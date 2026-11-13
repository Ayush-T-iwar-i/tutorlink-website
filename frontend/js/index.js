/* ===========================================================
   Home page: "The TutorLink book"
   Builds a book out of the chapters in #ixSource and turns its pages
   as the visitor scrolls. Falls back to the plain stacked chapters
   (static mode) when JavaScript is off, motion is reduced, or the
   screen is too small for the book.
   =========================================================== */
(function () {
  'use strict';

  var root = document.documentElement;
  var track = document.getElementById('ixTrack');
  var stage = document.getElementById('ixStage');
  var float_ = document.getElementById('ixFloat');
  var fit = document.getElementById('ixFit');
  var book = document.getElementById('ixBook');
  var base = document.getElementById('ixBase');
  var leavesEl = document.getElementById('ixLeaves');
  var source = document.getElementById('ixSource');
  var hint = document.getElementById('ixHint');
  var labelEl = document.getElementById('ixLabel');
  var prevBtn = document.getElementById('ixPrev');
  var nextBtn = document.getElementById('ixNext');
  var controls = document.getElementById('ixControls');
  var nav = document.getElementById('mainNav');

  if (!track || !stage || !fit || !book || !leavesEl || !source) return;

  var reducedQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  // Page sizes the book is designed at. The whole book is scaled to fit the screen,
  // so the layout inside never changes with the viewport.
  var SIZES = {
    wide: { w: 1040, h: 640 },   // two-page spread
    narrow: { w: 360, h: 580 }   // single page
  };
  var MIN_SCALE = 0.5;
  var MAX_SCALE = 1.15;

  var chapters = Array.prototype.slice.call(source.querySelectorAll('.ix-chapter'));
  var coverSrc = source.querySelector('[data-cover] .ix-cover');
  var n = chapters.length;           // number of spreads = number of page turns
  if (!n || !coverSrc) return;

  var leaves = [];
  var layout = null;                 // { mode, scale, step, top }
  var targetP = 0;                   // where the scroll position says we should be
  var shownP = 0;                    // what is drawn (eased towards targetP)
  var raf = 0;
  var activeIdx = -1;
  var teaseDeg = 0;                  // the cover lifts a little now and then to invite a scroll
  var teaseRaf = 0;
  var tilt = { x: 0, y: 0, tx: 0, ty: 0 };
  var tiltRaf = 0;
  var closedness = 1;                // 1 while the book is shut, fades to 0 as it opens

  /* ---------- helpers ---------- */
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function reduced() { return !!(reducedQuery && reducedQuery.matches); }

  function stripIds(node) {
    if (node.removeAttribute) node.removeAttribute('id');
    var withIds = node.querySelectorAll ? node.querySelectorAll('[id]') : [];
    for (var i = 0; i < withIds.length; i++) withIds[i].removeAttribute('id');
    return node;
  }

  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function folio(num, side) {
    var f = el('span', 'ix-folio');
    f.textContent = String(num);
    f.setAttribute('aria-hidden', 'true');
    f.dataset.side = side;
    return f;
  }

  /* ---------- build the leaves once ---------- */
  // Spread k is visible when leaves 0..k are turned:
  //   left page  = back of leaf k      (the chapter's illustration)
  //   right page = front of leaf k + 1 (the chapter's text)
  function build() {
    if (leaves.length) return;

    for (var i = 0; i <= n; i++) {
      var leaf = el('div', 'ix-leaf');
      var front = el('div', 'ix-face ix-front');
      var back = el('div', 'ix-face ix-back ix-page');

      if (i === 0) {
        front.classList.add('ix-cover-face');
        front.appendChild(stripIds(coverSrc.cloneNode(true)));
        front.setAttribute('role', 'button');
        front.setAttribute('tabindex', '0');
        front.setAttribute('aria-label', 'Open the book');
      } else {
        front.classList.add('ix-page');
        var body = el('div', 'ix-pagebody');
        var chapter = chapters[i - 1];
        var miniSrc = chapter.querySelector('.ix-left .ix-art');
        if (miniSrc) {
          var mini = el('div', 'ix-mini-art');
          var miniClone = stripIds(miniSrc.cloneNode(true));
          miniClone.setAttribute('aria-hidden', 'true');
          miniClone.removeAttribute('role');
          miniClone.removeAttribute('aria-label');
          mini.appendChild(miniClone);
          body.appendChild(mini);
        }
        body.appendChild(stripIds(chapter.querySelector('.ix-right').cloneNode(true)));
        front.appendChild(body);
        front.appendChild(folio(2 * (i - 1) + 1, 'right'));
      }

      if (i < n) {
        var leftBody = el('div', 'ix-pagebody');
        leftBody.appendChild(stripIds(chapters[i].querySelector('.ix-left').cloneNode(true)));
        back.appendChild(leftBody);
        if (i > 0) back.appendChild(folio(2 * i, 'left'));
      }

      var shadeF = el('div', 'ix-shade');
      var shadeB = el('div', 'ix-shade');
      front.appendChild(shadeF);
      back.appendChild(shadeB);

      leaf.appendChild(front);
      leaf.appendChild(back);
      leavesEl.appendChild(leaf);
      leaves.push(leaf);
    }
  }

  /* ---------- sizing ---------- */
  function computeLayout() {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    if (reduced() || vw < 320 || vh < 520) return null;

    var navH = nav ? nav.offsetHeight : 64;
    var controlsH = controls ? controls.offsetHeight + 14 : 58;
    var stageH = vh - navH;
    // Extra room above and below: pages swing towards the viewer while they turn.
    var availH = stageH - controlsH - 36 - 64;

    var mode = vw >= 900 && vh >= 560 ? 'wide' : 'narrow';
    var size = SIZES[mode];
    var scale = Math.min((vw - (mode === 'wide' ? 32 : 24)) / size.w, availH / size.h, MAX_SCALE);

    // A wide screen that is too short for a readable spread falls back to the single page.
    if (mode === 'wide' && scale < 0.62) {
      mode = 'narrow';
      size = SIZES.narrow;
      scale = Math.min((vw - 24) / size.w, availH / size.h, MAX_SCALE);
    }
    if (scale < MIN_SCALE) return null;

    return {
      mode: mode,
      scale: scale,
      size: size,
      navH: navH,
      stageH: stageH,
      step: Math.max(380, Math.round(vh * 0.7))
    };
  }

  function applyLayout() {
    var next = computeLayout();
    if (!next) {
      root.classList.remove('ix-book-on');
      layout = null;
      return;
    }
    root.classList.add('ix-book-on');
    build();
    layout = next;

    var size = next.size;
    book.classList.toggle('ix-narrow', next.mode === 'narrow');
    book.style.width = size.w + 'px';
    book.style.height = size.h + 'px';
    book.style.transform = 'scale(' + next.scale + ')';
    fit.style.width = Math.round(size.w * next.scale) + 'px';
    fit.style.height = Math.round(size.h * next.scale) + 'px';

    stage.style.setProperty('--ix-top', next.navH + 'px');
    stage.style.setProperty('--ix-stage-h', next.stageH + 'px');
    track.style.height = (next.stageH + n * next.step) + 'px';

    readScroll();
    shownP = targetP;
    draw(shownP);
  }

  /* ---------- scroll -> progress ---------- */
  // Scroll position at which the stage pins under the navbar (progress 0). The stage is
  // sticky at `top: navbar height`, so it starts pinning that many pixels before the track
  // reaches the top of the page, and it lets go exactly n * step pixels later.
  function trackTop() {
    var navH = nav ? nav.offsetHeight : 64;
    return track.getBoundingClientRect().top + window.pageYOffset - navH;
  }

  function readScroll() {
    if (!layout) return;
    targetP = clamp((window.pageYOffset - trackTop()) / layout.step, 0, n);
  }

  function scrollToProgress(p, smooth) {
    if (!layout) return;
    var top = trackTop() + clamp(p, 0, n) * layout.step;
    window.scrollTo({ top: Math.round(top), behavior: smooth === false ? 'instant' : 'smooth' });
  }

  /* ---------- drawing ---------- */
  function draw(p) {
    if (!layout) return;
    var wide = layout.mode === 'wide';

    for (var i = 0; i < n; i++) {
      var t = clamp(p - i, 0, 1);
      var e = ease(t);
      var leaf = leaves[i];
      var extra = i === 0 ? teaseDeg : 0;
      leaf.style.transform = 'rotateY(' + (-180 * e - extra).toFixed(2) + 'deg)';
      leaf.style.zIndex = t <= 0 ? (n + 1 - i) : (t >= 1 ? (i + 1) : (n + 5));
      leaf.style.setProperty('--sh', Math.sin(Math.PI * t).toFixed(3));
    }
    leaves[n].style.zIndex = 1;

    var open = ease(clamp(p, 0, 1));
    closedness = 1 - clamp(p / 0.5, 0, 1);
    paintTilt();
    if (wide) {
      // Closed book sits in the middle; it slides to the left half as it opens.
      leavesEl.style.transform = 'translateX(' + (-(layout.size.w / 4) * (1 - open)).toFixed(2) + 'px)';
      base.style.opacity = String(clamp(open * 1.4, 0, 1));
    } else {
      leavesEl.style.transform = 'none';
    }

    // Page state: which leaf may be focused, label, hint, buttons.
    var round = clamp(Math.round(p), 0, n);
    if (round !== activeIdx) {
      activeIdx = round;
      for (var j = 0; j <= n; j++) {
        var live = j === round || (wide && j === round - 1);
        if (live) leaves[j].removeAttribute('inert');
        else leaves[j].setAttribute('inert', '');
      }
      labelEl.textContent = round === 0 ? 'Scroll to open the book' : chapters[round - 1].getAttribute('data-title') || ('Page ' + round);
      prevBtn.disabled = round === 0;
      float_.classList.toggle('is-closed', round === 0);
    }
    if (hint) hint.classList.toggle('is-on', p < 0.12);
  }

  function frame() {
    raf = 0;
    var diff = targetP - shownP;
    if (Math.abs(diff) < 0.0015) {
      shownP = targetP;
    } else {
      shownP += diff * 0.2;
      raf = window.requestAnimationFrame(frame);
    }
    draw(shownP);
  }

  function onScroll() {
    if (!layout) return;
    readScroll();
    if (!raf) raf = window.requestAnimationFrame(frame);
  }

  /* ---------- cover tilt (follows the mouse while the book is closed) ---------- */
  function paintTilt() {
    var f = closedness;
    float_.style.setProperty('--ix-tx', (tilt.x * f).toFixed(2) + 'deg');
    float_.style.setProperty('--ix-ty', (tilt.y * f).toFixed(2) + 'deg');
  }

  function tiltStep() {
    tiltRaf = 0;
    tilt.x += (tilt.tx - tilt.x) * 0.12;
    tilt.y += (tilt.ty - tilt.y) * 0.12;
    paintTilt();
    if (Math.abs(tilt.tx - tilt.x) > 0.02 || Math.abs(tilt.ty - tilt.y) > 0.02) {
      tiltRaf = window.requestAnimationFrame(tiltStep);
    }
  }

  function setTiltTarget(x, y) {
    tilt.tx = x;
    tilt.ty = y;
    if (!tiltRaf) tiltRaf = window.requestAnimationFrame(tiltStep);
  }

  stage.addEventListener('pointermove', function (e) {
    if (!layout || e.pointerType !== 'mouse' || closedness < 0.05) return;
    var r = stage.getBoundingClientRect();
    var nx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    var ny = ((e.clientY - r.top) / r.height - 0.5) * 2;
    setTiltTarget(-ny * 5, nx * 9);
  });
  stage.addEventListener('pointerleave', function () { setTiltTarget(0, 0); });

  /* ---------- teaser: the cover lifts a little, then closes again ---------- */
  function runTeaser() {
    if (!layout || targetP > 0.01 || teaseRaf) return;
    var start = window.performance.now();
    var dur = 1900;
    function step(now) {
      var t = clamp((now - start) / dur, 0, 1);
      if (!layout || targetP > 0.01) {
        teaseDeg = 0;
        teaseRaf = 0;
        draw(shownP);
        return;
      }
      var wave = Math.sin(Math.PI * t);
      teaseDeg = 17 * wave * wave;
      draw(shownP);
      if (t < 1) {
        teaseRaf = window.requestAnimationFrame(step);
      } else {
        teaseDeg = 0;
        teaseRaf = 0;
        draw(shownP);
      }
    }
    teaseRaf = window.requestAnimationFrame(step);
  }

  /* ---------- controls ---------- */
  function goTo(index) {
    if (!layout) return;
    if (index > n) {
      var shelf = document.getElementById('subjects');
      if (shelf) shelf.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    scrollToProgress(index, true);
  }

  prevBtn.addEventListener('click', function () { goTo(clamp(Math.round(targetP) - 1, 0, n)); });
  nextBtn.addEventListener('click', function () { goTo(Math.round(targetP) + 1); });

  leavesEl.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.ix-cover-face')) goTo(1);
  });
  leavesEl.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('ix-cover-face')) {
      e.preventDefault();
      goTo(1);
    }
  });

  // Chapter links (contents list and the navbar) jump to that spread in book mode.
  document.addEventListener('click', function (e) {
    if (!layout || !root.classList.contains('ix-book-on')) return;
    var link = e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!link) return;
    var id = link.getAttribute('href').slice(1);
    for (var i = 0; i < n; i++) {
      if (chapters[i].id === id) {
        e.preventDefault();
        e.stopPropagation();
        scrollToProgress(i + 1, true);
        return;
      }
    }
  }, true);

  /* ---------- lifecycle ---------- */
  var resizeRaf = 0;
  function onResize() {
    if (resizeRaf) return;
    resizeRaf = window.requestAnimationFrame(function () {
      resizeRaf = 0;
      applyLayout();
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  if (reducedQuery) {
    if (reducedQuery.addEventListener) reducedQuery.addEventListener('change', applyLayout);
    else if (reducedQuery.addListener) reducedQuery.addListener(applyLayout);
  }

  applyLayout();

  // A link such as index.html#safety opens the book on that chapter.
  if (layout && window.location.hash) {
    var wanted = window.location.hash.slice(1);
    for (var c = 0; c < n; c++) {
      if (chapters[c].id === wanted) {
        scrollToProgress(c + 1, false);
        break;
      }
    }
  }

  if (layout) {
    window.setTimeout(runTeaser, 1600);
    window.setInterval(runTeaser, 9000);
  }

  // Fonts change text metrics inside the (fixed-size) pages, not the layout, but the
  // sticky stage depends on the navbar height, so measure again once everything loaded.
  window.addEventListener('load', applyLayout);
})();