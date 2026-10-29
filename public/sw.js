// The web door's service worker: it shows what the resident pushes (src/web-push.ts) and opens the page when one is
// tapped. It keeps nothing offline; the page always comes from the Worker.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  // Every push is shown: Safari takes a push it is not shown as a reason to stop sending them.
  event.waitUntil(
    self.registration.showNotification(data.title || '住户', {
      body: data.body || '',
      icon: data.icon || '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'resident',
      renotify: true,
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const page of pages) {
        // Not a page framed inside another site (the Mini App in Telegram's web app): open a window of its own.
        if (new URL(page.url).origin === self.location.origin && page.frameType !== 'nested' && 'focus' in page) {
          // An open page switches to the resident the notification is from (?r=<id>, src/residents.ts).
          page.postMessage({ open: url });
          return page.focus();
        }
      }
      return self.clients.openWindow(url);
    })()
  );
});
