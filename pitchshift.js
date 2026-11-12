/**
 * PITCHSHIFT.JS - Cambio de tono SIN cambiar la duración, procesado de antemano (no en vivo)
 *
 * Método: se remuestrea la pista (cambia el tono y la duración) y luego se estira en el tiempo
 * con WSOLA (superposición de ventanas alineadas por correlación) para recuperar la duración original.
 * - La duración de salida es EXACTAMENTE la de entrada (no se desfasa del click ni de las demás pistas).
 * - Estéreo: las posiciones de corte se calculan con la mezcla mono y se aplican igual a cada canal.
 * - Procesa por tandas y cede el turno al navegador para que la pantalla no se congele.
 * - Funciona bien a ±1 a ±3 semitonos; más allá empiezan los artefactos.
 */
(function (root) {
  'use strict';

  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** Lee x con paso "step" e interpolación cúbica (Catmull-Rom): tono × step, duración / step */
  function resample(x, step) {
    const n = x.length;
    const len = Math.floor((n - 1) / step) + 1;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const p = i * step, j = Math.floor(p), f = p - j;
      const a = x[j > 0 ? j - 1 : 0], b = x[j];
      const c = x[j + 1 < n ? j + 1 : n - 1], d = x[j + 2 < n ? j + 2 : n - 1];
      out[i] = b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a)));
    }
    return out;
  }

  /** Elige, cuadro por cuadro, desde qué punto de la señal leer para que el empalme sea limpio */
  async function plan(mono, sr, alpha, outLen, N, Hs, progress) {
    const L = mono.length;
    const D = 8;                                  // búsqueda gruesa a 1/8 de la frecuencia de muestreo
    const delta = Math.round(0.012 * sr);         // ±12 ms de margen de búsqueda
    const M = N - Hs;                             // zona donde se superponen dos cuadros
    const pad = N + 2 * delta + 4 * D + 16;
    const mp = new Float32Array(L + pad);
    mp.set(mono);

    const Ld = Math.ceil((L + pad) / D);
    const xd = new Float32Array(Ld);
    for (let j = 0; j < Ld; j++) {
      let s = 0;
      for (let q = 0; q < D; q++) { const idx = j * D + q; if (idx < mp.length) s += mp[idx]; }
      xd[j] = s / D;
    }

    const K = Math.ceil(outLen / Hs) + 1;
    const pos = new Int32Array(K);
    const Md = Math.max(8, Math.floor(M / D));
    let slice = 0;

    for (let k = 1; k < K; k++) {
      const nominal = Math.round(k * Hs / alpha);
      const t0 = pos[k - 1] + Hs;                 // continuación natural del cuadro anterior
      if (t0 + M >= L || nominal >= L) { pos[k] = Math.min(nominal, L); continue; }
      const lo = Math.max(0, nominal - delta), hi = Math.min(L - 1, nominal + delta);

      // Etapa gruesa
      const t0d = Math.round(t0 / D);
      let best = -Infinity, bestD = Math.round(nominal / D);
      for (let sd = Math.ceil(lo / D); sd <= Math.floor(hi / D); sd++) {
        let dot = 0, en = 0;
        for (let j = 0; j < Md; j++) { const c = xd[sd + j]; dot += xd[t0d + j] * c; en += c * c; }
        const sc = dot / Math.sqrt(en + 1e-12);
        if (sc > best) { best = sc; bestD = sd; }
      }

      // Etapa fina a la frecuencia completa
      let bestS = Math.min(Math.max(bestD * D, lo), hi), bestSc = -Infinity;
      const f0 = Math.max(lo, bestD * D - D), f1 = Math.min(hi, bestD * D + D);
      for (let s = f0; s <= f1; s++) {
        let dot = 0, en = 0;
        for (let j = 0; j < M; j += 2) { const c = mp[s + j]; dot += mp[t0 + j] * c; en += c * c; }
        const sc = dot / Math.sqrt(en + 1e-12);
        if (sc > bestSc) { bestSc = sc; bestS = s; }
      }
      pos[k] = bestSc > 1e-9 ? bestS : Math.min(Math.max(nominal, lo), hi); // silencio: se queda en la posición nominal

      if (++slice >= 150) { slice = 0; if (progress) progress(k / K); await tick(); }
    }
    return pos;
  }

  /** Suma los cuadros con ventana Hann (50 % de traslape suma 1) */
  function overlapAdd(src, pos, N, Hs, win, out) {
    const outLen = out.length, L = src.length;
    for (let k = 0; k < pos.length; k++) {
      const s = pos[k], o = k * Hs;
      if (o >= outLen || s >= L) continue;
      const count = Math.min(N, L - s, outLen - o);
      if (k === 0) {                              // el primer cuadro no se desvanece al entrar
        for (let i = 0; i < count; i++) out[o + i] += (i < Hs ? 1 : win[i]) * src[s + i];
      } else {
        for (let i = 0; i < count; i++) out[o + i] += win[i] * src[s + i];
      }
    }
  }

  /**
   * chans: Float32Array[] (uno por canal). semitones: entero o decimal (±6 máx.).
   * outs: Float32Array[] opcionales donde escribir (misma longitud que chans[0]); si no, se crean.
   * Devuelve Float32Array[] con la misma longitud que la entrada.
   */
  async function shiftChannels(chans, sr, semitones, onProgress, outs) {
    const n = chans[0].length;
    const st = Math.max(-6, Math.min(6, Number(semitones) || 0));
    if (!st) return chans;
    const r = Math.pow(2, st / 12);               // factor de tono
    const nch = chans.length;
    let N = Math.round(0.05 * sr); N += N % 2;     // cuadro de ~50 ms
    const Hs = N / 2;
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const report = (f) => { if (onProgress) onProgress(Math.min(1, f)); };

    // 1) Mezcla mono de la señal remuestreada (solo para decidir los cortes)
    let mono = null;
    for (let c = 0; c < nch; c++) {
      const rs = resample(chans[c], r);
      if (!mono) mono = new Float32Array(rs.length);
      for (let i = 0; i < rs.length; i++) mono[i] += rs[i] / nch;
      await tick();
    }

    // 2) Plan de cortes
    const pos = await plan(mono, sr, r, n, N, Hs, (f) => report(f * 0.7));
    mono = null;

    // 3) Cada canal: remuestrear y empalmar con el mismo plan
    const result = [];
    for (let c = 0; c < nch; c++) {
      const rs = resample(chans[c], r);
      const out = outs && outs[c] ? outs[c] : new Float32Array(n);
      overlapAdd(rs, pos, N, Hs, win, out);
      result.push(out);
      report(0.7 + 0.3 * (c + 1) / nch);
      await tick();
    }
    return result;
  }

  /** Versión para AudioBuffer: devuelve un AudioBuffer nuevo con el tono cambiado (misma duración) */
  async function shiftBuffer(ctx, buf, semitones, onProgress) {
    if (!semitones) return buf;
    const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    const src = [], dst = [];
    for (let c = 0; c < buf.numberOfChannels; c++) { src.push(buf.getChannelData(c)); dst.push(out.getChannelData(c)); }
    await shiftChannels(src, buf.sampleRate, semitones, onProgress, dst);
    return out;
  }

  const api = { shiftChannels, shiftBuffer, resample };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PitchShift = api;
})(typeof window !== 'undefined' ? window : this);
