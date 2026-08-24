// verba service worker — offline support.
// Strategy:
//  - app shell + samples: precached on install, navigations are
//    network-first with a fallback to the cached shell (hash routing
//    means one index.html covers every route)
//  - hashed /assets/* (app js/css and the large dictionary chunks):
//    cache-first; they are content-hashed and immutable, and the
//    ~8MB dictionaries are cached on first use instead of precached

const VERSION = 'v1';
const CORE_CACHE = `verba-core-${VERSION}`;
const RUNTIME_CACHE = `verba-runtime-${VERSION}`;

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './samples/decameron.txt',
  './samples/quijote.txt',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(CORE_CACHE);
      await c.addAll(CORE_ASSETS);
      // also precache the hashed app assets (js/css) referenced by
      // index.html — the first page load happens before this worker is
      // active, so those files would never otherwise be cached. The large
      // dictionary chunks are *not* in index.html (dynamic imports); they
      // are cached on first use by the fetch handler below.
      const htmlRes = (await c.match('./index.html')) || (await fetch('./index.html'));
      const html = await htmlRes.text();
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
      await Promise.all(
        refs
          .filter((r) => r.includes('/assets/'))
          .map(async (r) => {
            const path = r.startsWith('/') ? '.' + r : r;
            const res = await fetch(path);
            if (res.ok) c.put(path, res);
          })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (k) =>
                k.startsWith('verba-') && k !== CORE_CACHE && k !== RUNTIME_CACHE
            )
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return; // e.g. Google Translate

  // navigations: network first, fall back to the cached shell when offline
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CORE_CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html', { ignoreVary: true }))
    );
    return;
  }

  // hashed assets (app + dictionary chunks): immutable, cache first.
  // ignoreVary is important here: <script crossorigin>/<link> tags issue
  // CORS-mode requests, and some servers (e.g. vite preview) send
  // `Vary: Origin` on responses — without ignoreVary, Cache Storage's
  // default vary-aware matching treats those as a miss even though the
  // asset is same-origin and content-hashed/immutable.
  if (req.url.includes('/assets/')) {
    e.respondWith(
      caches.match(req, { ignoreVary: true }).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
            return res;
          })
      )
    );
    return;
  }

  // everything else same-origin (samples, icons): stale-while-revalidate
  e.respondWith(
    caches.match(req, { ignoreVary: true }).then((hit) => {
      const revalidate = fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => {});
      return hit || revalidate;
    })
  );
});
