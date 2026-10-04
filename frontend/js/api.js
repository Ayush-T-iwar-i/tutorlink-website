// ===========================================
// TutorLink — Shared API helper
// All fetch() calls to the backend go through here
// ===========================================

// If served on port 5000 or in production (same origin), use relative paths ("").
// If running on a local Live Server (port 5500, 3000, 8080, etc.), point to localhost:5000.
const isSeparateDevServer = typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' ||
   window.location.hostname === '127.0.0.1') &&
  window.location.port !== '' &&
  window.location.port !== '5000';

const API_BASE = isSeparateDevServer
  ? 'http://localhost:5000'
  : '';

// ---------- silent session refresh ----------
// The access cookie is short-lived (15 minutes). When a protected call answers 401, the httpOnly refresh
// cookie is exchanged for a new one ONCE and the call is repeated, so people are not logged out mid-task.
// Many calls failing at the same moment share a single refresh request (they all wait on one promise).
const NO_REFRESH_PATHS = [
  '/api/auth/login', '/api/auth/signup', '/api/auth/google', '/api/auth/refresh', '/api/auth/logout',
  '/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/verify-email',
];
let refreshInFlight = null;

function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include' })
      .then((r) => r.ok)
      .catch(() => false)
      .then((ok) => {
        setTimeout(() => { refreshInFlight = null; }, 0);
        return ok;
      });
  }
  return refreshInFlight;
}

// Drop-in replacement for fetch() against the TutorLink API: pass the path (e.g. "/api/bookings/student/me"),
// not the full URL. Use it for anything apiRequest cannot do, such as multipart file uploads.
async function apiFetch(path, init = {}) {
  const options = { credentials: 'include', ...init }; // sends the httpOnly cookies
  let res = await fetch(`${API_BASE}${path}`, options);
  if (res.status === 401 && !NO_REFRESH_PATHS.some((p) => path.startsWith(p))) {
    if (await refreshSession()) {
      res = await fetch(`${API_BASE}${path}`, options); // repeat exactly once
    } else {
      localStorage.removeItem(SESSION_USER_KEY); // the login is really gone; pages will send the user to log in
    }
  }
  return res;
}

async function apiRequest(path, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" };

  let response;
  try {
    response = await apiFetch(path, {
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
    if (response.status === 401 && !path.includes('/login') && !path.includes('/signup')) {
      // Session expired or invalidated on a protected call
      // Don't auto-redirect immediately on background polling, but clear stale token
    }
    const message =
      (data && (data.message || data.error)) ||
      defaultErrorFor(response.status);
    throw new Error(message);
  }

  return data;
}

function defaultErrorFor(status) {
  if (status === 401) return "Session expired or invalid credentials. Please log in again.";
  if (status === 403) return "You don't have permission to perform this action.";
  if (status === 404) return "Resource not found.";
  if (status === 409) return "An account or record with these details already exists.";
  if (status === 422) return "Please check the details you entered.";
  if (status === 423) return "Account temporarily locked due to too many failed attempts.";
  if (status === 429) return "Too many requests. Please slow down and try again in a few minutes.";
  if (status >= 500) return "Something went wrong on our end. Please try again shortly.";
  return "Something went wrong. Please try again.";
}

/* ---------- session ---------- */
// The JWT itself now lives only in an httpOnly cookie set by the server —
// it's never stored in localStorage or readable by JS, which closes off
// token theft via XSS. localStorage only keeps the non-sensitive user
// object (name/role/etc.) so pages can show it instantly without an
// extra round trip; actual authorization on every API call is enforced
// server-side via the cookie regardless of what's in localStorage.

const SESSION_USER_KEY = "tutorlink.user";

function saveSession(user) {
  localStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
}

function getSession() {
  const raw = localStorage.getItem(SESSION_USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

function clearSession() {
  localStorage.removeItem(SESSION_USER_KEY);
  // Fire-and-forget: an httpOnly cookie can't be cleared by JS, so the
  // server has to do it. `keepalive` lets this request finish even if the
  // page navigates away (e.g. to login.html) right after this call.
  fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', credentials: 'include', keepalive: true }).catch(() => {});
}

// ---------- XSS-safe text rendering ----------
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- Global toast helper fallback ----------
function showToast(message, isError = false) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { el.className = 'toast'; }, 2800);
}
if (typeof window !== 'undefined' && typeof window.toast !== 'function') {
  window.toast = showToast;
}

/* ---------- Notification bell (shared by student/teacher dashboards) ---------- */
function initNotificationBell() {
  const bell = document.getElementById('notifBell');
  const dropdown = document.getElementById('notifDropdown');
  if (!bell || !dropdown) return;

  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
    if (dropdown.classList.contains('open')) loadNotifications();
  });
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && e.target !== bell) dropdown.classList.remove('open');
  });

  const markAllBtn = document.getElementById('markAllReadBtn');
  if (markAllBtn) {
    markAllBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await apiRequest('/api/notifications/read-all', 'PUT');
        loadNotifications();
      } catch (err) { /* non-blocking */ }
    });
  }

  async function loadNotifications() {
    if (!getSession()) return;
    const list = document.getElementById('notifList');
    const badge = document.getElementById('notifBadge');
    if (!list || !badge) return;

    try {
      const data = await apiRequest('/api/notifications/me');
      if (data.unread_count > 0) {
        badge.style.display = 'flex';
        badge.textContent = data.unread_count > 9 ? '9+' : data.unread_count;
      } else {
        badge.style.display = 'none';
      }

      if (!data.notifications || data.notifications.length === 0) {
        list.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
        return;
      }

      list.innerHTML = data.notifications.map(n => `
        <div class="notif-item ${n.is_read ? '' : 'unread'}" onclick="handleNotificationClick(${n.id}, '${n.link || ''}')">
          ${escapeHtml(n.message)}
          <span class="notif-time">${new Date(n.created_at).toLocaleString()}</span>
        </div>
      `).join('');
    } catch (err) {
      list.innerHTML = '<div class="notif-empty">Could not load notifications.</div>';
    }
  }

  loadNotifications();
  const pollInterval = setInterval(() => {
    if (!getSession()) {
      clearInterval(pollInterval);
      return;
    }
    loadNotifications();
  }, 30000);
}

