/* Offline shell for the Meridian Club prototype. Bump CACHE on every release. */
const CACHE = 'meridian-v1';
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './css/theme.css', './css/table.css',
  './js/app.js', './js/table.js', './js/engine.js', './js/evaluator.js',
  './js/cards.js', './js/bots.js', './js/state.js', './js/roster.js',
  './assets/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((hit) => hit ?? fetch(event.request).catch(() => caches.match('./index.html'))),
  );
});
