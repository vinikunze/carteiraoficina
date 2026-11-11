// Service worker do web app. Guarda só a "casca" do sistema (tela, logo, ícones)
// para abrir rápido. Os dados (/api) sempre vêm da internet, nunca do cache.
const VERSAO = 'carteira-v1';
const CASCA = ['/', '/logo.png', '/icone.png', '/icone-192.png', '/favicon-64.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(CASCA)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== VERSAO).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // a tela principal: tenta a internet primeiro (pega a versão nova), cai no cache se estiver sem sinal
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(req)
        .then((r) => { if (r.ok) { const copia = r.clone(); caches.open(VERSAO).then((c) => c.put('/', copia)); } return r; })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // imagens e manifest: usa o cache e atualiza por trás
  e.respondWith(
    caches.match(req).then((cache) => {
      const rede = fetch(req).then((r) => {
        if (r.ok) { const copia = r.clone(); caches.open(VERSAO).then((c) => c.put(req, copia)); }
        return r;
      }).catch(() => cache);
      return cache || rede;
    })
  );
});
