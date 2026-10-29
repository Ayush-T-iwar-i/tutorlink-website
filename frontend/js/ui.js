// ===========================================
// TutorLink — Shared UI helpers + Motion Layer
// Mobile nav, scroll-reveal, micro-interactions,
// page enter, stagger lists, toasts, reduced-motion
// ===========================================

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- Mobile Navigation ---------- */
function initMobileNav() {
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');
  const mainNav = document.getElementById('mainNav');

  if (!navToggle || !navLinks) return;

  navToggle.addEventListener('click', () => {
    const isOpen = navLinks.classList.contains('mobile-open');
    navLinks.classList.toggle('mobile-open', !isOpen);
    navToggle.classList.toggle('open', !isOpen);
    navToggle.setAttribute('aria-expanded', String(!isOpen));
    document.body.style.overflow = isOpen ? '' : 'hidden';
  });

  navLinks.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => {
      navLinks.classList.remove('mobile-open');
      navToggle.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && navLinks.classList.contains('mobile-open')) {
      navLinks.classList.remove('mobile-open');
      navToggle.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
      navToggle.focus();
    }
  });

  if (mainNav) {
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          mainNav.classList.toggle('scrolled', window.scrollY > 12);
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });
  }
}

/* ---------- Scroll-reveal (enhanced) ---------- */
function initScrollReveal() {
  if (!window.IntersectionObserver) {
    document.querySelectorAll('.reveal').forEach(el => el.classList.add('visible'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.12,
    rootMargin: '0px 0px -48px 0px',
  });

  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
}

/* ---------- Page enter animation ---------- */
function initPageEnter() {
  if (prefersReducedMotion()) {
    document.body.classList.add('page-ready');
    return;
  }
  requestAnimationFrame(() => {
    document.body.classList.add('page-enter');
    requestAnimationFrame(() => {
      document.body.classList.add('page-ready');
    });
  });
}

/* ---------- Stagger children (lists / grids) ---------- */
function initStagger() {
  if (prefersReducedMotion()) {
    document.querySelectorAll('[data-stagger]').forEach(parent => {
      parent.querySelectorAll(':scope > *').forEach(child => {
        child.classList.add('stagger-visible');
      });
    });
    return;
  }

  if (!window.IntersectionObserver) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const parent = entry.target;
      const kids = parent.querySelectorAll(':scope > *');
      kids.forEach((child, i) => {
        child.style.setProperty('--stagger-i', String(i));
        child.classList.add('stagger-item');
        requestAnimationFrame(() => {
          child.classList.add('stagger-visible');
        });
      });
      observer.unobserve(parent);
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });

  document.querySelectorAll('[data-stagger]').forEach(el => observer.observe(el));
}

/* ---------- Micro-interactions: buttons & cards ---------- */
function initMicroInteractions() {
  if (prefersReducedMotion()) return;

  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.btn-primary, .btn-accent, .btn-danger');
    if (!btn || btn.disabled || btn.classList.contains('btn-loading')) return;

    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'btn-ripple';
    const size = Math.max(rect.width, rect.height) * 1.2;
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  }, { passive: true });

  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.btn, .panel, .subject-card, .trust-card, .testimonial-card, .stat-item');
    if (el) el.classList.add('is-pressed');
  });
  document.addEventListener('pointerup', () => {
    document.querySelectorAll('.is-pressed').forEach(el => el.classList.remove('is-pressed'));
  });
  document.addEventListener('pointercancel', () => {
    document.querySelectorAll('.is-pressed').forEach(el => el.classList.remove('is-pressed'));
  });
}

/* ---------- Enhanced toast ---------- */
function enhanceToast() {
  const original = window.toast || (typeof showToast === 'function' ? showToast : null);
  if (!original && typeof showToast !== 'function') {
    window.toast = function (message, isError) {
      let el = document.getElementById('toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        el.className = 'toast';
        document.body.appendChild(el);
      }
      el.classList.remove('show', 'hiding', 'error', 'success');
      void el.offsetWidth;
      el.textContent = message;
      el.className = 'toast show' + (isError ? ' error' : ' success');
      clearTimeout(el._hideTimer);
      el._hideTimer = setTimeout(() => {
        el.classList.add('hiding');
        el.classList.remove('show');
        setTimeout(() => { el.className = 'toast'; }, 320);
      }, 2800);
    };
    return;
  }

  window.toast = function (message, isError) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.classList.remove('show', 'hiding', 'error', 'success');
    void el.offsetWidth;
    el.textContent = message;
    el.className = 'toast show' + (isError ? ' error' : ' success');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      el.classList.add('hiding');
      el.classList.remove('show');
      setTimeout(() => { el.className = 'toast'; }, 320);
    }, 2800);
  };
}

/* ---------- Form focus polish ---------- */
function initFormMotion() {
  document.querySelectorAll('.form-group input, .form-group select, .form-group textarea').forEach(input => {
    const group = input.closest('.form-group');
    if (!group) return;
    input.addEventListener('focus', () => group.classList.add('is-focused'));
    input.addEventListener('blur', () => group.classList.remove('is-focused'));
  });
}

/* ---------- Smooth internal anchor scroll ---------- */
function initSmoothAnchors() {
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    const id = a.getAttribute('href');
    if (!id || id === '#') return;
    const target = document.querySelector(id);
    if (!target) return;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    });
  });
}

/* ---------- Dynamic nav state (logged-in user) ---------- */
function updateNavForLoggedInUser() {
  const session = typeof getSession === 'function' ? getSession() : null;
  if (!session || !session.user) return;

  const dashboardLink =
    session.user.role === 'teacher' ? 'teacher-dashboard.html' :
    session.user.role === 'admin'   ? 'admin-dashboard.html'   :
    'student-dashboard.html';

  const loginBtn  = document.getElementById('navLoginBtn');
  const signupBtn = document.getElementById('navSignupBtn');

  if (loginBtn) loginBtn.remove();
  if (signupBtn) {
    signupBtn.textContent = 'Dashboard →';
    signupBtn.href = dashboardLink;
  }
}

/* ---------- Auto-init on DOM ready ---------- */
document.addEventListener('DOMContentLoaded', () => {
  initPageEnter();
  initMobileNav();
  initScrollReveal();
  initStagger();
  initMicroInteractions();
  enhanceToast();
  initFormMotion();
  initSmoothAnchors();
  updateNavForLoggedInUser();
});
