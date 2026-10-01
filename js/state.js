/* MakerBeater – state.js
 * Datový model projektu, hudební teorie, historie (undo/redo), ukládání
 * do localStorage, import/export JSON a sdílená sběrnice událostí.
 *
 * Všechny moduly visí na globálním objektu window.MB (klasické skripty,
 * aby aplikace šla spustit prostým otevřením index.html z disku).
 */
(function (MB) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Konstanty
  // ---------------------------------------------------------------------------

  /** Počet tiků na jednu dobu (čtvrťovou notu). 1/8 = 48 tiků, 1/16 = 24 tiků. */
  const PPQ = 96;
  /** Rozsah melodických stop v mřížce (MIDI): C1 – C7. */
  const PITCH_MIN = 24;
  const PITCH_MAX = 96;
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  const STORAGE_KEY = 'makerbeater.project.v1';
  const UI_KEY = 'makerbeater.ui.v1';
  const HISTORY_LIMIT = 200;
  const SAVE_DELAY = 400; // ms – automatické uložení po poslední změně

  // ---------------------------------------------------------------------------
  // Sběrnice událostí – moduly spolu mluví přes MB.on / MB.emit
  // ---------------------------------------------------------------------------
  // 'change' (kind)   projekt se změnil: 'notes' | 'tracks' | 'mixer' | 'look' | 'project' | 'all'
  // 'track' (prevId)  přepnutí editované stopy
  // 'selection'       změna výběru not
  // 'history'         změna zásobníku undo/redo
  // 'saved' / 'saveerror'
  // 'transport', 'audiostate', 'zoom' – viz audio.js a grid.js

  const listeners = new Map();

  function on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name).delete(fn);
  }

  function emit(name, data) {
    const set = listeners.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(data); } catch (err) { console.error(`[MB] chyba v posluchači "${name}"`, err); }
    }
  }

  // ---------------------------------------------------------------------------
  // Pomocné funkce
  // ---------------------------------------------------------------------------

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const pitchClass = (p) => ((p % 12) + 12) % 12;
  /** MIDI 60 = C4 */
  const noteName = (p) => NOTE_NAMES[pitchClass(p)] + (Math.floor(p / 12) - 1);
  const isBlackKey = (p) => [1, 3, 6, 8, 10].includes(pitchClass(p));

  const songTicks = (p) => p.bars * p.beatsPerBar * PPQ;
  const stepTicks = (p) => PPQ / p.stepsPerBeat;
  const barTicks = (p) => p.beatsPerBar * PPQ;
  const secPerTick = (p) => 60 / p.bpm / PPQ;

  // ---------------------------------------------------------------------------
  // Stupnice
  // ---------------------------------------------------------------------------

  const SCALES = {
    chromatic: { name: 'Chromatická', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
    major: { name: 'Dur', steps: [0, 2, 4, 5, 7, 9, 11] },
    minor: { name: 'Moll', steps: [0, 2, 3, 5, 7, 8, 10] },
    harmonicMinor: { name: 'Moll harmonická', steps: [0, 2, 3, 5, 7, 8, 11] },
    majorPentatonic: { name: 'Pentatonika dur', steps: [0, 2, 4, 7, 9] },
    minorPentatonic: { name: 'Pentatonika moll', steps: [0, 3, 5, 7, 10] },
    blues: { name: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
    dorian: { name: 'Dórská', steps: [0, 2, 3, 5, 7, 9, 10] },
  };

  const scaleSteps = (scale) => (SCALES[scale.type] || SCALES.chromatic).steps;
  const inScale = (pitch, scale) => scaleSteps(scale).includes(pitchClass(pitch - scale.root));
  const isRoot = (pitch, scale) => pitchClass(pitch - scale.root) === 0;
  const scaleActive = (p) => !!p.scale && p.scale.type !== 'chromatic';
  const snapActive = (p) => scaleActive(p) && !!p.snapToScale;

  /** Nejbližší tón stupnice (při stejné vzdálenosti vyhrává ten nižší). */
  function snapToScale(pitch, scale) {
    for (let d = 0; d < 12; d++) {
      if (inScale(pitch - d, scale)) return pitch - d;
      if (inScale(pitch + d, scale)) return pitch + d;
    }
    return pitch;
  }

  /** Pořadí tónu v nekonečné řadě tónů stupnice (null = tón do stupnice nepatří). */
  function scaleIndex(pitch, scale) {
    const steps = scaleSteps(scale);
    const rel = pitch - scale.root;
    const octave = Math.floor(rel / 12);
    const i = steps.indexOf(rel - octave * 12);
    return i < 0 ? null : octave * steps.length + i;
  }

  function scaleIndexToPitch(index, scale) {
    const steps = scaleSteps(scale);
    const octave = Math.floor(index / steps.length);
    return scale.root + octave * 12 + steps[index - octave * steps.length];
  }

  /** Posun o `degrees` stupňů stupnice. Tón mimo stupnici si zachová odchylku od sousedního. */
  function transposeInScale(pitch, degrees, scale) {
    const base = snapToScale(pitch, scale);
    return scaleIndexToPitch(scaleIndex(base, scale) + degrees, scale) + (pitch - base);
  }

  /** Vrátí [začátek, konec] smyčky v ticích, oříznuté na délku skladby. */
  function loopRange(p) {
    const end = songTicks(p);
    let s = clamp(p.loopStart || 0, 0, end);
    let e = p.loopEnd == null ? end : clamp(p.loopEnd, 0, end);
    if (e - s < stepTicks(p)) { s = 0; e = end; }
    return [s, e];
  }

  // ---------------------------------------------------------------------------
  // Tvorba projektu, stop a not
  // ---------------------------------------------------------------------------

  function createNote(pitch, start, length, velocity = 0.8) {
    return { id: uid(), pitch, start, length, velocity };
  }

  function createTrack(instrument = 'piano', opts = {}) {
    const def = (MB.Instruments && MB.Instruments[instrument]) || {};
    return Object.assign({
      id: uid(),
      name: def.name || instrument,
      instrument,
      color: def.color || '#8ab4f8',
      volume: def.volume != null ? def.volume : 0.8,
      pan: 0,
      reverb: def.reverb != null ? def.reverb : 0.15,
      mute: false,
      solo: false,
      notes: [],
    }, opts);
  }

  function createProject(opts = {}) {
    return Object.assign({
      version: 1,
      name: 'Nový projekt',
      bpm: 120,
      bars: 8,
      beatsPerBar: 4,
      stepsPerBeat: 4,
      scale: { root: 0, type: 'major' },
      snapToScale: true,
      loop: true,
      loopStart: 0,
      loopEnd: null,
      tracks: [],
    }, opts);
  }

  /** Prázdný projekt na začátek: bicí + klavír. */
  function createEmptyProject() {
    const p = createProject();
    p.tracks.push(createTrack('drums'), createTrack('piano'));
    return p;
  }

  /** Kopie stopy s novými id (stopy i not). */
  function cloneTrack(t) {
    const copy = JSON.parse(JSON.stringify(t));
    copy.id = uid();
    for (const n of copy.notes) n.id = uid();
    return copy;
  }

  /** „Bas“, „Bas 2“, „Bas 3“… */
  function uniqueTrackName(project, base) {
    const names = new Set(project.tracks.map((t) => t.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  /** Ukázková skladba: A moll, akordy Am – F – C – G, 8 taktů. */
  function createDemoProject() {
    const p = createProject({ name: 'Demo – Noční jízda', bpm: 100, bars: 8, scale: { root: 9, type: 'minor' } });
    const S = PPQ / 4; // 1/16
    const BAR = 16;    // kroků v taktu
    const add = (t, step, len, pitch, vel = 0.8) => t.notes.push(createNote(pitch, step * S, len * S, vel));
    const chords = [[57, 60, 64], [57, 60, 65], [55, 60, 64], [55, 59, 62]]; // Am F C G
    const roots = [45, 41, 48, 43];                                       // A2 F2 C3 G2

    // Bicí: kick na 1, 2a, 3 · virbl na 2 a 4 · hi-haty v osminách · v posledním taktu přechod
    const drums = createTrack('drums');
    const D = MB.DRUM_INDEX;
    for (let bar = 0; bar < 8; bar++) {
      const o = bar * BAR;
      const fill = bar === 7;
      for (const s of [0, 6, 8]) add(drums, o + s, 1, D.kick, 0.95);
      add(drums, o + 4, 1, D.snare, 0.85);
      if (!fill) add(drums, o + 12, 1, D.snare, 0.85);
      if (bar >= 4) {
        add(drums, o + 4, 1, D.clap, 0.55);
        if (!fill) add(drums, o + 12, 1, D.clap, 0.55);
      }
      for (let s = 0; s < (fill ? 8 : 14); s += 2) add(drums, o + s, 1, D.hatClosed, s % 4 === 0 ? 0.75 : 0.5);
      if (fill) {
        add(drums, o + 8, 1, D.tomHigh, 0.8);
        add(drums, o + 10, 1, D.tomMid, 0.8);
        add(drums, o + 12, 1, D.tomLow, 0.85);
        add(drums, o + 14, 1, D.snare, 0.7);
        add(drums, o + 15, 1, D.snare, 0.9);
      } else {
        add(drums, o + 14, 1, D.hatOpen, 0.6);
      }
    }
    add(drums, 0, 1, D.crash, 0.8);
    add(drums, 4 * BAR, 1, D.crash, 0.8);

    // Bas: synkopovaný rytmus na základních tónech akordů
    const bass = createTrack('bass');
    const groove = [[0, 3, 0], [3, 3, 0], [6, 2, 0], [8, 3, 0], [11, 2, 12], [14, 2, 7]];
    for (let bar = 0; bar < 8; bar++) {
      for (const [s, len, iv] of groove) add(bass, bar * BAR + s, len, roots[bar % 4] + iv, s === 0 ? 0.9 : 0.75);
    }

    // Akordy: celé takty na pad
    const pad = createTrack('pad', { name: 'Akordy' });
    for (let bar = 0; bar < 8; bar++) for (const pitch of chords[bar % 4]) add(pad, bar * BAR, BAR, pitch, 0.7);

    // Arpeggio: rozložené akordy v osminách (takty 1–4)
    const arp = createTrack('pluck', { name: 'Arpeggio' });
    for (let bar = 0; bar < 4; bar++) {
      const c = chords[bar].map((x) => x + 12);
      [0, 1, 2, 1, 0, 1, 2, 1].forEach((k, i) => add(arp, bar * BAR + i * 2, 2, c[k], i % 2 ? 0.55 : 0.75));
    }

    // Melodie: takty 5–8
    const lead = createTrack('lead', { name: 'Melodie', volume: 0.85 });
    const melody = [ // [krok, délka, MIDI]
      [0, 2, 69], [2, 2, 72], [4, 4, 76], [8, 2, 74], [10, 2, 72], [12, 4, 74],
      [16, 6, 72], [22, 2, 69], [24, 4, 72], [28, 4, 69],
      [32, 4, 76], [36, 4, 79], [40, 2, 76], [42, 2, 74], [44, 4, 72],
      [48, 8, 74], [56, 4, 71], [60, 4, 67],
    ];
    for (const [s, len, pitch] of melody) add(lead, 4 * BAR + s, len, pitch, 0.8);

    p.tracks.push(drums, bass, pad, arp, lead);
    return p;
  }

  // ---------------------------------------------------------------------------
  // Kontrola načtených dat (localStorage i import JSON)
  // ---------------------------------------------------------------------------
  // Do projektu se nikdy nedostane nic, co by rozbilo aplikaci: čísla se oříznou
  // na rozumný rozsah, neznámé nástroje se nahradí klavírem, vadné noty se zahodí.

  const HEX_COLOR = /^#[0-9a-f]{6}$/i;
  const num = (v, lo, hi, def) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? clamp(Number(v), lo, hi) : def);
  const int = (v, lo, hi, def) => Math.round(num(v, lo, hi, def));
  const text = (v, max, def) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : def);

  function normalizeProject(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tracks)) {
      throw new Error('Soubor neobsahuje projekt MakerBeater (chybí seznam stop).');
    }
    const p = createProject();
    p.name = text(raw.name, 80, p.name);
    p.bpm = int(raw.bpm, 30, 300, 120);
    p.bars = int(raw.bars, 1, 128, 8);
    p.beatsPerBar = int(raw.beatsPerBar, 2, 7, 4);
    p.stepsPerBeat = [1, 2, 4].includes(raw.stepsPerBeat) ? raw.stepsPerBeat : 4;
    const sc = raw.scale && typeof raw.scale === 'object' ? raw.scale : {};
    p.scale = { root: int(sc.root, 0, 11, 0), type: SCALES[sc.type] ? sc.type : 'chromatic' };
    p.snapToScale = !!raw.snapToScale;
    p.loop = raw.loop !== false;
    const end = songTicks(p);
    p.loopStart = int(raw.loopStart, 0, end, 0);
    p.loopEnd = raw.loopEnd == null ? null : int(raw.loopEnd, 0, end, end);

    const trackIds = new Set();
    for (const rt of raw.tracks.slice(0, 64)) {
      if (!rt || typeof rt !== 'object') continue;
      const instrument = MB.Instruments && MB.Instruments[rt.instrument] ? rt.instrument : 'piano';
      const t = createTrack(instrument);
      if (typeof rt.id === 'string' && rt.id && !trackIds.has(rt.id)) t.id = rt.id.slice(0, 32);
      trackIds.add(t.id);
      t.name = text(rt.name, 40, t.name);
      if (HEX_COLOR.test(rt.color)) t.color = rt.color.toLowerCase();
      t.volume = num(rt.volume, 0, 1, t.volume);
      t.pan = num(rt.pan, -1, 1, 0);
      t.reverb = num(rt.reverb, 0, 1, t.reverb);
      t.mute = !!rt.mute;
      t.solo = !!rt.solo;

      const drums = MB.getInstrument(instrument).kind === 'drums';
      const noteIds = new Set();
      for (const rn of Array.isArray(rt.notes) ? rt.notes.slice(0, 20000) : []) {
        if (!rn || typeof rn !== 'object') continue;
        let pitch = Math.round(Number(rn.pitch));
        const start = Math.round(Number(rn.start));
        const length = Math.round(Number(rn.length));
        if (![pitch, start, length].every(Number.isFinite) || start < 0 || length < 1) continue;
        if (drums) {
          if (pitch < 0 || pitch >= MB.DRUM_ROWS.length) continue;
        } else { // tón mimo rozsah mřížky posuneme o oktávy dovnitř
          if (pitch < 0 || pitch > 127) continue;
          while (pitch < PITCH_MIN) pitch += 12;
          while (pitch > PITCH_MAX) pitch -= 12;
        }
        const n = createNote(pitch, start, Math.min(length, 128 * 7 * PPQ), num(rn.velocity, 0.05, 1, 0.8));
        if (typeof rn.id === 'string' && rn.id && !noteIds.has(rn.id)) n.id = rn.id.slice(0, 32);
        noteIds.add(n.id);
        t.notes.push(n);
      }
      p.tracks.push(t);
    }
    if (!p.tracks.length) p.tracks.push(createTrack('piano'));
    return p;
  }

  // ---------------------------------------------------------------------------
  // localStorage (může chybět nebo být plné – vše v try/catch)
  // ---------------------------------------------------------------------------

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (err) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Stav aplikace
  // ---------------------------------------------------------------------------

  const snapshot = () => JSON.stringify(State.project);
  let gestureBefore = null; // snapshot ze začátku tažení (null = žádné gesto neprobíhá)
  let saveTimer = 0;

  const State = {
    project: null,
    undoStack: [],
    redoStack: [],
    lastSaved: 0,
    restored: false, // načetl se projekt z localStorage?

    /** Stav editoru, který se neukládá do projektu. */
    ui: {
      trackId: null,         // právě editovaná stopa
      selection: new Set(),  // id vybraných not (jen v aktuální stopě)
      tool: 'draw',          // 'draw' | 'select' | 'erase'
      follow: true,          // posouvat mřížku za přehrávacím kurzorem
      ghosts: true,          // ukazovat noty ostatních stop
    },

    /** Volá main.js až po načtení všech skriptů (nástroje jsou v audio.js). */
    init() {
      let project = null;
      const raw = storageGet(STORAGE_KEY);
      if (raw) {
        try {
          project = normalizeProject(JSON.parse(raw));
        } catch (err) {
          console.warn('[MB] uložený projekt nejde načíst, otevírám demo', err);
          storageSet(`${STORAGE_KEY}.broken`, raw); // pro jistotu záloha
        }
      }
      this.restored = !!project;
      this.project = project || createDemoProject();
      const ui = this.loadUi();
      const remembered = ui.trackId && this.project.tracks.find((t) => t.id === ui.trackId);
      const pluck = this.project.tracks.find((t) => t.instrument === 'pluck');
      this.ui.trackId = (remembered || pluck || this.project.tracks[0]).id;
      for (const k of ['tool', 'follow', 'ghosts']) if (ui[k] !== undefined) this.ui[k] = ui[k];
      window.addEventListener('pagehide', () => this.flushSave());
    },

    currentTrack() {
      const p = this.project;
      return p.tracks.find((t) => t.id === this.ui.trackId) || p.tracks[0];
    },

    trackById(id) {
      return this.project.tracks.find((t) => t.id === id) || null;
    },

    // --- změny projektu --------------------------------------------------------

    /**
     * Jediná cesta, jak trvale změnit projekt: fn(projekt) provede změnu,
     * uloží se krok historie a rozešle se událost 'change'.
     */
    change(fn, kind = 'notes') {
      const before = gestureBefore === null ? snapshot() : null;
      if (fn) fn(this.project);
      if (before !== null) this._commit(before);
      this.changed(kind);
    },

    /** Jen oznámí změnu (průběžně během tažení) – historii řeší begin/endGesture. */
    changed(kind = 'notes') {
      emit('change', kind);
      this.scheduleSave();
    },

    /** Začátek gesta (tažení myší, posuvník) – celé gesto bude jeden krok historie. */
    beginGesture() {
      if (gestureBefore === null) gestureBefore = snapshot();
    },

    endGesture(kind = 'notes') {
      if (gestureBefore === null) return;
      const before = gestureBefore;
      gestureBefore = null;
      this._commit(before);
      this.changed(kind);
    },

    _commit(before) {
      if (before === snapshot()) return; // nic se nezměnilo → žádný krok historie
      this.undoStack.push(before);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
      emit('history');
    },

    // --- undo / redo -----------------------------------------------------------

    get canUndo() { return this.undoStack.length > 0; },
    get canRedo() { return this.redoStack.length > 0; },

    undo() {
      if (!this.undoStack.length || gestureBefore !== null) return false;
      this.redoStack.push(snapshot());
      this._restore(this.undoStack.pop());
      return true;
    },

    redo() {
      if (!this.redoStack.length || gestureBefore !== null) return false;
      this.undoStack.push(snapshot());
      this._restore(this.redoStack.pop());
      return true;
    },

    _restore(json) {
      const prevTrack = this.ui.trackId;
      this.project = JSON.parse(json);
      if (!this.trackById(this.ui.trackId)) this.ui.trackId = this.project.tracks[0].id;
      emit('history');
      this.changed('all');
      if (this.ui.trackId !== prevTrack) emit('track', prevTrack);
    },

    /** Nahradí celý projekt (nový, demo, import). Jde vrátit přes Ctrl+Z. */
    loadProject(project) {
      if (gestureBefore !== null) gestureBefore = null;
      const prevTrack = this.ui.trackId;
      this.undoStack.push(snapshot());
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
      this.project = project;
      const pluck = project.tracks.find((t) => t.instrument === 'pluck');
      this.ui.trackId = (pluck || project.tracks[0]).id;
      this.ui.selection = new Set();
      emit('history');
      this.changed('all');
      emit('track', prevTrack);
    },

    // --- stopy ---------------------------------------------------------------

    /** Přepne editovanou stopu. Posluchači 'track' dostanou id předchozí stopy. */
    selectTrack(id) {
      if (this.ui.trackId === id || !this.trackById(id)) return;
      const prev = this.ui.trackId;
      this.ui.trackId = id;
      this.ui.selection = new Set();
      emit('track', prev);
      this.saveUi();
    },

    addTrack(instrument) {
      let track = null;
      this.change((p) => {
        track = createTrack(instrument, { name: uniqueTrackName(p, MB.getInstrument(instrument).name) });
        p.tracks.push(track);
      }, 'tracks');
      this.selectTrack(track.id);
      return track;
    },

    duplicateTrack(id) {
      const p = this.project;
      const idx = p.tracks.findIndex((t) => t.id === id);
      if (idx < 0) return null;
      const copy = cloneTrack(p.tracks[idx]);
      copy.name = uniqueTrackName(p, `${p.tracks[idx].name} (kopie)`);
      copy.solo = false;
      this.change((pp) => { pp.tracks.splice(idx + 1, 0, copy); }, 'tracks');
      this.selectTrack(copy.id);
      return copy;
    },

    removeTrack(id) {
      const p = this.project;
      const idx = p.tracks.findIndex((t) => t.id === id);
      if (idx < 0 || p.tracks.length <= 1) return false;
      const wasCurrent = this.ui.trackId === id;
      this.change((pp) => { pp.tracks.splice(idx, 1); }, 'tracks');
      if (wasCurrent) this.selectTrack(p.tracks[Math.min(idx, p.tracks.length - 1)].id);
      return true;
    },

    // --- ukládání --------------------------------------------------------------

    scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => this.saveNow(), SAVE_DELAY);
    },

    saveNow() {
      clearTimeout(saveTimer);
      saveTimer = 0;
      if (storageSet(STORAGE_KEY, snapshot())) {
        this.lastSaved = Date.now();
        emit('saved');
      } else {
        emit('saveerror');
      }
    },

    /** Při zavírání stránky uložit hned (čekající automatické uložení by se nestihlo). */
    flushSave() {
      if (saveTimer) this.saveNow();
      this.saveUi();
    },

    /** Nastavení editoru (zoom, nástroj…) – ukládá se zvlášť, není součástí projektu. */
    saveUi(extra) {
      const current = this.loadUi();
      const ui = Object.assign(current, {
        trackId: this.ui.trackId,
        tool: this.ui.tool,
        follow: this.ui.follow,
        ghosts: this.ui.ghosts,
      }, extra);
      storageSet(UI_KEY, JSON.stringify(ui));
    },

    loadUi() {
      try {
        const ui = JSON.parse(storageGet(UI_KEY) || '{}');
        return ui && typeof ui === 'object' ? ui : {};
      } catch (err) {
        return {};
      }
    },

    // --- import / export -------------------------------------------------------

    exportJSON() {
      return JSON.stringify(this.project, null, 2);
    },

    /** Načte projekt z textu JSON (vyhodí srozumitelnou chybu, když to nejde). */
    importJSON(textValue) {
      let raw;
      try {
        raw = JSON.parse(textValue);
      } catch (err) {
        throw new Error('Soubor není platný JSON.');
      }
      const p = normalizeProject(raw);
      this.loadProject(p);
      return p;
    },
  };

  Object.assign(MB, {
    PPQ, PITCH_MIN, PITCH_MAX, NOTE_NAMES, SCALES,
    on, emit,
    clamp, uid, pitchClass, noteName, isBlackKey,
    songTicks, stepTicks, barTicks, secPerTick, loopRange,
    scaleSteps, inScale, isRoot, scaleActive, snapActive, snapToScale, scaleIndex, scaleIndexToPitch, transposeInScale,
    createNote, createTrack, createProject, createEmptyProject, createDemoProject, cloneTrack, uniqueTrackName,
    normalizeProject,
    State,
  });
})(window.MB = window.MB || {});
