/* Vigie — service hors ligne (v0.13).
   L'appli s'ouvre même sans réseau. Les prix des carburants, la carte et Mécano restent en ligne :
   ils ne sont jamais servis depuis une vieille copie. */
const VERSION = 'vigie-dev'; // remplacé par la version du changelog dans docs/ (outils/construire-site.py)
const SHELL = ['./', 'index.html', 'changelog.json', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
const CDN = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('vigie-') && k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const keep = (req, res) => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; };

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // L'appli : le réseau d'abord (pour recevoir les mises à jour), la copie hors ligne sinon
    e.respondWith(
      fetch(req)
        .then(res => (res.ok ? keep(req, res) : res))
        .catch(() => caches.match(req, { ignoreSearch: true }).then(m => m || caches.match('index.html')))
    );
    return;
  }
  if (CDN.includes(url.hostname)) {
    // Bibliothèques à version fixe (three.js, Leaflet) et polices : la copie d'abord
    e.respondWith(
      caches.match(req).then(m => m || fetch(req).then(res => (res.ok || res.type === 'opaque' ? keep(req, res) : res)))
    );
  }
  // Tout le reste (prix des carburants, tuiles de carte) passe directement par le réseau.
});
