// Service worker: הכול נשמר במטמון אחרי הטעינה הראשונה, האפליקציה עובדת גם בלי אינטרנט.
const VERSION = 'tp-v4';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/maskable-512.png'];
const FF = ['vendor/ffmpeg/index.js', 'vendor/ffmpeg/classes.js', 'vendor/ffmpeg/const.js', 'vendor/ffmpeg/errors.js',
  'vendor/ffmpeg/types.js', 'vendor/ffmpeg/utils.js', 'vendor/ffmpeg/worker.js', 'vendor/ffmpeg/ffmpeg-core.js', 'vendor/ffmpeg/ffmpeg-core.wasm'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL);                       // חובה
    try { await c.addAll(FF); } catch (err) {}   // מנוע החיתוך (32MB) - אם נכשל, יישמר בשימוש הראשון
    self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const hit = await c.match(req, { ignoreSearch: true });
    if (req.mode === 'navigate') {
      // רשת קודם (לעדכונים), נפילה למטמון כשאין אינטרנט
      try { const r = await fetch(req); if (r.ok) c.put('index.html', r.clone()); return r; }
      catch { return hit || (await c.match('index.html')); }
    }
    if (hit) {
      // מטמון קודם, עדכון ברקע לקבצי הקוד הקטנים
      if (!req.url.endsWith('.wasm')) e.waitUntil(fetch(req).then((r) => r.ok && c.put(req, r)).catch(() => {}));
      return hit;
    }
    const r = await fetch(req);
    if (r.ok) c.put(req, r.clone());
    return r;
  })());
});
