/**
 * SW.JS - Service Worker de Alabanza (solo la "cáscara" de la app)
 *
 * - Guarda los archivos de la app para que abra sin internet.
 * - NO toca peticiones a otros dominios (Apps Script, Google Fonts, archive.org).
 * - El audio de las multipistas lo guarda multitrack.js en cachés "alabanza-audio-<fecha>";
 *   aquí NUNCA se borran. Si ya tienes un sw.js, conserva esa regla en tu "activate".
 * - Los archivos de la app se piden primero a la red (así ves los cambios en cuanto subes algo a GitHub);
 *   si no hay red, o tarda más de 3 s, se usa la copia guardada.
 * - Al cambiar este archivo, sube el número de SHELL (v3, v4…).
 */
const SHELL = 'alabanza-shell-v5';
const FILES = [
  './', 'index.html', 'styles.css',
  'theme.js', 'music.js', 'ui.js', 'audio-core.js', 'database.js',
  'pads.js', 'metronome.js', 'perc.js', 'tuner.js', 'synth.js', 'pitchshift.js', 'multitrack.js', 'setlist.js',
  'proy-core.js', 'proy-render.js', 'proy-operator.js', 'proyeccion.css', 'salida.html', 'proyeccion-ejemplo.json', 'manifest.webmanifest',
  'secuencias.json', 'biblias.json',
  'logo_app.jpg', 'logo_app_2.png', 'logo_pagina.jpg', 'logo_pagina_2.jpg'
];

self.addEventListener('install', (e) => {
  // Tolerante: si un archivo falta, la instalación no se cae
  e.waitUntil(caches.open(SHELL).then((c) => Promise.all(FILES.map((f) => c.add(f).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names
        .filter((n) => n.startsWith('alabanza-shell-') && n !== SHELL) // solo cachés viejos de la app
        .map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Apps Script, fuentes, archive.org: pasan directo
  if (url.pathname.indexOf('/biblias/') !== -1) return;   // Biblias (pesadas): se guardan en IndexedDB, no en este caché

  // Todo lo de la app: primero red (con revisión de que no esté viejo); sin red o con red lenta, la copia guardada
  e.respondWith(networkFirst(req, 3000));
});

function networkFirst(req, ms) {
  return new Promise((resolve) => {
    let done = false;
    const fromCache = () => caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : null));
    const timer = setTimeout(() => fromCache().then((r) => { if (r && !done) { done = true; resolve(r); } }), ms);
    fetch(req, { cache: 'no-cache' }).then((res) => {
      clearTimeout(timer);
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
      if (!done) { done = true; resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      fromCache().then((r) => { if (!done) { done = true; resolve(r || Response.error()); } });
    });
  });
}
