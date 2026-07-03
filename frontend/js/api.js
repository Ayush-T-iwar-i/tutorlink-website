// ===========================================
// TutorLink — Shared API helper
// All fetch() calls to the backend go through here
// ===========================================

const API_BASE = ''; // same origin — backend serves this frontend too

async function apiRequest(path, method = 'GET', body = null) {
  const session = getSession();

  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };

  // Automatically attach the login token to every request, if we have one
  if (session && session.token) {
    options.headers['Authorization'] = `Bearer ${session.token}`;
  }

  if (body) options.body = JSON.stringify(body);

  const res = await fetch(API_BASE + path, options);
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    // Session expired or invalid — send the user back to login
    clearSession();
    window.location.href = 'login.html';
    throw new Error('Session expired. Please log in again.');
  }

  if (!res.ok) {
    throw new Error(data.error || 'Something went wrong. Please try again.');
  }
  return data;
}

// ---------- Session helpers ----------
function saveSession(user, token) {
  sessionStorage.setItem('tl_token', token);
  sessionStorage.setItem('tl_user', JSON.stringify(user));
}

function getSession() {
  const token = sessionStorage.getItem('tl_token');
  const user = sessionStorage.getItem('tl_user');
  return token && user ? { token, user: JSON.parse(user) } : null;
}

function clearSession() {
  sessionStorage.removeItem('tl_token');
  sessionStorage.removeItem('tl_user');
}

function requireLogin(expectedRole) {
  const session = getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }
  if (expectedRole && session.user.role !== expectedRole) {
    window.location.href = 'login.html';
    return null;
  }
  return session;
}
