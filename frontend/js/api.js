// ===========================================
// TutorLink — Shared API helper
// All fetch() calls to the backend go through here
// ===========================================

const API_BASE = 'http://localhost:5000'; // same origin — backend serves this frontend too


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
 
// ---------- XSS-safe text rendering ----------
// Use this whenever inserting user-entered text (names, bios, comments,
// subjects, etc.) into innerHTML. Never trust that data from the database
// is "safe" just because it came from your own API — it started as
// unescaped user input at signup/profile time.
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
 
/* ---------- Notification bell (shared by student/teacher dashboards) ----------
   Call initNotificationBell() once on any page that has the
   #notifBell / #notifDropdown / #notifList / #notifBadge markup. */
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
 
  document.getElementById('markAllReadBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await apiRequest('/api/notifications/read-all', 'PUT');
      loadNotifications();
    } catch (err) { /* non-blocking */ }
  });
 
  async function loadNotifications() {
    const list = document.getElementById('notifList');
    const badge = document.getElementById('notifBadge');
    try {
      const data = await apiRequest('/api/notifications/me');
      if (data.unread_count > 0) {
        badge.style.display = 'flex';
        badge.textContent = data.unread_count > 9 ? '9+' : data.unread_count;
      } else {
        badge.style.display = 'none';
      }
 
      if (data.notifications.length === 0) {
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
 
  // Poll every 30s so the badge count stays roughly fresh without a full page reload
  loadNotifications();
  setInterval(loadNotifications, 30000);
}
 
async function handleNotificationClick(id, link) {
  try { await apiRequest(`/api/notifications/${id}/read`, 'PUT'); } catch (e) { /* non-blocking */ }
  if (link) window.location.href = link;
}
 
/* ---------- Chat modal (shared by student/teacher dashboards) ----------
   Call openChatModal(bookingId, otherPersonName) from a button's onclick.
   Builds its own modal markup the first time it's used, so no HTML
   needs to be duplicated into every dashboard page. */
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
 
 
 
 
function requireLogin(requiredRole = null) {
  const user = getSession();
  const token = getToken();
 
  if (!user || !token) {
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
 
  return {
    user,
    token
  };
}