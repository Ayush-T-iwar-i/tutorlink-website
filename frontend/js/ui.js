// ===========================================
// TutorLink — Shared UI helpers
// Handles: mobile nav, navbar scroll state,
//          scroll-reveal, and utility functions
// ===========================================

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

  // Close mobile menu on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && navLinks.classList.contains('mobile-open')) {
      navLinks.classList.remove('mobile-open');
      navToggle.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
      navToggle.focus();
    }
  });

  // Navbar scroll state
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

/* ---------- Scroll-reveal IntersectionObserver ---------- */
function initScrollReveal() {
  if (!window.IntersectionObserver) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.1,
    rootMargin: '0px 0px -40px 0px',
  });

  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
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
  initMobileNav();
  initScrollReveal();
  updateNavForLoggedInUser();
});
