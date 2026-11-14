// Offline support. The app shell is cached per build; the card file is fetched
// fresh when online (new cards arrive after each nightly run) and served from
// cache when offline.
const VERSION = '__BUILD_ID__';
const SHELL = ['./', 'index.html', 'app.js?v=' + VERSION, 'app.css?v=' + VERSION, 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
const CARDS = 'data/cards.json';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open('shell-' + VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== 'shell-' + VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/' + CARDS)) {
    e.respondWith(fetch(e.request, { cache: 'no-cache' })
      .then((r) => { if (r.ok) { const copy = r.clone(); caches.open('data').then((c) => c.put(CARDS, copy)); } return r; })
      .catch(() => caches.open('data').then((c) => c.match(CARDS)).then((r) => r || Response.error())));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: url.pathname.endsWith('/') || url.pathname.endsWith('index.html') })
    .then((r) => r || fetch(e.request)));
});
