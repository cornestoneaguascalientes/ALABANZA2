/**
 * MULTITRACK.JS - Reproductor multipista para secuencias (número de pistas libre por canción)
 *
 * - Cada canción define sus propias pistas (Click, Guía, Pads, Batería, Bajo, Teclas…), hasta 16.
 * - Todas se decodifican a AudioBuffer y arrancan con UN SOLO start(when, offset) sobre el reloj
 *   de audio: sincronía de muestra, sin deriva.
 * - Mezclador: fader, Mute y Solo por pista. Salida Estéreo normal o Split L/R (StereoPannerNode):
 *   cada pista va a L (in-ear) o R (PA) según su campo "out".
 * - Offline: "Descargar setlist" guarda los MP3 en Cache Storage (un caché por setlist) y, al
 *   terminar bien, borra los cachés de setlists anteriores. Pide almacenamiento persistente.
 * - El audio se lee de Cache Storage desde la página (no depende del Service Worker).
 *
 * - Precarga: mientras suena una canción, la siguiente del setlist se prepara en segundo plano (decodificada y
 *   con su cambio de tono ya aplicado), así que pasar a ella es casi instantáneo. Se limita por memoria.
 * - Cambio de tono: el tono de la canción en la biblioteca (o "key" del catálogo) se compara con el
 *   "tono para el servicio" del setlist y las pistas melódicas se procesan UNA vez al cargar
 *   (pitchshift.js), sin cambiar la duración. Click, guía, batería y percusión no se tocan.
 *
 * Catálogo secuencias.json:
 *   { "<id de canción>": { "key": "G", "tracks": [ { "name": "Click", "url": "https://…", "out": "L", "shift": false }, … ] } }
 *   "key" es opcional: tono en que están grabadas las pistas (por defecto, el tono de la biblioteca).
 *   "out" es opcional: L si el nombre contiene click/guía/voz/cue, R en los demás casos.
 *   "shift" es opcional: false = esa pista nunca cambia de tono; por defecto solo se excluyen
 *   click, guía/voz, batería, percusión y loops.
 *
 * Lo normal: el enlace del item de archive.org se pega en la ficha de la canción (modo administrador) y
 * se guarda en el Google Sheet; secuencias.json queda solo como opción manual / de respaldo.
 *
 * Forma corta (recomendada): en vez de listar cada pista, se indica el item de archive.org y la app
 * lee sola sus archivos (las pistas nuevas aparecen sin tocar GitHub):
 *   { "<id de canción>": { "item": "bautizados_en_fuego", "key": "G", "skip": ["EG 4", "Keys 3"] } }
 *   "skip" es opcional: nombres de archivo (sin .mp3) que no se cargan. También vale: "12": "bautizados_en_fuego".
 */
