// Guarda la app en el navegador para que abra al instante y aunque no
// haya internet. Sirve la copia guardada enseguida y, por detrás, baja la
// versión nueva del servidor: un cambio publicado se ve en la apertura
// siguiente.
// No toca los pedidos a Supabase ni a Firebase: esos datos los maneja la app.
const CACHE = 'mek-v15';
const APP = [
  './', 'index.html', 'deudores.html', 'cabinas.html', 'giftcards.html', 'gastos.html', 'liquidaciones.html', 'panel.html', 'acreedores.html', 'compras.html', 'catalogo.html',
  'css/app.css', 'js/config.js', 'js/comun.js', 'js/calculo.js', 'js/cola.js', 'js/pacientes.js', 'js/turnos.js', 'js/app.js',
  'js/deudores.js', 'js/cabinas.js', 'js/giftcards.js', 'js/semana.js', 'js/gastos.js', 'js/liquidaciones.js', 'js/panel.js', 'js/acreedores.js', 'js/compras.js', 'js/catalogo.js',
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
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const guardada = await c.match(e.request, { ignoreSearch: true });
    // 'no-cache': al servidor se le pregunta siempre si hay versión nueva.
    const red = fetch(e.request, propio ? { cache: 'no-cache' } : undefined)
      .then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; })
      .catch(() => guardada);
    if (guardada) { e.waitUntil(red); return guardada; }
    return red;
  }));
});
