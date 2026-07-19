// Bump this whenever the app-shell file list below changes; old caches
// get cleaned up automatically on activate.
const CACHE_NAME = 'nextset-v17';

const APP_SHELL = [
  './index.html',
  './rally.html',
  './events.html',
  './americano-8-player-event.html',
  './auth.js',
  './events.js',
  './invites.js',
  './push.js',
  './padelEvents.js',
  './firebase-config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

// cache.addAll() is all-or-nothing — if even one of these URLs fails to
// fetch, the whole install rejects and the service worker never
// activates at all, with no visible error anywhere. That's the leading
// suspect for why installability has been failing outright. Caching
// each file individually, with its own catch, means one bad entry
// can't take the rest down — installation succeeds either way, and any
// real failure gets logged instead of silently sinking everything.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.error('[NextSet] precache failed for', url, err);
          }),
        ),
      ),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

// Network-first, falling back to cache. Deliberately NOT cache-first —
// a cache-first strategy would mean everyone stays on whatever version
// was first installed until they happen to clear it, which defeats the
// point of being able to keep shipping fixes. This only ever touches
// this app's own files; anything going to Firebase/Google APIs is left
// completely alone.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});

// A push message only ever carries a data payload here — no images or
// actions, kept deliberately simple. If parsing ever fails for any
// reason, fall back to a generic notification rather than showing
// nothing at all.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'NextSet';
  const options = {
    body: data.body || 'You have an upcoming game.',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: data.url || './' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    }),
  );
});