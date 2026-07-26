/* Offline cache and update channel.
 *
 * BUILD is rewritten by the deploy workflow with the commit SHA. That matters
 * for more than cache naming: the browser decides whether an update exists by
 * byte-comparing this file, so if sw.js were identical between deploys no
 * update would ever be detected no matter what else changed.
 */

const BUILD = '__BUILD__';

const SHELL_CACHE = `sim-shell-${BUILD}`;
const AUDIO_CACHE = 'sim-audio';   // unversioned: a clip's bytes never change

/* Two strategies, because the two kinds of asset have opposite needs:
 *
 *   audio/*.mp3  — cache-first. A clip is immutable: its content is fully
 *                  determined by the phrase id and track in its filename, so a
 *                  cache hit is always correct and never worth a round trip.
 *                  Kept across updates so an upgrade doesn't re-download 2 MB.
 *
 *   app shell    — network-first, falling back to cache. Cache-first here would
 *                  pin users to whatever HTML/CSS/JS they first loaded, with no
 *                  way to ship a fix. The cache is the offline safety net, not
 *                  the source of truth.
 */

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'data/phrases.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  // Deliberately no skipWaiting() here. The new worker parks in `waiting` so
  // the page can offer the user an update rather than swapping the app out
  // from under them mid-sentence. app.js sends SKIP_WAITING when they accept.
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)));
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

self.addEventListener('message', e => {
  const type = e.data && e.data.type;
  if (type === 'SKIP_WAITING') self.skipWaiting();
  if (type === 'GET_BUILD') e.source.postMessage({ type: 'BUILD', build: BUILD });
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
