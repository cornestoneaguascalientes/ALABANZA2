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
    START_DELAY: 0.15 // s de margen para que todas las pistas arranquen en el mismo instante
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
      if (p.vol && typeof p.vol === 'object') Object.keys(p.vol).forEach((k) => { volPrefs[k] = clamp(p.vol[k], 0, 1); });
    } catch (e) { /* noop */ }
  }
  function savePrefs() {
    try { localStorage.setItem(CONFIG.PREFS_KEY, JSON.stringify({ mode, vol: volPrefs })); } catch (e) { /* noop */ }
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
  async function getBytes(url) {
    if ('caches' in window) {
      const hit = await caches.match(url);
      if (hit) return hit.arrayBuffer();
    }
    const r = await fetch(url, { mode: 'cors' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.arrayBuffer();
  }

  const decode = (ab) => new Promise((res, rej) => {
    const p = ctx.decodeAudioData(ab, res, rej);
    if (p && p.catch) p.catch(rej);
  });

  const reason = (e) => (e && e.name === 'TypeError' ? 'sin conexión o el servidor bloquea CORS' : (e && e.message) || 'error desconocido');

  async function load(info, keepAdjust) {
    const token = ++loadToken;
    stop();
    if (!keepAdjust) adjust = 0;
    baseSemis = info.tone && info.key ? Music.semitonesBetween(info.key, info.tone) : 0;
    const semis = clamp(baseSemis + adjust, -MAX_SHIFT, MAX_SHIFT);
    let shiftFailed = false;
    ready = false; buffers = {}; duration = 0; offset = 0; song = info; tracks = info.tracks || [];
    ensureGraph();
    buildChannels();
    buildMixer();
    renderAll();
    if (!tracks.length) { status('Esta canción no tiene pistas configuradas', true); return false; }
    try {
      for (let n = 0; n < tracks.length; n++) { // una por una: decodificar todas a la vez dispara la memoria
        status('Cargando ' + tracks[n].name + '… (' + (n + 1) + '/' + tracks.length + ')');
        let buf = await decode(await getBytes(tracks[n].url));
        if (token !== loadToken) return false;
        if (semis && tracks[n].shift && window.PitchShift) {
          const name = tracks[n].name;
          try {
            buf = await PitchShift.shiftBuffer(ctx, buf, semis, (f) => {
              if (token === loadToken) status('Cambiando tono de ' + name + '… ' + Math.round(f * 100) + '% (' + (n + 1) + '/' + tracks.length + ')');
            });
          } catch (e) { shiftFailed = true; }
          if (token !== loadToken) return false;
        } else if (semis && tracks[n].shift && !window.PitchShift) shiftFailed = true;
        buffers[tracks[n].id] = buf;
      }
    } catch (e) {
      if (token !== loadToken) return false;
      status('No se pudo cargar: ' + reason(e), true);
      toast('No se pudo cargar la secuencia: ' + reason(e), 'error');
      renderAll();
      return false;
    }
    const ds = tracks.map((t) => buffers[t.id].duration);
    duration = Math.max.apply(null, ds);
    const diff = duration - Math.min.apply(null, ds);
    const mem = tracks.reduce((s, t) => s + buffers[t.id].length * buffers[t.id].numberOfChannels * 4, 0);
    ready = true;
    if (diff > 0.05) status('Aviso: las pistas no miden lo mismo (' + diff.toFixed(2) + ' s de diferencia). Reexporta todas con la misma duración.', true);
    else if (shiftFailed) status('Aviso: no se pudo cambiar el tono; las pistas suenan en su tono original.', true);
    else if (mem > CONFIG.MEM_WARN_BYTES) status('Lista, pero usa ~' + sizeText(mem) + ' de memoria. Si el celular se traba, exporta las pistas en mono.', true);
    else if (Math.abs(semis) > 3) status('Lista · cambio de ' + semis + ' semitonos: puede sonar artificial en voces y teclas.', true);
    else status('Lista · ' + tracks.length + ' pistas' + (semis ? ' · ' + toneLabel() : ''));
    renderAll();
    updateBadge();
    return true;
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

  function setCatalog(obj) {
    Object.keys(obj || {}).forEach((k) => {
      if (!/^\d+$/.test(k)) return;
      const list = normTracks(obj[k]);
      const key = obj[k] && typeof obj[k].key === 'string' && /^[A-G][#b]?$/.test(obj[k].key) ? obj[k].key : '';
      if (list.length) catalog[k] = { key, tracks: list };
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
  function setlistSongs(date) {
    const out = [];
    if (window.Database && Database.isLoaded()) {
      Database.getSetlistEntries(date).forEach((e) => {
        const s = Database.getSongById(e.songId);
        if (s && catalog[s.id]) out.push({ id: s.id, title: s.title, tracks: catalog[s.id].tracks, key: catalog[s.id].key || s.originalKey, tone: e.toneForService || '' });
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
      list = Object.keys(catalog).map((id) => {
        const s = window.Database && Database.isLoaded() ? Database.getSongById(id) : null;
        return { id: Number(id), title: s ? s.title : 'Canción ' + id, tracks: catalog[id].tracks, key: catalog[id].key || (s ? s.originalKey : ''), tone: '' };
      });
    }
    lastList = {};
    list.forEach((s) => { lastList[s.id] = s; });
    const keep = song ? String(song.id) : '';
    sel.innerHTML = '<option value="">' + (list.length ? 'Elige una canción…' : 'No hay secuencias configuradas') + '</option>' +
      list.map((s) => '<option value="' + s.id + '"' + (String(s.id) === keep ? ' selected' : '') + '>' + esc(s.title) + '</option>').join('');
    $('mt-download').disabled = !fromSetlist || downloading;
    $('mt-download').textContent = fromSetlist ? 'Descargar setlist offline' : 'Descargar setlist offline (sin secuencias en esta fecha)';
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
    const date = currentDate();
    const urls = [];
    setlistSongs(date).forEach((s) => s.tracks.forEach((t) => { if (urls.indexOf(t.url) === -1) urls.push(t.url); }));
    if (!urls.length) { toast('Ninguna canción de este setlist tiene secuencia', 'error'); return; }

    downloading = true;
    $('mt-download').disabled = true;
    await requestPersist();
    const name = CONFIG.CACHE_PREFIX + (date || 'setlist');
    let bytes = 0, failed = 0, done = 0, overLimit = false;

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
              if (e && e.name === 'QuotaExceededError' && attempt === 0) await dropOtherCaches(name); // sin espacio: libera los setlists viejos y reintenta
            }
          }
          if (!ok && !overLimit) failed++;
        }
        done++;
        showProgress(done / urls.length * 100);
      }

      if (overLimit) {
        toast('Se alcanzó el límite de 1.5 GB. Este setlist es demasiado grande', 'error');
      } else if (failed) {
        toast(failed + ' archivo(s) no se pudieron descargar. Reintenta con buena señal (el setlist anterior se conservó)', 'error');
      } else {
        // Rotación: ya está todo el setlist nuevo, ahora sí se borra el anterior
        await dropOtherCaches(name);
        const wanted = new Set(urls.map(absUrl));
        for (const req of await cache.keys()) if (!wanted.has(req.url)) await cache.delete(req);
        toast('Setlist guardado para usarse sin internet');
      }
    } catch (e) {
      toast('No se pudo descargar: ' + reason(e), 'error');
    }

    downloading = false;
    showProgress(null);
    refreshSongs();
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
        loadToken++; stop(); teardownChannels(); song = null; tracks = []; ready = false; buffers = {}; duration = 0;
        buildMixer(); renderAll(); updateBadge(); status('');
        return;
      }
      if (lastList[id]) load(lastList[id]);
    });
    $('mt-download').addEventListener('click', downloadSetlist);
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
    /** Carga directa: Multitrack.load({ id: 1, title: 'Gracia', key: 'G', tone: 'A', tracks: [{ name, url, out }] }) */
    load: (info) => load({ id: info.id, title: info.title || '', key: info.key || '', tone: info.tone || '', tracks: normTracks(info.tracks || info) }),
    isReady: () => ready,
    isPlaying: () => playing
  };
})();