async function handleNotificationClick(id, link) {
  try { await apiRequest(`/api/notifications/${id}/read`, 'PUT'); } catch (e) { /* non-blocking */ }
  if (link) window.location.href = link;
}

/* ---------- Chat modal (shared by student/teacher dashboards) ---------- */
let _chatPollTimer = null;
let _chatBookingId = null;

function ensureChatModalExists() {
  if (document.getElementById('chatModalBackdrop')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="modal-backdrop" id="chatModalBackdrop">
      <div class="modal modal-booking">
        <div class="modal-header">
          <div>
            <h3 id="chatModalTitle">Chat</h3>
            <p>Messages are only visible to you and the other person on this booking.</p>
          </div>
          <button class="modal-close" id="chatModalClose" aria-label="Close">✕</button>
        </div>
        <div class="modal-body">
          <div class="chat-body" id="chatBody"><div class="chat-empty">Loading messages…</div></div>
          <div class="chat-input-row">
            <input type="text" id="chatInput" placeholder="Type a message…" maxlength="1000">
            <button class="btn btn-primary btn-sm" id="chatSendBtn">Send</button>
          </div>
          <div id="chatMsgBox" class="msg-box"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(div.firstElementChild);

  document.getElementById('chatModalClose').addEventListener('click', closeChatModal);
  document.getElementById('chatSendBtn').addEventListener('click', sendChatMessage);
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); }
  });
}

async function openChatModal(bookingId, otherPersonName) {
  ensureChatModalExists();
  _chatBookingId = bookingId;
  document.getElementById('chatModalTitle').textContent = `Chat with ${otherPersonName}`;
  document.getElementById('chatModalBackdrop').classList.add('open');
  document.getElementById('chatMsgBox').className = 'msg-box';
  await loadChatMessages();
  clearInterval(_chatPollTimer);
  _chatPollTimer = setInterval(loadChatMessages, 5000);
}

function closeChatModal() {
  const backdrop = document.getElementById('chatModalBackdrop');
  if (backdrop) backdrop.classList.remove('open');
  clearInterval(_chatPollTimer);
  _chatBookingId = null;
}