(function () {
  'use strict';

  const CONFIG = {
    CATALOG_URL: 'secuencias.json',
    CACHE_PREFIX: 'alabanza-audio-',
    MAX_DOWNLOAD_BYTES: 1.5 * 1024 * 1024 * 1024, // tope por descarga de setlist
    MAX_TRACKS: 16,
    MEM_WARN_BYTES: 600 * 1024 * 1024,            // aviso si lo decodificado supera esto
    PREFS_KEY: 'alabanza.multi',
    START_DELAY: 0.15, // s de margen para que todas las pistas arranquen en el mismo instante
    ITEMS_KEY: 'alabanza.multi.items',               // últimas listas de archivos leídas (para usarse sin internet)
    ARCHIVE_BASE: 'https://archive.org/download/',   // si el CORS falla, cambiar a 'https://archive.org/cors/'
    AUDIO_RE: /\.(mp3|wav|flac|m4a|ogg|opus|aac)$/i,
    PRELOAD_AHEAD: 1,        // cuántas canciones siguientes se precargan
    BUDGET_MB: 0             // tope de memoria para canciones cargadas; 0 = se calcula según el equipo
  };

  const LEFT_RE = /click|gu[ií]a|guide|voz|cue/i;
  const OLD_KEYS = { click: 'Click', guide: 'Voz guía', pads: 'Pads', seq: 'Secuencia' }; // formato anterior
  const NOSHIFT_RE = /click|gu[ií]a|guide|voz|cue|bater|drum|perc|shaker|loop/i; // no cambian de tono por defecto
  const MAX_SHIFT = 6; // semitonos máximos

  const $ = (id) => document.getElementById(id);
  const esc = (s) => (window.UI ? UI.escape(s) : String(s));
  const toast = (m, t) => { if (window.UI) UI.toast(m, t); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const sizeText = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB');
  const absUrl = (u) => { try { return new URL(u, location.href).href; } catch (e) { return u; } };

  // ---------- Estado ----------
  let catalog = {};                 // id de canción -> { key, tracks: [ { id, name, url, out, shift } ] }
  let lastList = {};                // id -> canción mostrada en la lista (con key y tono del servicio)
  let baseSemis = 0, adjust = 0, adjustTimer = null; // semitonos del setlist + ajuste manual
  let ctx = null, master = null;
  let nodes = {};                   // id de pista -> { gain, pan }
  let mix = {};                     // id de pista -> { vol, mute, solo }
  let volPrefs = {};                // nombre de pista -> volumen recordado
  let mode = 'stereo';              // 'stereo' | 'split'

  let song = null, tracks = [], buffers = {}, duration = 0, ready = false, loadToken = 0;
  let playing = false, startedAt = 0, offset = 0, sources = {}, timer = null;
  let seeking = false, downloading = false;

  // ---------- Preferencias (modo y faders por nombre de pista; mute/solo no se recuerdan) ----------
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(CONFIG.PREFS_KEY)) || {};
      if (p.mode === 'split') mode = 'split';
      if (p.preload === false) preloadOn = false;
      if (p.vol && typeof p.vol === 'object') Object.keys(p.vol).forEach((k) => { volPrefs[k] = clamp(p.vol[k], 0, 1); });
    } catch (e) { /* noop */ }
  }
  function savePrefs() {
    try { localStorage.setItem(CONFIG.PREFS_KEY, JSON.stringify({ mode, vol: volPrefs, preload: preloadOn })); } catch (e) { /* noop */ }
  }

  // ---------- Grafo de audio ----------
  function ensureGraph() {
    ctx = AudioCore.context();
    if (master) return;
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
  }

  /** Crea el canal (volumen + panorama) de cada pista de la canción actual */
  function buildChannels() {
    ensureGraph();
    teardownChannels();
    tracks.forEach((t) => {
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      gain.connect(pan); pan.connect(master);
      nodes[t.id] = { gain, pan };
      mix[t.id] = { vol: t.name in volPrefs ? volPrefs[t.name] : 0.85, mute: false, solo: false };
    });
    applyMix();
  }

  function teardownChannels() {
    Object.keys(nodes).forEach((k) => { try { nodes[k].gain.disconnect(); nodes[k].pan.disconnect(); } catch (e) { /* noop */ } });
    nodes = {}; mix = {};
  }

  /** Aplica faders, mute/solo y panorama. Solo manda sobre Mute (como en una consola). */
  function applyMix() {
    if (!master) return;
    const anySolo = tracks.some((t) => mix[t.id] && mix[t.id].solo);
    const now = ctx.currentTime;
    tracks.forEach((t) => {
      const m = mix[t.id];
      if (!m || !nodes[t.id]) return;
      const audible = anySolo ? m.solo : !m.mute;
      nodes[t.id].gain.gain.setTargetAtTime(audible ? m.vol : 0, now, 0.015);
      nodes[t.id].pan.pan.setTargetAtTime(mode === 'split' ? (t.out === 'L' ? -1 : 1) : 0, now, 0.015);
    });
  }

  // ---------- Carga (caché primero, red después) ----------
  async function getBytes(url, stats) {
    if ('caches' in window) {
      const hit = await caches.match(url);
      if (hit) { if (stats) stats.saved++; return hit.arrayBuffer(); }
    }
    const r = await fetch(url, { mode: 'cors' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (stats) stats.net++;
    return r.arrayBuffer();
  }

  const decode = (ab) => new Promise((res, rej) => {
    const p = ctx.decodeAudioData(ab, res, rej);
    if (p && p.catch) p.catch(rej);
  });

  const reason = (e) => (e && e.name === 'TypeError' ? 'sin conexión o el servidor bloquea CORS' : (e && e.message) || 'error desconocido');

  // ---------- Carga y precarga ----------
  const cache = new Map();          // "id|semitonos" -> canción ya preparada { tracks, buffers, duration, mem, ... }
  let inflight = null;              // precarga en curso: { key, promise }
  let preloadToken = 0, preloadOn = true, currentKey = '';

  const keyOf = (info, semis) => info.id + '|' + semis;
  const semisFor = (info, adj) => clamp((info.tone && info.key ? Music.semitonesBetween(info.key, info.tone) : 0) + (adj || 0), -MAX_SHIFT, MAX_SHIFT);
  const isCoarse = () => { try { return !!(window.matchMedia && matchMedia('(pointer: coarse)').matches); } catch (e) { return false; } };
  const concurrency = () => (isCoarse() ? 1 : 3);
  /** Tope de memoria para lo cargado (la actual + las precargadas): calculado según el equipo, o CONFIG.BUDGET_MB */
  function budgetBytes() {
    if (CONFIG.BUDGET_MB > 0) return CONFIG.BUDGET_MB * 1048576;
    const dm = navigator.deviceMemory || (isCoarse() ? 4 : 8);
    return (isCoarse() ? dm * 0.15 : dm * 0.5) * 1073741824;
  }
  const cachedBytes = () => [...cache.values()].reduce((a, q) => a + q.mem, 0);
  const setNext = (t) => { const el = $('mt-next'); if (el) el.textContent = t || ''; };

  async function mapPool(items, limit, fn) {
    let i = 0;
    const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  }

  /** Lee/descarga, decodifica y (si hace falta) cambia el tono de todas las pistas de una canción. No toca la reproducción. */
  async function prepareSong(info, semis, cancelled, onStatus, forceResolve) {
    const t0 = performance.now();
    let trs = info.tracks;
    if (info.item && (forceResolve || !trs)) {       // forma corta: se lee la lista de pistas del item
      onStatus('Leyendo la lista de pistas…');
      trs = await resolveItem(info.item, info.skip);
      if (cancelled()) return null;
    }
    if (!trs || !trs.length) throw new Error('esta canción no tiene pistas configuradas');
    ensureGraph();
    const bufs = {};
    const stats = { net: 0, saved: 0, shifted: 0 };   // de dónde salió cada pista y a cuántas se les cambió el tono
    let shiftFailed = false, done = 0, failed = null;
    await mapPool(trs, concurrency(), async (t) => {   // en la computadora se decodifican varias a la vez
      if (failed || cancelled()) return;
      try {
        let buf = await decode(await getBytes(t.url, stats));
        if (failed || cancelled()) return;
        if (semis && t.shift) {
          if (window.PitchShift) {
            try {
              buf = await PitchShift.shiftBuffer(ctx, buf, semis, (f) => { if (!cancelled()) onStatus('Cambiando tono de ' + t.name + '… ' + Math.round(f * 100) + '%'); });
              stats.shifted++;
            } catch (e) { shiftFailed = true; }
          } else shiftFailed = true;
        }
        bufs[t.id] = buf; done++;
        onStatus('Cargando pistas… ' + done + '/' + trs.length);
      } catch (e) { if (!failed) failed = e; }
    });
    if (cancelled()) return null;
    if (failed) throw failed;
    const ds = trs.map((t) => bufs[t.id].duration);
    const duration = Math.max.apply(null, ds);
    return {
      tracks: trs, buffers: bufs, duration, shiftFailed,
      diff: duration - Math.min.apply(null, ds),
      mem: trs.reduce((a, t) => a + bufs[t.id].length * bufs[t.id].numberOfChannels * 4, 0),
      secs: (performance.now() - t0) / 1000, fromPreload: false, stats
    };
  }

  async function load(info, keepAdjust) {
    const token = ++loadToken;
    if (!keepAdjust) adjust = 0;
    stop();
    baseSemis = info.tone && info.key ? Music.semitonesBetween(info.key, info.tone) : 0;
    const semis = clamp(baseSemis + adjust, -MAX_SHIFT, MAX_SHIFT);
    const key = keyOf(info, semis);
    const sameInflight = !!inflight && inflight.key === key;   // si ya se está precargando esta, se espera en vez de empezar de nuevo
    if (!sameInflight) cancelPreload();
    ready = false; buffers = {}; duration = 0; offset = 0; song = info; tracks = info.tracks || [];
    ensureGraph();
    buildChannels();
    buildMixer();
    renderAll();

    let p = cache.get(key);
    if (!p && sameInflight) {
      status('Terminando de preparar la canción…');
      try { await inflight.promise; } catch (e) { /* se reintenta abajo */ }
      if (token !== loadToken) return false;
      p = cache.get(key);
    }
    if (!p) {
      try {
        p = await prepareSong(info, semis, () => token !== loadToken, (t) => { if (token === loadToken) status(t); }, !(keepAdjust && info.tracks));
      } catch (e) {
        if (token === loadToken) {
          status('No se pudo cargar: ' + reason(e), true);
          toast('No se pudo cargar la secuencia: ' + reason(e), 'error');
          renderAll();
        }
        return false;
      }
      if (!p || token !== loadToken) return false;
      cache.set(key, p);
    }
    install(p, semis, key);
    return true;
  }

  /** Deja lista para tocar una canción ya preparada */
  function install(p, semis, key) {
    song.tracks = p.tracks;
    tracks = p.tracks; buffers = p.buffers; duration = p.duration;
    currentKey = key;
    buildChannels();
    buildMixer();
    ready = true;
    renderDownload();
    const st = p.stats || { net: 0, saved: 0, shifted: 0 };
    const detail = [st.net ? st.net + ' bajadas de internet' : '', st.saved ? st.saved + ' desde lo guardado' : '', st.shifted ? 'tono en ' + st.shifted + ' pistas' : ''].filter(Boolean).join(', ');
    const how = p.fromPreload ? ' · precargada' : (p.secs >= 1 ? ' · cargó en ' + p.secs.toFixed(1) + ' s' + (detail ? ' (' + detail + ')' : '') : '');
    if (p.diff > 0.05) status('Aviso: las pistas no miden lo mismo (' + p.diff.toFixed(2) + ' s de diferencia). Reexporta todas con la misma duración.', true);
    else if (p.shiftFailed) status('Aviso: no se pudo cambiar el tono; las pistas suenan en su tono original.', true);
    else if (p.mem > CONFIG.MEM_WARN_BYTES && isCoarse()) status('Lista, pero usa ~' + sizeText(p.mem) + ' de memoria. Si el celular se traba, exporta las pistas en mono.', true);
    else if (Math.abs(semis) > 3) status('Lista · cambio de ' + semis + ' semitonos: puede sonar artificial en voces y teclas.', true);
    else status('Lista · ' + tracks.length + ' pistas' + (semis ? ' · ' + toneLabel() : '') + how);
    renderAll();
    updateBadge();
    trimCache();
    schedulePreload();
  }

  /** Canciones que siguen a la actual en el setlist de la fecha elegida */
  function nextTargets() {
    if (!song) return [];
    const list = setlistSongs(currentDate());
    const i = list.findIndex((x) => x.id === song.id);
    return i < 0 ? [] : list.slice(i + 1, i + 1 + CONFIG.PRELOAD_AHEAD);
  }

  /** Libera de memoria lo que ya no hace falta: se queda la actual y las que siguen */
  function trimCache() {
    const keep = new Set([currentKey]);
    if (preloadOn) nextTargets().forEach((t) => keep.add(keyOf(t, semisFor(t, 0))));
    [...cache.keys()].forEach((k) => { if (!keep.has(k)) cache.delete(k); });
  }

  function cancelPreload() { preloadToken++; setNext(''); }

  /** Prepara en segundo plano la(s) siguiente(s) canción(es) del setlist */
  async function schedulePreload() {
    const pt = ++preloadToken;
    const cancelled = () => pt !== preloadToken;
    if (!preloadOn || !ready) { setNext(''); return; }
    const targets = nextTargets();
    if (!targets.length) { setNext(''); return; }
    for (const t of targets) {
      if (cancelled()) return;
      const sem = semisFor(t, 0), key = keyOf(t, sem);
      if (cache.has(key)) { setNext('Siguiente lista: ' + t.title); continue; }
      const est = Math.max.apply(null, [0].concat([...cache.values()].map((q) => q.mem)));
      if (cachedBytes() + est > budgetBytes()) {
        setNext('No se precarga "' + t.title + '": la memoria no alcanza. Junta pistas o expórtalas en mono.');
        return;
      }
      const promise = prepareSong(t, sem, cancelled, (m) => { if (!cancelled()) setNext('Precargando "' + t.title + '": ' + m); }, true)
        .then((p) => { if (p && !cancelled()) { p.fromPreload = true; cache.set(key, p); } return p; });
      inflight = { key, promise };
      try {
        const p = await promise;
        if (p && !cancelled()) setNext('Siguiente lista: ' + t.title + ' (' + p.secs.toFixed(1) + ' s en prepararse)');
      } catch (e) {
        if (!cancelled()) setNext('No se pudo precargar "' + t.title + '": ' + reason(e));
        return;
      } finally {
        if (inflight && inflight.promise === promise) inflight = null;
      }
    }
  }

  // ---------- Transporte ----------
  const position = () => (playing ? clamp(ctx.currentTime - startedAt, 0, duration) : offset);

  function startSources(from) {
    const when = ctx.currentTime + CONFIG.START_DELAY;
    sources = {};
    tracks.forEach((t) => {
      if (!buffers[t.id]) return;
      const s = ctx.createBufferSource();
      s.buffer = buffers[t.id];
      s.connect(nodes[t.id].gain);
      s.start(when, from); // mismo "when" para todas = sincronía de muestra
      sources[t.id] = s;
    });
    startedAt = when - from;
  }

  function stopSources() {
    Object.keys(sources).forEach((k) => {
      try { sources[k].stop(); sources[k].disconnect(); } catch (e) { /* noop */ }
    });
    sources = {};
  }

  async function play() {
    if (!ready || playing) return;
    ensureGraph();
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* noop */ } }
    if (playing) return; // doble toque mientras se reanudaba el contexto
    if (offset >= duration - 0.05) offset = 0;
    startSources(offset);
    playing = true;
    AudioCore.setActive('multitrack', true);
    clearInterval(timer);
    timer = setInterval(tick, 200); // setInterval y no rAF: sigue vivo con la pantalla bloqueada
    renderTransport();
  }

  function pause() {
    if (!playing) return;
    offset = position();
    stopSources();
    playing = false;
    clearInterval(timer);
    AudioCore.setActive('multitrack', false);
    renderTransport();
  }

  function stop() {
    pause();
    offset = 0;
    renderTransport();
  }

  function seek(t) {
    if (!ready) return;
    t = clamp(t, 0, Math.max(0, duration - 0.1));
    if (playing) { stopSources(); startSources(t); } else offset = t;
    renderTime();
  }

  function tick() {
    if (playing && position() >= duration) { stop(); return; }
    renderTime();
  }

  function setMode(m) {
    mode = m === 'split' ? 'split' : 'stereo';
    applyMix(); savePrefs(); renderMode();
  }
  function toggleMute(id) { if (mix[id]) { mix[id].mute = !mix[id].mute; applyMix(); renderMixer(); } }
  function toggleSolo(id) { if (mix[id]) { mix[id].solo = !mix[id].solo; applyMix(); renderMixer(); } }
  function setVol(id, v) {
    const t = tracks.find((x) => x.id === id);
    if (!t || !mix[id]) return;
    mix[id].vol = clamp(v, 0, 1);
    volPrefs[t.name] = mix[id].vol;
    applyMix(); savePrefs();
  }

  // ---------- Catálogo y canciones del setlist ----------
  /** Acepta { tracks: [{name,url,out}] }, un arreglo directo, o el formato anterior { click, guide, pads, seq } */
  function normTracks(entry) {
    let list = [];
    if (Array.isArray(entry)) list = entry;
    else if (entry && Array.isArray(entry.tracks)) list = entry.tracks;
    else if (entry && typeof entry === 'object') list = Object.keys(entry).map((k) => ({ name: OLD_KEYS[k] || k, url: entry[k] }));
    return list
      .filter((t) => t && typeof t.url === 'string' && /^https:\/\//.test(t.url))
      .slice(0, CONFIG.MAX_TRACKS)
      .map((t, i) => {
        const name = String(t.name || 'Pista ' + (i + 1)).slice(0, 24);
        return {
          id: 't' + i, name, url: t.url,
          out: t.out === 'L' || t.out === 'R' ? t.out : (LEFT_RE.test(name) ? 'L' : 'R'),
          shift: typeof t.shift === 'boolean' ? t.shift : !NOSHIFT_RE.test(name)
        };
      });
  }

  // ---------- Pistas leídas directo de un item de archive.org ----------
  const ITEM_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]*$/;
  const stripExt = (n) => n.replace(/\.[^.\/]+$/, '');
  const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

  function readItemCache() { try { return JSON.parse(localStorage.getItem(CONFIG.ITEMS_KEY)) || {}; } catch (e) { return {}; } }
  function writeItemCache(item, files) {
    const all = readItemCache();
    all[item] = { files, at: Date.now() };
    try { localStorage.setItem(CONFIG.ITEMS_KEY, JSON.stringify(all)); } catch (e) { /* noop */ }
  }

  /** Pistas de un item: con internet lee la lista de archive.org (las pistas nuevas aparecen solas);
   *  sin internet usa la última lista guardada. Solo cuenta audio original (no las copias que genera archive.org). */
  async function resolveItem(item, skip) {
    let files = null;
    try {
      const r = await fetch('https://archive.org/metadata/' + encodeURIComponent(item), { cache: 'no-cache' });
      if (r.ok) {
        const j = await r.json();
        files = (j.files || []).filter((f) => f.source === 'original' && CONFIG.AUDIO_RE.test(f.name)).map((f) => f.name);
        if (files.length) writeItemCache(item, files);
      }
    } catch (e) { /* sin red o sin CORS: se usa la lista guardada */ }
    if (!files || !files.length) { const c = readItemCache()[item]; files = c ? c.files : null; }
    if (!files || !files.length) throw new Error('no se pudo leer la lista de pistas de archive.org');
    const skipSet = new Set((skip || []).map((x) => String(x).trim().toLowerCase()));
    const list = files
      .filter((n) => !skipSet.has(stripExt(n).toLowerCase()) && !skipSet.has(n.toLowerCase()))
      .map((n) => ({
        name: stripExt(n.split('/').pop()),
        url: CONFIG.ARCHIVE_BASE + encodeURIComponent(item) + '/' + n.split('/').map(encodeURIComponent).join('/')
      }))
      .sort((a, b) => (LEFT_RE.test(b.name) - LEFT_RE.test(a.name)) || natural(a.name, b.name)); // click y guía primero
    const tracks = normTracks(list);
    if (!tracks.length) throw new Error('el item no tiene pistas de audio');
    return tracks;
  }

  /** Acepta por canción: "item" (forma corta) o la lista manual de pistas ("tracks") */
  function setCatalog(obj) {
    Object.keys(obj || {}).forEach((k) => {
      if (!/^\d+$/.test(k)) return;
      const v = obj[k];
      const key = v && typeof v.key === 'string' && /^[A-G][#b]?$/.test(v.key) ? v.key : '';
      const item = typeof v === 'string' ? v : (v && typeof v.item === 'string' ? v.item : '');
      const list = typeof v === 'string' ? [] : normTracks(v);
      if (list.length) catalog[k] = { key, tracks: list, item: '', skip: [] };
      else if (ITEM_RE.test(item)) catalog[k] = { key, tracks: null, item, skip: Array.isArray(v && v.skip) ? v.skip : [] };
    });
    refreshSongs();
  }

  async function loadCatalog() {
    try {
      const r = await fetch(CONFIG.CATALOG_URL, { cache: 'no-cache' });
      if (r.ok) setCatalog(await r.json());
    } catch (e) { /* sin red: el Service Worker sirve la copia guardada */ }
  }

  const currentDate = () => { const el = $('setlist-date'); return el && el.value ? el.value : ''; };

  /** Canciones del setlist de la fecha elegida que tienen secuencia */
  /** Identificador de archive.org a partir de un enlace (details, download, items) o del identificador solo */
  function parseItem(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    const m = t.match(/archive\.org\/(?:details|download|embed|metadata|compress|stream)\/([A-Za-z0-9][A-Za-z0-9_.\-]*)/i) ||
              t.match(/\/items\/([A-Za-z0-9][A-Za-z0-9_.\-]*)/);
    const id = m ? m[1] : t;
    return ITEM_RE.test(id) ? id : '';
  }

  /** Secuencia de una canción: primero la de su ficha (Google Sheet), si no la de secuencias.json */
  function sequenceFor(s) {
    const item = parseItem(s.sequence);
    if (item) return { key: '', tracks: null, item, skip: String(s.seqSkip || '').split(',').map((x) => x.trim()).filter(Boolean) };
    return catalog[s.id] || null;
  }

  function setlistSongs(date) {
    const out = [];
    if (window.Database && Database.isLoaded()) {
      Database.getSetlistEntries(date).forEach((e) => {
        const s = Database.getSongById(e.songId);
        const c = s ? sequenceFor(s) : null;
        if (c) out.push({ id: s.id, title: s.title, tracks: c.tracks, item: c.item, skip: c.skip, key: c.key || s.originalKey, tone: e.toneForService || '' });
      });
    }
    return out;
  }

  function refreshSongs() {
    const sel = $('mt-song');
    if (!sel) return;
    let list = setlistSongs(currentDate());
    const fromSetlist = list.length > 0;
    if (!fromSetlist) { // sin setlist con secuencias: se ofrece todo el catálogo
      const ids = new Set(Object.keys(catalog));
      const ready = window.Database && Database.isLoaded();
      if (ready) Database.getAllSongs().forEach((x) => { if (parseItem(x.sequence)) ids.add(String(x.id)); });
      list = [...ids].map((id) => {
        const s = ready ? Database.getSongById(id) : null;
        const c = (s ? sequenceFor(s) : null) || catalog[id];
        return { id: Number(id), title: s ? s.title : 'Canción ' + id, tracks: c.tracks, item: c.item, skip: c.skip, key: c.key || (s ? s.originalKey : ''), tone: '' };
      }).sort((a, b) => a.title.localeCompare(b.title));
    }
    lastList = {};
    list.forEach((s) => { lastList[s.id] = s; });
    const keep = song ? String(song.id) : '';
    sel.innerHTML = '<option value="">' + (list.length ? 'Elige una canción…' : 'No hay secuencias configuradas') + '</option>' +
      list.map((s) => '<option value="' + s.id + '"' + (String(s.id) === keep ? ' selected' : '') + '>' + esc(s.title) + '</option>').join('');
    renderDownload();
  }

  /** Qué se descargará: las canciones del setlist de la fecha que tengan secuencia; si no hay, la canción elegida */
  function downloadPlan() {
    const date = currentDate();
    const list = setlistSongs(date);
    if (list.length) return { kind: 'setlist', songs: list, name: CONFIG.CACHE_PREFIX + (date || 'setlist') };
    if (song) return { kind: 'song', songs: [song], name: CONFIG.CACHE_PREFIX + 'cancion-' + song.id };
    return { kind: 'none', songs: [], name: '' };
  }

  function renderDownload() {
    const b = $('mt-download');
    if (!b) return;
    const p = downloadPlan();
    b.disabled = downloading;
    b.textContent = p.kind === 'setlist'
      ? 'Descargar setlist offline (' + p.songs.length + (p.songs.length === 1 ? ' canción)' : ' canciones)')
      : p.kind === 'song' ? 'Descargar esta canción offline' : 'Descargar offline (elige una canción)';
  }

  // ---------- Offline: descarga + rotación ----------
  async function requestPersist() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        if (await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
      }
    } catch (e) { /* noop */ }
    return false;
  }

  async function dropOtherCaches(keep) {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.indexOf(CONFIG.CACHE_PREFIX) === 0 && n !== keep).map((n) => caches.delete(n)));
  }

  async function downloadSetlist() {
    if (downloading) return;
    if (!('caches' in window)) { toast('Este navegador no permite guardar archivos offline (se necesita HTTPS)', 'error'); return; }
    const plan = downloadPlan();
    if (plan.kind === 'none') {
      toast('El setlist del ' + (currentDate() || 'día elegido') + ' no tiene canciones con secuencia. Agrégalas a ese setlist, o elige una canción de la lista y vuelve a tocar el botón.', 'error');
      return;
    }

    downloading = true;
    renderDownload();
    setBadge('⏳ Leyendo listas de pistas…');
    const urls = [];
    for (const s of plan.songs) {
      try { if (s.item) s.tracks = await resolveItem(s.item, s.skip); } catch (e) {
        toast('No se pudo leer las pistas de "' + s.title + '": ' + reason(e), 'error');
        continue;
      }
      (s.tracks || []).forEach((t) => { if (urls.indexOf(t.url) === -1) urls.push(t.url); });
    }
    if (!urls.length) {
      downloading = false; renderDownload(); updateBadge();
      toast('No se encontraron pistas para descargar', 'error');
      return;
    }

    requestPersist(); // sin esperar: en algunos navegadores pregunta al usuario y no debe frenar la descarga
    const name = plan.name;
    let bytes = 0, failed = 0, done = 0, overLimit = false, firstErr = '';

    try {
      const cache = await caches.open(name);
      showProgress(0);
      for (const url of urls) {
        if (overLimit) break;
        setBadge('⏳ Descargando ' + (done + 1) + '/' + urls.length);
        if (!(await cache.match(url))) {                    // lo ya descargado no se vuelve a bajar
          let ok = false;
          for (let attempt = 0; attempt < 2 && !ok; attempt++) {
            try {
              const r = await fetch(url, { mode: 'cors' });
              if (!r.ok) throw new Error('HTTP ' + r.status);
              const blob = await r.blob();
              bytes += blob.size;
              if (bytes > CONFIG.MAX_DOWNLOAD_BYTES) { overLimit = true; break; }
              await cache.put(url, new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg' } }));
              ok = true;
            } catch (e) {
              if (!firstErr) firstErr = e && e.name === 'QuotaExceededError' ? 'no hay espacio en el celular' : reason(e);
              if (e && e.name === 'QuotaExceededError' && attempt === 0) await dropOtherCaches(name); // sin espacio: libera los setlists viejos y reintenta
            }
          }
          if (!ok && !overLimit) failed++;
        }
        done++;
        showProgress(done / urls.length * 100);
      }

      if (!overLimit && !failed) {                           // comprobación final: todo está realmente guardado
        for (const url of urls) if (!(await cache.match(url))) { failed++; if (!firstErr) firstErr = 'el navegador no guardó el archivo'; }
      }

      if (overLimit) {
        toast('Se alcanzó el límite de 1.5 GB. Este setlist es demasiado grande', 'error');
      } else if (failed) {
        toast(failed + ' de ' + urls.length + ' archivos no se guardaron (' + firstErr + '). Reintenta con buena señal.' + (plan.kind === 'setlist' ? ' El setlist anterior se conservó.' : ''), 'error');
      } else {
        if (plan.kind === 'setlist') {                       // Rotación: ya está todo el setlist nuevo, ahora sí se borra el anterior
          await dropOtherCaches(name);
          const wanted = new Set(urls.map(absUrl));
          for (const req of await cache.keys()) if (!wanted.has(req.url)) await cache.delete(req);
        }
        toast('Listo para usarse sin internet: ' + plan.songs.length + (plan.songs.length === 1 ? ' canción, ' : ' canciones, ') + urls.length + ' pistas' + (bytes ? ' (' + sizeText(bytes) + ' nuevos)' : ' (ya estaban guardadas)'));
      }
    } catch (e) {
      toast('No se pudo descargar: ' + reason(e), 'error');
    }

    downloading = false;
    showProgress(null);
    renderDownload();
    updateBadge();
    updateStorage();
  }

  async function updateBadge() {
    if (downloading) return;
    if (!('caches' in window)) { setBadge('⚠️ Sin soporte offline'); return; }
    if (!song) { setBadge('⚪ Elige una canción'); return; }
    let n = 0;
    for (const t of tracks) if (await caches.match(t.url)) n++;
    setBadge(n === tracks.length && n ? '🟢 Listo para Offline' : n ? '🟡 Parcial (' + n + '/' + tracks.length + ')' : '⚪ Solo en línea');
  }

  async function updateStorage() {
    const el = $('mt-storage');
    if (!el) return;
    let txt = '';
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        txt = 'Almacenamiento: ' + sizeText(e.usage || 0) + ' usados de ' + sizeText(e.quota || 0);
      }
      if (navigator.storage && navigator.storage.persisted) {
        txt += (txt ? ' · ' : '') + ((await navigator.storage.persisted()) ? 'protegido contra borrado' : 'sin protección (el navegador podría borrarlo)');
      }
    } catch (e) { /* noop */ }
    el.textContent = txt;
  }

  // ---------- Pantalla ----------
  function setBadge(t) { const b = $('mt-badge'); if (b) b.textContent = t; }
  function status(t, isError) { const s = $('mt-status'); if (s) { s.textContent = t; s.classList.toggle('err', !!isError); } }
  function showProgress(pct) {
    const p = $('mt-progress');
    if (!p) return;
    p.hidden = pct === null;
    if (pct !== null) p.value = pct;
  }

  function renderTime() {
    const pos = position();
    $('mt-time').textContent = fmt(pos) + ' / ' + fmt(duration);
    if (!seeking) $('mt-seek').value = duration ? Math.round(pos / duration * 1000) : 0;
  }

  function renderTransport() {
    $('mt-play').disabled = $('mt-pause').disabled = $('mt-stop').disabled = $('mt-seek').disabled = !ready;
    $('mt-play').classList.toggle('active', playing);
    $('mt-play').setAttribute('aria-pressed', String(playing));
    $('mt-pause').classList.toggle('active', ready && !playing && offset > 0);
    renderTime();
  }

  function renderMode() {
    document.querySelectorAll('#mt-mode [data-mode]').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    $('mt-mixer').classList.toggle('split', mode === 'split');
    $('mt-mode-hint').textContent = mode === 'split'
      ? 'L (in-ear): pistas marcadas L (Click, Guía) · R (PA): las demás. Cada lado sale en mono.'
      : 'Todo al centro, en estéreo.';
  }

  function renderMixer() {
    const anySolo = tracks.some((t) => mix[t.id] && mix[t.id].solo);
    tracks.forEach((t) => {
      const row = document.querySelector('#mt-mixer [data-ch="' + t.id + '"]');
      const m = mix[t.id];
      if (!row || !m) return;
      row.classList.toggle('silent', anySolo ? !m.solo : m.mute);
      row.querySelector('.mt-mute').classList.toggle('on', m.mute);
      row.querySelector('.mt-mute').setAttribute('aria-pressed', String(m.mute));
      row.querySelector('.mt-solo').classList.toggle('on', m.solo);
      row.querySelector('.mt-solo').setAttribute('aria-pressed', String(m.solo));
    });
  }

  function renderAll() { renderTransport(); renderMixer(); renderMode(); renderPitch(); }

  // ---------- Tono ----------
  function toneLabel() {
    if (!song) return '';
    const key = song.key || 'C';
    const total = clamp(baseSemis + adjust, -MAX_SHIFT, MAX_SHIFT);
    if (!total) return 'Tono original (' + key + ')';
    const target = adjust === 0 && song.tone ? song.tone : Music.transposeNote(key, total, Music.useFlats(Music.pitchClass(key) + total));
    return key + ' → ' + target + ' (' + (total > 0 ? '+' : '') + total + ')';
  }

  function renderPitch() {
    const row = $('mt-pitch-row');
    if (!row) return;
    row.hidden = !song;
    $('mt-pitch').textContent = toneLabel();
  }

  /** Ajuste manual de ±1 semitono; espera un momento por si das varios toques y recarga una sola vez */
  function nudge(d) {
    if (!song) return;
    const total = clamp(baseSemis + adjust + d, -MAX_SHIFT, MAX_SHIFT);
    if (total - baseSemis === adjust) return;
    adjust = total - baseSemis;
    renderPitch();
    clearTimeout(adjustTimer);
    adjustTimer = setTimeout(() => load(song, true), 700);
  }

  /** Dibuja un canal por cada pista de la canción actual */
  function buildMixer() {
    $('mt-mixer').innerHTML = tracks.map((t) =>
      '<div class="mt-ch" data-ch="' + t.id + '">' +
        '<div class="mt-ch-name"><strong>' + esc(t.name) + '</strong><small class="mt-side">' + t.out + '</small></div>' +
        '<input class="mt-fader" type="range" min="0" max="1" step="0.01" value="' + (mix[t.id] ? mix[t.id].vol : 0.85) + '" aria-label="Volumen de ' + esc(t.name) + '">' +
        '<button type="button" class="mt-mute" aria-pressed="false" aria-label="Silenciar ' + esc(t.name) + '">M</button>' +
        '<button type="button" class="mt-solo" aria-pressed="false" aria-label="Solo ' + esc(t.name) + '">S</button>' +
      '</div>').join('');
  }

  // ---------- Inicio ----------
  AudioCore.register('multitrack', { start: play, stop: pause }); // controles de la pantalla de bloqueo

  document.addEventListener('DOMContentLoaded', () => {
    if (!$('tool-multi')) return;
    loadPrefs();
    renderAll();
    setBadge('⚪ Elige una canción');
    status('');

    $('mt-play').addEventListener('click', play);
    $('mt-pause').addEventListener('click', pause);
    $('mt-stop').addEventListener('click', stop);
    $('mt-seek').addEventListener('input', (e) => { seeking = true; if (duration) $('mt-time').textContent = fmt(e.target.value / 1000 * duration) + ' / ' + fmt(duration); });
    $('mt-seek').addEventListener('change', (e) => { seek(e.target.value / 1000 * duration); seeking = false; });
    $('mt-seek').addEventListener('pointercancel', () => { seeking = false; });
    $('mt-mode').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });

    $('mt-mixer').addEventListener('input', (e) => {
      const row = e.target.closest('[data-ch]');
      if (row && e.target.classList.contains('mt-fader')) setVol(row.dataset.ch, e.target.value);
    });
    $('mt-mixer').addEventListener('click', (e) => {
      const row = e.target.closest('[data-ch]');
      if (!row) return;
      if (e.target.closest('.mt-mute')) toggleMute(row.dataset.ch);
      else if (e.target.closest('.mt-solo')) toggleSolo(row.dataset.ch);
    });

    $('mt-song').addEventListener('change', (e) => {
      const id = e.target.value;
      if (!id) {
        loadToken++; cancelPreload(); cache.clear(); currentKey = '';
        stop(); teardownChannels(); song = null; tracks = []; ready = false; buffers = {}; duration = 0;
        buildMixer(); renderAll(); updateBadge(); status(''); renderDownload();
        return;
      }
      if (lastList[id]) load(lastList[id]);
    });
    $('mt-download').addEventListener('click', downloadSetlist);
    const pc = $('mt-preload');
    if (pc) {
      pc.checked = preloadOn;
      pc.addEventListener('change', () => {
        preloadOn = pc.checked; savePrefs();
        if (preloadOn) schedulePreload(); else { cancelPreload(); trimCache(); }
      });
    }
    if ($('mt-pitch-down')) $('mt-pitch-down').addEventListener('click', () => nudge(-1));
    if ($('mt-pitch-up')) $('mt-pitch-up').addEventListener('click', () => nudge(1));

    // La lista depende de la fecha del setlist: se actualiza al entrar a la pestaña y al cambiar los datos
    ['#tool-tabs', '.main-nav', '.menu', '#date-chips'].forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) el.addEventListener('click', () => setTimeout(refreshSongs, 0));
    });
    $('setlist-date').addEventListener('change', refreshSongs);
    window.addEventListener('database:change', refreshSongs);
    window.addEventListener('online', updateBadge);

    // Si el navegador suspendió el contexto con la pantalla bloqueada, se retoma al volver
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && playing && ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    });

    refreshSongs();
    loadCatalog();
    updateStorage();
  });

  window.Multitrack = {
    setCatalog, play, pause, stop, seek, setMode, downloadSetlist,
    /** Multitrack.setPreload({ ahead: 2, budgetMB: 6000 }): cuántas siguientes precargar y cuánta memoria permitir */
    setPreload: (o) => { if (o && o.ahead >= 0) CONFIG.PRELOAD_AHEAD = Math.min(4, Math.floor(o.ahead)); if (o && o.budgetMB >= 0) CONFIG.BUDGET_MB = o.budgetMB; if (ready) { trimCache(); schedulePreload(); } },
    cacheInfo: () => ({ cached: [...cache.keys()], loading: inflight ? inflight.key : null, mb: Math.round(cachedBytes() / 1048576) }),
    /** Carga directa: Multitrack.load({ id: 1, title: 'Gracia', key: 'G', tone: 'A', tracks: [{ name, url, out }] }) */
    load: (info) => load({ id: info.id, title: info.title || '', key: info.key || '', tone: info.tone || '', tracks: normTracks(info.tracks || info) }),
    isReady: () => ready,
    isPlaying: () => playing
  };
})();
