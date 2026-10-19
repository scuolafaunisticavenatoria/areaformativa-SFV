/* Service worker dell'app SFV (pianura).
   - Tiene in memoria l'app, le librerie e le foto: si apre anche senza campo.
   - Manda le notifiche delle scadenze (telefoni Android con l'app installata).
   Quando pubblichi una nuova versione dell'app, aumenta il numero qui sotto. */
const CACHE = 'sfv-pianura-v3';
const LIBRERIE = 'sfv-librerie-v1';
const FOTO = 'sfv-foto-v1';
const SHELL = [
  '/pianura/',
  '/pianura/manifest.webmanifest',
  '/pianura/icone.css',
  '/pianura/icon-192.png',
  '/pianura/icon-512.png',
  '/pianura/apple-touch-icon.png',
  '/pianura/simbolo.svg',
  '/pianura/favicon-32.png',
  '/pianura/logo-scuola.jpg',
  '/pianura/logo-calresana.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('sfv-pianura-') && k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// copia salvata se c'è, altrimenti rete (e la salva)
function primaCopia(nome, req) {
  return caches.open(nome).then(c => c.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok || r.type === 'opaque') c.put(req, r.clone());
    return r;
  })));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Librerie fisse (versioni bloccate): Firebase, caratteri, lettore PDF
  if ((url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) ||
      url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com' ||
      (url.hostname === 'cdnjs.cloudflare.com' && url.pathname.includes('/pdf.js/'))) {
    e.respondWith(primaCopia(LIBRERIE, req));
    return;
  }
  // Foto della fauna da Wikimedia Commons
  if (/(^|\.)wikimedia\.org$/.test(url.hostname) && req.destination === 'image') {
    e.respondWith(primaCopia(FOTO, req));
    return;
  }
  // Database, accesso, documenti: sempre diretti
  if (url.origin !== location.origin || !url.pathname.startsWith('/pianura')) return;

  // Pagina: prima la rete (versione aggiornata), se offline la copia salvata
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(r => {
        const c = r.clone();
        caches.open(CACHE).then(ca => ca.put('/pianura/', c));
        return r;
      }).catch(() => caches.match('/pianura/'))
    );
    return;
  }
  // File dell'app: copia salvata, aggiornata in background
  e.respondWith(
    caches.match(req).then(cached => {
      const fresh = fetch(req).then(r => {
        if (r.ok) { const c = r.clone(); caches.open(CACHE).then(ca => ca.put(req, c)); }
        return r;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});

/* ───────── Notifiche delle scadenze ─────────
   L'app copia le scadenze in un piccolo archivio sul telefono (IndexedDB).
   Il telefono risveglia il service worker circa una volta al giorno
   (Periodic Background Sync: Chrome su Android, app installata). */
function idb() {
  return new Promise((ok, ko) => {
    const r = indexedDB.open('sfv_notifiche', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
  });
}
function leggi(db, k) { return new Promise(ok => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); }); }
function scrivi(db, k, v) { return new Promise(ok => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = ok; t.onerror = ok; }); }
function giorni(iso) { const [y, m, d] = iso.split('-').map(Number); const o = new Date(); o.setHours(0, 0, 0, 0); return Math.round((new Date(y, m - 1, d) - o) / 86400000); }

async function controllaScadenze() {
  const db = await idb();
  const cfg = await leggi(db, 'config');
  if (!cfg || !cfg.attive) return;
  const lista = (await leggi(db, 'scadenze')) || [];
  const inviate = (await leggi(db, 'inviate')) || {};
  const soglie = [30, 7, 1, 0];
  for (const s of lista) {
    const g = giorni(s.scadenza);
    const soglia = soglie.find(x => g <= x && g >= (x === 0 ? -3 : x - 2)); // tollera qualche giorno di ritardo del telefono
    if (soglia === undefined) continue;
    const chiave = s.id + '|' + s.scadenza + '|' + soglia;
    if (inviate[chiave]) continue;
    const testo = g < 0 ? `È scaduto da ${-g} giorn${g === -1 ? 'o' : 'i'}.` : g === 0 ? 'Scade oggi.' : g === 1 ? 'Scade domani.' : `Scade tra ${g} giorni, il ${s.scadenza.split('-').reverse().join('/')}.`;
    await self.registration.showNotification(s.nome, {
      body: testo + ' Tocca per aprire le tue scadenze.',
      icon: '/pianura/icon-192.png', badge: '/pianura/favicon-32.png',
      tag: 'scad-' + s.id, data: { url: '/pianura/#scad' }
    });
    inviate[chiave] = Date.now();
  }
  await scrivi(db, 'inviate', inviate);
}

self.addEventListener('periodicsync', e => { if (e.tag === 'sfv-scadenze') e.waitUntil(controllaScadenze()); });
self.addEventListener('message', e => { if (e.data === 'controlla-scadenze') e.waitUntil(controllaScadenze()); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/pianura/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.includes('/pianura/')) { c.navigate(url); return c.focus(); } }
    return clients.openWindow(url);
  }));
});
