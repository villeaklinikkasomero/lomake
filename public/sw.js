'use strict';
// Service worker sovellusversiota (PWA) varten. Kirjauksia tai muuta rajapinnan dataa EI tallenneta
// laitteelle: /api-pyynnöt kulkevat aina suoraan palvelimelle. Välimuistiin tallennetaan vain
// ulkoasun tiedostot (fontit, tunnus) ja yhteydettömän tilan ilmoitussivu.
const CACHE = 'kohtaamiset-v2';
const PRECACHE = ['/offline.html', '/offline.css', '/brand/favicon.svg', '/brand/tunnus.svg', '/brand/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
  // Sivu: aina verkosta (uusin versio); ilman yhteyttä ilmoitussivu
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  // Fontit ja tunnus: välimuistista, päivitetään taustalla
  if (url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/brand/') || url.pathname === '/offline.css') {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
  // Muut (app.js, app.css): selain ja palvelin hoitavat (versioitu osoite, ETag)
});
