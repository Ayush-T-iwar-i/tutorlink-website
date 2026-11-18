/* GharTutor home page: header that hides on scroll down, light reveal-on-scroll, dashboard-aware buttons. */
(function () {
  'use strict';

  var nav = document.getElementById('mainNav');
  var root = document.documentElement;

  /* ---------- header: slides away when scrolling down, returns on scroll up ---------- */
  var lastY = window.pageYOffset;
  var ticking = false;
  function navSync() {
    ticking = false;
    if (!nav) return;
    var toggle = document.getElementById('navToggle');
    var menuOpen = toggle && toggle.getAttribute('aria-expanded') === 'true';
    var y = window.pageYOffset;
    var dy = y - lastY;
    if (y < 80 || menuOpen || dy < -6) nav.classList.remove('nav-hidden');
    else if (dy > 6) nav.classList.add('nav-hidden');
    if (Math.abs(dy) > 6 || y < 80) lastY = y;
  }
  window.addEventListener('scroll', function () {
    if (!ticking) { ticking = true; window.requestAnimationFrame(navSync); }
  }, { passive: true });
  if (nav) nav.addEventListener('focusin', function () { nav.classList.remove('nav-hidden'); });

  /* ---------- reveal on scroll (opacity/transform only) ---------- */
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if ('IntersectionObserver' in window && !reduce) {
    var items = document.querySelectorAll('.hm-steps li, .hm-feat, .hm-checks li, .hm-band, .hm-faq details, .hm-chips a');
    if (items.length) {
      root.classList.add('hm-js');
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
      items.forEach(function (el) { el.classList.add('hm-reveal'); io.observe(el); });
      // Safety net: never leave content hidden if the observer does not fire.
      window.setTimeout(function () {
        items.forEach(function (el) { el.classList.add('in'); });
      }, 2500);
    }
  }

  /* ---------- logged-in visitors: buttons go to their dashboard ---------- */
  try {
    var user = typeof getSession === 'function' ? getSession() : null;
    if (user && user.role) {
      var home = user.role === 'teacher' ? 'teacher-dashboard.html'
        : user.role === 'admin' ? 'admin-dashboard.html' : 'student-dashboard.html';
      var label = 'Go to your dashboard';
      ['heroStudentBtn', 'heroTeacherBtn', 'ctaStudentBtn', 'ctaTeacherBtn', 'teachBtn'].forEach(function (id) {
        var a = document.getElementById(id);
        if (!a) return;
        if (id === 'heroTeacherBtn' || id === 'ctaTeacherBtn') { a.hidden = true; return; }
        a.setAttribute('href', home);
        a.textContent = label;
      });
    }
  } catch (e) { /* buttons keep their sign-up links */ }
})();