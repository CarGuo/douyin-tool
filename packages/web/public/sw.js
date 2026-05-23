/* douyin-tool service worker — minimal app-shell cache */
const CACHE = 'dt-shell-v4';
// Derive the deployment base from the SW's own URL. When registered with
// scope '/dy/', self.registration.scope ends with '/dy/'; for root it's '/'.
const SCOPE = new URL(self.registration ? self.registration.scope : './', self.location.href).pathname;
const BASE = SCOPE.endsWith('/') ? SCOPE : SCOPE + '/';
const SHELL = [BASE, BASE + 'index.html', BASE + 'manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never cache API and download proxy.
  if (url.pathname.startsWith(BASE + 'api/')) return;

  // Network-first for navigation / HTML so new deploys take effect immediately
  // and stale shells (which can cause blank screens on iOS) self-heal.
  const isNavigation =
    req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');
  if (isNavigation) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200 && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(BASE + 'index.html', copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(BASE + 'index.html').then((m) => m || caches.match(req)),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200 && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(BASE + 'index.html'));
    }),
  );
});
