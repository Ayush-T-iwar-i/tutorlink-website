/* Teacher dashboard: section navigation bar, running classes and "subjects I teach".
   Runs after teacher-dashboard.js and only talks to existing API routes. */
(function () {
  'use strict';

  var session = typeof getSession === 'function' ? getSession() : null;
  if (!session || session.role !== 'teacher') return;

  var USER_ID = session.id;
  var SUGGESTIONS = ['Mathematics', 'Science', 'Physics', 'Chemistry', 'Biology', 'English', 'Hindi', 'Computer Science'];
  var MAX_SUBJECTS = 12;
  var MAX_SUBJECT_LEN = 40;
  var MAX_TOTAL_LEN = 255; // the server's limit for the whole subjects text

  function $(id) { return document.getElementById(id); }
  function esc(v) { return escapeHtml(v); }

  // ============================================================
  // Side navigation: one view at a time
  // ============================================================
  var rail = $('tnRail');
  var navLinks = Array.prototype.slice.call(rail.querySelectorAll('.tn-nav'));
  var header = document.querySelector('.dashboard-header');

  // route -> which view to show (and, for the two request links, which filter of the requests card)
  var ROUTES = {
    'overview': { view: 'overview' },
    'requests-new': { view: 'requests', filter: 'requested' },
    'requests-accepted': { view: 'requests', filter: 'accepted' },
    'running': { view: 'running' },
    'subjects': { view: 'subjects' },
    'schedule': { view: 'schedule' },
    'courses': { view: 'courses' },
    'reviews': { view: 'reviews' },
    'earnings': { view: 'earnings' },
    'profile': { view: 'profile' }
  };
  var VIEW_NAMES = ['overview', 'requests', 'running', 'subjects', 'schedule', 'courses', 'reviews', 'earnings', 'profile'];
  // dashboard cards -> the route that shows them (used by the quick actions and the "needs attention" strip)
  var SECTION_ROUTE = {
    'sec-requests': 'requests-new', 'sec-running': 'running', 'sec-subjects': 'subjects', 'sec-schedule': 'schedule',
    'sec-courses': 'courses', 'sec-reviews': 'reviews', 'sec-earnings': 'earnings', 'sec-profile': 'profile'
  };
  var currentRoute = null;

  function placeRail() {
    var h = header ? Math.round(header.getBoundingClientRect().height) : 60;
    rail.parentNode.style.setProperty('--tn-top', h + 'px');
  }
  placeRail();
  window.addEventListener('resize', placeRail);
  window.addEventListener('load', placeRail);

  function activeRequestFilter() {
    var on = document.querySelector('#sec-requests .pg-tab.is-on');
    return on ? on.getAttribute('data-filter') : 'all';
  }

  function highlight(route) {
    var target = null;
    navLinks.forEach(function (a) {
      var on = a.getAttribute('data-route') === route;
      if (on) { a.setAttribute('aria-current', 'page'); target = a; } else a.removeAttribute('aria-current');
    });
    if (target && window.innerWidth <= 960 && target.scrollIntoView) {
      try { target.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) { /* older browsers */ }
    }
  }

  // Shows a view synchronously. Returns true when the route is known.
  function showRoute(route, focusHeading) {
    var r = ROUTES[route];
    if (!r) return false;
    currentRoute = route;
    VIEW_NAMES.forEach(function (v) { var el = $('view-' + v); if (el) el.hidden = v !== r.view; });
    if (r.filter) {
      var tab = document.querySelector('#sec-requests .pg-tab[data-filter="' + r.filter + '"]');
      if (tab && activeRequestFilter() !== r.filter) tab.click();
    }
    highlight(route);
    if (focusHeading) {
      window.scrollTo(0, 0);
      var h = document.querySelector('#view-' + r.view + ' h2');
      if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    }
    return true;
  }

  function routeFromHash() {
    var name = location.hash.replace(/^#/, '');
    return ROUTES[name] ? name : null;
  }

  // Used by teacher-dashboard.js (quick actions, "needs attention") before it scrolls to a card.
  window.tnShow = function (sectionId) {
    var route = SECTION_ROUTE[sectionId];
    if (!route) return false;
    if (sectionId === 'sec-requests') {
      var f = activeRequestFilter();
      route = f === 'accepted' ? 'requests-accepted' : 'requests-new';
    }
    showRoute(route, false);
    if (history.replaceState) history.replaceState(null, '', '#' + route);
    return true;
  };

  navLinks.forEach(function (a) {
    a.addEventListener('click', function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // let "open in a new tab" work
      e.preventDefault();
      var route = a.getAttribute('data-route');
      showRoute(route, true);
      if (history.pushState && location.hash !== '#' + route) history.pushState(null, '', '#' + route);
    });
  });
  window.addEventListener('hashchange', function () {
    var route = routeFromHash();
    if (route) showRoute(route, true);
  });
  // Keep the highlight right when the teacher switches the filter inside the requests card.
  document.addEventListener('click', function (e) {
    if (!(e.target.closest && e.target.closest('#sec-requests .pg-tab'))) return;
    window.setTimeout(function () {
      if (currentRoute && ROUTES[currentRoute].view === 'requests') {
        var f = activeRequestFilter();
        highlight(f === 'accepted' ? 'requests-accepted' : f === 'requested' ? 'requests-new' : '');
      }
    }, 0);
  });

  showRoute(routeFromHash() || 'overview', false);

  // ============================================================
  // Counts + running classes (one small fetch each, refreshed every minute)
  // ============================================================
  function setCount(id, n, alertStyle) {
    var el = $(id);
    el.textContent = String(n);
    el.hidden = !(n > 0);
  }

  function fmtDate(d) {
    var s = String(d || '').slice(0, 10);
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return '';
    var dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return dt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function fmtTime(t) {
    var m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
    if (!m) return '';
    var h = Number(m[1]);
    return (h % 12 || 12) + ':' + m[2] + ' ' + (h >= 12 ? 'PM' : 'AM');
  }
  function initials(name) {
    return String(name || '').split(/\s+/).filter(Boolean).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase() || '?';
  }

  function renderRunning(students, today) {
    var area = $('runningArea');
    var active = students.filter(function (s) { return s.status === 'active'; });
    setCount('cntRunning', active.length);

    if (active.length === 0) {
      area.innerHTML = '<div class="pg-empty pg-empty-sm">No running classes yet. When you accept a recurring request, the student appears here.</div>';
      return;
    }

    // Students who need attention first: unmarked classes, then fees due, then the soonest next class.
    active.sort(function (a, b) {
      var an = (a.unmarked_classes > 0 ? 0 : a.fees_due_count > 0 ? 1 : 2);
      var bn = (b.unmarked_classes > 0 ? 0 : b.fees_due_count > 0 ? 1 : 2);
      if (an !== bn) return an - bn;
      return String(a.next_class_date || '9999').localeCompare(String(b.next_class_date || '9999'));
    });

    var shown = active.slice(0, 6);
    var html = '<ul class="tn-list">';
    shown.forEach(function (s) {
      var next = s.next_class_date ? fmtDate(s.next_class_date) + (s.next_class_time ? ', ' + fmtTime(s.next_class_time) : '') : 'No class scheduled';
      var tags = '';
      if (s.unmarked_classes > 0) tags += '<span class="tn-tag is-warn">' + s.unmarked_classes + ' to mark</span>';
      if (s.fees_due_count > 0) tags += '<span class="tn-tag is-warn">Fee due</span>';
      else if (s.fee_this_month === 'paid') tags += '<span class="tn-tag is-ok">Fee paid</span>';
      tags += '<span class="tn-tag">' + s.classes_attended + ' attended</span>';
      html += '<li><a class="tn-run" href="teacher-students.html?id=' + encodeURIComponent(s.id) + '">' +
        '<span class="tn-run-av" aria-hidden="true">' + esc(initials(s.student_name)) + '</span>' +
        '<span class="tn-run-main"><p class="tn-run-name">' + esc(s.student_name) + '</p>' +
        '<p class="tn-run-meta">' + esc(s.subject || 'Subject') + ' &middot; Next: ' + esc(next) + '</p></span>' +
        '<span class="tn-run-tags">' + tags + '</span></a></li>';
    });
    html += '</ul>';
    if (active.length > shown.length) {
      html += '<div class="tn-more"><span>Showing ' + shown.length + ' of ' + active.length + ' students.</span><a href="teacher-students.html">See all students &rarr;</a></div>';
    }
    area.innerHTML = html;
  }

  // ============================================================
  // Overview: tiles, quick actions, upcoming classes, latest requests, profile tips
  // ============================================================
  var ovData = { bookings: null, students: null };
  var ovBox = $('tnOverview');

  function tile(href, num, label, hint, warn) {
    return '<a class="tn-tile' + (warn && num > 0 ? ' is-warn' : '') + '" href="' + href + '"><span class="tn-tile-num">' + num + '</span>' +
      '<span class="tn-tile-label">' + esc(label) + '</span><span class="tn-tile-hint">' + esc(hint) + '</span></a>';
  }
  function statusTag(st) {
    var map = { requested: ['New', 'is-warn'], accepted: ['Accepted', 'is-ok'], completed: ['Completed', ''], declined: ['Declined', ''], cancelled: ['Cancelled', ''] };
    var m = map[st] || [String(st || 'Unknown'), ''];
    return '<span class="tn-tag ' + m[1] + '">' + esc(m[0]) + '</span>';
  }

  function tipsHtml() {
    if (!record) return '';
    var n = parseSubjects(record.subjects).length;
    var items = [
      [n >= 3, 'List at least 3 subjects', '#subjects', 'Students search by subject.'],
      [!!String(record.bio || '').trim(), 'Write a short bio', 'teacher-complete-profile.html', 'A bio builds trust before the first class.'],
      [!!String(record.languages || '').trim(), 'Add the languages you teach in', 'teacher-complete-profile.html', 'Helps families pick the right fit.'],
      [!!String(record.grades || '').trim(), 'Set the grades you teach', 'teacher-complete-profile.html', 'Shows you in the right searches.'],
      [record.verification_status === 'approved', 'Get your profile verified', 'teacher-complete-profile.html', 'Verified teachers get more requests.']
    ];
    var done = items.filter(function (i) { return i[0]; }).length;
    var rows = items.map(function (i) {
      return '<li class="' + (i[0] ? 'is-done' : '') + '"><span class="tn-check" aria-hidden="true">' + (i[0] ? '&#10003;' : '') + '</span>' +
        (i[0] ? '<span>' + esc(i[1]) + '</span>' : '<a href="' + i[2] + '">' + esc(i[1]) + '</a><small>' + esc(i[3]) + '</small>') + '</li>';
    }).join('');
    return '<section class="tn-panel"><h3>Grow your profile <span class="tn-pill">' + done + '/' + items.length + '</span></h3>' +
      '<div class="tn-bar" role="progressbar" aria-valuemin="0" aria-valuemax="' + items.length + '" aria-valuenow="' + done + '" aria-label="Profile checklist"><span style="width:' + Math.round(done / items.length * 100) + '%"></span></div>' +
      '<ul class="tn-tips">' + rows + '</ul></section>';
  }

  function renderOverview() {
    var b = ovData.bookings, st = ovData.students;
    var active = st ? st.filter(function (s) { return s.status === 'active'; }) : [];
    var newCount = b ? b.filter(function (x) { return x.status === 'requested'; }).length : 0;
    var toMark = active.reduce(function (a, s) { return a + (Number(s.unmarked_classes) || 0); }, 0);
    var feesDue = active.filter(function (s) { return s.fees_due_count > 0; }).length;

    var html = '<div class="tn-tiles">' +
      tile('#requests-new', b ? newCount : '–', 'New requests', newCount ? 'Reply soon to win them' : 'Nothing waiting', true) +
      tile('#running', st ? active.length : '–', 'Active students', 'Running classes', false) +
      tile('#running', st ? toMark : '–', 'Classes to mark', toMark ? 'Mark attendance' : 'All up to date', true) +
      tile('#running', st ? feesDue : '–', 'Fees due', feesDue ? 'Students with pending fees' : 'No pending fees', true) +
      '</div>';

    html += '<section class="tn-panel"><h3>Quick actions</h3><div class="tn-actions">' +
      '<a href="#requests-new"><b>Review requests</b><span>Accept or decline new students</span></a>' +
      '<a href="#subjects"><b>Add subjects</b><span>Reach more students</span></a>' +
      '<a href="#schedule"><b>Open schedule</b><span>See your week</span></a>' +
      '<a href="#courses"><b>Manage courses</b><span>Modules and enrolments</span></a>' +
      '<a href="teacher-students.html"><b>My students</b><span>Progress, attendance, fees</span></a>' +
      '<a href="account-settings.html"><b>Account settings</b><span>Email, password, phone</span></a>' +
      '</div></section>';

    var up = active.filter(function (s) { return s.next_class_date; }).sort(function (a, c) {
      return (String(a.next_class_date) + String(a.next_class_time || '')).localeCompare(String(c.next_class_date) + String(c.next_class_time || ''));
    }).slice(0, 5);
    var upHtml = !st ? '<p class="pg-hint">Loading&hellip;</p>' : up.length ? '<ul class="tn-mini">' + up.map(function (s) {
      return '<li><a href="teacher-students.html?id=' + encodeURIComponent(s.id) + '"><span class="tn-mini-main">' + esc(s.student_name) + '<small>' + esc(s.subject || '') + '</small></span><span class="tn-mini-when">' + esc(fmtDate(s.next_class_date)) + (s.next_class_time ? '<small>' + esc(fmtTime(s.next_class_time)) + '</small>' : '') + '</span></a></li>';
    }).join('') + '</ul>' : '<p class="pg-hint">No upcoming classes yet.</p>';

    var latest = b ? b.slice().sort(function (a, c) { return String(c.created_at || '').localeCompare(String(a.created_at || '')); }).slice(0, 5) : [];
    var latHtml = !b ? '<p class="pg-hint">Loading&hellip;</p>' : latest.length ? '<ul class="tn-mini">' + latest.map(function (x) {
      var route = x.status === 'accepted' ? '#requests-accepted' : '#requests-new';
      return '<li><a href="' + route + '"><span class="tn-mini-main">' + esc(x.student_name || 'Student') + '<small>' + esc(x.subject || '') + '</small></span><span class="tn-mini-when">' + statusTag(x.status) + '</span></a></li>';
    }).join('') + '</ul>' : '<p class="pg-hint">No requests yet. Complete your profile to get discovered.</p>';

    html += '<div class="tn-two"><section class="tn-panel"><h3>Upcoming classes</h3>' + upHtml + '</section>' +
      '<section class="tn-panel"><h3>Latest requests</h3>' + latHtml + '</section></div>';
    html += tipsHtml();
    ovBox.innerHTML = html;
  }
  renderOverview();

  var lastRefresh = 0;
  async function refreshCounts() {
    lastRefresh = Date.now();
    try {
      var bookings = await apiRequest('/api/bookings/teacher/me');
      if (Array.isArray(bookings)) {
        setCount('cntNew', bookings.filter(function (b) { return b.status === 'requested'; }).length);
        setCount('cntAccepted', bookings.filter(function (b) { return b.status === 'accepted'; }).length);
        ovData.bookings = bookings; renderOverview();
      }
    } catch (e) { /* counts simply stay hidden; the requests card shows its own error */ }
    try {
      var data = await apiRequest('/api/my-students');
      ovData.students = Array.isArray(data && data.students) ? data.students : [];
      renderRunning(ovData.students);
      renderOverview();
    } catch (e) {
      $('runningArea').innerHTML = '<div class="pg-empty pg-empty-sm">Could not load your running classes. <button type="button" class="btn btn-outline btn-sm" id="runningRetry">Try again</button></div>';
      var retry = $('runningRetry');
      if (retry) retry.addEventListener('click', refreshCounts);
    }
  }
  refreshCounts();
  window.setInterval(function () { if (!document.hidden) refreshCounts(); }, 60000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - lastRefresh > 20000) refreshCounts();
  });
  // After the teacher accepts or declines a request, the counts should follow.
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#bookingsArea button')) window.setTimeout(refreshCounts, 1500);
  });

  // ============================================================
  // Subjects I teach
  // ============================================================
  var subjArea = $('subjectsArea');
  var record = null;     // the full teacher row; the profile endpoint replaces every field, so we send them all back
  var subjects = [];
  var saved = [];        // what the server has now, to know whether there is anything to save

  function parseSubjects(text) {
    var seen = {};
    return String(text || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) {
      var k = s.toLowerCase();
      if (!s || seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }
  function joined(list) { return list.join(', '); }
  function dirty() { return joined(subjects) !== joined(saved); }

  function paintSubjects(statusKind, statusText) {
    var chips = subjects.map(function (s, i) {
      return '<li class="tn-chip">' + esc(s) + '<button type="button" data-remove="' + i + '" aria-label="Remove ' + esc(s) + '">&times;</button></li>';
    }).join('');
    var free = SUGGESTIONS.filter(function (s) {
      return subjects.map(function (x) { return x.toLowerCase(); }).indexOf(s.toLowerCase()) === -1;
    }).slice(0, 6);
    subjArea.innerHTML =
      '<ul class="tn-chips" aria-label="Your subjects">' + (chips || '<li class="pg-hint">No subjects yet. Add the first one below.</li>') + '</ul>' +
      '<form class="tn-add" id="subjForm" novalidate>' +
        '<label class="sr-only" for="subjInput" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);">Add a subject</label>' +
        '<input type="text" id="subjInput" maxlength="' + MAX_SUBJECT_LEN + '" placeholder="e.g. Accountancy" autocomplete="off">' +
        '<button type="submit" class="btn btn-outline">Add subject</button>' +
      '</form>' +
      (free.length ? '<div class="tn-suggest"><span>Quick add:</span>' + free.map(function (s) { return '<button type="button" data-suggest="' + esc(s) + '">+ ' + esc(s) + '</button>'; }).join('') + '</div>' : '') +
      '<div class="tn-save"><button type="button" class="btn btn-primary" id="subjSave"' + (dirty() ? '' : ' disabled') + '>Save subjects</button>' +
      '<p class="tn-status" id="subjStatus" role="status" aria-live="polite"' + (statusKind ? ' data-kind="' + statusKind + '"' : '') + '>' + esc(statusText || (dirty() ? 'You have unsaved changes.' : '')) + '</p></div>';
  }

  function addSubject(raw) {
    var name = String(raw || '').replace(/\s+/g, ' ').trim();
    if (name) name = name.charAt(0).toUpperCase() + name.slice(1);
    if (!name) { paintSubjects('error', 'Type a subject first.'); return; }
    if (name.length > MAX_SUBJECT_LEN) { paintSubjects('error', 'A subject name can have at most ' + MAX_SUBJECT_LEN + ' characters.'); return; }
    if (/[<>]/.test(name)) { paintSubjects('error', 'Subject names cannot contain < or >.'); return; }
    if (subjects.some(function (s) { return s.toLowerCase() === name.toLowerCase(); })) { paintSubjects('error', name + ' is already in your list.'); return; }
    if (subjects.length >= MAX_SUBJECTS) { paintSubjects('error', 'You can list up to ' + MAX_SUBJECTS + ' subjects.'); return; }
    if (joined(subjects.concat([name])).length > MAX_TOTAL_LEN) { paintSubjects('error', 'Your subject list is too long. Remove one first.'); return; }
    subjects.push(name);
    paintSubjects();
    var input = $('subjInput');
    if (input) input.focus();
  }

  async function saveSubjects() {
    var btn = $('subjSave');
    if (!btn || !record) return;
    if (subjects.length === 0) { paintSubjects('error', 'Keep at least one subject, students search by subject.'); return; }
    btn.disabled = true;
    btn.classList.add('btn-loading');
    function v(x) { return x === null || x === undefined ? '' : x; }
    try {
      // The endpoint replaces the whole profile, so every other field goes back unchanged.
      await apiRequest('/api/teachers/' + encodeURIComponent(USER_ID) + '/profile', 'PUT', {
        qualification: v(record.qualification),
        subjects: joined(subjects),
        grades: v(record.grades),
        experience_years: record.experience_years || 0,
        fee_per_hour: record.fee_per_hour || 0,
        languages: v(record.languages),
        bio: v(record.bio),
        address: v(record.address),
        city: v(record.city),
        available_slots: v(record.available_slots)
      });
      record.subjects = joined(subjects);
      saved = subjects.slice();
      paintSubjects('ok', 'Subjects saved. Students can now find you under these subjects.');
    } catch (err) {
      paintSubjects('error', (err && err.message) || 'Could not save your subjects. Please try again.');
    }
  }

  subjArea.addEventListener('click', function (e) {
    var rm = e.target.closest('[data-remove]');
    if (rm) { subjects.splice(Number(rm.getAttribute('data-remove')), 1); paintSubjects(); return; }
    var sg = e.target.closest('[data-suggest]');
    if (sg) { addSubject(sg.getAttribute('data-suggest')); return; }
    if (e.target.closest('#subjSave')) saveSubjects();
  });
  subjArea.addEventListener('submit', function (e) {
    e.preventDefault();
    addSubject($('subjInput').value);
  });

  // Warn before leaving with unsaved subject changes.
  window.addEventListener('beforeunload', function (e) {
    if (record && dirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  async function loadSubjects() {
    try {
      record = await apiRequest('/api/teachers/by-user/' + encodeURIComponent(USER_ID));
      saved = parseSubjects(record.subjects);
      subjects = saved.slice();
      paintSubjects();
      renderOverview();
    } catch (err) {
      subjArea.innerHTML = '<div class="pg-empty pg-empty-sm">' +
        (err && /not found/i.test(err.message || '') ? 'Complete your teacher profile first, then you can manage your subjects here. <a href="teacher-complete-profile.html">Complete profile</a>' : 'Could not load your subjects. <button type="button" class="btn btn-outline btn-sm" id="subjRetry">Try again</button>') + '</div>';
      var retry = $('subjRetry');
      if (retry) retry.addEventListener('click', loadSubjects);
    }
  }
  loadSubjects();
})();