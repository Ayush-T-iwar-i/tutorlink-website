// ===========================================
// TutorLink — Shared API helper
// All fetch() calls to the backend go through here
// ===========================================

const API_BASE = 'http://localhost:5000'; // same origin — backend serves this frontend too
/* =====================================================
   TutorLink — API helper + session storage
   ===================================================== */

async function apiRequest(path, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let response;
  try {
   response = await fetch(`${API_BASE}${path}`, {
  method,
  headers,
  body: body ? JSON.stringify(body) : undefined,
});
  } catch (networkErr) {
    throw new Error("Can't reach TutorLink right now. Check your connection and try again.");
  }

  let data = null;
  const text = await response.text();
  if (text) {
    try { data = JSON.parse(text); } catch { /* non-JSON response body */ }
  }

  if (!response.ok) {
    const message =
      (data && (data.message || data.error)) ||
      defaultErrorFor(response.status);
    throw new Error(message);
  }

  return data;
}

function defaultErrorFor(status) {
  if (status === 401) return "That email and password don't match.";
  if (status === 409) return "An account with that email already exists.";
  if (status === 422) return "Please check the details you entered.";
  if (status >= 500) return "Something went wrong on our end. Please try again shortly.";
  return "Something went wrong. Please try again.";
}

/* ---------- session ---------- */

const SESSION_USER_KEY = "tutorlink.user";
const SESSION_TOKEN_KEY = "tutorlink.token";

function saveSession(user, token) {
  localStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
  localStorage.setItem(SESSION_TOKEN_KEY, token);
}

function getSession() {
  const raw = localStorage.getItem(SESSION_USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

function getToken() {
  return localStorage.getItem(SESSION_TOKEN_KEY);
}

function clearSession() {
  localStorage.removeItem(SESSION_USER_KEY);
  localStorage.removeItem(SESSION_TOKEN_KEY);
}




function requireLogin(requiredRole = null) {
  const user = getSession();
  const token = getToken();

  if (!user || !token) {
    window.location.href = "login.html";
    return null;
  }

  if (requiredRole && user.role !== requiredRole) {
    window.location.href = "login.html";
    return null;
  }

  return {
    user,
    token
  };
}