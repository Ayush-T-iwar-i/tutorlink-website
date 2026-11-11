/* =========================================================
   TutorLink - teacher "My students" page
   Place at: frontend/js/teacher-students.js
   Needs: js/api.js, js/ui.js (loaded before this file)
   Talks to: /api/my-students/*  and  PUT /api/enrollments/:id/status
   ========================================================= */
(function () {
  'use strict';

  var session = requireLogin('teacher');
  if (!session) return;
  var USER = session.user;

  /* ---------------- Small helpers ---------------- */
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
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' '); }
  function dayText(iso, opts) {
    if (!iso) return '';
    var dt = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(dt.getTime())) return String(iso);
    var o = opts || { day: 'numeric', month: 'short', year: 'numeric' };
    o.timeZone = 'UTC';   // A calendar day must not shift with the browser time zone.
    return dt.toLocaleDateString('en-IN', o);
  }
  function shiftDate(iso, n) {
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function istToday() {
    var p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    var o = {};
    p.forEach(function (x) { o[x.type] = x.value; });
    return o.year + '-' + o.month + '-' + o.day;
  }
  var TODAY = istToday();
  function relDay(iso) {
    var d = String(iso || '').slice(0, 10);
    if (d === TODAY) return 'Today';
    if (d === shiftDate(TODAY, 1)) return 'Tomorrow';
    if (d === shiftDate(TODAY, -1)) return 'Yesterday';
    return '';
  }
  function classDate(iso) {
    var rel = relDay(iso);
    var base = dayText(iso, { weekday: 'short', day: 'numeric', month: 'short' });
    return rel ? rel + ' · ' + base : base;
  }
  function monthLabel(ym) {
    var dt = new Date(ym + '-01T00:00:00Z');
    return isNaN(dt.getTime()) ? ym : dt.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  function shiftMonth(ym, n) {
    var y = Number(ym.slice(0, 4));
    var m = Number(ym.slice(5, 7)) - 1 + n;
    y += Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    return y + '-' + String(m + 1).padStart(2, '0');
  }
  // Server timestamps (TIMESTAMP columns) arrive as UTC; show them in Indian time.
  function stamp(ts, withTime) {
    if (!ts) return '';
    var s = String(ts);
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    var dt = new Date(s);
    if (isNaN(dt.getTime())) return '';
    var o = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' };
    if (withTime) { o.hour = 'numeric'; o.minute = '2-digit'; }
    return dt.toLocaleString('en-IN', o);
  }
  function monthsBetween(isoStart, isoEnd) {
    var a = String(isoStart).slice(0, 7), b = String(isoEnd).slice(0, 7);
    return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
  }

  var toastTimer = null;
  function toast(message, isError) {
    var t = $('toast');
    t.textContent = message;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 3500);
  }
  function emptyState(text) { return el('div', 'pg-empty pg-empty-sm', text); }
  function setBusy(btn, on) {
    btn.disabled = on;
    btn.classList.toggle('btn-loading', on);
  }
  function btn(label, cls, onClick, ariaLabel) {
    var b = el('button', 'btn btn-sm ' + (cls || 'btn-outline'), label);
    b.type = 'button';
    if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function tag(label, tone) { return el('span', 'pg-chip-tag' + (tone ? ' is-' + tone : ''), label); }
  function bar(pct, label) {
    var b = el('div', 'pg-progress-bar');
    b.setAttribute('role', 'progressbar');
    b.setAttribute('aria-valuemin', '0');
    b.setAttribute('aria-valuemax', '100');
    b.setAttribute('aria-valuenow', String(Math.round(pct)));
    if (label) b.setAttribute('aria-label', label);
    var i = el('i');
    i.style.width = Math.max(0, Math.min(100, pct)) + '%';
    b.appendChild(i);
    return b;
  }
  // Photo with a fallback to initials if the image cannot be loaded.
  function fillAvatar(node, photo, name) {
    if (!photo) { node.textContent = initials(name); return; }
    var img = document.createElement('img');
    img.alt = '';
    img.addEventListener('error', function () { img.remove(); node.textContent = initials(name); });
    img.src = photoUrl(photo);
    node.appendChild(img);
  }
  function errMsg(err) { return (err && err.message) || 'Something went wrong. Please try again.'; }

  function api(path, method, body) { return apiRequest('/api/my-students' + path, method || 'GET', body || null); }

  /* ---------------- Header ---------------- */
  $('welcomeText').textContent = USER.name || '';
  $('avatarInitials').textContent = initials(USER.name);
  $('logoutBtn').addEventListener('click', function () {
    clearSession();
    window.location.href = 'login.html';
  });
  if (typeof initNotificationBell === 'function') initNotificationBell();
  apiRequest('/api/auth/me').then(function (me) {
    if (me && me.user && me.user.profile_photo) {
      var av = $('avatarInitials');
      clear(av);
      var img = document.createElement('img');
      img.alt = '';
      img.src = photoUrl(me.user.profile_photo);
      av.appendChild(img);
    }
  }).catch(function () { /* the initials stay */ });

  /* ---------------- Modal + form dialog ---------------- */
  var openModals = [];
  function focusSoon(node) {
    var tries = 0;
    (function attempt() {
      node.focus();
      if (document.activeElement !== node && tries++ < 12) setTimeout(attempt, 30);
    })();
  }
  function openModal(backdrop, focusNode, opener) {
    backdrop.classList.add('open');
    document.body.classList.add('pg-modal-open');
    openModals.push({ backdrop: backdrop, opener: opener || document.activeElement });
    if (focusNode) focusSoon(focusNode);
  }
  function closeModal(backdrop) {
    var idx = -1;
    openModals.forEach(function (m, i) { if (m.backdrop === backdrop) idx = i; });
    backdrop.classList.remove('open');
    if (idx === -1) return;
    var m = openModals.splice(idx, 1)[0];
    if (!openModals.length) document.body.classList.remove('pg-modal-open');
    if (m.opener && document.contains(m.opener) && !m.opener.disabled) m.opener.focus();
  }
  document.addEventListener('keydown', function (e) {
    if (!openModals.length) return;
    var top = openModals[openModals.length - 1];
    if (e.key === 'Escape') { e.preventDefault(); closeModal(top.backdrop); return; }
    if (e.key !== 'Tab') return;
    var nodes = Array.prototype.filter.call(
      top.backdrop.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'),
      function (n) { return n.offsetParent !== null; }
    );
    if (!nodes.length) return;
    var first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  var formBackdrop = $('formBackdrop');
  var formState = null;
  function openForm(cfg) {
    formState = cfg;
    $('formTitle').textContent = cfg.title;
    $('formSub').textContent = cfg.sub || '';
    $('formSubmit').textContent = cfg.submitLabel || 'Save';
    var msg = $('formMsg');
    msg.className = 'msg-box';
    msg.textContent = '';
    var host = $('formFields');
    clear(host);
    cfg.fields.forEach(function (f) {
      var wrap = el('div', 'pg-field');
      wrap.dataset.name = f.name;
      var label = el('label', '', f.label);
      label.htmlFor = 'f-' + f.name;
      wrap.appendChild(label);
      var input;
      if (f.type === 'textarea') {
        input = el('textarea');
        input.rows = f.rows || 3;
      } else if (f.type === 'select') {
        input = el('select');
        f.options.forEach(function (o) {
          var op = el('option', '', o.label);
          op.value = o.value;
          input.appendChild(op);
        });
      } else {
        input = el('input');
        input.type = f.type || 'text';
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        if (f.step !== undefined) input.step = f.step;
        if (f.type === 'number') input.setAttribute('inputmode', 'decimal');
      }
      input.id = 'f-' + f.name;
      input.name = f.name;
      if (f.maxlength) input.maxLength = f.maxlength;
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.value !== undefined && f.value !== null) input.value = f.value;
      if (f.hint) {
        var hint = el('span', 'pg-hint', f.hint);
        hint.id = 'f-' + f.name + '-hint';
        input.setAttribute('aria-describedby', hint.id);
        wrap.appendChild(input);
        wrap.appendChild(hint);
      } else {
        wrap.appendChild(input);
      }
      host.appendChild(wrap);
    });
    syncShowIf();
    openModal(formBackdrop, host.querySelector('input, select, textarea'), cfg.opener);
  }
  function formValues() {
    var v = {};
    formState.fields.forEach(function (f) { v[f.name] = $('f-' + f.name).value; });
    return v;
  }
  function syncShowIf() {
    if (!formState) return;
    var v = formValues();
    formState.fields.forEach(function (f) {
      var wrap = $('formFields').querySelector('[data-name="' + f.name + '"]');
      wrap.hidden = !!(f.showIf && !f.showIf(v));
    });
  }
  $('formFields').addEventListener('input', syncShowIf);
  $('formFields').addEventListener('change', syncShowIf);
  $('formClose').addEventListener('click', function () { closeModal(formBackdrop); });
  $('formCancel').addEventListener('click', function () { closeModal(formBackdrop); });
  formBackdrop.addEventListener('mousedown', function (e) { if (e.target === formBackdrop) closeModal(formBackdrop); });
  $('formEl').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!formState) return;
    var msg = $('formMsg');
    var values = formValues();
    var out = {};
    for (var i = 0; i < formState.fields.length; i++) {
      var f = formState.fields[i];
      if (f.showIf && !f.showIf(values)) continue;
      var val = String(values[f.name]).trim();
      if (f.required && !val) {
        msg.className = 'msg-box error';
        msg.textContent = f.label.replace(/\s*\(.*\)\s*$/, '') + ' is required.';
        $('f-' + f.name).focus();
        return;
      }
      out[f.name] = val;
    }
    var submit = $('formSubmit');
    setBusy(submit, true);
    msg.className = 'msg-box';
    msg.textContent = '';
    try {
      await formState.onSubmit(out);
      closeModal(formBackdrop);
    } catch (err) {
      msg.className = 'msg-box error';
      msg.textContent = errMsg(err);
    } finally {
      setBusy(submit, false);
    }
  });

  /* ---------------- State ---------------- */
  var state = { students: [], month: TODAY.slice(0, 7), filter: 'active', loaded: false };
  var cur = null;         // The student whose record is open: { id, data, tab, seq }
  var lastOpenedId = null; // The card to focus again when the teacher comes back to the list.
  var seq = 0;            // Bumped on every navigation so late responses from an old view are ignored.

  var TABS = [
    ['overview', 'Overview'],
    ['classes', 'Classes'],
    ['fees', 'Fees'],
    ['homework', 'Homework'],
    ['tests', 'Tests'],
    ['notes', 'Notes']
  ];

  /* ============================================================
     LIST VIEW
     ============================================================ */
  function attentionScore(s) {
    var n = 0;
    if (s.status === 'active') {
      if (s.unmarked_classes > 0) n += 2;
      if (s.fee_this_month !== 'paid') n += 1;
      if (s.fees_due_count > 0) n += 1;
    }
    return n;
  }
  function visibleStudents() {
    var q = $('stSearch').value.trim().toLowerCase();
    var list = state.students.filter(function (s) {
      if (state.filter !== 'all' && s.status !== state.filter) return false;
      if (!q) return true;
      return (String(s.student_name || '') + ' ' + String(s.subject || '')).toLowerCase().indexOf(q) !== -1;
    });
    var mode = $('stSort').value;
    list.sort(function (a, b) {
      if (mode === 'name') return String(a.student_name).localeCompare(String(b.student_name));
      if (mode === 'newest') return b.id - a.id;
      if (mode === 'next') {
        var x = a.next_class_date || '9999', y = b.next_class_date || '9999';
        return x < y ? -1 : x > y ? 1 : 0;
      }
      var d = attentionScore(b) - attentionScore(a);
      return d !== 0 ? d : String(a.student_name).localeCompare(String(b.student_name));
    });
    return list;
  }

  function updateListStats() {
    var active = state.students.filter(function (s) { return s.status === 'active'; });
    $('statActive').textContent = active.length;
    $('statFees').textContent = active.filter(function (s) { return s.fee_this_month !== 'paid'; }).length;
    $('statMark').textContent = active.reduce(function (a, s) { return a + s.unmarked_classes; }, 0);
    document.querySelectorAll('#stTabs .pg-tab').forEach(function (t) {
      var f = t.dataset.filter;
      var n = f === 'all' ? state.students.length : state.students.filter(function (s) { return s.status === f; }).length;
      t.textContent = cap(f) + ' (' + n + ')';
    });
  }

  function studentCard(s) {
    var a = el('a', 'pg-st-card');
    a.href = 'teacher-students.html?id=' + encodeURIComponent(s.id);
    a.dataset.id = s.id;
    a.addEventListener('click', function (e) {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      openStudent(s.id, 'overview', true);
    });

    var top = el('div', 'pg-st-top');
    var av = el('span', 'pg-avatar pg-st-av');
    fillAvatar(av, s.student_photo, s.student_name);
    top.appendChild(av);
    var who = el('div', 'pg-st-who');
    who.appendChild(el('strong', '', s.student_name || 'Student'));
    who.appendChild(el('span', 'pg-st-sub', [s.student_grade, s.subject].filter(Boolean).join(' · ')));
    top.appendChild(who);
    top.appendChild(el('span', 'status-tag ' + (s.status === 'active' ? 'accepted' : s.status === 'paused' ? 'requested' : 'completed'), cap(s.status)));
    a.appendChild(top);

    var meta = el('div', 'pg-st-meta');
    var sched = [s.days_per_week ? s.days_per_week.replace(/,/g, ', ') : '', s.booking_time].filter(Boolean).join(' · ');
    if (sched) meta.appendChild(el('span', '', sched));
    if (s.monthly_fee !== null && s.monthly_fee !== undefined) meta.appendChild(el('span', '', money(s.monthly_fee) + ' / month'));
    meta.appendChild(el('span', '', 'Since ' + dayText(s.start_date, { month: 'short', year: 'numeric' })));
    a.appendChild(meta);

    var chips = el('div', 'pg-st-chips');
    if (s.status === 'active') {
      if (s.fee_this_month === 'paid') chips.appendChild(tag('Fee paid this month', 'ok'));
      else if (s.fee_this_month === 'due') chips.appendChild(tag('Fee due this month', 'bad'));
      else chips.appendChild(tag('Fee not recorded this month', 'warn'));
      if (s.unmarked_classes > 0) chips.appendChild(tag(s.unmarked_classes + (s.unmarked_classes === 1 ? ' class needs attendance' : ' classes need attendance'), 'warn'));
    }
    var marked = s.classes_attended + s.classes_absent;
    if (marked > 0) chips.appendChild(tag('Attendance ' + Math.round(s.classes_attended * 100 / marked) + '%', ''));
    if (s.avg_test_percent !== null) chips.appendChild(tag('Tests ' + s.avg_test_percent + '%', ''));
    a.appendChild(chips);

    if (s.status === 'active') {
      a.appendChild(el('div', 'pg-st-next', s.next_class_date
        ? 'Next class: ' + classDate(s.next_class_date) + (s.next_class_time ? ' at ' + s.next_class_time : '')
        : 'No upcoming class scheduled'));
    }
    return a;
  }

  function renderList() {
    var area = $('studentsArea');
    clear(area);
    if (!state.students.length) {
      var empty = el('div', 'pg-empty');
      empty.appendChild(el('p', '', 'No monthly students yet. When a student books a weekly class and you accept it, they will appear here.'));
      var link = el('a', '', 'Go to your dashboard');
      link.href = 'teacher-dashboard.html';
      empty.appendChild(link);
      area.appendChild(empty);
      return;
    }
    var list = visibleStudents();
    if (!list.length) {
      area.appendChild(emptyState($('stSearch').value.trim() ? 'No students match your search.' : 'No students in this group.'));
      return;
    }
    var grid = el('div', 'pg-st-grid');
    list.forEach(function (s) { grid.appendChild(studentCard(s)); });
    area.appendChild(grid);
  }

  async function loadList() {
    var my = ++seq;
    var area = $('studentsArea');
    try {
      var res = await api('/');
      if (my !== seq) return;
      state.students = Array.isArray(res.students) ? res.students : [];
      if (res.today) TODAY = res.today;
      if (res.month) state.month = res.month;
      state.loaded = true;
      updateListStats();
      renderList();
    } catch (err) {
      if (my !== seq) return;
      clear(area);
      var box = emptyState(errMsg(err));
      box.appendChild(document.createElement('br'));
      box.appendChild(btn('Try again', 'btn-outline', loadList));
      area.appendChild(box);
    }
  }

  document.querySelectorAll('#stTabs .pg-tab').forEach(function (t) {
    t.addEventListener('click', function () {
      state.filter = t.dataset.filter;
      document.querySelectorAll('#stTabs .pg-tab').forEach(function (x) {
        var on = x === t;
        x.classList.toggle('is-on', on);
        x.setAttribute('aria-pressed', String(on));
      });
      renderList();
    });
  });
  $('stSearch').addEventListener('input', renderList);
  $('stSort').addEventListener('change', renderList);

  /* ============================================================
     ROUTING (list <-> one student, with the browser Back button)
     ============================================================ */
  function showList(focusId) {
    cur = null;
    $('detailView').hidden = true;
    $('listView').hidden = false;
    document.title = 'My students — TutorLink';
    loadList().then(function () {
      var back = focusId || lastOpenedId;
      if (back) {
        var card = document.querySelector('.pg-st-card[data-id="' + back + '"]');
        if (card) card.focus();
      }
    });
  }

  function openStudent(id, tab, push) {
    if (push) history.pushState({ id: id }, '', 'teacher-students.html?id=' + encodeURIComponent(id) + (tab && tab !== 'overview' ? '&tab=' + tab : ''));
    lastOpenedId = id;
    cur = { id: id, data: null, tab: TABS.some(function (t) { return t[0] === tab; }) ? tab : 'overview', seq: ++seq };
    $('listView').hidden = true;
    $('detailView').hidden = false;
    window.scrollTo(0, 0);
    clear($('detailHead'));
    clear($('dTabs'));
    clear($('dPanel'));
    $('dPanel').appendChild(emptyState('Loading student…'));
    loadStudent(true);
  }

  function route() {
    var q = new URLSearchParams(window.location.search);
    var id = Number(q.get('id'));
    if (Number.isInteger(id) && id > 0) openStudent(id, q.get('tab') || 'overview', false);
    else showList();
  }
  window.addEventListener('popstate', route);
  $('backBtn').addEventListener('click', function () {
    var id = cur && cur.id;
    if (history.state && history.state.id) history.back();
    else { history.replaceState(null, '', 'teacher-students.html'); showList(id); }
  });

  /* ============================================================
     ONE STUDENT: header, tabs
     ============================================================ */
  async function loadStudent(full) {
    var my = cur && cur.seq;
    var id = cur && cur.id;
    try {
      var d = await api('/' + id);
      if (!cur || cur.seq !== my) return;
      cur.data = d;
      if (d.today) TODAY = d.today;
      document.title = (d.student && d.student.name ? d.student.name + ' — ' : '') + 'My students — TutorLink';
      renderHead();
      renderTabs();
      if (full) renderPanel();
    } catch (err) {
      if (!cur || cur.seq !== my) return;
      if (full) {
        clear($('detailHead'));
        clear($('dTabs'));
        var p = $('dPanel');
        clear(p);
        var box = emptyState(errMsg(err));
        box.appendChild(document.createElement('br'));
        box.appendChild(btn('Try again', 'btn-outline', function () { loadStudent(true); }));
        box.appendChild(document.createTextNode(' '));
        box.appendChild(btn('Back to all students', 'btn-outline', function () { $('backBtn').click(); }));
        p.appendChild(box);
      } else {
        toast(errMsg(err), true);
      }
    }
  }

  async function setEnrollmentStatus(status, confirmText, okText) {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      await apiRequest('/api/enrollments/' + cur.id + '/status', 'PUT', { status: status });
      toast(okText);
      await loadStudent(false);
      if (cur && cur.tab === 'overview') renderPanel();
    } catch (err) {
      toast(errMsg(err), true);
    }
  }

  function renderHead() {
    var d = cur.data, s = d.student || {};
    var host = $('detailHead');
    clear(host);
    var card = el('section', 'pg-card pg-st-head');
    var av = el('span', 'pg-avatar pg-st-av pg-st-av-lg');
    fillAvatar(av, s.profile_photo, s.name);
    card.appendChild(av);
    var who = el('div', 'pg-st-headtext');
    var h = el('h1', 'pg-st-name', s.name || 'Student');
    h.id = 'studentName';
    h.tabIndex = -1;
    who.appendChild(h);
    who.appendChild(el('p', 'pg-st-sub', [s.preferred_grade, d.subject, d.schedule.days ? d.schedule.days.replace(/,/g, ', ') + (d.schedule.time ? ' at ' + d.schedule.time : '') : ''].filter(Boolean).join(' · ')));
    card.appendChild(who);
    card.appendChild(el('span', 'status-tag ' + (d.status === 'active' ? 'accepted' : d.status === 'paused' ? 'requested' : 'completed'), cap(d.status)));

    var actions = el('div', 'pg-btnrow pg-st-actions');
    if (d.booking_id) actions.appendChild(btn('💬 Chat', 'btn-outline', function () { openChatModal(d.booking_id, s.name); }));
    if (d.status === 'active') {
      actions.appendChild(btn('Pause', 'btn-outline', function () { setEnrollmentStatus('paused', 'Pause this tuition? The student will be notified.', 'Tuition paused.'); }));
      actions.appendChild(btn('End tuition', 'btn-outline', function () { setEnrollmentStatus('completed', 'End this tuition? It will be marked as completed and the student will be notified.', 'Tuition marked as completed.'); }));
    } else {
      actions.appendChild(btn('Resume tuition', 'btn-primary', function () { setEnrollmentStatus('active', null, 'Tuition resumed.'); }));
    }
    card.appendChild(actions);
    host.appendChild(card);
  }

  function tabBadge(key) {
    if (!cur.data) return 0;
    if (key === 'classes') return cur.data.attendance.unmarked;
    return 0;
  }

  function renderTabs() {
    var host = $('dTabs');
    clear(host);
    TABS.forEach(function (t) {
      var b = el('button', 'pg-tab' + (cur.tab === t[0] ? ' is-on' : ''));
      b.type = 'button';
      b.id = 'tab-' + t[0];
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(cur.tab === t[0]));
      b.setAttribute('aria-controls', 'dPanel');
      b.tabIndex = cur.tab === t[0] ? 0 : -1;
      b.appendChild(document.createTextNode(t[1]));
      var n = tabBadge(t[0]);
      if (n > 0) b.appendChild(el('span', 'pg-tab-badge', String(n)));
      b.addEventListener('click', function () { switchTab(t[0]); });
      b.addEventListener('keydown', function (e) {
        var idx = TABS.findIndex(function (x) { return x[0] === cur.tab; });
        var next = null;
        if (e.key === 'ArrowRight') next = TABS[(idx + 1) % TABS.length][0];
        else if (e.key === 'ArrowLeft') next = TABS[(idx - 1 + TABS.length) % TABS.length][0];
        else if (e.key === 'Home') next = TABS[0][0];
        else if (e.key === 'End') next = TABS[TABS.length - 1][0];
        if (next) { e.preventDefault(); switchTab(next); $('tab-' + next).focus(); }
      });
      host.appendChild(b);
    });
    $('dPanel').setAttribute('aria-labelledby', 'tab-' + cur.tab);
  }

  function switchTab(key) {
    if (!cur || cur.tab === key) return;
    cur.tab = key;
    var url = 'teacher-students.html?id=' + encodeURIComponent(cur.id) + (key !== 'overview' ? '&tab=' + key : '');
    history.replaceState(history.state, '', url);
    renderTabs();
    renderPanel();
  }

  function renderPanel() {
    var panel = $('dPanel');
    clear(panel);
    var my = cur.seq;
    var render = { overview: renderOverview, classes: renderClasses, fees: renderFees, homework: renderHomework, tests: renderTests, notes: renderNotes }[cur.tab];
    var host = el('div');
    panel.appendChild(host);
    host.appendChild(emptyState('Loading…'));
    Promise.resolve(render(host, my)).catch(function (err) {
      if (!cur || cur.seq !== my) return;
      clear(host);
      var box = emptyState(errMsg(err));
      box.appendChild(document.createElement('br'));
      box.appendChild(btn('Try again', 'btn-outline', renderPanel));
      host.appendChild(box);
    });
  }
  function reloadPanel() { if (cur) renderPanel(); }
  // After a change, refresh the header counts and the open tab.
  function afterChange(message) {
    if (message) toast(message);
    loadStudent(false);
    reloadPanel();
  }
  function stale(my) { return !cur || cur.seq !== my; }

  function panelTitle(host, title, sub, actions) {
    var head = el('div', 'pg-st-panelhead');
    var t = el('div');
    t.appendChild(el('h2', 'pg-card-title', title));
    if (sub) t.appendChild(el('p', 'pg-hint', sub));
    head.appendChild(t);
    if (actions && actions.length) {
      var row = el('div', 'pg-btnrow');
      actions.forEach(function (a) { row.appendChild(a); });
      head.appendChild(row);
    }
    host.appendChild(head);
  }
  function block(title) {
    var b = el('div', 'pg-st-block');
    b.appendChild(el('h3', '', title));
    return b;
  }
  function row(label, valueNode) {
    var r = el('div', 'pg-st-row');
    r.appendChild(el('span', 'pg-st-label', label));
    var v = el('span', 'pg-st-value');
    if (typeof valueNode === 'string') v.textContent = valueNode; else v.appendChild(valueNode);
    r.appendChild(v);
    return r;
  }

  /* ============================================================
     TAB: OVERVIEW
     ============================================================ */
  async function renderOverview(host, my) {
    var sessions = await api('/' + cur.id + '/sessions');
    if (stale(my)) return;
    var d = cur.data, s = d.student || {};
    clear(host);

    var quick = el('div', 'pg-btnrow pg-st-quick');
    quick.appendChild(btn('Mark attendance', 'btn-primary', function () { switchTab('classes'); }));
    quick.appendChild(btn('Record fee', 'btn-outline', function () { openFeeForm(null, this); }));
    quick.appendChild(btn('Give homework', 'btn-outline', function () { openHomeworkForm(this); }));
    quick.appendChild(btn('Add test', 'btn-outline', function () { openTestForm(null, this); }));
    quick.appendChild(btn('Add note', 'btn-outline', function () { switchTab('notes'); }));
    host.appendChild(quick);

    var grid = el('div', 'pg-st-grid2');

    // Student contact
    var b1 = block('Student');
    b1.appendChild(row('Name', s.name || '—'));
    b1.appendChild(row('Class', s.preferred_grade || '—'));
    if (s.phone) { var ph = el('a', '', s.phone); ph.href = 'tel:' + String(s.phone).replace(/[^\d+]/g, ''); b1.appendChild(row('Phone', ph)); }
    else b1.appendChild(row('Phone', 'Not shared'));
    if (s.email) { var em = el('a', '', s.email); em.href = 'mailto:' + s.email; b1.appendChild(row('Email', em)); }
    var addr = [s.address, s.area, s.city, s.pincode].filter(Boolean).join(', ');
    b1.appendChild(row('Address', addr || 'Not added'));
    grid.appendChild(b1);

    // Tuition
    var b2 = block('Tuition');
    b2.appendChild(row('Subject', d.subject || '—'));
    var months = d.start_date ? monthsBetween(d.start_date, TODAY) : 0;
    b2.appendChild(row('Started', d.start_date ? dayText(d.start_date) + (months >= 1 ? ' (' + months + (months === 1 ? ' month' : ' months') + ' ago)' : ' (this month)') : '—'));
    if (d.end_date) b2.appendChild(row('Ended', dayText(d.end_date)));
    b2.appendChild(row('Weekly days', d.schedule.days ? d.schedule.days.replace(/,/g, ', ') : '—'));
    b2.appendChild(row('Time', d.schedule.time || '—'));
    b2.appendChild(row('Monthly fee', d.monthly_fee !== null ? money(d.monthly_fee) : '—'));
    grid.appendChild(b2);

    // Last / next class
    var past = sessions.filter(function (x) { return x.status !== 'cancelled' && x.session_date <= TODAY && (x.topic || x.attendance); });
    var lastDone = past.length ? past[past.length - 1] : null;
    var upcoming = sessions.filter(function (x) { return x.status === 'scheduled' && x.session_date >= TODAY; });
    var nextOne = upcoming.length ? upcoming[0] : null;
    var b3 = block('Last and next class');
    b3.appendChild(row('Last class', lastDone ? classDate(lastDone.session_date) + (lastDone.topic ? ' — ' + lastDone.topic : '') + (lastDone.attendance ? ' (' + cap(lastDone.attendance) + ')' : '') : 'Nothing recorded yet'));
    b3.appendChild(row('Next class', nextOne ? classDate(nextOne.session_date) + (nextOne.session_time ? ' at ' + nextOne.session_time : '') : 'None scheduled'));
    b3.appendChild(row('Planned topic', nextOne && nextOne.topic ? nextOne.topic : 'Not planned yet'));
    var go = btn('Open classes', 'btn-outline', function () { switchTab('classes'); });
    go.classList.add('pg-st-mt');
    b3.appendChild(go);
    grid.appendChild(b3);

    // Attendance
    var a = d.attendance;
    var attended = a.present + a.late;
    var marked = attended + a.absent + a.excused;
    var b4 = block('Attendance');
    if (marked > 0) {
      var pct = Math.round(attended * 100 / marked);
      b4.appendChild(el('p', 'pg-st-big', pct + '%'));
      b4.appendChild(bar(pct, 'Attendance'));
      b4.appendChild(el('p', 'pg-hint', a.present + ' present, ' + a.late + ' late, ' + a.absent + ' absent, ' + a.excused + ' excused'));
    } else {
      b4.appendChild(el('p', 'pg-hint', 'No attendance recorded yet.'));
    }
    if (a.unmarked > 0) b4.appendChild(tag(a.unmarked + (a.unmarked === 1 ? ' class needs attendance' : ' classes need attendance'), 'warn'));
    grid.appendChild(b4);

    // Fees
    var b5 = block('Fees');
    b5.appendChild(row('Collected', money(d.fees.paid_total) + ' (' + d.fees.paid_count + (d.fees.paid_count === 1 ? ' month' : ' months') + ')'));
    b5.appendChild(row('Marked as due', d.fees.due_count ? money(d.fees.due_total) + ' (' + d.fees.due_count + (d.fees.due_count === 1 ? ' month' : ' months') + ')' : 'Nothing'));
    var gf = btn('Open fees', 'btn-outline', function () { switchTab('fees'); });
    gf.classList.add('pg-st-mt');
    b5.appendChild(gf);
    grid.appendChild(b5);

    // Syllabus
    var b6 = block('Syllabus progress');
    if (!d.courses.length) b6.appendChild(el('p', 'pg-hint', 'No course created yet. Add modules from your dashboard under Your courses.'));
    d.courses.forEach(function (c) {
      var p = c.module_count ? c.modules_done * 100 / c.module_count : 0;
      b6.appendChild(el('div', 'pg-st-coursename', c.title));
      b6.appendChild(bar(p, c.title + ' progress'));
      b6.appendChild(el('p', 'pg-hint', c.module_count ? c.modules_done + ' of ' + c.module_count + ' modules completed' : 'No modules yet'));
    });
    grid.appendChild(b6);

    // Tests
    var b7 = block('Tests');
    if (d.tests.marked > 0) {
      b7.appendChild(el('p', 'pg-st-big', d.tests.avg_percent + '%'));
      b7.appendChild(bar(d.tests.avg_percent, 'Average test score'));
      b7.appendChild(el('p', 'pg-hint', 'Average over ' + d.tests.marked + (d.tests.marked === 1 ? ' marked test' : ' marked tests')));
    } else {
      b7.appendChild(el('p', 'pg-hint', 'No marked tests yet.'));
    }
    grid.appendChild(b7);

    host.appendChild(grid);
  }

  /* ============================================================
     TAB: CLASSES
     ============================================================ */
  var ATT = [['present', 'Present'], ['late', 'Late'], ['absent', 'Absent'], ['excused', 'Excused']];

  async function renderClasses(host, my) {
    var sessions = await api('/' + cur.id + '/sessions');
    if (stale(my)) return;
    var d = cur.data;
    clear(host);

    var actions = [];
    if (d.status === 'active' && d.booking_id) {
      actions.push(btn('+ Add class', 'btn-primary', function () { openClassForm(this); }));
      if (d.schedule.type === 'recurring') actions.push(btn('Schedule next 4 weeks', 'btn-outline', function () { extendTimetable(this); }));
    }
    panelTitle(host, 'Classes', 'Mark attendance, write what you taught, and plan what comes next.', actions);

    if (!sessions.length) { host.appendChild(emptyState('No classes are scheduled for this student yet.')); return; }

    var needs = sessions.filter(function (x) { return x.status === 'scheduled' && x.session_date < TODAY; });
    var todayList = sessions.filter(function (x) { return x.status === 'scheduled' && x.session_date === TODAY; });
    var upcoming = sessions.filter(function (x) { return x.status === 'scheduled' && x.session_date > TODAY; });
    var history = sessions.filter(function (x) { return x.status !== 'scheduled'; }).reverse();

    function group(title, list, opts) {
      if (!list.length) return;
      var g = el('div', 'pg-st-group');
      g.appendChild(el('h3', 'pg-st-grouphead', title + ' (' + list.length + ')'));
      var shown = opts.limit && list.length > opts.limit ? list.slice(0, opts.limit) : list;
      var wrap = el('div', 'pg-list');
      shown.forEach(function (x) { wrap.appendChild(sessionRow(x)); });
      g.appendChild(wrap);
      if (shown.length < list.length) {
        var more = btn('Show all ' + list.length, 'btn-outline', function () {
          clear(wrap);
          list.forEach(function (x) { wrap.appendChild(sessionRow(x)); });
          more.remove();
        });
        more.classList.add('pg-st-mt');
        g.appendChild(more);
      }
      host.appendChild(g);
    }
    group('Needs attendance', needs, {});
    group('Today', todayList, {});
    group('Upcoming', upcoming, { limit: 8 });
    group('History', history, { limit: 10 });
  }

  function sessionRow(x) {
    var isPast = x.session_date <= TODAY;
    var r = el('div', 'pg-row-item pg-session' + (x.status === 'cancelled' ? ' is-cancelled' : ''));
    var info = el('div', 'pg-row-info');
    var line = el('div');
    line.appendChild(el('strong', '', classDate(x.session_date)));
    if (x.session_time) line.appendChild(document.createTextNode(' · ' + x.session_time));
    if (x.status === 'cancelled') line.appendChild(tag('Cancelled', 'muted'));
    else if (x.attendance) line.appendChild(tag(cap(x.attendance), x.attendance === 'present' ? 'ok' : x.attendance === 'late' || x.attendance === 'excused' ? 'warn' : 'bad'));
    info.appendChild(line);
    var done = x.session_date < TODAY || !!x.attendance;
    if (x.topic) info.appendChild(el('div', 'pg-row-meta pg-st-topic', (done ? 'Taught: ' : 'Planned: ') + x.topic));
    if (x.notes) info.appendChild(el('div', 'pg-row-meta pg-st-notes', x.notes));
    r.appendChild(info);

    if (x.status !== 'cancelled') {
      var side = el('div', 'pg-row-side');
      if (isPast) {
        var seg = el('div', 'pg-seg');
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', 'Attendance for ' + classDate(x.session_date));
        ATT.forEach(function (a) {
          var on = x.attendance === a[0];
          var b = el('button', 'pg-seg-btn' + (on ? ' is-on' : ''), a[1]);
          b.type = 'button';
          b.setAttribute('aria-pressed', String(on));
          b.addEventListener('click', function () { setAttendance(x, on ? null : a[0], b); });
          seg.appendChild(b);
        });
        side.appendChild(seg);
      }
      side.appendChild(btn(isPast ? (x.topic ? 'Edit topic' : 'Add topic') : (x.topic ? 'Edit plan' : 'Plan topic'), 'btn-outline', function () { openSessionForm(x, this); }));
      if (x.status === 'scheduled' && !x.attendance) {
        side.appendChild(btn('Cancel class', 'btn-outline', function () { cancelClass(x, this); }));
      }
      r.appendChild(side);
    }
    return r;
  }

  async function setAttendance(x, value, button) {
    setBusy(button, true);
    try {
      await api('/' + cur.id + '/sessions/' + x.id, 'PUT', { attendance: value });
      afterChange(value ? 'Marked ' + value + '.' : 'Attendance cleared.');
    } catch (err) {
      setBusy(button, false);
      toast(errMsg(err), true);
    }
  }
  async function cancelClass(x, button) {
    if (!window.confirm('Cancel the class on ' + classDate(x.session_date) + '?')) return;
    setBusy(button, true);
    try {
      await api('/' + cur.id + '/sessions/' + x.id, 'PUT', { status: 'cancelled' });
      afterChange('Class cancelled.');
    } catch (err) {
      setBusy(button, false);
      toast(errMsg(err), true);
    }
  }
  function openSessionForm(x, opener) {
    var past = x.session_date <= TODAY;
    openForm({
      title: past ? 'What was taught' : 'Plan this class',
      sub: classDate(x.session_date) + (x.session_time ? ' at ' + x.session_time : ''),
      opener: opener,
      fields: [
        { name: 'topic', label: past ? 'Topic taught' : 'Topic to teach', type: 'text', value: x.topic || '', maxlength: 255, placeholder: 'e.g. Quadratic equations' },
        { name: 'notes', label: 'Notes (optional)', type: 'textarea', value: x.notes || '', maxlength: 2000, placeholder: 'Homework given, how the student did, what to revise next time' }
      ],
      onSubmit: async function (v) {
        await api('/' + cur.id + '/sessions/' + x.id, 'PUT', { topic: v.topic, notes: v.notes });
        afterChange('Class saved.');
      }
    });
  }
  function openClassForm(opener) {
    var d = cur.data;
    openForm({
      title: 'Add a class',
      sub: 'One extra class for ' + (d.student && d.student.name ? d.student.name : 'this student') + '.',
      submitLabel: 'Add class',
      opener: opener,
      fields: [
        { name: 'session_date', label: 'Date', type: 'date', min: TODAY, required: true, value: TODAY },
        { name: 'session_time', label: 'Time', type: 'text', required: true, value: d.schedule.time || '', placeholder: 'e.g. 5:00 PM', hint: 'Use a time like 5:00 PM.' },
        { name: 'topic', label: 'Planned topic (optional)', type: 'text', maxlength: 255 }
      ],
      onSubmit: async function (v) {
        await api('/' + cur.id + '/sessions', 'POST', { session_date: v.session_date, session_time: v.session_time, topic: v.topic });
        afterChange('Class added.');
      }
    });
  }
  async function extendTimetable(button) {
    setBusy(button, true);
    try {
      var r = await api('/' + cur.id + '/sessions/extend', 'POST', { weeks: 4 });
      var skipped = r.skipped && r.skipped.length ? ' ' + r.skipped.length + (r.skipped.length === 1 ? ' date was' : ' dates were') + ' skipped because you already have another class then.' : '';
      afterChange((r.message || 'Timetable extended.') + skipped);
    } catch (err) {
      setBusy(button, false);
      toast(errMsg(err), true);
    }
  }

  /* ============================================================
     TAB: FEES
     ============================================================ */
  var METHODS = [['cash', 'Cash'], ['upi', 'UPI'], ['bank', 'Bank transfer'], ['online', 'Online'], ['other', 'Other']];
  function methodLabel(m) { var f = METHODS.filter(function (x) { return x[0] === m; })[0]; return f ? f[1] : cap(m); }

  async function renderFees(host, my) {
    var data = await api('/' + cur.id + '/fees');
    if (stale(my)) return;
    cur.fees = data;
    clear(host);
    panelTitle(host, 'Fees', 'Record what the student paid each month and when. Only you can see these records.', [btn('+ Record fee', 'btn-primary', function () { openFeeForm(null, this); })]);

    var byMonth = {};
    data.records.forEach(function (r) { byMonth[r.period_month] = r; });
    var thisMonth = TODAY.slice(0, 7);
    var startMonth = data.start_date ? String(data.start_date).slice(0, 7) : thisMonth;
    var months = [];
    for (var m = thisMonth, guard = 0; m >= startMonth && guard < 24; m = shiftMonth(m, -1), guard++) months.push(m);
    Object.keys(byMonth).forEach(function (k) { if (months.indexOf(k) === -1) months.push(k); });
    months.sort().reverse();

    var paidTotal = data.records.filter(function (r) { return r.status === 'paid'; }).reduce(function (a, r) { return a + r.amount; }, 0);
    var unrecorded = months.filter(function (k) { return !byMonth[k] && k <= thisMonth; }).length;
    var dueCount = data.records.filter(function (r) { return r.status === 'due'; }).length;

    var tiles = el('div', 'pg-tiles pg-tiles-tight');
    function tile(label, value) {
      var t = el('div', 'pg-tile');
      t.appendChild(el('div', 'pg-tile-label', label));
      t.appendChild(el('div', 'pg-tile-value', value));
      return t;
    }
    tiles.appendChild(tile('Monthly fee', data.monthly_fee !== null ? money(data.monthly_fee) : '—'));
    tiles.appendChild(tile('Collected', money(paidTotal)));
    tiles.appendChild(tile('Marked as due', String(dueCount)));
    tiles.appendChild(tile('Months not recorded', String(unrecorded)));
    host.appendChild(tiles);

    var list = el('div', 'pg-list pg-st-feelist');
    months.forEach(function (k) {
      var rec = byMonth[k];
      var r = el('div', 'pg-row-item');
      var info = el('div', 'pg-row-info');
      var line = el('div');
      line.appendChild(el('strong', '', monthLabel(k)));
      line.appendChild(document.createTextNode(' · ' + (rec ? money(rec.amount) : (data.monthly_fee !== null ? money(data.monthly_fee) : ''))));
      info.appendChild(line);
      if (rec && rec.status === 'paid') info.appendChild(el('div', 'pg-row-meta', 'Paid on ' + dayText(rec.paid_on) + (rec.method ? ' · ' + methodLabel(rec.method) : '') + (rec.note ? ' · ' + rec.note : '')));
      else if (rec && rec.note) info.appendChild(el('div', 'pg-row-meta', rec.note));
      r.appendChild(info);
      var side = el('div', 'pg-row-side');
      if (rec) {
        side.appendChild(tag(rec.status === 'paid' ? 'Paid' : 'Due', rec.status === 'paid' ? 'ok' : 'bad'));
        side.appendChild(btn('Edit', 'btn-outline', function () { openFeeForm(rec, this); }, 'Edit fee for ' + monthLabel(k)));
        side.appendChild(btn('Delete', 'btn-outline', function () { deleteFee(rec, this); }, 'Delete fee record for ' + monthLabel(k)));
      } else {
        side.appendChild(tag(k > thisMonth ? 'Upcoming' : 'Not recorded', k > thisMonth ? 'muted' : 'warn'));
        side.appendChild(btn('Record', 'btn-outline', function () { openFeeForm({ period_month: k }, this); }, 'Record fee for ' + monthLabel(k)));
      }
      r.appendChild(side);
      list.appendChild(r);
    });
    host.appendChild(list);

    if (data.online_payments.length) {
      var ob = block('Online payments through TutorLink');
      data.online_payments.forEach(function (p) {
        ob.appendChild(row(p.paid_at ? stamp(p.paid_at) : 'Payment', money(p.amount) + ' · ' + cap(String(p.status).replace(/_/g, ' '))));
      });
      ob.classList.add('pg-st-mt');
      host.appendChild(ob);
    }
  }

  function openFeeForm(rec, opener) {
    var d = cur.data;
    var thisMonth = TODAY.slice(0, 7);
    var startMonth = d.start_date ? String(d.start_date).slice(0, 7) : thisMonth;
    var opts = [];
    for (var m = shiftMonth(thisMonth, 1), guard = 0; m >= startMonth && guard < 26; m = shiftMonth(m, -1), guard++) opts.push({ value: m, label: monthLabel(m) });
    var chosen = (rec && rec.period_month) || thisMonth;
    if (!opts.some(function (o) { return o.value === chosen; })) opts.push({ value: chosen, label: monthLabel(chosen) });
    var fee = rec && rec.amount !== undefined ? rec.amount : (d.monthly_fee !== null ? d.monthly_fee : '');
    openForm({
      title: rec && rec.id ? 'Edit fee record' : 'Record a fee',
      sub: 'Saving a month that already has a record updates it.',
      submitLabel: 'Save fee',
      opener: opener,
      fields: [
        { name: 'period_month', label: 'Month', type: 'select', options: opts, value: chosen, required: true },
        { name: 'amount', label: 'Amount (₹)', type: 'number', min: 0, max: 1000000, step: '1', value: fee, required: true },
        { name: 'status', label: 'Status', type: 'select', options: [{ value: 'paid', label: 'Paid' }, { value: 'due', label: 'Not paid yet (due)' }], value: rec && rec.status ? rec.status : 'paid' },
        { name: 'paid_on', label: 'Date paid', type: 'date', max: TODAY, value: rec && rec.paid_on ? String(rec.paid_on).slice(0, 10) : TODAY, required: true, showIf: function (v) { return v.status === 'paid'; } },
        { name: 'method', label: 'How was it paid', type: 'select', options: METHODS.map(function (x) { return { value: x[0], label: x[1] }; }), value: rec && rec.method ? rec.method : 'cash', showIf: function (v) { return v.status === 'paid'; } },
        { name: 'note', label: 'Note (optional)', type: 'text', maxlength: 255, value: rec && rec.note ? rec.note : '' }
      ],
      onSubmit: async function (v) {
        var body = { period_month: v.period_month, amount: Number(v.amount), status: v.status, note: v.note };
        if (v.status === 'paid') { body.paid_on = v.paid_on; body.method = v.method; }
        await api('/' + cur.id + '/fees', 'POST', body);
        afterChange('Fee saved.');
      }
    });
  }
  async function deleteFee(rec, button) {
    if (!window.confirm('Delete the fee record for ' + monthLabel(rec.period_month) + '?')) return;
    setBusy(button, true);
    try {
      await api('/' + cur.id + '/fees/' + rec.id, 'DELETE');
      afterChange('Fee record deleted.');
    } catch (err) {
      setBusy(button, false);
      toast(errMsg(err), true);
    }
  }

  /* ============================================================
     TAB: HOMEWORK
     ============================================================ */
  async function renderHomework(host, my) {
    var list = await api('/' + cur.id + '/assignments');
    if (stale(my)) return;
    clear(host);
    panelTitle(host, 'Homework', 'Give homework and mark it as checked with feedback.', [btn('+ Give homework', 'btn-primary', function () { openHomeworkForm(this); })]);
    if (!list.length) { host.appendChild(emptyState('No homework given yet.')); return; }
    var wrap = el('div', 'pg-list');
    list.forEach(function (a) {
      var r = el('div', 'pg-row-item');
      var info = el('div', 'pg-row-info');
      var line = el('div');
      line.appendChild(el('strong', '', a.title));
      var checked = a.submission_status === 'reviewed';
      if (checked) line.appendChild(tag('Checked', 'ok'));
      else if (a.submission_status === 'submitted') line.appendChild(tag('Submitted by student', 'warn'));
      else if (a.due_date && String(a.due_date).slice(0, 10) < TODAY) line.appendChild(tag('Overdue', 'bad'));
      else line.appendChild(tag('Not checked', 'muted'));
      info.appendChild(line);
      if (a.due_date) info.appendChild(el('div', 'pg-row-meta', 'Due ' + classDate(a.due_date)));
      if (a.instructions) info.appendChild(el('div', 'pg-row-meta pg-st-notes', a.instructions));
      if (a.submission_text) info.appendChild(el('div', 'pg-row-meta pg-st-notes', 'Student wrote: ' + a.submission_text));
      if (a.feedback) info.appendChild(el('div', 'pg-row-meta pg-st-notes', 'Your feedback: ' + a.feedback));
      r.appendChild(info);
      var side = el('div', 'pg-row-side');
      side.appendChild(btn(checked ? 'Edit feedback' : 'Mark as checked', checked ? 'btn-outline' : 'btn-primary', function () { openReviewForm(a, this); }));
      side.appendChild(btn('Delete', 'btn-outline', function () { deleteHomework(a, this); }, 'Delete homework ' + a.title));
      r.appendChild(side);
      wrap.appendChild(r);
    });
    host.appendChild(wrap);
  }
  function openHomeworkForm(opener) {
    openForm({
      title: 'Give homework',
      sub: 'The student gets a notification.',
      submitLabel: 'Give homework',
      opener: opener,
      fields: [
        { name: 'title', label: 'Title', type: 'text', required: true, maxlength: 255, placeholder: 'e.g. Exercise 4.2, questions 1 to 10' },
        { name: 'instructions', label: 'Instructions (optional)', type: 'textarea', maxlength: 3000 },
        { name: 'due_date', label: 'Due date (optional)', type: 'date', min: TODAY }
      ],
      onSubmit: async function (v) {
        var body = { title: v.title, instructions: v.instructions };
        if (v.due_date) body.due_date = v.due_date;
        await api('/' + cur.id + '/assignments', 'POST', body);
        if (cur.tab !== 'homework') switchTab('homework'); else reloadPanel();
        toast('Homework given.');
      }
    });
  }
  function openReviewForm(a, opener) {
    openForm({
      title: 'Check homework',
      sub: a.title,
      submitLabel: 'Mark as checked',
      opener: opener,
      fields: [{ name: 'feedback', label: 'Feedback (optional)', type: 'textarea', value: a.feedback || '', maxlength: 1000, placeholder: 'What was good, what to fix' }],
      onSubmit: async function (v) {
        await api('/' + cur.id + '/assignments/' + a.id + '/review', 'PUT', { feedback: v.feedback });
        afterChange('Homework marked as checked.');
      }
    });
  }
  async function deleteHomework(a, button) {
    if (!window.confirm('Delete this homework? "' + a.title + '"')) return;
    setBusy(button, true);
    try {
      await api('/' + cur.id + '/assignments/' + a.id, 'DELETE');
      afterChange('Homework deleted.');
    } catch (err) {
      setBusy(button, false);
      toast(errMsg(err), true);
    }
  }

  /* ============================================================
     TAB: TESTS
     ============================================================ */
  async function renderTests(host, my) {
    var list = await api('/' + cur.id + '/tests');
    if (stale(my)) return;
    cur.tests = list;
    clear(host);
    panelTitle(host, 'Tests', 'Keep every test and the marks the student scored.', [btn('+ Add test', 'btn-primary', function () { openTestForm(null, this); })]);
    if (!list.length) { host.appendChild(emptyState('No tests added yet.')); return; }
    var marked = list.filter(function (t) { return t.marks_obtained !== null; });
    if (marked.length) {
      var avg = marked.reduce(function (a, t) { return a + t.marks_obtained * 100 / t.max_marks; }, 0) / marked.length;
      host.appendChild(el('p', 'pg-hint pg-sumline', 'Average score ' + (Math.round(avg * 10) / 10) + '% across ' + marked.length + (marked.length === 1 ? ' test' : ' tests')));
    }
    var wrap = el('div', 'pg-list');
    list.forEach(function (t) {
      var r = el('div', 'pg-row-item');
      var info = el('div', 'pg-row-info');
      var line = el('div');
      line.appendChild(el('strong', '', t.title));
      line.appendChild(document.createTextNode(' · ' + dayText(t.test_date)));
      info.appendChild(line);
      if (t.marks_obtained !== null) {
        var pct = t.marks_obtained * 100 / t.max_marks;
        info.appendChild(el('div', 'pg-row-meta', t.marks_obtained + ' / ' + t.max_marks + ' (' + Math.round(pct) + '%)'));
        info.appendChild(bar(pct, t.title + ' score'));
      } else {
        info.appendChild(el('div', 'pg-row-meta', 'Out of ' + t.max_marks + ' · marks not entered yet'));
      }
      if (t.remarks) info.appendChild(el('div', 'pg-row-meta pg-st-notes', t.remarks));
      r.appendChild(info);
      var side = el('div', 'pg-row-side');
      side.appendChild(btn(t.marks_obtained === null ? 'Enter marks' : 'Edit', t.marks_obtained === null ? 'btn-primary' : 'btn-outline', function () { openTestForm(t, this); }, 'Edit test ' + t.title));
      side.appendChild(btn('Delete', 'btn-outline', function () { deleteTest(t, this); }, 'Delete test ' + t.title));
      r.appendChild(side);
      wrap.appendChild(r);
    });
    host.appendChild(wrap);
  }
  function openTestForm(t, opener) {
    openForm({
      title: t ? 'Edit test' : 'Add a test',
      sub: t ? '' : 'You can add the marks later if the test has not been checked yet.',
      submitLabel: 'Save test',
      opener: opener,
      fields: [
        { name: 'title', label: 'Test name', type: 'text', required: true, maxlength: 150, value: t ? t.title : '', placeholder: 'e.g. Unit test 1' },
        { name: 'test_date', label: 'Test date', type: 'date', required: true, value: t ? String(t.test_date).slice(0, 10) : TODAY },
        { name: 'max_marks', label: 'Maximum marks', type: 'number', min: 1, max: 1000, step: 'any', required: true, value: t ? t.max_marks : '' },
        { name: 'marks_obtained', label: 'Marks obtained (optional)', type: 'number', min: 0, max: 1000, step: 'any', value: t && t.marks_obtained !== null ? t.marks_obtained : '' },
        { name: 'remarks', label: 'Remarks (optional)', type: 'text', maxlength: 500, value: t && t.remarks ? t.remarks : '' }
      ],
      onSubmit: async function (v) {
        var max = Number(v.max_marks);
        if (!(max > 0)) throw new Error('Maximum marks must be more than 0.');
        if (v.marks_obtained !== '' && Number(v.marks_obtained) > max) throw new Error('Marks obtained cannot be more than the maximum marks.');
        var body = { title: v.title, test_date: v.test_date, max_marks: max, marks_obtained: v.marks_obtained === '' ? null : Number(v.marks_obtained), remarks: v.remarks };
        if (t) await api('/' + cur.id + '/tests/' + t.id, 'PUT', body);
        else await api('/' + cur.id + '/tests', 'POST', body);
        if (cur.tab !== 'tests') switchTab('tests'); else reloadPanel();
        loadStudent(false);
        toast('Test saved.');
      }
    });
  }
  async function deleteTest(t, button) {
    if (!window.confirm('Delete the test "' + t.title + '"?')) return;
    setBusy(button, true);
    try {
      await api('/' + cur.id + '/tests/' + t.id, 'DELETE');
      afterChange('Test deleted.');
    } catch (err) {
      setBusy(button, false);
      toast(errMsg(err), true);
    }
  }

  /* ============================================================
     TAB: NOTES
     ============================================================ */
  async function renderNotes(host, my) {
    var notes = await api('/' + cur.id + '/notes');
    if (stale(my)) return;
    clear(host);
    panelTitle(host, 'Private notes', 'Only you can see these notes. The student never sees them.');

    var form = el('form', 'pg-st-noteform');
    form.noValidate = true;
    var field = el('div', 'pg-field');
    var label = el('label', '', 'New note');
    label.htmlFor = 'noteText';
    var ta = el('textarea');
    ta.id = 'noteText';
    ta.rows = 3;
    ta.maxLength = 2000;
    ta.placeholder = 'e.g. Weak in fractions. Needs extra practice before the unit test.';
    field.appendChild(label);
    field.appendChild(ta);
    form.appendChild(field);
    var msg = el('div', 'msg-box');
    msg.setAttribute('role', 'alert');
    form.appendChild(msg);
    var save = el('button', 'btn btn-primary btn-sm', 'Save note');
    save.type = 'submit';
    form.appendChild(save);
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var value = ta.value.trim();
      if (!value) { msg.className = 'msg-box error'; msg.textContent = 'Please write a note first.'; ta.focus(); return; }
      msg.className = 'msg-box';
      msg.textContent = '';
      setBusy(save, true);
      try {
        await api('/' + cur.id + '/notes', 'POST', { note: value });
        toast('Note saved.');
        reloadPanel();
      } catch (err) {
        setBusy(save, false);
        msg.className = 'msg-box error';
        msg.textContent = errMsg(err);
      }
    });
    host.appendChild(form);

    if (!notes.length) { host.appendChild(emptyState('No notes yet.')); return; }
    var wrap = el('div', 'pg-list pg-st-mt');
    notes.forEach(function (n) {
      var r = el('div', 'pg-row-item');
      var info = el('div', 'pg-row-info');
      info.appendChild(el('div', 'pg-st-notetext', n.note));
      info.appendChild(el('div', 'pg-row-meta', stamp(n.created_at, true)));
      r.appendChild(info);
      var side = el('div', 'pg-row-side');
      side.appendChild(btn('Delete', 'btn-outline', function () {
        var b = this;
        if (!window.confirm('Delete this note?')) return;
        setBusy(b, true);
        api('/' + cur.id + '/notes/' + n.id, 'DELETE').then(function () { toast('Note deleted.'); reloadPanel(); }).catch(function (err) { setBusy(b, false); toast(errMsg(err), true); });
      }, 'Delete note'));
      r.appendChild(side);
      wrap.appendChild(r);
    });
    host.appendChild(wrap);
  }

  /* ---------------- Go ---------------- */
  route();
})();