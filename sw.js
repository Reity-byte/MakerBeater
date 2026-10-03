/* MakerBeater – service worker
 * Díky němu jde aplikaci nainstalovat a funguje i bez internetu.
 * Strategie „nejdřív síť“: s internetem se vždy načte nejnovější verze
 * (a uloží do mezipaměti), bez internetu se použije uložená kopie.
 */
const CACHE = 'makerbeater-v2';
const FILES = [
  './',
  'index.html',
  'style.css',
  'js/state.js',
  'js/audio.js',
  'js/grid.js',
  'js/main.js',
  'manifest.webmanifest',
  'app/icon.png',
  'app/icon-192.png',
  'app/icon-512.png',
  'app/icon-maskable.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))),
  );
});
