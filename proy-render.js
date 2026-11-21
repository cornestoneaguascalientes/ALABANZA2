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
    const b = Object.assign({ mediaId: null, color: '#000000', dim: 0.35, blur: 0 }, base || {});
    if (slide && slide.kind === 'media') return { mediaId: slide.mediaId, color: '#000000', dim: 0, blur: 0, loop: !!slide.loop, fg: true };
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
      const key = [eff.mediaId || '', eff.color, eff.loop ? 1 : 0, eff.fg ? (state && state.showN) : ''].join('|');
      if (key === bgKey) return;
      bgKey = key;
      const tok = ++bgTok;
      const next = bgLayers[1 - bgAct], old = bgLayers[bgAct];
      next.innerHTML = '';
      next.style.backgroundImage = '';
      next.style.backgroundColor = eff.color || '#000';
      if (eff.mediaId) {
        const m = await mediaInfo(eff.mediaId);
        if (tok !== bgTok) return;
        if (m && m.kind === 'video') {
          const v = document.createElement('video');
          v.src = m.url;
          v.loop = eff.fg ? !!eff.loop : true;           // los fondos siempre en bucle; un video de anuncio solo si se pidió
          v.muted = muted || !eff.fg;                     // los fondos no llevan audio
          v.playsInline = true;
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
    timer = setInterval(tickCountdown, 250);

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
      tickCountdown();
    }

    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => { if (txt[act].classList.contains('on')) fit(txt[act], lastScale); });
      ro.observe(host);
    }

    return {
      mode,
      update,
      refit() { fit(txt[act], lastScale); },
      destroy() { clearInterval(timer); if (ro) ro.disconnect(); }
    };
  }

  Proy.Render = { mount, mediaInfo, forgetMedia, FONTS, effectiveBg };
  if (typeof module !== 'undefined' && module.exports) module.exports = Proy.Render;
})(typeof window !== 'undefined' ? window : globalThis);
