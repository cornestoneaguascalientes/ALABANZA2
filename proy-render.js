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
    const b = Object.assign({ mediaId: null, color: '#000000', dim: 0.35, blur: 0, fit: 'cover', preset: null, accent: '' }, base || {});
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


  // ============================================================
  // Fondos animados (hechos con código, sin archivos). Predominan el negro y la luz brillante, para que se distingan en una pared con luz ambiente.
  // La mayoría es CSS puro (casi no gasta); estrellas, brasas y polvo dorado usan un canvas ligero (30 cuadros por segundo).
  // ============================================================
  const Fx = (function () {
    const LIST = [
      { id: 'aurora', name: 'Aurora', accent: '#2fa4ff' },
      { id: 'rayos', name: 'Rayos de luz', accent: '#ffe2a0' },
      { id: 'resplandor', name: 'Resplandor', accent: '#ff8a2b' },
      { id: 'niebla', name: 'Niebla', accent: '#6d86ff' },
      { id: 'ondas', name: 'Ondas', accent: '#35c6ff' },
      { id: 'olas', name: 'Olas', accent: '#2f80ff' },
      { id: 'horizonte', name: 'Horizonte', accent: '#ffb347' },
      { id: 'bordes', name: 'Bordes de luz', accent: '#4fa8ff' },
      { id: 'estrellas', name: 'Estrellas', accent: '#ffffff', canvas: true },
      { id: 'brasas', name: 'Brasas', accent: '#ff7a1a', canvas: true },
      { id: 'polvo', name: 'Polvo dorado', accent: '#ffd36b', canvas: true }
    ];
    const byId = (id) => LIST.filter((f) => f.id === id)[0] || null;

    // ---- color: del acento se sacan 3 tonos brillantes (luminosidad alta = se ven con luz en la pared)
    function hexToHsl(hex) {
      const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
      const n = parseInt(m ? m[1] : 'ffffff', 16);
      const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
      let h = 0, s = 0;
      if (mx !== mn) {
        const d = mx - mn;
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h *= 60;
      }
      return { h, s, l };
    }
    function palette(hex) {
      const c = hexToHsl(hex);
      if (c.s < 0.12) return ['hsl(0,0%,100%)', 'hsl(45,60%,88%)', 'hsl(210,60%,88%)'];       // blanco / casi blanco
      const s = Math.round(Math.max(c.s, 0.8) * 100), l = Math.round(Math.min(Math.max(c.l, 0.52), 0.62) * 100);
      const h = (d) => ((Math.round(c.h) + d) % 360 + 360) % 360;
      return ['hsl(' + h(0) + ',' + s + '%,' + l + '%)', 'hsl(' + h(22) + ',' + s + '%,' + l + '%)', 'hsl(' + h(-24) + ',' + Math.max(s - 6, 60) + '%,' + Math.max(l - 3, 48) + '%)'];
    }

    // ---- HTML de cada fondo (todo el estilo vive en proyeccion.css)
    const WAVE = '<svg class="w" viewBox="0 0 2400 200" preserveAspectRatio="none"><path d="M0 100 Q150 30 300 100 T600 100 T900 100 T1200 100 T1500 100 T1800 100 T2100 100 T2400 100 V200 H0 Z"/></svg>';
    const HTML = {
      aurora: '<i class="b b1"></i><i class="b b2"></i><i class="b b3"></i>',
      rayos: '<i class="glow"></i><i class="r r1"></i><i class="r r2"></i><i class="r r3"></i><i class="r r4"></i><i class="r r5"></i>',
      resplandor: '<i class="g g1"></i><i class="g g2"></i>',
      niebla: '<i class="f f1"></i><i class="f f2"></i><i class="f f3"></i>',
      ondas: '<i class="o o1"></i><i class="o o2"></i><i class="o o3"></i><i class="o o4"></i>',
      olas: '<div class="wv wv1">' + WAVE + '</div><div class="wv wv2">' + WAVE + '</div>',
      horizonte: '<i class="hg"></i><i class="hr"></i><i class="hl"></i>',
      bordes: '<div class="ering"><i></i></div>',
      estrellas: '<canvas width="960" height="540"></canvas>',
      brasas: '<canvas width="960" height="540"></canvas>',
      polvo: '<canvas width="960" height="540"></canvas>'
    };

    // ---- canvas ligero
    function startCanvas(canvas, type, pal, still) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return () => {};
      const W = canvas.width, H = canvas.height, rnd = (a, b) => a + Math.random() * (b - a);
      const col = type === 'estrellas' ? pal[0] : pal[0];
      let P = [], shoot = null, shootAt = 3, raf = 0, last = 0, t = 0, dead = false;
      const make = (init) => {
        if (type === 'estrellas') return { x: rnd(0, W), y: rnd(0, H), r: rnd(0.8, 2.6), ph: rnd(0, 6.28), sp: rnd(0.4, 1.8) };
        if (type === 'brasas') return { x: rnd(0, W), y: init ? rnd(0, H) : H + rnd(0, 40), r: rnd(1.6, 4.6), vy: rnd(0.4, 1.3), ph: rnd(0, 6.28), sw: rnd(0.4, 1.6), sp: rnd(0.8, 2.4) };
        return { x: rnd(0, W), y: rnd(0, H), r: rnd(1.2, 3.8), vx: rnd(-0.12, 0.12), vy: rnd(-0.18, 0.05), ph: rnd(0, 6.28), sp: rnd(0.5, 1.6) };
      };
      const N = type === 'estrellas' ? 130 : type === 'brasas' ? 95 : 80;
      for (let i = 0; i < N; i++) P.push(make(true));

      function step() {
        for (let i = 0; i < P.length; i++) {
          const p = P[i];
          if (type === 'brasas') { p.y -= p.vy; p.x += Math.sin(t * p.sw + p.ph) * 0.35; if (p.y < -10) P[i] = make(false); }
          else if (type === 'polvo') { p.x += p.vx; p.y += p.vy; if (p.x < -5) p.x = W + 5; if (p.x > W + 5) p.x = -5; if (p.y < -5) p.y = H + 5; if (p.y > H + 5) p.y = -5; }
        }
      }
      function draw() {
        ctx.clearRect(0, 0, W, H);
        ctx.shadowColor = col;
        for (const p of P) {
          let a;
          if (type === 'brasas') a = Math.max(0, Math.min(1, (p.y / H) * 1.25)) * (0.55 + 0.45 * Math.sin(t * p.sp + p.ph));
          else a = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * p.sp + p.ph));
          ctx.globalAlpha = Math.max(0, Math.min(1, a));
          ctx.shadowBlur = type === 'estrellas' ? (p.r > 1.8 ? 14 : 6) : 16;
          ctx.fillStyle = type === 'brasas' && p.r < 1.8 ? pal[1] : col;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
        }
        if (type === 'estrellas' && shoot) {                         // estrella fugaz de vez en cuando
          ctx.globalAlpha = Math.max(0, shoot.life);
          ctx.shadowBlur = 8; ctx.strokeStyle = col; ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.moveTo(shoot.x, shoot.y); ctx.lineTo(shoot.x - shoot.vx * 9, shoot.y - shoot.vy * 9); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      function frame(ts) {
        if (dead) return;
        raf = requestAnimationFrame(frame);
        if (ts - last < 33) return;                                   // ~30 cuadros por segundo
        last = ts; t += 0.033;
        step();
        if (type === 'estrellas') {
          shootAt -= 0.033;
          if (!shoot && shootAt <= 0) { shoot = { x: rnd(W * 0.3, W * 0.9), y: rnd(0, H * 0.4), vx: rnd(10, 16), vy: rnd(4, 7), life: 1 }; shootAt = rnd(7, 14); }
          if (shoot) { shoot.x -= shoot.vx; shoot.y += shoot.vy; shoot.life -= 0.035; if (shoot.life <= 0) shoot = null; }
        }
        draw();
      }
      if (still) { for (let i = 0; i < 90; i++) { t += 0.033; step(); } draw(); return () => {}; }
      raf = requestAnimationFrame(frame);
      return () => { dead = true; cancelAnimationFrame(raf); };
    }

    /** Dibuja el fondo `id` dentro de `host`. opts: { accent: '#rrggbb' (vacío = el original), still: true (miniatura sin animar) } */
    function build(host, id, opts) {
      const def = byId(id);
      if (!def) return { stop() {} };
      const o = opts || {};
      const pal = palette(o.accent || def.accent);
      host.classList.add('pr-fx', 'fx-' + id);
      host.style.setProperty('--c1', pal[0]); host.style.setProperty('--c2', pal[1]); host.style.setProperty('--c3', pal[2]);
      host.innerHTML = HTML[id] || '';
      let stop = () => {};
      if (def.canvas) stop = startCanvas(host.querySelector('canvas'), id, pal, !!o.still);
      return { stop() { stop(); stop = () => {}; } };
    }

    return { list: LIST, byId, build, palette };
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
      const key = [eff.mediaId || '', eff.preset || '', eff.accent || '', eff.color, eff.fit || 'cover', eff.loop ? 1 : 0, eff.fg ? (state && state.showN) : ''].join('|');
      if (key === bgKey) return;
      bgKey = key;
      const tok = ++bgTok;
      const next = bgLayers[1 - bgAct], old = bgLayers[bgAct];
      if (next._fx) { next._fx.stop(); next._fx = null; }
      next.classList.remove('pr-fx');
      next.className = next.className.replace(/\bfx-\w+/g, '').trim();
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
      if (eff.preset && !eff.mediaId && !eff.fg) next._fx = Fx.build(next, eff.preset, { accent: eff.accent });   // fondo animado
      next.classList.add('on');
      old.classList.remove('on');
      bgAct = 1 - bgAct;
      setTimeout(() => { if (tok === bgTok) { if (old._fx) { old._fx.stop(); old._fx = null; } old.className = old.className.replace(/\bfx-\w+|\bpr-fx\b/g, '').trim(); old.innerHTML = ''; } }, 800);   // detiene el video / animación anterior
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
      destroy() { clearInterval(timer); if (seq) seq.stop(); bgLayers.forEach((l) => { if (l._fx) l._fx.stop(); }); if (ro) ro.disconnect(); }
    };
  }

  Proy.Render = { mount, mediaInfo, forgetMedia, FONTS, effectiveBg, Sound, Fx };
  if (typeof module !== 'undefined' && module.exports) module.exports = Proy.Render;
})(typeof window !== 'undefined' ? window : globalThis);
