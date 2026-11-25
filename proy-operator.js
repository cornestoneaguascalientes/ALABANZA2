/**
 * PROY-OPERATOR.JS - Consola del operador (vista "Proyección" de la app)
 *
 * Todo se construye dentro de <div id="proy-root"> (ver index.html). Usa:
 *   Proy.createController  estado y navegación        Proy.Render  monitores Preview / Live
 *   Proy.Bible / Slides / Items / Data / DB            Database / UI de la app (canciones de la biblioteca, avisos)
 *
 * Atajos (solo con la vista Proyección abierta y sin escribir en un campo):
 *   ↓ → Espacio  siguiente      ↑ ←  anterior      Av Pág / Re Pág  siguiente / anterior elemento
 *   B o Esc  pantalla negra     C  limpiar texto   L  logo          Ctrl+F  buscar en la Biblia
 */
(function () {
  'use strict';

  const P = window.Proy;
  if (!P) return;
  const { Items, Bible, Data, DB } = P;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (window.UI ? UI.escape(s) : String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = (m, t) => { if (window.UI) UI.toast(m, t); };
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const norm = P.util.norm;
  const TYPE = { song: 'Canción', bible: 'Biblia', text: 'Texto', countdown: 'Cuenta', media: 'Media' };

  let C = null, ch = null, root = null, liveR = null, prevR = null, lastShow = -1, audioWarned = false;
  const ui = {
    sel: 0, tab: 'songs', query: '', localSongs: [], media: [], services: [],
    lastBible: null, kw: [], prepare: false, picked: null, staged: null, stagedQ: '', viewService: false
  };

  // ============================================================
  // Plantilla
  // ============================================================
  function template() {
    const tabs = [['songs', 'Canciones'], ['bible', 'Biblia'], ['media', 'Media'], ['settings', 'Ajustes'], ['data', 'Datos']];
    return `
<div class="pj">
  <div class="pj-bar">
    <div class="pj-clock" id="pj-clock">--:--</div>
    <span class="pj-outs" id="pj-outs">Sin pantallas abiertas</span>
    <span class="pj-grow"></span>
    <button class="pj-btn primary" id="pj-open" type="button">Abrir pantalla de proyección</button>
    <button class="pj-btn" id="pj-open-lower" type="button">Lower Third (OBS)</button>
    <button class="pj-btn" id="pj-open-stage" type="button">Vista de escenario</button>
  </div>

  <div class="pj-quick">
    <button class="pj-btn" data-flag="clear" type="button">Limpiar texto <kbd>C</kbd></button>
    <button class="pj-btn danger" data-flag="black" type="button">Pantalla negra <kbd>B</kbd></button>
    <button class="pj-btn" data-flag="logo" type="button">Logo <kbd>L</kbd></button>
    <span class="pj-sep"></span>
    <label class="pj-inl">Cuenta regresiva <input id="pj-cd-min" class="pj-in sm" type="number" min="0" max="600" value="5"> min</label>
    <input id="pj-cd-label" class="pj-in" type="text" maxlength="40" placeholder="Empezamos en">
    <button class="pj-btn" id="pj-cd-start" type="button">Iniciar</button>
    <button class="pj-btn" id="pj-cd-stop" type="button">Detener</button>
  </div>

  <div class="pj-grid">
    <aside class="pj-col pj-left">
      <div class="pj-h">Orden del servicio</div>
      <input id="pj-svc-name" class="pj-in" type="text" maxlength="60" placeholder="Nombre del servicio" aria-label="Nombre del servicio">
      <div class="pj-row">
        <button class="pj-btn sm" id="pj-svc-new" type="button">Nuevo</button>
        <select id="pj-svc-open" class="pj-in" aria-label="Abrir un servicio guardado"><option value="">Abrir guardado…</option></select>
      </div>
      <button class="pj-btn sm block" id="pj-svc-setlist" type="button">Traer setlist de la fecha</button>
      <ol class="pj-items" id="pj-items"></ol>
      <details class="pj-add">
        <summary>Agregar texto, anuncio o cuenta regresiva</summary>
        <input id="pj-txt-title" class="pj-in" type="text" placeholder="Título (ej. Anuncios)">
        <textarea id="pj-txt-body" class="pj-in" rows="4" placeholder="Texto. Una línea en blanco separa diapositivas."></textarea>
        <div class="pj-row">
          <button class="pj-btn sm" id="pj-txt-add" type="button">Agregar texto</button>
          <button class="pj-btn sm" id="pj-cd-add" type="button">Agregar cuenta regresiva</button>
        </div>
      </details>
      <p class="pj-help"><kbd>↓</kbd> <kbd>→</kbd> <kbd>Espacio</kbd> siguiente · <kbd>↑</kbd> <kbd>←</kbd> anterior · <kbd>Av Pág</kbd>/<kbd>Re Pág</kbd> elemento · <kbd>Ctrl</kbd>+<kbd>F</kbd> Biblia</p>
    </aside>

    <section class="pj-col pj-center">
      <div class="pj-mons">
        <div><div class="pj-mon-t" id="pj-prev-t">SIGUIENTE</div><div class="pj-mon" id="pj-mon-prev"></div></div>
        <div><div class="pj-mon-t live">EN VIVO</div><div class="pj-mon live" id="pj-mon-live"></div></div>
      </div>
      <label class="pj-chk"><input type="checkbox" id="pj-prepare"> Preparar: el clic solo selecciona (Enter proyecta)</label>
      <div class="pj-edit">
        <div class="pj-h">Editar en caliente <small id="pj-edit-info"></small></div>
        <textarea id="pj-edit-text" class="pj-in" rows="3" placeholder="Proyecta una diapositiva y corrígela aquí; la salida cambia al instante"></textarea>
        <label class="pj-inl">Tamaño de esta diapositiva <input id="pj-edit-size" type="range" min="40" max="180" value="100"> <output id="pj-edit-size-v">100%</output></label>
      </div>
      <div class="pj-h"><span id="pj-slides-title">Diapositivas</span> <span class="pj-h-btns"><button class="pj-btn sm" id="pj-bible-more" type="button" hidden>+ Más versículos</button> <button class="pj-btn sm" id="pj-quick-add" type="button" hidden>+ Agregar al orden</button></span></div>
      <div class="pj-slides" id="pj-slides"></div>
    </section>

    <aside class="pj-col pj-right">
      <div class="pj-tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" class="pj-tab" data-tab="${k}">${l}</button>`).join('')}</div>

      <div class="pj-panel" data-p="songs">
        <input id="pj-song-q" class="pj-in" type="search" placeholder="Buscar canción o letra…" aria-label="Buscar canción">
        <div class="pj-row">
          <button class="pj-btn sm" id="pj-song-new" type="button">Nueva canción</button>
          <button class="pj-btn sm" id="pj-song-refresh" type="button">Actualizar de Google Sheets</button>
        </div>
        <ul class="pj-list" id="pj-songs"></ul>
      </div>

      <div class="pj-panel" data-p="bible">
        <div class="pj-row">
          <label class="pj-fld">Versión<select id="pj-bv0" class="pj-in" data-set="bibleVersions.0"></select></label>
          <label class="pj-fld">2.ª versión<select id="pj-bv1" class="pj-in" data-set="bibleVersions.1"></select></label>
        </div>
        <label class="pj-fld">Dos versiones<select class="pj-in" data-set="bibleLayout"><option value="stack">Una arriba de la otra</option><option value="split">Lado a lado</option></select></label>
        <input id="pj-bible-q" class="pj-in" type="text" autocomplete="off" placeholder="Jn 3:16 · Sal 23 1-4 · o palabras. Enter" aria-label="Buscar en la Biblia">
        <div class="pj-help" id="pj-bible-msg"></div>
        <ul class="pj-list" id="pj-bible-results"></ul>
        <div class="pj-row">
          <button class="pj-btn sm" id="pj-bible-add" type="button">+ Agregar última cita al orden</button>
          <button class="pj-btn sm" id="pj-bible-sync" type="button">Buscar Biblias del servidor</button>
          <button class="pj-btn sm" id="pj-bible-file" type="button">Cargar Biblia (JSON)…</button>
          <input id="pj-bible-input" type="file" multiple accept=".json,application/json" hidden>
        </div>
        <ul class="pj-list" id="pj-bible-versions"></ul>
      </div>

      <div class="pj-panel" data-p="media">
        <div class="pj-drop" id="pj-drop">
          Arrastra aquí imágenes (JPG, PNG, WebP) o videos (MP4, WebM)
          <div><button class="pj-btn sm" id="pj-media-pick" type="button">Elegir archivos…</button></div>
          <input id="pj-media-input" type="file" multiple accept="image/*,video/*,.mp4,.webm,.mov,.m4v,.heic,.heif,.tif,.tiff,.bmp,.avif" hidden>
        </div>
        <div class="pj-thumbs" id="pj-thumbs"></div>
        <p class="pj-help">Los archivos se guardan en este navegador y funcionan sin internet.</p>
      </div>

      <div class="pj-panel" data-p="settings">
        <div class="pj-h">Texto</div>
        <div class="pj-grid2">
          <label class="pj-fld">Letra<select class="pj-in" data-set="text.font"><option value="system">Sistema</option><option value="sans">Instrument Sans</option><option value="serif">Serif</option><option value="mono">Monoespaciada</option><option value="impact">Impact</option></select></label>
          <label class="pj-fld">Grosor<select class="pj-in" data-set="text.weight"><option value="400">Normal</option><option value="600">Seminegrita</option><option value="700">Negrita</option><option value="800">Extra</option></select></label>
          <label class="pj-fld">Alineación<select class="pj-in" data-set="text.align"><option value="left">Izquierda</option><option value="center">Centro</option><option value="right">Derecha</option></select></label>
          <label class="pj-fld">Color<input class="pj-in" type="color" data-set="text.color"></label>
        </div>
        <label class="pj-fld">Tamaño <input type="range" min="50" max="160" data-set="text.size"></label>
        <label class="pj-chk"><input type="checkbox" data-set="text.shadow"> Sombra</label>
        <label class="pj-chk"><input type="checkbox" data-set="text.uppercase"> Todo en mayúsculas</label>
        <div class="pj-h">Canciones y Biblia</div>
        <div class="pj-grid2">
          <label class="pj-fld">Líneas por diapositiva<input class="pj-in" type="number" min="1" max="8" data-set="maxLines"></label>
          <label class="pj-fld">Letras máx. por diapositiva<input class="pj-in" type="number" min="30" max="300" step="10" data-set="maxChars"></label>
        </div>
        <button class="pj-btn sm block" id="pj-reslice" type="button">Aplicar a las canciones del orden</button>
        <p class="pj-help">Con 2 líneas y 90 letras cada diapositiva queda corta y de letra grande. Las canciones que ya están en el orden se actualizan con el botón (se pierden las ediciones manuales de sus diapositivas).</p>
        <label class="pj-fld">Versículos por diapositiva (Biblia)<input class="pj-in" type="number" min="1" max="6" data-set="bibleVerses"></label>
        <label class="pj-chk"><input type="checkbox" data-set="bibleStage"> Biblia: el primer Enter muestra la previa y el segundo proyecta</label>
        <label class="pj-chk"><input type="checkbox" data-set="stopAtItemEnd"> Detenerse al terminar cada canción o cita (no pasar sola a lo siguiente)</label>

        <div class="pj-h">Cuenta regresiva</div>
        <label class="pj-chk"><input type="checkbox" data-set="cdSound"> Sonido en los últimos 10 segundos (latidos que van subiendo, con eco)</label>
        <label class="pj-fld">Volumen del sonido <input type="range" min="0" max="100" data-set="cdVolume"></label>
        <label class="pj-fld">Tono del colchón (pad)<select class="pj-in" data-set="cdPadKey">
          <option value="auto">Automático (tono de la primera canción del orden)</option>
          <option value="off">Sin colchón (solo latidos)</option>
          <option value="C">Do (C)</option><option value="C#">Do♯ / Re♭ (C#)</option><option value="D">Re (D)</option><option value="Eb">Mi♭ (Eb)</option>
          <option value="E">Mi (E)</option><option value="F">Fa (F)</option><option value="F#">Fa♯ / Sol♭ (F#)</option><option value="G">Sol (G)</option>
          <option value="Ab">La♭ (Ab)</option><option value="A">La (A)</option><option value="Bb">Si♭ (Bb)</option><option value="B">Si (B)</option>
        </select></label>
        <button class="pj-btn sm block" id="pj-cd-test" type="button">▶ Probar el sonido (10 segundos)</button>
        <p class="pj-help">El sonido sale de la pantalla de proyección, por la salida de audio de esta computadora. Haz un clic en esa ventana al abrirla (el mismo clic de pantalla completa) para que el navegador permita el sonido.</p>
        <label class="pj-chk"><input type="checkbox" data-set="cdFinal"> Cuenta regresiva: últimos 10 segundos grandes y animados (10, 9, 8…)</label>
        <label class="pj-fld">Al llegar a cero la cuenta regresiva<select class="pj-in" data-set="cdAfter" id="pj-cd-after"><option value="none">No hacer nada (se oculta sola)</option><option value="logo">Mostrar el logo</option><option value="black">Pantalla negra</option><option value="next">Pasar al siguiente elemento del orden</option><option value="media">Mostrar una imagen o video…</option></select></label>
        <label class="pj-fld" id="pj-cd-media-wrap" hidden>Imagen o video<select class="pj-in" data-set="cdAfterMediaId" id="pj-cd-media"></select></label>
        <p class="pj-help">«Siguiente elemento» funciona cuando la cuenta regresiva es parte del orden del servicio. Las imágenes y videos se agregan en la pestaña Media.</p>

        <div class="pj-h">Fondo detrás del texto</div>
        <div class="pj-help" id="pj-bg-name">Fondo: color liso</div>
        <div class="pj-h">Fondos animados</div>
        <div class="pj-fxgrid" id="pj-fxgrid"></div>
        <div class="pj-grid2">
          <label class="pj-fld">Color del fondo animado<input class="pj-in" type="color" id="pj-fx-accent"></label>
          <button class="pj-btn sm" id="pj-fx-reset" type="button">Color original</button>
        </div>
        <p class="pj-help">Hechos con código: no pesan, funcionan sin internet y predominan el negro con luz brillante para que se vean en la pared. Se aplican detrás de letras y versículos. Al elegir uno se quita la imagen o video de fondo.</p>
        <div class="pj-grid2">
          <label class="pj-fld">Color liso<input class="pj-in" type="color" data-set="bg.color"></label>
          <button class="pj-btn sm" id="pj-bg-clear" type="button">Quitar fondo (imagen, video o animado)</button>
        </div>
        <label class="pj-fld">Imagen o video de fondo<select class="pj-in" data-set="bg.fit"><option value="cover">Llenar la pantalla (puede recortar los bordes)</option><option value="contain">Completa (se ve entera, con barras si hace falta)</option></select></label>
        <label class="pj-fld">Oscurecer (legibilidad) <input type="range" min="0" max="90" data-set="bg.dim" data-scale="0.01"></label>
        <label class="pj-fld">Desenfoque <input type="range" min="0" max="40" data-set="bg.blur"></label>
        <div class="pj-help">Elige el fondo en la pestaña Media (botón «Fondo»). Las imágenes y videos que proyectas como diapositiva (botón «Proyectar») siempre se ven completos, sin recortar ni deformar.</div>

        <div class="pj-h">Salida Lower Third (OBS)</div>
        <label class="pj-fld">Fondo<select class="pj-in" data-set="lower.chroma"><option value="transparent">Transparente</option><option value="#00FF00">Croma verde #00FF00</option><option value="#0000FF">Croma azul #0000FF</option><option value="#FF00FF">Croma magenta #FF00FF</option></select></label>
        <label class="pj-fld">Tamaño del texto <input type="range" min="50" max="160" data-set="lower.size"></label>

        <div class="pj-h">Logo</div>
        <button class="pj-btn sm" id="pj-logo-default" type="button">Usar el logo por defecto</button>

        <div class="pj-h">Vista de escenario</div>
        <div class="pj-row"><input id="pj-stage-msg" class="pj-in" type="text" maxlength="200" placeholder="Mensaje para el escenario (ej. Una más)"><button class="pj-btn sm" id="pj-stage-send" type="button">Enviar</button><button class="pj-btn sm" id="pj-stage-clear" type="button">Quitar</button></div>
      </div>

      <div class="pj-panel" data-p="data">
        <div class="pj-h">Datos</div>
        <div class="pj-row">
          <button class="pj-btn sm" id="pj-demo" type="button">Cargar datos de ejemplo</button>
          <button class="pj-btn sm" id="pj-import" type="button">Importar JSON…</button>
          <input id="pj-import-input" type="file" accept=".json,application/json" hidden>
        </div>
        <label class="pj-chk"><input type="checkbox" id="pj-exp-bibles"> Incluir las Biblias al exportar</label>
        <button class="pj-btn sm block" id="pj-export" type="button">Exportar canciones y servicios (JSON)</button>
        <p class="pj-help" id="pj-storage"></p>
        <p class="pj-help">Las canciones de la biblioteca (Google Sheets) aparecen en Canciones con la etiqueta «app». Con internet, «Actualizar de Google Sheets» las vuelve a leer; sin internet se usa la última copia guardada.</p>
      </div>
    </aside>
  </div>

  <dialog id="pj-song-dlg" class="pj-dlg">
    <form method="dialog" id="pj-song-form">
      <div class="pj-h" id="pj-song-dlg-title">Canción</div>
      <input id="pj-sf-title" class="pj-in" type="text" maxlength="120" placeholder="Título" required>
      <div class="pj-row"><input id="pj-sf-author" class="pj-in" type="text" maxlength="120" placeholder="Autor"><input id="pj-sf-key" class="pj-in sm" type="text" maxlength="4" placeholder="Tono"></div>
      <textarea id="pj-sf-lyrics" class="pj-in" rows="14" placeholder="[Verso 1]&#10;Letra…&#10;&#10;[Coro]&#10;Letra…"></textarea>
      <p class="pj-help">Una etiqueta entre corchetes ([Verso 1], [Coro], [Puente]…) abre una sección. Una línea en blanco separa diapositivas. Los acordes entre corchetes ([G]) se ignoran al proyectar. Los cambios no modifican servicios ya armados: vuelve a agregar la canción.</p>
      <div class="pj-row">
        <button class="pj-btn primary" value="save" type="submit">Guardar</button>
        <button class="pj-btn" value="cancel" type="button" id="pj-sf-cancel">Cancelar</button>
        <button class="pj-btn" type="button" id="pj-sf-sheet" hidden>Subir a la biblioteca (Sheets)</button>
        <span class="pj-grow"></span>
        <button class="pj-btn danger" type="button" id="pj-sf-del" hidden>Eliminar</button>
      </div>
    </form>
  </dialog>
</div>`;
  }

  // ============================================================
  // Datos de apoyo
  // ============================================================
  function librarySongs() {
    try {
      if (!window.Database || !Database.isLoaded()) return [];
      return Database.getAllSongs().map((s) => ({ id: 'lib-' + s.id, source: 'library', title: s.title, key: s.originalKey, lyrics: s.lyrics }));
    } catch (e) { return []; }
  }
  const allSongs = () => ui.localSongs.concat(librarySongs());
  const bibleOpts = () => ({ maxChars: C.settings.bibleVersions.filter(Boolean).length > 1 ? 190 : 280, maxVerses: Math.max(1, Number(C.settings.bibleVerses) || 1) });
  const songOpts = () => ({ maxLines: C.settings.maxLines || 2, maxChars: C.settings.maxChars || 90 });

  async function loadLocal() {
    ui.localSongs = (await DB.all('songs')).map((s) => Object.assign({ source: 'local' }, s)).sort((a, b) => a.title.localeCompare(b.title));
    ui.media = (await DB.all('media')).sort((a, b) => b.added - a.added);
    ui.services = await C.services();
  }

  // ============================================================
  // Dibujar
  // ============================================================
  function renderBar() {
    root.querySelectorAll('[data-flag]').forEach((b) => b.classList.toggle('on', !!C.flags[b.dataset.flag]));
    $('pj-svc-name').value !== C.service.name && document.activeElement !== $('pj-svc-name') && ($('pj-svc-name').value = C.service.name);
  }

  function tickBar() {
    $('pj-clock').textContent = new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    const outs = C.connected();
    const n = (m) => outs.filter((o) => o.mode === m).length;
    const parts = [];
    if (n('pantalla')) parts.push('Proyección ✓');
    if (n('lower')) parts.push('Lower Third ✓');
    if (n('escenario')) parts.push('Escenario ✓');
    const el = $('pj-outs');
    el.textContent = parts.length ? parts.join(' · ') : 'Sin pantallas abiertas';
    el.classList.toggle('on', parts.length > 0);
  }

  const TYPE_CLS = (t) => 't-' + t;

  function renderItems() {
    const items = C.service.items;
    const live = C.mode === 'service' && C.cursor ? C.cursor.item : -1;
    $('pj-items').innerHTML = items.length ? items.map((it, i) =>
      `<li class="pj-item${i === ui.sel && (C.mode === 'service' || ui.viewService) ? ' sel' : ''}${i === live ? ' live' : ''}" draggable="true" data-i="${i}">
        <span class="pj-type ${TYPE_CLS(it.type)}">${TYPE[it.type] || ''}</span>
        <span class="pj-item-t">${esc(it.title)}</span>
        <span class="pj-item-n">${it.slides.length}</span>
        <span class="pj-item-b"><button type="button" data-act="up" aria-label="Subir">↑</button><button type="button" data-act="down" aria-label="Bajar">↓</button><button type="button" data-act="del" aria-label="Quitar">✕</button></span>
      </li>`).join('') : '<li class="pj-empty">El orden está vacío. Agrega canciones, citas, texto o media.</li>';
  }

  const pickIs = (q, i, j) => ui.picked && ui.picked.quick === q && ui.picked.item === i && ui.picked.slide === j;

  function renderSlides() {
    const quickView = C.mode === 'quick' && !ui.viewService;
    const item = quickView ? C.quick.items[0] : C.service.items[ui.sel];
    $('pj-slides-title').textContent = quickView ? 'Cita rápida (fuera del orden)' : (item ? item.title : 'Diapositivas');
    $('pj-quick-add').hidden = !quickView;
    $('pj-bible-more').hidden = !(item && item.type === 'bible' && item.meta && item.meta.ref);
    const box = $('pj-slides');
    if (!item) { box.innerHTML = '<div class="pj-empty">Elige un elemento del orden.</div>'; return; }
    const prevTop = box.scrollTop;
    box.innerHTML = item.slides.map((s, j) => {
      const live = quickView ? (C.mode === 'quick' && C.cursor && C.cursor.slide === j) : (C.mode === 'service' && C.cursor && C.cursor.item === ui.sel && C.cursor.slide === j);
      const body = s.kind === 'bible' ? (s.versions || []).map((v) => v.text).join('\n— — —\n') : (s.kind === 'media' ? (s.mediaKind === 'video' ? '▶ Video' : '🖼 Imagen') : (s.kind === 'countdown' ? '⏱ ' + s.minutes + ' min · ' + esc(s.countdownLabel) : s.text));
      return `<button type="button" class="pj-slide${live ? ' live' : ''}${pickIs(quickView, quickView ? 0 : ui.sel, j) ? ' picked' : ''}" data-j="${j}" style="--c:${s.color}">
        <span class="pj-slide-l">${esc(s.label)}${s.part ? ' · ' + esc(s.part) : ''}</span><span class="pj-slide-n">${j + 1}</span>
        <span class="pj-slide-t">${s.kind === 'countdown' || s.kind === 'media' ? body : esc(body)}</span></button>`;
    }).join('');
    fitSlidesBox(box);
    box.scrollTop = prevTop;
    const l = box.querySelector('.live');
    if (l) {                                   // primero se mueve el cuadro de diapositivas; la página solo si hace falta para que se vea la tarjeta
      const b = box.getBoundingClientRect(), r = l.getBoundingClientRect();
      if (r.top < b.top) box.scrollTop -= (b.top - r.top) + 4;
      else if (r.bottom > b.bottom) box.scrollTop += (r.bottom - b.bottom) + 4;
      const r2 = l.getBoundingClientRect();
      if (r2.bottom > window.innerHeight || r2.top < 0) l.scrollIntoView({ block: 'nearest' });
    }
  }

  /** El cuadro de diapositivas termina donde termina la ventana, para que la tarjeta en vivo nunca quede fuera de la pantalla */
  function fitSlidesBox(box) {
    box.style.maxHeight = '';
    const top = box.getBoundingClientRect().top + window.scrollY;
    const room = window.innerHeight - top - 16;
    box.style.maxHeight = Math.max(150, Math.min(room, window.innerHeight * 0.6)) + 'px';
  }

  /** Agrega a la cita actual los siguientes versículos del mismo capítulo (una diapositiva por versículo) */
  function bibleMore(n) {
    const quickView = C.mode === 'quick' && !ui.viewService;
    const item = quickView ? (C.quick && C.quick.items[0]) : C.service.items[ui.sel];
    if (!item || item.type !== 'bible' || !item.meta || !item.meta.ref) return;
    const ref = item.meta.ref, ids = (item.meta.versions || []).filter((id) => Bible.versions[id]);
    if (!ids.length) { toast('Esa Biblia ya no está cargada', 'error'); return; }
    let all = [];
    for (let i = 0; i < ids.length && !all.length; i++) all = Bible.getVerses(ids[i], { book: ref.book, chapter: ref.chapter, ranges: null }).map((v) => v.n);
    const last = ref.ranges ? Math.max.apply(null, ref.ranges.map((r) => r[1])) : Math.max.apply(null, all.concat([0]));
    const next = { book: ref.book, chapter: ref.chapter, ranges: [[last + 1, last + (n || 5)]] };
    const r = P.Slides.bibleSlides(next, ids, bibleOpts());
    if (r.error) { toast('No hay más versículos en este capítulo', 'error'); return; }
    item.slides = item.slides.concat(r.slides);
    const newLast = Math.max.apply(null, all.filter((v) => v > last && v <= last + (n || 5)));
    ref.ranges = (ref.ranges || [[1, last]]).concat([[last + 1, newLast]]);
    item.title = Bible.formatRef(ref, all.filter((v) => ref.ranges.some((x) => v >= x[0] && v <= x[1])));
    C.changed(false);
    render();
    toast(r.slides.length + ' versículo(s) más');
  }

  function slideAtPick(p) {
    const items = p.quick ? (C.quick ? C.quick.items : []) : C.service.items;
    return items[p.item] ? items[p.item].slides[p.slide] : null;
  }

  function renderMonitors() {
    const s = C.liveState();
    liveR.update(s);
    const staged = ui.staged && ui.staged.slides[0];
    const p = staged ? ui.staged.slides[0] : (ui.prepare && ui.picked ? slideAtPick(ui.picked) : s.next);
    $('pj-prev-t').textContent = staged ? 'PREVIA · ' + ui.staged.title + ' (Enter para proyectar)' : (ui.prepare && ui.picked ? 'PREPARADA (Enter para proyectar)' : 'SIGUIENTE');
    prevR.update(Object.assign({}, s, { slide: p, flags: {}, countdown: null }));
  }

  function renderEdit() {
    const cur = C.current();
    const ta = $('pj-edit-text'), sz = $('pj-edit-size');
    ta.disabled = sz.disabled = !cur || cur.kind === 'media' || cur.kind === 'countdown';
    $('pj-edit-info').textContent = cur ? '· ' + cur.label : '';
    if (document.activeElement !== ta) ta.value = cur && !ta.disabled ? cur.text : '';
    sz.value = Math.round(((cur && cur.fontScale) || 1) * 100);
    $('pj-edit-size-v').textContent = sz.value + '%';
  }

  function render() {
    if (C.showN !== lastShow) {                    // al proyectar algo nuevo, la lista sigue al cursor
      lastShow = C.showN;
      if (C.cursor) {
        if (C.mode === 'service') { ui.sel = C.cursor.item; ui.viewService = false; } else ui.viewService = false;
      }
    }
    renderBar(); renderItems(); renderSlides(); renderMonitors(); renderEdit();
    renderServiceSelect();
  }

  function renderServiceSelect() {
    const sel = $('pj-svc-open');
    if (document.activeElement === sel) return;
    sel.innerHTML = '<option value="">Abrir guardado…</option>' + ui.services.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} (${s.items.length})</option>`).join('');
  }

  function renderSongs() {
    const q = norm(ui.query).trim();
    const list = allSongs().filter((s) => !q || norm(s.title).includes(q) || norm(P.Slides.stripChords(s.lyrics || '')).includes(q)).slice(0, 80);
    $('pj-songs').innerHTML = list.length ? list.map((s) =>
      `<li class="pj-song" data-id="${esc(s.id)}"><span class="pj-song-t">${esc(s.title)}</span><span class="pj-tag ${s.source}">${s.source === 'local' ? 'local' : 'app'}</span>
        <span class="pj-song-b">${s.source === 'local' ? '<button type="button" data-act="edit" aria-label="Editar">✎</button>' : ''}<button type="button" data-act="add" aria-label="Agregar al orden">+</button></span></li>`).join('')
      : '<li class="pj-empty">Sin canciones. Usa «Nueva canción», o «Cargar datos de ejemplo» en la pestaña Datos.</li>';
  }

  function renderBibleVersions() {
    const list = Bible.list();
    const opts = '<option value="">(ninguna)</option>' + list.map((v) => `<option value="${esc(v.id)}">${esc(v.short)} · ${esc(v.name)}</option>`).join('');
    [0, 1].forEach((i) => {
      const sel = $('pj-bv' + i);
      sel.innerHTML = opts;
      sel.value = C.settings.bibleVersions[i] || '';
    });
    $('pj-bible-versions').innerHTML = list.length ? list.map((v) =>
      `<li class="pj-song" data-id="${esc(v.id)}"><span class="pj-song-t">${esc(v.name)}</span><span class="pj-tag local">${esc(v.short)}</span><span class="pj-song-b"><button type="button" data-act="rename" aria-label="Cambiar nombre corto">✎</button><button type="button" data-act="del" aria-label="Quitar">✕</button></span></li>`).join('')
      : '<li class="pj-empty">No hay ninguna Biblia cargada. Prueba «Buscar Biblias del servidor» (necesita biblias.json y la carpeta biblias/ en tu sitio), «Cargar Biblia (JSON)…», o los datos de ejemplo.</li>';
  }

  function renderBibleResults() {
    const ids = C.settings.bibleVersions.filter(Boolean);
    $('pj-bible-results').innerHTML = ui.kw.map((r, i) =>
      `<li class="pj-song" data-k="${i}"><span class="pj-song-t"><b>${esc(Bible.formatRef({ book: r.book, chapter: r.chapter }, [r.verse]))}</b> ${esc(r.text)}</span><span class="pj-song-b"><button type="button" data-act="go">▶</button></span></li>`).join('');
    void ids;
  }

  /** Miniaturas de los fondos animados (la primera es «sin animación») */
  const fxThumbs = [];
  function renderFxGallery() {
    const grid = $('pj-fxgrid');
    if (!grid) return;
    const cur = C.settings.bg.preset || '';
    if (!grid.children.length) {
      fxThumbs.forEach((h) => h.stop()); fxThumbs.length = 0;
      const tiles = [{ id: '', name: 'Sin animación' }].concat(P.Render.Fx.list);
      grid.innerHTML = tiles.map((f) => '<button type="button" class="pj-fxbtn" data-fx="' + f.id + '"><div class="pj-fxthumb"></div><div class="pj-fxname">' + esc(f.name) + '</div></button>').join('');
      [].slice.call(grid.querySelectorAll('.pj-fxbtn')).forEach((btn) => {
        const id = btn.dataset.fx;
        if (id) fxThumbs.push(P.Render.Fx.build(btn.querySelector('.pj-fxthumb'), id, { still: true }));
      });
    }
    [].slice.call(grid.querySelectorAll('.pj-fxbtn')).forEach((btn) => btn.classList.toggle('on', (btn.dataset.fx || '') === cur));
    const def = P.Render.Fx.byId(cur);
    $('pj-fx-accent').value = C.settings.bg.accent || (def ? def.accent : '#ffffff');
    $('pj-fx-accent').disabled = !def;
  }

  function renderMedia() {
    renderCdMedia();
    const bg = C.settings.bg.mediaId, lg = C.settings.logoMediaId;
    $('pj-thumbs').innerHTML = ui.media.length ? ui.media.map((m) =>
      `<div class="pj-thumb" data-id="${esc(m.id)}">
        <div class="pj-thumb-img" style="${m.thumb ? 'background-image:url(' + m.thumb + ')' : ''}">${m.kind === 'video' ? '<span class="pj-play">▶</span>' : ''}</div>
        <div class="pj-thumb-n" title="${esc(m.name)}">${esc(m.name)}</div>
        <div class="pj-thumb-b">
          <button type="button" data-act="bg" class="${bg === m.id ? 'on' : ''}">Fondo</button>
          <button type="button" data-act="slide">Proyectar</button>
          ${m.kind === 'image' ? `<button type="button" data-act="logo" class="${lg === m.id ? 'on' : ''}">Logo</button>` : ''}
          <button type="button" data-act="del" aria-label="Eliminar">✕</button>
        </div></div>`).join('') : '<div class="pj-empty">Aún no hay imágenes ni videos.</div>';
    const m = ui.media.find((x) => x.id === bg);
    const fxd = P.Render.Fx.byId(C.settings.bg.preset);
    $('pj-bg-name').textContent = m ? 'Fondo: ' + m.name + (m.kind === 'video' ? ' (video en bucle)' : '') : (fxd ? 'Fondo animado: ' + fxd.name : 'Fondo: color liso');
  }

  /** Llena la lista de imágenes/videos para «Al llegar a cero → mostrar una imagen o video» */
  function renderCdMedia() {
    const sel = $('pj-cd-media');
    if (!sel) return;
    sel.innerHTML = '<option value="">(elige un archivo)</option>' + ui.media.map((m) => '<option value="' + esc(m.id) + '">' + (m.kind === 'video' ? '▶ ' : '🖼 ') + esc(m.name) + '</option>').join('');
    sel.value = C.settings.cdAfterMediaId || '';
    $('pj-cd-media-wrap').hidden = C.settings.cdAfter !== 'media';
  }

  function syncSettings() {
    renderCdMedia();
    root.querySelectorAll('[data-set]').forEach((el) => {
      const v = getPath(C.settings, el.dataset.set);
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.dataset.scale) el.value = Math.round(Number(v) / Number(el.dataset.scale));
      else if (v != null) el.value = v;
    });
    $('pj-cd-min').value = C.settings.countdown.minutes;
    $('pj-cd-label').value = C.settings.countdown.label;
  }

  function switchTab(name) {
    ui.tab = name;
    root.querySelectorAll('.pj-tab').forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle('on', on); t.setAttribute('aria-selected', String(on)); });
    root.querySelectorAll('.pj-panel').forEach((p) => { p.hidden = p.dataset.p !== name; });
  }

  // ============================================================
  // Acciones
  // ============================================================
  /** Busca la pantalla extendida (proyector). Chrome/Edge piden un permiso la primera vez ("administrar ventanas"). */
  async function pickExternalScreen(mode) {
    if (mode === 'lower' || !window.getScreenDetails) return null;
    if (window.screen && window.screen.isExtended === false) return null;       // solo hay una pantalla
    try {
      const d = await window.getScreenDetails();
      const ext = d.screens.filter((s) => s !== d.currentScreen);                // las que NO son donde está la consola
      if (!ext.length) return null;
      return ext[mode === 'escenario' && ext.length > 1 ? 1 : 0];               // escenario: una tercera pantalla si existe
    } catch (e) { return null; }                                                 // permiso negado o no disponible
  }

  async function openOutput(mode) {
    const url = 'salida.html?modo=' + mode, name = 'alabanza-salida-' + mode;
    const tail = ',menubar=no,toolbar=no,location=no,status=no';
    const scr = await pickExternalScreen(mode);
    let feat = (mode === 'escenario' ? 'popup=yes,width=960,height=540' : 'popup=yes,width=1280,height=720') + tail;
    if (scr) {
      const L = scr.availLeft != null ? scr.availLeft : scr.left, T = scr.availTop != null ? scr.availTop : scr.top;
      const W = scr.availWidth || scr.width, H = scr.availHeight || scr.height;
      feat = 'popup=yes,left=' + L + ',top=' + T + ',width=' + W + ',height=' + H + tail;
    }
    const w = window.open(url, name, feat);
    if (!w) { toast('El navegador bloqueó la ventana. Permite ventanas emergentes para este sitio y vuelve a tocar el botón.', 'error'); return; }
    if (scr) { try { w.moveTo(scr.availLeft != null ? scr.availLeft : scr.left, scr.availTop != null ? scr.availTop : scr.top); } catch (e) { /* noop */ } }
    w.focus();
    if (mode === 'lower') return;
    toast(scr ? 'Se abrió en la otra pantalla. Haz un clic en ella para ponerla en pantalla completa'
              : 'Arrástrala al proyector y haz un clic en ella para pantalla completa');
  }

  function addToService(item, andGo) {
    const afterCur = andGo && C.mode === 'service' && C.cursor ? C.cursor.item + 1 : null;
    const pos = C.addItem(item, afterCur);
    ui.sel = pos; ui.viewService = true;
    if (andGo) C.go(pos, 0);
    render();
    return pos;
  }

  function addSong(id, andGo) {
    const s = allSongs().find((x) => x.id === id);
    if (!s) return;
    const it = Items.song(s, songOpts());
    if (!it.slides.length) { toast('Esa canción no tiene letra', 'error'); return; }
    addToService(it, andGo);
  }

  async function importSetlist() {
    const date = ($('setlist-date') || {}).value;
    if (!window.Database || !Database.isLoaded()) { toast('La biblioteca todavía no carga. Espera un momento o revisa tu internet.', 'error'); return; }
    const entries = Database.getSetlistEntries(date);
    if (!entries.length) { toast('El setlist del ' + (date || 'día elegido') + ' está vacío', 'error'); return; }
    let n = 0;
    entries.forEach((e) => {
      const s = Database.getSongById(e.songId);
      if (!s) return;
      C.addItem(Items.song({ id: 'lib-' + s.id, source: 'library', title: s.title, key: e.toneForService || s.originalKey, lyrics: s.lyrics }, songOpts()));
      n++;
    });
    toast(n + ' canciones agregadas del setlist ' + date);
    render();
  }

  function bibleMsg(t, bad) { const el = $('pj-bible-msg'); el.textContent = t || ''; el.classList.toggle('bad', !!bad); }

  /** Proyecta una cita (quita el logo / negro, igual que cualquier diapositiva nueva) */
  function projectStaged(it) {
    it = it || ui.staged;
    if (!it) return;
    ui.staged = null; ui.stagedQ = '';
    ui.lastBible = it;
    C.projectQuick(it);
    bibleMsg('Proyectando ' + it.title + (it.slides.length > 1 ? ' (' + it.slides.length + ' diapositivas: ↓ para avanzar)' : ''));
    renderBibleResults(); render();
  }

  function bibleGo(text) {
    const q = text.trim();
    if (!q) return;
    const ids = C.settings.bibleVersions.filter(Boolean);
    if (!ids.length) { bibleMsg('Primero carga una Biblia («Cargar Biblia (JSON)…» o los datos de ejemplo).', true); return; }
    const ref = Bible.parseRef(q);
    if (ref && ref.error) { bibleMsg(ref.error, true); return; }
    if (ref) {
      const it = Items.bible(ref, ids, bibleOpts());
      if (it.error) { bibleMsg(it.error, true); return; }
      ui.kw = [];
      const same = ui.staged && ui.stagedQ === q;
      if (C.settings.bibleStage && !same) {                    // 1.er Enter: solo la previa (no toca lo que está en pantalla)
        ui.staged = it; ui.stagedQ = q;
        bibleMsg('Previa de ' + it.title + ': revisa el monitor. Enter otra vez para proyectar.');
        renderBibleResults(); render();
        return;
      }
      projectStaged(it);                                        // 2.º Enter (o con la previa apagada): se proyecta
      return;
    }
    ui.kw = Bible.search(ids[0], q, 40);
    bibleMsg(ui.kw.length ? ui.kw.length + ' resultado(s). Toca ▶ para proyectar.' : 'Sin resultados para «' + q + '».', !ui.kw.length);
    renderBibleResults();
  }

  async function loadBibleFile(file) {
    try {
      const json = JSON.parse(await file.text());
      const v = Bible.parseBibleFile(json, file.name.replace(/\.[^.]+$/, ''));
      await DB.put('bibles', v);
      Bible.add(v);
      if (!C.settings.bibleVersions[0]) C.setSetting('bibleVersions.0', v.id);
      const n = Object.keys(v.books).reduce((a, b) => a + Object.keys(v.books[b].ch).reduce((x, c) => x + Object.keys(v.books[b].ch[c]).length, 0), 0);
      toast(v.name + ': ' + n + ' versículos cargados');
      renderBibleVersions();
    } catch (e) { toast('No se pudo leer la Biblia: ' + e.message, 'error'); }
  }

  /** Descarga las Biblias que lista biblias.json (están en la carpeta biblias/ del sitio) y las guarda en este dispositivo */
  let bibleSyncing = false;
  async function syncServerBibles(manual) {
    if (bibleSyncing) return;
    bibleSyncing = true;
    try {
      let list = null;
      try {
        const r = await fetch('biblias.json', { cache: 'no-cache' });
        if (r.ok) list = (await r.json()).biblias || [];
      } catch (e) { /* sin red o sin archivo */ }
      if (!list || !list.length) { if (manual) toast('No encontré biblias.json en el servidor. Revisa que lo hayas subido junto con la carpeta biblias/', 'error'); return; }
      let added = 0;
      for (const e of list) {
        const id = e.id || (e.short || e.file || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (Bible.versions[id]) continue;                       // ya está en este dispositivo
        if (!manual && e.auto === false) continue;              // las marcadas auto:false solo se bajan con el botón
        try {
          const r = await fetch('biblias/' + e.file);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const v = Bible.parseBibleFile(await r.json(), e.name || e.file);
          v.id = id; if (e.name) v.name = e.name; if (e.short) v.short = e.short;
          await DB.put('bibles', v);
          Bible.add(v); added++;
          if (!C.settings.bibleVersions[0]) C.setSetting('bibleVersions.0', v.id);
        } catch (x) { if (manual || !Bible.list().length) toast('No se pudo cargar ' + (e.name || e.file) + ': ' + x.message, 'error'); }
      }
      renderBibleVersions(); syncSettings();
      if (added) toast(added + ' Biblia(s) lista(s)');
      else if (manual) toast('Ya tienes todas las Biblias del servidor');
    } finally { bibleSyncing = false; }
  }

  async function makeThumb(file, kind) {
    try {
      const draw = (src, w, h) => {
        const c = document.createElement('canvas');
        const r = Math.min(1, 240 / Math.max(w, h));
        c.width = Math.max(1, Math.round(w * r)); c.height = Math.max(1, Math.round(h * r));
        c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.7);
      };
      if (kind === 'image') { const bmp = await createImageBitmap(file); const d = draw(bmp, bmp.width, bmp.height); if (bmp.close) bmp.close(); return d; }
      return await new Promise((resolve) => {
        const url = URL.createObjectURL(file), v = document.createElement('video');
        const done = (d) => { URL.revokeObjectURL(url); resolve(d); };
        v.muted = true; v.preload = 'auto'; v.src = url;
        v.onloadeddata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 4); };
        v.onseeked = () => { try { done(draw(v, v.videoWidth || 320, v.videoHeight || 180)); } catch (e) { done(''); } };
        v.onerror = () => done('');
        setTimeout(() => done(''), 5000);
      });
    } catch (e) { return ''; }
  }

  /** Lee la imagen con el navegador (si no puede, el formato no sirve) y reduce las fotos gigantes (> 3840 px) para que no pesen ni se trabe el proyector */
  async function prepareImage(f) {
    let bmp;
    try { bmp = await createImageBitmap(f); } catch (e) { return { error: true }; }
    const long = Math.max(bmp.width, bmp.height);
    const keep = /gif|svg/i.test(f.type) || /\.(gif|svg)$/i.test(f.name);       // los GIF animados y SVG no se tocan
    if (long <= 3840 || keep) { if (bmp.close) bmp.close(); return { blob: f, type: f.type }; }
    const k = 3840 / long, c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    const png = /png|webp/i.test(f.type);                                          // conserva la transparencia
    const blob = await new Promise((res) => c.toBlob(res, png ? 'image/png' : 'image/jpeg', 0.92));
    return blob ? { blob, type: blob.type } : { blob: f, type: f.type };
  }

  async function addMedia(files) {
    let n = 0;
    for (const f of Array.from(files)) {
      const isVideo = /^video\//.test(f.type) || /\.(mp4|webm|mov|m4v|ogv)$/i.test(f.name);
      const isImage = /^image\//.test(f.type) || /\.(jpe?g|jfif|png|webp|gif|avif|bmp|svg|ico|tiff?|heic|heif)$/i.test(f.name);
      if (!isVideo && !isImage) { toast('Formato no compatible: ' + f.name + ' (usa JPG, PNG, WebP, GIF o video MP4/WebM)', 'error'); continue; }
      let blob = f, mime = f.type, kind = isVideo ? 'video' : 'image';
      if (kind === 'image') {
        const r = await prepareImage(f);
        if (r.error) { toast('Este navegador no puede leer «' + f.name + '» (los HEIC de iPhone y los TIFF casi nunca abren). Conviértela a JPG o PNG e inténtalo otra vez.', 'error'); continue; }
        blob = r.blob; mime = r.type;
      }
      const thumb = await makeThumb(blob, kind);
      await DB.put('media', { id: P.util.uid(), name: f.name.replace(/\.[^.]+$/, ''), kind, mime, blob, thumb, size: blob.size, added: Date.now() });
      n++;
    }
    if (n) { ui.media = (await DB.all('media')).sort((a, b) => b.added - a.added); renderMedia(); toast(n + ' archivo(s) guardados'); }
  }

  async function mediaAction(id, act) {
    const m = ui.media.find((x) => x.id === id);
    if (!m) return;
    if (act === 'bg') { C.setSetting('bg.mediaId', C.settings.bg.mediaId === id ? null : id); if (C.settings.bg.mediaId) C.setSetting('bg.preset', null); renderFxGallery(); }
    else if (act === 'logo') C.setSetting('logoMediaId', C.settings.logoMediaId === id ? null : id);
    else if (act === 'slide') { addToService(Items.media(m), true); }
    else if (act === 'del') {
      if (!confirm('¿Eliminar «' + m.name + '»?')) return;
      await DB.del('media', id);
      P.Render.forgetMedia(id);
      if (C.settings.bg.mediaId === id) C.setSetting('bg.mediaId', null);
      if (C.settings.logoMediaId === id) C.setSetting('logoMediaId', null);
      ui.media = ui.media.filter((x) => x.id !== id);
    }
    renderMedia();
  }

  // ---------- Diálogo de canción local ----------
  let editingSong = null;
  function openSongDialog(id) {
    const s = id ? ui.localSongs.find((x) => x.id === id) : null;
    editingSong = s;
    $('pj-song-dlg-title').textContent = s ? 'Editar canción' : 'Nueva canción';
    $('pj-sf-title').value = s ? s.title : '';
    $('pj-sf-author').value = s ? s.author || '' : '';
    $('pj-sf-key').value = s ? s.key || '' : '';
    $('pj-sf-lyrics').value = s ? s.lyrics : '';
    $('pj-sf-del').hidden = !s;
    $('pj-sf-sheet').hidden = !(window.Database && Database.isAdminMode && Database.isAdminMode());
    $('pj-song-dlg').showModal();
  }

  async function saveSong(e) {
    e.preventDefault();
    const title = $('pj-sf-title').value.trim();
    if (!title) return;
    const rec = { id: editingSong ? editingSong.id : P.util.uid(), source: 'local', title, author: $('pj-sf-author').value.trim(), key: $('pj-sf-key').value.trim(), lyrics: $('pj-sf-lyrics').value, updated: Date.now() };
    await DB.put('songs', rec);
    $('pj-song-dlg').close();
    await loadLocal(); renderSongs();
    toast('Canción guardada');
  }

  async function exportJson() {
    const data = await Data.exportAll({ bibles: $('pj-exp-bibles').checked });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'alabanza-proyeccion-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function importJson(json, openFirst) {
    const res = await Data.importAll(json, { librarySongs, maxLines: C.settings.maxLines });
    await loadLocal();
    if (openFirst && json.services && json.services[0] && json.services[0].id) await C.openService(String(json.services[0].id));
    renderSongs(); renderBibleVersions();
    const first = Bible.list()[0];
    if (first && !C.settings.bibleVersions[0]) C.setSetting('bibleVersions.0', first.id);
    renderBibleVersions(); renderServiceSelect();
    toast('Importado: ' + res.songs + ' canciones, ' + res.bibles + ' Biblias, ' + res.services + ' servicios' + (res.avisos.length ? '. Avisos: ' + res.avisos.join('; ') : ''), res.avisos.length ? 'error' : undefined);
    render();
  }

  async function updateStorageInfo() {
    let txt = (await DB.isPersistent()) ? 'Datos guardados en este navegador (IndexedDB).' : 'Este navegador no permite guardar datos: lo que cargues se pierde al cerrar.';
    try { if (navigator.storage && navigator.storage.persisted) txt += (await navigator.storage.persisted()) ? ' Almacenamiento protegido.' : ' Sin protección contra borrado automático.'; } catch (e) { /* noop */ }
    $('pj-storage').textContent = txt;
  }

  // ============================================================
  // Eventos
  // ============================================================
  function bind() {
    $('pj-open').onclick = () => openOutput('pantalla');
    $('pj-open-lower').onclick = () => openOutput('lower');
    $('pj-open-stage').onclick = () => openOutput('escenario');
    root.querySelectorAll('[data-flag]').forEach((b) => { b.onclick = () => C.toggleFlag(b.dataset.flag); });
    root.querySelectorAll('.pj-tab').forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });

    $('pj-cd-start').onclick = () => C.startCountdown($('pj-cd-min').value, $('pj-cd-label').value.trim());
    $('pj-cd-stop').onclick = () => C.stopCountdown();
    $('pj-cd-add').onclick = () => { addToService(Items.countdown($('pj-cd-min').value, $('pj-cd-label').value.trim()), false); };

    // Servicio
    $('pj-svc-name').onchange = () => { C.service.name = $('pj-svc-name').value.trim() || 'Servicio'; C.save(); loadLocal().then(renderServiceSelect); };
    $('pj-svc-new').onclick = () => { C.newService('Servicio ' + new Date().toLocaleDateString('es', { day: 'numeric', month: 'short' })); ui.sel = 0; loadLocal().then(render); };
    $('pj-svc-open').onchange = async (e) => { if (e.target.value) { await C.openService(e.target.value); ui.sel = 0; ui.viewService = true; render(); } };
    $('pj-svc-setlist').onclick = importSetlist;
    $('pj-txt-add').onclick = () => {
      const body = $('pj-txt-body').value.trim();
      if (!body) return;
      const it = Items.text($('pj-txt-title').value.trim() || 'Texto', body);
      addToService(it, false);
      $('pj-txt-body').value = ''; $('pj-txt-title').value = '';
    };

    $('pj-items').addEventListener('click', (e) => {
      const li = e.target.closest('.pj-item');
      if (!li) return;
      const i = Number(li.dataset.i), btn = e.target.closest('button');
      if (btn) {
        const act = btn.dataset.act;
        if (act === 'del') { if (confirm('¿Quitar «' + C.service.items[i].title + '» del orden?')) { C.removeItem(i); ui.sel = Math.max(0, Math.min(ui.sel, C.service.items.length - 1)); } }
        else if (act === 'up') { C.moveItem(i, i - 1); ui.sel = Math.max(0, i - 1); }
        else if (act === 'down') { C.moveItem(i, i + 1); ui.sel = Math.min(C.service.items.length - 1, i + 1); }
        render();
        return;
      }
      ui.sel = i; ui.viewService = true; render();
    });
    $('pj-items').addEventListener('dblclick', (e) => {
      const li = e.target.closest('.pj-item');
      if (li && !e.target.closest('button')) { C.go(Number(li.dataset.i), 0); render(); }
    });
    // Arrastrar para reordenar
    let dragFrom = null;
    $('pj-items').addEventListener('dragstart', (e) => { const li = e.target.closest('.pj-item'); if (li) { dragFrom = Number(li.dataset.i); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch (x) { /* noop */ } } });
    $('pj-items').addEventListener('dragover', (e) => { if (dragFrom !== null) e.preventDefault(); });
    $('pj-items').addEventListener('drop', (e) => {
      const li = e.target.closest('.pj-item');
      if (li && dragFrom !== null) { e.preventDefault(); const to = Number(li.dataset.i); C.moveItem(dragFrom, to); ui.sel = to; render(); }
      dragFrom = null;
    });

    // Diapositivas
    $('pj-slides').addEventListener('click', (e) => {
      const b = e.target.closest('.pj-slide');
      if (!b) return;
      const j = Number(b.dataset.j);
      const quickView = C.mode === 'quick' && !ui.viewService;
      ui.staged = null;
      if (ui.prepare) { ui.picked = { quick: quickView, item: quickView ? 0 : ui.sel, slide: j }; render(); return; }
      if (quickView) C.goQuick(j); else C.go(ui.sel, j);
      render();
    });
    $('pj-quick-add').onclick = () => { if (C.quick) { const it = C.quick.items[0]; addToService(JSON.parse(JSON.stringify(it)), false); toast('Agregado al orden'); } };
    $('pj-prepare').onchange = (e) => { ui.prepare = e.target.checked; ui.picked = null; render(); };

    // Edición en caliente
    const path = () => (C.cursor ? { item: C.cursor.item, slide: C.cursor.slide, quick: C.mode === 'quick' } : null);
    $('pj-edit-text').addEventListener('input', (e) => { const p = path(); if (p) C.editSlide(p, { text: e.target.value }); });
    $('pj-edit-size').addEventListener('input', (e) => { const p = path(); if (p) C.editSlide(p, { fontScale: Number(e.target.value) / 100 }); });

    // Canciones
    $('pj-song-q').addEventListener('input', (e) => { ui.query = e.target.value; renderSongs(); });
    $('pj-song-new').onclick = () => openSongDialog(null);
    $('pj-song-refresh').onclick = async () => {
      if (!window.Database) return;
      try { await Database.refresh(); toast(Database.isOffline() ? 'Sin conexión: se usa la última copia guardada' : 'Biblioteca actualizada'); } catch (e) { toast('No se pudo actualizar', 'error'); }
      renderSongs();
    };
    $('pj-songs').addEventListener('click', (e) => {
      const li = e.target.closest('.pj-song');
      if (!li) return;
      const btn = e.target.closest('button');
      if (btn && btn.dataset.act === 'edit') openSongDialog(li.dataset.id);
      else addSong(li.dataset.id, false);
    });
    $('pj-songs').addEventListener('dblclick', (e) => { const li = e.target.closest('.pj-song'); if (li && !e.target.closest('button')) addSong(li.dataset.id, true); });
    $('pj-song-form').addEventListener('submit', saveSong);
    $('pj-sf-cancel').onclick = () => $('pj-song-dlg').close();
    $('pj-sf-del').onclick = async () => {
      if (editingSong && confirm('¿Eliminar «' + editingSong.title + '»?')) { await DB.del('songs', editingSong.id); $('pj-song-dlg').close(); await loadLocal(); renderSongs(); }
    };
    $('pj-sf-sheet').onclick = async () => {
      try {
        await Database.addSong({ title: $('pj-sf-title').value.trim(), originalKey: $('pj-sf-key').value.trim() || 'C', bpm: 120, timeSig: '4/4', lyrics: $('pj-sf-lyrics').value, sequence: '', seqSkip: '' });
        toast('Canción subida a la biblioteca (Google Sheets)');
      } catch (e) { toast('No se pudo subir: ' + e.message, 'error'); }
    };

    // Biblia
    $('pj-bible-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); bibleGo(e.target.value); } });
    $('pj-bible-add').onclick = () => { if (ui.lastBible) { addToService(JSON.parse(JSON.stringify(ui.lastBible)), false); toast('Cita agregada al orden'); } else bibleMsg('Aún no has proyectado ninguna cita.', true); };
    $('pj-bible-file').onclick = () => $('pj-bible-input').click();
    $('pj-bible-more').onclick = () => bibleMore(5);
    let cdTest = null;
    $('pj-cd-test').onclick = () => {
      if (cdTest) { cdTest.stop(); cdTest = null; }
      if (!P.Render.Sound.unlock() && !P.Render.Sound.running()) { /* el clic ya lo habilita */ }
      cdTest = P.Render.Sound.preview((C.settings.cdVolume == null ? 70 : C.settings.cdVolume) / 100, C.padKey());
      if (!cdTest) toast('Este navegador no permite generar sonido', 'error');
    };
    window.addEventListener('resize', () => fitSlidesBox($('pj-slides')));
    $('pj-bible-sync').onclick = () => syncServerBibles(true);
    $('pj-reslice').onclick = () => {
      const n = C.resliceSongs((it) => allSongs().find((s) => String(s.id) === String(it.meta && it.meta.songId)), songOpts());
      render();
      toast(n ? n + ' canción(es) actualizadas' : 'No hay canciones en el orden para actualizar', n ? undefined : 'error');
    };
    $('pj-bible-input').onchange = async (e) => { for (const f of Array.from(e.target.files)) await loadBibleFile(f); e.target.value = ''; };
    $('pj-bible-results').addEventListener('click', (e) => {
      const li = e.target.closest('.pj-song');
      if (!li) return;
      const r = ui.kw[Number(li.dataset.k)];
      const it = Items.bible({ book: r.book, chapter: r.chapter, ranges: [[r.verse, r.verse]] }, C.settings.bibleVersions.filter(Boolean), bibleOpts());
      if (it.error) { bibleMsg(it.error, true); return; }
      ui.lastBible = it; C.projectQuick(it); render();
    });
    $('pj-bible-versions').addEventListener('click', async (e) => {
      const li = e.target.closest('.pj-song'), btn = e.target.closest('button');
      if (!li || !btn) return;
      const v = Bible.versions[li.dataset.id];
      if (btn.dataset.act === 'del') {
        if (!confirm('¿Quitar la Biblia «' + v.name + '»?')) return;
        await DB.del('bibles', v.id); Bible.remove(v.id);
        [0, 1].forEach((i) => { if (C.settings.bibleVersions[i] === v.id) C.setSetting('bibleVersions.' + i, ''); });
      } else if (btn.dataset.act === 'rename') {
        const s = prompt('Nombre corto que se muestra en pantalla (ej. RVR1960):', v.short);
        if (s) { v.short = s.trim().slice(0, 10); await DB.put('bibles', Object.assign({}, v, { index: undefined })); }
      }
      renderBibleVersions();
    });

    // Media
    $('pj-media-pick').onclick = () => $('pj-media-input').click();
    $('pj-media-input').onchange = async (e) => { await addMedia(e.target.files); e.target.value = ''; };
    const drop = $('pj-drop');
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); drop.classList.add('over'); } }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length) addMedia(e.dataTransfer.files); });
    // También se puede soltar un archivo en cualquier parte de la vista
    root.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); });
    root.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length && !e.defaultPrevented) { e.preventDefault(); switchTab('media'); addMedia(e.dataTransfer.files); } });
    $('pj-thumbs').addEventListener('click', (e) => {
      const b = e.target.closest('button'), t = e.target.closest('.pj-thumb');
      if (b && t) mediaAction(t.dataset.id, b.dataset.act);
    });
    $('pj-bg-clear').onclick = () => { C.setSetting('bg.mediaId', null); C.setSetting('bg.preset', null); renderMedia(); renderFxGallery(); };
    $('pj-fx-accent').oninput = (e) => { C.setSetting('bg.accent', e.target.value); };
    $('pj-fx-reset').onclick = () => { C.setSetting('bg.accent', ''); renderFxGallery(); };
    $('pj-fxgrid').addEventListener('click', (e) => {
      const b = e.target.closest('.pj-fxbtn');
      if (!b) return;
      const id = b.dataset.fx || null;
      C.setSetting('bg.preset', id);
      if (id) { C.setSetting('bg.mediaId', null); C.setSetting('bg.accent', ''); C.setSetting('bg.dim', 0); C.setSetting('bg.blur', 0); }   // sin oscurecer: así la luz se ve más en la pared
      renderMedia(); syncSettings(); renderFxGallery();
    });
    $('pj-logo-default').onclick = () => { C.setSetting('logoMediaId', null); renderMedia(); };

    // Ajustes (cada control con data-set escribe directo en la configuración)
    root.querySelectorAll('[data-set]').forEach((el) => {
      const apply = () => {
        let v = el.type === 'checkbox' ? el.checked : (el.type === 'range' || el.type === 'number' ? Number(el.value) * (Number(el.dataset.scale) || 1) : el.value);
        if (el.dataset.set === 'text.weight') v = Number(v);
        C.setSetting(el.dataset.set, v);
        if (el.dataset.set.indexOf('bibleVersions') === 0) renderBibleVersions();
      };
      el.addEventListener('input', apply);
      el.addEventListener('change', apply);
    });
    $('pj-cd-after').addEventListener('change', () => { $('pj-cd-media-wrap').hidden = $('pj-cd-after').value !== 'media'; });
    $('pj-stage-send').onclick = () => C.setStageMsg($('pj-stage-msg').value);
    $('pj-stage-clear').onclick = () => { $('pj-stage-msg').value = ''; C.setStageMsg(''); };

    // Datos
    $('pj-export').onclick = exportJson;
    $('pj-import').onclick = () => $('pj-import-input').click();
    $('pj-import-input').onchange = async (e) => {
      for (const f of Array.from(e.target.files)) {
        try { await importJson(JSON.parse(await f.text()), true); } catch (x) { toast('No se pudo importar: ' + x.message, 'error'); }
      }
      e.target.value = '';
    };
    $('pj-demo').onclick = async () => {
      try {
        const r = await fetch('proyeccion-ejemplo.json', { cache: 'no-cache' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        await importJson(await r.json(), true);
        const v = Bible.list().map((x) => x.id);
        if (v[0] && !C.settings.bibleVersions[0]) C.setSetting('bibleVersions.0', v[0]);
        renderBibleVersions(); syncSettings();
      } catch (e) { toast('No se pudieron cargar los datos de ejemplo: ' + e.message, 'error'); }
    };

    // Teclado
    document.addEventListener('keydown', onKey);
    $('pj-sf-cancel').addEventListener('keydown', () => {});
  }

  function onKey(e) {
    const view = $('projection-view');
    if (!view || !view.classList.contains('active')) return;
    if (document.querySelector('dialog[open]')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault(); switchTab('bible');
      const q = $('pj-bible-q'); q.focus(); q.select();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (typing) { e.target.blur(); return; }
      e.preventDefault(); C.toggleFlag('black'); return;
    }
    if (typing) return;
    const k = e.key;
    if (k !== 'Enter' && ui.staged && /^(Arrow|Page| )/.test(k)) ui.staged = null;   // navegar descarta la previa
    if (k === 'ArrowDown' || k === 'ArrowRight' || k === ' ') { e.preventDefault(); C.next(); }
    else if (k === 'ArrowUp' || k === 'ArrowLeft') { e.preventDefault(); C.prev(); }
    else if (k === 'PageDown') { e.preventDefault(); C.jumpItem(1); }
    else if (k === 'PageUp') { e.preventDefault(); C.jumpItem(-1); }
    else if (k === 'b' || k === 'B') C.toggleFlag('black');
    else if (k === 'c' || k === 'C') C.toggleFlag('clear');
    else if (k === 'l' || k === 'L') C.toggleFlag('logo');
    else if (k === 'Enter' && ui.staged) { e.preventDefault(); projectStaged(); }
    else if (k === 'Enter' && ui.prepare && ui.picked) {
      e.preventDefault();
      if (ui.picked.quick) C.goQuick(ui.picked.slide); else C.go(ui.picked.item, ui.picked.slide);
    } else return;
    render();
  }

  // ============================================================
  // Inicio
  // ============================================================
  async function init() {
    root = $('proy-root');
    if (!root) return;
    root.innerHTML = template();
    ch = P.channel();
    C = P.createController({ channel: ch });
    C.getMedia = (id) => ui.media.find((m) => m.id === id) || null;
    await C.init();
    await loadLocal();

    liveR = P.Render.mount($('pj-mon-live'), { mode: 'pantalla', muted: true });
    prevR = P.Render.mount($('pj-mon-prev'), { mode: 'pantalla', muted: true });

    ch.on((m) => {
      if (m && m.t === 'audio-blocked' && !audioWarned) {
        audioWarned = true;
        toast('Haz clic una vez dentro de la ventana de proyección para activar el audio de los videos', 'error');
      }
    });

    bind();
    switchTab('songs');
    syncSettings();
    renderSongs(); renderBibleVersions(); renderBibleResults(); renderMedia(); renderFxGallery();
    syncServerBibles(false);        // si falta alguna Biblia del servidor, se baja sola (una vez por dispositivo)
    C.onChange(render);
    render();
    setInterval(tickBar, 1000); tickBar();
    updateStorageInfo();
    window.addEventListener('database:change', () => { renderSongs(); });
    // Pide a Chrome que no borre los videos e imágenes guardados
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* noop */ }
    window.Projection = { controller: C, openOutput, next: () => C.next(), prev: () => C.prev() };
  }

  document.addEventListener('DOMContentLoaded', () => { init().catch((e) => { console.error(e); toast('No se pudo iniciar Proyección: ' + e.message, 'error'); }); });
})();
