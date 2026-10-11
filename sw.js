// Offline support: serve the app shell from cache, refresh it in the background.
// Bump CACHE when shipping changes so old files are dropped.
const CACHE = 'family-meals-v7';
const ASSETS = [
  './', './index.html', './styles.css', './i18n.js', './store.js', './cropper.js', './firebase-config.js', './sync.js', './app.js', './data/default-dishes.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  // 'reload' skips the browser's HTTP cache so a new version never stores old files.
  const fresh = ASSETS.map(url => new Request(url, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Firebase SDK files are versioned and never change, so keep them for offline starts.
const SDK_PREFIX = 'https://www.gstatic.com/firebasejs/';

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.startsWith(SDK_PREFIX)) {
    e.respondWith(caches.open(CACHE).then(async cache =>
      (await cache.match(e.request)) || fetch(e.request).then(res => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      })));
    return;
  }
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const network = fetch(e.request).then(res => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});
