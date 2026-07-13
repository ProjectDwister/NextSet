// Bump this whenever the app-shell file list below changes; old caches
// get cleaned up automatically on activate.
const CACHE_NAME = 'nextset-v3';

const APP_SHELL = [
  './',
  './index.html',
  './auth.js',
  './events.js',
  './invites.js',
  './firebase-config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
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
