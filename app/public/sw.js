// Offline support and updates.
// - Page loads (navigations) go to the network first, so a new version reaches the
//   installed Home Screen app on the next open; offline, the cached page is used.
// - app.js / app.css carry the build id in their URL, so they are cached forever.
// - The data files (cards, openings, insights) are fetched fresh when online (the
//   nightly run rebuilds them) and served from cache when offline.
const VERSION = '__BUILD_ID__';
const SHELL = ['./', 'app.js?v=' + VERSION, 'app.css?v=' + VERSION, 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
const DATA = ['data/cards.json', 'data/openings.json', 'data/insights.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open('shell-' + VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== 'shell-' + VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(withTimeout(fetch(e.request, { cache: 'no-cache' }), 4000)
      .then((r) => { if (r.ok) { const copy = r.clone(); caches.open('shell-' + VERSION).then((c) => c.put('./', copy)); } return r; })
      .catch(() => caches.match('./')));
    return;
  }
  const data = DATA.find((d) => url.pathname.endsWith('/' + d));
  if (data) {
    e.respondWith(fetch(e.request, { cache: 'no-cache' })
      .then((r) => { if (r.ok) { const copy = r.clone(); caches.open('data').then((c) => c.put(data, copy)); } return r; })
      .catch(() => caches.open('data').then((c) => c.match(data)).then((r) => r || Response.error())));
    return;
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
