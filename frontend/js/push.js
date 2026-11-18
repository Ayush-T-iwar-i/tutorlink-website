/* GharTutor: phone/laptop push notifications + "open this chat" links.
   Loaded on the student and teacher dashboards after api.js. */
(function () {
  'use strict';
  if (typeof getSession !== 'function' || !getSession()) return;
  var session = getSession();

  /* ---- 1. Open a chat when the page is opened with ?chat=<bookingId> (from a notification) ---- */
  (function openChatFromLink() {
    var params = new URLSearchParams(window.location.search);
    var id = params.get('chat');
    if (!id || !/^\d+$/.test(id)) return;
    params.delete('chat');
    var qs = params.toString();
    try { history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash); } catch (e) { /* ignore */ }
    var who = session.role === 'teacher' ? 'your student' : 'your teacher';
    window.addEventListener('load', function () {
      setTimeout(function () { if (typeof openChatModal === 'function') openChatModal(id, who); }, 600);
    });
  })();

  /* ---- 2. Push notifications ---- */
  var supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  function toKey(base64) {
    var pad = '='.repeat((4 - (base64.length % 4)) % 4);
    var raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function subscribe(publicKey) {
    var reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) });
    }
    await apiRequest('/api/push/subscribe', 'POST', sub.toJSON());
    return sub;
  }

  var box = null;
  function setBox(html) { if (box) { box.innerHTML = html; box.hidden = !html; } }

  function makeBox() {
    var dd = document.getElementById('notifDropdown');
    var list = document.getElementById('notifList');
    if (!dd || !list) return;
    box = document.createElement('div');
    box.id = 'pushPrompt';
    box.hidden = true;
    box.style.cssText = 'padding:10px 14px;border-bottom:1px solid var(--border);font-size:13px;line-height:1.45;';
    dd.insertBefore(box, list);
  }

  async function init() {
    makeBox();
    if (isIos && !isStandalone) {
      setBox('<span>To get phone notifications on iPhone, tap Share, then <b>Add to Home Screen</b>, and open GharTutor from there.</span>');
      return;
    }
    if (!supported) return;

    var cfg;
    try { cfg = await apiRequest('/api/push/public-key'); } catch (e) { return; }
    if (!cfg || !cfg.enabled || !cfg.publicKey) return;

    if (Notification.permission === 'granted') {
      try { await subscribe(cfg.publicKey); } catch (e) { /* try again next visit */ }
      return;
    }
    if (Notification.permission === 'denied') {
      setBox('<span>Notifications are blocked for this site. Allow them in your browser settings to get message alerts.</span>');
      return;
    }
    setBox('<span>Get an alert on this device when someone messages you.</span> ' +
      '<button type="button" id="pushEnableBtn" class="btn btn-primary btn-sm" style="margin-top:8px;">Turn on notifications</button>');
    var btn = document.getElementById('pushEnableBtn');
    btn.addEventListener('click', async function (e) {
      e.stopPropagation();
      btn.disabled = true;
      try {
        var perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          setBox('<span>Notifications are blocked for this site. Allow them in your browser settings to get message alerts.</span>');
          return;
        }
        await subscribe(cfg.publicKey);
        setBox('<span>Notifications are on for this device.</span>');
        setTimeout(function () { setBox(''); }, 3000);
      } catch (err) {
        btn.disabled = false;
        if (typeof toast === 'function') toast('Could not turn on notifications. Please try again.', 'error');
      }
    });
  }

  /* On log out, stop sending this device the previous person's alerts. */
  var logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn && supported) {
    logoutBtn.addEventListener('click', function () {
      navigator.serviceWorker.getRegistration('/sw.js').then(function (reg) {
        return reg && reg.pushManager.getSubscription();
      }).then(function (sub) {
        if (sub) apiFetch('/api/push/unsubscribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }), keepalive: true,
        });
      }).catch(function () { /* ignore */ });
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();