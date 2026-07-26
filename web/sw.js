/* Offline cache.
 *
 * Two strategies, because the two kinds of asset have opposite needs:
 *
 *   audio/*.mp3  — cache-first. A clip is immutable: its content is fully
 *                  determined by the phrase id and track in its filename, so a
 *                  cache hit is always correct and we should never spend a
 *                  round trip on it.
 *
 *   app shell    — network-first, falling back to cache. Cache-first here would
 *                  pin users to whatever HTML/CSS/JS they first loaded, with no
 *                  way to ship a fix short of renaming files. The cache is the
 *                  offline safety net, not the source of truth.
 */

const VERSION = 'v2';
const SHELL_CACHE = `sim-shell-${VERSION}`;
const AUDIO_CACHE = 'sim-audio';   // unversioned: clips never change

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'data/phrases.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== AUDIO_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

const cachePut = (cacheName, req, res) => {
  // 206 Partial Content (from media range requests) is not cacheable.
  if (res && res.ok && res.status === 200) {
    const copy = res.clone();
    caches.open(cacheName).then(c => c.put(req, copy));
  }
  return res;
};

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('.mp3')) {
    e.respondWith(
      caches.match(req).then(hit =>
        hit || fetch(req).then(res => cachePut(AUDIO_CACHE, req, res))
      )
    );
    return;
  }

  e.respondWith(
    fetch(req)
      .then(res => cachePut(SHELL_CACHE, req, res))
      .catch(() => caches.match(req).then(hit => hit || caches.match('index.html')))
  );
});
