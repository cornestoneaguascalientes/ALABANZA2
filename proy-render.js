/**
 * PROY-RENDER.JS - Dibuja el "estado en vivo" en un contenedor.
 *
 * Lo usan: la ventana de proyección (salida.html), el Lower Third, la vista de escenario
 * y los monitores Preview / Live de la consola del operador. Todos reciben el mismo objeto de estado
 * (ver Proy.createController().liveState()), así lo que ves en el monitor es lo que sale al aire.
 *
 *   const r = Proy.Render.mount(elemento, { mode: 'pantalla' | 'lower' | 'escenario', muted: false });
 *   r.update(estado);
 */
(function (root) {
  'use strict';

  const Proy = root.Proy = root.Proy || {};
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lines = (t) => String(t == null ? '' : t).split('\n').map((l) => '<p>' + (esc(l) || '&nbsp;') + '</p>').join('');

  const FONTS = {
    system: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
    sans: '"Instrument Sans", system-ui, Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, Consolas, "Courier New", monospace',
    impact: 'Impact, "Arial Black", sans-serif'
  };

  // ---------- Media (imágenes / videos guardados en IndexedDB) ----------
  const mediaCache = new Map();   // id -> Promise<{ url, kind } | null>
  function mediaInfo(id) {
    if (!id) return Promise.resolve(null);
    if (!mediaCache.has(id)) {
      mediaCache.set(id, Proy.DB.get('media', id)
        .then((r) => {
          if (r && r.blob) return { url: URL.createObjectURL(r.blob), kind: r.kind };
          mediaCache.delete(id);           // todavía no existe: se vuelve a intentar la próxima vez
          return null;
        })
        .catch(() => { mediaCache.delete(id); return null; }));
    }
    return mediaCache.get(id);
  }
  function forgetMedia(id) {
    const p = mediaCache.get(id);
    mediaCache.delete(id);
    if (p) p.then((m) => { if (m) URL.revokeObjectURL(m.url); });
  }

  const MAIN_HTML =
    '<div class="pr-bg"><div class="pr-bgl"></div><div class="pr-bgl"></div></div>' +
    '<div class="pr-dim"></div>' +
    '<div class="pr-txt"></div><div class="pr-txt"></div>' +
    '<div class="pr-logo"><img alt=""></div>' +
    '<div class="pr-cd"><div class="pr-cd-l"></div><div class="pr-cd-t"></div></div>' +
    '<div class="pr-black"></div>';

  const STAGE_HTML =
    '<div class="ps-top"><span class="ps-badge"></span><span class="ps-cd"></span><span class="ps-clock"></span></div>' +
    '<div class="ps-cur"><div class="ps-lab"></div><div class="ps-body"></div></div>' +
    '<div class="ps-nxt"><div class="ps-nlab">SIGUIENTE</div><div class="ps-nbody"></div></div>' +
    '<div class="ps-msg"></div>';

  /** Achica la letra hasta que el texto quepa en su caja (la caja tiene tamaño fijo por CSS) */
  function fit(box, scale) {
    const inner = box.firstElementChild;
    if (!inner) return;
    const H = box.clientHeight, W = box.clientWidth;
    if (!H || !W) return;
    let size = Math.max(12, H * 0.17 * (scale || 1));
    box.style.fontSize = size + 'px';
    for (let k = 0; k < 30 && size > 11; k++) {
      if (inner.scrollHeight <= H + 1 && inner.scrollWidth <= W + 1) break;
      size *= 0.93;
      box.style.fontSize = size + 'px';
    }
  }

  function effectiveBg(base, slide) {
    const b = Object.assign({ mediaId: null, color: '#000000', dim: 0.35, blur: 0, fit: 'cover' }, base || {});
    if (slide && slide.kind === 'media') return { mediaId: slide.mediaId, color: '#000000', dim: 0, blur: 0, loop: !!slide.loop, fg: true, fit: 'contain' };   // imágenes/videos de anuncio: completos, sin recortar ni deformar
    if (slide && slide.bg) Object.assign(b, slide.bg);
    return b;
  }

  function slideHtml(slide, set) {
    if (slide.kind === 'bible' && slide.versions && slide.versions.length) {
      const two = slide.versions.length > 1;
      const cls = 'pr-bible' + (two ? ' pr-two pr-' + (set.bibleLayout === 'split' ? 'split' : 'stack') : '');
      return '<div class="pr-in ' + cls + '">' + slide.versions.map((v) =>
        '<div class="pr-ver"><div class="pr-vtext">' + lines(v.text) + '</div><div class="pr-vref">' + esc(v.ref) + (v.ver ? ' · ' + esc(v.ver) : '') + '</div></div>').join('') + '</div>';
    }
    return '<div class="pr-in"><div class="pr-vtext">' + lines(slide.text) + '</div></div>';
  }


  // ============================================================
  // Sonido de la cuenta regresiva (últimos 10 s): latidos que suben de intensidad + colchón (pad) + reverb
  // Todo se sintetiza con Web Audio (sin archivos). Cada golpe se programa con el reloj de audio, así que no se desfasa.
  // ============================================================
  const Sound = (function () {
    let ctx = null, dry = null, conv = null, noiseBuf = null;

    function impulse(c, secs, decay) {             // reverb sintética: ruido que se apaga, suavizado para que sea "cálido"
      const len = Math.floor(c.sampleRate * secs), buf = c.createBuffer(2, len, c.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch); let lp = 0;
        for (let i = 0; i < len; i++) {
          lp += ((Math.random() * 2 - 1) - lp) * 0.35;
          d[i] = lp * Math.pow(1 - i / len, decay);
        }
      }
      return buf;
    }

    function ensure() {
      if (ctx) return ctx;
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
      const master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
      dry = ctx.createGain(); dry.gain.value = 0.85; dry.connect(master);
      conv = ctx.createConvolver(); conv.buffer = impulse(ctx, 2.8, 2.4);
      const wet = ctx.createGain(); wet.gain.value = 0.55; conv.connect(wet); wet.connect(master);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
      return ctx;
    }

    function unlock() { const c = ensure(); if (c && c.state === 'suspended') c.resume().catch(() => {}); return !!c && c.state === 'running'; }
    const running = () => !!ctx && ctx.state === 'running';

    const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    /** Nota base grave (C2..B2) del tono elegido; null = sin colchón */
    function rootOf(key) {
      if (key === 'off') return null;
      const pc = PC[key] == null ? 4 : PC[key];                                   // si no se reconoce: Mi
      return 36 + pc;
    }

    function env(g, t, peak, decay) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    }
    function thump(out, t, f0, f1, peak, decay) {   // golpe grave (bombo suave)
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + 0.14);
      env(g, t, peak, decay);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + decay + 0.05);
    }
    function puff(out, t, peak, decay, freq) {      // golpe de aire (da cuerpo al ataque)
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noiseBuf; f.type = 'lowpass'; f.frequency.value = freq || 700;
      env(g, t, peak, decay);
      s.connect(f); f.connect(g); g.connect(out); s.start(t); s.stop(t + decay + 0.05);
    }
    function bell(out, t, freq, peak, decay) {      // campana suave (solo en los últimos segundos)
      [1, 2.0].forEach((m, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = freq * m;
        env(g, t, peak / (i + 1), decay);
        o.connect(g); g.connect(out); o.start(t); o.stop(t + decay + 0.05);
      });
    }

    /** Un "latido" (lub-dub) por segundo; i = 0..1 sube la intensidad */
    function beat(out, t, i, k, root) {
      const g = 0.38 + 0.62 * i;
      thump(out, t, 135, 46, g, 0.42 + 0.25 * i);
      puff(out, t, 0.16 * g, 0.09, 900);
      thump(out, t + 0.21, 108, 44, g * (0.55 + 0.15 * i), 0.3);          // el segundo golpe es más suave
      if (k <= 5 && root != null) bell(out, t + 0.02, hz(root + 36), 0.035 + 0.05 * i, 1.1);   // brillo: la tónica del tono, dos octavas arriba
      if (k <= 3) thump(out, t + 0.5, 90, 42, g * 0.35, 0.25);              // y se agrega un tercer pulso muy suave
    }

    /** Colchón: acorde ABIERTO (tónica y quinta, sin tercera, así queda bien en tono mayor o menor) que sube de volumen y se va abriendo */
    function pad(out, t0, t1, root) {
      const f = ctx.createBiquadFilter(), g = ctx.createGain();
      f.type = 'lowpass'; f.Q.value = 0.7;
      f.frequency.setValueAtTime(220, t0); f.frequency.exponentialRampToValueAtTime(2400, t1);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.2, t1);
      g.gain.setTargetAtTime(0.0001, t1, 0.5);                                // al llegar a cero se suelta
      f.connect(g); g.connect(out);
      [root, root + 7, root + 12, root + 19].forEach((m, j) => {
        [-5, 5].forEach((cents) => {
          const o = ctx.createOscillator(); o.type = j === 0 ? 'sine' : 'triangle'; o.frequency.value = hz(m); o.detune.value = cents;
          const og = ctx.createGain(); og.gain.value = j === 0 ? 0.9 : 0.45;
          o.connect(og); og.connect(f); o.start(t0); o.stop(t1 + 3);
        });
      });
    }

    /** Latido final al llegar a cero: un lub-dub como los demás, un poco más fuerte y con una caída larga (la reverb lo alarga todavía más) */
    function boom(out, t, root) {
      thump(out, t, 135, 46, 1.2, 2.6);                  // lub: más fuerte que el último latido (1.0) y se apaga despacio
      puff(out, t, 0.2, 0.09, 900);
      thump(out, t + 0.21, 108, 44, 0.85, 1.8);          // dub
    }

    /** Programa los 10 latidos + el golpe final para que caigan justo cuando cambia cada número. endAt = hora (ms) en que llega a cero */
    function schedule(endAt, volume, key) {
      const root = rootOf(key == null ? 'E' : key);
      const c = ensure();
      if (!c) return null;
      if (c.state === 'suspended') c.resume().catch(() => {});
      const now = c.currentTime, nowMs = Date.now();
      const T = (ms) => now + (ms - nowMs) / 1000;
      const out = c.createGain();
      out.gain.value = Math.max(0, Math.min(1, volume == null ? 0.7 : volume));
      out.connect(dry); out.connect(conv);
      if (root != null) pad(out, Math.max(now, T(endAt - 10000)), Math.max(now + 0.5, T(endAt)), root);
      for (let k = 10; k >= 1; k--) {
        const t = T(endAt - k * 1000);
        if (t >= now - 0.05) beat(out, Math.max(t, now), (10 - k) / 9, k, root);   // los que ya pasaron no se tocan
      }
      if (T(endAt) >= now - 0.05) boom(out, Math.max(T(endAt), now), root);
      return {
        stop() {
          try { out.gain.cancelScheduledValues(c.currentTime); out.gain.setTargetAtTime(0, c.currentTime, 0.04); } catch (e) { /* noop */ }
          setTimeout(() => { try { out.disconnect(); } catch (e) { /* noop */ } }, 600);
        }
      };
    }

    /** Escucha cómo suena (10 s de prueba) */
    function preview(volume, key) { unlock(); return schedule(Date.now() + 10300, volume, key); }

    return { unlock, running, schedule, preview };
  })();

  function mount(host, opts) {
    const o = opts || {};
    const mode = o.mode || 'pantalla';
    const muted = !!o.muted;
    host.classList.add('pr-root', 'pr-' + mode);
    host.innerHTML = mode === 'escenario' ? STAGE_HTML : MAIN_HTML;
    const q = (c) => host.querySelector('.' + c);
    let state = null, timer = null, clock = null, ro = null;

    // ---------- Escenario ----------
    if (mode === 'escenario') {
      const el = { badge: q('ps-badge'), cd: q('ps-cd'), clock: q('ps-clock'), lab: q('ps-lab'), body: q('ps-body'), nbody: q('ps-nbody'), nlab: q('ps-nlab'), msg: q('ps-msg') };
      const plain = (s) => (s ? (s.kind === 'bible' && s.versions && s.versions[0] ? s.versions[0].text + '\n' + s.versions[0].ref : s.text || '') : '');
      const draw = () => {
        const st = state || {};
        const f = st.flags || {};
        el.badge.textContent = f.black ? 'PANTALLA NEGRA' : f.logo ? 'LOGO' : f.clear ? 'TEXTO LIMPIO' : '';
        const s = st.slide;
        el.lab.textContent = s ? (s.label + (s.part ? ' ' + s.part : '') + (st.itemTitle ? ' · ' + st.itemTitle : '')) : '';
        el.lab.style.borderColor = s ? s.color : 'transparent';
        el.body.innerHTML = s ? '<div class="pr-in"><div class="pr-vtext">' + lines(plain(s)) + '</div></div>' : '';
        el.nbody.innerHTML = st.next ? '<div class="pr-in"><div class="pr-vtext">' + lines(plain(st.next)) + '</div></div>' : '';
        el.nlab.style.visibility = st.next ? 'visible' : 'hidden';
        el.msg.textContent = st.stageMsg || '';
        el.msg.style.display = st.stageMsg ? 'block' : 'none';
        fit(el.body, (s && s.fontScale) || 1);
        fit(el.nbody, 0.55);
      };
      const tickClock = () => {
        el.clock.textContent = new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const cd = state && state.countdown;
        if (cd) {
          const rem = Math.max(0, Math.ceil((cd.endAt - Date.now()) / 1000));
          el.cd.textContent = (cd.label ? cd.label + ' ' : '') + String(Math.floor(rem / 60)).padStart(2, '0') + ':' + String(rem % 60).padStart(2, '0');
          el.cd.classList.toggle('ps-cd-final', !!((state.settings || {}).cdFinal) && rem <= 10 && rem > 0);
        } else el.cd.textContent = '';
      };
      clock = setInterval(tickClock, 500);
      tickClock();
      if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => draw()); ro.observe(host); }
      return {
        mode,
        update(st) { state = st; draw(); tickClock(); },
        refit: draw,
        destroy() { clearInterval(clock); if (ro) ro.disconnect(); }
      };
    }

    // ---------- Pantalla y Lower Third ----------
    const bgWrap = q('pr-bg'), bgLayers = [].slice.call(host.querySelectorAll('.pr-bgl'));
    const dim = q('pr-dim'), txt = [].slice.call(host.querySelectorAll('.pr-txt'));
    const logo = q('pr-logo'), logoImg = logo.querySelector('img');
    const cdEl = q('pr-cd'), cdL = q('pr-cd-l'), cdT = q('pr-cd-t'), black = q('pr-black');
    let act = 0, lastKey = '', lastId = '', lastScale = 1;
    let bgAct = 0, bgKey = '', bgTok = 0, logoKey = '';

    function textVars(t) {
      const x = t || {};
      host.style.setProperty('--pr-font', FONTS[x.font] || x.font || FONTS.system);
      host.style.setProperty('--pr-weight', x.weight || 700);
      host.style.setProperty('--pr-color', x.color || '#fff');
      host.style.setProperty('--pr-align', x.align || 'center');
      host.style.setProperty('--pr-upper', x.uppercase ? 'uppercase' : 'none');
      host.style.setProperty('--pr-shadow', x.shadow === false ? 'none' : '0 0.04em 0.14em rgba(0,0,0,.85), 0 0 0.35em rgba(0,0,0,.55)');
    }

    async function applyBg(eff) {
      dim.style.opacity = eff.dim;
      bgWrap.style.filter = eff.blur > 0 ? 'blur(' + eff.blur + 'px)' : '';
      bgWrap.style.transform = eff.blur > 0 ? 'scale(1.06)' : '';
      const key = [eff.mediaId || '', eff.color, eff.fit || 'cover', eff.loop ? 1 : 0, eff.fg ? (state && state.showN) : ''].join('|');
      if (key === bgKey) return;
      bgKey = key;
      const tok = ++bgTok;
      const next = bgLayers[1 - bgAct], old = bgLayers[bgAct];
      next.innerHTML = '';
      next.style.backgroundImage = '';
      next.style.backgroundColor = eff.color || '#000';
      const fit = eff.fit === 'contain' ? 'contain' : 'cover';
      next.style.backgroundSize = fit;
      if (eff.mediaId) {
        const m = await mediaInfo(eff.mediaId);
        if (tok !== bgTok) return;
        if (m && m.kind === 'video') {
          const v = document.createElement('video');
          v.src = m.url;
          v.loop = eff.fg ? !!eff.loop : true;           // los fondos siempre en bucle; un video de anuncio solo si se pidió
          v.muted = muted || !eff.fg;                     // los fondos no llevan audio
          v.playsInline = true;
          v.style.objectFit = fit;
          v.autoplay = true;
          next.appendChild(v);
          const p = v.play();
          if (p && p.catch) p.catch(() => {
            if (!v.muted) { v.muted = true; v.play().catch(() => {}); if (o.onAudioBlocked) o.onAudioBlocked(); }
          });
        } else if (m) next.style.backgroundImage = 'url("' + m.url + '")';
      }
      next.classList.add('on');
      old.classList.remove('on');
      bgAct = 1 - bgAct;
      setTimeout(() => { if (tok === bgTok) old.innerHTML = ''; }, 800);   // detiene el video anterior
    }

    function renderText(slide, set) {
      if (!slide) { txt.forEach((l) => l.classList.remove('on')); lastKey = ''; lastId = ''; return; }
      const sizeSetting = mode === 'lower' ? (set.lower && set.lower.size) : (set.text && set.text.size);
      const key = [slide.id, slide.text, slide.fontScale || 1, JSON.stringify(slide.versions || ''), sizeSetting, set.bibleLayout, mode].join('|');
      if (key === lastKey && txt[act].classList.contains('on')) return;
      const inPlace = lastId === slide.id && txt[act].classList.contains('on');   // misma diapositiva editada: sin fundido
      const L = inPlace ? txt[act] : txt[1 - act];
      L.innerHTML = slideHtml(slide, set);
      lastScale = (slide.fontScale || 1) * (sizeSetting || 100) / 100 * (mode === 'lower' ? 0.9 : 1);
      fit(L, lastScale);
      if (!inPlace) { txt[act].classList.remove('on'); act = 1 - act; L.classList.add('on'); }
      lastKey = key; lastId = slide.id;
    }

    async function applyLogo(set) {
      const key = set.logoMediaId || 'default';
      if (key === logoKey) return;
      logoKey = key;
      const m = set.logoMediaId ? await mediaInfo(set.logoMediaId) : null;
      logoImg.src = m && m.kind === 'image' ? m.url : 'logo_pagina_2.jpg';
    }

    // Sonido: se programa una sola vez por cuenta, cuando faltan ~10 s (solo la salida lo usa: opts.sound)
    let seq = null, seqKey = null;
    function soundSync() {
      if (!o.sound || mode !== 'pantalla') return;
      const cd = state && state.countdown, set = (state && state.settings) || {};
      const early = () => seq && seqKey && Date.now() < seqKey - 50;           // ¿se canceló antes de llegar a cero?
      if (!(cd && set.cdSound)) { if (early()) seq.stop(); seq = null; seqKey = null; return; }   // si ya llegó a cero, el golpe final termina de sonar
      if (seqKey && cd.endAt !== seqKey) { if (early()) seq.stop(); seq = null; seqKey = null; }
      if (seqKey === cd.endAt) return;
      const left = cd.endAt - Date.now();
      if (left > 10600 || left < -500) return;
      if (!Sound.running()) { Sound.unlock(); return; }                         // sin permiso del navegador todavía (falta un clic en la ventana)
      seq = Sound.schedule(cd.endAt, (set.cdVolume == null ? 70 : set.cdVolume) / 100, set.cdPad);
      seqKey = seq ? cd.endAt : null;
    }
    function tickAll() { soundSync(); tickCountdown(); }

    let cdSec = -1;
    function tickCountdown() {
      const cd = state && state.countdown;
      if (!cd || mode !== 'pantalla') { cdEl.classList.remove('on'); return; }
      const now = Date.now();
      const rem = Math.max(0, Math.ceil((cd.endAt - now) / 1000));
      const finalMode = !!((state.settings || {}).cdFinal) && rem <= 10;      // últimos 10 s en grande (opcional)
      if (now > cd.endAt + (finalMode ? 1500 : 5000)) { cdEl.classList.remove('on', 'final'); return; }   // tras llegar a cero se oculta
      cdL.textContent = cd.label || '';
      cdEl.classList.toggle('final', finalMode);
      if (finalMode) {
        cdEl.classList.toggle('lv-b', rem <= 5 && rem > 3);
        cdEl.classList.toggle('lv-c', rem <= 3);
        if (rem !== cdSec) {                                   // un número nuevo: reinicia la animación (aparece, se queda y se desvanece)
          cdSec = rem;
          cdT.textContent = String(rem);
          cdT.classList.remove('pop');
          void cdT.offsetWidth;
          cdT.classList.add('pop');
        }
      } else {
        cdSec = -1;
        cdEl.classList.remove('lv-b', 'lv-c');
        cdT.classList.remove('pop');
        cdT.textContent = String(Math.floor(rem / 60)).padStart(2, '0') + ':' + String(rem % 60).padStart(2, '0');
      }
      cdEl.classList.add('on');
    }
    timer = setInterval(tickAll, 100);

    function update(st) {
      state = st;
      if (!st) return;
      const f = st.flags || {}, set = st.settings || {}, slide = st.slide;
      textVars(set.text);
      if (mode === 'lower') {
        const chroma = (set.lower && set.lower.chroma) || 'transparent';
        host.style.background = chroma === 'transparent' ? 'transparent' : chroma;
        const visible = slide && !f.black && !f.logo && !f.clear && slide.kind !== 'media' && slide.kind !== 'countdown';
        renderText(visible ? slide : null, set);
        return;
      }
      applyBg(effectiveBg(set.bg, slide));
      const visible = slide && !f.black && !f.logo && !f.clear && slide.kind !== 'media' && slide.kind !== 'countdown';
      renderText(visible ? slide : null, set);
      applyLogo(set);
      logo.classList.toggle('on', !!f.logo && !f.black);
      black.classList.toggle('on', !!f.black);
      tickAll();
    }

    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => { if (txt[act].classList.contains('on')) fit(txt[act], lastScale); });
      ro.observe(host);
    }

    return {
      mode,
      update,
      refit() { fit(txt[act], lastScale); },
      destroy() { clearInterval(timer); if (seq) seq.stop(); if (ro) ro.disconnect(); }
    };
  }

  Proy.Render = { mount, mediaInfo, forgetMedia, FONTS, effectiveBg, Sound };
  if (typeof module !== 'undefined' && module.exports) module.exports = Proy.Render;
})(typeof window !== 'undefined' ? window : globalThis);
