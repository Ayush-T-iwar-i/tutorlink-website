/* =========================================================
   TutorLink - student "My tuition" page
   Place at: frontend/js/student-tuition.js
   Needs: js/api.js, js/ui.js (loaded before this file)
   Talks to: /api/my-tuition/*
   ========================================================= */
(function () {
  'use strict';

  var session = requireLogin('student');
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

  function api(path, method, body) { return apiRequest('/api/my-tuition' + path, method || 'GET', body || null); }

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
  var state = { tuitions: [], filter: 'active' };
  var cur = null;         // The tuition that is open: { id, data, tab, seq }
  var lastOpenedId = null;
  var seq = 0;            // Bumped on every navigation so late responses from an old view are ignored.

  var TABS = [['overview', 'Overview'], ['classes', 'Classes'], ['homework', 'Homework'], ['tests', 'Tests']];

  function stale(my) { return !cur || cur.seq !== my; }
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
  function panelTitle(host, title, sub) {
    var head = el('div', 'pg-st-panelhead');
    var t = el('div');
    t.appendChild(el('h2', 'pg-card-title', title));
    if (sub) t.appendChild(el('p', 'pg-hint', sub));
    head.appendChild(t);
    host.appendChild(head);
  }
  function statusClass(s) { return s === 'active' ? 'accepted' : s === 'paused' ? 'requested' : 'completed'; }

  /* ============================================================
     LIST VIEW
     ============================================================ */
  function visibleTuitions() {
    return state.tuitions.filter(function (t) { return state.filter === 'all' || t.status === state.filter; });
  }
  function updateListStats() {
    var active = state.tuitions.filter(function (t) { return t.status === 'active'; });
    $('statActive').textContent = active.length;
    $('statHomework').textContent = active.reduce(function (a, t) { return a + t.homework_to_do; }, 0);
    var next = active.filter(function (t) { return t.next_class_date; }).sort(function (a, b) { return a.next_class_date < b.next_class_date ? -1 : 1; })[0];
    $('statNext').textContent = next ? relDay(next.next_class_date) || dayText(next.next_class_date, { day: 'numeric', month: 'short' }) : '—';
    document.querySelectorAll('#stTabs .pg-tab').forEach(function (tab) {
      var f = tab.dataset.filter;
      var n = f === 'all' ? state.tuitions.length : state.tuitions.filter(function (t) { return t.status === f; }).length;
      tab.textContent = cap(f) + ' (' + n + ')';
    });
  }

  function tuitionCard(t) {
    var a = el('a', 'pg-st-card');
    a.href = 'student-tuition.html?id=' + encodeURIComponent(t.id);
    a.dataset.id = t.id;
    a.addEventListener('click', function (e) {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      openTuition(t.id, 'overview', true);
    });
    var top = el('div', 'pg-st-top');
    var av = el('span', 'pg-avatar pg-st-av');
    fillAvatar(av, t.teacher_photo, t.teacher_name);
    top.appendChild(av);
    var who = el('div', 'pg-st-who');
    who.appendChild(el('strong', '', t.teacher_name || 'Teacher'));
    who.appendChild(el('span', 'pg-st-sub', t.subject || ''));
    top.appendChild(who);
    top.appendChild(el('span', 'status-tag ' + statusClass(t.status), cap(t.status)));
    a.appendChild(top);

    var meta = el('div', 'pg-st-meta');
    var sched = [t.days_per_week ? t.days_per_week.replace(/,/g, ', ') : '', t.booking_time].filter(Boolean).join(' · ');
    if (sched) meta.appendChild(el('span', '', sched));
    meta.appendChild(el('span', '', 'Since ' + dayText(t.start_date, { month: 'short', year: 'numeric' })));
    a.appendChild(meta);

    var chips = el('div', 'pg-st-chips');
    var marked = t.classes_attended + t.classes_absent;
    if (marked > 0) chips.appendChild(tag('Attendance ' + Math.round(t.classes_attended * 100 / marked) + '%', ''));
    if (t.homework_to_do > 0) chips.appendChild(tag(t.homework_to_do + ' homework to do', 'warn'));
    if (t.avg_test_percent !== null) chips.appendChild(tag('Tests ' + t.avg_test_percent + '%', ''));
    a.appendChild(chips);
    if (t.status === 'active') {
      a.appendChild(el('div', 'pg-st-next', t.next_class_date
        ? 'Next class: ' + classDate(t.next_class_date) + (t.next_class_time ? ' at ' + t.next_class_time : '')
        : 'No upcoming class scheduled'));
    }
    return a;
  }

  function renderList() {
    var area = $('tuitionArea');
    clear(area);
    if (!state.tuitions.length) {
      var empty = el('div', 'pg-empty');
      empty.appendChild(el('p', '', 'You have no monthly tuition yet. When a teacher accepts your weekly class request, it will appear here.'));
      var link = el('a', '', 'Find a teacher');
      link.href = 'student-dashboard.html';
      empty.appendChild(link);
      area.appendChild(empty);
      return;
    }
    var list = visibleTuitions();
    if (!list.length) { area.appendChild(emptyState('Nothing in this group.')); return; }
    var grid = el('div', 'pg-st-grid');
    list.forEach(function (t) { grid.appendChild(tuitionCard(t)); });
    area.appendChild(grid);
  }

  async function loadList() {
    var my = ++seq;
    var area = $('tuitionArea');
    try {
      var res = await api('/');
      if (my !== seq) return;
      state.tuitions = Array.isArray(res.tuitions) ? res.tuitions : [];
      if (res.today) TODAY = res.today;
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

  /* ============================================================
     ROUTING
     ============================================================ */
  function showList(focusId) {
    cur = null;
    $('detailView').hidden = true;
    $('listView').hidden = false;
    document.title = 'My tuition — TutorLink';
    loadList().then(function () {
      var back = focusId || lastOpenedId;
      if (back) {
        var card = document.querySelector('.pg-st-card[data-id="' + back + '"]');
        if (card) card.focus();
      }
    });
  }
  function openTuition(id, tab, push) {
    if (push) history.pushState({ id: id }, '', 'student-tuition.html?id=' + encodeURIComponent(id) + (tab && tab !== 'overview' ? '&tab=' + tab : ''));
    lastOpenedId = id;
    cur = { id: id, data: null, tab: TABS.some(function (t) { return t[0] === tab; }) ? tab : 'overview', seq: ++seq };
    $('listView').hidden = true;
    $('detailView').hidden = false;
    window.scrollTo(0, 0);
    clear($('detailHead'));
    clear($('dTabs'));
    clear($('dPanel'));
    $('dPanel').appendChild(emptyState('Loading…'));
    loadTuition(true);
  }
  function route() {
    var q = new URLSearchParams(window.location.search);
    var id = Number(q.get('id'));
    if (Number.isInteger(id) && id > 0) openTuition(id, q.get('tab') || 'overview', false);
    else showList();
  }
  window.addEventListener('popstate', route);
  $('backBtn').addEventListener('click', function () {
    var id = cur && cur.id;
    if (history.state && history.state.id) history.back();
    else { history.replaceState(null, '', 'student-tuition.html'); showList(id); }
  });

  /* ============================================================
     ONE TUITION: header and tabs
     ============================================================ */
  async function loadTuition(full) {
    var my = cur && cur.seq;
    var id = cur && cur.id;
    try {
      var d = await api('/' + id);
      if (!cur || cur.seq !== my) return;
      cur.data = d;
      if (d.today) TODAY = d.today;
      document.title = (d.teacher && d.teacher.name ? d.subject + ' with ' + d.teacher.name + ' — ' : '') + 'My tuition — TutorLink';
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
        box.appendChild(btn('Try again', 'btn-outline', function () { loadTuition(true); }));
        box.appendChild(document.createTextNode(' '));
        box.appendChild(btn('Back to my tuition', 'btn-outline', function () { $('backBtn').click(); }));
        p.appendChild(box);
      } else {
        toast(errMsg(err), true);
      }
    }
  }

  function renderHead() {
    var d = cur.data, t = d.teacher || {};
    var host = $('detailHead');
    clear(host);
    var card = el('section', 'pg-card pg-st-head');
    var av = el('span', 'pg-avatar pg-st-av pg-st-av-lg');
    fillAvatar(av, t.profile_photo, t.name);
    card.appendChild(av);
    var who = el('div', 'pg-st-headtext');
    var h = el('h1', 'pg-st-name', d.subject || 'Tuition');
    h.id = 'tuitionName';
    h.tabIndex = -1;
    who.appendChild(h);
    who.appendChild(el('p', 'pg-st-sub', ['with ' + (t.name || 'your teacher'), d.schedule.days ? d.schedule.days.replace(/,/g, ', ') + (d.schedule.time ? ' at ' + d.schedule.time : '') : ''].filter(Boolean).join(' · ')));
    card.appendChild(who);
    card.appendChild(el('span', 'status-tag ' + statusClass(d.status), cap(d.status)));
    var actions = el('div', 'pg-btnrow pg-st-actions');
    if (d.booking_id) actions.appendChild(btn('💬 Chat', 'btn-outline', function () { openChatModal(d.booking_id, t.name); }));
    if (t.teacher_id) {
      var prof = el('a', 'btn btn-sm btn-outline', 'Teacher profile');
      prof.href = 'teacher-profile-view.html?id=' + encodeURIComponent(t.teacher_id);
      actions.appendChild(prof);
    }
    card.appendChild(actions);
    host.appendChild(card);
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
    history.replaceState(history.state, '', 'student-tuition.html?id=' + encodeURIComponent(cur.id) + (key !== 'overview' ? '&tab=' + key : ''));
    renderTabs();
    renderPanel();
  }
  function renderPanel() {
    var panel = $('dPanel');
    clear(panel);
    var my = cur.seq;
    var render = { overview: renderOverview, classes: renderClasses, homework: renderHomework, tests: renderTests }[cur.tab];
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

  /* ---------------- Overview ---------------- */
  async function renderOverview(host, my) {
    var sessions = await api('/' + cur.id + '/sessions');
    if (stale(my)) return;
    var d = cur.data, t = d.teacher || {};
    clear(host);
    var grid = el('div', 'pg-st-grid2');

    var b1 = block('Your teacher');
    b1.appendChild(row('Name', t.name || '—'));
    if (t.qualification) b1.appendChild(row('Qualification', t.qualification));
    if (t.experience_years) b1.appendChild(row('Experience', t.experience_years + (t.experience_years === 1 ? ' year' : ' years')));
    grid.appendChild(b1);

    var b2 = block('Your tuition');
    b2.appendChild(row('Subject', d.subject || '—'));
    var months = d.start_date ? monthsBetween(d.start_date, TODAY) : 0;
    b2.appendChild(row('Started', d.start_date ? dayText(d.start_date) + (months >= 1 ? ' (' + months + (months === 1 ? ' month' : ' months') + ' ago)' : ' (this month)') : '—'));
    b2.appendChild(row('Weekly days', d.schedule.days ? d.schedule.days.replace(/,/g, ', ') : '—'));
    b2.appendChild(row('Time', d.schedule.time || '—'));
    if (d.monthly_fee !== null && d.monthly_fee !== undefined) b2.appendChild(row('Monthly fee', money(d.monthly_fee)));
    grid.appendChild(b2);

    var done = sessions.filter(function (x) { return x.status !== 'cancelled' && x.session_date <= TODAY && (x.topic || x.attendance); });
    var last = done.length ? done[done.length - 1] : null;
    var upcoming = sessions.filter(function (x) { return x.status === 'scheduled' && x.session_date >= TODAY; });
    var next = upcoming.length ? upcoming[0] : null;
    var b3 = block('Last and next class');
    b3.appendChild(row('Last class', last ? classDate(last.session_date) + (last.topic ? ' — ' + last.topic : '') : 'Nothing yet'));
    b3.appendChild(row('Next class', next ? classDate(next.session_date) + (next.session_time ? ' at ' + next.session_time : '') : 'None scheduled'));
    b3.appendChild(row('Next topic', next && next.topic ? next.topic : 'Not planned yet'));
    grid.appendChild(b3);

    var a = d.attendance;
    var attended = a.present + a.late;
    var marked = attended + a.absent + a.excused;
    var b4 = block('Your attendance');
    if (marked > 0) {
      var pct = Math.round(attended * 100 / marked);
      b4.appendChild(el('p', 'pg-st-big', pct + '%'));
      b4.appendChild(bar(pct, 'Attendance'));
      b4.appendChild(el('p', 'pg-hint', a.present + ' present, ' + a.late + ' late, ' + a.absent + ' absent, ' + a.excused + ' excused'));
    } else {
      b4.appendChild(el('p', 'pg-hint', 'No attendance has been recorded yet.'));
    }
    grid.appendChild(b4);

    var b5 = block('Syllabus progress');
    if (!d.courses.length) b5.appendChild(el('p', 'pg-hint', 'Your teacher has not added a syllabus yet.'));
    d.courses.forEach(function (c) {
      var p = c.module_count ? c.modules_done * 100 / c.module_count : 0;
      b5.appendChild(el('div', 'pg-st-coursename', c.title));
      b5.appendChild(bar(p, c.title + ' progress'));
      b5.appendChild(el('p', 'pg-hint', c.module_count ? c.modules_done + ' of ' + c.module_count + ' modules completed' : 'No modules yet'));
    });
    grid.appendChild(b5);

    var b6 = block('Tests');
    if (d.tests.marked > 0) {
      b6.appendChild(el('p', 'pg-st-big', d.tests.avg_percent + '%'));
      b6.appendChild(bar(d.tests.avg_percent, 'Average test score'));
      b6.appendChild(el('p', 'pg-hint', 'Average over ' + d.tests.marked + (d.tests.marked === 1 ? ' marked test' : ' marked tests')));
    } else {
      b6.appendChild(el('p', 'pg-hint', 'No marked tests yet.'));
    }
    grid.appendChild(b6);
    host.appendChild(grid);
  }

  /* ---------------- Classes ---------------- */
  async function renderClasses(host, my) {
    var sessions = await api('/' + cur.id + '/sessions');
    if (stale(my)) return;
    clear(host);
    panelTitle(host, 'Classes', 'What was taught, what is planned next, and your attendance.');
    if (!sessions.length) { host.appendChild(emptyState('No classes are scheduled yet.')); return; }
    var upcoming = sessions.filter(function (x) { return x.status === 'scheduled' && x.session_date >= TODAY; });
    var history = sessions.filter(function (x) { return !(x.status === 'scheduled' && x.session_date >= TODAY); }).reverse();

    function group(title, list, limit) {
      if (!list.length) return;
      var g = el('div', 'pg-st-group');
      g.appendChild(el('h3', 'pg-st-grouphead', title + ' (' + list.length + ')'));
      var wrap = el('div', 'pg-list');
      (limit && list.length > limit ? list.slice(0, limit) : list).forEach(function (x) { wrap.appendChild(sessionRow(x)); });
      g.appendChild(wrap);
      if (limit && list.length > limit) {
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
    group('Upcoming', upcoming, 6);
    group('Past classes', history, 10);
  }
  function sessionRow(x) {
    var r = el('div', 'pg-row-item pg-session' + (x.status === 'cancelled' ? ' is-cancelled' : ''));
    var info = el('div', 'pg-row-info');
    var line = el('div');
    line.appendChild(el('strong', '', classDate(x.session_date)));
    if (x.session_time) line.appendChild(document.createTextNode(' · ' + x.session_time));
    if (x.status === 'cancelled') line.appendChild(tag('Cancelled', 'muted'));
    else if (x.attendance) line.appendChild(tag(cap(x.attendance), x.attendance === 'present' ? 'ok' : x.attendance === 'absent' ? 'bad' : 'warn'));
    else if (x.session_date < TODAY) line.appendChild(tag('Not marked', 'muted'));
    info.appendChild(line);
    var done = x.session_date < TODAY || !!x.attendance;
    if (x.topic) info.appendChild(el('div', 'pg-row-meta pg-st-topic', (done ? 'Taught: ' : 'Planned: ') + x.topic));
    r.appendChild(info);
    return r;
  }

  /* ---------------- Homework ---------------- */
  async function renderHomework(host, my) {
    var list = await api('/' + cur.id + '/assignments');
    if (stale(my)) return;
    clear(host);
    panelTitle(host, 'Homework', 'Hand in your answers here. You can change an answer until your teacher checks it.');
    if (!list.length) { host.appendChild(emptyState('No homework yet.')); return; }
    var active = cur.data.status === 'active';
    var wrap = el('div', 'pg-list');
    list.forEach(function (a) {
      var r = el('div', 'pg-row-item');
      var info = el('div', 'pg-row-info');
      var line = el('div');
      line.appendChild(el('strong', '', a.title));
      if (a.submission_status === 'reviewed') line.appendChild(tag('Checked', 'ok'));
      else if (a.submission_status === 'submitted') line.appendChild(tag('Handed in', 'warn'));
      else if (a.due_date && String(a.due_date).slice(0, 10) < TODAY) line.appendChild(tag('Overdue', 'bad'));
      else line.appendChild(tag('To do', 'muted'));
      info.appendChild(line);
      if (a.due_date) info.appendChild(el('div', 'pg-row-meta', 'Due ' + classDate(a.due_date)));
      if (a.instructions) info.appendChild(el('div', 'pg-row-meta pg-st-notes', a.instructions));
      if (a.submission_text) info.appendChild(el('div', 'pg-row-meta pg-st-notes', 'Your answer: ' + a.submission_text));
      if (a.feedback) info.appendChild(el('div', 'pg-row-meta pg-st-notes', 'Teacher feedback: ' + a.feedback));
      r.appendChild(info);
      if (active && a.submission_status !== 'reviewed') {
        var side = el('div', 'pg-row-side');
        side.appendChild(btn(a.submission_status === 'submitted' ? 'Change answer' : 'Hand in', a.submission_status === 'submitted' ? 'btn-outline' : 'btn-primary', function () { openSubmitForm(a, this); }, (a.submission_status === 'submitted' ? 'Change answer for ' : 'Hand in ') + a.title));
        r.appendChild(side);
      }
      wrap.appendChild(r);
    });
    host.appendChild(wrap);
  }
  function openSubmitForm(a, opener) {
    openForm({
      title: 'Hand in homework',
      sub: a.title,
      submitLabel: 'Hand in',
      opener: opener,
      fields: [{ name: 'text', label: 'Your answer', type: 'textarea', rows: 6, required: true, value: a.submission_text || '', maxlength: 3000, placeholder: 'Write your answer here', hint: 'Up to 3000 characters.' }],
      onSubmit: async function (v) {
        var res = await api('/' + cur.id + '/assignments/' + a.id + '/submit', 'POST', { text: v.text });
        toast(res.message || 'Homework handed in.');
        renderPanel();
      }
    });
  }

  /* ---------------- Tests ---------------- */
  async function renderTests(host, my) {
    var list = await api('/' + cur.id + '/tests');
    if (stale(my)) return;
    clear(host);
    panelTitle(host, 'Tests', 'Your test marks.');
    if (!list.length) { host.appendChild(emptyState('No tests yet.')); return; }
    var marked = list.filter(function (t) { return t.marks_obtained !== null; });
    if (marked.length) {
      var avg = marked.reduce(function (s, t) { return s + t.marks_obtained * 100 / t.max_marks; }, 0) / marked.length;
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
        info.appendChild(el('div', 'pg-row-meta', 'Out of ' + t.max_marks + ' · marks not added yet'));
      }
      if (t.remarks) info.appendChild(el('div', 'pg-row-meta pg-st-notes', t.remarks));
      r.appendChild(info);
      wrap.appendChild(r);
    });
    host.appendChild(wrap);
  }

  /* ---------------- Go ---------------- */
  route();
})();