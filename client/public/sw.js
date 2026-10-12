// The service worker the app registers: Angular's, with cross-origin requests
// left to the browser.
//
// ngsw-worker.js answers every fetch it sees unless the request carries
// ngsw-bypass — including requests to other origins, which it never caches
// here (no data group names one), so it only fetched them again itself. Every
// Google Fonts file, analytics call, R2 image and backend request took that
// extra hop, and showed up twice in DevTools, once from the page and once from
// the worker. The Google Fonts files cannot carry ngsw-bypass, since their
// URLs come from Google's stylesheet.
//
// This listener is registered before ngsw-worker.js adds its own, and stops
// the event from reaching it for any other origin, so the browser handles
// those requests natively. Same-origin requests — the app shell, route
// chunks, index.html — are left to Angular's worker exactly as before.
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).origin !== self.location.origin) {
    event.stopImmediatePropagation();
  }
});

// Push notifications (Firebase Cloud Messaging). The server sends data-only
// messages, so this builds the notification — in the language the server
// chose — and Angular's worker, which only shows ones carrying a
// `notification` field, leaves them alone. FCM wraps the data it was given,
// so the fields sit under `data`; the bare shape is accepted too.
//
// A notification is always shown: browsers require it of a push subscription
// that promised to be user-visible, and show a generic "site updated in the
// background" one of their own when it is skipped. The server already holds
// back from users who have the site open.
self.addEventListener('push', (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch (e) {
    return;
  }
  const data = payload && (payload.data || payload);
  if (!data || !data.title) return;

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body || '',
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-96x96.png',
      // One notification per conversation: a second message replaces the
      // first instead of stacking.
      tag: data.link || 'unibooks',
      data: { link: data.link || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/';
  // Same-origin only: the link comes from a push payload.
  const target = new URL(link, self.location.origin);
  if (target.origin !== self.location.origin) return;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
          return w.focus().then((focused) => ('navigate' in focused ? focused.navigate(target.href) : undefined));
        }
      }
      return self.clients.openWindow(target.href);
    })
  );
});

importScripts('./ngsw-worker.js');
