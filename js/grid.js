/* MakerBeater – grid.js
 * Piano roll: vykreslování mřížky na canvas a editace not přes Pointer Events
 * (myš, pero i dotyk). Řádky = výška tónu (vysoké nahoře), sloupce = čas.
 *
 * Rozložení: pravítko (nahoře), klaviatura (vlevo) a mřížka. Mřížka je canvas
 * velký jen jako viditelná plocha – pod ním leží průhledný scrollovací <div>
 * s „distančním“ prvkem velikosti celé skladby. Ten dává nativní posuvníky
 * a kolečko myši; canvas se jen překreslí podle scrollLeft/scrollTop.
 */
(function (MB) {
  'use strict';

  const { PPQ, State, clamp } = MB;

  const MIN_PITCH = MB.PITCH_MIN; // C1
  const MAX_PITCH = MB.PITCH_MAX; // C7
  const RULER_H = 30;
  const CLIPBOARD_KEY = 'makerbeater.clipboard.v1';
  const KEYS_W = 64;
  const DRUM_KEYS_W = 116;
  const BEAT_W_MIN = 12;
  const BEAT_W_MAX = 480;
  const ROW_H_MIN = 8;
  const ROW_H_MAX = 40;
  const FONT = "'Inter', 'Segoe UI', system-ui, sans-serif";

  const COL = {
    bg: '#0b0d12',
    rowWhite: '#1a1e28',
    rowBlack: '#141821',
    rowOut: '#0f1218',
    rowOutBlack: '#0c0f14',
    rowRoot: 'rgba(124, 92, 255, 0.10)',
    rowHover: 'rgba(255, 255, 255, 0.04)',
    drumA: '#191d27',
    drumB: '#151922',
    barShade: 'rgba(255, 255, 255, 0.018)',
    lineStep: 'rgba(255, 255, 255, 0.045)',
    lineBeat: 'rgba(255, 255, 255, 0.11)',
    lineBar: 'rgba(255, 255, 255, 0.28)',
    lineRow: 'rgba(0, 0, 0, 0.35)',
    lineOctave: 'rgba(255, 255, 255, 0.09)',
    afterEnd: 'rgba(0, 0, 0, 0.5)',
    playhead: '#22d3ee',
    accent: '#7c5cff',
  };

  // Kurzory jako malé SVG (tužka, guma)
  const svgCursor = (path, x, y, fallback) => {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 24 24'>` +
      `<path d='${path}' fill='white' stroke='black' stroke-width='1.3' stroke-linejoin='round'/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
  };
  const CURSOR_DRAW = svgCursor('M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z', 3, 19, 'crosshair');
  const CURSOR_ERASE = svgCursor('M16.24 3.56l4.95 4.94c.78.79.78 2.05 0 2.84L12 20.53a4 4 0 0 1-5.66 0L2.81 17c-.78-.79-.78-2.05 0-2.84l10.6-10.6c.79-.78 2.05-.78 2.83 0z', 5, 19, 'not-allowed');

  // ---------------------------------------------------------------------------
  // Barvy a kreslicí pomůcky
  // ---------------------------------------------------------------------------

  const rgbCache = new Map();
  function hexToRgb(hex) {
    let v = rgbCache.get(hex);
    if (!v) {
      let h = String(hex).replace('#', '');
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      const n = parseInt(h, 16) || 0;
      v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      rgbCache.set(hex, v);
    }
    return v;
  }
  const rgba = (hex, a) => {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  };
  const lighten = (hex, amt) => {
    const [r, g, b] = hexToRgb(hex);
    const f = (c) => Math.round(c + (255 - c) * amt);
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  };

  function roundRect(c, x, y, w, h, r) {
    if (c.roundRect) {
      c.roundRect(x, y, w, h, r);
      return;
    }
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // ---------------------------------------------------------------------------
  // Stav mřížky
  // ---------------------------------------------------------------------------

  const G = {
    els: null,
    gctx: null,
    rctx: null,
    kctx: null,
    dpr: 1,
    viewW: 0,           // viditelná plocha mřížky (bez posuvníků)
    viewH: 0,
    beatW: 80,          // vodorovný zoom: px na jednu dobu
    rowHeight: 18,      // svislý zoom: px na řádek (bicí mají řádky vyšší)
    sl: 0,              // scrollLeft / scrollTop pro aktuální výpočty
    st: 0,
    kind: 'melodic',    // druh aktuální stopy: 'melodic' | 'drums'
    drag: null,         // probíhající tažení (viz start* funkce)
    mouse: null,        // pozice myši nad mřížkou
    lastPt: null,
    lastEvt: null,
    keysHover: -1,      // řádek pod myší na klaviatuře
    keysDown: null,     // { row, voice } – držená klávesa
    rulerDrag: null,
    touches: new Map(), // aktivní prsty (pinch zoom)
    autoRAF: 0,
    lastLength: PPQ / 4,
    playTick: 0,
    scrollMemory: new Map(), // id stopy → scrollTop
    dirty: true,
  };

  // ---------------------------------------------------------------------------
  // Geometrie: tick ↔ x, řádek ↔ y
  // ---------------------------------------------------------------------------

  const track = () => State.currentTrack();
  const kindOf = (t) => MB.getInstrument(t.instrument).kind;
  const drumRows = () => MB.DRUM_ROWS || [];
  const isDrums = () => G.kind === 'drums';
  const rowCount = () => (isDrums() ? drumRows().length : MAX_PITCH - MIN_PITCH + 1);
  // bicí mají řádků málo – roztáhnou se na celou výšku okna (svislý zoom je může zvětšit ještě víc)
  const drumRowH = () => Math.max(Math.floor(G.viewH / Math.max(1, drumRows().length)), Math.round(G.rowHeight * 1.6));
  const rowH = () => (isDrums() ? drumRowH() : G.rowHeight);
  const pitchToRow = (pitch) => (isDrums() ? pitch : pitch - MIN_PITCH);
  const rowToPitch = (row) => (isDrums() ? row : row + MIN_PITCH);
  const pitchRange = () => (isDrums() ? [0, rowCount() - 1] : [MIN_PITCH, MAX_PITCH]);

  const tickX = (tick) => (tick * G.beatW) / PPQ - G.sl;
  const xTick = (x) => ((x + G.sl) * PPQ) / G.beatW;
  const rowY = (row) => (rowCount() - 1 - row) * rowH() - G.st;
  const yRow = (y) => rowCount() - 1 - Math.floor((y + G.st) / rowH());

  function syncScroll() {
    G.sl = G.els.scroll.scrollLeft;
    G.st = G.els.scroll.scrollTop;
  }

  function localPoint(e, el = G.els.scroll) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Tah i mimo prvek dál posílá události sem (ochrana pro syntetické/neplatné ukazatele). */
  function capture(el, e) {
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* nevadí */ }
  }

  // ---------------------------------------------------------------------------
  // Výběr
  // ---------------------------------------------------------------------------

  const selection = () => State.ui.selection;
  const isSelected = (n) => selection().has(n.id);

  function setSelection(ids) {
    State.ui.selection = new Set(ids);
    G.dirty = true;
    MB.emit('selection');
  }
  const selectOnly = (n) => setSelection([n.id]);
  const clearSelection = () => setSelection([]);

  function toggleSelect(n) {
    const s = new Set(selection());
    if (s.has(n.id)) s.delete(n.id);
    else s.add(n.id);
    setSelection(s);
  }

  function selectedNotes() {
    const s = selection();
    return track().notes.filter((n) => s.has(n.id));
  }

  /** Vyhodí z výběru noty, které už neexistují (po smazání, undo…). */
  function pruneSelection() {
    const s = selection();
    if (!s.size) return;
    const ids = new Set(track().notes.map((n) => n.id));
    const kept = [...s].filter((id) => ids.has(id));
    if (kept.length !== s.size) setSelection(kept);
  }

  // ---------------------------------------------------------------------------
  // Pomocné funkce editace
  // ---------------------------------------------------------------------------

  /** Krátké přehrání tónu aktuální stopy (při vkládání / přesunu noty). */
  function preview(pitch, dur = 0.3) {
    MB.Engine.preview(track(), pitch, isDrums() ? 0.5 : dur);
  }

  function newNoteLength(p) {
    const stepT = MB.stepTicks(p);
    if (isDrums()) return stepT;
    return Math.max(stepT, Math.round(G.lastLength / stepT) * stepT);
  }

  /** Buňka mřížky pod bodem: začátek přichycený na krok, výška (případně přichycená ke stupnici). */
  function cellAt(x, y) {
    const p = State.project;
    const row = yRow(y);
    if (row < 0 || row >= rowCount()) return null;
    let pitch = rowToPitch(row);
    if (!isDrums() && MB.snapActive(p)) {
      pitch = MB.snapToScale(pitch, p.scale);
      if (pitch < MIN_PITCH || pitch > MAX_PITCH) return null;
    }
    const stepT = MB.stepTicks(p);
    const start = Math.floor(xTick(x) / stepT) * stepT;
    if (start < 0 || start >= MB.songTicks(p)) return null;
    return { pitch, start };
  }

  /** Která nota (a která její část) je pod bodem. */
  function hitTest(x, y, touch = false) {
    const row = yRow(y);
    const notes = track().notes;
    let best = null;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (pitchToRow(n.pitch) !== row) continue;
      const x1 = tickX(n.start);
      const x2 = tickX(n.start + n.length);
      if (x < x1 || x > x2 + 3) continue; // 3 px za koncem ještě chytá změnu délky
      const edge = touch ? 14 : clamp((x2 - x1) * 0.3, 4, 9);
      const zone = x >= x2 - edge ? 'resize' : 'body';
      const inside = x <= x2;
      // přednost má zásah dovnitř noty, pak vybraná nota, pak ta nakreslená navrchu
      const better = !best || (inside && !best.inside) ||
        (inside === best.inside && isSelected(n) && !isSelected(best.note));
      if (better) best = { note: n, zone, inside };
    }
    return best;
  }

  function removeNotes(ids) {
    const t = track();
    const del = new Set(ids);
    t.notes = t.notes.filter((n) => !del.has(n.id));
    if ([...del].some((id) => selection().has(id))) {
      setSelection([...selection()].filter((id) => !del.has(id)));
    }
  }

  /** Posune pohled tak, aby byly noty vidět (po posunu šipkami). */
  function ensureVisible(notes) {
    if (!notes.length) return;
    syncScroll();
    const rh = rowH();
    const ys = notes.map((n) => rowY(pitchToRow(n.pitch)));
    const top = Math.min(...ys);
    const bottom = Math.max(...ys) + rh;
    if (top < 0) G.els.scroll.scrollTop += top - rh;
    else if (bottom > G.viewH) G.els.scroll.scrollTop += bottom - G.viewH + rh;
  }

  // ---------------------------------------------------------------------------
  // Tažení – start / průběh / konec
  // ---------------------------------------------------------------------------

  function startMove(e, pt, grabbed, copyOnMove, wasSelected) {
    State.beginGesture();
    const notes = selectedNotes();
    const pitches = notes.map((n) => pitchToRow(n.pitch));
    const starts = notes.map((n) => n.start);
    G.drag = {
      type: 'move',
      pointerId: e.pointerId,
      cx: pt.x + G.sl,
      cy: pt.y + G.st,
      grabbed,
      notes,
      orig: new Map(notes.map((n) => [n.id, { start: n.start, pitch: n.pitch }])),
      minRow: Math.min(...pitches),
      maxRow: Math.max(...pitches),
      minStart: Math.min(...starts),
      maxStart: Math.max(...starts),
      copy: copyOnMove,
      wasSelected,
      moved: false,
      lastPitch: grabbed.pitch,
    };
    if (!isDrums()) G.lastLength = grabbed.length; // další nová nota dostane stejnou délku
    preview(grabbed.pitch);
  }

  function updateMove(pt, e) {
    const d = G.drag;
    const p = State.project;
    const cx = pt.x + G.sl;
    const cy = pt.y + G.st;
    if (!d.moved && Math.hypot(cx - d.cx, cy - d.cy) < 4) return;

    // Ctrl + tah = kopie: originály zůstanou, táhneme nové kopie
    if (d.copy && !d.moved) {
      const t = track();
      const copies = d.notes.map((n) => ({ ...n, id: MB.uid() }));
      t.notes.push(...copies);
      const map = new Map(d.notes.map((n, i) => [n.id, copies[i]]));
      d.orig = new Map(copies.map((c, i) => [c.id, d.orig.get(d.notes[i].id)]));
      d.grabbed = map.get(d.grabbed.id);
      d.notes = copies;
      setSelection(copies.map((c) => c.id));
    }
    d.moved = true;

    // Čas: začátek uchopené noty přichytíme na mřížku, ostatní se posunou stejně.
    const og = d.orig.get(d.grabbed.id);
    const snap = e.altKey ? 1 : MB.stepTicks(p);
    const wanted = Math.round((og.start + ((cx - d.cx) * PPQ) / G.beatW) / snap) * snap;
    const songEnd = MB.songTicks(p);
    const dt = clamp(wanted - og.start, -d.minStart, Math.max(0, songEnd - MB.stepTicks(p) - d.maxStart));

    // Výška: o kolik řádků se uchopená nota posunula (se stupnicí po stupních stupnice).
    const rows = rowCount();
    const rowNow = rows - 1 - Math.floor(cy / rowH());
    let mapPitch;
    if (isDrums()) {
      const dr = clamp(rowNow - og.pitch, -d.minRow, rows - 1 - d.maxRow);
      mapPitch = (q) => q + dr;
    } else if (MB.snapActive(p)) {
      const target = MB.snapToScale(clamp(rowToPitch(rowNow), MIN_PITCH, MAX_PITCH), p.scale);
      let deg = MB.scaleIndex(target, p.scale) - MB.scaleIndex(MB.snapToScale(og.pitch, p.scale), p.scale);
      const origs = [...d.orig.values()];
      const fits = (k) => origs.every((o) => {
        const q = MB.transposeInScale(o.pitch, k, p.scale);
        return q >= MIN_PITCH && q <= MAX_PITCH;
      });
      while (deg !== 0 && !fits(deg)) deg -= Math.sign(deg);
      mapPitch = (q) => MB.transposeInScale(q, deg, p.scale);
    } else {
      const dp = clamp(rowToPitch(rowNow) - og.pitch, MIN_PITCH - (d.minRow + MIN_PITCH), MAX_PITCH - (d.maxRow + MIN_PITCH));
      mapPitch = (q) => q + dp;
    }

    for (const n of d.notes) {
      const o = d.orig.get(n.id);
      n.start = o.start + dt;
      n.pitch = mapPitch(o.pitch);
    }
    if (d.grabbed.pitch !== d.lastPitch) {
      d.lastPitch = d.grabbed.pitch;
      preview(d.grabbed.pitch, 0.25);
    }
    State.changed('notes');
  }

  function startResize(e, pt, grabbed) {
    State.beginGesture();
    const notes = selectedNotes();
    G.drag = {
      type: 'resize',
      pointerId: e.pointerId,
      cx: pt.x + G.sl,
      grabbed,
      notes,
      orig: new Map(notes.map((n) => [n.id, n.length])),
    };
  }

  function updateResize(pt, e) {
    const d = G.drag;
    const p = State.project;
    const snap = e.altKey ? 1 : MB.stepTicks(p);
    const origEnd = d.grabbed.start + d.orig.get(d.grabbed.id);
    const wantedEnd = Math.round((origEnd + ((pt.x + G.sl - d.cx) * PPQ) / G.beatW) / snap) * snap;
    const dl = wantedEnd - origEnd;
    const songEnd = MB.songTicks(p);
    for (const n of d.notes) {
      n.length = Math.max(snap, Math.min(d.orig.get(n.id) + dl, Math.max(snap, songEnd - n.start)));
    }
    G.lastLength = d.grabbed.length;
    State.changed('notes');
  }

  function createNoteAt(e, pt) {
    const p = State.project;
    const cell = cellAt(pt.x, pt.y);
    if (!cell) return false;
    State.beginGesture();
    const len = Math.min(newNoteLength(p), MB.songTicks(p) - cell.start);
    const n = MB.createNote(cell.pitch, cell.start, len, 0.8);
    track().notes.push(n);
    selectOnly(n);
    G.drag = { type: 'create', pointerId: e.pointerId, note: n, x0: pt.x };
    preview(n.pitch);
    State.changed('notes');
    return true;
  }

  function updateCreate(pt, e) {
    const d = G.drag;
    if (isDrums() || Math.abs(pt.x - d.x0) < 4) return;
    const p = State.project;
    const snap = e.altKey ? 1 : MB.stepTicks(p);
    const n = d.note;
    // nota se natáhne tak, aby pokryla buňku pod kurzorem
    const len = Math.max(snap, Math.ceil((xTick(pt.x) - n.start) / snap) * snap);
    n.length = Math.min(len, MB.songTicks(p) - n.start);
    G.lastLength = n.length;
    State.changed('notes');
  }

  function startRubber(e, pt, additive) {
    const cx = pt.x + G.sl;
    const cy = pt.y + G.st;
    G.drag = {
      type: 'rubber',
      pointerId: e.pointerId,
      x0: cx, y0: cy, x1: cx, y1: cy,
      base: additive ? new Set(selection()) : new Set(),
    };
    if (!additive) clearSelection();
  }

  function updateRubber(pt) {
    const d = G.drag;
    d.x1 = pt.x + G.sl;
    d.y1 = pt.y + G.st;
    const tA = (Math.min(d.x0, d.x1) * PPQ) / G.beatW;
    const tB = (Math.max(d.x0, d.x1) * PPQ) / G.beatW;
    const yA = Math.min(d.y0, d.y1);
    const yB = Math.max(d.y0, d.y1);
    const rows = rowCount();
    const rh = rowH();
    const ids = new Set(d.base);
    for (const n of track().notes) {
      const top = (rows - 1 - pitchToRow(n.pitch)) * rh;
      if (n.start < tB && n.start + n.length > tA && top < yB && top + rh > yA) ids.add(n.id);
    }
    setSelection(ids);
  }

  function startErase(e, pt) {
    State.beginGesture();
    G.drag = { type: 'erase', pointerId: e.pointerId, last: pt };
    eraseAt(pt);
  }

  function eraseAt(pt) {
    const hit = hitTest(pt.x, pt.y);
    if (hit) {
      removeNotes([hit.note.id]);
      State.changed('notes');
    }
  }

  function updateErase(pt) {
    // projdeme úsečku po malých krocích, ať se při rychlém tahu nic nevynechá
    const d = G.drag;
    const dx = pt.x - d.last.x;
    const dy = pt.y - d.last.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 4));
    for (let i = 1; i <= steps; i++) eraseAt({ x: d.last.x + (dx * i) / steps, y: d.last.y + (dy * i) / steps });
    d.last = pt;
  }

  function startPan(e, pt) {
    G.drag = { type: 'pan', pointerId: e.pointerId, x: pt.x, y: pt.y, sl: G.sl, st: G.st };
    G.els.scroll.style.cursor = 'grabbing';
  }

  function updatePan(pt) {
    const d = G.drag;
    G.els.scroll.scrollLeft = d.sl - (pt.x - d.x);
    G.els.scroll.scrollTop = d.st - (pt.y - d.y);
  }

  function startPinch() {
    const [a, b] = [...G.touches.values()];
    const cx = (a.x + b.x) / 2;
    G.drag = {
      type: 'pinch',
      d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
      cy0: (a.y + b.y) / 2,
      st0: G.st,
      beatW0: G.beatW,
      tick0: xTick(cx),
    };
  }

  function updatePinch() {
    const [a, b] = [...G.touches.values()];
    if (!a || !b) return;
    const d = G.drag;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    G.beatW = clamp(d.beatW0 * (Math.hypot(a.x - b.x, a.y - b.y) / d.d0), BEAT_W_MIN, BEAT_W_MAX);
    updateSpacer();
    G.els.scroll.scrollLeft = (d.tick0 * G.beatW) / PPQ - cx;
    G.els.scroll.scrollTop = d.st0 - (cy - d.cy0);
    G.dirty = true;
  }

  /** Zruší tažení a vrátí změny (když během něj přibude druhý prst). */
  function cancelDrag() {
    const d = G.drag;
    if (!d) return;
    if (d.type === 'move' || d.type === 'resize') {
      for (const n of d.notes) {
        const o = d.orig.get(n.id);
        if (d.type === 'move') Object.assign(n, o);
        else n.length = o;
      }
      if (d.copy && d.moved) removeNotes(d.notes.map((n) => n.id));
    } else if (d.type === 'create') {
      removeNotes([d.note.id]);
    }
    G.drag = null;
    cancelAnimationFrame(G.autoRAF);
    State.endGesture();
  }

  function finishDrag(e) {
    const d = G.drag;
    G.drag = null;
    cancelAnimationFrame(G.autoRAF);
    switch (d.type) {
      case 'move':
        if (!d.moved) {
          // klik bez tažení: Ctrl+klik na vybranou notu ji odebere z výběru,
          // obyčejný klik na notu z většího výběru vybere jen ji
          if (d.copy && d.wasSelected) toggleSelect(d.grabbed);
          else if (!d.copy && d.wasSelected && selection().size > 1) selectOnly(d.grabbed);
        }
        State.endGesture();
        break;
      case 'resize':
      case 'create':
      case 'erase':
        State.endGesture();
        break;
      case 'touchPending': // ťuknutí prstem do prázdna = nová nota
        if (createNoteAt(e, { x: d.x0, y: d.y0 })) {
          G.drag = null;
          State.endGesture();
        }
        break;
      default:
        break;
    }
    G.dirty = true;
  }

  /** Když táhneš k okraji, mřížka se sama posouvá. */
  function autoScrollStep() {
    G.autoRAF = 0;
    const d = G.drag;
    if (!d || !['move', 'resize', 'create', 'rubber'].includes(d.type) || !G.lastPt) return;
    const { x, y } = G.lastPt;
    const m = 24;
    let dx = 0;
    let dy = 0;
    if (x < m) dx = x - m;
    else if (x > G.viewW - m) dx = x - (G.viewW - m);
    if (y < m) dy = y - m;
    else if (y > G.viewH - m) dy = y - (G.viewH - m);
    if (!dx && !dy) return;
    G.els.scroll.scrollLeft += clamp(dx, -40, 40) * 0.6;
    G.els.scroll.scrollTop += clamp(dy, -40, 40) * 0.6;
    syncScroll();
    applyDrag(G.lastPt, G.lastEvt);
    G.autoRAF = requestAnimationFrame(autoScrollStep);
  }

  function applyDrag(pt, e) {
    switch (G.drag.type) {
      case 'move': updateMove(pt, e); break;
      case 'resize': updateResize(pt, e); break;
      case 'create': updateCreate(pt, e); break;
      case 'rubber': updateRubber(pt); break;
      case 'erase': updateErase(pt); break;
      case 'pan': updatePan(pt); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------------------
  // Pointer Events – mřížka
  // ---------------------------------------------------------------------------

  function onDown(e) {
    syncScroll();
    const pt = localPoint(e);
    if (pt.x >= G.viewW || pt.y >= G.viewH) return; // klik na posuvník – necháme prohlížeči
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    e.preventDefault();

    const touch = e.pointerType === 'touch';
    if (touch) {
      G.touches.set(e.pointerId, pt);
      if (G.touches.size === 2) {
        cancelDrag();
        startPinch();
        return;
      }
      if (G.touches.size > 2) return;
    }
    // nový stisk stejného ukazatele = předchozí puštění se ztratilo → staré tažení dokončit
    if (G.drag && G.drag.pointerId === e.pointerId) finishDrag(e);
    if (G.drag) return;

    capture(G.els.scroll, e);
    G.mouse = touch ? null : pt;
    G.lastPt = pt;
    G.lastEvt = e;
    const tool = State.ui.tool;
    const mod = e.ctrlKey || e.metaKey;

    if (e.button === 1) return startPan(e, pt);
    if (e.button === 2 || (e.button === 0 && tool === 'erase')) return startErase(e, pt);
    if (e.button !== 0) return;

    const hit = hitTest(pt.x, pt.y, touch);
    if (hit) {
      const n = hit.note;
      if (e.shiftKey) { // Shift+klik = přidat / odebrat z výběru
        toggleSelect(n);
        G.drag = { type: 'none', pointerId: e.pointerId };
        return;
      }
      const wasSelected = isSelected(n);
      if (!wasSelected) {
        if (mod) setSelection([...selection(), n.id]);
        else selectOnly(n);
      }
      if (hit.zone === 'resize' && !mod) startResize(e, pt, n);
      else startMove(e, pt, n, mod, wasSelected);
      return;
    }

    // prázdné místo
    if (tool === 'select' || e.shiftKey || mod) return startRubber(e, pt, e.shiftKey || mod);
    if (touch) { // prstem: ťuk = nota, tah = posun plátna
      G.drag = { type: 'touchPending', pointerId: e.pointerId, x0: pt.x, y0: pt.y, sl: G.sl, st: G.st };
      return;
    }
    createNoteAt(e, pt);
  }

  function onMove(e) {
    syncScroll();
    const pt = localPoint(e);
    if (e.pointerType === 'touch' && G.touches.has(e.pointerId)) G.touches.set(e.pointerId, pt);
    const d = G.drag;
    if (d && d.type === 'pinch') {
      updatePinch();
      return;
    }
    if (!d || d.pointerId !== e.pointerId) {
      if (!d && e.pointerType !== 'touch') {
        G.mouse = pt;
        updateCursor(pt);
        G.dirty = true;
      }
      return;
    }
    G.mouse = e.pointerType === 'touch' ? null : pt;
    G.lastPt = pt;
    G.lastEvt = e;
    if (d.type === 'touchPending') {
      if (Math.hypot(pt.x - d.x0, pt.y - d.y0) > 8) {
        G.drag = { type: 'pan', pointerId: d.pointerId, x: d.x0, y: d.y0, sl: d.sl, st: d.st };
        updatePan(pt);
      }
      return;
    }
    applyDrag(pt, e);
    if (!G.autoRAF) G.autoRAF = requestAnimationFrame(autoScrollStep);
    G.dirty = true;
  }

  function onUp(e) {
    if (e.pointerType === 'touch') G.touches.delete(e.pointerId);
    const d = G.drag;
    if (!d) return;
    if (d.type === 'pinch') {
      if (G.touches.size === 0) G.drag = null;
      return;
    }
    if (d.pointerId !== e.pointerId) return;
    syncScroll();
    finishDrag(e);
    if (e.pointerType !== 'touch') updateCursor(localPoint(e));
  }

  function onLeave() {
    if (!G.drag) {
      G.mouse = null;
      G.dirty = true;
    }
  }

  function onDblClick(e) {
    // v režimu Výběr vloží dvojklik do prázdna novou notu
    if (State.ui.tool !== 'select') return;
    syncScroll();
    const pt = localPoint(e);
    if (hitTest(pt.x, pt.y)) return;
    if (createNoteAt(e, pt)) {
      G.drag = null;
      State.endGesture();
    }
  }

  function onWheel(e) {
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    if (e.ctrlKey || e.metaKey) { // Ctrl + kolečko (i pinch na touchpadu) = vodorovný zoom
      e.preventDefault();
      syncScroll();
      zoomX(Math.exp(-dy * 0.0025), localPoint(e).x);
    } else if (e.altKey) { // Alt + kolečko = svislý zoom
      e.preventDefault();
      syncScroll();
      zoomY(Math.exp(-dy * 0.002), localPoint(e).y);
    }
    // jinak nativní posun (Shift + kolečko = vodorovně)
  }

  function updateCursor(pt) {
    const tool = State.ui.tool;
    let cur;
    if (tool === 'erase') cur = CURSOR_ERASE;
    else {
      const hit = pt && pt.x < G.viewW && pt.y < G.viewH ? hitTest(pt.x, pt.y) : null;
      if (hit) cur = hit.zone === 'resize' ? 'ew-resize' : 'move';
      else cur = tool === 'select' ? 'default' : CURSOR_DRAW;
    }
    if (G.els.scroll.style.cursor !== cur) G.els.scroll.style.cursor = cur;
  }

  // ---------------------------------------------------------------------------
  // Klaviatura vlevo – kliknutí zahraje tón (držením zní, tažením glissando)
  // ---------------------------------------------------------------------------

  function keysRow(e) {
    syncScroll();
    return yRow(localPoint(e, G.els.keys).y);
  }

  function pressKey(row) {
    releaseKey();
    if (row < 0 || row >= rowCount()) return;
    const voice = MB.Engine.preview(track(), rowToPitch(row), isDrums() ? 0.5 : 6);
    G.keysDown = { row, voice };
    G.dirty = true;
  }

  function releaseKey() {
    if (!G.keysDown) return;
    if (G.keysDown.voice && !isDrums()) G.keysDown.voice.cut();
    G.keysDown = null;
    G.dirty = true;
  }

  function onKeysDown(e) {
    e.preventDefault();
    capture(G.els.keys, e);
    pressKey(keysRow(e));
  }

  function onKeysMove(e) {
    const row = keysRow(e);
    if (G.keysDown && row !== G.keysDown.row) pressKey(row);
    if (row !== G.keysHover) {
      G.keysHover = row;
      G.dirty = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Pravítko – klik = skok přehrávání, tažení = oblast smyčky, dvojklik = celá skladba
  // ---------------------------------------------------------------------------

  function rulerTick(e) {
    syncScroll();
    return xTick(localPoint(e, G.els.ruler).x);
  }

  function onRulerDown(e) {
    e.preventDefault();
    capture(G.els.ruler, e);
    G.rulerDrag = { tick0: rulerTick(e), x0: e.clientX, moved: false };
  }

  function onRulerMove(e) {
    const rd = G.rulerDrag;
    if (!rd) return;
    if (!rd.moved && Math.abs(e.clientX - rd.x0) < 5) return;
    if (!rd.moved) State.beginGesture();
    rd.moved = true;
    const p = State.project;
    const songEnd = MB.songTicks(p);
    const snap = PPQ; // smyčka se přichytává na doby
    let a = clamp(Math.round(rd.tick0 / snap) * snap, 0, songEnd);
    let b = clamp(Math.round(rulerTick(e) / snap) * snap, 0, songEnd);
    if (a > b) [a, b] = [b, a];
    if (b - a >= snap) {
      p.loopStart = a;
      p.loopEnd = b;
      p.loop = true;
      State.changed('project');
    }
  }

  function onRulerUp(e) {
    const rd = G.rulerDrag;
    G.rulerDrag = null;
    if (!rd) return;
    if (rd.moved) {
      State.endGesture('project');
      return;
    }
    const stepT = MB.stepTicks(State.project);
    MB.Transport.seek(Math.max(0, Math.floor(rulerTick(e) / stepT) * stepT));
  }

  function resetLoop() {
    State.change((p) => {
      p.loopStart = 0;
      p.loopEnd = null;
    }, 'project');
  }

  // ---------------------------------------------------------------------------
  // Rozložení a zoom
  // ---------------------------------------------------------------------------

  function sizeCanvas(canvas, w, h) {
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const W = Math.max(1, Math.round(w * G.dpr));
    const H = Math.max(1, Math.round(h * G.dpr));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
  }

  function updateSpacer() {
    const p = State.project;
    G.els.spacer.style.width = `${Math.ceil((MB.songTicks(p) * G.beatW) / PPQ)}px`;
    G.els.spacer.style.height = `${rowCount() * rowH()}px`;
  }

  function layout() {
    const { scroll, canvas, ruler, keys, editor } = G.els;
    G.kind = kindOf(track());
    const kw = isDrums() ? DRUM_KEYS_W : KEYS_W;
    editor.style.setProperty('--keys-w', `${kw}px`);
    G.dpr = window.devicePixelRatio || 1;
    G.viewW = scroll.clientWidth;
    G.viewH = scroll.clientHeight;
    updateSpacer();
    sizeCanvas(canvas, G.viewW, G.viewH);
    sizeCanvas(ruler, G.viewW, RULER_H);
    sizeCanvas(keys, kw, G.viewH);
    syncScroll();
    render(); // změna velikosti canvas vymaže – překreslíme hned, ať nic nebliká
  }

  function zoomX(factor, anchorX = G.viewW / 2) {
    syncScroll();
    const tick = xTick(anchorX);
    const beatW = clamp(G.beatW * factor, BEAT_W_MIN, BEAT_W_MAX);
    if (beatW === G.beatW) return;
    G.beatW = beatW;
    updateSpacer();
    G.els.scroll.scrollLeft = (tick * G.beatW) / PPQ - anchorX;
    syncScroll();
    G.dirty = true;
    MB.emit('zoom');
  }

  function zoomY(factor, anchorY = G.viewH / 2) {
    syncScroll();
    const rows = rowCount();
    const pos = (anchorY + G.st) / (rows * rowH()); // poměrná poloha kotvy
    let h = clamp(Math.round(G.rowHeight * factor), ROW_H_MIN, ROW_H_MAX);
    if (h === G.rowHeight && factor !== 1) h = clamp(G.rowHeight + (factor > 1 ? 1 : -1), ROW_H_MIN, ROW_H_MAX);
    if (h === G.rowHeight) return;
    G.rowHeight = h;
    updateSpacer();
    G.els.scroll.scrollTop = pos * rows * rowH() - anchorY;
    syncScroll();
    G.dirty = true;
    MB.emit('zoom');
  }

  /** Vodorovný zoom tak, aby byla vidět celá skladba (ale ne moc natěsno). */
  function fitToSong() {
    const p = State.project;
    G.beatW = clamp(Math.floor((G.viewW - 16) / (p.bars * p.beatsPerBar)), 40, 80);
    updateSpacer();
    G.els.scroll.scrollLeft = 0;
    syncScroll();
    G.dirty = true;
    MB.emit('zoom');
  }

  /** Svisle vycentruje pohled na noty aktuální stopy (nebo typický rozsah nástroje). */
  function centerOnTrack() {
    const t = track();
    const rows = rowCount();
    const rh = rowH();
    let centerRow;
    if (isDrums()) {
      centerRow = (rows - 1) / 2;
    } else {
      const ps = t.notes.map((n) => n.pitch);
      const center = ps.length
        ? (Math.min(...ps) + Math.max(...ps)) / 2
        : MB.getInstrument(t.instrument).center || 60;
      centerRow = center - MIN_PITCH;
    }
    G.els.scroll.scrollTop = Math.max(0, (rows - 1 - centerRow) * rh + rh / 2 - G.viewH / 2);
    syncScroll();
    G.dirty = true;
  }

  /** Po přepnutí stopy: zapamatuje si svislou polohu staré a obnoví / vycentruje novou. */
  function onTrackSwitch(prevId) {
    if (prevId) G.scrollMemory.set(prevId, G.els.scroll.scrollTop);
    releaseKey();
    clearSelection();
    layout();
    const remembered = G.scrollMemory.get(track().id);
    if (remembered != null) {
      G.els.scroll.scrollTop = remembered;
      syncScroll();
    } else {
      centerOnTrack();
    }
  }

  function onProjectChange() {
    if (kindOf(track()) !== G.kind) { // nástroj stopy se změnil z melodického na bicí nebo naopak
      layout();
      centerOnTrack();
    } else {
      updateSpacer();
    }
    pruneSelection();
    G.dirty = true;
  }

  // ---------------------------------------------------------------------------
  // Vykreslování
  // ---------------------------------------------------------------------------

  function followPlayhead() {
    if (!State.ui.follow || !MB.Transport.playing || G.drag) return;
    const x = (G.playTick * G.beatW) / PPQ - G.sl;
    if (x > G.viewW * 0.92 || x < 0) {
      G.els.scroll.scrollLeft = Math.max(0, (G.playTick * G.beatW) / PPQ - G.viewW * 0.08);
      syncScroll();
    }
  }

  function render() {
    const p = State.project;
    if (!p || !G.viewW || !G.viewH) return;
    syncScroll();
    G.playTick = MB.Transport.currentTick();
    followPlayhead();
    renderGrid(p);
    renderRuler(p);
    renderKeys(p);
    G.dirty = false;
  }

  /** Úzká čára zarovnaná na fyzické pixely (ostrá i na HiDPI displejích). */
  function vline(c, x, h, color, px = 1) {
    const d = G.dpr;
    c.fillStyle = color;
    c.fillRect(Math.round(x * d) / d, 0, px / d, h);
  }

  function hline(c, y, w, color, px = 1) {
    const d = G.dpr;
    c.fillStyle = color;
    c.fillRect(0, Math.round(y * d) / d - px / d, w, px / d);
  }

  function renderGrid(p) {
    const c = G.gctx;
    const W = G.viewW;
    const H = G.viewH;
    const t = track();
    const rows = rowCount();
    const rh = rowH();
    const drums = isDrums();
    const useScale = !drums && MB.scaleActive(p);
    c.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    c.fillStyle = COL.bg;
    c.fillRect(0, 0, W, H);

    // 1) řádky: bílé/černé klávesy, tóny mimo stupnici tmavší, základní tón zvýrazněný
    const i0 = Math.max(0, Math.floor(G.st / rh));
    const i1 = Math.min(rows - 1, Math.floor((G.st + H) / rh));
    for (let i = i0; i <= i1; i++) {
      const row = rows - 1 - i;
      const y = i * rh - G.st;
      if (drums) {
        c.fillStyle = row % 2 ? COL.drumA : COL.drumB;
      } else {
        const pitch = row + MIN_PITCH;
        const black = MB.isBlackKey(pitch);
        const out = useScale && !MB.inScale(pitch, p.scale);
        c.fillStyle = out ? (black ? COL.rowOutBlack : COL.rowOut) : black ? COL.rowBlack : COL.rowWhite;
      }
      c.fillRect(0, y, W, rh);
      if (useScale && MB.isRoot(row + MIN_PITCH, p.scale)) {
        c.fillStyle = COL.rowRoot;
        c.fillRect(0, y, W, rh);
      }
    }

    // řádek pod myší / pod drženou klávesou
    const hoverRow = G.keysDown ? G.keysDown.row : G.mouse ? yRow(G.mouse.y) : G.keysHover;
    if (hoverRow >= 0 && hoverRow < rows) {
      c.fillStyle = COL.rowHover;
      c.fillRect(0, rowY(hoverRow), W, rh);
    }

    // 2) každý druhý takt o chlup světlejší
    const barT = MB.barTicks(p);
    const stepT = MB.stepTicks(p);
    const songEnd = MB.songTicks(p);
    const tA = Math.max(0, xTick(0));
    const tB = Math.min(songEnd, xTick(W));
    c.fillStyle = COL.barShade;
    for (let b = Math.floor(tA / barT); b * barT < tB; b++) {
      if (b % 2 === 1) {
        const x1 = tickX(b * barT);
        c.fillRect(x1, 0, tickX(Math.min((b + 1) * barT, songEnd)) - x1, H);
      }
    }

    // 3) vodorovné čáry mezi řádky, výraznější mezi oktávami (pod každým C)
    for (let i = i0; i <= i1; i++) {
      const row = rows - 1 - i;
      const yb = (i + 1) * rh - G.st;
      const octave = !drums && (row + MIN_PITCH) % 12 === 0;
      hline(c, yb, W, octave ? COL.lineOctave : COL.lineRow);
    }

    // 4) svislé čáry: kroky (slabé), doby, takty (silné)
    const stepPx = (stepT * G.beatW) / PPQ;
    const inc = stepPx >= 6 ? stepT : G.beatW >= 6 ? PPQ : barT;
    for (let tk = Math.floor(tA / inc) * inc; tk <= tB; tk += inc) {
      const x = tickX(tk);
      if (tk % barT === 0) vline(c, x, H, COL.lineBar, 2);
      else if (tk % PPQ === 0) vline(c, x, H, COL.lineBeat);
      else vline(c, x, H, COL.lineStep);
    }

    // 5) za koncem skladby ztmavit
    const xe = tickX(songEnd);
    if (xe < W) {
      c.fillStyle = COL.afterEnd;
      c.fillRect(Math.max(0, xe), 0, W - Math.max(0, xe), H);
    }

    // 6) „duchové“ – noty ostatních stop stejného druhu
    if (State.ui.ghosts) {
      for (const other of p.tracks) {
        if (other === t || kindOf(other) !== G.kind) continue;
        c.fillStyle = rgba(other.color, other.mute ? 0.08 : 0.2);
        for (const n of other.notes) {
          const box = noteBox(n);
          if (!box) continue;
          c.beginPath();
          roundRect(c, box.x, box.y, box.w, box.h, box.r);
          c.fill();
        }
      }
    }

    // 7) noty aktuální stopy (vybrané nakonec, ať jsou navrchu)
    const sel = selection();
    const playTick = MB.Transport.playing ? G.playTick : -1;
    c.font = `600 ${Math.max(8, Math.min(11, rh - 6))}px ${FONT}`;
    c.textBaseline = 'middle';
    for (const pass of [false, true]) {
      for (const n of t.notes) {
        if (sel.has(n.id) !== pass) continue;
        drawNote(c, n, t.color, pass, playTick >= n.start && playTick < n.start + n.length);
      }
    }

    // 8) náhled noty pod kurzorem (jen kreslicí nástroj)
    if (!G.drag && G.mouse && State.ui.tool === 'draw' && !hitTest(G.mouse.x, G.mouse.y)) {
      const cell = cellAt(G.mouse.x, G.mouse.y);
      if (cell) {
        const len = newNoteLength(p);
        const x = tickX(cell.start);
        const y = rowY(pitchToRow(cell.pitch));
        c.beginPath();
        roundRect(c, x + 0.5, y + 1, Math.max(3, (len * G.beatW) / PPQ - 1), rh - 2, Math.min(4, rh / 3));
        c.fillStyle = rgba(t.color, 0.18);
        c.fill();
        c.setLineDash([3, 3]);
        c.strokeStyle = rgba(t.color, 0.7);
        c.lineWidth = 1;
        c.stroke();
        c.setLineDash([]);
      }
    }

    // 9) výběrový obdélník
    const d = G.drag;
    if (d && d.type === 'rubber') {
      const x = Math.min(d.x0, d.x1) - G.sl;
      const y = Math.min(d.y0, d.y1) - G.st;
      const w = Math.abs(d.x1 - d.x0);
      const h = Math.abs(d.y1 - d.y0);
      c.fillStyle = 'rgba(124, 92, 255, 0.15)';
      c.fillRect(x, y, w, h);
      c.strokeStyle = COL.accent;
      c.lineWidth = 1;
      c.strokeRect(x + 0.5, y + 0.5, w, h);
    }

    // 10) přehrávací kurzor
    const px = tickX(G.playTick);
    if (px >= -2 && px <= W + 2) {
      c.fillStyle = 'rgba(34, 211, 238, 0.18)';
      c.fillRect(px - 3, 0, 6, H);
      vline(c, px - 0.5, H, COL.playhead, Math.max(2, Math.round(G.dpr * 1.5)));
    }
  }

  /** Obdélník noty ve view souřadnicích (null = mimo obraz). */
  function noteBox(n) {
    const row = pitchToRow(n.pitch);
    if (row < 0 || row >= rowCount()) return null;
    const x = tickX(n.start);
    const w = (n.length * G.beatW) / PPQ;
    if (x > G.viewW || x + w < 0) return null;
    const rh = rowH();
    const y = rowY(row);
    if (y > G.viewH || y + rh < 0) return null;
    const bw = Math.max(3, w - 1);
    const bh = rh - 2;
    return { x: x + 0.5, y: y + 1, w: bw, h: bh, r: Math.min(4, bh / 3, bw / 2) };
  }

  function drawNote(c, n, color, selected, active) {
    const b = noteBox(n);
    if (!b) return;
    c.beginPath();
    roundRect(c, b.x, b.y, b.w, b.h, b.r);
    c.fillStyle = active ? lighten(color, 0.5) : color;
    c.globalAlpha = 0.55 + 0.45 * clamp(n.velocity, 0, 1); // síla úhozu = sytost
    c.fill();
    c.globalAlpha = 1;
    c.lineWidth = selected ? 2 : 1;
    c.strokeStyle = selected ? '#ffffff' : 'rgba(0, 0, 0, 0.55)';
    c.stroke();
    if (b.w > 16 && b.h > 8) { // úchyt pro změnu délky
      c.fillStyle = 'rgba(0, 0, 0, 0.3)';
      c.fillRect(b.x + b.w - 5, b.y + 3, 2, b.h - 6);
    }
    if (!isDrums() && b.w > 30 && b.h >= 12) {
      c.fillStyle = 'rgba(8, 10, 14, 0.85)';
      c.fillText(MB.noteName(n.pitch), b.x + 5, b.y + b.h / 2 + 0.5);
    }
  }

  function renderRuler(p) {
    const c = G.rctx;
    const W = G.viewW;
    const H = RULER_H;
    c.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    c.fillStyle = '#121620';
    c.fillRect(0, 0, W, H);

    const songEnd = MB.songTicks(p);
    const barT = MB.barTicks(p);

    // oblast smyčky
    const [ls, le] = MB.loopRange(p);
    const lx1 = tickX(ls);
    const lx2 = tickX(le);
    c.fillStyle = p.loop ? 'rgba(124, 92, 255, 0.14)' : 'rgba(139, 147, 167, 0.06)';
    c.fillRect(lx1, 0, lx2 - lx1, H);
    c.fillStyle = p.loop ? COL.accent : '#4a5164';
    c.fillRect(lx1, 0, lx2 - lx1, 4);

    // takty a doby
    const barPx = (barT * G.beatW) / PPQ;
    let labelEvery = 1;
    while (barPx * labelEvery < 30) labelEvery *= 2;
    c.font = `600 11px ${FONT}`;
    c.textBaseline = 'middle';
    const tA = Math.max(0, xTick(0));
    const tB = Math.min(songEnd, xTick(W));
    for (let b = Math.floor(tA / barT); b * barT <= tB; b++) {
      const x = tickX(b * barT);
      vline(c, x, H, 'rgba(255, 255, 255, 0.25)');
      if (b % labelEvery === 0 && b * barT < songEnd) {
        c.fillStyle = '#c9cfdc';
        c.fillText(String(b + 1), x + 5, 17);
      }
      if (G.beatW >= 10) {
        for (let k = 1; k < p.beatsPerBar; k++) {
          const xb = tickX(b * barT + k * PPQ);
          c.fillStyle = 'rgba(255, 255, 255, 0.18)';
          c.fillRect(Math.round(xb), H - 7, 1, 7);
        }
      }
    }

    // konec skladby
    const xe = tickX(songEnd);
    if (xe < W) {
      c.fillStyle = 'rgba(0, 0, 0, 0.45)';
      c.fillRect(Math.max(0, xe), 0, W, H);
    }

    // přehrávací kurzor – trojúhelník
    const px = tickX(G.playTick);
    if (px >= -8 && px <= W + 8) {
      c.fillStyle = COL.playhead;
      c.beginPath();
      c.moveTo(px - 6, H - 11);
      c.lineTo(px + 6, H - 11);
      c.lineTo(px, H - 2);
      c.closePath();
      c.fill();
    }
    hline(c, H, W, '#262c3a');
  }

  function renderKeys(p) {
    const c = G.kctx;
    const W = isDrums() ? DRUM_KEYS_W : KEYS_W;
    const H = G.viewH;
    const rows = rowCount();
    const rh = rowH();
    const t = track();
    c.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    c.fillStyle = '#0f1218';
    c.fillRect(0, 0, W, H);

    // řádky, které právě znějí (přehrávání) nebo jsou držené
    const active = new Set();
    if (MB.Transport.playing) {
      for (const n of t.notes) {
        if (G.playTick >= n.start && G.playTick < n.start + n.length) active.add(pitchToRow(n.pitch));
      }
    }
    if (G.keysDown) active.add(G.keysDown.row);
    const hoverRow = G.mouse ? yRow(G.mouse.y) : G.keysHover;

    const i0 = Math.max(0, Math.floor(G.st / rh));
    const i1 = Math.min(rows - 1, Math.floor((G.st + H) / rh));
    const useScale = !isDrums() && MB.scaleActive(p);

    if (isDrums()) {
      const drumList = drumRows();
      c.font = `500 12px ${FONT}`;
      c.textBaseline = 'middle';
      for (let i = i0; i <= i1; i++) {
        const row = rows - 1 - i;
        const y = i * rh - G.st;
        c.fillStyle = active.has(row) ? rgba(t.color, 0.45) : row === hoverRow ? '#232a38' : row % 2 ? '#181c25' : '#141821';
        c.fillRect(0, y, W, rh);
        c.fillStyle = rgba(t.color, 0.8);
        c.fillRect(0, y + 2, 3, rh - 4);
        c.fillStyle = active.has(row) ? '#ffffff' : '#c9cfdc';
        c.fillText(drumList[row] ? drumList[row].name : '', 10, y + rh / 2 + 0.5);
        hline(c, y + rh, W, 'rgba(0, 0, 0, 0.4)');
      }
    } else {
      const blackW = Math.round(W * 0.62);
      c.font = `600 ${Math.max(8, Math.min(11, rh - 5))}px ${FONT}`;
      c.textBaseline = 'middle';
      c.textAlign = 'right';
      for (let i = i0; i <= i1; i++) {
        const row = rows - 1 - i;
        const pitch = row + MIN_PITCH;
        const y = i * rh - G.st;
        const black = MB.isBlackKey(pitch);
        const out = useScale && !MB.inScale(pitch, p.scale);
        const on = active.has(row);
        // bílý podklad (i pod černou klávesou – pokračují tam sousední bílé klávesy)
        c.fillStyle = out ? '#9aa1ae' : '#dfe3ea';
        if (row === hoverRow) c.fillStyle = '#f4f6fa';
        if (on && !black) c.fillStyle = lighten(t.color, 0.25);
        c.fillRect(0, y, W, rh);
        if (black) {
          c.fillStyle = on ? t.color : row === hoverRow ? '#3a4152' : out ? '#2a2f3a' : '#1b1f28';
          c.fillRect(0, y, blackW, rh);
          // hranice bílých kláves je uprostřed černé
          c.fillStyle = 'rgba(0, 0, 0, 0.25)';
          c.fillRect(blackW, Math.round(y + rh / 2), W - blackW, 1);
        } else {
          const pc = MB.pitchClass(pitch);
          if (pc === 0 || pc === 5) hline(c, y + rh, W, 'rgba(0, 0, 0, 0.35)'); // hranice C|B a F|E
        }
        if (useScale && MB.isRoot(pitch, p.scale)) {
          c.fillStyle = COL.accent;
          c.fillRect(W - 3, y + 1, 3, rh - 2);
        }
        if (MB.pitchClass(pitch) === 0 || row === hoverRow || on) {
          c.fillStyle = black && !on ? '#c9cfdc' : '#3d4352';
          if (rh >= 9) c.fillText(MB.noteName(pitch), W - 6, y + rh / 2 + 0.5);
        }
      }
      c.textAlign = 'left';
    }
    // oddělovač od mřížky
    c.fillStyle = '#262c3a';
    c.fillRect(W - 1, 0, 1, H);
  }

  // ---------------------------------------------------------------------------
  // Veřejné editační příkazy (klávesové zkratky v main.js)
  // ---------------------------------------------------------------------------

  function deleteSelection() {
    const ids = [...selection()];
    if (!ids.length) return false;
    State.change(() => removeNotes(ids));
    return true;
  }

  /** ↑/↓: o půltón (se zapnutým přichytáváním o stupeň stupnice), Shift = oktáva. */
  function transposeSelection(dir, octave) {
    const notes = selectedNotes();
    if (!notes.length) return false;
    const p = State.project;
    let fn;
    if (isDrums()) fn = (q) => q + dir;
    else if (octave) fn = (q) => q + 12 * dir;
    else if (MB.snapActive(p)) fn = (q) => MB.transposeInScale(q, dir, p.scale);
    else fn = (q) => q + dir;
    const [lo, hi] = pitchRange();
    if (!notes.every((n) => { const q = fn(n.pitch); return q >= lo && q <= hi; })) return false;
    State.change(() => notes.forEach((n) => { n.pitch = fn(n.pitch); }));
    const top = notes.reduce((a, n) => (n.pitch > a.pitch ? n : a), notes[0]);
    preview(top.pitch, 0.25);
    ensureVisible(notes);
    return true;
  }

  /** ←/→: o krok mřížky, Shift = o takt. */
  function moveSelectionTime(dir, bar) {
    const notes = selectedNotes();
    if (!notes.length) return false;
    const p = State.project;
    const dt = (bar ? MB.barTicks(p) : MB.stepTicks(p)) * dir;
    const starts = notes.map((n) => n.start);
    if (Math.min(...starts) + dt < 0 || Math.max(...starts) + dt >= MB.songTicks(p)) return false;
    State.change(() => notes.forEach((n) => { n.start += dt; }));
    return true;
  }

  function selectAll() {
    setSelection(track().notes.map((n) => n.id));
  }

  // --- schránka ---------------------------------------------------------------
  // Noty se kopírují s časem relativně k první z nich. Schránka se ukládá i do
  // localStorage, takže jde vkládat i do jiné karty nebo po znovuotevření.

  let clipboard = null;

  function copySelection() {
    const notes = selectedNotes();
    if (!notes.length) return false;
    const t0 = Math.min(...notes.map((n) => n.start));
    clipboard = {
      kind: G.kind,
      notes: notes.map((n) => ({ pitch: n.pitch, start: n.start - t0, length: n.length, velocity: n.velocity })),
    };
    try { localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(clipboard)); } catch (err) { /* nevadí */ }
    return true;
  }

  function cutSelection() {
    return copySelection() && deleteSelection();
  }

  function readClipboard() {
    if (clipboard) return clipboard;
    try {
      const c = JSON.parse(localStorage.getItem(CLIPBOARD_KEY) || 'null');
      if (c && Array.isArray(c.notes)) clipboard = c;
    } catch (err) { /* nic */ }
    return clipboard;
  }

  /** Kam vložit: pod kurzor myši (je-li nad mřížkou), jinak na pozici přehrávání. */
  function pasteTick() {
    const p = State.project;
    const stepT = MB.stepTicks(p);
    syncScroll();
    const tick = G.mouse ? xTick(G.mouse.x) : MB.Transport.currentTick();
    return clamp(Math.floor(tick / stepT) * stepT, 0, MB.songTicks(p) - stepT);
  }

  /** Vloží noty ze schránky. Vrátí počet vložených not, nebo chybovou zprávu. */
  function paste() {
    const clip = readClipboard();
    if (!clip || !clip.notes.length) return 'Schránka je prázdná – nejdřív vyber noty a stiskni Ctrl+C.';
    if (clip.kind !== G.kind) {
      return clip.kind === 'drums' ? 'Noty z bicích nejde vložit do melodické stopy.' : 'Melodické noty nejde vložit do bicí stopy.';
    }
    const p = State.project;
    const at = pasteTick();
    const songEnd = MB.songTicks(p);
    const [lo, hi] = pitchRange();
    const notes = clip.notes
      .map((n) => MB.createNote(n.pitch, at + n.start, n.length, n.velocity))
      .filter((n) => n.start < songEnd && n.pitch >= lo && n.pitch <= hi);
    if (!notes.length) return 'Vložené noty by byly mimo skladbu.';
    State.change(() => { track().notes.push(...notes); });
    setSelection(notes.map((n) => n.id));
    return notes.length;
  }

  /** Ctrl+D: kopie výběru hned za něj. */
  function duplicateSelection() {
    const notes = selectedNotes();
    if (!notes.length) return false;
    const p = State.project;
    const stepT = MB.stepTicks(p);
    const start = Math.min(...notes.map((n) => n.start));
    const end = Math.max(...notes.map((n) => n.start + n.length));
    const span = Math.ceil((end - start) / stepT) * stepT;
    const copies = notes
      .map((n) => MB.createNote(n.pitch, n.start + span, n.length, n.velocity))
      .filter((n) => n.start < MB.songTicks(p));
    if (!copies.length) return false;
    State.change(() => { track().notes.push(...copies); });
    setSelection(copies.map((n) => n.id));
    return true;
  }

  /** Q: přichytí začátky a délky na mřížku a výšky do stupnice (výběr, jinak celá stopa). */
  function quantize() {
    const p = State.project;
    const notes = selection().size ? selectedNotes() : track().notes;
    if (!notes.length) return 0;
    const stepT = MB.stepTicks(p);
    const songEnd = MB.songTicks(p);
    const useScale = !isDrums() && MB.scaleActive(p);
    let changed = 0;
    State.change(() => {
      for (const n of notes) {
        const start = clamp(Math.round(n.start / stepT) * stepT, 0, songEnd - stepT);
        const length = Math.max(stepT, Math.round(n.length / stepT) * stepT);
        let pitch = n.pitch;
        if (useScale) {
          pitch = MB.snapToScale(pitch, p.scale);
          if (pitch < MIN_PITCH || pitch > MAX_PITCH) pitch = n.pitch;
        }
        if (start !== n.start || length !== n.length || pitch !== n.pitch) changed++;
        Object.assign(n, { start, length, pitch });
      }
    });
    return changed;
  }

  /** Síla úhozu vybraných not (0–1). Během tažení posuvníkem jeden krok historie. */
  function setSelectionVelocity(v) {
    const notes = selectedNotes();
    if (!notes.length) return;
    State.beginGesture();
    for (const n of notes) n.velocity = clamp(v, 0.05, 1);
    State.changed('notes');
  }

  // ---------------------------------------------------------------------------
  // Inicializace
  // ---------------------------------------------------------------------------

  function init(els) {
    G.els = els;
    G.gctx = els.canvas.getContext('2d');
    G.rctx = els.ruler.getContext('2d');
    G.kctx = els.keys.getContext('2d');

    const s = els.scroll;
    s.addEventListener('pointerdown', onDown);
    s.addEventListener('pointermove', onMove);
    s.addEventListener('pointerup', onUp);
    s.addEventListener('pointercancel', onUp);
    s.addEventListener('pointerleave', onLeave);
    s.addEventListener('dblclick', onDblClick);
    s.addEventListener('wheel', onWheel, { passive: false });
    s.addEventListener('contextmenu', (e) => e.preventDefault());
    s.addEventListener('scroll', () => { G.dirty = true; });

    const k = els.keys;
    k.addEventListener('pointerdown', onKeysDown);
    k.addEventListener('pointermove', onKeysMove);
    k.addEventListener('pointerup', releaseKey);
    k.addEventListener('pointercancel', releaseKey);
    k.addEventListener('pointerleave', () => { G.keysHover = -1; G.dirty = true; });
    k.addEventListener('contextmenu', (e) => e.preventDefault());
    k.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.altKey) return onWheel(e);
      e.preventDefault();
      s.scrollTop += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    }, { passive: false });

    const r = els.ruler;
    r.addEventListener('pointerdown', onRulerDown);
    r.addEventListener('pointermove', onRulerMove);
    r.addEventListener('pointerup', onRulerUp);
    r.addEventListener('pointercancel', () => { G.rulerDrag = null; });
    r.addEventListener('dblclick', resetLoop);
    r.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) return onWheel(e);
      e.preventDefault();
      s.scrollLeft += (e.deltaMode === 1 ? 33 : 1) * (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
    }, { passive: false });

    new ResizeObserver(layout).observe(els.wrap);
    window.addEventListener('resize', layout); // změna devicePixelRatio (zoom prohlížeče)

    MB.on('change', (kind) => {
      if (kind !== 'mixer') onProjectChange();
      else G.dirty = true; // ztlumené stopy mají slabší „duchy“
    });
    MB.on('track', onTrackSwitch);
    MB.on('transport', () => { G.dirty = true; });

    layout();
    centerOnTrack();
  }

  /** Volá se každý snímek z main.js – překresluje jen když je potřeba. */
  function frame() {
    if (G.dirty || MB.Transport.playing || G.keysDown) render();
  }

  MB.Grid = {
    MIN_PITCH, MAX_PITCH,
    init, frame, layout,
    markDirty: () => { G.dirty = true; },
    zoomX, zoomY, fitToSong, centerOnTrack,
    deleteSelection, transposeSelection, moveSelectionTime, selectAll,
    clearSelection, selectedNotes, setSelection,
    copySelection, cutSelection, paste, duplicateSelection, quantize, setSelectionVelocity,
    get beatW() { return G.beatW; },
    get rowHeight() { return G.rowHeight; },
    get dragging() { return !!G.drag; },
    get hoverTick() { return G.mouse ? xTick(G.mouse.x) : null; },
    setView(beatW, rowHeight) {
      G.beatW = clamp(beatW || G.beatW, BEAT_W_MIN, BEAT_W_MAX);
      G.rowHeight = clamp(Math.round(rowHeight || G.rowHeight), ROW_H_MIN, ROW_H_MAX);
      if (G.els) layout();
    },
    resetLastLength: () => { G.lastLength = MB.stepTicks(State.project); },
  };
})(window.MB);
