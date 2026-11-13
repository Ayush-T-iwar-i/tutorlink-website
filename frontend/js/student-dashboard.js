/* ===========================================================
   TutorLink — Student dashboard
   Needs js/api.js and js/ui.js loaded first.
   Everything lives inside one function so nothing leaks into
   the global scope. Clicks use data-act attributes (no inline
   onclick), and every value from the server goes through
   escapeHtml() before it is put into the page.
   =========================================================== */
(function () {
  'use strict';

  var session = requireLogin('student');
  if (!session) return;
  var USER = session.user;

  // Must match APP_TIMEZONE on the server (default Asia/Kolkata). Class times are stored in this zone.
  var APP_TZ = 'Asia/Kolkata';
  var APP_TZ_OFFSET = '+05:30';
  var MAX_DAYS_AHEAD = 180; // same limit as the server
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var VIEWS = ['overview', 'find', 'classes', 'courses', 'payments', 'saved', 'support'];
  var SUBJECT_CHIPS = ['Maths', 'Science', 'English', 'Physics', 'Chemistry', 'Biology', 'Hindi', 'Computer'];
  var BRAND = '#7C5CFC';
  var DEFAULT_CENTER = [28.9845, 77.7064]; // Meerut — only used to open the map when nothing else is known
  var REPORT_REASONS = {
    no_show: 'No-show',
    inappropriate_behaviour: 'Inappropriate behaviour',
    payment_issue: 'Payment issue',
    fake_profile: 'Fake profile',
    other: 'Other'
  };

  function $(id) { return document.getElementById(id); }
  function esc(v) { return escapeHtml(v); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function reduceMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* ---------------------------------------------------------
     State
     --------------------------------------------------------- */
  var state = {
    me: null,
    student: null,
    bookings: [],
    bookingsError: null,
    sessions: {},          // bookingId -> array of class_sessions (only for accepted bookings)
    courses: [],
    coursesError: null,
    saved: [],
    savedError: null,
    favoriteIds: new Set(),
    reports: [],
    reportsError: null,
    loaded: { bookings: false, courses: false, saved: false, reports: false, student: false }
  };
  var ui = {
    view: 'overview',
    classFilter: 'all',
    classQuery: '',
    radius: 5,
    sort: 'nearest',
    minRating: 0,
    maxFee: null,
    search: { items: [], page: 0, totalPages: 0, total: 0, params: null, ran: false, loading: false, error: null }
  };
  var teacherCache = {};
  var confirmingPayments = new Set(); // payments received but not yet confirmed (prevents paying twice)
  var currentLat = null;
  var currentLng = null;
  var currentAddress = null;

  /* ---------------------------------------------------------
     Date + money helpers (all dates are plain YYYY-MM-DD)
     --------------------------------------------------------- */
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function todayIST() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  function hourIST() {
    var h = new Intl.DateTimeFormat('en-GB', { timeZone: APP_TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date());
    return parseInt(h, 10);
  }
  function addDays(dateStr, days) {
    var p = dateStr.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days)).toISOString().slice(0, 10);
  }
  function weekdayOf(dateStr) {
    var p = dateStr.split('-').map(Number);
    return WEEKDAYS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
  }
  function parseSlot(slot) {
    var m = String(slot || '').trim().match(/^(0?[1-9]|1[0-2]):([0-5]\d)\s*(AM|PM)$/i);
    if (!m) return null;
    var h = parseInt(m[1], 10) % 12;
    if (m[3].toUpperCase() === 'PM') h += 12;
    return { h: h, m: parseInt(m[2], 10) };
  }
  function classInstant(date, slot) {
    var t = parseSlot(slot);
    if (!t || !DATE_RE.test(String(date || ''))) return null;
    var d = new Date(date + 'T' + pad2(t.h) + ':' + pad2(t.m) + ':00' + APP_TZ_OFFSET);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(dateStr, long) {
    if (!DATE_RE.test(String(dateStr || ''))) return dateStr ? String(dateStr) : '—';
    var p = dateStr.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.toLocaleDateString('en-IN', long
      ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }
      : { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  function dateParts(dateStr) {
    if (!DATE_RE.test(String(dateStr || ''))) return { day: '—', mon: '', wd: '' };
    var p = dateStr.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return {
      day: String(p[2]),
      mon: d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }),
      wd: d.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })
    };
  }
  function fmtMoney(n) {
    return '₹' + num(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }
  function until(ms) {
    if (ms <= 0) {
      var ago = Math.floor(-ms / 60000);
      if (ago < 1) return 'Starting now';
      if (ago <= 60) return 'Started ' + ago + ' min ago';
      return 'Earlier today';
    }
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return 'In under a minute';
    if (mins < 60) return 'In ' + mins + ' min';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return 'In ' + hrs + 'h ' + (mins % 60) + 'm';
    var days = Math.floor(hrs / 24);
    return 'In ' + days + ' day' + (days === 1 ? '' : 's');
  }
  function initials(name) {
    var s = String(name || '').split(/\s+/).filter(Boolean).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
    return s || '?';
  }
  function avatarInner(name, photo) {
    if (photo) return '<img src="' + esc(photoUrl(photo)) + '" alt="">';
    return esc(initials(name));
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /* ---------------------------------------------------------
     Toast + confirm dialog
     --------------------------------------------------------- */
  var toastTimer = null;
  function toast(message, isError) {
    var el = $('toast');
    el.textContent = message;
    el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 5000);
  }

  // A backdrop is visibility:hidden until its fade-in starts, and hidden elements cannot take focus yet.
  function focusSoon(el) {
    var tries = 0;
    (function attempt() {
      el.focus();
      if (document.activeElement !== el && ++tries < 12) setTimeout(attempt, 30);
    })();
  }

  var confirmResolve = null;
  function ask(opts) {
    $('confirmTitle').textContent = opts.title;
    $('confirmText').textContent = opts.message;
    var yes = $('confirmYes');
    yes.textContent = opts.okText || 'Yes';
    yes.className = 'btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger');
    $('confirmNo').textContent = opts.cancelText || 'Keep it';
    $('confirmBackdrop').classList.add('open');
    focusSoon($('confirmNo'));
    return new Promise(function (resolve) { confirmResolve = resolve; });
  }
  function closeConfirm(result) {
    $('confirmBackdrop').classList.remove('open');
    if (confirmResolve) { var r = confirmResolve; confirmResolve = null; r(result); }
  }
  $('confirmYes').addEventListener('click', function () { closeConfirm(true); });
  $('confirmNo').addEventListener('click', function () { closeConfirm(false); });

  /* ---------------------------------------------------------
     Header + navigation
     --------------------------------------------------------- */
  $('welcomeText').textContent = USER.name || 'Student';
  $('avatarInitials').textContent = initials(USER.name);

  $('logoutBtn').addEventListener('click', function () {
    clearSession();
    window.location.href = 'login.html';
  });
  initNotificationBell();

  function currentRoute() {
    var name = location.hash.replace(/^#/, '');
    return VIEWS.indexOf(name) === -1 ? 'overview' : name;
  }
  function go(name) {
    if (currentRoute() === name && location.hash.replace(/^#/, '') === name) applyRoute(false);
    else location.hash = name;
  }
  function applyRoute(focusHeading) {
    var name = currentRoute();
    ui.view = name;
    VIEWS.forEach(function (v) {
      $('view-' + v).hidden = v !== name;
    });
    document.querySelectorAll('#sdRail .sd-nav').forEach(function (a) {
      if (a.dataset.view === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    var active = document.querySelector('#sdRail .sd-nav[aria-current="page"]');
    if (active && active.scrollIntoView && window.innerWidth <= 960) {
      try { active.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) { /* older browsers */ }
    }
    if (name === 'find') ensureFindReady();
    if (name !== 'overview' || focusHeading) window.scrollTo(0, 0);
    if (focusHeading) {
      var h = document.querySelector('#view-' + name + ' h2');
      if (h) h.focus({ preventScroll: true });
    }
  }
  window.addEventListener('hashchange', function () {
    var h = location.hash.replace(/^#/, '');
    if (VIEWS.indexOf(h) === -1) {
      // e.g. the skip link (#mainContent): keep the current view, just move focus
      if (h === 'mainContent') $('mainContent').focus();
      return;
    }
    applyRoute(true);
  });

  /* ---------------------------------------------------------
     Data loading
     --------------------------------------------------------- */
  async function loadMe() {
    try {
      var data = await apiRequest('/api/auth/me');
      state.me = (data && data.user) || null;
      if (state.me && state.me.profile_photo) {
        $('avatarInitials').innerHTML = '<img src="' + esc(photoUrl(state.me.profile_photo)) + '" alt="">';
      }
    } catch (e) { /* keep the initials */ }
    renderVerifyBanner();
    renderProfileCard();
    renderOverview();
  }

  async function loadStudent() {
    try {
      state.student = await apiRequest('/api/students/by-user/' + encodeURIComponent(USER.id));
      if (state.student && state.student.latitude !== null && state.student.longitude !== null &&
          state.student.latitude !== undefined && state.student.longitude !== undefined && currentLat === null) {
        var lat = parseFloat(state.student.latitude);
        var lng = parseFloat(state.student.longitude);
        if (isFinite(lat) && isFinite(lng)) {
          currentLat = lat;
          currentLng = lng;
          currentAddress = {
            area: state.student.area || '',
            district: state.student.district || '',
            pincode: state.student.pincode || '',
            display: state.student.address || ''
          };
        }
      }
    } catch (e) { state.student = null; }
    state.loaded.student = true;
    renderLocation();
    renderProfileCard();
    renderChips();
    renderOverview();
    if (ui.view === 'find') ensureFindReady();
  }

  async function loadBookings() {
    try {
      var data = await apiRequest('/api/bookings/student/me');
      state.bookings = Array.isArray(data) ? data : ((data && data.bookings) || []);
      state.bookingsError = null;
    } catch (e) {
      state.bookingsError = e.message || 'Could not load your bookings.';
    }
    state.loaded.bookings = true;
    renderAll();
    await loadSessions();
    renderAll();
  }

  async function loadSessions() {
    var accepted = state.bookings.filter(function (b) { return b.status === 'accepted'; }).slice(0, 15);
    var results = await Promise.allSettled(accepted.map(function (b) {
      return apiRequest('/api/bookings/' + encodeURIComponent(b.id) + '/sessions');
    }));
    var next = {};
    results.forEach(function (r, i) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) next[accepted[i].id] = r.value;
    });
    state.sessions = next;
  }

  async function loadCourses() {
    try {
      var data = await apiRequest('/api/courses');
      state.courses = Array.isArray(data) ? data : [];
      state.coursesError = null;
    } catch (e) { state.coursesError = e.message || 'Could not load your courses.'; }
    state.loaded.courses = true;
    renderCourses();
  }

  async function loadSaved() {
    try {
      var data = await apiRequest('/api/favorites/me');
      state.saved = Array.isArray(data) ? data : [];
      state.favoriteIds = new Set(state.saved.map(function (t) { return Number(t.id); }));
      state.savedError = null;
    } catch (e) { state.savedError = e.message || 'Could not load saved teachers.'; }
    state.loaded.saved = true;
    renderSaved();
    renderResults();
    renderNavBadges();
    renderOverview();
  }

  async function loadReports() {
    try {
      var data = await apiRequest('/api/reports/mine');
      state.reports = Array.isArray(data) ? data : [];
      state.reportsError = null;
    } catch (e) { state.reportsError = e.message || 'Could not load your reports.'; }
    state.loaded.reports = true;
    renderReports();
  }

  /* ---------------------------------------------------------
     Derived data
     --------------------------------------------------------- */
  function bookingStatus(b) { return String(b.status || 'requested').toLowerCase(); }
  function isOpenStatus(s) { return s === 'requested' || s === 'accepted'; }

  // Every scheduled class that has not finished yet, soonest first.
  function classEvents() {
    var out = [];
    var now = Date.now();
    state.bookings.forEach(function (b) {
      if (bookingStatus(b) !== 'accepted') return;
      var sess = state.sessions[b.id];
      var list = [];
      if (Array.isArray(sess)) {
        list = sess.filter(function (s) { return s.status === 'scheduled'; })
          .map(function (s) { return { date: s.session_date, time: s.session_time || b.booking_time }; });
      } else if (b.booking_date) {
        list = [{ date: b.booking_date, time: b.booking_time }]; // sessions not loaded (yet): fall back to the first date
      }
      list.forEach(function (s) {
        var at = classInstant(s.date, s.time);
        if (!at || at.getTime() < now - 60 * 60000) return;
        out.push({ booking: b, date: s.date, time: s.time, at: at });
      });
    });
    out.sort(function (a, c) { return a.at - c.at; });
    return out;
  }

  function payInfo(b) {
    var s = bookingStatus(b);
    var fee = num(b.fee);
    if (b.payment_status === 'refunded') return { label: 'Refunded', tone: 'info' };
    if (fee > 0 && b.payment_status === 'paid') return { label: 'Paid', tone: 'ok' };
    if (s === 'accepted' && fee > 0) return { label: 'Payment due', tone: 'warn' };
    if (s === 'completed' && fee > 0) return { label: 'Payment pending', tone: 'warn' };
    if ((s === 'accepted' || s === 'completed') && fee === 0) return { label: 'No charge', tone: 'muted' };
    return null;
  }
  function isDue(b) {
    return bookingStatus(b) === 'accepted' && b.payment_status === 'unpaid' && num(b.fee) > 0;
  }
  function findBooking(id) {
    id = Number(id);
    return state.bookings.find(function (b) { return Number(b.id) === id; }) || null;
  }
  function typeLabel(b) {
    if (b.type === 'recurring') {
      var days = String(b.days_per_week || '').split(',').map(function (d) { return d.trim(); }).filter(Boolean).join(', ');
      return 'Weekly' + (days ? ' · ' + days : '');
    }
    return 'Demo class';
  }

  /* ---------------------------------------------------------
     Rendering — shared pieces
     --------------------------------------------------------- */
  function emptyState(icon, title, text, actionHtml) {
    return '<div class="sd-empty"><div class="sd-empty-ic" aria-hidden="true">' + icon + '</div><h3>' + esc(title) + '</h3>' +
      (text ? '<p>' + esc(text) + '</p>' : '') + (actionHtml || '') + '</div>';
  }
  function errorState(message, retryAct) {
    return '<div class="sd-empty sd-empty-err"><div class="sd-empty-ic" aria-hidden="true">⚠️</div><h3>Something went wrong</h3><p>' +
      esc(message) + '</p><button type="button" class="btn btn-outline btn-sm" data-act="' + retryAct + '">Try again</button></div>';
  }
  function skeletons(n) {
    var h = '';
    for (var i = 0; i < n; i++) h += '<div class="sd-skel sd-skel-lg"></div>';
    return h;
  }
  function tag(label, tone) {
    return '<span class="sd-tag sd-tag-' + (tone || 'muted') + '">' + esc(label) + '</span>';
  }
  function statusTag(status) {
    var tone = { requested: 'warn', accepted: 'ok', completed: 'ok', declined: 'bad', cancelled: 'bad' }[status] || 'muted';
    var label = { requested: 'Waiting for teacher', accepted: 'Confirmed', completed: 'Completed', declined: 'Declined', cancelled: 'Cancelled' }[status] || status;
    return tag(label, tone);
  }

  function renderAll() {
    renderNavBadges();
    renderOverview();
    renderClasses();
    renderPayments();
    renderProfileCard();
  }

  function renderNavBadges() {
    var open = state.bookings.filter(function (b) { return isOpenStatus(bookingStatus(b)); }).length;
    var due = state.bookings.filter(isDue).length;
    setBadge('navClassesBadge', open);
    setBadge('navPaymentsBadge', due);
    setBadge('navSavedBadge', state.saved.length);
  }
  function setBadge(id, n) {
    var el = $(id);
    el.textContent = n > 99 ? '99+' : String(n);
    el.hidden = !(n > 0);
  }

  function renderVerifyBanner() {
    var host = $('verifyBanner');
    if (!state.me || state.me.email_verified) { host.innerHTML = ''; return; }
    host.innerHTML =
      '<div class="container"><div class="sd-banner" role="status">' +
      '<div><strong>Please verify your email</strong><span>You need a verified email to book classes. Check your inbox, or resend the link.</span></div>' +
      '<button type="button" class="btn btn-accent btn-sm" data-act="resend-verify">Resend email</button></div></div>';
  }

  function profileChecks() {
    var s = state.student || {};
    var me = state.me || {};
    return [
      { ok: !!me.email_verified, label: 'Verify your email' },
      { ok: !!me.profile_photo, label: 'Add a profile photo' },
      { ok: currentLat !== null, label: 'Set your location' },
      { ok: !!s.preferred_subjects, label: 'Add the subjects you want' },
      { ok: !!s.address, label: 'Add your address' }
    ];
  }
  function renderProfileCard() {
    var card = $('profileCard');
    if (!state.me && !state.loaded.student) { card.hidden = true; return; }
    var checks = profileChecks();
    var done = checks.filter(function (c) { return c.ok; }).length;
    var pct = Math.round(done / checks.length * 100);
    card.hidden = false;
    $('profileRing').style.setProperty('--pct', pct + '%');
    $('profilePct').textContent = pct + '%';
    var missing = checks.filter(function (c) { return !c.ok; })[0];
    $('profileHint').innerHTML = missing
      ? esc(missing.label) + '. <a href="student-complete-profile.html">Edit profile</a>'
      : 'All set. Teachers can match you better.';
  }

  /* ---------------------------------------------------------
     Overview
     --------------------------------------------------------- */
  function countTo(id, value, formatter) {
    var el = $(id);
    var fmt = formatter || function (v) { return String(v); };
    var target = num(value);
    if (reduceMotion() || target === 0) { el.textContent = fmt(target); return; }
    var start = performance.now();
    var dur = 600;
    function tick(now) {
      var p = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(tick); else el.textContent = fmt(target);
    }
    requestAnimationFrame(tick);
  }

  var lastStats = {};
  function setStat(id, value, formatter) {
    if (lastStats[id] === value) return;
    lastStats[id] = value;
    countTo(id, value, formatter);
  }

  function renderOverview() {
    var first = String(USER.name || 'there').split(' ')[0];
    var h = hourIST();
    var greet = h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Good night';
    $('h-overview').textContent = greet + ', ' + first;

    var events = classEvents();
    var next = events[0] || null;

    if (!state.loaded.bookings) {
      $('heroSub').textContent = 'Loading your day…';
    } else if (state.bookingsError) {
      $('heroSub').textContent = 'We could not load your classes just now.';
    } else if (next) {
      $('heroSub').innerHTML = 'Your next class is <strong>' + esc(next.booking.subject || 'a class') + '</strong> with <strong>' +
        esc(next.booking.teacher_name || 'your teacher') + '</strong>, ' + esc(until(next.at - Date.now()).toLowerCase()) + '.';
    } else if (state.bookings.some(function (b) { return bookingStatus(b) === 'requested'; })) {
      $('heroSub').textContent = 'Your request is with the teacher. We will notify you as soon as they reply.';
    } else {
      $('heroSub').textContent = 'No classes yet. Find a verified tutor near you and book a demo.';
    }

    var loc = $('heroLoc');
    if (currentLat !== null && currentAddress) {
      loc.innerHTML = '<span class="sd-loc-pill">📍 ' + esc(currentAddress.area || 'Location set') +
        (currentAddress.district && currentAddress.district !== '—' ? ', ' + esc(currentAddress.district) : '') + '</span>';
    } else {
      loc.innerHTML = '<button type="button" class="sd-loc-pill sd-loc-pill-btn" data-act="goto-location">📍 Set your location</button>';
    }

    var b = state.bookings;
    if (state.loaded.bookings && !state.bookingsError) {
      setStat('statAhead', events.length);
      setStat('statPending', b.filter(function (x) { return bookingStatus(x) === 'requested'; }).length);
      setStat('statDone', b.filter(function (x) { return bookingStatus(x) === 'completed'; }).length);
      var paid = b.reduce(function (sum, x) { return sum + (x.payment_status === 'paid' ? num(x.fee) : 0); }, 0);
      setStat('statPaid', paid, fmtMoney);
    }

    renderNextCard(next);
    renderAttention();
    renderWeek(events);
  }

  function renderNextCard(next) {
    var host = $('nextCard');
    if (!state.loaded.bookings) { host.innerHTML = '<div class="sd-skel sd-skel-lg"></div>'; return; }
    if (state.bookingsError) { host.innerHTML = errorState(state.bookingsError, 'reload-bookings'); return; }
    if (!next) {
      host.innerHTML = '<header class="sd-card-head"><h3>Next class</h3></header>' +
        emptyState('🎓', 'Nothing scheduled', 'When a teacher accepts your request, your class shows up here with a live countdown.',
          '<a href="#find" class="btn btn-primary btn-sm">Find a tutor</a>');
      return;
    }
    var b = next.booking;
    var dp = dateParts(next.date);
    var live = next.at.getTime() - Date.now() <= 0;
    host.innerHTML =
      '<header class="sd-card-head"><h3>Next class</h3>' + (live ? tag('Happening now', 'ok') : '') + '</header>' +
      '<div class="sd-next-body">' +
        '<div class="sd-datetile"><span>' + esc(dp.wd) + '</span><strong>' + esc(dp.day) + '</strong><span>' + esc(dp.mon) + '</span></div>' +
        '<div class="sd-next-info">' +
          '<h4>' + esc(b.subject || 'Class') + ' with ' + esc(b.teacher_name || 'your teacher') + '</h4>' +
          '<p class="sd-muted">' + esc(fmtDate(next.date, true)) + ' · ' + esc(next.time || '') + '</p>' +
          '<div class="sd-countdown" data-countdown="' + next.at.getTime() + '">' + esc(until(next.at - Date.now())) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="sd-row-actions">' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="chat" data-id="' + Number(b.id) + '">💬 Chat with teacher</button>' +
        '<button type="button" class="btn btn-outline btn-sm" data-act="details" data-id="' + Number(b.id) + '">Details</button>' +
        (isDue(b) ? '<button type="button" class="btn btn-accent btn-sm" data-act="pay" data-id="' + Number(b.id) + '">Pay ' + esc(fmtMoney(b.fee)) + '</button>' : '') +
      '</div>';
  }

  function attentionItems() {
    var items = [];
    if (state.me && !state.me.email_verified) {
      items.push({ tone: 'warn', icon: '✉️', title: 'Verify your email', text: 'Required before you can book a class.', act: 'resend-verify', label: 'Resend' });
    }
    if (state.loaded.student && currentLat === null) {
      items.push({ tone: 'warn', icon: '📍', title: 'Set your location', text: 'So we can show teachers near you.', act: 'goto-location', label: 'Set now' });
    }
    state.bookings.filter(isDue).slice(0, 3).forEach(function (b) {
      items.push({ tone: 'warn', icon: '💳', title: 'Pay ' + fmtMoney(b.fee) + ' to ' + (b.teacher_name || 'your teacher'),
        text: (b.subject || 'Class') + ' · ' + fmtDate(b.booking_date), act: 'pay', id: b.id, label: 'Pay now' });
    });
    state.bookings.filter(function (b) { return bookingStatus(b) === 'completed' && !b.review_id; }).slice(0, 3).forEach(function (b) {
      items.push({ tone: 'info', icon: '⭐', title: 'How was ' + (b.subject || 'your class') + ' with ' + (b.teacher_name || 'your teacher') + '?',
        text: 'A short review helps other students.', act: 'review', id: b.id, label: 'Review' });
    });
    if (state.loaded.student && state.student && !state.student.preferred_subjects) {
      items.push({ tone: 'muted', icon: '🧩', title: 'Add the subjects you want', text: 'Takes a minute and improves your matches.', href: 'student-complete-profile.html', label: 'Edit profile' });
    }
    return items;
  }

  function renderAttention() {
    var host = $('attentionList');
    if (!state.loaded.bookings && !state.loaded.student) { host.innerHTML = '<div class="sd-skel"></div><div class="sd-skel"></div>'; return; }
    var items = attentionItems();
    if (!items.length) {
      host.innerHTML = emptyState('✨', 'You are all caught up', 'Nothing needs your attention right now.');
      return;
    }
    host.innerHTML = '<ul class="sd-todo">' + items.slice(0, 6).map(function (it) {
      var action = it.href
        ? '<a class="btn btn-outline btn-sm" href="' + esc(it.href) + '">' + esc(it.label) + '</a>'
        : '<button type="button" class="btn btn-outline btn-sm" data-act="' + esc(it.act) + '"' + (it.id ? ' data-id="' + Number(it.id) + '"' : '') + '>' + esc(it.label) + '</button>';
      return '<li class="sd-todo-' + it.tone + '"><span class="sd-todo-ic" aria-hidden="true">' + it.icon + '</span>' +
        '<div><strong>' + esc(it.title) + '</strong><span>' + esc(it.text) + '</span></div>' + action + '</li>';
    }).join('') + '</ul>';
  }

  function renderWeek(events) {
    var strip = $('weekStrip');
    var today = todayIST();
    var cells = '';
    for (var i = 0; i < 7; i++) {
      var d = addDays(today, i);
      var count = events.filter(function (e) { return e.date === d; }).length;
      var dp = dateParts(d);
      cells += '<div class="sd-day' + (i === 0 ? ' is-today' : '') + (count ? ' has-class' : '') + '">' +
        '<span>' + esc(i === 0 ? 'Today' : dp.wd) + '</span><strong>' + esc(dp.day) + '</strong>' +
        '<em>' + (count ? plural(count, 'class', 'classes') : '—') + '</em></div>';
    }
    strip.innerHTML = cells;
    $('weekRange').textContent = fmtDate(today) + ' – ' + fmtDate(addDays(today, 6));

    var agenda = $('agendaList');
    if (!state.loaded.bookings) { agenda.innerHTML = ''; return; }
    var upcoming = events.slice(0, 6);
    if (!upcoming.length) { agenda.innerHTML = ''; return; }
    agenda.innerHTML = '<h4 class="sd-subhead">Coming up</h4><ul class="sd-agenda-list">' + upcoming.map(function (e) {
      return '<li><span class="sd-agenda-when"><strong>' + esc(fmtDate(e.date)) + '</strong>' + esc(e.time || '') + '</span>' +
        '<span class="sd-agenda-what">' + esc(e.booking.subject || 'Class') + ' · ' + esc(e.booking.teacher_name || 'Teacher') + '</span>' +
        '<span class="sd-muted" data-countdown="' + e.at.getTime() + '">' + esc(until(e.at - Date.now())) + '</span></li>';
    }).join('') + '</ul>';
  }

  // Keep countdowns fresh without re-rendering the whole page.
  setInterval(function () {
    var nodes = document.querySelectorAll('[data-countdown]');
    var stale = false;
    nodes.forEach(function (n) {
      var t = Number(n.dataset.countdown);
      if (!t) return;
      var ms = t - Date.now();
      n.textContent = until(ms);
      if (ms < -3600000) stale = true;
    });
    if (stale) renderOverview();
  }, 30000);

  /* ---------------------------------------------------------
     My classes
     --------------------------------------------------------- */
  function classMatchesFilter(b) {
    var s = bookingStatus(b);
    if (ui.classFilter === 'upcoming') return isOpenStatus(s);
    if (ui.classFilter === 'completed') return s === 'completed';
    if (ui.classFilter === 'closed') return s === 'cancelled' || s === 'declined';
    return true;
  }
  function bookingSortKey(b) {
    var at = classInstant(b.booking_date, b.booking_time);
    return at ? at.getTime() : (b.created_at ? new Date(b.created_at).getTime() : 0);
  }

  function renderClasses() {
    var host = $('bookingsArea');
    if (!state.loaded.bookings) { host.innerHTML = skeletons(2); return; }
    if (state.bookingsError) { host.innerHTML = errorState(state.bookingsError, 'reload-bookings'); return; }

    var all = state.bookings;
    $('tabAll').textContent = all.length;
    $('tabUpcoming').textContent = all.filter(function (b) { return isOpenStatus(bookingStatus(b)); }).length;
    $('tabCompleted').textContent = all.filter(function (b) { return bookingStatus(b) === 'completed'; }).length;
    $('tabClosed').textContent = all.filter(function (b) { var s = bookingStatus(b); return s === 'cancelled' || s === 'declined'; }).length;
    document.querySelectorAll('#classTabs button').forEach(function (btn) {
      btn.setAttribute('aria-selected', String(btn.dataset.filter === ui.classFilter));
    });

    if (!all.length) {
      host.innerHTML = emptyState('📅', 'No classes yet', 'Search for a tutor near you and request a demo class to get started.',
        '<a href="#find" class="btn btn-primary btn-sm">Find a tutor</a>');
      return;
    }

    var q = ui.classQuery.trim().toLowerCase();
    var list = all.filter(classMatchesFilter).filter(function (b) {
      if (!q) return true;
      return String(b.teacher_name || '').toLowerCase().indexOf(q) !== -1 || String(b.subject || '').toLowerCase().indexOf(q) !== -1;
    });
    list.sort(function (a, c) {
      var ao = isOpenStatus(bookingStatus(a)); var co = isOpenStatus(bookingStatus(c));
      if (ao !== co) return ao ? -1 : 1;
      return ao ? bookingSortKey(a) - bookingSortKey(c) : bookingSortKey(c) - bookingSortKey(a);
    });

    if (!list.length) {
      host.innerHTML = emptyState('🔎', 'Nothing matches', q ? 'Try a different name or subject.' : 'No classes in this view.');
      return;
    }
    host.innerHTML = '<div class="sd-list">' + list.map(bookingCard).join('') + '</div>';
  }

  function bookingCard(b) {
    var status = bookingStatus(b);
    var dp = dateParts(b.booking_date);
    var pay = payInfo(b);
    var hasReview = !!b.review_id;
    var hoursSince = hasReview ? (Date.now() - new Date(b.review_created_at).getTime()) / 36e5 : null;
    var canEdit = hasReview && hoursSince !== null && isFinite(hoursSince) && hoursSince <= 24;
    var id = Number(b.id);
    var at = classInstant(b.booking_date, b.booking_time);
    var countdown = (status === 'accepted' && at && at.getTime() > Date.now() - 3600000)
      ? '<span class="sd-countdown-sm" data-countdown="' + at.getTime() + '">' + esc(until(at - Date.now())) + '</span>' : '';

    var feeText = status === 'requested' ? 'Fee set when accepted'
      : (num(b.fee) > 0 ? fmtMoney(b.fee) : (status === 'declined' || status === 'cancelled' ? '' : 'No charge'));

    var actions = '';
    if (isDue(b)) {
      actions += confirmingPayments.has(id)
        ? '<button type="button" class="btn btn-outline btn-sm" disabled>⏳ Confirming payment…</button>'
        : '<button type="button" class="btn btn-accent btn-sm" data-act="pay" data-id="' + id + '">💳 Pay ' + esc(fmtMoney(b.fee)) + '</button>';
    }
    if (status === 'accepted' || status === 'completed') {
      actions += '<button type="button" class="btn btn-outline btn-sm" data-act="chat" data-id="' + id + '">💬 Chat</button>';
    }
    if (status === 'completed' && !hasReview) {
      actions += '<button type="button" class="btn btn-outline btn-sm" data-act="review" data-id="' + id + '">⭐ Review</button>';
    }
    if (canEdit) {
      actions += '<button type="button" class="btn btn-outline btn-sm" data-act="edit-review" data-id="' + id + '">✏️ Edit review</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="delete-review" data-id="' + id + '" aria-label="Delete review">🗑️</button>';
    }
    actions += '<button type="button" class="btn btn-ghost btn-sm" data-act="details" data-id="' + id + '">Details</button>';
    if (isOpenStatus(status)) {
      actions += '<button type="button" class="btn btn-ghost btn-sm sd-danger" data-act="cancel" data-id="' + id + '">Cancel class</button>';
    }
    if (status === 'accepted' || status === 'completed') {
      actions += '<button type="button" class="btn btn-ghost btn-sm" data-act="report" data-id="' + id + '" title="Report an issue" aria-label="Report an issue">🚩</button>';
    }

    var review = '';
    if (hasReview) {
      var r = Math.max(0, Math.min(5, num(b.review_rating)));
      review = '<div class="sd-review"><span class="sd-stars-line" aria-label="' + r + ' out of 5 stars">' + '★'.repeat(r) + '☆'.repeat(5 - r) + '</span>' +
        (b.review_comment ? ' ' + esc(b.review_comment) : '') +
        (b.teacher_reply ? '<div class="sd-reply"><strong>Teacher’s reply:</strong> ' + esc(b.teacher_reply) + '</div>' : '') + '</div>';
    }

    return '<article class="sd-booking sd-b-' + esc(status) + '">' +
      '<div class="sd-datetile"><span>' + esc(dp.wd) + '</span><strong>' + esc(dp.day) + '</strong><span>' + esc(dp.mon) + '</span></div>' +
      '<div class="sd-booking-main">' +
        '<div class="sd-booking-top"><h4>' + esc(b.subject || 'Class') + ' <span class="sd-muted">with</span> ' + esc(b.teacher_name || 'Teacher') + '</h4>' + countdown + '</div>' +
        '<div class="sd-meta">' +
          '<span>🕒 ' + esc(b.booking_time || '—') + '</span>' +
          '<span>' + esc(typeLabel(b)) + '</span>' +
          (feeText ? '<span>' + esc(feeText) + '</span>' : '') +
        '</div>' +
        '<div class="sd-tags">' + statusTag(status) + (pay ? tag(pay.label, pay.tone) : '') + '</div>' +
        review +
      '</div>' +
      '<div class="sd-booking-actions">' + actions + '</div>' +
    '</article>';
  }

  /* ---------------------------------------------------------
     Courses
     --------------------------------------------------------- */
  function renderCourses() {
    var host = $('coursesArea');
    if (!state.loaded.courses) { host.innerHTML = skeletons(1); return; }
    if (state.coursesError) { host.innerHTML = errorState(state.coursesError, 'reload-courses'); return; }
    if (!state.courses.length) {
      host.innerHTML = emptyState('📚', 'No courses yet', 'Your teacher can set up a course once your classes are underway. It will appear here.');
      return;
    }
    host.innerHTML = '<div class="sd-cards">' + state.courses.map(function (c) {
      var mods = num(c.module_count);
      var tone = c.status === 'completed' ? 'ok' : c.status === 'paused' ? 'warn' : 'info';
      return '<article class="sd-card sd-course">' +
        '<div class="sd-course-top">' + tag(c.status || 'active', tone) + (c.subject ? '<span class="sd-muted">' + esc(c.subject) + '</span>' : '') + '</div>' +
        '<h4>' + esc(c.title) + '</h4>' +
        '<p class="sd-muted">with ' + esc(c.teacher_name || 'your teacher') + ' · ' + esc(plural(mods, 'module', 'modules')) + '</p>' +
        (c.description ? '<p class="sd-clamp">' + esc(c.description) + '</p>' : '') +
        '<button type="button" class="btn btn-outline btn-sm" data-act="open-course" data-id="' + Number(c.id) + '">Open course</button>' +
      '</article>';
    }).join('') + '</div>';
  }

  async function openCourse(id) {
    $('courseTitle').textContent = 'Course';
    $('courseSub').textContent = '';
    $('courseBody').innerHTML = skeletons(1);
    $('courseModalBackdrop').classList.add('open');
    try {
      var c = await apiRequest('/api/courses/' + encodeURIComponent(id));
      var mods = Array.isArray(c.modules) ? c.modules : [];
      var done = mods.filter(function (m) { return m.status === 'completed'; }).length;
      var pct = mods.length ? Math.round(done / mods.length * 100) : 0;
      $('courseTitle').textContent = c.title || 'Course';
      $('courseSub').textContent = 'with ' + (c.teacher_name || 'your teacher') + (c.subject ? ' · ' + c.subject : '');
      $('courseBody').innerHTML =
        (c.description ? '<p>' + esc(c.description) + '</p>' : '') +
        '<div class="sd-meta">' +
          (c.start_date ? '<span>Starts ' + esc(fmtDate(String(c.start_date).slice(0, 10))) + '</span>' : '') +
          (c.end_date ? '<span>Ends ' + esc(fmtDate(String(c.end_date).slice(0, 10))) + '</span>' : '') +
          '<span>' + esc(c.status || 'active') + '</span>' +
        '</div>' +
        '<div class="sd-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Course progress"><i style="width:' + pct + '%"></i></div>' +
        '<p class="sd-muted">' + esc(done + ' of ' + plural(mods.length, 'module', 'modules') + ' completed') + '</p>' +
        (mods.length
          ? '<ol class="sd-modules">' + mods.map(function (m) {
              var ok = m.status === 'completed';
              return '<li class="' + (ok ? 'is-done' : '') + '"><span class="sd-check" aria-hidden="true">' + (ok ? '✓' : '') + '</span>' +
                '<div><strong>' + esc(m.title) + '</strong>' + (m.description ? '<span>' + esc(m.description) + '</span>' : '') + '</div>' +
                '<em class="sd-muted">' + (ok ? 'Done' : 'To do') + '</em></li>';
            }).join('') + '</ol>'
          : emptyState('🗂️', 'No modules yet', 'Your teacher has not added any modules to this course.'));
    } catch (e) {
      $('courseBody').innerHTML = errorState(e.message || 'Could not load this course.', 'close-course');
    }
  }

  /* ---------------------------------------------------------
     Payments
     --------------------------------------------------------- */
  function paymentRows() {
    return state.bookings.filter(function (b) {
      return num(b.fee) > 0 || b.payment_status === 'refunded';
    }).sort(function (a, c) { return bookingSortKey(c) - bookingSortKey(a); });
  }

  function renderPayments() {
    var host = $('paymentsArea');
    if (!state.loaded.bookings) { host.innerHTML = skeletons(1); return; }
    if (state.bookingsError) { host.innerHTML = errorState(state.bookingsError, 'reload-bookings'); return; }

    var rows = paymentRows();
    var paid = 0, due = 0, refunded = 0;
    rows.forEach(function (b) {
      var fee = num(b.fee);
      if (b.payment_status === 'paid') paid += fee;
      else if (b.payment_status === 'refunded') refunded += fee;
      else if (isDue(b)) due += fee;
    });
    $('payPaid').textContent = fmtMoney(paid);
    $('payDue').textContent = fmtMoney(due);
    $('payRefunded').textContent = fmtMoney(refunded);
    $('exportBtn').disabled = rows.length === 0;

    if (!rows.length) {
      host.innerHTML = emptyState('💳', 'No payments yet', 'When a teacher accepts a class and sets a fee, it shows up here.');
      return;
    }
    host.innerHTML = '<div class="sd-list">' + rows.map(function (b) {
      var id = Number(b.id);
      var pay = payInfo(b);
      var method = b.payment_status === 'paid' ? (b.razorpay_payment_id ? 'Online' : 'Paid to teacher directly') : '';
      return '<article class="sd-pay">' +
        '<div><strong>' + esc(b.subject || 'Class') + ' · ' + esc(b.teacher_name || 'Teacher') + '</strong>' +
        '<span class="sd-muted">' + esc(fmtDate(b.booking_date)) + ' · ' + esc(b.booking_time || '') + (method ? ' · ' + esc(method) : '') + '</span></div>' +
        '<div class="sd-pay-amt">' + esc(fmtMoney(b.fee)) + '</div>' +
        '<div>' + (pay ? tag(pay.label, pay.tone) : '') + '</div>' +
        '<div class="sd-pay-act">' + (isDue(b)
          ? (confirmingPayments.has(id)
              ? '<button type="button" class="btn btn-outline btn-sm" disabled>⏳ Confirming…</button>'
              : '<button type="button" class="btn btn-accent btn-sm" data-act="pay" data-id="' + id + '">Pay now</button>')
          : '') + '</div>' +
      '</article>';
    }).join('') + '</div>';
  }

  function csvCell(v) {
    var s = String(v === null || v === undefined ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets from running a cell as a formula
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function exportPayments() {
    var rows = paymentRows();
    if (!rows.length) return;
    var lines = [['Booking', 'Date', 'Time', 'Teacher', 'Subject', 'Amount (INR)', 'Status'].map(csvCell).join(',')];
    rows.forEach(function (b) {
      var pay = payInfo(b);
      lines.push([b.id, b.booking_date, b.booking_time, b.teacher_name, b.subject, num(b.fee).toFixed(2), pay ? pay.label : b.payment_status].map(csvCell).join(','));
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'tutorlink-payments.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------------------------------------------------------
     Saved teachers
     --------------------------------------------------------- */
  function renderSaved() {
    var host = $('savedTeachersArea');
    if (!state.loaded.saved) { host.innerHTML = skeletons(1); return; }
    if (state.savedError) { host.innerHTML = errorState(state.savedError, 'reload-saved'); return; }
    renderNavBadges();
    if (!state.saved.length) {
      host.innerHTML = emptyState('🤍', 'No saved teachers yet', 'Tap the heart on any teacher card to keep them here.',
        '<a href="#find" class="btn btn-primary btn-sm">Find a tutor</a>');
      return;
    }
    state.saved.forEach(function (t) {
      teacherCache[t.id] = Object.assign({}, teacherCache[t.id] || {}, t);
    });
    host.innerHTML = '<div class="sd-cards">' + state.saved.map(function (t) { return teacherCard(t, false); }).join('') + '</div>';
  }

  async function toggleFavorite(teacherId, btn) {
    teacherId = Number(teacherId);
    var wasSaved = state.favoriteIds.has(teacherId);
    if (btn) btn.disabled = true;
    try {
      if (wasSaved) {
        await apiRequest('/api/favorites/' + encodeURIComponent(teacherId), 'DELETE');
        state.favoriteIds.delete(teacherId);
        state.saved = state.saved.filter(function (t) { return Number(t.id) !== teacherId; });
        toast('Removed from saved teachers');
      } else {
        await apiRequest('/api/favorites', 'POST', { teacher_id: teacherId });
        state.favoriteIds.add(teacherId);
        toast('Teacher saved');
        await loadSaved();
        return;
      }
      renderSaved();
      renderResults();
      renderNavBadges();
    } catch (err) {
      toast(err.message, true);
      if (btn) btn.disabled = false;
    }
  }

  /* ---------------------------------------------------------
     Reports
     --------------------------------------------------------- */
  function renderReports() {
    var host = $('reportsArea');
    if (!state.loaded.reports) { host.innerHTML = '<div class="sd-skel"></div>'; return; }
    if (state.reportsError) { host.innerHTML = errorState(state.reportsError, 'reload-reports'); return; }
    if (!state.reports.length) {
      host.innerHTML = emptyState('🛡️', 'No reports filed', 'If something goes wrong in a class, you can report it from My classes.');
      return;
    }
    host.innerHTML = '<ul class="sd-todo">' + state.reports.map(function (r) {
      var tone = r.status === 'resolved' ? 'ok' : r.status === 'dismissed' ? 'muted' : 'warn';
      return '<li><span class="sd-todo-ic" aria-hidden="true">🚩</span><div><strong>' + esc(REPORT_REASONS[r.reason] || r.reason) +
        ' · ' + esc(r.reported_name || 'User') + '</strong><span>' + esc(r.details || 'No details added') + ' · ' +
        esc(r.created_at ? new Date(r.created_at).toLocaleDateString('en-IN') : '') + '</span></div>' + tag(r.status || 'open', tone) + '</li>';
    }).join('') + '</ul>';
  }

  /* ---------------------------------------------------------
     Location (GPS + map)
     --------------------------------------------------------- */
  function renderLocation() {
    var notSet = $('locationNotSet');
    var set = $('locationSet');
    if (currentLat === null || !currentAddress) {
      notSet.style.display = 'flex';
      set.style.display = 'none';
    } else {
      notSet.style.display = 'none';
      set.style.display = 'flex';
      $('crumbArea').textContent = currentAddress.area || 'Unknown area';
      $('crumbDistrict').textContent = currentAddress.district || '—';
      $('crumbPincode').textContent = currentAddress.pincode || '------';
    }
    renderOverview();
    renderProfileCard();
  }

  // OpenStreetMap Nominatim: free, no key. Swap for a paid geocoder if you outgrow its usage limits.
  async function reverseGeocode(lat, lng) {
    var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' + encodeURIComponent(lat) +
      '&lon=' + encodeURIComponent(lng) + '&zoom=18&addressdetails=1';
    var res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('Could not look up that address.');
    var data = await res.json();
    var a = data.address || {};
    return {
      area: a.suburb || a.neighbourhood || a.village || a.town || a.city_district || a.road || a.city || 'Unknown area',
      district: a.state_district || a.county || a.city || a.state || '—',
      pincode: a.postcode || '------',
      display: data.display_name || ''
    };
  }

  async function applyLocation(lat, lng) {
    currentLat = lat;
    currentLng = lng;
    try {
      currentAddress = await reverseGeocode(lat, lng);
    } catch (e) {
      currentAddress = { area: 'Location set', district: '—', pincode: '------', display: '' };
    }
    renderLocation();
    try {
      await apiRequest('/api/students/' + encodeURIComponent(USER.id) + '/location', 'PUT', {
        address: currentAddress.display || (currentAddress.area + ', ' + currentAddress.district),
        city: currentAddress.district,
        area: currentAddress.area,
        district: currentAddress.district,
        pincode: currentAddress.pincode,
        latitude: lat,
        longitude: lng
      });
      if (state.student) {
        state.student.latitude = lat; state.student.longitude = lng;
        state.student.address = currentAddress.display || state.student.address;
      }
    } catch (e) {
      toast('Location is set for this visit, but we could not save it to your profile.', true);
    }
    renderProfileCard();
    ensureFindReady(true);
  }

  function hasLeaflet() { return typeof window.L !== 'undefined' && typeof window.L.map === 'function'; }

  function useCurrentLocation(btn) {
    var status = $('locationStatus');
    if (!navigator.geolocation) {
      status.textContent = 'Geolocation is not supported by your browser. Set your spot on the map instead.';
      return;
    }
    btn.disabled = true;
    btn.classList.add('btn-loading');
    status.textContent = 'Getting a precise GPS fix… this can take a few seconds.';
    navigator.geolocation.getCurrentPosition(
      function (position) {
        btn.disabled = false;
        btn.classList.remove('btn-loading');
        var c = position.coords;
        if (!hasLeaflet()) {
          // No map library: trust the GPS fix instead of leaving the student stuck.
          applyLocation(c.latitude, c.longitude).then(function () { toast('Location updated'); });
          return;
        }
        status.textContent = 'GPS fix found. Confirm it on the map.';
        openMapModal({
          lat: c.latitude, lng: c.longitude, accuracy: c.accuracy,
          title: 'Confirm your exact location',
          sub: 'We centred the pin on your GPS fix. Drag it to your doorstep for the best match accuracy.'
        });
      },
      function (err) {
        btn.disabled = false;
        btn.classList.remove('btn-loading');
        var messages = {
          1: 'Location access denied. Allow location for this site in your browser settings, then try again.',
          2: 'Could not detect your location right now. Try again, or set it on the map.',
          3: 'Location request timed out. Try again, ideally outdoors or near a window.'
        };
        status.textContent = messages[err.code] || 'Could not get your location. Set it on the map instead.';
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  }

  var map = null, marker = null, accuracyCircle = null, pendingLat = null, pendingLng = null, geocodeTimer = null, geocodeSeq = 0;

  function pinIcon() {
    return L.divIcon({
      className: 'custom-pin',
      html: '<svg width="32" height="42" viewBox="0 0 34 44" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M17 0C7.6 0 0 7.6 0 17c0 12.7 17 27 17 27s17-14.3 17-27C34 7.6 26.4 0 17 0z" fill="' + BRAND + '"/>' +
        '<circle cx="17" cy="17" r="7" fill="#fff"/></svg>',
      iconSize: [32, 42],
      iconAnchor: [16, 42]
    });
  }

  function setAccuracyNote(accuracy) {
    var note = $('accuracyNote');
    if (!accuracy) { note.style.display = 'none'; return; }
    note.style.display = 'flex';
    var m = Math.round(accuracy);
    if (m <= 30) { note.className = 'accuracy-note good'; note.textContent = '✓ GPS accuracy: about ' + m + ' m. This pin should already be very close.'; }
    else if (m <= 100) { note.className = 'accuracy-note fair'; note.textContent = '⚠ GPS accuracy: about ' + m + ' m. Drag the pin to your exact spot for best results.'; }
    else { note.className = 'accuracy-note poor'; note.textContent = '⚠ GPS accuracy: about ' + m + ' m (weak signal). Please drag the pin precisely onto your location.'; }
  }
  function clearAccuracyCircle() {
    if (accuracyCircle && map) { map.removeLayer(accuracyCircle); }
    accuracyCircle = null;
    setAccuracyNote(null);
  }

  function openMapModal(opts) {
    if (!hasLeaflet()) {
      toast('The map could not load. Check your connection and refresh the page.', true);
      return;
    }
    opts = opts || {};
    $('mapModalBackdrop').classList.add('open');
    $('mapModalTitle').textContent = opts.title || 'Set your location';
    $('mapModalSub').textContent = opts.sub || 'Drag the pin, or click anywhere on the map, to place it exactly.';

    var startLat = opts.lat !== undefined ? opts.lat : (currentLat !== null ? currentLat : DEFAULT_CENTER[0]);
    var startLng = opts.lng !== undefined ? opts.lng : (currentLng !== null ? currentLng : DEFAULT_CENTER[1]);
    var zoom = (opts.lat !== undefined || currentLat !== null) ? 17 : 14;

    if (!map) {
      map = L.map('pickerMap').setView([startLat, startLng], zoom);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
      marker = L.marker([startLat, startLng], { draggable: true, icon: pinIcon() }).addTo(map);
      marker.on('dragend', function () {
        var p = marker.getLatLng();
        clearAccuracyCircle();
        previewLocation(p.lat, p.lng);
      });
      map.on('click', function (e) {
        marker.setLatLng(e.latlng);
        clearAccuracyCircle();
        previewLocation(e.latlng.lat, e.latlng.lng);
      });
    } else {
      map.setView([startLat, startLng], zoom);
      marker.setLatLng([startLat, startLng]);
      setTimeout(function () { map.invalidateSize(); }, 60);
    }

    clearAccuracyCircle();
    if (opts.accuracy) {
      accuracyCircle = L.circle([startLat, startLng], { radius: opts.accuracy, color: BRAND, fillColor: BRAND, fillOpacity: 0.12, weight: 1 }).addTo(map);
      setAccuracyNote(opts.accuracy);
    }
    previewLocation(startLat, startLng);
  }

  function previewLocation(lat, lng) {
    pendingLat = lat;
    pendingLng = lng;
    var box = $('mapPickedAddress');
    box.textContent = 'Looking up address…';
    clearTimeout(geocodeTimer);
    var seq = ++geocodeSeq;
    geocodeTimer = setTimeout(async function () {
      try {
        var addr = await reverseGeocode(lat, lng);
        if (seq === geocodeSeq) box.textContent = addr.area + ', ' + addr.district + ' — ' + addr.pincode;
      } catch (e) {
        if (seq === geocodeSeq) box.textContent = 'Pin placed. The address lookup failed, but the location is still usable.';
      }
    }, 450);
  }

  function closeMapModal() { $('mapModalBackdrop').classList.remove('open'); }

  async function doMapSearch() {
    var q = $('mapSearchInput').value.trim();
    if (!q || !map) return;
    try {
      var res = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&q=' + encodeURIComponent(q) + '&limit=1');
      var results = await res.json();
      if (!results.length) { toast('No matching place found.', true); return; }
      var lat = parseFloat(results[0].lat), lon = parseFloat(results[0].lon);
      map.setView([lat, lon], 16);
      marker.setLatLng([lat, lon]);
      clearAccuracyCircle();
      previewLocation(lat, lon);
    } catch (e) {
      toast('Search failed. Please try again.', true);
    }
  }

  $('openMapBtnEmpty').addEventListener('click', function () { openMapModal(); });
  $('openMapBtnSet').addEventListener('click', function () { openMapModal(); });
  $('useLocationBtn').addEventListener('click', function (e) { useCurrentLocation(e.currentTarget); });
  $('useLocationBtn2').addEventListener('click', function (e) { useCurrentLocation(e.currentTarget); });
  $('mapModalClose').addEventListener('click', closeMapModal);
  $('mapModalCancel').addEventListener('click', closeMapModal);
  $('mapSearchBtn').addEventListener('click', doMapSearch);
  $('mapSearchInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doMapSearch(); }
  });
  $('mapModalConfirm').addEventListener('click', async function () {
    if (pendingLat === null) return;
    var btn = $('mapModalConfirm');
    btn.disabled = true;
    btn.classList.add('btn-loading');
    await applyLocation(pendingLat, pendingLng);
    btn.disabled = false;
    btn.classList.remove('btn-loading');
    closeMapModal();
    toast('Location updated');
  });
  $('mapLocateBtn').addEventListener('click', function () {
    var btn = this;
    if (!navigator.geolocation) { toast('Geolocation is not supported by your browser.', true); return; }
    btn.textContent = '…';
    navigator.geolocation.getCurrentPosition(
      function (position) {
        btn.textContent = '📍';
        var c = position.coords;
        map.setView([c.latitude, c.longitude], 17);
        marker.setLatLng([c.latitude, c.longitude]);
        clearAccuracyCircle();
        accuracyCircle = L.circle([c.latitude, c.longitude], { radius: c.accuracy, color: BRAND, fillColor: BRAND, fillOpacity: 0.12, weight: 1 }).addTo(map);
        setAccuracyNote(c.accuracy);
        previewLocation(c.latitude, c.longitude);
      },
      function () {
        btn.textContent = '📍';
        toast('Could not fetch your location. Please drag the pin manually.', true);
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  });

  /* ---------------------------------------------------------
     Find tutors
     --------------------------------------------------------- */
  function renderChips() {
    var host = $('subjectChips');
    var mine = String((state.student && state.student.preferred_subjects) || '').split(',')
      .map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 4);
    var html = '';
    if (mine.length) {
      html += '<span class="sd-chips-label">Yours</span>' + mine.map(function (s) {
        return '<button type="button" class="sd-chip sd-chip-mine" data-act="chip" data-subject="' + esc(s) + '">' + esc(s) + '</button>';
      }).join('');
    }
    html += '<span class="sd-chips-label">Popular</span>' + SUBJECT_CHIPS.map(function (s) {
      return '<button type="button" class="sd-chip" data-act="chip" data-subject="' + esc(s) + '">' + esc(s) + '</button>';
    }).join('');
    host.innerHTML = html;
  }

  function applyClientFilters(items) {
    var list = items.filter(function (t) {
      if (ui.minRating && num(t.rating_avg) < ui.minRating) return false;
      if (ui.maxFee !== null && num(t.fee_per_hour) > ui.maxFee) return false;
      return true;
    });
    var sorters = {
      nearest: function (a, b) { return num(a.distance_km) - num(b.distance_km); },
      rating: function (a, b) { return (num(b.rating_avg) - num(a.rating_avg)) || (num(b.total_reviews) - num(a.total_reviews)); },
      feeLow: function (a, b) { return num(a.fee_per_hour) - num(b.fee_per_hour); },
      feeHigh: function (a, b) { return num(b.fee_per_hour) - num(a.fee_per_hour); },
      exp: function (a, b) { return num(b.experience_years) - num(a.experience_years); }
    };
    return list.sort(sorters[ui.sort] || sorters.nearest);
  }

  function teacherCard(t, withDistance) {
    var id = Number(t.id);
    var saved = state.favoriteIds.has(id);
    var rating = num(t.rating_avg);
    var fee = num(t.fee_per_hour);
    var badges = '';
    if (withDistance && t.distance_km !== undefined && t.distance_km !== null) {
      badges += '<span class="sd-badge">📍 ' + esc(num(t.distance_km).toFixed(1)) + ' km' + (t.city ? ' · ' + esc(t.city) : '') + '</span>';
    } else if (t.city) {
      badges += '<span class="sd-badge">📍 ' + esc(t.city) + '</span>';
    }
    badges += '<span class="sd-badge sd-badge-star">★ ' + (rating > 0 ? esc(rating.toFixed(1)) : 'New') + ' (' + num(t.total_reviews) + ')</span>';
    if (num(t.experience_years) > 0) badges += '<span class="sd-badge">🎓 ' + esc(plural(num(t.experience_years), 'yr', 'yrs')) + '</span>';
    if (withDistance) badges += '<span class="sd-badge sd-badge-ok">✓ Verified</span>';

    return '<article class="sd-teacher">' +
      '<button type="button" class="sd-heart' + (saved ? ' is-saved' : '') + '" data-act="fav" data-id="' + id + '" aria-pressed="' + saved + '" aria-label="' + (saved ? 'Remove ' : 'Save ') + esc(t.name) + (saved ? ' from saved teachers' : ' to saved teachers') + '">' + (saved ? '❤️' : '🤍') + '</button>' +
      '<button type="button" class="sd-teacher-top" data-act="profile" data-id="' + id + '">' +
        '<span class="sd-av">' + avatarInner(t.name, t.profile_photo) + '</span>' +
        '<span><h4>' + esc(t.name) + '</h4><span class="sd-muted">' + esc(t.subjects || 'Subjects not listed') + (t.grades ? ' · ' + esc(t.grades) : '') + '</span></span>' +
      '</button>' +
      (t.qualification ? '<p class="sd-qual">' + esc(t.qualification) + '</p>' : '') +
      '<div class="sd-badges">' + badges + '</div>' +
      '<div class="sd-teacher-foot">' +
        '<div class="sd-fee">' + (fee > 0 ? esc(fmtMoney(fee)) + '<span> / hour</span>' : '<span>Fee not listed</span>') + '</div>' +
        '<div class="sd-teacher-actions">' +
          '<button type="button" class="btn btn-outline btn-sm" data-act="profile" data-id="' + id + '">Profile</button>' +
          '<button type="button" class="btn btn-primary btn-sm" data-act="book" data-id="' + id + '">Book</button>' +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function renderResults() {
    var host = $('resultsArea');
    var s = ui.search;
    $('resultsToolbar').hidden = !(s.ran && !s.error && s.items.length);
    $('loadMoreWrap').hidden = !(s.ran && !s.error && s.page < s.totalPages);

    if (s.loading && !s.items.length) {
      host.innerHTML = '<div class="sd-cards">' + skeletons(3) + '</div>';
      return;
    }
    if (s.error) { host.innerHTML = errorState(s.error, 'retry-search'); return; }
    if (!s.ran) {
      host.innerHTML = emptyState('🧭', 'Set your location, then search', 'We will list verified teachers close to you, nearest first.');
      return;
    }
    if (!s.items.length) {
      host.innerHTML = emptyState('🔭', 'No teachers within ' + s.params.radius + ' km',
        s.params.subject ? 'Try a different subject or a bigger radius.' : 'Try a bigger radius.');
      return;
    }
    var shown = applyClientFilters(s.items);
    $('resultsCount').textContent = 'Showing ' + shown.length + ' of ' + s.total + ' teacher' + (s.total === 1 ? '' : 's') + ' within ' + s.params.radius + ' km' +
      (shown.length < s.items.length ? ' (' + (s.items.length - shown.length) + ' hidden by filters)' : '');
    host.innerHTML = shown.length
      ? '<div class="sd-cards">' + shown.map(function (t) { return teacherCard(t, true); }).join('') + '</div>'
      : emptyState('🪄', 'Filters hid every teacher', 'Loosen the rating or fee filter to see them again.');
  }

  async function runSearch(append) {
    var s = ui.search;
    if (currentLat === null || currentLng === null) {
      s.ran = false; s.items = []; s.error = null;
      renderResults();
      toast('Please set your location first.', true);
      return;
    }
    if (s.loading) return;
    var params = append && s.params ? s.params : {
      subject: $('subjectFilter').value.trim(),
      radius: ui.radius,
      lat: currentLat,
      lng: currentLng
    };
    var page = append ? s.page + 1 : 1;
    s.loading = true;
    s.error = null;
    if (!append) { s.items = []; s.ran = true; s.params = params; }
    renderResults();
    $('searchBtn').disabled = true;
    $('loadMoreBtn').disabled = true;

    try {
      var url = '/api/teachers/nearby?lat=' + encodeURIComponent(params.lat) + '&lng=' + encodeURIComponent(params.lng) +
        '&radius=' + encodeURIComponent(params.radius) + '&page=' + page;
      if (params.subject) url += '&subject=' + encodeURIComponent(params.subject);
      var data = await apiRequest(url);
      var got = Array.isArray(data && data.teachers) ? data.teachers : [];
      got.forEach(function (t) { teacherCache[t.id] = t; });
      s.items = append ? s.items.concat(got) : got;
      s.page = page;
      s.total = num(data && data.total) || s.items.length;
      s.totalPages = num(data && data.total_pages) || 1;
    } catch (err) {
      s.error = err.message || 'Could not search for teachers.';
    } finally {
      s.loading = false;
      $('searchBtn').disabled = false;
      $('loadMoreBtn').disabled = false;
      renderResults();
    }
  }

  // Run a first search automatically once the location is known, so the page is never empty.
  function ensureFindReady(force) {
    if (ui.view !== 'find' && !force) return;
    if (currentLat !== null && (!ui.search.ran || force) && !ui.search.loading && ui.view === 'find') runSearch(false);
  }

  /* ---------------------------------------------------------
     Booking modal
     --------------------------------------------------------- */
  var booking = { teacherId: null, type: 'demo', days: new Set(), slot: null, slotSeq: 0 };

  function slotMessage(grid, text) {
    grid.innerHTML = '';
    var note = document.createElement('div');
    note.className = 'slot-note';
    note.textContent = text;
    grid.appendChild(note);
  }

  function renderSlots(slots) {
    var grid = $('slotGrid');
    grid.innerHTML = '';
    if (!slots.some(function (s) { return s.available; })) {
      slotMessage(grid, 'No free times on this date. Please pick another date.');
      return;
    }
    slots.forEach(function (s) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot-btn';
      btn.dataset.slot = s.slot;
      btn.textContent = s.slot;
      btn.disabled = !s.available;
      btn.title = s.available ? '' : 'Not available';
      btn.addEventListener('click', function () {
        grid.querySelectorAll('.slot-btn').forEach(function (b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
        booking.slot = s.slot;
        renderBookingSummary();
      });
      grid.appendChild(btn);
    });
  }

  async function loadSlots() {
    var grid = $('slotGrid');
    var date = $('bookingDate').value;
    booking.slot = null;
    renderBookingSummary();
    if (!booking.teacherId || !DATE_RE.test(date)) { grid.innerHTML = ''; return; }
    var seq = ++booking.slotSeq; // ignore stale answers if the date changes quickly
    slotMessage(grid, 'Loading available times…');
    try {
      var data = await apiRequest('/api/bookings/availability/' + encodeURIComponent(booking.teacherId) + '?date=' + encodeURIComponent(date));
      if (seq !== booking.slotSeq) return;
      renderSlots((data && data.slots) || []);
    } catch (err) {
      if (seq !== booking.slotSeq) return;
      slotMessage(grid, err.message || 'Could not load available times.');
    }
  }

  function renderDays() {
    $('daysRow').innerHTML = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (d) {
      var on = booking.days.has(d);
      return '<button type="button" class="sd-day-btn' + (on ? ' is-on' : '') + '" data-day="' + d + '" aria-pressed="' + on + '">' + d + '</button>';
    }).join('');
  }

  function setBookingType(type) {
    booking.type = type;
    document.querySelectorAll('#bookingTypeSeg button').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.type === type));
    });
    $('daysField').hidden = type !== 'recurring';
    $('bookingTypeHint').textContent = type === 'recurring'
      ? 'A regular weekly class. Pick the days you want.'
      : 'A single trial class so you can meet the teacher.';
    $('bookingTitle').textContent = type === 'recurring' ? 'Book weekly classes' : 'Book a demo class';
    $('bookingModalConfirm').textContent = 'Send request';
    if (type === 'recurring' && booking.days.size === 0) {
      var date = $('bookingDate').value;
      if (DATE_RE.test(date)) booking.days.add(weekdayOf(date));
    }
    renderDays();
    renderBookingSummary();
  }

  function renderBookingSummary() {
    var box = $('bookingSummary');
    var date = $('bookingDate').value;
    if (!booking.slot || !DATE_RE.test(date)) { box.hidden = true; return; }
    var days = booking.type === 'recurring'
      ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].filter(function (d) { return booking.days.has(d); }).join(', ')
      : '';
    box.hidden = false;
    box.textContent = booking.type === 'recurring'
      ? 'Weekly on ' + (days || '…') + ' at ' + booking.slot + ', starting ' + fmtDate(date) + ' for 8 weeks.'
      : 'One demo class on ' + fmtDate(date, true) + ' at ' + booking.slot + '.';
  }

  function openBookingModal(teacherId) {
    var t = teacherCache[teacherId];
    if (!t) { toast('Could not find that teacher. Please search again.', true); return; }
    booking.teacherId = Number(teacherId);
    booking.slot = null;
    booking.days = new Set();
    $('bookingAvatar').innerHTML = avatarInner(t.name, t.profile_photo);
    $('bookingTeacherName').textContent = t.name;
    $('bookingTeacherMeta').textContent = (t.subjects || 'Subjects not listed') + (num(t.fee_per_hour) > 0 ? ' · ' + fmtMoney(t.fee_per_hour) + '/hr' : '');
    var chosen = $('subjectFilter').value.trim();
    $('bookingSubject').value = chosen || (t.subjects ? String(t.subjects).split(',')[0].trim() : '');

    var dateInput = $('bookingDate');
    var today = todayIST();
    dateInput.min = today;
    dateInput.max = addDays(today, MAX_DAYS_AHEAD);
    dateInput.value = today;

    $('bookingMsgBox').className = 'msg-box';
    $('bookingMsgBox').textContent = '';
    setBookingType('demo');
    $('bookingModalBackdrop').classList.add('open');
    loadSlots();
  }

  function closeBookingModal() { $('bookingModalBackdrop').classList.remove('open'); }

  $('bookingModalClose').addEventListener('click', closeBookingModal);
  $('bookingModalCancel').addEventListener('click', closeBookingModal);
  $('bookingDate').addEventListener('change', loadSlots);
  $('bookingTypeSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-type]');
    if (b) setBookingType(b.dataset.type);
  });
  $('daysRow').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-day]');
    if (!b) return;
    var d = b.dataset.day;
    if (booking.days.has(d)) booking.days.delete(d); else booking.days.add(d);
    renderDays();
    renderBookingSummary();
  });

  $('bookingModalConfirm').addEventListener('click', async function () {
    var msgBox = $('bookingMsgBox');
    var date = $('bookingDate').value;
    var subject = $('bookingSubject').value.trim();
    var btn = $('bookingModalConfirm');

    function fail(text) { msgBox.className = 'msg-box error'; msgBox.textContent = text; }
    if (!subject) return fail('Please enter a subject.');
    if (!DATE_RE.test(date)) return fail('Please choose a start date.');
    if (!booking.slot) return fail('Please choose a time slot.');
    if (booking.type === 'recurring' && booking.days.size === 0) return fail('Pick at least one day of the week.');

    var payload = {
      teacher_id: booking.teacherId,
      type: booking.type,
      subject: subject,
      booking_date: date,
      booking_time: booking.slot
    };
    if (booking.type === 'recurring') {
      payload.days_per_week = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].filter(function (d) { return booking.days.has(d); }).join(',');
    }

    btn.disabled = true;
    btn.classList.add('btn-loading');
    try {
      await apiRequest('/api/bookings', 'POST', payload);
      closeBookingModal();
      toast('Request sent. The teacher will confirm shortly.');
      go('classes');
      loadBookings();
    } catch (err) {
      fail(err.message);
      loadSlots(); // if someone else just took the slot, refresh the grid
    } finally {
      btn.disabled = false;
      btn.classList.remove('btn-loading');
    }
  });

  /* ---------------------------------------------------------
     Class details + cancel
     --------------------------------------------------------- */
  async function openDetails(id) {
    var b = findBooking(id);
    if (!b) return;
    $('detailsTitle').textContent = (b.subject || 'Class') + ' with ' + (b.teacher_name || 'your teacher');
    $('detailsSub').textContent = typeLabel(b) + ' · ' + fmtDate(b.booking_date, true) + ' · ' + (b.booking_time || '');
    var pay = payInfo(b);
    var head =
      '<div class="sd-tags">' + statusTag(bookingStatus(b)) + (pay ? tag(pay.label, pay.tone) : '') + '</div>' +
      '<dl class="sd-dl">' +
        '<div><dt>Fee</dt><dd>' + esc(bookingStatus(b) === 'requested' ? 'Set by the teacher when they accept' : (num(b.fee) > 0 ? fmtMoney(b.fee) : 'No charge')) + '</dd></div>' +
        '<div><dt>Requested on</dt><dd>' + esc(b.created_at ? new Date(b.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—') + '</dd></div>' +
      '</dl>' +
      '<h4 class="sd-subhead">Sessions</h4>';
    $('detailsBody').innerHTML = head + '<div id="detailsSessions">' + skeletons(1) + '</div>';
    $('detailsModalBackdrop').classList.add('open');

    var host = $('detailsSessions');
    if (bookingStatus(b) === 'requested' || bookingStatus(b) === 'declined') {
      host.innerHTML = '<p class="sd-muted">Sessions are created once the teacher accepts this request.</p>';
      return;
    }
    try {
      var rows = await apiRequest('/api/bookings/' + encodeURIComponent(b.id) + '/sessions');
      if (!Array.isArray(rows) || !rows.length) { host.innerHTML = '<p class="sd-muted">No sessions to show.</p>'; return; }
      host.innerHTML = '<ul class="sd-sessions">' + rows.map(function (s) {
        var tone = s.status === 'completed' ? 'ok' : s.status === 'scheduled' ? 'info' : s.status === 'missed' ? 'bad' : 'muted';
        return '<li><span>' + esc(fmtDate(s.session_date)) + ' · ' + esc(s.session_time || b.booking_time || '') + '</span>' + tag(s.status, tone) + '</li>';
      }).join('') + '</ul>';
    } catch (e) {
      host.innerHTML = '<p class="sd-muted">' + esc(e.message || 'Could not load sessions.') + '</p>';
    }
  }

  async function cancelBooking(id) {
    var b = findBooking(id);
    if (!b) return;
    var paid = b.payment_status === 'paid' && num(b.fee) > 0;
    var ok = await ask({
      title: 'Cancel this class?',
      message: 'Your ' + (b.subject || 'class') + ' with ' + (b.teacher_name || 'the teacher') + ' will be cancelled.' +
        (paid ? ' You have already paid. A refund is started automatically only if you cancel early enough; we will tell you the result right after.' : ' The teacher will be notified.'),
      okText: 'Yes, cancel class',
      cancelText: 'Keep class'
    });
    if (!ok) return;
    try {
      var res = await apiRequest('/api/bookings/' + encodeURIComponent(b.id) + '/cancel', 'PUT');
      toast((res && res.message) || 'Class cancelled.');
      loadBookings();
    } catch (err) {
      toast(err.message, true);
      loadBookings();
    }
  }

  /* ---------------------------------------------------------
     Payments (Razorpay)
     --------------------------------------------------------- */
  async function waitForPayment(bookingId) {
    confirmingPayments.add(bookingId);
    renderAll();
    for (var i = 0; i < 10; i++) {
      await new Promise(function (r) { setTimeout(r, 3000); });
      try {
        var r = await apiRequest('/api/payments/booking/' + encodeURIComponent(bookingId));
        if (r && r.payment_status === 'paid') {
          confirmingPayments.delete(bookingId);
          toast('Payment confirmed. Thank you!');
          loadBookings();
          return;
        }
        if (r && r.payment_status === 'refunded') {
          confirmingPayments.delete(bookingId);
          toast('Your payment has been refunded.');
          loadBookings();
          return;
        }
      } catch (e) { /* keep trying */ }
    }
    // Still unconfirmed: keep the button disabled until the page is reloaded so nobody pays twice.
    toast('Still confirming your payment. Please check again in a minute. You will not be charged twice.');
  }

  async function payNow(bookingId) {
    bookingId = Number(bookingId);
    if (confirmingPayments.has(bookingId)) return;
    if (typeof window.Razorpay !== 'function') {
      toast('The payment window could not load. Check your connection and refresh the page.', true);
      return;
    }
    try {
      var order = await apiRequest('/api/payments/create-order', 'POST', { booking_id: bookingId });
      var rzp = new window.Razorpay({
        key: order.key_id,
        amount: order.amount,
        currency: order.currency,
        order_id: order.order_id,
        name: 'TutorLink',
        description: 'Class payment',
        handler: async function (response) {
          try {
            var result = await apiRequest('/api/payments/verify', 'POST', {
              booking_id: bookingId,
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature
            });
            if (result && result.status === 'pending') {
              toast(result.message || 'Payment received. Confirming…');
              waitForPayment(bookingId);
            } else if (result && result.status === 'refund_initiated') {
              toast(result.message || 'Your payment is being refunded.', true);
              loadBookings();
            } else {
              toast('Payment successful!');
              loadBookings();
            }
          } catch (err) {
            toast(err.message, true);
          }
        },
        prefill: { name: USER.name, email: (state.me && state.me.email) || USER.email || '' },
        theme: { color: BRAND }
      });
      rzp.on('payment.failed', function () { toast('Payment failed or was cancelled.', true); });
      rzp.open();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ---------------------------------------------------------
     Reviews
     --------------------------------------------------------- */
  var review = { bookingId: null, reviewId: null, stars: 0 };

  function buildStars() {
    var grid = $('starGrid');
    grid.innerHTML = [1, 2, 3, 4, 5].map(function (n) {
      return '<button type="button" role="radio" class="sd-star' + (n <= review.stars ? ' is-on' : '') + '" data-star="' + n +
        '" aria-checked="' + (n === review.stars) + '" aria-label="' + n + ' star' + (n === 1 ? '' : 's') + '">★</button>';
    }).join('');
  }

  function openReviewModal(bookingId, editing) {
    var b = findBooking(bookingId);
    if (!b) return;
    review.bookingId = b.id;
    review.reviewId = editing ? b.review_id : null;
    review.stars = editing ? num(b.review_rating) : 0;
    $('reviewTitle').textContent = editing ? 'Edit your review' : 'Rate your class';
    $('reviewTeacherLabel').textContent = editing
      ? 'Editing your review of ' + (b.teacher_name || 'your teacher')
      : 'How was your session with ' + (b.teacher_name || 'your teacher') + '?';
    $('reviewComment').value = editing ? (b.review_comment || '') : '';
    $('reviewModalConfirm').textContent = editing ? 'Save changes' : 'Submit review';
    $('reviewMsgBox').className = 'msg-box';
    $('reviewMsgBox').textContent = '';
    buildStars();
    $('reviewModalBackdrop').classList.add('open');
  }
  function closeReviewModal() { $('reviewModalBackdrop').classList.remove('open'); }

  $('starGrid').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-star]');
    if (!b) return;
    review.stars = parseInt(b.dataset.star, 10);
    buildStars();
  });
  $('reviewModalClose').addEventListener('click', closeReviewModal);
  $('reviewModalCancel').addEventListener('click', closeReviewModal);
  $('reviewModalConfirm').addEventListener('click', async function () {
    var msgBox = $('reviewMsgBox');
    var btn = $('reviewModalConfirm');
    if (!review.stars) {
      msgBox.className = 'msg-box error';
      msgBox.textContent = 'Please pick a star rating.';
      return;
    }
    var comment = $('reviewComment').value.trim();
    btn.disabled = true;
    btn.classList.add('btn-loading');
    try {
      if (review.reviewId) {
        await apiRequest('/api/reviews/' + encodeURIComponent(review.reviewId), 'PUT', { rating: review.stars, comment: comment });
      } else {
        await apiRequest('/api/reviews', 'POST', { booking_id: review.bookingId, rating: review.stars, comment: comment });
      }
      closeReviewModal();
      toast(review.reviewId ? 'Review updated!' : 'Thanks for the review!');
      loadBookings();
    } catch (err) {
      msgBox.className = 'msg-box error';
      msgBox.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.classList.remove('btn-loading');
    }
  });

  async function deleteReview(bookingId) {
    var b = findBooking(bookingId);
    if (!b || !b.review_id) return;
    var ok = await ask({ title: 'Delete this review?', message: 'This cannot be undone.', okText: 'Delete review', cancelText: 'Keep it' });
    if (!ok) return;
    try {
      await apiRequest('/api/reviews/' + encodeURIComponent(b.review_id), 'DELETE');
      toast('Review deleted.');
      loadBookings();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ---------------------------------------------------------
     Quick actions (Ctrl/Cmd + K)
     --------------------------------------------------------- */
  var cmdItems = [
    { label: 'Overview', hint: 'Go to', run: function () { go('overview'); } },
    { label: 'Find tutors', hint: 'Go to', run: function () { go('find'); } },
    { label: 'My classes', hint: 'Go to', run: function () { go('classes'); } },
    { label: 'Courses', hint: 'Go to', run: function () { go('courses'); } },
    { label: 'Payments', hint: 'Go to', run: function () { go('payments'); } },
    { label: 'Saved teachers', hint: 'Go to', run: function () { go('saved'); } },
    { label: 'Safety & reports', hint: 'Go to', run: function () { go('support'); } },
    { label: 'Set location on the map', hint: 'Action', run: function () { go('find'); openMapModal(); } },
    { label: 'Use my current location', hint: 'Action', run: function () { go('find'); useCurrentLocation($('useLocationBtn')); } },
    { label: 'Edit profile', hint: 'Open', run: function () { window.location.href = 'student-complete-profile.html'; } },
    { label: 'Account settings', hint: 'Open', run: function () { window.location.href = 'account-settings.html'; } },
    { label: 'Log out', hint: 'Action', run: function () { $('logoutBtn').click(); } }
  ];
  var cmdShown = [];
  var cmdIndex = 0;

  function renderCmd() {
    var q = $('cmdInput').value.trim().toLowerCase();
    cmdShown = cmdItems.filter(function (c) { return !q || c.label.toLowerCase().indexOf(q) !== -1; });
    if (cmdIndex >= cmdShown.length) cmdIndex = Math.max(0, cmdShown.length - 1);
    var list = $('cmdList');
    list.innerHTML = cmdShown.length ? cmdShown.map(function (c, i) {
      return '<li role="option" id="cmd-opt-' + i + '" class="' + (i === cmdIndex ? 'is-active' : '') + '" aria-selected="' + (i === cmdIndex) + '" data-i="' + i + '">' +
        '<span>' + esc(c.label) + '</span><em>' + esc(c.hint) + '</em></li>';
    }).join('') : '<li class="sd-cmd-none">No matches</li>';
    if (cmdShown.length) $('cmdInput').setAttribute('aria-activedescendant', 'cmd-opt-' + cmdIndex);
    else $('cmdInput').removeAttribute('aria-activedescendant');
    var active = list.querySelector('.is-active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }
  function openCmd() {
    $('cmdInput').value = '';
    cmdIndex = 0;
    renderCmd();
    $('cmdBackdrop').classList.add('open');
    focusSoon($('cmdInput'));
  }
  function closeCmd() { $('cmdBackdrop').classList.remove('open'); $('cmdInput').blur(); }
  function runCmd(i) {
    var item = cmdShown[i];
    if (!item) return;
    closeCmd();
    item.run();
  }
  $('cmdBtn').addEventListener('click', openCmd);
  $('cmdInput').addEventListener('input', function () { cmdIndex = 0; renderCmd(); });
  $('cmdInput').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (cmdShown.length) { cmdIndex = (cmdIndex + 1) % cmdShown.length; renderCmd(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (cmdShown.length) { cmdIndex = (cmdIndex - 1 + cmdShown.length) % cmdShown.length; renderCmd(); } }
    else if (e.key === 'Enter') { e.preventDefault(); runCmd(cmdIndex); }
  });
  $('cmdList').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-i]');
    if (li) runCmd(Number(li.dataset.i));
  });
  $('cmdBackdrop').addEventListener('click', function (e) { if (e.target === $('cmdBackdrop')) closeCmd(); });

  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
      e.preventDefault();
      if ($('cmdBackdrop').classList.contains('open')) closeCmd(); else openCmd();
      return;
    }
    if (e.key === 'Escape') {
      if ($('cmdBackdrop').classList.contains('open')) { closeCmd(); return; }
      if ($('confirmBackdrop').classList.contains('open')) { closeConfirm(false); return; }
      var close = document.querySelector('.modal-backdrop.open .modal-close');
      if (close) close.click();
      return;
    }
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      go('find');
      focusSoon($('subjectFilter'));
    }
  });

  /* ---------------------------------------------------------
     Click handling (one listener for every data-act button)
     --------------------------------------------------------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.dataset.act;
    var id = el.dataset.id;
    switch (act) {
      case 'pay': payNow(id); break;
      case 'chat': {
        var cb = findBooking(id);
        if (cb) openChatModal(cb.id, cb.teacher_name || 'your teacher');
        break;
      }
      case 'report': {
        var rb = findBooking(id);
        if (rb) openReportModal(rb.teacher_user_id, rb.teacher_name || 'your teacher', rb.id);
        break;
      }
      case 'cancel': cancelBooking(id); break;
      case 'details': openDetails(id); break;
      case 'review': openReviewModal(id, false); break;
      case 'edit-review': openReviewModal(id, true); break;
      case 'delete-review': deleteReview(id); break;
      case 'open-course': openCourse(id); break;
      case 'close-course': $('courseModalBackdrop').classList.remove('open'); break;
      case 'fav': toggleFavorite(id, el); break;
      case 'book': openBookingModal(Number(id)); break;
      case 'profile': window.location.href = 'teacher-profile-view.html?id=' + encodeURIComponent(Number(id)); break;
      case 'chip':
        $('subjectFilter').value = el.dataset.subject || '';
        runSearch(false);
        break;
      case 'goto-location':
        go('find');
        break;
      case 'resend-verify': resendVerification(el); break;
      case 'reload-bookings': state.loaded.bookings = false; renderAll(); loadBookings(); break;
      case 'reload-courses': state.loaded.courses = false; renderCourses(); loadCourses(); break;
      case 'reload-saved': state.loaded.saved = false; renderSaved(); loadSaved(); break;
      case 'reload-reports': state.loaded.reports = false; renderReports(); loadReports(); break;
      case 'retry-search': runSearch(false); break;
      default: break;
    }
  });

  async function resendVerification(btn) {
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = 'Sending…';
    try {
      await apiRequest('/api/auth/resend-verification', 'POST');
      btn.textContent = 'Sent. Check your inbox';
    } catch (err) {
      btn.textContent = old;
      btn.disabled = false;
      toast(err.message || 'Could not send the email. Try again.', true);
    }
  }

  /* ---------------------------------------------------------
     Wiring for static controls
     --------------------------------------------------------- */
  $('searchForm').addEventListener('submit', function (e) { e.preventDefault(); runSearch(false); });
  $('radiusSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-radius]');
    if (!b) return;
    ui.radius = Number(b.dataset.radius);
    document.querySelectorAll('#radiusSeg button').forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); });
    if (ui.search.ran) runSearch(false);
  });
  $('sortSelect').addEventListener('change', function (e) { ui.sort = e.target.value; renderResults(); });
  $('ratingSelect').addEventListener('change', function (e) { ui.minRating = Number(e.target.value) || 0; renderResults(); });
  $('maxFeeInput').addEventListener('input', function (e) {
    var v = e.target.value.trim();
    ui.maxFee = v === '' || !isFinite(Number(v)) ? null : Math.max(0, Number(v));
    renderResults();
  });
  $('loadMoreBtn').addEventListener('click', function () { runSearch(true); });

  $('classTabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-filter]');
    if (!b) return;
    ui.classFilter = b.dataset.filter;
    renderClasses();
  });
  $('classSearch').addEventListener('input', function (e) { ui.classQuery = e.target.value; renderClasses(); });
  $('exportBtn').addEventListener('click', exportPayments);
  $('detailsModalClose').addEventListener('click', function () { $('detailsModalBackdrop').classList.remove('open'); });
  $('courseModalClose').addEventListener('click', function () { $('courseModalBackdrop').classList.remove('open'); });

  /* ---------------------------------------------------------
     Start
     --------------------------------------------------------- */
  renderChips();
  renderLocation();
  renderResults();
  renderSaved();
  renderCourses();
  renderReports();
  applyRoute(false);

  loadMe();
  loadStudent();
  loadBookings();
  loadCourses();
  loadSaved();
  loadReports();
})();/* ===========================================================
   TutorLink — Student dashboard
   Needs js/api.js and js/ui.js loaded first.
   Everything lives inside one function so nothing leaks into
   the global scope. Clicks use data-act attributes (no inline
   onclick), and every value from the server goes through
   escapeHtml() before it is put into the page.
   =========================================================== */
