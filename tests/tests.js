/* MakerBeater – automatické testy (spouští tests/test.html) */
(function (MB) {
  'use strict';

  const { PPQ } = MB;
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });

  function assert(cond, msg) {
    if (!cond) throw new Error(msg);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Deterministický generátor náhody (aby šly testy zopakovat). */
  function rng(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Projekt s jednou stopou: 1/16 noty, každá jiná výška (podle výšky poznáme pořadí). */
  function sixteenthProject({ bars = 2, bpm = 150, loop = true } = {}) {
    const p = MB.createProject({ bpm, bars, loop });
    const t = MB.createTrack('piano');
    const n = bars * p.beatsPerBar * 4;
    for (let i = 0; i < n; i++) t.notes.push(MB.createNote(40 + i, i * (PPQ / 4), PPQ / 8));
    // schválně zamícháme pořadí v poli – scheduler si je musí seřadit sám
    t.notes.sort(() => Math.random() - 0.5);
    p.tracks.push(t);
    return p;
  }

  /**
   * Spustí Transport proti falešným hodinám: místo AudioContextu objekt s currentTime,
   * který posouváme ručně. Zaznamená každé volání playNote (kdy a na jaký čas).
   */
  function withFakeClock(project, fn) {
    const E = MB.Engine, T = MB.Transport;
    const saved = {
      ctx: E.ctx, ensure: E.ensure, syncTracks: E.syncTracks, silence: E.silence,
      pruneVoices: E.pruneVoices, playNote: E.playNote, ticker: T.ticker, project: MB.State.project,
    };
    const clock = { currentTime: 0, state: 'running', outputLatency: 0, baseLatency: 0 };
    const log = [];
    E.ctx = clock;
    E.ensure = () => clock;
    E.syncTracks = () => {};
    E.silence = () => {};
    E.pruneVoices = () => {};
    E.playNote = (track, pitch, time, dur) => { log.push({ pitch, time, dur, at: clock.currentTime }); return null; };
    T.ticker = { start() {}, stop() {} };
    T.playing = false;
    T.position = 0;
    MB.State.project = project;
    try {
      fn(clock, log);
    } finally {
      T._halt(false);
      Object.assign(E, {
        ctx: saved.ctx, ensure: saved.ensure, syncTracks: saved.syncTracks, silence: saved.silence,
        pruneVoices: saved.pruneVoices, playNote: saved.playNote,
      });
      T.ticker = saved.ticker;
      MB.State.project = saved.project;
    }
  }

  /** Simuluje nepravidelné buzení scheduleru: jitter + občasné „zaseknutí“ UI. */
  function runClock(clock, until, rand, maxStall = 0.08, onStep) {
    while (clock.currentTime < until) {
      let dt = (MB.TICK_MS / 1000) * (0.5 + rand());
      if (rand() < 0.1) dt += maxStall * rand();
      clock.currentTime += dt;
      if (onStep) onStep(clock.currentTime);
      MB.Transport._schedule();
    }
  }

  function intervals(log) {
    const out = [];
    for (let i = 1; i < log.length; i++) out.push(log[i].time - log[i - 1].time);
    return out;
  }

  // ===========================================================================
  // Scheduler – simulovaný čas
  // ===========================================================================

  test('Scheduler: noty přesně v mřížce, nic pozdě, nic navíc ani chybějící', () => {
    const p = sixteenthProject({ bpm: 150 });
    const step = (PPQ / 4) * MB.secPerTick(p);
    let detail = '';
    withFakeClock(p, (clock, log) => {
      MB.Transport.play();
      runClock(clock, 20, rng(1));
      const late = log.filter((e) => e.time < e.at);
      assert(late.length === 0, `${late.length} not naplánováno pozdě`);
      assert(Math.abs(log[0].time - 0.05) < 1e-12, 'první nota nezačíná v t0');
      const iv = intervals(log);
      const maxErr = Math.max(...iv.map((d) => Math.abs(d - step)));
      assert(maxErr < 1e-9, `nepravidelný rozestup, max chyba ${maxErr}`);
      // pořadí výšek ověří, že se při smyčce nic nevynechalo ani nezdvojilo
      const n = 32;
      log.forEach((e, i) => assert(e.pitch === 40 + (i % n), `nota #${i} má špatnou výšku ${e.pitch}`));
      const minLead = Math.min(...log.map((e) => e.time - e.at));
      detail = `${log.length} not za 20 s (smyčka ${Math.floor(log.length / n)}×), krok ${(step * 1000).toFixed(3)} ms, ` +
        `max chyba rozestupu ${maxErr.toExponential(1)} s, nejmenší předstih ${(minLead * 1000).toFixed(1)} ms`;
    });
    return detail;
  });

  test('Scheduler: změna tempa za běhu – plynulý přechod', () => {
    const p = sixteenthProject({ bpm: 150 });
    const stepA = (PPQ / 4) * (60 / 150 / PPQ);
    const stepB = (PPQ / 4) * (60 / 97 / PPQ);
    let detail = '';
    withFakeClock(p, (clock, log) => {
      MB.Transport.play();
      let changed = false;
      runClock(clock, 12, rng(2), 0.08, (t) => {
        if (!changed && t > 5) { p.bpm = 97; changed = true; }
      });
      assert(log.every((e) => e.time >= e.at), 'nějaká nota přišla pozdě');
      const iv = intervals(log);
      const lo = Math.min(stepA, stepB) - 1e-9, hi = Math.max(stepA, stepB) + 1e-9;
      assert(iv.every((d) => d >= lo && d <= hi), 'rozestup mimo rozsah obou temp');
      // noty začínající po změně (+ rezerva na lookahead) už musí jet v novém tempu
      const after = [];
      for (let i = 1; i < log.length; i++) if (log[i - 1].time > 5 + MB.LOOKAHEAD) after.push(iv[i - 1]);
      assert(after.length > 20, 'po změně tempa zaznělo málo not');
      assert(after.every((d) => Math.abs(d - stepB) < 1e-9), 'po změně tempa nesedí nový rozestup');
      log.forEach((e, i) => assert(e.pitch === 40 + (i % 32), `po změně tempa se nota #${i} vynechala`));
      detail = `${log.length} not, přechod 150 → 97 BPM bez mezery i překryvu`;
    });
    return detail;
  });

  test('Scheduler: smyčka jen přes 2. takt (loopStart/loopEnd)', () => {
    const p = sixteenthProject({ bpm: 120 });
    p.loopStart = MB.barTicks(p);
    p.loopEnd = 2 * MB.barTicks(p);
    const step = (PPQ / 4) * MB.secPerTick(p);
    let detail = '';
    withFakeClock(p, (clock, log) => {
      MB.Transport.play(); // kurzor je na 0 → přehraje 1. takt, pak smyčkuje 2. takt
      runClock(clock, 8, rng(3));
      const expect = (i) => (i < 16 ? 40 + i : 56 + ((i - 16) % 16));
      log.forEach((e, i) => assert(e.pitch === expect(i), `nota #${i}: čekal ${expect(i)}, je ${e.pitch}`));
      const maxErr = Math.max(...intervals(log).map((d) => Math.abs(d - step)));
      assert(maxErr < 1e-9, 'skok smyčky rozbil rytmus');
      detail = `${log.length} not, skok ze 2. taktu zpět na jeho začátek je přesně v rytmu`;
    });
    return detail;
  });

  test('Scheduler: bez smyčky skladba skončí a kurzor se vrátí', () => {
    const p = sixteenthProject({ bars: 1, bpm: 120, loop: false });
    let detail = '';
    withFakeClock(p, (clock, log) => {
      MB.Transport.play();
      runClock(clock, 3, rng(4));
      MB.Transport.update();
      assert(log.length === 16, `čekal 16 not, zaznělo ${log.length}`);
      assert(!MB.Transport.playing, 'transport po konci skladby pořád hraje');
      assert(MB.Transport.position === 0, 'kurzor se nevrátil na začátek');
      detail = `přesně 16 not, konec v ${(0.05 + 2).toFixed(2)} s, transport zastaven`;
    });
    return detail;
  });

  test('Scheduler: start uprostřed dlouhé noty ji dohraje (chase)', () => {
    const p = MB.createProject({ bpm: 120, bars: 2 });
    const t = MB.createTrack('piano');
    t.notes.push(MB.createNote(60, 0, 4 * PPQ)); // celý takt
    p.tracks.push(t);
    let detail = '';
    withFakeClock(p, (clock, log) => {
      MB.Transport.position = 2 * PPQ; // start v polovině noty
      MB.Transport.play();
      assert(log.length === 1 && log[0].pitch === 60, 'dlouhá nota se nedohrála');
      const expected = 2 * PPQ * MB.secPerTick(p);
      assert(Math.abs(log[0].dur - expected) < 1e-9, 'špatná zbývající délka');
      detail = `zbývající délka ${expected.toFixed(3)} s`;
    });
    return detail;
  });

  // ===========================================================================
  // Offline render – začíná nota opravdu v naplánovaném vzorku?
  // ===========================================================================

  test('Offline render: nástup noty přesně na vzorek', async () => {
    const sr = 44100;
    const ctx = new OfflineAudioContext(1, sr * 3, sr);
    const times = [0.1, 0.60031, 1.1, 1.60017, 2.1, 2.55553];
    for (const t of times) MB.Instruments.piano.play(ctx, ctx.destination, 60, t, 0.05, 0.8, {});
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    const errs = times.map((t) => {
      const expected = t * sr;
      for (let i = Math.floor(expected) - 200; i < expected + 400; i++) {
        if (Math.abs(d[i]) > 1e-7) return i - expected;
      }
      return NaN;
    });
    assert(errs.every((e) => e >= -1 && e <= 2), `odchylky ve vzorcích: ${errs.map((e) => e.toFixed(2)).join(', ')}`);
    return `odchylka nástupu: ${errs.map((e) => e.toFixed(2)).join(', ')} vzorku (1 vzorek = 0,023 ms)`;
  });

  // ===========================================================================
  // Stav: stupnice, historie, import
  // ===========================================================================

  /** Spustí fn s dočasným projektem; ukládání do localStorage je po dobu testu vypnuté. */
  function withTempState(project, fn) {
    const S = MB.State;
    const saved = {
      project: S.project, undo: S.undoStack, redo: S.redoStack, scheduleSave: S.scheduleSave, saveNow: S.saveNow,
    };
    S.project = project;
    S.undoStack = [];
    S.redoStack = [];
    S.scheduleSave = () => {};
    S.saveNow = () => {};
    try {
      return fn(S);
    } finally {
      Object.assign(S, {
        project: saved.project, undoStack: saved.undo, redoStack: saved.redo,
        scheduleSave: saved.scheduleSave, saveNow: saved.saveNow,
      });
    }
  }

  test('Stupnice: přichycení k nejbližšímu tónu a posun po stupních', () => {
    const aMinor = { root: 9, type: 'minor' };      // A H C D E F G
    const n = MB.noteName;
    const cases = [
      [n(MB.snapToScale(70, aMinor)), 'A4'],          // A#4 → A4 (stejně daleko, vyhrává nižší)
      [n(MB.snapToScale(66, aMinor)), 'F4'],          // F#4 → F4
      [n(MB.transposeInScale(69, 1, aMinor)), 'B4'],  // A4 + 1 stupeň = H4 (B4)
      [n(MB.transposeInScale(72, -1, aMinor)), 'B4'], // C5 − 1 stupeň = H4
      [n(MB.transposeInScale(69, 7, aMinor)), 'A5'],  // + 7 stupňů = oktáva
      [n(MB.transposeInScale(76, 2, { root: 0, type: 'majorPentatonic' })), 'A5'], // C pentatonika C D E G A: E5 → G5 → A5
    ];
    for (const [got, want] of cases) assert(got === want, `čekal ${want}, vyšlo ${got}`);
    assert(MB.inScale(60, { root: 0, type: 'major' }) && !MB.inScale(61, { root: 0, type: 'major' }), 'C dur: C ano, C# ne');
    assert(Object.keys(MB.SCALES).every((k) => MB.SCALES[k].steps[0] === 0), 'každá stupnice začíná základním tónem');
    return `${cases.length + 2} kontrol v pořádku (A moll, C dur, pentatonika)`;
  });

  test('Undo/redo: krok po kroku, tažení = jeden krok, změna bez efektu se neukládá', () => {
    const p = MB.createProject();
    p.tracks.push(MB.createTrack('piano'));
    return withTempState(p, (S) => {
      const t = () => S.project.tracks[0];
      S.change((pp) => pp.tracks[0].notes.push(MB.createNote(60, 0, 24)));
      S.change((pp) => pp.tracks[0].notes.push(MB.createNote(62, 24, 24)));
      assert(S.undoStack.length === 2, `čekal 2 kroky, je ${S.undoStack.length}`);
      S.change(() => {}); // nic se nezměnilo
      assert(S.undoStack.length === 2, 'prázdná změna vytvořila krok historie');
      // tažení: 20 průběžných změn = 1 krok
      S.beginGesture();
      for (let i = 0; i < 20; i++) { t().notes[0].start += 24; S.changed('notes'); }
      S.endGesture();
      assert(S.undoStack.length === 3, 'tažení nevytvořilo právě jeden krok');
      S.undo();
      assert(t().notes[0].start === 0, 'undo tažení nevrátilo notu');
      S.undo();
      assert(t().notes.length === 1, 'undo nevrátilo přidání noty');
      S.redo();
      S.redo();
      assert(t().notes.length === 2 && t().notes[0].start === 480, 'redo nevrátilo stav');
      assert(!S.canRedo, 'po posledním redo by měl být zásobník prázdný');
      S.undo();
      S.change((pp) => { pp.bpm = 99; });
      assert(!S.canRedo, 'nová změna po undo musí smazat redo');
      return 'přidání, tažení (20 změn → 1 krok), undo, redo i větvení historie fungují';
    });
  });

  test('Import: vadná data se opraví nebo zahodí, nic nespadne', () => {
    const raw = {
      name: '   ', bpm: 9999, bars: -3, beatsPerBar: 'x', stepsPerBeat: 3,
      scale: { root: 15, type: 'neexistuje' }, loopStart: -100, loopEnd: 1e9,
      tracks: [
        null,
        { id: 'a', name: 'X'.repeat(200), instrument: 'kazoo', color: 'red', volume: 7, pan: -9, notes: [
          { pitch: 60, start: 0, length: 24 },          // v pořádku
          { pitch: 'C4', start: 0, length: 24 },        // špatný typ
          { pitch: 60, start: -24, length: 24 },        // záporný začátek
          { pitch: 60, start: 0, length: 0 },           // nulová délka
          { pitch: 120, start: 48, length: 24 },        // mimo rozsah → posun o oktávy
        ] },
        { id: 'a', instrument: 'drums', notes: [{ pitch: 3, start: 0, length: 24 }, { pitch: 40, start: 0, length: 24 }] },
      ],
    };
    const p = MB.normalizeProject(raw);
    assert(p.name === 'Nový projekt' && p.bpm === 300 && p.bars === 1 && p.beatsPerBar === 4 && p.stepsPerBeat === 4, 'hodnoty projektu');
    assert(p.scale.root === 11 && p.scale.type === 'chromatic', 'stupnice');
    assert(p.tracks.length === 2, `čekal 2 stopy, je ${p.tracks.length}`);
    const [t1, t2] = p.tracks;
    assert(t1.instrument === 'piano' && t1.name.length === 40 && /^#[0-9a-f]{6}$/.test(t1.color), 'opravená stopa');
    assert(t1.volume === 1 && t1.pan === -1, 'hlasitost / panorama oříznuté');
    assert(t1.notes.length === 2 && t1.notes[1].pitch <= MB.PITCH_MAX, `noty melodické stopy: ${t1.notes.length}`);
    assert(t2.id !== t1.id, 'duplicitní id stopy');
    assert(t2.notes.length === 1, 'bicí nota mimo řádky se má zahodit');
    let threw = false;
    try { MB.normalizeProject({ hello: 1 }); } catch (err) { threw = true; }
    assert(threw, 'projekt bez stop musí vyhodit chybu');
    return 'ořezané hodnoty, neznámý nástroj → klavír, vadné noty zahozené, duplicitní id opravené';
  });

  test('Export → import JSON beze ztráty dat', () => {
    const demo = MB.createDemoProject();
    const json = JSON.stringify(demo);
    const back = MB.normalizeProject(JSON.parse(json));
    assert(JSON.stringify(back) === json, 'po importu se projekt liší od exportu');
    const notes = demo.tracks.reduce((a, t) => a + t.notes.length, 0);
    return `demo: ${demo.tracks.length} stop, ${notes} not, ${(json.length / 1024).toFixed(1)} kB – shodné`;
  });

  // ===========================================================================
  // Nástroje a export
  // ===========================================================================

  const dB = (v) => 20 * Math.log10(Math.max(v, 1e-9));

  async function renderPeak(fn, seconds = 3, sr = 44100) {
    const ctx = new OfflineAudioContext(1, sr * seconds, sr);
    fn(ctx, ctx.destination);
    const d = (await ctx.startRendering()).getChannelData(0);
    let peak = 0;
    let nan = false;
    for (let i = 0; i < d.length; i++) {
      if (Number.isNaN(d[i])) nan = true;
      peak = Math.max(peak, Math.abs(d[i]));
    }
    return { peak, nan, data: d };
  }

  test('Nástroje: každý zní, bez NaN a bez přebuzení (−30 až 0 dBFS)', async () => {
    await MB.prepareDrumKit(44100);
    const rows = [];
    for (const def of Object.values(MB.Instruments)) {
      const pitches = def.kind === 'drums' ? MB.DRUM_ROWS.map((_, i) => i) : [36, def.center || 60, 84];
      for (const pitch of pitches) {
        const { peak, nan } = await renderPeak((c, d) => def.play(c, d, pitch, 0.01, 0.5, 0.8, {}));
        const name = def.kind === 'drums' ? MB.DRUM_ROWS[pitch].id : `${def.id} ${MB.noteName(pitch)}`;
        assert(!nan, `${name}: NaN ve výstupu`);
        assert(dB(peak) > -30 && dB(peak) < 0, `${name}: špička ${dB(peak).toFixed(1)} dBFS`);
        rows.push(`${name} ${dB(peak).toFixed(0)}`);
      }
    }
    return `${rows.length} zvuků v pořádku`;
  });

  test('Bicí: zavřený hi-hat utlumí znějící otevřený (choke)', async () => {
    await MB.prepareDrumKit(44100);
    const D = MB.DRUM_INDEX;
    const energyAfter = (d, from) => { let s = 0; for (let i = from; i < d.length; i++) s += d[i] * d[i]; return s; };
    const open = await renderPeak((c, d) => MB.Instruments.drums.play(c, d, D.hatOpen, 0.05, 0.1, 0.8, {}), 1.2);
    const state = {};
    const choked = await renderPeak((c, d) => {
      MB.Instruments.drums.play(c, d, D.hatOpen, 0.05, 0.1, 0.8, state);
      MB.Instruments.drums.play(c, d, D.hatClosed, 0.3, 0.1, 0.8, state);
    }, 1.2);
    const from = Math.floor(0.5 * 44100); // po doznění zavřeného hi-hatu
    const ratio = energyAfter(choked.data, from) / energyAfter(open.data, from);
    assert(ratio < 0.01, `otevřený hi-hat po zavřeném dál zní (poměr energie ${ratio.toFixed(3)})`);
    return `energie otevřeného hi-hatu po utlumení klesla na ${(ratio * 100).toFixed(2)} %`;
  });

  test('Export: render celé skladby přes master a WAV hlavička', async () => {
    const p = MB.createProject({ bpm: 120, bars: 2 });
    const drums = MB.createTrack('drums');
    for (let i = 0; i < 8; i++) drums.notes.push(MB.createNote(i % 2 ? MB.DRUM_INDEX.snare : MB.DRUM_INDEX.kick, i * PPQ, PPQ / 4, 0.9));
    const bass = MB.createTrack('bass');
    for (let i = 0; i < 4; i++) bass.notes.push(MB.createNote(36 + i * 2, i * 2 * PPQ, 2 * PPQ, 0.9));
    p.tracks.push(drums, bass);
    let progress = 0;
    const buf = await MB.renderProject(p, { onProgress: (x) => { progress = x; } });
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) for (const x of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(x));
    assert(peak > 0.05 && peak < 1, `špička mixu ${peak.toFixed(3)}`);
    const wav = MB.encodeWav(buf);
    const v = new DataView(await wav.arrayBuffer());
    const str = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    assert(str(0) === 'RIFF' && str(8) === 'WAVE' && str(36) === 'data', 'neplatná WAV hlavička');
    assert(v.getUint16(22, true) === 2 && v.getUint32(24, true) === 44100 && v.getUint16(34, true) === 16, 'špatný formát');
    assert(v.getUint32(40, true) === wav.size - 44, 'nesedí velikost dat');
    const seconds = (wav.size - 44) / 4 / 44100;
    assert(seconds > 4 && seconds < 8, `délka ${seconds.toFixed(2)} s`);
    return `WAV ${seconds.toFixed(2)} s, 44,1 kHz, 16 bit stereo, špička ${dB(peak).toFixed(1)} dBFS, průběh do ${(progress * 100).toFixed(0)} %`;
  });

  // ===========================================================================
  // Živý AudioContext – skutečný časovač ve Workeru + zátěž hlavního vlákna
  // ===========================================================================

  test('Živě: 4 s přehrávání při zaseknutém UI (40 ms každých 150 ms)', async () => {
    const E = MB.Engine, T = MB.Transport;
    const ctx = E.ensure();
    if (ctx.state !== 'running') await ctx.resume();
    E.setMasterVolume(document.getElementById('loud').checked ? 0.8 : 0);
    const p = sixteenthProject({ bpm: 150 });
    const saved = MB.State.project;
    MB.State.project = p;
    const log = [];
    const origPlay = E.playNote;
    E.playNote = function (track, pitch, time, dur, vel) {
      log.push({ pitch, time, at: ctx.currentTime });
      return origPlay.call(this, track, pitch, time, dur, vel);
    };
    let wakeups = 0;
    const origSchedule = T._schedule;
    T._schedule = function () { wakeups++; return origSchedule.call(this); };
    const stall = setInterval(() => { const s = performance.now(); while (performance.now() - s < 40) { /* zátěž */ } }, 150);
    try {
      T.position = 0;
      T.play();
      await sleep(4000);
    } finally {
      clearInterval(stall);
      T.stop();
      E.playNote = origPlay;
      T._schedule = origSchedule;
      MB.State.project = saved;
    }
    const step = (PPQ / 4) * MB.secPerTick(p);
    const late = log.filter((e) => e.time < e.at);
    const maxErr = Math.max(...intervals(log).map((d) => Math.abs(d - step)));
    const minLead = Math.min(...log.map((e) => e.time - e.at));
    // 4 s při 150 BPM v šestnáctinách = 40 not (+ to, co je naplánované dopředu)
    assert(log.length >= 38 && log.length <= 43, `čekal ~40 not, zaznělo ${log.length}`);
    assert(late.length === 0, `${late.length} not přišlo pozdě`);
    assert(maxErr < 1e-9, `nepravidelný rozestup ${maxErr}`);
    return `${log.length} not, ${(wakeups / 4).toFixed(0)} probuzení/s, nejmenší předstih ${(minLead * 1000).toFixed(1)} ms, ` +
      `max chyba rozestupu ${maxErr.toExponential(1)} s, sample rate ${ctx.sampleRate} Hz`;
  });

  // ===========================================================================
  // Spouštěč
  // ===========================================================================

  async function runAll() {
    const ul = document.getElementById('results');
    ul.innerHTML = '';
    const results = [];
    for (const t of tests) {
      const li = document.createElement('li');
      li.className = 'run';
      li.innerHTML = `<div class="name"></div><div class="detail"></div>`;
      li.querySelector('.name').textContent = t.name;
      ul.appendChild(li);
      let ok = true, detail = '';
      try {
        detail = (await t.fn()) || '';
      } catch (err) {
        ok = false;
        detail = err && err.stack ? err.message : String(err);
        console.error(t.name, err);
      }
      li.className = ok ? 'pass' : 'fail';
      li.querySelector('.detail').textContent = detail;
      results.push({ name: t.name, ok, detail });
    }
    const passed = results.filter((r) => r.ok).length;
    document.getElementById('summary').textContent = `${passed} / ${results.length} testů prošlo`;
    window.__testResults = results;
    return results;
  }

  const btn = document.getElementById('run');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    MB.Engine.ensure(); // AudioContext musí vzniknout přímo v kliknutí
    try { await runAll(); } finally { btn.disabled = false; }
  });

  MB.tests = { test, assert, runAll, withFakeClock, sixteenthProject, rng };
})(window.MB);
