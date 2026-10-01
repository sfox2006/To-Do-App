/* Service worker: offline-first app shell + stale-while-revalidate.
   Bump VERSION whenever you want every client to re-download the shell. */
const VERSION = 'v4';
const CACHE = `todo-app-${VERSION}`;

// Relative URLs resolve against the SW location, so this works from any subpath.
const SHELL = [
  './',
  './index.html',
  './app.js',
  './store.js',
  './sync.js',
  './parser.js',
  './styles.css',
  './pwa.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.ico',
  './icons/favicon-32.png'
];

// Pinned supabase-js. If these were never cached, sync stays off and the app still works.
const CDN_HOSTS = new Set(['esm.sh']);
const CDN_URLS = [
  'https://esm.sh/@supabase/supabase-js@2.49.4/es2022/supabase-js.bundle.mjs',
  'https://esm.sh/node/buffer.mjs'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Add individually so one missing file doesn't abort the whole install.
      Promise.all([...SHELL, ...CDN_URLS].map((url) =>
        cache.add(new Request(url, { cache: 'reload' })).catch((err) =>
          console.warn('[sw] could not precache', url, err)
        )
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('todo-app-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function fromCdn(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) {
    fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
    }).catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(req);
    if (res && res.ok) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (CDN_HOSTS.has(url.host)) {
    event.respondWith(fromCdn(req));
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const isNav = req.mode === 'navigate';
    const cached = await cache.match(req, { ignoreSearch: isNav }) ||
                   (isNav ? await cache.match('./index.html') : undefined);

    const network = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    });

    if (cached) {
      network.catch(() => {}); // revalidate in background; ignore offline errors
      return cached;
    }
    try {
      return await network;
    } catch (err) {
      if (isNav) {
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
