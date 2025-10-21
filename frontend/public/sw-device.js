// sw-device.js
const VERSION = 'xr-device-v1';
const STATIC_ASSETS = [
  '/device', // HTML shell (served by server route)
  '/public/css/common.css',
  '/public/css/device.css',
  '/public/css/styles.css',
  '/public/js/app.js',
  '/public/js/config.js',
  '/public/js/device.js',
  '/public/js/ui.js',
  '/public/js/signaling.js',
  '/public/js/voice.js',
  '/public/js/telemetry.js',
  '/public/js/webrtc-quality.js',
  '/public/js/messages.js',
  '/public/images/xr-logo-192.png',
  '/public/images/xr-logo-512.png',
];

// Handy helpers
const cacheName = VERSION;
const rootPaths = ['/device', '/device/']; // support both

self.addEventListener('install', (evt) => {
  evt.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    // Use {cache:'reload'} to bypass any stale HTTP cache on first install
    await cache.addAll(STATIC_ASSETS.map(u => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== cacheName).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (evt) => {
  const req = evt.request;
  const url = new URL(req.url);

  // Never touch Socket.IO / websockets / EventSource
  if (url.pathname.startsWith('/socket.io')) return;
  if (req.headers.get('upgrade') === 'websocket') return;

  // Only GET is cacheable
  if (req.method !== 'GET') return;

  // Network-first for navigations (page loads, reloads, SPA deep-links)
  const isNavigation = req.mode === 'navigate' || req.destination === 'document';
  if (isNavigation) {
    evt.respondWith((async () => {
      try {
        // Keep pages fresh in XR flows
        return await fetch(req, { cache: 'no-store' });
      } catch (err) {
        // Offline fallback: return cached shell (/device or /device/)
        const cache = await caches.open(cacheName);
        for (const p of rootPaths) {
          const cached = await cache.match(p, { ignoreSearch: true });
          if (cached) return cached;
        }
        return Response.error();
      }
    })());
    return;
  }

  // Stale-while-revalidate for static assets (ignore query strings like ?v=123)
  evt.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(req, { ignoreSearch: true });
    const fetcher = fetch(req).then(res => {
      if (res && res.ok) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    }).catch(() => cached);
    return cached || fetcher;
  })());
});