async function loadChatMessages() {
  if (!_chatBookingId) return;
  const body = document.getElementById('chatBody');
  const myId = getSession()?.id;
  try {
    const messages = await apiRequest(`/api/messages/${_chatBookingId}`);
    if (messages.length === 0) {
      body.innerHTML = '<div class="chat-empty">No messages yet — say hello!</div>';
      return;
    }
    const wasAtBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 20;
    body.innerHTML = messages.map(m => `
      <div class="chat-bubble ${m.sender_id === myId ? 'mine' : 'theirs'}">
        ${escapeHtml(m.message)}
        <span class="chat-time">${new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    `).join('');
    if (wasAtBottom) body.scrollTop = body.scrollHeight;
  } catch (err) {
    body.innerHTML = `<div class="chat-empty">${escapeHtml(err.message)}</div>`;
  }
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const msgBox = document.getElementById('chatMsgBox');
  const text = input.value.trim();
  if (!text || !_chatBookingId) return;

  msgBox.className = 'msg-box';
  try {
    await apiRequest(`/api/messages/${_chatBookingId}`, 'POST', { message: text });
    input.value = '';
    await loadChatMessages();
  } catch (err) {
    msgBox.className = 'msg-box error';
    msgBox.textContent = err.message;
  }
}

/* ---------- Report modal (shared) ---------- */
let _reportUserId = null;
let _reportBookingId = null;

function ensureReportModalExists() {
  if (document.getElementById('reportModalBackdrop')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="modal-backdrop" id="reportModalBackdrop">
      <div class="modal modal-booking">
        <div class="modal-header">
          <div>
            <h3 id="reportModalTitle">Report an issue</h3>
            <p>Our team reviews every report. This won't notify the other person.</p>
          </div>
          <button class="modal-close" id="reportModalClose" aria-label="Close">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label for="reportReason">What's the issue?</label>
            <select id="reportReason">
              <option value="no_show">They didn't show up</option>
              <option value="inappropriate_behaviour">Inappropriate behaviour</option>
              <option value="payment_issue">Payment issue</option>
              <option value="fake_profile">Fake or misleading profile</option>
              <option value="other">Something else</option>
            </select>
          </div>
          <div class="form-group">
            <label for="reportDetails">Details</label>
            <textarea id="reportDetails" rows="4" placeholder="Please describe what happened"></textarea>
          </div>
          <div id="reportMsgBox" class="msg-box"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline btn-sm" id="reportModalCancel">Cancel</button>
          <button class="btn btn-primary" id="reportModalConfirm">Submit report</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(div.firstElementChild);

  document.getElementById('reportModalClose').addEventListener('click', closeReportModal);
  document.getElementById('reportModalCancel').addEventListener('click', closeReportModal);
  document.getElementById('reportModalConfirm').addEventListener('click', submitReport);
}

function openReportModal(reportedUserId, reportedName, bookingId) {
  ensureReportModalExists();
  _reportUserId = reportedUserId;
  _reportBookingId = bookingId || null;
  document.getElementById('reportModalTitle').textContent = `Report ${reportedName}`;
  document.getElementById('reportDetails').value = '';
  document.getElementById('reportMsgBox').className = 'msg-box';
  document.getElementById('reportModalBackdrop').classList.add('open');
}

function closeReportModal() {
  const backdrop = document.getElementById('reportModalBackdrop');
  if (backdrop) backdrop.classList.remove('open');
}

async function submitReport() {
  const msgBox = document.getElementById('reportMsgBox');
  const confirmBtn = document.getElementById('reportModalConfirm');
  const reason = document.getElementById('reportReason').value;
  const details = document.getElementById('reportDetails').value.trim();

  confirmBtn.disabled = true;
  confirmBtn.classList.add('btn-loading');
  try {
    await apiRequest('/api/reports', 'POST', {
      reported_user_id: _reportUserId,
      booking_id: _reportBookingId,
      reason,
      details,
    });
    closeReportModal();
    showToast('Report submitted — thank you.');
  } catch (err) {
    msgBox.className = 'msg-box error';
    msgBox.textContent = err.message;
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.classList.remove('btn-loading');
  }
}

function requireLogin(requiredRole = null) {
  const user = getSession();

  if (!user) {
    window.location.href = "login.html";
    return null;
  }

  if (requiredRole && user.role !== requiredRole) {
    const home = user.role === "teacher" ? "teacher-dashboard.html"
      : user.role === "admin" ? "admin-dashboard.html"
      : "student-dashboard.html";
    window.location.href = home;
    return null;
  }

  return { user };
}

// Profile photos used to be stored as a local relative path (e.g.
// "photos/8_photo_123.jpg") served from /uploads/. They're now stored as
// full Cloudinary URLs instead, so uploads survive redeploys. This helper
// makes both formats work: a full URL is used as-is, an old relative path
// still falls back to the local /uploads/ route.
function photoUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  const normalized = cleanPath.startsWith('uploads/') ? cleanPath : `uploads/${cleanPath}`;
  return `${API_BASE}/${normalized}`;
}