(function () {
  'use strict';

  var session = requireLogin('student');
  if (!session) return;
  var USER = session.user;

  // Must match APP_TIMEZONE on the server (default Asia/Kolkata). Class times are stored in this zone.
  var APP_TZ = 'Asia/Kolkata';
  var APP_TZ_OFFSET = '+05:30';
  var MAX_DAYS_AHEAD = 180; // same limit as the server
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var VIEWS = ['overview', 'find', 'classes', 'courses', 'payments', 'saved', 'support'];
  var SUBJECT_CHIPS = ['Maths', 'Science', 'English', 'Physics', 'Chemistry', 'Biology', 'Hindi', 'Computer'];
  var BRAND = '#7C5CFC';
  var DEFAULT_CENTER = [28.9845, 77.7064]; // Meerut — only used to open the map when nothing else is known
  var REPORT_REASONS = {
    no_show: 'No-show',
    inappropriate_behaviour: 'Inappropriate behaviour',
    payment_issue: 'Payment issue',
    fake_profile: 'Fake profile',
    other: 'Other'
  };

  function $(id) { return document.getElementById(id); }
  function esc(v) { return escapeHtml(v); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function reduceMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* ---------------------------------------------------------
     State
     --------------------------------------------------------- */
  var state = {
    me: null,
    student: null,
    bookings: [],
    bookingsError: null,
    sessions: {},          // bookingId -> array of class_sessions (only for accepted bookings)
    courses: [],
    coursesError: null,
    saved: [],
    savedError: null,
    favoriteIds: new Set(),
    reports: [],
    reportsError: null,
    loaded: { bookings: false, courses: false, saved: false, reports: false, student: false }
  };
  var ui = {
    view: 'overview',
    classFilter: 'all',
    classQuery: '',
    radius: 5,
    sort: 'nearest',
    minRating: 0,
    maxFee: null,
    search: { items: [], page: 0, totalPages: 0, total: 0, params: null, ran: false, loading: false, error: null }
  };
  var teacherCache = {};
  var confirmingPayments = new Set(); // payments received but not yet confirmed (prevents paying twice)
  var currentLat = null;
  var currentLng = null;
  var currentAddress = null;

  /* ---------------------------------------------------------
     Date + money helpers (all dates are plain YYYY-MM-DD)
     --------------------------------------------------------- */
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function todayIST() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  function hourIST() {
    var h = new Intl.DateTimeFormat('en-GB', { timeZone: APP_TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date());
    return parseInt(h, 10);
  }
  function addDays(dateStr, days) {
    var p = dateStr.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days)).toISOString().slice(0, 10);
  }
  function weekdayOf(dateStr) {
    var p = dateStr.split('-').map(Number);
    return WEEKDAYS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
  }
  function parseSlot(slot) {
    var m = String(slot || '').trim().match(/^(0?[1-9]|1[0-2]):([0-5]\d)\s*(AM|PM)$/i);
    if (!m) return null;
    var h = parseInt(m[1], 10) % 12;
    if (m[3].toUpperCase() === 'PM') h += 12;
    return { h: h, m: parseInt(m[2], 10) };
  }
  function classInstant(date, slot) {
    var t = parseSlot(slot);
    if (!t || !DATE_RE.test(String(date || ''))) return null;
    var d = new Date(date + 'T' + pad2(t.h) + ':' + pad2(t.m) + ':00' + APP_TZ_OFFSET);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(dateStr, long) {
    if (!DATE_RE.test(String(dateStr || ''))) return dateStr ? String(dateStr) : '—';
    var p = dateStr.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.toLocaleDateString('en-IN', long
      ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }
      : { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  function dateParts(dateStr) {
    if (!DATE_RE.test(String(dateStr || ''))) return { day: '—', mon: '', wd: '' };
    var p = dateStr.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return {
      day: String(p[2]),
      mon: d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }),
      wd: d.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })
    };
  }
  function fmtMoney(n) {
    return '₹' + num(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }
  function until(ms) {
    if (ms <= 0) {
      var ago = Math.floor(-ms / 60000);
      if (ago < 1) return 'Starting now';
      if (ago <= 60) return 'Started ' + ago + ' min ago';
      return 'Earlier today';
    }
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return 'In under a minute';
    if (mins < 60) return 'In ' + mins + ' min';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return 'In ' + hrs + 'h ' + (mins % 60) + 'm';
    var days = Math.floor(hrs / 24);
    return 'In ' + days + ' day' + (days === 1 ? '' : 's');
  }
  function initials(name) {
    var s = String(name || '').split(/\s+/).filter(Boolean).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
    return s || '?';
  }
  function avatarInner(name, photo) {
    if (photo) return '<img src="' + esc(photoUrl(photo)) + '" alt="">';
    return esc(initials(name));
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /* ---------------------------------------------------------
     Toast + confirm dialog
     --------------------------------------------------------- */
  var toastTimer = null;
  function toast(message, isError) {
    var el = $('toast');
    el.textContent = message;
    el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 5000);
  }

  // A backdrop is visibility:hidden until its fade-in starts, and hidden elements cannot take focus yet.
  function focusSoon(el) {
    var tries = 0;
    (function attempt() {
      el.focus();
      if (document.activeElement !== el && ++tries < 12) setTimeout(attempt, 30);
    })();
  }

  var confirmResolve = null;
  function ask(opts) {
    $('confirmTitle').textContent = opts.title;
    $('confirmText').textContent = opts.message;
    var yes = $('confirmYes');
    yes.textContent = opts.okText || 'Yes';
    yes.className = 'btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger');
    $('confirmNo').textContent = opts.cancelText || 'Keep it';
    $('confirmBackdrop').classList.add('open');
    focusSoon($('confirmNo'));
    return new Promise(function (resolve) { confirmResolve = resolve; });
  }
  function closeConfirm(result) {
    $('confirmBackdrop').classList.remove('open');
    if (confirmResolve) { var r = confirmResolve; confirmResolve = null; r(result); }
  }
  $('confirmYes').addEventListener('click', function () { closeConfirm(true); });
  $('confirmNo').addEventListener('click', function () { closeConfirm(false); });

  /* ---------------------------------------------------------
     Header + navigation
     --------------------------------------------------------- */
  $('welcomeText').textContent = USER.name || 'Student';
  $('avatarInitials').textContent = initials(USER.name);

  $('logoutBtn').addEventListener('click', function () {
    clearSession();
    window.location.href = 'login.html';
  });
  initNotificationBell();

  function currentRoute() {
    var name = location.hash.replace(/^#/, '');
    return VIEWS.indexOf(name) === -1 ? 'overview' : name;
  }
  function go(name) {
    if (currentRoute() === name && location.hash.replace(/^#/, '') === name) applyRoute(false);
    else location.hash = name;
  }
  function applyRoute(focusHeading) {
    var name = currentRoute();
    ui.view = name;
    VIEWS.forEach(function (v) {
      $('view-' + v).hidden = v !== name;
    });
    document.querySelectorAll('#sdRail .sd-nav').forEach(function (a) {
      if (a.dataset.view === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    var active = document.querySelector('#sdRail .sd-nav[aria-current="page"]');
    if (active && active.scrollIntoView && window.innerWidth <= 960) {
      try { active.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) { /* older browsers */ }
    }
    if (name === 'find') ensureFindReady();
    if (name !== 'overview' || focusHeading) window.scrollTo(0, 0);
    if (focusHeading) {
      var h = document.querySelector('#view-' + name + ' h2');
      if (h) h.focus({ preventScroll: true });
    }
  }
  window.addEventListener('hashchange', function () {
    var h = location.hash.replace(/^#/, '');
    if (VIEWS.indexOf(h) === -1) {
      // e.g. the skip link (#mainContent): keep the current view, just move focus
      if (h === 'mainContent') $('mainContent').focus();
      return;
    }
    applyRoute(true);
  });

  /* ---------------------------------------------------------
     Data loading
     --------------------------------------------------------- */
  async function loadMe() {
    try {
      var data = await apiRequest('/api/auth/me');
      state.me = (data && data.user) || null;
      if (state.me && state.me.profile_photo) {
        $('avatarInitials').innerHTML = '<img src="' + esc(photoUrl(state.me.profile_photo)) + '" alt="">';
      }
    } catch (e) { /* keep the initials */ }
    renderVerifyBanner();
    renderProfileCard();
    renderOverview();
  }

  async function loadStudent() {
    try {
      state.student = await apiRequest('/api/students/by-user/' + encodeURIComponent(USER.id));
      if (state.student && state.student.latitude !== null && state.student.longitude !== null &&
          state.student.latitude !== undefined && state.student.longitude !== undefined && currentLat === null) {
        var lat = parseFloat(state.student.latitude);
        var lng = parseFloat(state.student.longitude);
        if (isFinite(lat) && isFinite(lng)) {
          currentLat = lat;
          currentLng = lng;
          currentAddress = {
            area: state.student.area || '',
            district: state.student.district || '',
            pincode: state.student.pincode || '',
            display: state.student.address || ''
          };
        }
      }
    } catch (e) { state.student = null; }
    state.loaded.student = true;
    renderLocation();
    renderProfileCard();
    renderChips();
    renderOverview();
    if (ui.view === 'find') ensureFindReady();
  }

  async function loadBookings() {
    try {
      var data = await apiRequest('/api/bookings/student/me');
      state.bookings = Array.isArray(data) ? data : ((data && data.bookings) || []);
      state.bookingsError = null;
    } catch (e) {
      state.bookingsError = e.message || 'Could not load your bookings.';
    }
    state.loaded.bookings = true;
    renderAll();
    await loadSessions();
    renderAll();
  }

  async function loadSessions() {
    var accepted = state.bookings.filter(function (b) { return b.status === 'accepted'; }).slice(0, 15);
    var results = await Promise.allSettled(accepted.map(function (b) {
      return apiRequest('/api/bookings/' + encodeURIComponent(b.id) + '/sessions');
    }));
    var next = {};
    results.forEach(function (r, i) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) next[accepted[i].id] = r.value;
    });
    state.sessions = next;
  }

  async function loadCourses() {
    try {
      var data = await apiRequest('/api/courses');
      state.courses = Array.isArray(data) ? data : [];
      state.coursesError = null;
    } catch (e) { state.coursesError = e.message || 'Could not load your courses.'; }
    state.loaded.courses = true;
    renderCourses();
  }

  async function loadSaved() {
    try {
      var data = await apiRequest('/api/favorites/me');
      state.saved = Array.isArray(data) ? data : [];
      state.favoriteIds = new Set(state.saved.map(function (t) { return Number(t.id); }));
      state.savedError = null;
    } catch (e) { state.savedError = e.message || 'Could not load saved teachers.'; }
    state.loaded.saved = true;
    renderSaved();
    renderResults();
    renderNavBadges();
    renderOverview();
  }

  async function loadReports() {
    try {
      var data = await apiRequest('/api/reports/mine');
      state.reports = Array.isArray(data) ? data : [];
      state.reportsError = null;
    } catch (e) { state.reportsError = e.message || 'Could not load your reports.'; }
    state.loaded.reports = true;
    renderReports();
  }

  /* ---------------------------------------------------------
     Derived data
     --------------------------------------------------------- */
  function bookingStatus(b) { return String(b.status || 'requested').toLowerCase(); }
  function isOpenStatus(s) { return s === 'requested' || s === 'accepted'; }

  // Every scheduled class that has not finished yet, soonest first.
  function classEvents() {
    var out = [];
    var now = Date.now();
    state.bookings.forEach(function (b) {
      if (bookingStatus(b) !== 'accepted') return;
      var sess = state.sessions[b.id];
      var list = [];
      if (Array.isArray(sess)) {
        list = sess.filter(function (s) { return s.status === 'scheduled'; })
          .map(function (s) { return { date: s.session_date, time: s.session_time || b.booking_time }; });
      } else if (b.booking_date) {
        list = [{ date: b.booking_date, time: b.booking_time }]; // sessions not loaded (yet): fall back to the first date
      }
      list.forEach(function (s) {
        var at = classInstant(s.date, s.time);
        if (!at || at.getTime() < now - 60 * 60000) return;
        out.push({ booking: b, date: s.date, time: s.time, at: at });
      });
    });
    out.sort(function (a, c) { return a.at - c.at; });
    return out;
  }

  function payInfo(b) {
    var s = bookingStatus(b);
    var fee = num(b.fee);
    if (b.payment_status === 'refunded') return { label: 'Refunded', tone: 'info' };
    if (fee > 0 && b.payment_status === 'paid') return { label: 'Paid', tone: 'ok' };
    if (s === 'accepted' && fee > 0) return { label: 'Payment due', tone: 'warn' };
    if (s === 'completed' && fee > 0) return { label: 'Payment pending', tone: 'warn' };
    if ((s === 'accepted' || s === 'completed') && fee === 0) return { label: 'No charge', tone: 'muted' };
    return null;
  }
  function isDue(b) {
    return bookingStatus(b) === 'accepted' && b.payment_status === 'unpaid' && num(b.fee) > 0;
  }
  function findBooking(id) {
    id = Number(id);
    return state.bookings.find(function (b) { return Number(b.id) === id; }) || null;
  }
  function typeLabel(b) {
    if (b.type === 'recurring') {
      var days = String(b.days_per_week || '').split(',').map(function (d) { return d.trim(); }).filter(Boolean).join(', ');
      return 'Weekly' + (days ? ' · ' + days : '');
    }
    return 'Demo class';
  }

  /* ---------------------------------------------------------
     Rendering — shared pieces
     --------------------------------------------------------- */
  function emptyState(icon, title, text, actionHtml) {
    return '<div class="sd-empty"><div class="sd-empty-ic" aria-hidden="true">' + icon + '</div><h3>' + esc(title) + '</h3>' +
      (text ? '<p>' + esc(text) + '</p>' : '') + (actionHtml || '') + '</div>';
  }
  function errorState(message, retryAct) {
    return '<div class="sd-empty sd-empty-err"><div class="sd-empty-ic" aria-hidden="true">⚠️</div><h3>Something went wrong</h3><p>' +
      esc(message) + '</p><button type="button" class="btn btn-outline btn-sm" data-act="' + retryAct + '">Try again</button></div>';
  }
  function skeletons(n) {
    var h = '';
    for (var i = 0; i < n; i++) h += '<div class="sd-skel sd-skel-lg"></div>';
    return h;
  }
  function tag(label, tone) {
    return '<span class="sd-tag sd-tag-' + (tone || 'muted') + '">' + esc(label) + '</span>';
  }
  function statusTag(status) {
    var tone = { requested: 'warn', accepted: 'ok', completed: 'ok', declined: 'bad', cancelled: 'bad' }[status] || 'muted';
    var label = { requested: 'Waiting for teacher', accepted: 'Confirmed', completed: 'Completed', declined: 'Declined', cancelled: 'Cancelled' }[status] || status;
    return tag(label, tone);
  }

  function renderAll() {
    renderNavBadges();
    renderOverview();
    renderClasses();
    renderPayments();
    renderProfileCard();
  }

  function renderNavBadges() {
    var open = state.bookings.filter(function (b) { return isOpenStatus(bookingStatus(b)); }).length;
    var due = state.bookings.filter(isDue).length;
    setBadge('navClassesBadge', open);
    setBadge('navPaymentsBadge', due);
    setBadge('navSavedBadge', state.saved.length);
  }
  function setBadge(id, n) {
    var el = $(id);
    el.textContent = n > 99 ? '99+' : String(n);
    el.hidden = !(n > 0);
  }

  function renderVerifyBanner() {
    var host = $('verifyBanner');
    if (!state.me || state.me.email_verified) { host.innerHTML = ''; return; }
    host.innerHTML =
      '<div class="container"><div class="sd-banner" role="status">' +
      '<div><strong>Please verify your email</strong><span>You need a verified email to book classes. Check your inbox, or resend the link.</span></div>' +
      '<button type="button" class="btn btn-accent btn-sm" data-act="resend-verify">Resend email</button></div></div>';
  }

  function profileChecks() {
    var s = state.student || {};
    var me = state.me || {};
    return [
      { ok: !!me.email_verified, label: 'Verify your email' },
      { ok: !!me.profile_photo, label: 'Add a profile photo' },
      { ok: currentLat !== null, label: 'Set your location' },
      { ok: !!s.preferred_subjects, label: 'Add the subjects you want' },
      { ok: !!s.address, label: 'Add your address' }
    ];
  }
  function renderProfileCard() {
    var card = $('profileCard');
    if (!state.me && !state.loaded.student) { card.hidden = true; return; }
    var checks = profileChecks();
    var done = checks.filter(function (c) { return c.ok; }).length;
    var pct = Math.round(done / checks.length * 100);
    card.hidden = false;
    $('profileRing').style.setProperty('--pct', pct + '%');
    $('profilePct').textContent = pct + '%';
    var missing = checks.filter(function (c) { return !c.ok; })[0];
    $('profileHint').innerHTML = missing
      ? esc(missing.label) + '. <a href="student-complete-profile.html">Edit profile</a>'
      : 'All set. Teachers can match you better.';
  }

  /* ---------------------------------------------------------
     Overview
     --------------------------------------------------------- */
  function countTo(id, value, formatter) {
    var el = $(id);
    var fmt = formatter || function (v) { return String(v); };
    var target = num(value);
    if (reduceMotion() || target === 0) { el.textContent = fmt(target); return; }
    var start = performance.now();
    var dur = 600;
    function tick(now) {
      var p = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(tick); else el.textContent = fmt(target);
    }
    requestAnimationFrame(tick);
  }

  var lastStats = {};
  function setStat(id, value, formatter) {
    if (lastStats[id] === value) return;
    lastStats[id] = value;
    countTo(id, value, formatter);
  }

  function renderOverview() {
    var first = String(USER.name || 'there').split(' ')[0];
    var h = hourIST();
    var greet = h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Good night';
    $('h-overview').textContent = greet + ', ' + first;

    var events = classEvents();
    var next = events[0] || null;

    if (!state.loaded.bookings) {
      $('heroSub').textContent = 'Loading your day…';
    } else if (state.bookingsError) {
      $('heroSub').textContent = 'We could not load your classes just now.';
    } else if (next) {
      $('heroSub').innerHTML = 'Your next class is <strong>' + esc(next.booking.subject || 'a class') + '</strong> with <strong>' +
        esc(next.booking.teacher_name || 'your teacher') + '</strong>, ' + esc(until(next.at - Date.now()).toLowerCase()) + '.';
    } else if (state.bookings.some(function (b) { return bookingStatus(b) === 'requested'; })) {
      $('heroSub').textContent = 'Your request is with the teacher. We will notify you as soon as they reply.';
    } else {
      $('heroSub').textContent = 'No classes yet. Find a verified tutor near you and book a demo.';
    }

    var loc = $('heroLoc');
    if (currentLat !== null && currentAddress) {
      loc.innerHTML = '<span class="sd-loc-pill">📍 ' + esc(currentAddress.area || 'Location set') +
        (currentAddress.district && currentAddress.district !== '—' ? ', ' + esc(currentAddress.district) : '') + '</span>';
    } else {
      loc.innerHTML = '<button type="button" class="sd-loc-pill sd-loc-pill-btn" data-act="goto-location">📍 Set your location</button>';
    }

    var b = state.bookings;
    if (state.loaded.bookings && !state.bookingsError) {
      setStat('statAhead', events.length);
      setStat('statPending', b.filter(function (x) { return bookingStatus(x) === 'requested'; }).length);
      setStat('statDone', b.filter(function (x) { return bookingStatus(x) === 'completed'; }).length);
      var paid = b.reduce(function (sum, x) { return sum + (x.payment_status === 'paid' ? num(x.fee) : 0); }, 0);
      setStat('statPaid', paid, fmtMoney);
    }

    renderNextCard(next);
    renderAttention();
    renderWeek(events);
  }

  function renderNextCard(next) {
    var host = $('nextCard');
    if (!state.loaded.bookings) { host.innerHTML = '<div class="sd-skel sd-skel-lg"></div>'; return; }
    if (state.bookingsError) { host.innerHTML = errorState(state.bookingsError, 'reload-bookings'); return; }
    if (!next) {
      host.innerHTML = '<header class="sd-card-head"><h3>Next class</h3></header>' +
        emptyState('🎓', 'Nothing scheduled', 'When a teacher accepts your request, your class shows up here with a live countdown.',
          '<a href="#find" class="btn btn-primary btn-sm">Find a tutor</a>');
      return;
    }
    var b = next.booking;
    var dp = dateParts(next.date);
    var live = next.at.getTime() - Date.now() <= 0;
    host.innerHTML =
      '<header class="sd-card-head"><h3>Next class</h3>' + (live ? tag('Happening now', 'ok') : '') + '</header>' +
      '<div class="sd-next-body">' +
        '<div class="sd-datetile"><span>' + esc(dp.wd) + '</span><strong>' + esc(dp.day) + '</strong><span>' + esc(dp.mon) + '</span></div>' +
        '<div class="sd-next-info">' +
          '<h4>' + esc(b.subject || 'Class') + ' with ' + esc(b.teacher_name || 'your teacher') + '</h4>' +
          '<p class="sd-muted">' + esc(fmtDate(next.date, true)) + ' · ' + esc(next.time || '') + '</p>' +
          '<div class="sd-countdown" data-countdown="' + next.at.getTime() + '">' + esc(until(next.at - Date.now())) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="sd-row-actions">' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="chat" data-id="' + Number(b.id) + '">💬 Chat with teacher</button>' +
        '<button type="button" class="btn btn-outline btn-sm" data-act="details" data-id="' + Number(b.id) + '">Details</button>' +
        (isDue(b) ? '<button type="button" class="btn btn-accent btn-sm" data-act="pay" data-id="' + Number(b.id) + '">Pay ' + esc(fmtMoney(b.fee)) + '</button>' : '') +
      '</div>';
  }

  function attentionItems() {
    var items = [];
    if (state.me && !state.me.email_verified) {
      items.push({ tone: 'warn', icon: '✉️', title: 'Verify your email', text: 'Required before you can book a class.', act: 'resend-verify', label: 'Resend' });
    }
    if (state.loaded.student && currentLat === null) {
      items.push({ tone: 'warn', icon: '📍', title: 'Set your location', text: 'So we can show teachers near you.', act: 'goto-location', label: 'Set now' });
    }
    state.bookings.filter(isDue).slice(0, 3).forEach(function (b) {
      items.push({ tone: 'warn', icon: '💳', title: 'Pay ' + fmtMoney(b.fee) + ' to ' + (b.teacher_name || 'your teacher'),
        text: (b.subject || 'Class') + ' · ' + fmtDate(b.booking_date), act: 'pay', id: b.id, label: 'Pay now' });
    });
    state.bookings.filter(function (b) { return bookingStatus(b) === 'completed' && !b.review_id; }).slice(0, 3).forEach(function (b) {
      items.push({ tone: 'info', icon: '⭐', title: 'How was ' + (b.subject || 'your class') + ' with ' + (b.teacher_name || 'your teacher') + '?',
        text: 'A short review helps other students.', act: 'review', id: b.id, label: 'Review' });
    });
    if (state.loaded.student && state.student && !state.student.preferred_subjects) {
      items.push({ tone: 'muted', icon: '🧩', title: 'Add the subjects you want', text: 'Takes a minute and improves your matches.', href: 'student-complete-profile.html', label: 'Edit profile' });
    }
    return items;
  }

  function renderAttention() {
    var host = $('attentionList');
    if (!state.loaded.bookings && !state.loaded.student) { host.innerHTML = '<div class="sd-skel"></div><div class="sd-skel"></div>'; return; }
    var items = attentionItems();
    if (!items.length) {
      host.innerHTML = emptyState('✨', 'You are all caught up', 'Nothing needs your attention right now.');
      return;
    }
    host.innerHTML = '<ul class="sd-todo">' + items.slice(0, 6).map(function (it) {
      var action = it.href
        ? '<a class="btn btn-outline btn-sm" href="' + esc(it.href) + '">' + esc(it.label) + '</a>'
        : '<button type="button" class="btn btn-outline btn-sm" data-act="' + esc(it.act) + '"' + (it.id ? ' data-id="' + Number(it.id) + '"' : '') + '>' + esc(it.label) + '</button>';
      return '<li class="sd-todo-' + it.tone + '"><span class="sd-todo-ic" aria-hidden="true">' + it.icon + '</span>' +
        '<div><strong>' + esc(it.title) + '</strong><span>' + esc(it.text) + '</span></div>' + action + '</li>';
    }).join('') + '</ul>';
  }

  function renderWeek(events) {
    var strip = $('weekStrip');
    var today = todayIST();
    var cells = '';
    for (var i = 0; i < 7; i++) {
      var d = addDays(today, i);
      var count = events.filter(function (e) { return e.date === d; }).length;
      var dp = dateParts(d);
      cells += '<div class="sd-day' + (i === 0 ? ' is-today' : '') + (count ? ' has-class' : '') + '">' +
        '<span>' + esc(i === 0 ? 'Today' : dp.wd) + '</span><strong>' + esc(dp.day) + '</strong>' +
        '<em>' + (count ? plural(count, 'class', 'classes') : '—') + '</em></div>';
    }
    strip.innerHTML = cells;
    $('weekRange').textContent = fmtDate(today) + ' – ' + fmtDate(addDays(today, 6));

    var agenda = $('agendaList');
    if (!state.loaded.bookings) { agenda.innerHTML = ''; return; }
    var upcoming = events.slice(0, 6);
    if (!upcoming.length) { agenda.innerHTML = ''; return; }
    agenda.innerHTML = '<h4 class="sd-subhead">Coming up</h4><ul class="sd-agenda-list">' + upcoming.map(function (e) {
      return '<li><span class="sd-agenda-when"><strong>' + esc(fmtDate(e.date)) + '</strong>' + esc(e.time || '') + '</span>' +
        '<span class="sd-agenda-what">' + esc(e.booking.subject || 'Class') + ' · ' + esc(e.booking.teacher_name || 'Teacher') + '</span>' +
        '<span class="sd-muted" data-countdown="' + e.at.getTime() + '">' + esc(until(e.at - Date.now())) + '</span></li>';
    }).join('') + '</ul>';
  }

  // Keep countdowns fresh without re-rendering the whole page.
  setInterval(function () {
    var nodes = document.querySelectorAll('[data-countdown]');
    var stale = false;
    nodes.forEach(function (n) {
      var t = Number(n.dataset.countdown);
      if (!t) return;
      var ms = t - Date.now();
      n.textContent = until(ms);
      if (ms < -3600000) stale = true;
    });
    if (stale) renderOverview();
  }, 30000);

  /* ---------------------------------------------------------
     My classes
     --------------------------------------------------------- */
  function classMatchesFilter(b) {
    var s = bookingStatus(b);
    if (ui.classFilter === 'upcoming') return isOpenStatus(s);
    if (ui.classFilter === 'completed') return s === 'completed';
    if (ui.classFilter === 'closed') return s === 'cancelled' || s === 'declined';
    return true;
  }
  function bookingSortKey(b) {
    var at = classInstant(b.booking_date, b.booking_time);
    return at ? at.getTime() : (b.created_at ? new Date(b.created_at).getTime() : 0);
  }

  function renderClasses() {
    var host = $('bookingsArea');
    if (!state.loaded.bookings) { host.innerHTML = skeletons(2); return; }
    if (state.bookingsError) { host.innerHTML = errorState(state.bookingsError, 'reload-bookings'); return; }

    var all = state.bookings;
    $('tabAll').textContent = all.length;
    $('tabUpcoming').textContent = all.filter(function (b) { return isOpenStatus(bookingStatus(b)); }).length;
    $('tabCompleted').textContent = all.filter(function (b) { return bookingStatus(b) === 'completed'; }).length;
    $('tabClosed').textContent = all.filter(function (b) { var s = bookingStatus(b); return s === 'cancelled' || s === 'declined'; }).length;
    document.querySelectorAll('#classTabs button').forEach(function (btn) {
      btn.setAttribute('aria-selected', String(btn.dataset.filter === ui.classFilter));
    });

    if (!all.length) {
      host.innerHTML = emptyState('📅', 'No classes yet', 'Search for a tutor near you and request a demo class to get started.',
        '<a href="#find" class="btn btn-primary btn-sm">Find a tutor</a>');
      return;
    }

    var q = ui.classQuery.trim().toLowerCase();
    var list = all.filter(classMatchesFilter).filter(function (b) {
      if (!q) return true;
      return String(b.teacher_name || '').toLowerCase().indexOf(q) !== -1 || String(b.subject || '').toLowerCase().indexOf(q) !== -1;
    });
    list.sort(function (a, c) {
      var ao = isOpenStatus(bookingStatus(a)); var co = isOpenStatus(bookingStatus(c));
      if (ao !== co) return ao ? -1 : 1;
      return ao ? bookingSortKey(a) - bookingSortKey(c) : bookingSortKey(c) - bookingSortKey(a);
    });

    if (!list.length) {
      host.innerHTML = emptyState('🔎', 'Nothing matches', q ? 'Try a different name or subject.' : 'No classes in this view.');
      return;
    }
    host.innerHTML = '<div class="sd-list">' + list.map(bookingCard).join('') + '</div>';
  }

  function bookingCard(b) {
    var status = bookingStatus(b);
    var dp = dateParts(b.booking_date);
    var pay = payInfo(b);
    var hasReview = !!b.review_id;
    var hoursSince = hasReview ? (Date.now() - new Date(b.review_created_at).getTime()) / 36e5 : null;
    var canEdit = hasReview && hoursSince !== null && isFinite(hoursSince) && hoursSince <= 24;
    var id = Number(b.id);
    var at = classInstant(b.booking_date, b.booking_time);
    var countdown = (status === 'accepted' && at && at.getTime() > Date.now() - 3600000)
      ? '<span class="sd-countdown-sm" data-countdown="' + at.getTime() + '">' + esc(until(at - Date.now())) + '</span>' : '';

    var feeText = status === 'requested' ? 'Fee set when accepted'
      : (num(b.fee) > 0 ? fmtMoney(b.fee) : (status === 'declined' || status === 'cancelled' ? '' : 'No charge'));

    var actions = '';
    if (isDue(b)) {
      actions += confirmingPayments.has(id)
        ? '<button type="button" class="btn btn-outline btn-sm" disabled>⏳ Confirming payment…</button>'
        : '<button type="button" class="btn btn-accent btn-sm" data-act="pay" data-id="' + id + '">💳 Pay ' + esc(fmtMoney(b.fee)) + '</button>';
    }
    if (status === 'accepted' || status === 'completed') {
      actions += '<button type="button" class="btn btn-outline btn-sm" data-act="chat" data-id="' + id + '">💬 Chat</button>';
    }
    if (status === 'completed' && !hasReview) {
      actions += '<button type="button" class="btn btn-outline btn-sm" data-act="review" data-id="' + id + '">⭐ Review</button>';
    }
    if (canEdit) {
      actions += '<button type="button" class="btn btn-outline btn-sm" data-act="edit-review" data-id="' + id + '">✏️ Edit review</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="delete-review" data-id="' + id + '" aria-label="Delete review">🗑️</button>';
    }
    actions += '<button type="button" class="btn btn-ghost btn-sm" data-act="details" data-id="' + id + '">Details</button>';
    if (isOpenStatus(status)) {
      actions += '<button type="button" class="btn btn-ghost btn-sm sd-danger" data-act="cancel" data-id="' + id + '">Cancel class</button>';
    }
    if (status === 'accepted' || status === 'completed') {
      actions += '<button type="button" class="btn btn-ghost btn-sm" data-act="report" data-id="' + id + '" title="Report an issue" aria-label="Report an issue">🚩</button>';
    }

    var review = '';
    if (hasReview) {
      var r = Math.max(0, Math.min(5, num(b.review_rating)));
      review = '<div class="sd-review"><span class="sd-stars-line" aria-label="' + r + ' out of 5 stars">' + '★'.repeat(r) + '☆'.repeat(5 - r) + '</span>' +
        (b.review_comment ? ' ' + esc(b.review_comment) : '') +
        (b.teacher_reply ? '<div class="sd-reply"><strong>Teacher’s reply:</strong> ' + esc(b.teacher_reply) + '</div>' : '') + '</div>';
    }

    return '<article class="sd-booking sd-b-' + esc(status) + '">' +
      '<div class="sd-datetile"><span>' + esc(dp.wd) + '</span><strong>' + esc(dp.day) + '</strong><span>' + esc(dp.mon) + '</span></div>' +
      '<div class="sd-booking-main">' +
        '<div class="sd-booking-top"><h4>' + esc(b.subject || 'Class') + ' <span class="sd-muted">with</span> ' + esc(b.teacher_name || 'Teacher') + '</h4>' + countdown + '</div>' +
        '<div class="sd-meta">' +
          '<span>🕒 ' + esc(b.booking_time || '—') + '</span>' +
          '<span>' + esc(typeLabel(b)) + '</span>' +
          (feeText ? '<span>' + esc(feeText) + '</span>' : '') +
        '</div>' +
        '<div class="sd-tags">' + statusTag(status) + (pay ? tag(pay.label, pay.tone) : '') + '</div>' +
        review +
      '</div>' +
      '<div class="sd-booking-actions">' + actions + '</div>' +
    '</article>';
  }

  /* ---------------------------------------------------------
     Courses
     --------------------------------------------------------- */
  function renderCourses() {
    var host = $('coursesArea');
    if (!state.loaded.courses) { host.innerHTML = skeletons(1); return; }
    if (state.coursesError) { host.innerHTML = errorState(state.coursesError, 'reload-courses'); return; }
    if (!state.courses.length) {
      host.innerHTML = emptyState('📚', 'No courses yet', 'Your teacher can set up a course once your classes are underway. It will appear here.');
      return;
    }
    host.innerHTML = '<div class="sd-cards">' + state.courses.map(function (c) {
      var mods = num(c.module_count);
      var tone = c.status === 'completed' ? 'ok' : c.status === 'paused' ? 'warn' : 'info';
      return '<article class="sd-card sd-course">' +
        '<div class="sd-course-top">' + tag(c.status || 'active', tone) + (c.subject ? '<span class="sd-muted">' + esc(c.subject) + '</span>' : '') + '</div>' +
        '<h4>' + esc(c.title) + '</h4>' +
        '<p class="sd-muted">with ' + esc(c.teacher_name || 'your teacher') + ' · ' + esc(plural(mods, 'module', 'modules')) + '</p>' +
        (c.description ? '<p class="sd-clamp">' + esc(c.description) + '</p>' : '') +
        '<button type="button" class="btn btn-outline btn-sm" data-act="open-course" data-id="' + Number(c.id) + '">Open course</button>' +
      '</article>';
    }).join('') + '</div>';
  }

  async function openCourse(id) {
    $('courseTitle').textContent = 'Course';
    $('courseSub').textContent = '';
    $('courseBody').innerHTML = skeletons(1);
    $('courseModalBackdrop').classList.add('open');
    try {
      var c = await apiRequest('/api/courses/' + encodeURIComponent(id));
      var mods = Array.isArray(c.modules) ? c.modules : [];
      var done = mods.filter(function (m) { return m.status === 'completed'; }).length;
      var pct = mods.length ? Math.round(done / mods.length * 100) : 0;
      $('courseTitle').textContent = c.title || 'Course';
      $('courseSub').textContent = 'with ' + (c.teacher_name || 'your teacher') + (c.subject ? ' · ' + c.subject : '');
      $('courseBody').innerHTML =
        (c.description ? '<p>' + esc(c.description) + '</p>' : '') +
        '<div class="sd-meta">' +
          (c.start_date ? '<span>Starts ' + esc(fmtDate(String(c.start_date).slice(0, 10))) + '</span>' : '') +
          (c.end_date ? '<span>Ends ' + esc(fmtDate(String(c.end_date).slice(0, 10))) + '</span>' : '') +
          '<span>' + esc(c.status || 'active') + '</span>' +
        '</div>' +
        '<div class="sd-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Course progress"><i style="width:' + pct + '%"></i></div>' +
        '<p class="sd-muted">' + esc(done + ' of ' + plural(mods.length, 'module', 'modules') + ' completed') + '</p>' +
        (mods.length
          ? '<ol class="sd-modules">' + mods.map(function (m) {
              var ok = m.status === 'completed';
              return '<li class="' + (ok ? 'is-done' : '') + '"><span class="sd-check" aria-hidden="true">' + (ok ? '✓' : '') + '</span>' +
                '<div><strong>' + esc(m.title) + '</strong>' + (m.description ? '<span>' + esc(m.description) + '</span>' : '') + '</div>' +
                '<em class="sd-muted">' + (ok ? 'Done' : 'To do') + '</em></li>';
            }).join('') + '</ol>'
          : emptyState('🗂️', 'No modules yet', 'Your teacher has not added any modules to this course.'));
    } catch (e) {
      $('courseBody').innerHTML = errorState(e.message || 'Could not load this course.', 'close-course');
    }
  }

  /* ---------------------------------------------------------
     Payments
     --------------------------------------------------------- */
  function paymentRows() {
    return state.bookings.filter(function (b) {
      return num(b.fee) > 0 || b.payment_status === 'refunded';
    }).sort(function (a, c) { return bookingSortKey(c) - bookingSortKey(a); });
  }

  function renderPayments() {
    var host = $('paymentsArea');
    if (!state.loaded.bookings) { host.innerHTML = skeletons(1); return; }
    if (state.bookingsError) { host.innerHTML = errorState(state.bookingsError, 'reload-bookings'); return; }

    var rows = paymentRows();
    var paid = 0, due = 0, refunded = 0;
    rows.forEach(function (b) {
      var fee = num(b.fee);
      if (b.payment_status === 'paid') paid += fee;
      else if (b.payment_status === 'refunded') refunded += fee;
      else if (isDue(b)) due += fee;
    });
    $('payPaid').textContent = fmtMoney(paid);
    $('payDue').textContent = fmtMoney(due);
    $('payRefunded').textContent = fmtMoney(refunded);
    $('exportBtn').disabled = rows.length === 0;

    if (!rows.length) {
      host.innerHTML = emptyState('💳', 'No payments yet', 'When a teacher accepts a class and sets a fee, it shows up here.');
      return;
    }
    host.innerHTML = '<div class="sd-list">' + rows.map(function (b) {
      var id = Number(b.id);
      var pay = payInfo(b);
      var method = b.payment_status === 'paid' ? (b.razorpay_payment_id ? 'Online' : 'Paid to teacher directly') : '';
      return '<article class="sd-pay">' +
        '<div><strong>' + esc(b.subject || 'Class') + ' · ' + esc(b.teacher_name || 'Teacher') + '</strong>' +
        '<span class="sd-muted">' + esc(fmtDate(b.booking_date)) + ' · ' + esc(b.booking_time || '') + (method ? ' · ' + esc(method) : '') + '</span></div>' +
        '<div class="sd-pay-amt">' + esc(fmtMoney(b.fee)) + '</div>' +
        '<div>' + (pay ? tag(pay.label, pay.tone) : '') + '</div>' +
        '<div class="sd-pay-act">' + (isDue(b)
          ? (confirmingPayments.has(id)
              ? '<button type="button" class="btn btn-outline btn-sm" disabled>⏳ Confirming…</button>'
              : '<button type="button" class="btn btn-accent btn-sm" data-act="pay" data-id="' + id + '">Pay now</button>')
          : '') + '</div>' +
      '</article>';
    }).join('') + '</div>';
  }

  function csvCell(v) {
    var s = String(v === null || v === undefined ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets from running a cell as a formula
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function exportPayments() {
    var rows = paymentRows();
    if (!rows.length) return;
    var lines = [['Booking', 'Date', 'Time', 'Teacher', 'Subject', 'Amount (INR)', 'Status'].map(csvCell).join(',')];
    rows.forEach(function (b) {
      var pay = payInfo(b);
      lines.push([b.id, b.booking_date, b.booking_time, b.teacher_name, b.subject, num(b.fee).toFixed(2), pay ? pay.label : b.payment_status].map(csvCell).join(','));
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'tutorlink-payments.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------------------------------------------------------
     Saved teachers
     --------------------------------------------------------- */
  function renderSaved() {
    var host = $('savedTeachersArea');
    if (!state.loaded.saved) { host.innerHTML = skeletons(1); return; }
    if (state.savedError) { host.innerHTML = errorState(state.savedError, 'reload-saved'); return; }
    renderNavBadges();
    if (!state.saved.length) {
      host.innerHTML = emptyState('🤍', 'No saved teachers yet', 'Tap the heart on any teacher card to keep them here.',
        '<a href="#find" class="btn btn-primary btn-sm">Find a tutor</a>');
      return;
    }
    state.saved.forEach(function (t) {
      teacherCache[t.id] = Object.assign({}, teacherCache[t.id] || {}, t);
    });
    host.innerHTML = '<div class="sd-cards">' + state.saved.map(function (t) { return teacherCard(t, false); }).join('') + '</div>';
  }

  async function toggleFavorite(teacherId, btn) {
    teacherId = Number(teacherId);
    var wasSaved = state.favoriteIds.has(teacherId);
    if (btn) btn.disabled = true;
    try {
      if (wasSaved) {
        await apiRequest('/api/favorites/' + encodeURIComponent(teacherId), 'DELETE');
        state.favoriteIds.delete(teacherId);
        state.saved = state.saved.filter(function (t) { return Number(t.id) !== teacherId; });
        toast('Removed from saved teachers');
      } else {
        await apiRequest('/api/favorites', 'POST', { teacher_id: teacherId });
        state.favoriteIds.add(teacherId);
        toast('Teacher saved');
        await loadSaved();
        return;
      }
      renderSaved();
      renderResults();
      renderNavBadges();
    } catch (err) {
      toast(err.message, true);
      if (btn) btn.disabled = false;
    }
  }

  /* ---------------------------------------------------------
     Reports
     --------------------------------------------------------- */
  function renderReports() {
    var host = $('reportsArea');
    if (!state.loaded.reports) { host.innerHTML = '<div class="sd-skel"></div>'; return; }
    if (state.reportsError) { host.innerHTML = errorState(state.reportsError, 'reload-reports'); return; }
    if (!state.reports.length) {
      host.innerHTML = emptyState('🛡️', 'No reports filed', 'If something goes wrong in a class, you can report it from My classes.');
      return;
    }
    host.innerHTML = '<ul class="sd-todo">' + state.reports.map(function (r) {
      var tone = r.status === 'resolved' ? 'ok' : r.status === 'dismissed' ? 'muted' : 'warn';
      return '<li><span class="sd-todo-ic" aria-hidden="true">🚩</span><div><strong>' + esc(REPORT_REASONS[r.reason] || r.reason) +
        ' · ' + esc(r.reported_name || 'User') + '</strong><span>' + esc(r.details || 'No details added') + ' · ' +
        esc(r.created_at ? new Date(r.created_at).toLocaleDateString('en-IN') : '') + '</span></div>' + tag(r.status || 'open', tone) + '</li>';
    }).join('') + '</ul>';
  }

  /* ---------------------------------------------------------
     Location (GPS + map)
     --------------------------------------------------------- */
  function renderLocation() {
    var notSet = $('locationNotSet');
    var set = $('locationSet');
    if (currentLat === null || !currentAddress) {
      notSet.style.display = 'flex';
      set.style.display = 'none';
    } else {
      notSet.style.display = 'none';
      set.style.display = 'flex';
      $('crumbArea').textContent = currentAddress.area || 'Unknown area';
      $('crumbDistrict').textContent = currentAddress.district || '—';
      $('crumbPincode').textContent = currentAddress.pincode || '------';
    }
    renderOverview();
    renderProfileCard();
  }

  // OpenStreetMap Nominatim: free, no key. Swap for a paid geocoder if you outgrow its usage limits.
  async function reverseGeocode(lat, lng) {
    var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' + encodeURIComponent(lat) +
      '&lon=' + encodeURIComponent(lng) + '&zoom=18&addressdetails=1';
    var res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('Could not look up that address.');
    var data = await res.json();
    var a = data.address || {};
    return {
      area: a.suburb || a.neighbourhood || a.village || a.town || a.city_district || a.road || a.city || 'Unknown area',
      district: a.state_district || a.county || a.city || a.state || '—',
      pincode: a.postcode || '------',
      display: data.display_name || ''
    };
  }

  async function applyLocation(lat, lng) {
    currentLat = lat;
    currentLng = lng;
    try {
      currentAddress = await reverseGeocode(lat, lng);
    } catch (e) {
      currentAddress = { area: 'Location set', district: '—', pincode: '------', display: '' };
    }
    renderLocation();
    try {
      await apiRequest('/api/students/' + encodeURIComponent(USER.id) + '/location', 'PUT', {
        address: currentAddress.display || (currentAddress.area + ', ' + currentAddress.district),
        city: currentAddress.district,
        area: currentAddress.area,
        district: currentAddress.district,
        pincode: currentAddress.pincode,
        latitude: lat,
        longitude: lng
      });
      if (state.student) {
        state.student.latitude = lat; state.student.longitude = lng;
        state.student.address = currentAddress.display || state.student.address;
      }
    } catch (e) {
      toast('Location is set for this visit, but we could not save it to your profile.', true);
    }
    renderProfileCard();
    ensureFindReady(true);
  }

  function hasLeaflet() { return typeof window.L !== 'undefined' && typeof window.L.map === 'function'; }

  function useCurrentLocation(btn) {
    var status = $('locationStatus');
    if (!navigator.geolocation) {
      status.textContent = 'Geolocation is not supported by your browser. Set your spot on the map instead.';
      return;
    }
    btn.disabled = true;
    btn.classList.add('btn-loading');
    status.textContent = 'Getting a precise GPS fix… this can take a few seconds.';
    navigator.geolocation.getCurrentPosition(
      function (position) {
        btn.disabled = false;
        btn.classList.remove('btn-loading');
        var c = position.coords;
        if (!hasLeaflet()) {
          // No map library: trust the GPS fix instead of leaving the student stuck.
          applyLocation(c.latitude, c.longitude).then(function () { toast('Location updated'); });
          return;
        }
        status.textContent = 'GPS fix found. Confirm it on the map.';
        openMapModal({
          lat: c.latitude, lng: c.longitude, accuracy: c.accuracy,
          title: 'Confirm your exact location',
          sub: 'We centred the pin on your GPS fix. Drag it to your doorstep for the best match accuracy.'
        });
      },
      function (err) {
        btn.disabled = false;
        btn.classList.remove('btn-loading');
        var messages = {
          1: 'Location access denied. Allow location for this site in your browser settings, then try again.',
          2: 'Could not detect your location right now. Try again, or set it on the map.',
          3: 'Location request timed out. Try again, ideally outdoors or near a window.'
        };
        status.textContent = messages[err.code] || 'Could not get your location. Set it on the map instead.';
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  }

  var map = null, marker = null, accuracyCircle = null, pendingLat = null, pendingLng = null, geocodeTimer = null, geocodeSeq = 0;

  function pinIcon() {
    return L.divIcon({
      className: 'custom-pin',
      html: '<svg width="32" height="42" viewBox="0 0 34 44" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M17 0C7.6 0 0 7.6 0 17c0 12.7 17 27 17 27s17-14.3 17-27C34 7.6 26.4 0 17 0z" fill="' + BRAND + '"/>' +
        '<circle cx="17" cy="17" r="7" fill="#fff"/></svg>',
      iconSize: [32, 42],
      iconAnchor: [16, 42]
    });
  }

  function setAccuracyNote(accuracy) {
    var note = $('accuracyNote');
    if (!accuracy) { note.style.display = 'none'; return; }
    note.style.display = 'flex';
    var m = Math.round(accuracy);
    if (m <= 30) { note.className = 'accuracy-note good'; note.textContent = '✓ GPS accuracy: about ' + m + ' m. This pin should already be very close.'; }
    else if (m <= 100) { note.className = 'accuracy-note fair'; note.textContent = '⚠ GPS accuracy: about ' + m + ' m. Drag the pin to your exact spot for best results.'; }
    else { note.className = 'accuracy-note poor'; note.textContent = '⚠ GPS accuracy: about ' + m + ' m (weak signal). Please drag the pin precisely onto your location.'; }
  }
  function clearAccuracyCircle() {
    if (accuracyCircle && map) { map.removeLayer(accuracyCircle); }
    accuracyCircle = null;
    setAccuracyNote(null);
  }

  function openMapModal(opts) {
    if (!hasLeaflet()) {
      toast('The map could not load. Check your connection and refresh the page.', true);
      return;
    }
    opts = opts || {};
    $('mapModalBackdrop').classList.add('open');
    $('mapModalTitle').textContent = opts.title || 'Set your location';
    $('mapModalSub').textContent = opts.sub || 'Drag the pin, or click anywhere on the map, to place it exactly.';

    var startLat = opts.lat !== undefined ? opts.lat : (currentLat !== null ? currentLat : DEFAULT_CENTER[0]);
    var startLng = opts.lng !== undefined ? opts.lng : (currentLng !== null ? currentLng : DEFAULT_CENTER[1]);
    var zoom = (opts.lat !== undefined || currentLat !== null) ? 17 : 14;

    if (!map) {
      map = L.map('pickerMap').setView([startLat, startLng], zoom);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
      marker = L.marker([startLat, startLng], { draggable: true, icon: pinIcon() }).addTo(map);
      marker.on('dragend', function () {
        var p = marker.getLatLng();
        clearAccuracyCircle();
        previewLocation(p.lat, p.lng);
      });
      map.on('click', function (e) {
        marker.setLatLng(e.latlng);
        clearAccuracyCircle();
        previewLocation(e.latlng.lat, e.latlng.lng);
      });
    } else {
      map.setView([startLat, startLng], zoom);
      marker.setLatLng([startLat, startLng]);
      setTimeout(function () { map.invalidateSize(); }, 60);
    }

    clearAccuracyCircle();
    if (opts.accuracy) {
      accuracyCircle = L.circle([startLat, startLng], { radius: opts.accuracy, color: BRAND, fillColor: BRAND, fillOpacity: 0.12, weight: 1 }).addTo(map);
      setAccuracyNote(opts.accuracy);
    }
    previewLocation(startLat, startLng);
  }

  function previewLocation(lat, lng) {
    pendingLat = lat;
    pendingLng = lng;
    var box = $('mapPickedAddress');
    box.textContent = 'Looking up address…';
    clearTimeout(geocodeTimer);
    var seq = ++geocodeSeq;
    geocodeTimer = setTimeout(async function () {
      try {
        var addr = await reverseGeocode(lat, lng);
        if (seq === geocodeSeq) box.textContent = addr.area + ', ' + addr.district + ' — ' + addr.pincode;
      } catch (e) {
        if (seq === geocodeSeq) box.textContent = 'Pin placed. The address lookup failed, but the location is still usable.';
      }
    }, 450);
  }

  function closeMapModal() { $('mapModalBackdrop').classList.remove('open'); }

  async function doMapSearch() {
    var q = $('mapSearchInput').value.trim();
    if (!q || !map) return;
    try {
      var res = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&q=' + encodeURIComponent(q) + '&limit=1');
      var results = await res.json();
      if (!results.length) { toast('No matching place found.', true); return; }
      var lat = parseFloat(results[0].lat), lon = parseFloat(results[0].lon);
      map.setView([lat, lon], 16);
      marker.setLatLng([lat, lon]);
      clearAccuracyCircle();
      previewLocation(lat, lon);
    } catch (e) {
      toast('Search failed. Please try again.', true);
    }
  }

  $('openMapBtnEmpty').addEventListener('click', function () { openMapModal(); });
  $('openMapBtnSet').addEventListener('click', function () { openMapModal(); });
  $('useLocationBtn').addEventListener('click', function (e) { useCurrentLocation(e.currentTarget); });
  $('useLocationBtn2').addEventListener('click', function (e) { useCurrentLocation(e.currentTarget); });
  $('mapModalClose').addEventListener('click', closeMapModal);
  $('mapModalCancel').addEventListener('click', closeMapModal);
  $('mapSearchBtn').addEventListener('click', doMapSearch);
  $('mapSearchInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doMapSearch(); }
  });
  $('mapModalConfirm').addEventListener('click', async function () {
    if (pendingLat === null) return;
    var btn = $('mapModalConfirm');
    btn.disabled = true;
    btn.classList.add('btn-loading');
    await applyLocation(pendingLat, pendingLng);
    btn.disabled = false;
    btn.classList.remove('btn-loading');
    closeMapModal();
    toast('Location updated');
  });
  $('mapLocateBtn').addEventListener('click', function () {
    var btn = this;
    if (!navigator.geolocation) { toast('Geolocation is not supported by your browser.', true); return; }
    btn.textContent = '…';
    navigator.geolocation.getCurrentPosition(
      function (position) {
        btn.textContent = '📍';
        var c = position.coords;
        map.setView([c.latitude, c.longitude], 17);
        marker.setLatLng([c.latitude, c.longitude]);
        clearAccuracyCircle();
        accuracyCircle = L.circle([c.latitude, c.longitude], { radius: c.accuracy, color: BRAND, fillColor: BRAND, fillOpacity: 0.12, weight: 1 }).addTo(map);
        setAccuracyNote(c.accuracy);
        previewLocation(c.latitude, c.longitude);
      },
      function () {
        btn.textContent = '📍';
        toast('Could not fetch your location. Please drag the pin manually.', true);
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  });

  /* ---------------------------------------------------------
     Find tutors
     --------------------------------------------------------- */
  function renderChips() {
    var host = $('subjectChips');
    var mine = String((state.student && state.student.preferred_subjects) || '').split(',')
      .map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 4);
    var html = '';
    if (mine.length) {
      html += '<span class="sd-chips-label">Yours</span>' + mine.map(function (s) {
        return '<button type="button" class="sd-chip sd-chip-mine" data-act="chip" data-subject="' + esc(s) + '">' + esc(s) + '</button>';
      }).join('');
    }
    html += '<span class="sd-chips-label">Popular</span>' + SUBJECT_CHIPS.map(function (s) {
      return '<button type="button" class="sd-chip" data-act="chip" data-subject="' + esc(s) + '">' + esc(s) + '</button>';
    }).join('');
    host.innerHTML = html;
  }

  function applyClientFilters(items) {
    var list = items.filter(function (t) {
      if (ui.minRating && num(t.rating_avg) < ui.minRating) return false;
      if (ui.maxFee !== null && num(t.fee_per_hour) > ui.maxFee) return false;
      return true;
    });
    var sorters = {
      nearest: function (a, b) { return num(a.distance_km) - num(b.distance_km); },
      rating: function (a, b) { return (num(b.rating_avg) - num(a.rating_avg)) || (num(b.total_reviews) - num(a.total_reviews)); },
      feeLow: function (a, b) { return num(a.fee_per_hour) - num(b.fee_per_hour); },
      feeHigh: function (a, b) { return num(b.fee_per_hour) - num(a.fee_per_hour); },
      exp: function (a, b) { return num(b.experience_years) - num(a.experience_years); }
    };
    return list.sort(sorters[ui.sort] || sorters.nearest);
  }

  function teacherCard(t, withDistance) {
    var id = Number(t.id);
    var saved = state.favoriteIds.has(id);
    var rating = num(t.rating_avg);
    var fee = num(t.fee_per_hour);
    var badges = '';
    if (withDistance && t.distance_km !== undefined && t.distance_km !== null) {
      badges += '<span class="sd-badge">📍 ' + esc(num(t.distance_km).toFixed(1)) + ' km' + (t.city ? ' · ' + esc(t.city) : '') + '</span>';
    } else if (t.city) {
      badges += '<span class="sd-badge">📍 ' + esc(t.city) + '</span>';
    }
    badges += '<span class="sd-badge sd-badge-star">★ ' + (rating > 0 ? esc(rating.toFixed(1)) : 'New') + ' (' + num(t.total_reviews) + ')</span>';
    if (num(t.experience_years) > 0) badges += '<span class="sd-badge">🎓 ' + esc(plural(num(t.experience_years), 'yr', 'yrs')) + '</span>';
    if (withDistance) badges += '<span class="sd-badge sd-badge-ok">✓ Verified</span>';

    return '<article class="sd-teacher">' +
      '<button type="button" class="sd-heart' + (saved ? ' is-saved' : '') + '" data-act="fav" data-id="' + id + '" aria-pressed="' + saved + '" aria-label="' + (saved ? 'Remove ' : 'Save ') + esc(t.name) + (saved ? ' from saved teachers' : ' to saved teachers') + '">' + (saved ? '❤️' : '🤍') + '</button>' +
      '<button type="button" class="sd-teacher-top" data-act="profile" data-id="' + id + '">' +
        '<span class="sd-av">' + avatarInner(t.name, t.profile_photo) + '</span>' +
        '<span><h4>' + esc(t.name) + '</h4><span class="sd-muted">' + esc(t.subjects || 'Subjects not listed') + (t.grades ? ' · ' + esc(t.grades) : '') + '</span></span>' +
      '</button>' +
      (t.qualification ? '<p class="sd-qual">' + esc(t.qualification) + '</p>' : '') +
      '<div class="sd-badges">' + badges + '</div>' +
      '<div class="sd-teacher-foot">' +
        '<div class="sd-fee">' + (fee > 0 ? esc(fmtMoney(fee)) + '<span> / hour</span>' : '<span>Fee not listed</span>') + '</div>' +
        '<div class="sd-teacher-actions">' +
          '<button type="button" class="btn btn-outline btn-sm" data-act="profile" data-id="' + id + '">Profile</button>' +
          '<button type="button" class="btn btn-primary btn-sm" data-act="book" data-id="' + id + '">Book</button>' +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function renderResults() {
    var host = $('resultsArea');
    var s = ui.search;
    $('resultsToolbar').hidden = !(s.ran && !s.error && s.items.length);
    $('loadMoreWrap').hidden = !(s.ran && !s.error && s.page < s.totalPages);

    if (s.loading && !s.items.length) {
      host.innerHTML = '<div class="sd-cards">' + skeletons(3) + '</div>';
      return;
    }
    if (s.error) { host.innerHTML = errorState(s.error, 'retry-search'); return; }
    if (!s.ran) {
      host.innerHTML = emptyState('🧭', 'Set your location, then search', 'We will list verified teachers close to you, nearest first.');
      return;
    }
    if (!s.items.length) {
      host.innerHTML = emptyState('🔭', 'No teachers within ' + s.params.radius + ' km',
        s.params.subject ? 'Try a different subject or a bigger radius.' : 'Try a bigger radius.');
      return;
    }
    var shown = applyClientFilters(s.items);
    $('resultsCount').textContent = 'Showing ' + shown.length + ' of ' + s.total + ' teacher' + (s.total === 1 ? '' : 's') + ' within ' + s.params.radius + ' km' +
      (shown.length < s.items.length ? ' (' + (s.items.length - shown.length) + ' hidden by filters)' : '');
    host.innerHTML = shown.length
      ? '<div class="sd-cards">' + shown.map(function (t) { return teacherCard(t, true); }).join('') + '</div>'
      : emptyState('🪄', 'Filters hid every teacher', 'Loosen the rating or fee filter to see them again.');
  }

  async function runSearch(append) {
    var s = ui.search;
    if (currentLat === null || currentLng === null) {
      s.ran = false; s.items = []; s.error = null;
      renderResults();
      toast('Please set your location first.', true);
      return;
    }
    if (s.loading) return;
    var params = append && s.params ? s.params : {
      subject: $('subjectFilter').value.trim(),
      radius: ui.radius,
      lat: currentLat,
      lng: currentLng
    };
    var page = append ? s.page + 1 : 1;
    s.loading = true;
    s.error = null;
    if (!append) { s.items = []; s.ran = true; s.params = params; }
    renderResults();
    $('searchBtn').disabled = true;
    $('loadMoreBtn').disabled = true;

    try {
      var url = '/api/teachers/nearby?lat=' + encodeURIComponent(params.lat) + '&lng=' + encodeURIComponent(params.lng) +
        '&radius=' + encodeURIComponent(params.radius) + '&page=' + page;
      if (params.subject) url += '&subject=' + encodeURIComponent(params.subject);
      var data = await apiRequest(url);
      var got = Array.isArray(data && data.teachers) ? data.teachers : [];
      got.forEach(function (t) { teacherCache[t.id] = t; });
      s.items = append ? s.items.concat(got) : got;
      s.page = page;
      s.total = num(data && data.total) || s.items.length;
      s.totalPages = num(data && data.total_pages) || 1;
    } catch (err) {
      s.error = err.message || 'Could not search for teachers.';
    } finally {
      s.loading = false;
      $('searchBtn').disabled = false;
      $('loadMoreBtn').disabled = false;
      renderResults();
    }
  }

  // Run a first search automatically once the location is known, so the page is never empty.
  function ensureFindReady(force) {
    if (ui.view !== 'find' && !force) return;
    if (currentLat !== null && (!ui.search.ran || force) && !ui.search.loading && ui.view === 'find') runSearch(false);
  }

  /* ---------------------------------------------------------
     Booking modal
     --------------------------------------------------------- */
  var booking = { teacherId: null, type: 'demo', days: new Set(), slot: null, slotSeq: 0 };

  function slotMessage(grid, text) {
    grid.innerHTML = '';
    var note = document.createElement('div');
    note.className = 'slot-note';
    note.textContent = text;
    grid.appendChild(note);
  }

  function renderSlots(slots) {
    var grid = $('slotGrid');
    grid.innerHTML = '';
    if (!slots.some(function (s) { return s.available; })) {
      slotMessage(grid, 'No free times on this date. Please pick another date.');
      return;
    }
    slots.forEach(function (s) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot-btn';
      btn.dataset.slot = s.slot;
      btn.textContent = s.slot;
      btn.disabled = !s.available;
      btn.title = s.available ? '' : 'Not available';
      btn.addEventListener('click', function () {
        grid.querySelectorAll('.slot-btn').forEach(function (b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
        booking.slot = s.slot;
        renderBookingSummary();
      });
      grid.appendChild(btn);
    });
  }

  async function loadSlots() {
    var grid = $('slotGrid');
    var date = $('bookingDate').value;
    booking.slot = null;
    renderBookingSummary();
    if (!booking.teacherId || !DATE_RE.test(date)) { grid.innerHTML = ''; return; }
    var seq = ++booking.slotSeq; // ignore stale answers if the date changes quickly
    slotMessage(grid, 'Loading available times…');
    try {
      var data = await apiRequest('/api/bookings/availability/' + encodeURIComponent(booking.teacherId) + '?date=' + encodeURIComponent(date));
      if (seq !== booking.slotSeq) return;
      renderSlots((data && data.slots) || []);
    } catch (err) {
      if (seq !== booking.slotSeq) return;
      slotMessage(grid, err.message || 'Could not load available times.');
    }
  }

  function renderDays() {
    $('daysRow').innerHTML = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (d) {
      var on = booking.days.has(d);
      return '<button type="button" class="sd-day-btn' + (on ? ' is-on' : '') + '" data-day="' + d + '" aria-pressed="' + on + '">' + d + '</button>';
    }).join('');
  }

  function setBookingType(type) {
    booking.type = type;
    document.querySelectorAll('#bookingTypeSeg button').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.type === type));
    });
    $('daysField').hidden = type !== 'recurring';
    $('bookingTypeHint').textContent = type === 'recurring'
      ? 'A regular weekly class. Pick the days you want.'
      : 'A single trial class so you can meet the teacher.';
    $('bookingTitle').textContent = type === 'recurring' ? 'Book weekly classes' : 'Book a demo class';
    $('bookingModalConfirm').textContent = 'Send request';
    if (type === 'recurring' && booking.days.size === 0) {
      var date = $('bookingDate').value;
      if (DATE_RE.test(date)) booking.days.add(weekdayOf(date));
    }
    renderDays();
    renderBookingSummary();
  }

  function renderBookingSummary() {
    var box = $('bookingSummary');
    var date = $('bookingDate').value;
    if (!booking.slot || !DATE_RE.test(date)) { box.hidden = true; return; }
    var days = booking.type === 'recurring'
      ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].filter(function (d) { return booking.days.has(d); }).join(', ')
      : '';
    box.hidden = false;
    box.textContent = booking.type === 'recurring'
      ? 'Weekly on ' + (days || '…') + ' at ' + booking.slot + ', starting ' + fmtDate(date) + ' for 8 weeks.'
      : 'One demo class on ' + fmtDate(date, true) + ' at ' + booking.slot + '.';
  }

  function openBookingModal(teacherId) {
    var t = teacherCache[teacherId];
    if (!t) { toast('Could not find that teacher. Please search again.', true); return; }
    booking.teacherId = Number(teacherId);
    booking.slot = null;
    booking.days = new Set();
    $('bookingAvatar').innerHTML = avatarInner(t.name, t.profile_photo);
    $('bookingTeacherName').textContent = t.name;
    $('bookingTeacherMeta').textContent = (t.subjects || 'Subjects not listed') + (num(t.fee_per_hour) > 0 ? ' · ' + fmtMoney(t.fee_per_hour) + '/hr' : '');
    var chosen = $('subjectFilter').value.trim();
    $('bookingSubject').value = chosen || (t.subjects ? String(t.subjects).split(',')[0].trim() : '');

    var dateInput = $('bookingDate');
    var today = todayIST();
    dateInput.min = today;
    dateInput.max = addDays(today, MAX_DAYS_AHEAD);
    dateInput.value = today;

    $('bookingMsgBox').className = 'msg-box';
    $('bookingMsgBox').textContent = '';
    setBookingType('demo');
    $('bookingModalBackdrop').classList.add('open');
    loadSlots();
  }

  function closeBookingModal() { $('bookingModalBackdrop').classList.remove('open'); }

  $('bookingModalClose').addEventListener('click', closeBookingModal);
  $('bookingModalCancel').addEventListener('click', closeBookingModal);
  $('bookingDate').addEventListener('change', loadSlots);
  $('bookingTypeSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-type]');
    if (b) setBookingType(b.dataset.type);
  });
  $('daysRow').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-day]');
    if (!b) return;
    var d = b.dataset.day;
    if (booking.days.has(d)) booking.days.delete(d); else booking.days.add(d);
    renderDays();
    renderBookingSummary();
  });

  $('bookingModalConfirm').addEventListener('click', async function () {
    var msgBox = $('bookingMsgBox');
    var date = $('bookingDate').value;
    var subject = $('bookingSubject').value.trim();
    var btn = $('bookingModalConfirm');

    function fail(text) { msgBox.className = 'msg-box error'; msgBox.textContent = text; }
    if (!subject) return fail('Please enter a subject.');
    if (!DATE_RE.test(date)) return fail('Please choose a start date.');
    if (!booking.slot) return fail('Please choose a time slot.');
    if (booking.type === 'recurring' && booking.days.size === 0) return fail('Pick at least one day of the week.');

    var payload = {
      teacher_id: booking.teacherId,
      type: booking.type,
      subject: subject,
      booking_date: date,
      booking_time: booking.slot
    };
    if (booking.type === 'recurring') {
      payload.days_per_week = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].filter(function (d) { return booking.days.has(d); }).join(',');
    }

    btn.disabled = true;
    btn.classList.add('btn-loading');
    try {
      await apiRequest('/api/bookings', 'POST', payload);
      closeBookingModal();
      toast('Request sent. The teacher will confirm shortly.');
      go('classes');
      loadBookings();
    } catch (err) {
      fail(err.message);
      loadSlots(); // if someone else just took the slot, refresh the grid
    } finally {
      btn.disabled = false;
      btn.classList.remove('btn-loading');
    }
  });

  /* ---------------------------------------------------------
     Class details + cancel
     --------------------------------------------------------- */
  async function openDetails(id) {
    var b = findBooking(id);
    if (!b) return;
    $('detailsTitle').textContent = (b.subject || 'Class') + ' with ' + (b.teacher_name || 'your teacher');
    $('detailsSub').textContent = typeLabel(b) + ' · ' + fmtDate(b.booking_date, true) + ' · ' + (b.booking_time || '');
    var pay = payInfo(b);
    var head =
      '<div class="sd-tags">' + statusTag(bookingStatus(b)) + (pay ? tag(pay.label, pay.tone) : '') + '</div>' +
      '<dl class="sd-dl">' +
        '<div><dt>Fee</dt><dd>' + esc(bookingStatus(b) === 'requested' ? 'Set by the teacher when they accept' : (num(b.fee) > 0 ? fmtMoney(b.fee) : 'No charge')) + '</dd></div>' +
        '<div><dt>Requested on</dt><dd>' + esc(b.created_at ? new Date(b.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—') + '</dd></div>' +
      '</dl>' +
      '<h4 class="sd-subhead">Sessions</h4>';
    $('detailsBody').innerHTML = head + '<div id="detailsSessions">' + skeletons(1) + '</div>';
    $('detailsModalBackdrop').classList.add('open');

    var host = $('detailsSessions');
    if (bookingStatus(b) === 'requested' || bookingStatus(b) === 'declined') {
      host.innerHTML = '<p class="sd-muted">Sessions are created once the teacher accepts this request.</p>';
      return;
    }
    try {
      var rows = await apiRequest('/api/bookings/' + encodeURIComponent(b.id) + '/sessions');
      if (!Array.isArray(rows) || !rows.length) { host.innerHTML = '<p class="sd-muted">No sessions to show.</p>'; return; }
      host.innerHTML = '<ul class="sd-sessions">' + rows.map(function (s) {
        var tone = s.status === 'completed' ? 'ok' : s.status === 'scheduled' ? 'info' : s.status === 'missed' ? 'bad' : 'muted';
        return '<li><span>' + esc(fmtDate(s.session_date)) + ' · ' + esc(s.session_time || b.booking_time || '') + '</span>' + tag(s.status, tone) + '</li>';
      }).join('') + '</ul>';
    } catch (e) {
      host.innerHTML = '<p class="sd-muted">' + esc(e.message || 'Could not load sessions.') + '</p>';
    }
  }

  async function cancelBooking(id) {
    var b = findBooking(id);
    if (!b) return;
    var paid = b.payment_status === 'paid' && num(b.fee) > 0;
    var ok = await ask({
      title: 'Cancel this class?',
      message: 'Your ' + (b.subject || 'class') + ' with ' + (b.teacher_name || 'the teacher') + ' will be cancelled.' +
        (paid ? ' You have already paid. A refund is started automatically only if you cancel early enough; we will tell you the result right after.' : ' The teacher will be notified.'),
      okText: 'Yes, cancel class',
      cancelText: 'Keep class'
    });
    if (!ok) return;
    try {
      var res = await apiRequest('/api/bookings/' + encodeURIComponent(b.id) + '/cancel', 'PUT');
      toast((res && res.message) || 'Class cancelled.');
      loadBookings();
    } catch (err) {
      toast(err.message, true);
      loadBookings();
    }
  }

  /* ---------------------------------------------------------
     Payments (Razorpay)
     --------------------------------------------------------- */
  async function waitForPayment(bookingId) {
    confirmingPayments.add(bookingId);
    renderAll();
    for (var i = 0; i < 10; i++) {
      await new Promise(function (r) { setTimeout(r, 3000); });
      try {
        var r = await apiRequest('/api/payments/booking/' + encodeURIComponent(bookingId));
        if (r && r.payment_status === 'paid') {
          confirmingPayments.delete(bookingId);
          toast('Payment confirmed. Thank you!');
          loadBookings();
          return;
        }
        if (r && r.payment_status === 'refunded') {
          confirmingPayments.delete(bookingId);
          toast('Your payment has been refunded.');
          loadBookings();
          return;
        }
      } catch (e) { /* keep trying */ }
    }
    // Still unconfirmed: keep the button disabled until the page is reloaded so nobody pays twice.
    toast('Still confirming your payment. Please check again in a minute. You will not be charged twice.');
  }

  async function payNow(bookingId) {
    bookingId = Number(bookingId);
    if (confirmingPayments.has(bookingId)) return;
    if (typeof window.Razorpay !== 'function') {
      toast('The payment window could not load. Check your connection and refresh the page.', true);
      return;
    }
    try {
      var order = await apiRequest('/api/payments/create-order', 'POST', { booking_id: bookingId });
      var rzp = new window.Razorpay({
        key: order.key_id,
        amount: order.amount,
        currency: order.currency,
        order_id: order.order_id,
        name: 'TutorLink',
        description: 'Class payment',
        handler: async function (response) {
          try {
            var result = await apiRequest('/api/payments/verify', 'POST', {
              booking_id: bookingId,
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature
            });
            if (result && result.status === 'pending') {
              toast(result.message || 'Payment received. Confirming…');
              waitForPayment(bookingId);
            } else if (result && result.status === 'refund_initiated') {
              toast(result.message || 'Your payment is being refunded.', true);
              loadBookings();
            } else {
              toast('Payment successful!');
              loadBookings();
            }
          } catch (err) {
            toast(err.message, true);
          }
        },
        prefill: { name: USER.name, email: (state.me && state.me.email) || USER.email || '' },
        theme: { color: BRAND }
      });
      rzp.on('payment.failed', function () { toast('Payment failed or was cancelled.', true); });
      rzp.open();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ---------------------------------------------------------
     Reviews
     --------------------------------------------------------- */
  var review = { bookingId: null, reviewId: null, stars: 0 };

  function buildStars() {
    var grid = $('starGrid');
    grid.innerHTML = [1, 2, 3, 4, 5].map(function (n) {
      return '<button type="button" role="radio" class="sd-star' + (n <= review.stars ? ' is-on' : '') + '" data-star="' + n +
        '" aria-checked="' + (n === review.stars) + '" aria-label="' + n + ' star' + (n === 1 ? '' : 's') + '">★</button>';
    }).join('');
  }

  function openReviewModal(bookingId, editing) {
    var b = findBooking(bookingId);
    if (!b) return;
    review.bookingId = b.id;
    review.reviewId = editing ? b.review_id : null;
    review.stars = editing ? num(b.review_rating) : 0;
    $('reviewTitle').textContent = editing ? 'Edit your review' : 'Rate your class';
    $('reviewTeacherLabel').textContent = editing
      ? 'Editing your review of ' + (b.teacher_name || 'your teacher')
      : 'How was your session with ' + (b.teacher_name || 'your teacher') + '?';
    $('reviewComment').value = editing ? (b.review_comment || '') : '';
    $('reviewModalConfirm').textContent = editing ? 'Save changes' : 'Submit review';
    $('reviewMsgBox').className = 'msg-box';
    $('reviewMsgBox').textContent = '';
    buildStars();
    $('reviewModalBackdrop').classList.add('open');
  }
  function closeReviewModal() { $('reviewModalBackdrop').classList.remove('open'); }

  $('starGrid').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-star]');
    if (!b) return;
    review.stars = parseInt(b.dataset.star, 10);
    buildStars();
  });
  $('reviewModalClose').addEventListener('click', closeReviewModal);
  $('reviewModalCancel').addEventListener('click', closeReviewModal);
  $('reviewModalConfirm').addEventListener('click', async function () {
    var msgBox = $('reviewMsgBox');
    var btn = $('reviewModalConfirm');
    if (!review.stars) {
      msgBox.className = 'msg-box error';
      msgBox.textContent = 'Please pick a star rating.';
      return;
    }
    var comment = $('reviewComment').value.trim();
    btn.disabled = true;
    btn.classList.add('btn-loading');
    try {
      if (review.reviewId) {
        await apiRequest('/api/reviews/' + encodeURIComponent(review.reviewId), 'PUT', { rating: review.stars, comment: comment });
      } else {
        await apiRequest('/api/reviews', 'POST', { booking_id: review.bookingId, rating: review.stars, comment: comment });
      }
      closeReviewModal();
      toast(review.reviewId ? 'Review updated!' : 'Thanks for the review!');
      loadBookings();
    } catch (err) {
      msgBox.className = 'msg-box error';
      msgBox.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.classList.remove('btn-loading');
    }
  });

  async function deleteReview(bookingId) {
    var b = findBooking(bookingId);
    if (!b || !b.review_id) return;
    var ok = await ask({ title: 'Delete this review?', message: 'This cannot be undone.', okText: 'Delete review', cancelText: 'Keep it' });
    if (!ok) return;
    try {
      await apiRequest('/api/reviews/' + encodeURIComponent(b.review_id), 'DELETE');
      toast('Review deleted.');
      loadBookings();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ---------------------------------------------------------
     Quick actions (Ctrl/Cmd + K)
     --------------------------------------------------------- */
  var cmdItems = [
    { label: 'Overview', hint: 'Go to', run: function () { go('overview'); } },
    { label: 'Find tutors', hint: 'Go to', run: function () { go('find'); } },
    { label: 'My classes', hint: 'Go to', run: function () { go('classes'); } },
    { label: 'Courses', hint: 'Go to', run: function () { go('courses'); } },
    { label: 'My tuition (attendance, homework, marks)', hint: 'Open', run: function () { window.location.href = 'student-tuition.html'; } },
    { label: 'Payments', hint: 'Go to', run: function () { go('payments'); } },
    { label: 'Saved teachers', hint: 'Go to', run: function () { go('saved'); } },
    { label: 'Safety & reports', hint: 'Go to', run: function () { go('support'); } },
    { label: 'Set location on the map', hint: 'Action', run: function () { go('find'); openMapModal(); } },
    { label: 'Use my current location', hint: 'Action', run: function () { go('find'); useCurrentLocation($('useLocationBtn')); } },
    { label: 'Edit profile', hint: 'Open', run: function () { window.location.href = 'student-complete-profile.html'; } },
    { label: 'Account settings', hint: 'Open', run: function () { window.location.href = 'account-settings.html'; } },
    { label: 'Log out', hint: 'Action', run: function () { $('logoutBtn').click(); } }
  ];
  var cmdShown = [];
  var cmdIndex = 0;

  function renderCmd() {
    var q = $('cmdInput').value.trim().toLowerCase();
    cmdShown = cmdItems.filter(function (c) { return !q || c.label.toLowerCase().indexOf(q) !== -1; });
    if (cmdIndex >= cmdShown.length) cmdIndex = Math.max(0, cmdShown.length - 1);
    var list = $('cmdList');
    list.innerHTML = cmdShown.length ? cmdShown.map(function (c, i) {
      return '<li role="option" id="cmd-opt-' + i + '" class="' + (i === cmdIndex ? 'is-active' : '') + '" aria-selected="' + (i === cmdIndex) + '" data-i="' + i + '">' +
        '<span>' + esc(c.label) + '</span><em>' + esc(c.hint) + '</em></li>';
    }).join('') : '<li class="sd-cmd-none">No matches</li>';
    if (cmdShown.length) $('cmdInput').setAttribute('aria-activedescendant', 'cmd-opt-' + cmdIndex);
    else $('cmdInput').removeAttribute('aria-activedescendant');
    var active = list.querySelector('.is-active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }
  function openCmd() {
    $('cmdInput').value = '';
    cmdIndex = 0;
    renderCmd();
    $('cmdBackdrop').classList.add('open');
    focusSoon($('cmdInput'));
  }
  function closeCmd() { $('cmdBackdrop').classList.remove('open'); $('cmdInput').blur(); }
  function runCmd(i) {
    var item = cmdShown[i];
    if (!item) return;
    closeCmd();
    item.run();
  }
  $('cmdBtn').addEventListener('click', openCmd);
  $('cmdInput').addEventListener('input', function () { cmdIndex = 0; renderCmd(); });
  $('cmdInput').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (cmdShown.length) { cmdIndex = (cmdIndex + 1) % cmdShown.length; renderCmd(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (cmdShown.length) { cmdIndex = (cmdIndex - 1 + cmdShown.length) % cmdShown.length; renderCmd(); } }
    else if (e.key === 'Enter') { e.preventDefault(); runCmd(cmdIndex); }
  });
  $('cmdList').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-i]');
    if (li) runCmd(Number(li.dataset.i));
  });
  $('cmdBackdrop').addEventListener('click', function (e) { if (e.target === $('cmdBackdrop')) closeCmd(); });

  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
      e.preventDefault();
      if ($('cmdBackdrop').classList.contains('open')) closeCmd(); else openCmd();
      return;
    }
    if (e.key === 'Escape') {
      if ($('cmdBackdrop').classList.contains('open')) { closeCmd(); return; }
      if ($('confirmBackdrop').classList.contains('open')) { closeConfirm(false); return; }
      var close = document.querySelector('.modal-backdrop.open .modal-close');
      if (close) close.click();
      return;
    }
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      go('find');
      focusSoon($('subjectFilter'));
    }
  });

  /* ---------------------------------------------------------
     Click handling (one listener for every data-act button)
     --------------------------------------------------------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.dataset.act;
    var id = el.dataset.id;
    switch (act) {
      case 'pay': payNow(id); break;
      case 'chat': {
        var cb = findBooking(id);
        if (cb) openChatModal(cb.id, cb.teacher_name || 'your teacher');
        break;
      }
      case 'report': {
        var rb = findBooking(id);
        if (rb) openReportModal(rb.teacher_user_id, rb.teacher_name || 'your teacher', rb.id);
        break;
      }
      case 'cancel': cancelBooking(id); break;
      case 'details': openDetails(id); break;
      case 'review': openReviewModal(id, false); break;
      case 'edit-review': openReviewModal(id, true); break;
      case 'delete-review': deleteReview(id); break;
      case 'open-course': openCourse(id); break;
      case 'close-course': $('courseModalBackdrop').classList.remove('open'); break;
      case 'fav': toggleFavorite(id, el); break;
      case 'book': openBookingModal(Number(id)); break;
      case 'profile': window.location.href = 'teacher-profile-view.html?id=' + encodeURIComponent(Number(id)); break;
      case 'chip':
        $('subjectFilter').value = el.dataset.subject || '';
        runSearch(false);
        break;
      case 'goto-location':
        go('find');
        break;
      case 'resend-verify': resendVerification(el); break;
      case 'reload-bookings': state.loaded.bookings = false; renderAll(); loadBookings(); break;
      case 'reload-courses': state.loaded.courses = false; renderCourses(); loadCourses(); break;
      case 'reload-saved': state.loaded.saved = false; renderSaved(); loadSaved(); break;
      case 'reload-reports': state.loaded.reports = false; renderReports(); loadReports(); break;
      case 'retry-search': runSearch(false); break;
      default: break;
    }
  });

  async function resendVerification(btn) {
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = 'Sending…';
    try {
      await apiRequest('/api/auth/resend-verification', 'POST');
      btn.textContent = 'Sent. Check your inbox';
    } catch (err) {
      btn.textContent = old;
      btn.disabled = false;
      toast(err.message || 'Could not send the email. Try again.', true);
    }
  }

  /* ---------------------------------------------------------
     Wiring for static controls
     --------------------------------------------------------- */
  $('searchForm').addEventListener('submit', function (e) { e.preventDefault(); runSearch(false); });
  $('radiusSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-radius]');
    if (!b) return;
    ui.radius = Number(b.dataset.radius);
    document.querySelectorAll('#radiusSeg button').forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); });
    if (ui.search.ran) runSearch(false);
  });
  $('sortSelect').addEventListener('change', function (e) { ui.sort = e.target.value; renderResults(); });
  $('ratingSelect').addEventListener('change', function (e) { ui.minRating = Number(e.target.value) || 0; renderResults(); });
  $('maxFeeInput').addEventListener('input', function (e) {
    var v = e.target.value.trim();
    ui.maxFee = v === '' || !isFinite(Number(v)) ? null : Math.max(0, Number(v));
    renderResults();
  });
  $('loadMoreBtn').addEventListener('click', function () { runSearch(true); });

  $('classTabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-filter]');
    if (!b) return;
    ui.classFilter = b.dataset.filter;
    renderClasses();
  });
  $('classSearch').addEventListener('input', function (e) { ui.classQuery = e.target.value; renderClasses(); });
  $('exportBtn').addEventListener('click', exportPayments);
  $('detailsModalClose').addEventListener('click', function () { $('detailsModalBackdrop').classList.remove('open'); });
  $('courseModalClose').addEventListener('click', function () { $('courseModalBackdrop').classList.remove('open'); });

  /* ---------------------------------------------------------
     Start
     --------------------------------------------------------- */
  renderChips();
  renderLocation();
  renderResults();
  renderSaved();
  renderCourses();
  renderReports();
  applyRoute(false);

  loadMe();
  loadStudent();
  loadBookings();
  loadCourses();
  loadSaved();
  loadReports();
})();