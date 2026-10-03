// Guarda la app en el navegador para que abra aunque no haya internet.
// Primero intenta la red (así siempre se ve la última versión) y si no
// hay conexión usa la copia guardada.
// No toca los pedidos a Supabase ni a Firebase: esos datos los maneja la app.
const CACHE = 'mek-v2';
const APP = [
  './', 'index.html', 'gastos.html', 'liquidaciones.html', 'panel.html', 'compras.html', 'catalogo.html',
  'css/app.css', 'js/config.js', 'js/comun.js', 'js/calculo.js', 'js/cola.js', 'js/pacientes.js', 'js/app.js',
  'js/gastos.js', 'js/liquidaciones.js', 'js/panel.js', 'js/compras.js', 'js/catalogo.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const propio = url.origin === self.location.origin;
  const cdn = url.hostname === 'cdn.jsdelivr.net';
  if (e.request.method !== 'GET' || (!propio && !cdn)) return;
  e.respondWith(
    // 'no-cache': siempre pregunta al servidor si hay versión nueva (si
    // no, el navegador podría mostrar archivos viejos después de actualizar).
    fetch(e.request, propio ? { cache: 'no-cache' } : undefined)
      .then((r) => {
        if (r.ok) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
