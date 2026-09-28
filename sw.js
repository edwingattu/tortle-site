// Tortle PWA — shell precache + network-first for HTML, network-only for tiles/supabase
const CACHE = 'tortle-shell-v3';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/app/style.css',
  '/app/config.js',
  '/app/engine.js',
  '/app/areas.js',
  '/app/map.js',
  '/app/main.js',
  '/app/sync.js',
  '/app/roles.js',
  '/app/joystick.js',
  '/app/auth.js',
  '/app/icons/icon-192.png',
  '/app/icons/icon-512.png',
  '/app/icons/favicon-32.png',
  '/app/brand/main-logo-800.png',
  '/app/data/meta.json',
  '/app/data/areas.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

function isTileOrSupabase(url) {
  return url.hostname.includes('openfreemap.org') || url.hostname.includes('tiles.openfreemap.org') || url.hostname.includes('supabase.co') || url.hostname.includes('nominatim.openstreetmap.org') || url.hostname.includes('esm.sh') || url.hostname.includes('unpkg.com');
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Bypass for dev
  if (url.searchParams.has('nosw')) return;
  // Network-only for tiles, supabase, esm, cdn
  if (isTileOrSupabase(url)) return;
  // Network-first for documents and shell
  if (e.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html') || SHELL.includes(url.pathname)) {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return r;
        })
        .catch(() => caches.match(e.request).then((c) => c || caches.match('/index.html')))
    );
    return;
  }
  // Stale-while-revalidate for other app assets
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetched = fetch(e.request).then((r) => {
        // Guard: a raced/consumed response throws on clone — skip caching it,
        // the network response itself still serves the page.
        if (r && r.ok && !r.bodyUsed) {
          try {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          } catch {}
        }
        return r;
      }).catch(() => null);
      return cached || fetched;
    })
  );
});
