/* GharTutor service worker: shows push notifications and opens the right page when one is tapped. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  var title = data.title || 'GharTutor';
  var options = {
    body: data.body || '',
    icon: '/images/favicon-192.png',
    badge: '/images/favicon-96.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || 'index.html' },
  };
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
      // If the person is already looking at the site, the in-app chat/bell shows it: no pop-up needed.
      var visible = wins.some(function (w) { return w.visibilityState === 'visible'; });
      if (visible) return undefined;
      return self.registration.showNotification(title, options);
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = new URL((event.notification.data && event.notification.data.url) || 'index.html', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
      for (var i = 0; i < wins.length; i++) {
        if (new URL(wins[i].url).origin === self.location.origin && 'focus' in wins[i]) {
          return wins[i].focus().then(function (c) {
            return c && 'navigate' in c ? c.navigate(target) : self.clients.openWindow(target);
          }).catch(function () { return self.clients.openWindow(target); });
        }
      }
      return self.clients.openWindow(target);
    })
  );
});