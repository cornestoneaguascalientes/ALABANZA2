/**
 * PROY-CORE.JS - Núcleo del módulo de Proyección en Vivo
 *
 * Lo comparten la consola del operador (index.html), la ventana de proyección (salida.html),
 * el Lower Third y la vista de escenario. No depende de Music, Database ni UI: puede cargarse solo.
 *
 *  Proy.DB             Base de datos local (IndexedDB; si no existe, memoria): canciones, Biblias, media, servicios.
 *  Proy.channel()      Sincronización entre ventanas (BroadcastChannel; respaldo con localStorage).
 *  Proy.Bible          Versiones de la Biblia, citas ("Jn 3:16", "Sal 23 1-4") y búsqueda por palabras.
 *  Proy.Slides         Canción / Biblia / texto -> diapositivas.
 *  Proy.createController()  Estado del servicio, navegación, pantalla negra/limpiar/logo, cuenta regresiva.
 *  Proy.Data           Importar / exportar JSON.
 */
(function (root) {
  'use strict';

  const Proy = root.Proy = root.Proy || {};

  // ============================================================
  // Utilidades
  // ============================================================
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function mergeDeep(t, s) {
    Object.keys(s || {}).forEach((k) => {
      if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) t[k] = mergeDeep(t[k] && typeof t[k] === 'object' ? t[k] : {}, s[k]);
      else t[k] = s[k];
    });
    return t;
  }
  function setPath(o, path, v) {
    const ks = path.split('.');
    let t = o;
    ks.slice(0, -1).forEach((k) => { t = t[k] = t[k] && typeof t[k] === 'object' ? t[k] : {}; });
    t[ks[ks.length - 1]] = v;
  }

  Proy.util = { uid, norm, clamp, clone, mergeDeep, setPath };

  // ============================================================
  // Base de datos local (IndexedDB con respaldo en memoria)
  // ============================================================
  const STORES = ['songs', 'bibles', 'media', 'services', 'meta'];
  const mem = {};
  STORES.forEach((s) => { mem[s] = new Map(); });
  let dbPromise = null;

  /** Abre la base. Devuelve la conexión o null si el navegador no permite IndexedDB (se usa memoria). */
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (typeof root.indexedDB === 'undefined' || !root.indexedDB) { resolve(null); return; }
      try {
        const r = root.indexedDB.open('alabanza-proy', 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          STORES.forEach((s) => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: s === 'meta' ? 'key' : 'id' }); });
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
        r.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return dbPromise;
  }

  async function run(store, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const keyOf = (store, o) => (store === 'meta' ? o.key : o.id);

  const DB = {
    async get(store, key) { return (await openDb()) ? run(store, 'readonly', (s) => s.get(key)) : mem[store].get(key); },
    async put(store, obj) { if (await openDb()) return run(store, 'readwrite', (s) => s.put(obj)); mem[store].set(keyOf(store, obj), obj); return undefined; },
    async del(store, key) { if (await openDb()) return run(store, 'readwrite', (s) => s.delete(key)); mem[store].delete(key); return undefined; },
    async all(store) { return (await openDb()) ? run(store, 'readonly', (s) => s.getAll()) : [...mem[store].values()]; },
    async getMeta(key, dflt) { const r = await DB.get('meta', key); return r && r.value !== undefined ? r.value : dflt; },
    async setMeta(key, value) { return DB.put('meta', { key, value }); },
    isPersistent: async () => !!(await openDb())
  };
  Proy.DB = DB;

  // ============================================================
  // Canal de sincronización entre ventanas
  // ============================================================
  const LS_MSG = 'alabanza.proy.msg';
  const LS_STATE = 'alabanza.proy.state';

  /** BroadcastChannel entre ventanas del mismo navegador; si no existe, respaldo con localStorage (evento "storage") */
  function channel() {
    let bc = null;
    try { if (typeof BroadcastChannel !== 'undefined') bc = new BroadcastChannel('alabanza-proy-v1'); } catch (e) { bc = null; }
    const handlers = new Set();
    const deliver = (m) => handlers.forEach((h) => { try { h(m); } catch (e) { console.error(e); } });
    if (bc) bc.onmessage = (e) => deliver(e.data);
    if (root.addEventListener) {
      root.addEventListener('storage', (e) => {
        if (!bc && e.key === LS_MSG && e.newValue) { try { deliver(JSON.parse(e.newValue).m); } catch (x) { /* noop */ } }
      });
    }
    return {
      usesBroadcast: !!bc,
      on(fn) { handlers.add(fn); return () => handlers.delete(fn); },
      send(m) {
        if (bc) { bc.postMessage(m); return; }
        try { root.localStorage.setItem(LS_MSG, JSON.stringify({ m, n: Math.random() })); } catch (e) { /* noop */ }
      },
      /** Último estado: lo lee una ventana que se abre tarde, antes de recibir el primer mensaje */
      saveState(s) { try { root.localStorage.setItem(LS_STATE, JSON.stringify(s)); } catch (e) { /* noop */ } },
      loadState() { try { return JSON.parse(root.localStorage.getItem(LS_STATE)); } catch (e) { return null; } },
      close() { if (bc) bc.close(); }
    };
  }
  Proy.channel = channel;

  // ============================================================
  // Biblia
  // ============================================================
  // [nombre, alias separados por espacio (sin acentos, minúsculas, sin espacios internos)]
  const BOOKS = [
    ['Génesis', 'gn gen genesis ge'], ['Éxodo', 'ex exo exodo'], ['Levítico', 'lv lev levitico'], ['Números', 'nm num numeros nu'],
    ['Deuteronomio', 'dt deu deut deuteronomio'], ['Josué', 'jos josue'], ['Jueces', 'jue jc jueces'], ['Rut', 'rt rut'],
    ['1 Samuel', '1s 1sa 1sam 1samuel'], ['2 Samuel', '2s 2sa 2sam 2samuel'], ['1 Reyes', '1r 1re 1rey 1reyes'], ['2 Reyes', '2r 2re 2rey 2reyes'],
    ['1 Crónicas', '1cr 1cro 1cronicas'], ['2 Crónicas', '2cr 2cro 2cronicas'], ['Esdras', 'esd esdras'], ['Nehemías', 'neh nehemias'],
    ['Ester', 'est ester'], ['Job', 'job jb'], ['Salmos', 'sal salmo salmos sl'], ['Proverbios', 'pr pro prov proverbios'],
    ['Eclesiastés', 'ec ecl eclesiastes'], ['Cantares', 'cnt cant cantares ct'], ['Isaías', 'is isa isaias'], ['Jeremías', 'jer jeremias'],
    ['Lamentaciones', 'lm lam lamentaciones'], ['Ezequiel', 'ez eze ezequiel'], ['Daniel', 'dn dan daniel'], ['Oseas', 'os ose oseas'],
    ['Joel', 'jl joel'], ['Amós', 'am amos'], ['Abdías', 'abd abdias'], ['Jonás', 'jon jonas'], ['Miqueas', 'mi miq miqueas'],
    ['Nahúm', 'nah nahum'], ['Habacuc', 'hab habacuc'], ['Sofonías', 'sof sofonias'], ['Hageo', 'hag hageo'], ['Zacarías', 'zac zacarias'],
    ['Malaquías', 'mal malaquias'], ['Mateo', 'mt mat mateo'], ['Marcos', 'mr mc mar marcos'], ['Lucas', 'lc luc lucas'],
    ['Juan', 'jn jua juan'], ['Hechos', 'hch hec hechos'], ['Romanos', 'ro rom romanos'], ['1 Corintios', '1co 1cor 1corintios'],
    ['2 Corintios', '2co 2cor 2corintios'], ['Gálatas', 'ga gal galatas'], ['Efesios', 'ef efe efesios'], ['Filipenses', 'fil flp filipenses'],
    ['Colosenses', 'col colosenses'], ['1 Tesalonicenses', '1ts 1tes 1tesalonicenses'], ['2 Tesalonicenses', '2ts 2tes 2tesalonicenses'],
    ['1 Timoteo', '1ti 1tim 1timoteo'], ['2 Timoteo', '2ti 2tim 2timoteo'], ['Tito', 'tit tito'], ['Filemón', 'flm filemon'],
    ['Hebreos', 'he heb hebreos'], ['Santiago', 'stg snt sant santiago'], ['1 Pedro', '1p 1pe 1ped 1pedro'], ['2 Pedro', '2p 2pe 2ped 2pedro'],
    ['1 Juan', '1jn 1jua 1juan'], ['2 Juan', '2jn 2jua 2juan'], ['3 Juan', '3jn 3jua 3juan'], ['Judas', 'jud judas'], ['Apocalipsis', 'ap apo apoc apocalipsis']
  ];

  const ALIAS = new Map();   // alias normalizado -> índice del libro
  BOOKS.forEach(([name, aliases], i) => {
    aliases.split(' ').concat([norm(name).replace(/\s+/g, '')]).forEach((a) => { if (!ALIAS.has(a)) ALIAS.set(a, i); });
  });

  const ORDINALS = { primera: '1', primero: '1', segunda: '2', segundo: '2', tercera: '3', tercero: '3', iii: '3', ii: '2', i: '1' };

  /** "1 Jn", "I Juan", "primera de juan", "Éx." -> "1jn", "1juan", "1juan", "ex" */
  function bookKey(text) {
    let q = norm(text).replace(/[.\u00BA\u00AA]/g, '').trim();
    q = q.replace(/^(primera|primero|segunda|segundo|tercera|tercero|iii|ii|i)\s+(?:de\s+)?/, (m, o) => ORDINALS[o]);
    return q.replace(/\s+/g, '');
  }

  /** Devuelve { idx } si el libro es único, { candidates: [...] } si es ambiguo, o null */
  function resolveBook(text) {
    const key = bookKey(text);
    if (!key) return null;
    if (ALIAS.has(key)) return { idx: ALIAS.get(key) };
    if (key.length < 2) return null;
    const found = new Set();
    ALIAS.forEach((idx, a) => { if (a.indexOf(key) === 0) found.add(idx); });
    if (found.size === 1) return { idx: [...found][0] };
    return found.size ? { candidates: [...found] } : null;
  }

  const SPEC = '(\\d+(?:\\s*[-\\u2013\\u2014]\\s*\\d+)?(?:\\s*,\\s*\\d+(?:\\s*[-\\u2013\\u2014]\\s*\\d+)?)*)';
  const TAIL = new RegExp('(\\d+)(?:\\s*[:.,]\\s*|\\s+)' + SPEC + '\\s*$|(\\d+)\\s*$');

  /**
   * "Jn 3:16", "Juan 3 16", "Sal 23 1-4", "1 Co 13:4-7,13", "Sal 23" (capítulo completo)
   * -> { book, chapter, ranges: [[desde, hasta], ...] | null }  |  { error }  |  null (vacío)
   */
  function parseRef(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const m = t.match(TAIL);
    if (!m) return null;
    const bookText = t.slice(0, m.index).trim();
    if (!bookText) return null;
    const rb = resolveBook(bookText);
    if (!rb) return { error: 'No reconozco el libro "' + bookText + '"' };
    if (rb.candidates) return { error: 'Libro ambiguo: ' + rb.candidates.map((i) => BOOKS[i][0]).join(', ') };
    const chapter = Number(m[1] != null ? m[1] : m[3]);
    let ranges = null;
    if (m[2]) {
      ranges = m[2].split(',').map((p) => {
        const parts = p.split(/[-\u2013\u2014]/).map((x) => Number(x.trim()));
        return [parts[0], parts.length > 1 && !isNaN(parts[1]) ? parts[1] : parts[0]];
      });
    }
    return { book: rb.idx, chapter, ranges };
  }

  /** [1,2,3,5] -> "1-3,5" */
  function compress(nums) {
    const out = [];
    let a = null, b = null;
    nums.slice().sort((x, y) => x - y).forEach((n) => {
      if (a === null) { a = b = n; return; }
      if (n === b + 1) { b = n; return; }
      out.push(a === b ? String(a) : a + '-' + b);
      a = b = n;
    });
    if (a !== null) out.push(a === b ? String(a) : a + '-' + b);
    return out.join(',');
  }

  const formatRef = (ref, nums) => BOOKS[ref.book][0] + ' ' + ref.chapter + (nums && nums.length ? ':' + compress(nums) : '');

  const versions = {};   // id -> { id, name, short, books: { idx: { ch: { cap: { vers: texto } } } } }

  function normChapters(ch) {
    const out = {};
    const verses = (v) => {
      const o = {};
      if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.items)) {      // { items: [{ type: 'verse', verse_numbers: [1], lines: [...] }] }
        v.items.forEach((it) => {
          if (!it || it.type !== 'verse' || !it.verse_numbers || !it.verse_numbers.length) return;
          let t = (it.lines || []).join(' ').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();   // quita etiquetas sueltas como <note>
          // Algunas ediciones (p. ej. TLA) traen el número del versículo pegado al texto: "1 (2) Jacob…" o "23 En el año…"
          const m = t.match(/^(\d+)(\s*\([^)]*\))?\s+(\S[\s\S]*)$/);
          if (m && (m[2] || it.verse_numbers.indexOf(Number(m[1])) !== -1)) t = m[3];
          if (t) it.verse_numbers.forEach((n) => { o[Number(n)] = t; });
        });
        return o;
      }
      if (Array.isArray(v)) v.forEach((t, i) => {
        const isObj = t && typeof t === 'object';                       // [{ verse: "1", text: "..." }]
        const txt = isObj ? t.text : t, n = isObj ? (Number(t.verse) || i + 1) : i + 1;
        if (txt != null && String(txt).trim() !== '') o[n] = String(txt);
      });
      else if (v && typeof v === 'object') Object.keys(v).forEach((k) => { if (!isNaN(Number(k)) && String(v[k]).trim() !== '') o[Number(k)] = String(v[k]); });
      return o;
    };
    if (Array.isArray(ch)) ch.forEach((v, i) => {
      if (v && !Array.isArray(v) && Array.isArray(v.items)) out[i + 1] = verses(v);
      else if (v && !Array.isArray(v) && Array.isArray(v.verses)) out[Number(v.chapter) || i + 1] = verses(v.verses);   // [{ chapter, verses: [...] }]
      else out[i + 1] = verses(v);
    });
    else if (ch && typeof ch === 'object') Object.keys(ch).forEach((k) => { if (!isNaN(Number(k))) out[Number(k)] = verses(ch[k]); });
    return out;
  }

  /**
   * Acepta: { id?, name, short?, books: [ { name, chapters } ] }, una lista [ { abbrev, name, chapters: [[versículos]] } ]
   * (formato común de Biblias en JSON) u { "Génesis": { "1": { "1": "texto" } } }. Los capítulos pueden ser listas u objetos.
   */
  function parseBibleFile(data, fallbackName) {
    let books = null, name = fallbackName || 'Biblia', short = '', id = '';
    if (Array.isArray(data)) books = data;
    else if (data && Array.isArray(data.books)) {
      books = data.books; name = data.name || data.local_title || name; short = data.short || data.version || data.local_abbreviation || ''; id = data.id || '';
      if (!id && data.version_id) id = String(data.local_abbreviation || 'biblia').toLowerCase().replace(/[^a-z0-9]+/g, '') + '-' + data.version_id;   // dos versiones con la misma sigla no se pisan
      if (/castellano/i.test(String(data.local_title || ''))) short = (short || 'NVI') + '-ES';
    }
    else if (data && typeof data === 'object') books = Object.keys(data).map((k) => ({ name: k, chapters: data[k] }));
    if (!books || !books.length) throw new Error('El archivo no parece una Biblia en JSON');
    const out = {};
    books.forEach((b, pos) => {
      const byName = resolveBook(b.name || b.book || b.human || '');
      const byAbbr = resolveBook(b.abbrev || b.id || '');
      let idx = byName && byName.idx != null ? byName.idx : (byAbbr && byAbbr.idx != null ? byAbbr.idx : (books.length === 66 ? pos : -1));
      if (idx < 0 || idx > 65) return;
      out[idx] = { ch: normChapters(b.chapters) };
    });
    if (!Object.keys(out).length) throw new Error('No se encontró ningún libro reconocible');
    const slug = norm(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'biblia';
    const par = name.match(/\(([^)]+)\)/);
    return { id: id || slug, name, short: short || (par ? par[1] : name.split(/\s+/)[0]).toUpperCase().slice(0, 10), books: out };
  }

  const Bible = {
    BOOKS, versions, parseRef, resolveBook, formatRef, compress, parseBibleFile,
    add(v) { versions[v.id] = v; return v; },
    remove(id) { delete versions[id]; },
    list: () => Object.keys(versions).map((k) => ({ id: k, name: versions[k].name, short: versions[k].short })),
    /** Versículos de una cita en una versión: [ { n, text } ] */
    getVerses(versionId, ref) {
      const v = versions[versionId];
      const book = v && v.books[ref.book];
      const chap = book && book.ch[ref.chapter];
      if (!chap) return [];
      const nums = Object.keys(chap).map(Number).sort((a, b) => a - b);
      const pick = ref.ranges ? nums.filter((n) => ref.ranges.some(([a, b]) => n >= a && n <= b)) : nums;
      // versículos unidos (p. ej. TLA) traen el mismo texto en cada número: se muestra una sola vez
      return pick.filter((n, i) => i === 0 || chap[n] !== chap[pick[i - 1]]).map((n) => ({ n, text: chap[n] }));
    },
    /** Búsqueda por palabras (todas deben aparecer, sin importar acentos ni mayúsculas) */
    search(versionId, query, limit) {
      const v = versions[versionId];
      if (!v) return [];
      if (!v.index) {
        v.index = [];
        Object.keys(v.books).forEach((b) => {
          const ch = v.books[b].ch;
          Object.keys(ch).forEach((c) => Object.keys(ch[c]).forEach((n) => v.index.push({ b: Number(b), c: Number(c), v: Number(n), t: ch[c][n], n: norm(ch[c][n]) })));
        });
        v.index.sort((x, y) => x.b - y.b || x.c - y.c || x.v - y.v);
      }
      const words = norm(query).split(/\s+/).filter((w) => w.length > 1);
      if (!words.length) return [];
      const res = [];
      for (let i = 0; i < v.index.length && res.length < (limit || 40); i++) {
        const e = v.index[i];
        if (words.every((w) => e.n.indexOf(w) !== -1)) res.push({ book: e.b, chapter: e.c, verse: e.v, text: e.t });
      }
      return res;
    }
  };
  Proy.Bible = Bible;

  // ============================================================
  // Diapositivas
  // ============================================================
  const CHORD_RE = /^([A-G][#b]?)((?:maj|min|dim|aug|sus|add|m|M)?(?:\d+|(?:sus|add|maj|b|#|\+|-)\d*)*)(?:\/([A-G][#b]?))?$/;
  const stripChords = (line) => String(line).replace(/\[([^\]]*)\]/g, (all, c) => (CHORD_RE.test(c) ? '' : all));
  const labelOf = (line) => { const m = String(line).match(/^\s*\[([^\]]+)\]\s*$/); return m && !CHORD_RE.test(m[1]) ? m[1].trim() : null; };
  const cleanText = (t) => String(t == null ? '' : t).replace(/\r/g, '').replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD]/g, '').replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');

  // Colores por tipo de sección (el orden importa: "pre-coro" antes que "coro")
  const SECTION_KINDS = [
    { re: /pre\s*-?\s*(coro|chorus)/i, key: 'precoro', color: '#e8890c' },
    { re: /coro|chorus|estribillo/i, key: 'coro', color: '#e5484d' },
    { re: /puente|bridge/i, key: 'puente', color: '#30a46c' },
    { re: /verso|estrofa|verse|^v\d/i, key: 'verso', color: '#3e63dd' },
    { re: /intro|instrumental|interludio|solo/i, key: 'intro', color: '#8d8d8d' },
    { re: /final|tag|outro|ending|cierre|conclus/i, key: 'final', color: '#8e4ec6' }
  ];
  const DEFAULT_COLOR = '#0091ff';
  const BIBLE_COLOR = '#12a594';
  const TEXT_COLOR = '#ffb224';
  const sectionColor = (label) => { const k = SECTION_KINDS.find((x) => x.re.test(label || '')); return k ? k.color : DEFAULT_COLOR; };

  /** La letra puede venir como "lyrics" (formato de la app, con [Coro] y [acordes]) o como "sections": [{ label, text }] */
  function lyricsOf(song) {
    if (song && Array.isArray(song.sections)) return song.sections.map((s) => '[' + (s.label || 'Sección') + ']\n' + (s.text || (s.lines || []).join('\n'))).join('\n\n');
    return String((song && song.lyrics) || '');
  }

  /** Reparte N líneas en trozos parejos de máximo "max" (6 líneas con máx. 4 -> 3 + 3) */
  function balanced(lines, max) {
    const parts = Math.ceil(lines.length / max);
    const size = Math.ceil(lines.length / parts);
    const out = [];
    for (let i = 0; i < lines.length; i += size) out.push(lines.slice(i, i + size));
    return out;
  }

  /** Si un trozo tiene demasiado texto, lo parte por la mitad (las líneas largas ocupan más pantalla) */
  function splitLong(chunk, maxChars) {
    const len = chunk.reduce((n, l) => n + l.length, 0);
    if (chunk.length < 2 || len <= maxChars) return [chunk];
    const mid = Math.ceil(chunk.length / 2);
    return splitLong(chunk.slice(0, mid), maxChars).concat(splitLong(chunk.slice(mid), maxChars));
  }

  /** Letra -> diapositivas por sección. Una línea en blanco separa diapositivas; las secciones largas se parten solas. */
  function songToSlides(song, opts) {
    const max = Math.max(1, (opts && opts.maxLines) || 2);
    const maxChars = Math.max(20, (opts && opts.maxChars) || 90);
    const lines = cleanText(lyricsOf(song)).split('\n');
    const secs = [];
    let cur = null;
    let hasLabels = false;
    const open = (label) => { cur = { label, blocks: [[]] }; secs.push(cur); };
    lines.forEach((raw) => {
      const lab = labelOf(raw);
      if (lab !== null) { hasLabels = true; open(lab); return; }
      if (!cur) open('');
      const text = stripChords(raw).replace(/\s+$/, '').replace(/^\s+/, '');
      if (raw.trim() === '') { if (cur.blocks[cur.blocks.length - 1].length) cur.blocks.push([]); return; }
      if (text.trim() === '') return;               // línea de solo acordes: no cuenta como letra
      cur.blocks[cur.blocks.length - 1].push(text);
    });
    const slides = [];
    let auto = 0;
    secs.forEach((s) => {
      const blocks = s.blocks.filter((b) => b.length);
      if (!blocks.length) return;
      // Sin ninguna etiqueta en la canción, cada bloque separado por línea en blanco es una estrofa
      const groups = !s.label && !hasLabels ? blocks.map((b) => [b]) : [blocks];
      groups.forEach((g) => {
        const label = s.label || (hasLabels ? 'Letra' : 'Estrofa ' + (++auto));
        const chunks = [].concat(...g.map((b) => [].concat(...balanced(b, max).map((x) => splitLong(x, maxChars)))));   // una sección puede dar varias diapositivas
        chunks.forEach((c, ci) => {
          slides.push({ id: uid(), kind: 'song', label, part: chunks.length > 1 ? (ci + 1) + '/' + chunks.length : '', color: sectionColor(label), text: c.join('\n') });
        });
      });
    });
    return slides;
  }

  function textToSlides(text, label) {
    const blocks = cleanText(text).split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    return blocks.map((b) => ({ id: uid(), kind: 'text', label: label || 'Texto', part: '', color: TEXT_COLOR, text: b }));
  }

  function chunkVerses(verses, maxChars, maxVerses) {
    const chunks = [];
    let cur = [], len = 0;
    verses.forEach((v) => {
      const l = v.text.length + 4;
      if (cur.length && (len + l > maxChars || cur.length >= maxVerses)) { chunks.push(cur); cur = []; len = 0; }
      cur.push(v); len += l;
    });
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  /**
   * Cita -> diapositivas. versionIds: [principal, secundaria?]. Cada diapositiva lleva "versions": [{ ver, ref, text }]
   * para poder mostrar dos versiones a la vez. Devuelve { title, slides } o { error }.
   */
  function bibleSlides(refOrText, versionIds, opts) {
    const o = Object.assign({ maxChars: 280, maxVerses: 4, numbers: true }, opts || {});
    const ref = typeof refOrText === 'string' ? parseRef(refOrText) : refOrText;
    if (!ref || ref.error) return { error: (ref && ref.error) || 'Cita no válida' };
    const ids = (versionIds || []).filter((id) => id && versions[id]);
    if (!ids.length) return { error: 'No hay ninguna versión de la Biblia cargada' };
    let verses = [];
    for (let i = 0; i < ids.length && !verses.length; i++) verses = Bible.getVerses(ids[i], ref);
    if (!verses.length) return { error: 'No encontré ' + formatRef(ref, null) + (ref.ranges ? ':' + compress([].concat(...ref.ranges.map(([a, b]) => [a, b]))) : '') + ' en ' + versions[ids[0]].short };
    const slides = chunkVerses(verses, o.maxChars, o.maxVerses).map((chunk) => {
      const nums = chunk.map((v) => v.n);
      const vers = ids.map((id) => {
        const chap = (versions[id].books[ref.book] || { ch: {} }).ch[ref.chapter] || {};
        const vv = nums.filter((n) => chap[n]).map((n) => ({ n, t: chap[n] }));
        if (!vv.length) return null;
        const text = vv.map((x) => (vv.length > 1 && o.numbers ? x.n + ' ' : '') + x.t).join('\n');
        return { ver: versions[id].short, ref: formatRef(ref, vv.map((x) => x.n)), text };
      }).filter(Boolean);
      return { id: uid(), kind: 'bible', label: formatRef(ref, nums), part: '', color: BIBLE_COLOR, versions: vers, text: vers[0].text };
    });
    return { title: formatRef(ref, verses.map((v) => v.n)), slides };
  }

  const Slides = { songToSlides, textToSlides, bibleSlides, stripChords, labelOf, cleanText, sectionColor, lyricsOf, balanced };
  Proy.Slides = Slides;

  // Elementos del orden del servicio
  const Items = {
    song(song, opts) {
      return { id: uid(), type: 'song', title: song.title || 'Canción', meta: { songId: String(song.id), source: song.source || 'local', key: song.key || song.originalKey || '', lyrics: lyricsOf(song) }, slides: songToSlides(song, opts) };
    },
    bible(ref, versionIds, opts) {
      const r = bibleSlides(ref, versionIds, opts);
      if (r.error) return { error: r.error };
      return { id: uid(), type: 'bible', title: r.title, meta: { versions: versionIds.filter(Boolean), ref: JSON.parse(JSON.stringify(ref)) }, slides: r.slides };
    },
    text(title, text) { return { id: uid(), type: 'text', title: title || 'Texto', meta: {}, slides: textToSlides(text, title || 'Texto') }; },
    countdown(minutes, label) {
      const m = clamp(minutes, 0, 600);
      return { id: uid(), type: 'countdown', title: 'Cuenta regresiva ' + m + ' min', meta: {}, slides: [{ id: uid(), kind: 'countdown', label: 'Cuenta regresiva', part: '', color: '#8d8d8d', text: '', minutes: m, countdownLabel: label || 'Empezamos en' }] };
    },
    media(rec) {
      return { id: uid(), type: 'media', title: rec.name || 'Media', meta: { mediaId: rec.id, mediaKind: rec.kind }, slides: [{ id: uid(), kind: 'media', label: rec.kind === 'video' ? 'Video' : 'Imagen', part: '', color: '#8e4ec6', text: '', mediaId: rec.id, mediaKind: rec.kind, loop: false }] };
    }
  };
  Proy.Items = Items;

  // ============================================================
  // Controlador: servicio, navegación, estado en vivo
  // ============================================================
  const DEFAULTS = {
    text: { font: 'system', size: 100, weight: 700, color: '#ffffff', align: 'center', shadow: true, uppercase: false },
    bg: { mediaId: null, color: '#000000', dim: 0.35, blur: 0, fit: 'cover', preset: null, accent: '' },   // fit: cover (llena y recorta) | contain (completa, sin recortar)
    bibleLayout: 'stack',            // 'stack' (arriba / abajo) | 'split' (lado a lado)
    bibleVersions: ['', ''],
    bibleStage: true,                 // en la Biblia, el primer Enter solo muestra la previa y el segundo proyecta
    cdAfter: 'logo',                  // qué pasa al llegar a cero: none | logo | black | next | media
    cdAfterMediaId: null,
    cdSound: true,                    // latidos y golpe final en los últimos 10 s (suena en la pantalla de proyección)
    cdVolume: 70,
    cdPadKey: 'auto',                 // tono del colchón: auto (primera canción del orden) | off | C, C#, D, Eb, E, F, F#, G, Ab, A, Bb, B
    cdFinal: true,                    // cuenta regresiva: últimos 10 segundos en grande y animados
    stopAtItemEnd: true,              // al terminar las diapositivas de una canción/cita, se queda ahí (no pasa sola a lo siguiente)
    bibleVerses: 1,                   // versículos por diapositiva
    lower: { chroma: 'transparent', size: 100 },   // 'transparent' o un color de croma (#00FF00)
    maxLines: 2,                      // líneas por diapositiva de canción
    maxChars: 90,                     // y máximo de letras por diapositiva
    slideDefaults: 2,                 // versión de estos valores (sube para forzar los nuevos en instalaciones viejas)
    logoMediaId: null,
    countdown: { minutes: 5, label: 'Empezamos en' }
  };
  Proy.DEFAULTS = DEFAULTS;

  const blankService = (name) => ({ id: uid(), name: name || 'Servicio', items: [], updated: Date.now() });

  function createController(opts) {
    const ch = opts.channel;
    const subs = new Set();
    const C = {
      settings: clone(DEFAULTS), service: blankService('Servicio'),
      cursor: null, mode: 'service', quick: null, anchor: null,
      flags: { black: false, clear: false, logo: false },
      countdown: null, stageMsg: '', rev: 0, showN: 0, outputs: new Map(), media: []
    };
    let saveTimer = null;

    const emit = () => subs.forEach((fn) => fn());
    const list = () => (C.mode === 'quick' && C.quick ? C.quick.items : C.service.items);
    const slidesOf = (it) => (it && it.slides) || [];
    const at = (cur, items) => (cur && items[cur.item] ? slidesOf(items[cur.item])[cur.slide] || null : null);

    function nextOf(cur, items) {
      let i = cur ? cur.item : 0, j = cur ? cur.slide + 1 : 0;
      for (; i < items.length; i++, j = 0) if (j < slidesOf(items[i]).length) return { item: i, slide: j };
      return null;
    }
    function prevOf(cur, items) {
      if (!cur) return null;
      let i = cur.item, j = cur.slide - 1;
      while (i >= 0) {
        if (j >= 0 && j < slidesOf(items[i]).length) return { item: i, slide: j };
        i--;
        j = i >= 0 ? slidesOf(items[i]).length - 1 : -1;
      }
      return null;
    }

    // ---------- Estado que ven las salidas ----------
    function liveState() {
      const items = list();
      const slide = at(C.cursor, items);
      let nxt = nextOf(C.cursor, items);
      if (C.settings.stopAtItemEnd && nxt && C.cursor && nxt.item !== C.cursor.item) nxt = null;   // la vista previa tampoco salta al siguiente elemento
      let nextSlide = nxt ? at(nxt, items) : null;
      if (!nextSlide && !C.settings.stopAtItemEnd && C.mode === 'quick' && C.anchor) { nxt = nextOf(C.anchor, C.service.items); nextSlide = nxt ? at(nxt, C.service.items) : null; }
      const it = C.cursor && items[C.cursor.item];
      return {
        rev: ++C.rev, showN: C.showN, ts: Date.now(), slide, next: nextSlide, itemTitle: it ? it.title : '',
        position: C.cursor ? { item: C.cursor.item + 1, items: items.length, slide: C.cursor.slide + 1, slides: slidesOf(it).length } : null,
        flags: Object.assign({}, C.flags), countdown: C.countdown, stageMsg: C.stageMsg,
        settings: { text: C.settings.text, bg: C.settings.bg, bibleLayout: C.settings.bibleLayout, lower: C.settings.lower, logoMediaId: C.settings.logoMediaId, cdFinal: !!C.settings.cdFinal, cdSound: !!C.settings.cdSound, cdVolume: C.settings.cdVolume, cdPad: padKey() }
      };
    }

    function publish() {
      const s = liveState();
      ch.send({ t: 'state', s });
      ch.saveState(s);
      return s;
    }

    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        C.service.updated = Date.now();
        DB.put('services', C.service).catch(() => {});
        DB.setMeta('lastService', C.service.id).catch(() => {});
        DB.setMeta('settings', C.settings).catch(() => {});
      }, 400);
    }

    function changed(live) { if (live) publish(); scheduleSave(); emit(); }

    // ---------- Navegación ----------
    function closeQuick() { C.mode = 'service'; C.quick = null; }

    function go(i, j) {
      if (C.mode === 'quick') { closeQuick(); C.anchor = null; }
      const it = C.service.items[i];
      if (!it || !slidesOf(it)[j]) return;
      return show({ item: i, slide: j });
    }

    function show(cur) {
      C.cursor = cur;
      C.showN++;                       // cuenta cada vez que se proyecta algo (reinicia los videos)
      C.flags = { black: false, clear: false, logo: false };
      const s = at(cur, list());
      if (s && s.kind === 'countdown') {
        C.countdown = { endAt: Date.now() + s.minutes * 60000, label: s.countdownLabel || 'Empezamos en' };
      } else C.countdown = null;
      changed(true);
    }

    function next() {
      const items = list();
      if (C.settings.stopAtItemEnd && C.cursor) {     // solo avanza dentro del mismo elemento
        const cur = C.cursor, n = cur.slide + 1;
        if (items[cur.item] && n < slidesOf(items[cur.item]).length) show({ item: cur.item, slide: n });
        return;
      }
      const n = nextOf(C.cursor, items);
      if (n) { show(n); return; }
      if (C.mode === 'quick') {
        const a = C.anchor;
        closeQuick(); C.anchor = null;
        const m = nextOf(a, C.service.items);
        if (m) show(m); else if (a) show(a);
      }
    }

    function prev() {
      const items = list();
      if (C.settings.stopAtItemEnd && C.cursor) {
        if (C.cursor.slide > 0) show({ item: C.cursor.item, slide: C.cursor.slide - 1 });
        return;
      }
      const p = prevOf(C.cursor, items);
      if (p) { show(p); return; }
      if (C.mode === 'quick') { const a = C.anchor; closeQuick(); C.anchor = null; if (a) show(a); }
    }

    function jumpItem(dir) {
      const items = list();
      const start = C.cursor ? C.cursor.item + dir : 0;
      for (let i = start; i >= 0 && i < items.length; i += dir) if (slidesOf(items[i]).length) { show({ item: i, slide: 0 }); return; }
    }

    function goQuick(j) {
      if (C.mode !== 'quick' || !C.quick || !slidesOf(C.quick.items[0])[j]) return;
      show({ item: 0, slide: j });
    }

    /** Proyecta un elemento suelto (cita rápida) sin meterlo al orden. Con "siguiente" se regresa al servicio. */
    function projectQuick(item) {
      C.anchor = C.mode === 'service' ? C.cursor : C.anchor;
      C.quick = { items: [item] };
      C.mode = 'quick';
      show({ item: 0, slide: 0 });
    }

    // ---------- Banderas (negro / limpiar / logo) ----------
    function toggleFlag(name) {
      if (!(name in C.flags)) return;
      C.flags[name] = !C.flags[name];
      if (name === 'logo' && C.flags.logo) C.flags.black = false;
      changed(true);
    }

    // ---------- Cuenta regresiva ----------
    function startCountdown(minutes, label) {
      const m = clamp(minutes, 0, 600);
      C.countdown = { endAt: Date.now() + m * 60000, label: label || C.settings.countdown.label };
      C.settings.countdown = { minutes: m, label: C.countdown.label };
      changed(true);
    }
    /** Tono para el colchón de la cuenta regresiva. «auto» toma el tono de la primera canción del orden (si no hay, Mi) */
    function padKey() {
      const k = C.settings.cdPadKey || 'auto';
      if (k !== 'auto') return k;
      const song = C.service.items.find((it) => it.type === 'song' && it.meta && it.meta.key);
      const m = song ? String(song.meta.key).trim().match(/^([A-Ga-g])([#b♯♭]?)/) : null;
      if (!m) return 'E';
      return m[1].toUpperCase() + m[2].replace('♯', '#').replace('♭', 'b');
    }
    function stopCountdown() { C.countdown = null; changed(true); }

    /** Al llegar a cero (con una breve pausa para ver el "0") hace lo que se eligió en Ajustes */
    function afterCountdown() {
      const a = C.settings.cdAfter || 'none';
      if (a === 'none') return;
      C.countdown = null;
      if (a === 'logo') C.flags = { black: false, clear: false, logo: true };
      else if (a === 'black') C.flags = { black: true, clear: false, logo: false };
      else if (a === 'next') {
        if (C.mode === 'service' && C.cursor && C.service.items[C.cursor.item + 1]) { go(C.cursor.item + 1, 0); return; }
      } else if (a === 'media') {
        const rec = C.settings.cdAfterMediaId && C.getMedia ? C.getMedia(C.settings.cdAfterMediaId) : null;
        if (rec) { projectQuick(Items.media(rec)); return; }
      }
      changed(true);
    }
    function checkCountdown() {
      const cd = C.countdown;
      if (!cd || cd.done) return;
      const late = Date.now() - cd.endAt;
      if (late < 900) return;
      cd.done = true;
      if (late < 6000) afterCountdown();      // si la compu estuvo dormida y ya pasó mucho, no dispara nada
    }

    // ---------- Edición en caliente ----------
    function editSlide(path, patch) {
      const items = path.quick ? (C.quick ? C.quick.items : []) : C.service.items;
      const s = at({ item: path.item, slide: path.slide }, items);
      if (!s) return false;
      Object.assign(s, patch);
      if (s.kind === 'bible' && 'text' in patch && s.versions && s.versions[0]) s.versions[0].text = patch.text;
      const live = C.cursor && C.cursor.item === path.item && C.cursor.slide === path.slide && (!!path.quick === (C.mode === 'quick'));
      changed(live);
      return true;
    }

    // ---------- Servicio ----------
    function addItem(item, pos) {
      const items = C.service.items;
      const p = pos == null ? items.length : clamp(pos, 0, items.length);
      items.splice(p, 0, item);
      if (C.mode === 'service' && C.cursor && C.cursor.item >= p) C.cursor.item++;
      changed(false);
      return p;
    }
    function removeItem(i) {
      const items = C.service.items;
      if (!items[i]) return;
      items.splice(i, 1);
      if (C.mode === 'service' && C.cursor) {
        if (C.cursor.item === i) C.cursor = null;
        else if (C.cursor.item > i) C.cursor.item--;
      }
      changed(C.mode === 'service' && C.cursor === null);
    }
    function moveItem(from, to) {
      const items = C.service.items;
      if (!items[from] || to < 0 || to >= items.length || from === to) return;
      const [it] = items.splice(from, 1);
      items.splice(to, 0, it);
      if (C.mode === 'service' && C.cursor) {
        const c = C.cursor.item;
        if (c === from) C.cursor.item = to;
        else if (from < c && to >= c) C.cursor.item--;
        else if (from > c && to <= c) C.cursor.item++;
      }
      changed(false);
    }

    async function openService(id) {
      const s = await DB.get('services', id);
      if (!s) return false;
      C.service = s; C.cursor = null; C.mode = 'service'; C.quick = null; C.anchor = null;
      changed(true);
      return true;
    }
    function newService(name) {
      C.service = blankService(name || 'Servicio nuevo');
      C.cursor = null; C.mode = 'service'; C.quick = null; C.anchor = null;
      changed(true);
    }
    const services = () => DB.all('services').then((l) => l.sort((a, b) => b.updated - a.updated));

    /** Vuelve a partir las canciones del orden con los ajustes actuales (se pierden las ediciones manuales de esas diapositivas) */
    function resliceSongs(getSong, sopts) {
      let n = 0;
      C.service.items.forEach((it, i) => {
        if (it.type !== 'song') return;
        const song = (getSong && getSong(it)) || (it.meta && it.meta.lyrics ? { title: it.title, lyrics: it.meta.lyrics } : null);
        if (!song) return;
        const slides = songToSlides(song, sopts);
        if (!slides.length) return;
        it.slides = slides; n++;
        if (C.mode === 'service' && C.cursor && C.cursor.item === i) C.cursor.slide = Math.min(C.cursor.slide, slides.length - 1);
      });
      changed(n > 0 && C.mode === 'service' && !!C.cursor);
      return n;
    }

    function setSetting(path, value) { setPath(C.settings, path, value); changed(true); }
    function setStageMsg(t) { C.stageMsg = String(t || '').slice(0, 200); changed(true); }

    // ---------- Mensajes de las salidas ----------
    ch.on((m) => {
      if (!m || m.t !== 'hello') return;
      const known = C.outputs.has(m.id);
      C.outputs.set(m.id, { mode: m.mode, seen: Date.now() });
      if (!known) { publish(); emit(); }
    });
    const connected = () => {
      const now = Date.now();
      [...C.outputs.entries()].forEach(([k, v]) => { if (now - v.seen > 9000) C.outputs.delete(k); });
      return [...C.outputs.values()];
    };

    async function init() {
      const st = await DB.getMeta('settings', null);
      if (st && st.slideDefaults !== DEFAULTS.slideDefaults) { st.maxLines = DEFAULTS.maxLines; st.maxChars = DEFAULTS.maxChars; st.slideDefaults = DEFAULTS.slideDefaults; }   // antes eran 4 líneas
      if (st) C.settings = mergeDeep(clone(DEFAULTS), st);
      const stored = await DB.all('bibles');
      stored.forEach((b) => Bible.add(b));
      const last = await DB.getMeta('lastService', null);
      const svc = last ? await DB.get('services', last) : null;
      if (svc) C.service = svc;
      emit();
    }

    Object.assign(C, {
      init, onChange: (fn) => { subs.add(fn); return () => subs.delete(fn); }, emit, publish, liveState,
      list, current: () => at(C.cursor, list()), nextOf, prevOf, slidesOf,
      padKey, go, goQuick, next, prev, jumpItem, projectQuick, closeQuick, toggleFlag, startCountdown, stopCountdown,
      editSlide, resliceSongs, addItem, removeItem, moveItem, openService, newService, services, setSetting, setStageMsg,
      connected, save: scheduleSave, changed
    });
    const cdTimer = setInterval(checkCountdown, 250);
    if (cdTimer && cdTimer.unref) cdTimer.unref();
    return C;
  }
  Proy.createController = createController;

  // ============================================================
  // Importar / exportar
  // ============================================================
  const Data = {
    /** Canciones locales, Biblias y servicios en un solo JSON (los archivos de media no se incluyen: son pesados) */
    async exportAll(opts) {
      const o = opts || {};
      return {
        app: 'alabanza-proyeccion', version: 1, exported: new Date().toISOString(),
        songs: await DB.all('songs'),
        bibles: o.bibles ? (await DB.all('bibles')).map((b) => ({ id: b.id, name: b.name, short: b.short, books: Object.keys(b.books).map((k) => ({ name: BOOKS[k][0], chapters: b.books[k].ch })) })) : [],
        services: await DB.all('services')
      };
    },

    /**
     * Mezcla un JSON: songs, bibles y services. En "services", los elementos pueden venir ya con diapositivas
     * (exportados) o como pedido simple: { type: "song", songId }, { type: "bible", ref, versions }, { type: "text", title, text }, { type: "countdown", minutes }.
     * Devuelve un resumen { songs, bibles, services, avisos }.
     */
    async importAll(json, ctx) {
      const out = { songs: 0, bibles: 0, services: 0, avisos: [] };
      const songsAll = new Map();
      (ctx && ctx.librarySongs ? ctx.librarySongs() : []).forEach((s) => songsAll.set(String(s.id), s));
      (await DB.all('songs')).forEach((s) => songsAll.set(String(s.id), s));
      for (const s of (json.songs || [])) {
        if (!s || !s.title) continue;
        const rec = { id: String(s.id || uid()), source: 'local', title: String(s.title), author: s.author || '', key: s.key || '', lyrics: lyricsOf(s), updated: Date.now() };
        await DB.put('songs', rec); songsAll.set(rec.id, rec); out.songs++;
      }
      for (const b of (json.bibles || [])) {
        try { const v = parseBibleFile(b, b.name); await DB.put('bibles', v); Bible.add(v); out.bibles++; } catch (e) { out.avisos.push('Biblia: ' + e.message); }
      }
      const maxLines = (ctx && ctx.maxLines) || 2;
      for (const sv of (json.services || [])) {
        const items = [];
        (sv.items || []).forEach((it) => {
          if (it.slides) { items.push(it); return; }
          if (it.type === 'song') {
            const song = songsAll.get(String(it.songId));
            if (song) items.push(Items.song(song, { maxLines })); else out.avisos.push('No encontré la canción ' + it.songId);
          } else if (it.type === 'bible') {
            const b = Items.bible(it.ref, it.versions || [], {});
            if (b.error) out.avisos.push(b.error); else items.push(b);
          } else if (it.type === 'text') items.push(Items.text(it.title, it.text));
          else if (it.type === 'countdown') items.push(Items.countdown(it.minutes, it.label));
        });
        const rec = { id: String(sv.id || uid()), name: sv.name || 'Servicio importado', items, updated: Date.now() };
        await DB.put('services', rec); out.services++;
      }
      return out;
    }
  };
  Proy.Data = Data;

  if (typeof module !== 'undefined' && module.exports) module.exports = Proy;
})(typeof window !== 'undefined' ? window : globalThis);
