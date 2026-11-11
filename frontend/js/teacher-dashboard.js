/* =========================================================
   TutorLink - teacher dashboard
   Place at: frontend/js/teacher-dashboard.js
   Needs: js/api.js, js/ui.js (loaded before this file)
   ========================================================= */
(function () {
  'use strict';

  var session = requireLogin('teacher');
  if (!session) return;
  var USER = session.user;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function money(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }
  function initials(name) {
    return String(name || '').split(/\s+/).filter(Boolean).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase() || '?';
  }
  function dayText(iso, opts) {
    if (!iso) return '';
    var dt = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(dt.getTime())) return String(iso);
    var o = opts || { day: 'numeric', month: 'short', year: 'numeric' };
    o.timeZone = 'UTC';   // The date is a calendar day, so it must not shift with the browser zone.
    return dt.toLocaleDateString('en-IN', o);
  }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' '); }

  var toastTimer = null;
  function toast(message, isError) {
    var t = $('toast');
    t.textContent = message;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 3500);
  }
  function setMsg(box, type, text) {
    box.className = 'msg-box' + (type ? ' ' + type : '');
    box.textContent = text || '';
  }
  function emptyState(text) { return el('div', 'pg-empty pg-empty-sm', text); }
  function setBusy(btn, on) {
    btn.disabled = on;
    btn.classList.toggle('btn-loading', on);
  }

  /* ---------------- Header ---------------- */
  $('welcomeText').textContent = USER.name || '';
  $('avatarInitials').textContent = initials(USER.name);
  $('heroGreeting').textContent = 'Welcome back, ' + String(USER.name || 'teacher').split(' ')[0];

  $('logoutBtn').addEventListener('click', function () {
    clearSession();
    window.location.href = 'login.html';
  });
  if (typeof initNotificationBell === 'function') initNotificationBell();

  var meUser = null;
  var mePromise = apiRequest('/api/auth/me').catch(function () { return null; });
  mePromise.then(function (me) {
    if (!me || !me.user) return;
    meUser = me.user;
    if (me.user.profile_photo) {
      var av = $('avatarInitials');
      clear(av);
      var img = document.createElement('img');
      img.alt = '';
      img.src = photoUrl(me.user.profile_photo);
      av.appendChild(img);
    }
    if (!me.user.email_verified) showVerifyEmailBanner();
  });

  function banner(title, text, actionNode, tone) {
    var b = el('div', 'pg-banner' + (tone ? ' is-' + tone : ''));
    var t = el('div', 'pg-banner-text');
    t.appendChild(el('strong', '', title));
    t.appendChild(el('span', '', text));
    b.appendChild(t);
    if (actionNode) b.appendChild(actionNode);
    return b;
  }
  function linkBtn(href, label, cls) {
    var a = el('a', 'btn btn-sm ' + (cls || 'btn-outline'), label);
    a.href = href;
    return a;
  }

  function showVerifyEmailBanner() {
    var btn = el('button', 'btn btn-accent btn-sm', 'Resend email');
    btn.type = 'button';
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        await apiRequest('/api/auth/resend-verification', 'POST');
        btn.textContent = 'Sent. Check your inbox';
      } catch (err) {
        btn.textContent = 'Could not send. Try again';
        btn.disabled = false;
      }
    });
    var host = $('emailBanner');
    clear(host);
    host.appendChild(banner('Please verify your email', 'You need a verified email before you can accept bookings. Check your inbox or resend the link.', btn, 'warn'));
  }

  /* ---------------- Modal helper ---------------- */
  var openModals = [];
  function focusSoon(node) {
    var tries = 0;
    (function attempt() {
      node.focus();
      if (document.activeElement !== node && tries++ < 12) setTimeout(attempt, 30);
    })();
  }
  function openModal(backdrop, focusNode, opener, onClose) {
    backdrop.classList.add('open');
    document.body.classList.add('pg-modal-open');
    openModals.push({ backdrop: backdrop, opener: opener || null, onClose: onClose || null });
    if (focusNode) focusSoon(focusNode);
  }
  function closeModal(backdrop) {
    var idx = -1;
    openModals.forEach(function (m, i) { if (m.backdrop === backdrop) idx = i; });
    backdrop.classList.remove('open');
    if (idx === -1) return;
    var m = openModals.splice(idx, 1)[0];
    if (!openModals.length) document.body.classList.remove('pg-modal-open');
    if (m.onClose) m.onClose();
    if (m.opener && document.contains(m.opener) && !m.opener.disabled) m.opener.focus();
  }
  document.addEventListener('keydown', function (e) {
    if (!openModals.length) return;
    var top = openModals[openModals.length - 1];
    if (e.key === 'Escape') { e.preventDefault(); closeModal(top.backdrop); return; }
    if (e.key === 'Tab') {
      var f = Array.prototype.filter.call(top.backdrop.querySelectorAll('button, input, select, textarea, a[href]'),
        function (n) { return !n.disabled && n.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  ['acceptFeeModalBackdrop', 'createCourseModalBackdrop', 'courseModalBackdrop'].forEach(function (id) {
    var b = $(id);
    b.addEventListener('mousedown', function (e) { if (e.target === b) closeModal(b); });
  });

  /* ---------------- Dates (always IST) ---------------- */
  var APP_TZ = 'Asia/Kolkata';
  function istNow() {
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    var o = {};
    parts.forEach(function (p) { o[p.type] = p.value; });
    return { date: o.year + '-' + o.month + '-' + o.day, minutes: Number(o.hour) * 60 + Number(o.minute) };
  }
  function shiftDate(iso, n) {
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function slotMinutes(label) {
    var m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(label || '').trim());
    if (!m) return null;
    var h = Number(m[1]) % 12;
    if (m[3].toUpperCase() === 'PM') h += 12;
    return h * 60 + Number(m[2]);
  }
  function relDay(iso) {
    var d = String(iso || '').slice(0, 10);
    var t = istNow().date;
    if (d === t) return 'Today';
    if (d === shiftDate(t, 1)) return 'Tomorrow';
    if (d === shiftDate(t, -1)) return 'Yesterday';
    return dayText(d);
  }
  function dateWithRel(iso) {
    var rel = relDay(iso);
    return /^(Today|Tomorrow|Yesterday)$/.test(rel) ? rel + ' (' + dayText(iso) + ')' : dayText(iso);
  }

  /* ---------------- CSV export ---------------- */
  function csvCell(v) {
    var s = String(v === null || v === undefined ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // Stops spreadsheet formula injection.
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function downloadCsv(name, header, rows) {
    var text = '﻿' + [header].concat(rows).map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------------- Attention strip ---------------- */
  var att = { pending: null, unpaid: null, unreplied: null, today: null };
  function jumpTo(id) {
    var n = $(id);
    if (!n) return;
    n.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var h = n.querySelector('h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }
  function renderAttention() {
    var host = $('attention');
    clear(host);
    var keys = Object.keys(att);
    var allKnown = keys.every(function (k) { return att[k] !== null; });
    var items = [];
    if (att.pending > 0) items.push({ n: att.pending, text: (att.pending === 1 ? 'request is' : 'requests are') + ' waiting for your reply', run: function () { setFilter('requested'); jumpTo('sec-requests'); } });
    if (att.today > 0) items.push({ n: att.today, text: (att.today === 1 ? 'class' : 'classes') + ' still to teach today', run: function () { jumpTo('sec-schedule'); } });
    if (att.unpaid > 0) items.push({ n: att.unpaid, text: 'completed ' + (att.unpaid === 1 ? 'class is' : 'classes are') + ' not marked paid', run: function () { jumpTo('sec-earnings'); } });
    if (att.unreplied > 0) items.push({ n: att.unreplied, text: (att.unreplied === 1 ? 'review has' : 'reviews have') + ' no reply', run: function () { jumpTo('sec-reviews'); } });
    if (!items.length && !allKnown) return;
    var wrap = el('div', 'pg-attn' + (items.length ? '' : ' is-clear'));
    if (!items.length) {
      wrap.appendChild(el('span', 'pg-attn-ok', '✓ You are all caught up. Nothing needs your attention.'));
    } else {
      wrap.appendChild(el('span', 'pg-attn-title', 'Needs your attention'));
      items.forEach(function (it) {
        var b = el('button', 'pg-attn-item');
        b.type = 'button';
        b.appendChild(el('b', '', String(it.n)));
        b.appendChild(document.createTextNode(' ' + it.text));
        b.addEventListener('click', it.run);
        wrap.appendChild(b);
      });
    }
    host.appendChild(wrap);
  }

  /* ---------------- Profile summary ---------------- */
  var myTeacherId = null;
  var myFee = 0;
  var myProfile = null;

  var STATUS_COPY = {
    approved: ['Your profile is live', null, 'ok'],
    pending: ['Verification pending', 'Your profile is waiting for admin verification before it goes live.', 'warn'],
    under_review: ['Under review', 'Your documents are being reviewed by our team.', 'warn'],
    rejected: ['Verification not approved', 'Please update your details and documents, or contact support.', 'bad']
  };

  function sumTile(label, value) {
    var t = el('div', 'pg-tile');
    t.appendChild(el('div', 'pg-tile-label', label));
    t.appendChild(el('div', 'pg-tile-value', value));
    return t;
  }

  function strengthMeter(t, user) {
    var checks = [
      ['Photo', !!(user && user.profile_photo)],
      ['Qualification', !!t.qualification],
      ['Subjects', !!t.subjects],
      ['Classes', !!t.grades],
      ['Experience', Number(t.experience_years) > 0],
      ['Fee', Number(t.fee_per_hour) > 0],
      ['About you', !!t.bio],
      ['Time slots', !!t.available_slots],
      ['Location', t.latitude !== null && t.latitude !== undefined && t.latitude !== ''],
      ['Documents', !!(t.id_proof_path && t.certificate_path)]
    ];
    var done = checks.filter(function (c) { return c[1]; }).length;
    var pct = Math.round(done / checks.length * 100);
    var missing = checks.filter(function (c) { return !c[1]; }).map(function (c) { return c[0]; });
    var box = el('div', 'pg-strength');
    var head = el('div', 'pg-strength-head');
    head.appendChild(el('strong', '', 'Profile strength'));
    head.appendChild(el('span', 'pg-strength-pct', pct + '%'));
    box.appendChild(head);
    var bar = el('div', 'pg-progress-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(pct));
    bar.setAttribute('aria-label', 'Profile strength');
    var fill = el('i');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    box.appendChild(bar);
    box.appendChild(el('p', 'pg-hint', missing.length ? 'Still to add: ' + missing.join(', ') + '. A complete profile gets more booking requests.' : 'Your profile is complete.'));
    return box;
  }

  async function loadProfileSummary() {
    var bannerHost = $('profileBanner');
    var summary = $('profileSummary');
    clear(bannerHost);
    clear(summary);
    try {
      var t = await apiRequest('/api/teachers/by-user/' + encodeURIComponent(USER.id));
      myTeacherId = t.id;
      myProfile = t;
      myFee = Number(t.fee_per_hour) || 0;
      var meWrap = await mePromise;
      var complete = !!(t.subjects && t.qualification && t.address && t.latitude);
      var rating = Number(t.rating_avg) > 0 ? Number(t.rating_avg).toFixed(1) : null;
      $('statRating').textContent = rating ? '★ ' + rating : 'New';

      if (complete) {
        var c = STATUS_COPY[t.verification_status] || STATUS_COPY.pending;
        var text = c[1] || ('Students within ' + (t.travel_radius_km || 5) + ' km of ' + (t.city || 'your area') + ' can find you.');
        bannerHost.appendChild(banner(c[0], text, null, c[2]));

        summary.appendChild(strengthMeter(t, meWrap && meWrap.user));
        var grid = el('div', 'pg-tiles pg-tiles-tight');
        grid.appendChild(sumTile('Qualification', t.qualification));
        grid.appendChild(sumTile('Subjects', t.subjects));
        grid.appendChild(sumTile('Fee / hour', money(t.fee_per_hour)));
        grid.appendChild(sumTile('Location', [t.address, t.city].filter(Boolean).join(', ') || 'Not set'));
        grid.appendChild(sumTile('Travel radius', (t.travel_radius_km || 5) + ' km'));
        grid.appendChild(sumTile('Rating', rating ? '★ ' + rating : 'New'));
        summary.appendChild(grid);
        var slotList = String(t.available_slots || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        var slotBox = el('div', 'pg-slotsum');
        slotBox.appendChild(el('div', 'pg-tile-label', 'Weekly time slots'));
        var chips = el('div', 'pg-chips');
        if (slotList.length) slotList.forEach(function (x) { chips.appendChild(el('span', 'badge badge-subject', x)); });
        else chips.appendChild(el('span', 'pg-hint', 'None chosen. Students see the default slots (9 AM, 11 AM, 1 PM, 3 PM, 5 PM, 7 PM).'));
        slotBox.appendChild(chips);
        summary.appendChild(slotBox);
        var btns = el('div', 'pg-btnrow');
        btns.appendChild(linkBtn('teacher-complete-profile.html', 'Edit profile'));
        btns.appendChild(linkBtn('teacher-profile-view.html?id=' + encodeURIComponent(t.id), 'Preview public profile'));
        summary.appendChild(btns);
      } else {
        bannerHost.appendChild(banner('Your profile is not complete yet',
          'Add your qualifications and location. Students cannot find you until this is done.',
          linkBtn('teacher-complete-profile.html', 'Complete profile', 'btn-accent'), 'warn'));
        summary.appendChild(emptyState('Complete your profile to start appearing in student search results.'));
      }
    } catch (err) {
      // A 404 means no profile row yet. Any other failure is shown honestly.
      var notFound = /not found|404|no profile/i.test(err && err.message ? err.message : '');
      bannerHost.appendChild(banner(notFound ? 'Complete your profile' : 'Could not load your profile',
        notFound ? 'Add your qualifications and location to start receiving bookings.' : (err.message || 'Please refresh the page.'),
        linkBtn('teacher-complete-profile.html', 'Complete profile', 'btn-accent'), 'warn'));
      summary.appendChild(emptyState('Complete your profile to start appearing in student search results.'));
    }
    loadMyReviews();
  }

  /* ---------------- Reviews ---------------- */
  async function loadMyReviews() {
    var area = $('reviewsArea');
    clear(area);
    if (!myTeacherId) { area.appendChild(emptyState('Complete your profile to start receiving reviews.')); return; }
    var reviews;
    try {
      reviews = await apiRequest('/api/reviews/teacher/' + encodeURIComponent(myTeacherId));
    } catch (err) {
      area.appendChild(emptyState(err.message || 'Could not load reviews.'));
      return;
    }
    if (!Array.isArray(reviews) || !reviews.length) { att.unreplied = 0; renderAttention(); area.appendChild(emptyState('No reviews yet.')); return; }
    att.unreplied = reviews.filter(function (r) { return !r.teacher_reply; }).length;
    renderAttention();
    var avg = reviews.reduce(function (a, r) { return a + (Number(r.rating) || 0); }, 0) / reviews.length;
    area.appendChild(el('p', 'pg-hint pg-sumline', avg.toFixed(1) + ' average from ' + reviews.length + (reviews.length === 1 ? ' review' : ' reviews') + (att.unreplied ? ' · ' + att.unreplied + ' waiting for your reply' : ' · all replied')));

    var list = el('div', 'pg-list');
    reviews.forEach(function (r) {
      var rating = Math.max(0, Math.min(5, Math.round(Number(r.rating) || 0)));
      var row = el('article', 'pg-review');
      var top = el('div', 'pg-review-top');
      var who = el('div');
      who.appendChild(el('strong', '', r.student_name || 'Student'));
      var st = el('span', 'badge badge-rating', '★'.repeat(rating) + '☆'.repeat(5 - rating));
      st.setAttribute('aria-label', 'Rated ' + rating + ' out of 5');
      who.appendChild(st);
      top.appendChild(who);
      top.appendChild(el('time', 'pg-review-date', dayText(r.created_at)));
      row.appendChild(top);
      if (r.comment) row.appendChild(el('p', 'pg-prose', r.comment));

      if (r.teacher_reply) {
        var reply = el('div', 'pg-reply');
        reply.appendChild(el('strong', '', 'Your reply: '));
        reply.appendChild(document.createTextNode(r.teacher_reply));
        row.appendChild(reply);
      } else {
        var form = el('form', 'pg-replyform');
        form.noValidate = true;
        var input = el('input');
        input.type = 'text';
        input.maxLength = 500;
        input.placeholder = 'Write a public reply…';
        input.setAttribute('aria-label', 'Reply to ' + (r.student_name || 'student'));
        var send = el('button', 'btn btn-outline btn-sm', 'Reply');
        send.type = 'submit';
        form.appendChild(input);
        form.appendChild(send);
        form.addEventListener('submit', async function (e) {
          e.preventDefault();
          var text = input.value.trim();
          if (!text) { toast('Please write a reply first.', true); input.focus(); return; }
          setBusy(send, true);
          try {
            await apiRequest('/api/reviews/' + encodeURIComponent(r.id) + '/reply', 'PUT', { reply: text });
            toast('Reply posted');
            loadMyReviews();
          } catch (err) {
            toast(err.message || 'Could not post the reply.', true);
            setBusy(send, false);
          }
        });
        row.appendChild(form);
      }
      list.appendChild(row);
    });
    area.appendChild(list);
  }

  /* ---------------- Earnings ---------------- */
  var lastEarnings = [];
  async function loadEarnings() {
    var area = $('earningsArea');
    var e;
    try {
      e = await apiRequest('/api/bookings/teacher/earnings');
    } catch (err) {
      clear(area);
      area.appendChild(emptyState('Could not load earnings.'));
      return;
    }
    clear(area);
    var grid = el('div', 'pg-tiles pg-tiles-tight');
    grid.appendChild(sumTile('Total earned', money(e.total_earned)));
    grid.appendChild(sumTile('This month', money(e.this_month)));
    grid.appendChild(sumTile('Pending payment', money(e.pending_amount)));
    area.appendChild(grid);

    var recent = Array.isArray(e.recent) ? e.recent : [];
    lastEarnings = recent;
    att.unpaid = recent.filter(function (r) { return r.payment_status === 'unpaid'; }).length;
    renderAttention();
    if (!recent.length) { area.appendChild(emptyState('No completed classes yet.')); return; }
    var list = el('div', 'pg-list');
    recent.forEach(function (r) {
      var row = el('div', 'pg-row-item');
      var info = el('div', 'pg-row-info');
      var line = el('div');
      line.appendChild(el('strong', '', r.student_name || 'Student'));
      line.appendChild(document.createTextNode(' — ' + (r.subject || 'Class')));
      info.appendChild(line);
      info.appendChild(el('div', 'pg-row-meta', dayText(r.booking_date)));
      row.appendChild(info);
      var side = el('div', 'pg-row-side');
      side.appendChild(el('span', 'pg-amount', money(r.fee)));
      var paid = r.payment_status === 'paid';
      side.appendChild(el('span', 'status-tag ' + (paid ? 'accepted' : 'requested'), cap(r.payment_status || 'unpaid')));
      if (r.payment_status === 'unpaid') {
        var btn = el('button', 'btn btn-outline btn-sm', 'Mark paid');
        btn.type = 'button';
        btn.addEventListener('click', function () {
          if (!window.confirm('Mark this class as paid in cash? This cannot be undone.')) return;
          markPaid(r.id, btn);
        });
        side.appendChild(btn);
      }
      row.appendChild(side);
      list.appendChild(row);
    });
    area.appendChild(list);
  }

  async function markPaid(bookingId, btn) {
    btn.disabled = true;
    try {
      await apiRequest('/api/bookings/' + encodeURIComponent(bookingId) + '/payment', 'PUT', { payment_status: 'paid' });
      toast('Marked as paid');
      loadEarnings();
    } catch (err) {
      toast(err.message || 'Could not update payment.', true);
      btn.disabled = false;
    }
  }

  /* ---------------- Booking requests ---------------- */
  var bookings = [];
  var filter = 'all';

  function setStats() {
    $('statTotal').textContent = bookings.length;
    var pending = bookings.filter(function (b) { return b.status === 'requested'; }).length;
    $('statPending').textContent = pending;
    att.pending = pending;
    renderAttention();
    updateTabs();
  }

  async function loadBookings() {
    var area = $('bookingsArea');
    try {
      var data = await apiRequest('/api/bookings/teacher/me');
      bookings = Array.isArray(data) ? data : [];
    } catch (err) {
      bookings = [];
      clear(area);
      area.appendChild(emptyState(err.message || 'Could not load booking requests.'));
      $('statTotal').textContent = '—';
      $('statPending').textContent = '—';
      loadSchedule();
      return;
    }
    setStats();
    renderBookings();
    loadSchedule();
  }

  function actionBtn(label, cls, handler, title) {
    var b = el('button', 'btn btn-sm ' + cls, label);
    b.type = 'button';
    if (title) { b.title = title; b.setAttribute('aria-label', title); }
    b.addEventListener('click', handler);
    return b;
  }

  var TAB_LABELS = { all: 'All', requested: 'Awaiting reply', accepted: 'Accepted', completed: 'Completed' };
  function updateTabs() {
    document.querySelectorAll('.pg-tab').forEach(function (tab) {
      var f = tab.dataset.filter;
      var n = f === 'all' ? bookings.length : bookings.filter(function (b) { return b.status === f; }).length;
      tab.textContent = TAB_LABELS[f] + ' (' + n + ')';
    });
  }
  function setFilter(f) {
    filter = f;
    document.querySelectorAll('.pg-tab').forEach(function (t) {
      var on = t.dataset.filter === f;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-pressed', String(on));
    });
    renderBookings();
  }
  function bookingKey(b) {
    var m = slotMinutes(b.booking_time);
    return String(b.booking_date || '').slice(0, 10) + ' ' + String(m === null ? 0 : m).padStart(4, '0');
  }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function visibleBookings() {
    var q = $('reqSearch').value.trim().toLowerCase();
    var list = bookings.filter(function (b) {
      if (filter !== 'all' && b.status !== filter) return false;
      if (!q) return true;
      return (String(b.student_name || '') + ' ' + String(b.subject || '')).toLowerCase().indexOf(q) !== -1;
    });
    var mode = $('reqSort').value;
    var rank = { requested: 0, accepted: 1, completed: 2 };
    list.sort(function (a, b) {
      if (mode === 'newest') return Number(b.id) - Number(a.id);
      if (mode === 'oldest') return Number(a.id) - Number(b.id);
      if (mode === 'soonest') return cmp(bookingKey(a), bookingKey(b));
      var ra = rank[a.status] !== undefined ? rank[a.status] : 3;
      var rb = rank[b.status] !== undefined ? rank[b.status] : 3;
      if (ra !== rb) return ra - rb;
      return ra < 2 ? cmp(bookingKey(a), bookingKey(b)) : cmp(bookingKey(b), bookingKey(a));
    });
    return list;
  }

  function renderBookings() {
    var area = $('bookingsArea');
    clear(area);
    if (!bookings.length) {
      area.appendChild(emptyState('No booking requests yet. They will appear here once a student books a class with you.'));
      return;
    }
    var shown = visibleBookings();
    if (!shown.length) { area.appendChild(emptyState($('reqSearch').value.trim() ? 'No requests match your search.' : 'Nothing here for this filter.')); return; }

    var today = istNow().date;
    var tomorrow = shiftDate(today, 1);
    var list = el('div', 'pg-list');
    shown.forEach(function (b) {
      var row = el('div', 'pg-row-item pg-booking');
      var info = el('div', 'pg-row-info');
      var line = el('div');
      line.appendChild(el('strong', '', b.student_name || 'Student'));
      line.appendChild(document.createTextNode(' requested a ' + (b.type || 'demo') + ' class' + (b.subject ? ' for ' + b.subject : '')));
      info.appendChild(line);
      var meta = [dateWithRel(b.booking_date), b.booking_time].filter(Boolean).join(' · ');
      if (b.type === 'recurring' && b.days_per_week) meta += ' · ' + b.days_per_week;
      var metaEl = el('div', 'pg-row-meta', meta);
      var d = String(b.booking_date || '').slice(0, 10);
      if (b.status === 'requested' && d >= today && d <= tomorrow) metaEl.appendChild(el('span', 'pg-urgent', 'Starts soon'));
      if (b.status === 'requested' && d && d < today) metaEl.appendChild(el('span', 'pg-muted-tag', 'Date passed'));
      info.appendChild(metaEl);
      row.appendChild(info);

      var side = el('div', 'pg-row-side');
      side.appendChild(el('span', 'status-tag ' + (b.status || ''), cap(b.status)));
      if (b.status === 'accepted' || b.status === 'completed') {
        side.appendChild(actionBtn('💬 Chat', 'btn-outline', function () { openChatModal(b.id, b.student_name); }));
        side.appendChild(actionBtn('🚩', 'btn-outline', function () { openReportModal(b.student_user_id, b.student_name, b.id); }, 'Report an issue with ' + (b.student_name || 'this student')));
      }
      if (b.status === 'requested') {
        side.appendChild(actionBtn('Accept', 'btn-primary', function (e) { openAcceptFeeModal(b, e.currentTarget); }));
        side.appendChild(actionBtn('Decline', 'btn-outline', function (e) {
          if (window.confirm('Decline this request from ' + (b.student_name || 'the student') + '?')) respond(b.id, 'declined', e.currentTarget);
        }));
      }
      if (b.status === 'accepted') {
        side.appendChild(actionBtn('Mark completed', 'btn-outline', function (e) {
          if (window.confirm('Mark this class as completed?')) respond(b.id, 'completed', e.currentTarget);
        }));
      }
      row.appendChild(side);
      list.appendChild(row);
    });
    area.appendChild(list);
  }

  document.querySelectorAll('.pg-tab').forEach(function (tab) {
    tab.addEventListener('click', function () { setFilter(tab.dataset.filter); });
  });
  $('reqSearch').addEventListener('input', renderBookings);
  $('reqSort').addEventListener('change', renderBookings);

  function exportRequests() {
    var list = visibleBookings();
    if (!list.length) { toast('Nothing to export for this view.', true); return; }
    downloadCsv('tutorlink-requests-' + istNow().date + '.csv',
      ['Student', 'Subject', 'Type', 'Date', 'Time', 'Days', 'Status'],
      list.map(function (b) { return [b.student_name, b.subject, b.type, String(b.booking_date || '').slice(0, 10), b.booking_time, b.days_per_week || '', b.status]; }));
    toast('Exported ' + list.length + (list.length === 1 ? ' request' : ' requests'));
  }
  function exportEarnings() {
    if (!lastEarnings.length) { toast('No completed classes to export yet.', true); return; }
    downloadCsv('tutorlink-earnings-' + istNow().date + '.csv',
      ['Student', 'Subject', 'Date', 'Fee (INR)', 'Payment status'],
      lastEarnings.map(function (r) { return [r.student_name, r.subject, String(r.booking_date || '').slice(0, 10), r.fee, r.payment_status]; }));
    toast('Exported ' + lastEarnings.length + (lastEarnings.length === 1 ? ' class' : ' classes'));
  }
  $('exportRequests').addEventListener('click', exportRequests);
  $('exportEarnings').addEventListener('click', exportEarnings);

  async function respond(bookingId, status, btn) {
    var row = btn.closest('.pg-row-item');
    row.classList.add('is-busy');
    row.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    try {
      await apiRequest('/api/bookings/' + encodeURIComponent(bookingId) + '/status', 'PUT', { status: status });
      toast(status === 'declined' ? 'Booking declined' : 'Booking marked as completed');
      await loadBookings();
      if (status === 'completed') loadEarnings();
    } catch (err) {
      row.classList.remove('is-busy');
      row.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
      toast('Could not update booking: ' + (err.message || 'try again'), true);
    }
  }

  /* ---------------- Accept with fee ---------------- */
  var accept = { booking: null, busy: false };
  var acceptBackdrop = $('acceptFeeModalBackdrop');

  function openAcceptFeeModal(b, opener) {
    accept.booking = b;
    $('acceptSub').textContent = (b.student_name || 'The student') + (b.subject ? ' · ' + b.subject : '') + ' · ' + dateWithRel(b.booking_date) + (b.booking_time ? ' at ' + b.booking_time : '') + '. They will be asked to pay this amount.';
    $('acceptFeeInput').value = '';
    var quick = $('feeQuick');
    clear(quick);
    function chip(label, value) {
      var c = el('button', 'pg-chipbtn', label);
      c.type = 'button';
      c.addEventListener('click', function () { $('acceptFeeInput').value = String(value); $('acceptFeeInput').focus(); setMsg($('acceptFeeMsgBox'), '', ''); });
      quick.appendChild(c);
    }
    chip('Free demo (₹0)', 0);
    if (myFee > 0) chip('My hourly fee (' + money(myFee) + ')', Math.round(myFee));
    setMsg($('acceptFeeMsgBox'), '', '');
    openModal(acceptBackdrop, $('acceptFeeInput'), opener);
  }
  $('acceptFeeModalClose').addEventListener('click', function () { if (!accept.busy) closeModal(acceptBackdrop); });
  $('acceptFeeModalCancel').addEventListener('click', function () { if (!accept.busy) closeModal(acceptBackdrop); });
  $('acceptFeeInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('acceptFeeModalConfirm').click(); }
  });

  $('acceptFeeModalConfirm').addEventListener('click', async function () {
    if (accept.busy || !accept.booking) return;
    var box = $('acceptFeeMsgBox');
    var raw = $('acceptFeeInput').value.trim();
    var fee = Number(raw);
    if (raw === '' || !isFinite(fee) || fee < 0 || fee > 100000) {
      setMsg(box, 'error', 'Please enter a fee between 0 and 100000.');
      return;
    }
    var btn = $('acceptFeeModalConfirm');
    accept.busy = true;
    setBusy(btn, true);
    try {
      await apiRequest('/api/bookings/' + encodeURIComponent(accept.booking.id) + '/status', 'PUT', { status: 'accepted', fee: fee });
      accept.busy = false;
      closeModal(acceptBackdrop);
      toast('Booking accepted');
      loadBookings();
      loadCourses();
    } catch (err) {
      setMsg(box, 'error', err.message || 'Could not accept the booking.');
      accept.busy = false;
    } finally {
      setBusy(btn, false);
    }
  });

  /* ---------------- Schedule ---------------- */
  function renderNextClass(sessions) {
    var host = $('nextClass');
    clear(host);
    var now = istNow();
    var upcoming = sessions.map(function (s) {
      return { s: s, date: String(s.session_date || '').slice(0, 10), min: slotMinutes(s.session_time) };
    }).filter(function (x) {
      if (!x.date) return false;
      if (x.date > now.date) return true;
      return x.date === now.date && (x.min === null || x.min + 60 > now.minutes);
    }).sort(function (a, b) { return cmp(a.date + ' ' + String(a.min === null ? 0 : a.min).padStart(4, '0'), b.date + ' ' + String(b.min === null ? 0 : b.min).padStart(4, '0')); });

    var card = el('section', 'pg-next');
    card.setAttribute('aria-label', 'Next class');
    if (!upcoming.length) {
      card.classList.add('is-empty');
      card.appendChild(el('span', 'pg-next-label', 'Up next'));
      card.appendChild(el('span', 'pg-next-text', 'No classes scheduled in the next 7 days.'));
      host.appendChild(card);
      return;
    }
    var n = upcoming[0];
    var when;
    if (n.date === now.date) {
      if (n.min === null) when = 'Today';
      else if (n.min <= now.minutes) when = 'Happening now';
      else {
        var diff = n.min - now.minutes;
        when = 'In ' + (diff >= 60 ? Math.floor(diff / 60) + 'h ' + (diff % 60 ? (diff % 60) + 'm' : '') : diff + ' min');
        when = when.trim() + ' (' + n.s.session_time + ')';
      }
    } else if (n.date === shiftDate(now.date, 1)) {
      when = 'Tomorrow' + (n.s.session_time ? ' at ' + n.s.session_time : '');
    } else {
      when = dayText(n.date, { weekday: 'long', day: 'numeric', month: 'short' }) + (n.s.session_time ? ' at ' + n.s.session_time : '');
    }
    card.appendChild(el('span', 'pg-next-label', 'Up next'));
    var body = el('div', 'pg-next-body');
    body.appendChild(el('strong', '', (n.s.student_name || 'Student') + (n.s.subject ? ' — ' + n.s.subject : '')));
    body.appendChild(el('span', 'pg-next-when', when));
    card.appendChild(body);
    card.appendChild(actionBtn('💬 Chat', 'btn-outline', function () { openChatModal(n.s.booking_id, n.s.student_name); }));
    host.appendChild(card);
  }

  async function loadSchedule() {
    var area = $('scheduleArea');
    var sessions;
    try {
      sessions = await apiRequest('/api/bookings/teacher/schedule');
    } catch (err) {
      clear(area);
      area.appendChild(emptyState('Could not load your schedule.'));
      return;
    }
    clear(area);
    if (!Array.isArray(sessions)) sessions = [];
    var now = istNow();
    att.today = sessions.filter(function (s) {
      var m = slotMinutes(s.session_time);
      return String(s.session_date || '').slice(0, 10) === now.date && (m === null || m + 60 > now.minutes);
    }).length;
    renderAttention();
    renderNextClass(sessions);
    if (!sessions.length) { area.appendChild(emptyState('No classes scheduled in the next 7 days.')); return; }

    var byDate = {};
    sessions.forEach(function (s) {
      var key = String(s.session_date || '').slice(0, 10);
      (byDate[key] = byDate[key] || []).push(s);
    });
    Object.keys(byDate).forEach(function (k) {
      byDate[k].sort(function (a, b) { return (slotMinutes(a.session_time) || 0) - (slotMinutes(b.session_time) || 0); });
    });
    // Always show the next seven days so free days are visible too.
    var days = [];
    for (var i = 0; i < 7; i++) days.push(shiftDate(now.date, i));
    Object.keys(byDate).forEach(function (k) { if (days.indexOf(k) === -1) days.push(k); });
    days.sort();
    days.forEach(function (date) {
      var group = el('div', 'pg-day-group');
      var rel = relDay(date);
      group.appendChild(el('div', 'pg-day-label', (/^(Today|Tomorrow)$/.test(rel) ? rel + ' · ' : '') + dayText(date, { weekday: 'long', day: 'numeric', month: 'short' })));
      if (!byDate[date]) {
        group.appendChild(el('div', 'pg-free', 'Free day'));
      } else {
        byDate[date].forEach(function (s) {
          var row = el('div', 'pg-row-item');
          var info = el('div', 'pg-row-info');
          var line = el('div');
          line.appendChild(el('strong', '', s.student_name || 'Student'));
          line.appendChild(document.createTextNode(' — ' + (s.subject || s.type || 'Class')));
          info.appendChild(line);
          info.appendChild(el('div', 'pg-row-meta', s.session_time || 'Time to be confirmed'));
          row.appendChild(info);
          var side = el('div', 'pg-row-side');
          side.appendChild(actionBtn('💬 Chat', 'btn-outline', function () { openChatModal(s.booking_id, s.student_name); }));
          row.appendChild(side);
          group.appendChild(row);
        });
      }
      area.appendChild(group);
    });
  }

  /* ---------------- Courses ---------------- */
  async function loadCourses() {
    var area = $('coursesArea');
    var courses;
    try {
      courses = await apiRequest('/api/courses');
    } catch (err) {
      clear(area);
      area.appendChild(emptyState('Could not load your courses.'));
      return;
    }
    clear(area);
    if (!Array.isArray(courses) || !courses.length) {
      area.appendChild(emptyState('No courses yet. Click "New course" to set one up for a student you are teaching.'));
      return;
    }
    var list = el('div', 'pg-list');
    courses.forEach(function (c) {
      var row = el('div', 'pg-row-item');
      var info = el('div', 'pg-row-info');
      var line = el('div');
      line.appendChild(el('strong', '', c.title));
      line.appendChild(document.createTextNode(' — ' + (c.student_name || 'Student')));
      info.appendChild(line);
      var n = Number(c.module_count) || 0;
      var meta = el('div', 'pg-row-meta', n + (n === 1 ? ' module' : ' modules') + ' · ');
      meta.appendChild(el('span', 'status-tag ' + (c.status || ''), cap(c.status)));
      info.appendChild(meta);
      row.appendChild(info);
      var side = el('div', 'pg-row-side');
      side.appendChild(actionBtn('Manage', 'btn-outline', function (e) { openCourse(c.id, e.currentTarget); }));
      row.appendChild(side);
      list.appendChild(row);
    });
    area.appendChild(list);
  }

  /* ---------------- Create course ---------------- */
  var ccBackdrop = $('createCourseModalBackdrop');
  var ccSelect = $('createCourseEnrollment');
  var cc = { busy: false, seq: 0 };

  $('createCourseBtn').addEventListener('click', async function (e) {
    $('createCourseTitle').value = '';
    $('createCourseDescription').value = '';
    setMsg($('createCourseMsgBox'), '', '');
    ccSelect.innerHTML = '<option value="">Loading…</option>';
    openModal(ccBackdrop, ccSelect, e.currentTarget);
    var seq = ++cc.seq;
    try {
      var enrollments = await apiRequest('/api/enrollments?status=active');
      if (seq !== cc.seq) return;
      clear(ccSelect);
      if (!Array.isArray(enrollments) || !enrollments.length) {
        ccSelect.innerHTML = '<option value="">No active students yet</option>';
        return;
      }
      enrollments.forEach(function (en) {
        var o = document.createElement('option');
        o.value = en.id;
        o.textContent = (en.student_name || 'Student') + (en.subject ? ' — ' + en.subject : '');
        ccSelect.appendChild(o);
      });
    } catch (err) {
      if (seq !== cc.seq) return;
      ccSelect.innerHTML = '<option value="">Could not load students</option>';
    }
  });
  $('createCourseModalClose').addEventListener('click', function () { if (!cc.busy) closeModal(ccBackdrop); });
  $('createCourseModalCancel').addEventListener('click', function () { if (!cc.busy) closeModal(ccBackdrop); });

  $('createCourseModalConfirm').addEventListener('click', async function () {
    if (cc.busy) return;
    var box = $('createCourseMsgBox');
    var enrollmentId = ccSelect.value;
    var title = $('createCourseTitle').value.trim();
    var description = $('createCourseDescription').value.trim();
    if (!enrollmentId) { setMsg(box, 'error', 'Please choose a student.'); return; }
    if (!title) { setMsg(box, 'error', 'Please enter a course title.'); $('createCourseTitle').focus(); return; }
    var btn = $('createCourseModalConfirm');
    cc.busy = true;
    setBusy(btn, true);
    try {
      var result = await apiRequest('/api/courses', 'POST', { enrollment_id: enrollmentId, title: title, description: description });
      cc.busy = false;
      closeModal(ccBackdrop);
      toast('Course created');
      await loadCourses();
      if (result && result.course_id) openCourse(result.course_id, $('createCourseBtn'));
    } catch (err) {
      setMsg(box, 'error', err.message || 'Could not create the course.');
      cc.busy = false;
    } finally {
      setBusy(btn, false);
    }
  });

  /* ---------------- Course manager ---------------- */
  var cm = { id: null, course: null, busy: false, seq: 0 };
  var cmBackdrop = $('courseModalBackdrop');
  var cmMsg = $('cmMsgBox');

  async function openCourse(id, opener) {
    cm.id = id;
    cm.course = null;
    $('cmTitle').textContent = 'Course';
    $('cmSub').textContent = '';
    $('cmModules').innerHTML = '';
    $('cmModules').appendChild(emptyState('Loading…'));
    $('cmNewTitle').value = '';
    setMsg(cmMsg, '', '');
    openModal(cmBackdrop, $('courseModalClose'), opener);
    await refreshCourse();
  }

  async function refreshCourse() {
    var seq = ++cm.seq;
    try {
      var c = await apiRequest('/api/courses/' + encodeURIComponent(cm.id));
      if (seq !== cm.seq) return;
      cm.course = c;
      $('cmTitle').textContent = c.title || 'Course';
      $('cmSub').textContent = (c.student_name || 'Student') + (c.subject || c.enrollment_subject ? ' · ' + (c.subject || c.enrollment_subject) : '');
      $('cmStatus').value = ['active', 'paused', 'completed'].indexOf(c.status) > -1 ? c.status : 'active';
      renderModules(Array.isArray(c.modules) ? c.modules : []);
    } catch (err) {
      if (seq !== cm.seq) return;
      $('cmModules').innerHTML = '';
      $('cmModules').appendChild(emptyState(err.message || 'Could not load this course.'));
    }
  }

  function renderModules(mods) {
    var host = $('cmModules');
    clear(host);
    var prog = $('cmProgress');
    if (mods.length) {
      var doneN = mods.filter(function (m) { return m.status === 'completed'; }).length;
      var pct = Math.round(doneN / mods.length * 100);
      prog.hidden = false;
      prog.querySelector('i').style.width = pct + '%';
      prog.querySelector('.pg-hint').textContent = doneN + ' of ' + mods.length + (mods.length === 1 ? ' module' : ' modules') + ' completed (' + pct + '%)';
    } else {
      prog.hidden = true;
    }
    if (!mods.length) { host.appendChild(emptyState('No modules yet. Add the first one below.')); return; }
    mods.forEach(function (m, i) {
      var done = m.status === 'completed';
      var row = el('div', 'pg-mod' + (done ? ' is-done' : ''));
      row.appendChild(el('span', 'pg-mod-n', String(i + 1)));
      var body = el('div', 'pg-mod-body');
      body.appendChild(el('strong', '', m.title));
      if (m.description) body.appendChild(el('span', 'pg-row-meta', m.description));
      row.appendChild(body);
      var side = el('div', 'pg-row-side');
      // Module status values are "active" and "completed" only.
      side.appendChild(actionBtn(done ? 'Reopen' : 'Mark done', 'btn-outline', function (e) {
        patchModule(m.id, { status: done ? 'active' : 'completed' }, e.currentTarget);
      }));
      side.appendChild(actionBtn('Delete', 'btn-outline pg-danger', function (e) {
        if (window.confirm('Delete the module "' + m.title + '"? This cannot be undone.')) deleteModule(m.id, e.currentTarget);
      }, 'Delete module ' + m.title));
      row.appendChild(side);
      host.appendChild(row);
    });
  }

  async function patchModule(moduleId, body, btn) {
    btn.disabled = true;
    try {
      await apiRequest('/api/courses/' + encodeURIComponent(cm.id) + '/modules/' + encodeURIComponent(moduleId), 'PUT', body);
      await refreshCourse();
    } catch (err) {
      setMsg(cmMsg, 'error', err.message || 'Could not update the module.');
      btn.disabled = false;
    }
  }
  async function deleteModule(moduleId, btn) {
    btn.disabled = true;
    try {
      await apiRequest('/api/courses/' + encodeURIComponent(cm.id) + '/modules/' + encodeURIComponent(moduleId), 'DELETE');
      setMsg(cmMsg, '', '');
      await refreshCourse();
    } catch (err) {
      setMsg(cmMsg, 'error', err.message || 'Could not delete the module.');
      btn.disabled = false;
    }
  }

  $('cmAddForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (cm.busy) return;
    var title = $('cmNewTitle').value.trim();
    if (!title) { setMsg(cmMsg, 'error', 'Please enter a module title.'); $('cmNewTitle').focus(); return; }
    var btn = $('cmAddBtn');
    cm.busy = true;
    setBusy(btn, true);
    try {
      await apiRequest('/api/courses/' + encodeURIComponent(cm.id) + '/modules', 'POST', { title: title });
      $('cmNewTitle').value = '';
      setMsg(cmMsg, '', '');
      await refreshCourse();
      $('cmNewTitle').focus();
    } catch (err) {
      setMsg(cmMsg, 'error', err.message || 'Could not add the module.');
    } finally {
      cm.busy = false;
      setBusy(btn, false);
    }
  });

  $('cmStatus').addEventListener('change', async function () {
    var sel = $('cmStatus');
    var prev = cm.course ? cm.course.status : 'active';
    sel.disabled = true;
    try {
      await apiRequest('/api/courses/' + encodeURIComponent(cm.id), 'PUT', { status: sel.value });
      if (cm.course) cm.course.status = sel.value;
      setMsg(cmMsg, 'success', 'Course status updated.');
    } catch (err) {
      sel.value = prev;
      setMsg(cmMsg, 'error', err.message || 'Could not update the course.');
    } finally {
      sel.disabled = false;
    }
  });

  function closeCourse() { closeModal(cmBackdrop); }
  $('courseModalClose').addEventListener('click', closeCourse);
  $('courseModalDone').addEventListener('click', closeCourse);
  // Keep the course list in step with whatever changed inside the manager.
  var cmObserver = new MutationObserver(function () {
    if (!cmBackdrop.classList.contains('open') && cm.id !== null) { cm.id = null; loadCourses(); }
  });
  cmObserver.observe(cmBackdrop, { attributes: true, attributeFilter: ['class'] });

  /* ---------------- Quick actions (Ctrl+K) ---------------- */
  var cmdBackdrop = $('cmdBackdrop');
  var cmdInput = $('cmdInput');
  var cmdList = $('cmdList');
  var cmdShown = [];
  var cmdIndex = 0;

  function commands() {
    var list = [
      { label: 'Open My students', run: function () { window.location.href = 'teacher-students.html'; } },
      { label: 'Go to booking requests', run: function () { jumpTo('sec-requests'); } },
      { label: 'Show requests awaiting my reply', run: function () { setFilter('requested'); jumpTo('sec-requests'); } },
      { label: 'Go to my schedule', run: function () { jumpTo('sec-schedule'); } },
      { label: 'Go to my courses', run: function () { jumpTo('sec-courses'); } },
      { label: 'Go to my reviews', run: function () { jumpTo('sec-reviews'); } },
      { label: 'Go to earnings', run: function () { jumpTo('sec-earnings'); } },
      { label: 'Create a new course', run: function () { $('createCourseBtn').click(); } },
      { label: 'Export requests (CSV)', run: exportRequests },
      { label: 'Export earnings (CSV)', run: exportEarnings },
      { label: 'Refresh data now', run: function () { refreshAll(true); } },
      { label: 'Edit my profile', run: function () { window.location.href = 'teacher-complete-profile.html'; } }
    ];
    if (myTeacherId) list.push({ label: 'Preview my public profile', run: function () { window.location.href = 'teacher-profile-view.html?id=' + encodeURIComponent(myTeacherId); } });
    list.push({ label: 'Account settings', run: function () { window.location.href = 'account-settings.html'; } });
    list.push({ label: 'Log out', run: function () { $('logoutBtn').click(); } });
    return list;
  }
  function renderCmd() {
    var q = cmdInput.value.trim().toLowerCase();
    cmdShown = commands().filter(function (c) { return !q || c.label.toLowerCase().indexOf(q) !== -1; });
    if (cmdIndex >= cmdShown.length) cmdIndex = Math.max(0, cmdShown.length - 1);
    clear(cmdList);
    if (!cmdShown.length) { cmdList.appendChild(el('div', 'pg-cmd-empty', 'No matching action.')); return; }
    cmdShown.forEach(function (c, i) {
      var b = el('button', 'pg-cmd-item' + (i === cmdIndex ? ' is-active' : ''), c.label);
      b.type = 'button';
      b.id = 'cmd-opt-' + i;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(i === cmdIndex));
      b.tabIndex = -1;
      b.addEventListener('mousemove', function () { if (cmdIndex !== i) { cmdIndex = i; renderCmd(); } });
      b.addEventListener('click', function () { runCmd(i); });
      cmdList.appendChild(b);
    });
    cmdInput.setAttribute('aria-activedescendant', 'cmd-opt-' + cmdIndex);
  }
  function runCmd(i) {
    var c = cmdShown[i];
    if (!c) return;
    closeModal(cmdBackdrop);
    setTimeout(c.run, 0);
  }
  function openCmd(opener) {
    cmdInput.value = '';
    cmdIndex = 0;
    renderCmd();
    openModal(cmdBackdrop, cmdInput, opener || $('cmdBtn'));
  }
  cmdInput.addEventListener('input', function () { cmdIndex = 0; renderCmd(); });
  cmdInput.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (cmdShown.length) { cmdIndex = (cmdIndex + 1) % cmdShown.length; renderCmd(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (cmdShown.length) { cmdIndex = (cmdIndex - 1 + cmdShown.length) % cmdShown.length; renderCmd(); } }
    else if (e.key === 'Enter') { e.preventDefault(); runCmd(cmdIndex); }
  });
  cmdBackdrop.addEventListener('mousedown', function (e) { if (e.target === cmdBackdrop) closeModal(cmdBackdrop); });
  $('cmdBtn').addEventListener('click', function (e) { openCmd(e.currentTarget); });
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
      e.preventDefault();
      if (!openModals.length) openCmd();
      else if (openModals[openModals.length - 1].backdrop === cmdBackdrop) closeModal(cmdBackdrop);
    }
  });

  /* ---------------- Live refresh ---------------- */
  var lastRefresh = Date.now();
  function stamp() {
    lastRefresh = Date.now();
    $('updatedAt').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }
  function refreshAll(manual) {
    var btn = $('refreshBtn');
    if (manual) btn.disabled = true;
    return Promise.all([loadBookings(), loadEarnings()]).then(function () {
      stamp();
      if (manual) toast('Up to date');
    }).finally(function () { btn.disabled = false; });
  }
  $('refreshBtn').addEventListener('click', function () { refreshAll(true); });
  setInterval(function () {
    if (!document.hidden && !openModals.length) refreshAll(false);
  }, 60000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !openModals.length && Date.now() - lastRefresh > 60000) refreshAll(false);
  });

  /* ---------------- Go ---------------- */
  loadProfileSummary();
  loadCourses();
  refreshAll(false);
})();