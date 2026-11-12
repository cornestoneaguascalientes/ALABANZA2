/**
 * SW.JS - Service Worker de Alabanza (solo la "cáscara" de la app)
 *
 * - Guarda los archivos de la app para que abra sin internet.
 * - NO toca peticiones a otros dominios (Apps Script, Google Fonts, archive.org).
 * - El audio de las multipistas lo guarda multitrack.js en cachés "alabanza-audio-<fecha>";
 *   aquí NUNCA se borran. Si ya tienes un sw.js, conserva esa regla en tu "activate".
 * - Al cambiar cualquier archivo de la app, sube el número de SHELL (v2, v3…).
 */
const SHELL = 'alabanza-shell-v2';
const FILES = [
  './', 'index.html', 'styles.css',
  'theme.js', 'music.js', 'ui.js', 'audio-core.js', 'database.js',
  'pads.js', 'metronome.js', 'perc.js', 'tuner.js', 'synth.js', 'pitchshift.js', 'multitrack.js', 'setlist.js',
  'secuencias.json',
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

  // Páginas y catálogo: primero red (para ver cambios), sin red usa la copia guardada
  if (req.mode === 'navigate' || url.pathname.endsWith('.json')) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
    );
    return;
  }

  // Resto (js, css, logos): copia guardada al instante y se actualiza en segundo plano
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
