// 오프라인에서도 열리게 앱 파일을 보관한다.
// 앱 파일은 네트워크 우선(새 버전이 바로 반영됨), 실패하면 보관본. 글꼴은 보관본 우선. GitHub API는 건드리지 않는다.
const CACHE = 'today-v4';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/core.js', 'js/store.js', 'js/sync.js', 'js/chart.js', 'js/pk.js', 'js/game.js', 'js/weather.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) c.put(req, res.clone());
  return res;
}
async function networkFirst(req) {
  const c = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req.url, { cache: 'no-cache' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch {
    const hit = (await c.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await c.match('index.html') : null);
    return hit || fetch(req);
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (FONT_HOSTS.includes(url.hostname)) return e.respondWith(cacheFirst(req));
  if (url.origin === self.location.origin) e.respondWith(networkFirst(req));
});
