/* MakerBeater – audio.js
 * Web Audio engine: mixážní řetězec, registr nástrojů a přesný scheduler.
 * Všechny zvuky jsou syntetické – žádné stažené samply.
 */
(function (MB) {
  'use strict';

  const { clamp } = MB;

  /** Jak daleko dopředu (s) scheduler plánuje noty. */
  const LOOKAHEAD = 0.12;
  /** Jak často (ms) se scheduler probouzí. Musí být výrazně kratší než LOOKAHEAD. */
  const TICK_MS = 25;

  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // ===========================================================================
  // Stavební kameny zvuku
  // ===========================================================================

  // Bílý šum: jeden 2s buffer na AudioContext, sdílí ho všechny nástroje.
  const noiseBuffers = new WeakMap();
  function getNoiseBuffer(ctx) {
    let buf = noiseBuffers.get(ctx);
    if (!buf) {
      buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noiseBuffers.set(ctx, buf);
    }
    return buf;
  }

  /**
   * Hlas = jedna znějící nota. Drží si všechny zdroje (oscilátory, šum, LFO),
   * aby je šlo při Stop ukončit, a výstupní gain, přes který jde celý zvuk.
   */
  class Voice {
    constructor(ctx, dest) {
      this.ctx = ctx;
      this.out = ctx.createGain();
      this.out.connect(dest);
      this.sources = [];
      this.startTime = 0;
      this.endTime = 0;
    }

    osc(type, freq, detune = 0) {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      if (detune) o.detune.value = detune;
      this.sources.push(o);
      return o;
    }

    /** Bílý šum. `length` (s) = jak dlouho ho nechat běžet (jinak celou notu). */
    noise(length) {
      const s = this.ctx.createBufferSource();
      s.buffer = getNoiseBuffer(this.ctx);
      s.loop = true;
      s._offset = Math.random() * 1.5; // pokaždé jiný kus šumu = přirozenější zvuk
      s._length = length || 0;
      this.sources.push(s);
      return s;
    }

    /** Přehrání předpočítaného bufferu (např. Karplus-Strong struna). */
    buffer(audioBuffer) {
      const s = this.ctx.createBufferSource();
      s.buffer = audioBuffer;
      this.sources.push(s);
      return s;
    }

    gain(value = 1) {
      const g = this.ctx.createGain();
      g.gain.value = value;
      return g;
    }

    filter(type, freq, q = 0.7) {
      const f = this.ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    }

    panner(value) {
      if (!this.ctx.createStereoPanner) return this.gain(1);
      const p = this.ctx.createStereoPanner();
      p.pan.value = value;
      return p;
    }

    /** Spustí všechny zdroje v čase `time` a zastaví je v čase `end`. */
    play(time, end) {
      this.startTime = time;
      this.endTime = end;
      for (const s of this.sources) {
        s.start(time, s._offset || 0);
        s.stop(s._length ? Math.min(end, time + s._length) : end);
      }
      // po doznění hlas odpojíme, ať se graf nezanáší
      const keeper = this.sources.find((s) => !s._length) || this.sources[0];
      if (keeper) keeper.onended = () => this.out.disconnect();
      return this;
    }

    /** Rychlé ztlumení (Stop, puštění klávesy). */
    cut(when) {
      const t = Math.max(when || 0, this.ctx.currentTime);
      if (this.endTime <= t) return;
      this.out.gain.cancelScheduledValues(t);
      this.out.gain.setTargetAtTime(0, t, 0.012);
      const stopAt = t + 0.1;
      for (const s of this.sources) {
        try { s.stop(stopAt); } catch (err) { /* zdroj už skončil */ }
      }
      this.endTime = stopAt;
    }
  }

  /**
   * ADSR obálka na AudioParam (obvykle gain).
   * a, d, r v sekundách, s = úroveň sustain (0–1). Vrací čas, kdy release dozní.
   * Když nota skončí ještě během náběhu, release jde z dosažené úrovně – jako u syntezátoru.
   */
  function adsr(param, time, dur, { a = 0.005, d = 0.1, s = 0.7, r = 0.1 } = {}, peak = 1) {
    a = Math.max(0.001, a);
    const end = time + Math.max(dur, 0.005);
    param.setValueAtTime(0, time);
    if (end <= time + a) {
      param.linearRampToValueAtTime(peak * (end - time) / a, end);
    } else {
      param.linearRampToValueAtTime(peak, time + a);
      param.setTargetAtTime(peak * s, time + a, Math.max(0.001, d / 3));
    }
    param.setTargetAtTime(0, end, Math.max(0.001, r / 5));
    return end + r;
  }

  // ===========================================================================
  // Master a stopy
  // ===========================================================================

  /** Syntetická impulzní odezva pro dozvuk: šum, který exponenciálně doznívá a tmavne. */
  function makeImpulse(ctx, seconds = 2.6, decay = 3) {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const pre = Math.floor(sr * 0.012); // předzpoždění 12 ms
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / (len - pre);
        const k = 0.65 - 0.55 * t; // čím později, tím tmavší (víc filtrovaný) šum
        lp += k * ((Math.random() * 2 - 1) - lp);
        d[i] = lp * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  function setParams(node, values) {
    for (const [k, v] of Object.entries(values)) node[k].value = v;
  }

  /** Master řetězec – stejný pro živé přehrávání i pro export do WAV. */
  function buildMaster(ctx) {
    const input = ctx.createGain();
    input.gain.value = 0.5;

    const comp = ctx.createDynamicsCompressor();
    setParams(comp, { threshold: -18, knee: 12, ratio: 3, attack: 0.005, release: 0.25 });
    const limiter = ctx.createDynamicsCompressor();
    setParams(limiter, { threshold: -2, knee: 0, ratio: 20, attack: 0.001, release: 0.1 });
    const output = ctx.createGain();

    input.connect(comp);
    comp.connect(limiter);
    limiter.connect(output);
    output.connect(ctx.destination);

    // Dozvuk jako „send“ efekt – každá stopa si řekne, kolik do něj pošle.
    const reverbIn = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 200; // basy do dozvuku neposíláme – zbytečně by kalily
    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(ctx);
    const reverbOut = ctx.createGain();
    reverbOut.gain.value = 0.8;
    reverbIn.connect(hp);
    hp.connect(convolver);
    convolver.connect(reverbOut);
    reverbOut.connect(input);

    return { input, output, reverbIn, comp, limiter };
  }

  /** Kanál jedné stopy: bus → mute/solo → hlasitost → panorama → master (+ send do dozvuku). */
  function createStrip(ctx, master) {
    const bus = ctx.createGain();      // sem hrají noty ze sekvenceru
    const mute = ctx.createGain();     // mute / solo
    const preview = ctx.createGain();  // náhledy při editaci – obchází mute
    const volume = ctx.createGain();
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    const send = ctx.createGain();
    bus.connect(mute);
    mute.connect(volume);
    preview.connect(volume);
    volume.connect(panner);
    panner.connect(master.input);
    panner.connect(send);
    send.connect(master.reverbIn);
    return { bus, mute, preview, volume, panner, send, state: {}, applied: {} };
  }

  function disconnectStrip(strip) {
    for (const node of [strip.bus, strip.mute, strip.preview, strip.volume, strip.panner, strip.send]) {
      try { node.disconnect(); } catch (err) { /* nic */ }
    }
  }

  /** Hlasitost 0–1 → zesílení. Kvadratická křivka odpovídá lépe vnímání sluchu. */
  const volumeToGain = (v) => v * v;
  const isAudible = (track, anySolo) => !track.mute && (!anySolo || track.solo);

  function applyStrip(ctx, strip, track, audible, instant) {
    const t = ctx.currentTime;
    const set = (key, param, value) => {
      if (strip.applied[key] === value) return; // bez zbytečných automatizací
      strip.applied[key] = value;
      if (instant) param.setValueAtTime(value, t);
      else param.setTargetAtTime(value, t, 0.015);
    };
    set('mute', strip.mute.gain, audible ? 1 : 0);
    set('volume', strip.volume.gain, volumeToGain(clamp(track.volume, 0, 1)));
    if (strip.panner.pan) set('pan', strip.panner.pan, clamp(track.pan, -1, 1));
    set('send', strip.send.gain, clamp(track.reverb || 0, 0, 1) * 0.8);
  }

  // ===========================================================================
  // Registr nástrojů
  // ===========================================================================
  // Každý nástroj = objekt s metadaty a funkcí
  //   play(ctx, dest, pitch, time, dur, vel, state) → Voice
  // ctx může být AudioContext i OfflineAudioContext (export do WAV),
  // `state` je objekt, který si stopa drží mezi notami (např. dusení hi-hatu).

  const Instruments = {};

  function defineInstrument(id, def) {
    def.id = id;
    def.kind = def.kind || 'melodic';
    Instruments[id] = def;
    return def;
  }

  const getInstrument = (id) => Instruments[id] || Instruments.piano;

  // ---------------------------------------------------------------------------
  // Klavír: FM úder kladívka + dvě „struny“, rychlý útlum závislý na výšce tónu
  // ---------------------------------------------------------------------------
  defineInstrument('piano', {
    name: 'Klavír',
    color: '#ffd43b',
    volume: 0.8,
    reverb: 0.22,
    center: 64,
    play(ctx, dest, pitch, time, dur, vel) {
      const v = new Voice(ctx, dest);
      const f = midiToFreq(pitch);
      const ring = clamp(3.2 - (pitch - 36) * 0.045, 0.6, 3.2); // hluboké tóny znějí déle
      const peak = 0.4 * (0.35 + 0.65 * vel);
      const end = time + dur;

      // Barva: low-pass se postupně zavírá – struna ztrácí vyšší alikvóty.
      const tone = v.filter('lowpass', Math.min(16000, f * (5 + 9 * vel)), 0.4);
      tone.frequency.setTargetAtTime(Math.min(9000, f * 2.5 + 500), time + 0.01, ring * 0.25);
      const amp = v.gain(0);
      tone.connect(amp).connect(v.out);

      // FM pár 1:1 – tvrdý úder kladívka, který během ~0,1 s změkne.
      const car = v.osc('sine', f);
      const mod = v.osc('sine', f);
      const depth = v.gain(0);
      depth.gain.setValueAtTime(f * (0.8 + 1.6 * vel), time);
      depth.gain.setTargetAtTime(f * 0.1, time, 0.1);
      mod.connect(depth).connect(car.frequency);
      car.connect(tone);

      // Druhá struna lehce rozladěná (chorus) + tichý alikvót o oktávu výš.
      v.osc('triangle', f, 3).connect(v.gain(0.3)).connect(tone);
      v.osc('sine', f * 2, -4).connect(v.gain(0.1 + 0.1 * vel)).connect(tone);

      // Obálka: náběh 4 ms → rychlý pokles → dlouhé doznívání → dusítko po puštění klávesy.
      const g = amp.gain;
      g.setValueAtTime(0, time);
      g.linearRampToValueAtTime(peak, time + 0.004);
      g.setTargetAtTime(peak * 0.45, time + 0.004, 0.08);
      if (end > time + 0.25) g.setTargetAtTime(0, time + 0.25, ring / 3);
      g.setTargetAtTime(0, Math.max(end, time + 0.004), 0.05);
      const stop = Math.min(Math.max(end, time + 0.004) + 0.3, time + 0.25 + ring * 1.7);
      return v.play(time, Math.max(stop, time + 0.05));
    },
  });

  // ---------------------------------------------------------------------------
  // Bas: trojúhelník + sinus (+ trocha pily pro „hryzání“), low-pass s obálkou
  // ---------------------------------------------------------------------------
  defineInstrument('bass', {
    name: 'Bas',
    color: '#4dabf7',
    volume: 0.8,
    reverb: 0.04,
    center: 43,
    play(ctx, dest, pitch, time, dur, vel) {
      const v = new Voice(ctx, dest);
      const f = midiToFreq(pitch);
      const open = Math.min(f * 14 + 300, 5000) * (0.5 + 0.5 * vel);
      const lp = v.filter('lowpass', open, 4);
      lp.frequency.setValueAtTime(open, time);
      lp.frequency.setTargetAtTime(Math.max(f * 2.2, 140), time + 0.005, 0.08);
      const amp = v.gain(0);
      lp.connect(amp).connect(v.out);
      v.osc('triangle', f).connect(v.gain(0.9)).connect(lp);
      v.osc('sine', f).connect(v.gain(0.8)).connect(lp);
      v.osc('sawtooth', f, 4).connect(v.gain(0.18)).connect(lp);
      const end = adsr(amp.gain, time, dur, { a: 0.004, d: 0.3, s: 0.6, r: 0.07 }, 0.25 * (0.4 + 0.6 * vel));
      return v.play(time, end + 0.02);
    },
  });

  // ---------------------------------------------------------------------------
  // Lead: dvě rozladěné pily + čtverec o oktávu níž, rezonanční filtr, vibrato
  // ---------------------------------------------------------------------------
  defineInstrument('lead', {
    name: 'Lead',
    color: '#b197fc',
    volume: 0.75,
    reverb: 0.25,
    center: 74,
    play(ctx, dest, pitch, time, dur, vel) {
      const v = new Voice(ctx, dest);
      const f = midiToFreq(pitch);
      const base = 900 + 2600 * vel;
      const lp = v.filter('lowpass', base * 2.2, 5);
      lp.frequency.setValueAtTime(base * 2.2, time);
      lp.frequency.setTargetAtTime(base, time + 0.01, 0.12);
      const amp = v.gain(0);
      lp.connect(amp).connect(v.out);

      // vibrato: LFO 5,5 Hz do ladění oscilátorů – nabíhá až po chvíli, jako u zpěváka
      const lfo = v.osc('sine', 5.5);
      const depth = v.gain(0);
      depth.gain.setValueAtTime(0, time);
      depth.gain.setTargetAtTime(14, time + 0.22, 0.15); // ±14 centů
      lfo.connect(depth);
      for (const [type, freq, detune, g] of [['sawtooth', f, -7, 0.45], ['sawtooth', f, 7, 0.45], ['square', f / 2, 0, 0.22]]) {
        const o = v.osc(type, freq, detune);
        depth.connect(o.detune);
        o.connect(v.gain(g)).connect(lp);
      }
      const end = adsr(amp.gain, time, dur, { a: 0.01, d: 0.25, s: 0.75, r: 0.12 }, 0.47 * (0.5 + 0.5 * vel));
      return v.play(time, end + 0.02);
    },
  });

  // ---------------------------------------------------------------------------
  // Pad: pomalý náběh, čtyři rozladěné pily rozložené do sterea, filtr se pomalu otevírá
  // ---------------------------------------------------------------------------
  defineInstrument('pad', {
    name: 'Pad',
    color: '#38d9a9',
    volume: 0.7,
    reverb: 0.45,
    center: 60,
    play(ctx, dest, pitch, time, dur, vel) {
      const v = new Voice(ctx, dest);
      const f = midiToFreq(pitch);
      const open = 900 + 1400 * vel;
      const lp = v.filter('lowpass', open * 0.5, 1);
      lp.frequency.setValueAtTime(open * 0.5, time);
      lp.frequency.setTargetAtTime(open, time, 0.35); // zvuk se během náběhu „rozjasní“
      const amp = v.gain(0);
      lp.connect(amp).connect(v.out);
      // dvě pily vlevo, dvě vpravo (rozladěné proti sobě = široký „chorus“)
      for (const [pan, detunes] of [[-0.6, [-14, 5]], [0.6, [-5, 14]]]) {
        const side = v.gain(0.22);
        for (const d of detunes) v.osc('sawtooth', f, d).connect(side);
        side.connect(v.panner(pan)).connect(lp);
      }
      v.osc('triangle', f * 2, 3).connect(v.gain(0.12)).connect(lp); // třpyt o oktávu výš
      const end = adsr(amp.gain, time, dur, { a: 0.45, d: 0.8, s: 0.85, r: 0.9 }, 0.56 * (0.6 + 0.4 * vel));
      return v.play(time, end + 0.05);
    },
  });

  // ---------------------------------------------------------------------------
  // Pluck: pila + čtverec, filtr se rychle zavře, hlasitost rychle odezní
  // ---------------------------------------------------------------------------
  defineInstrument('pluck', {
    name: 'Pluck',
    color: '#ff922b',
    volume: 0.75,
    reverb: 0.3,
    center: 67,
    play(ctx, dest, pitch, time, dur, vel) {
      const v = new Voice(ctx, dest);
      const f = midiToFreq(pitch);
      const decay = clamp(0.9 - (pitch - 48) * 0.012, 0.25, 0.9);
      const open = Math.min(16000, f * 10 + 2500 * vel);
      const lp = v.filter('lowpass', open, 2);
      lp.frequency.setValueAtTime(open, time);
      lp.frequency.setTargetAtTime(f * 1.5 + 200, time, decay * 0.18);
      const amp = v.gain(0);
      lp.connect(amp).connect(v.out);
      v.osc('sawtooth', f, -4).connect(v.gain(0.5)).connect(lp);
      v.osc('square', f, 4).connect(v.gain(0.3)).connect(lp);
      v.osc('sine', f).connect(v.gain(0.4)).connect(lp);
      const end = adsr(amp.gain, time, dur, { a: 0.002, d: decay, s: 0, r: 0.08 }, 0.58 * (0.4 + 0.6 * vel));
      return v.play(time, Math.min(end, time + decay * 1.7 + 0.05) + 0.02);
    },
  });

  // ---------------------------------------------------------------------------
  // Kytara: Karplus-Strong – syntéza struny ze šumu (zpožďovací smyčka + filtr).
  // Vzorek se spočítá jednou pro každou výšku tónu a uloží do cache.
  // ---------------------------------------------------------------------------
  const ksCache = new Map();

  function karplusStrong(sampleRate, pitch) {
    const f = midiToFreq(pitch);
    const t60 = clamp(4.2 - (pitch - 40) * 0.065, 0.9, 4.2); // doba doznění na -60 dB
    const n = Math.floor(sampleRate * Math.min(t60, 3.5));
    const data = new Float32Array(n);
    const D = sampleRate / f - 0.5; // délka smyčky (0,5 vzorku přidá průměrovací filtr)
    const iD = Math.floor(D);
    const fr = D - iD;
    const g = Math.pow(0.001, 1 / (t60 * f)); // útlum za jednu periodu
    const exc = Math.min(iD + 2, n);
    let lp = 0;
    for (let i = 0; i < exc; i++) { // vybuzení = trochu vyhlazený šum (trsátko)
      lp += 0.6 * (Math.random() * 2 - 1 - lp);
      data[i] = lp;
    }
    for (let i = exc; i < n; i++) {
      // hodnota zpožděná o D a D+1 vzorků (lineární interpolace) → průměr = low-pass
      const a = data[i - iD - 1] * fr + data[i - iD] * (1 - fr);
      const b = data[i - iD - 2] * fr + data[i - iD - 1] * (1 - fr);
      data[i] = g * 0.5 * (a + b);
    }
    // odstranění stejnosměrné složky + normalizace
    let prevX = 0;
    let prevY = 0;
    let peak = 1e-9;
    for (let i = 0; i < n; i++) {
      const y = data[i] - prevX + 0.995 * prevY;
      prevX = data[i];
      prevY = y;
      data[i] = y;
      peak = Math.max(peak, Math.abs(y));
    }
    for (let i = 0; i < n; i++) data[i] *= 0.9 / peak;
    return data;
  }

  function ksBuffer(ctx, pitch) {
    const key = `${ctx.sampleRate}:${pitch}`;
    let buf = ksCache.get(key);
    if (buf) {
      ksCache.delete(key); // LRU: posuneme na konec
    } else {
      const data = karplusStrong(ctx.sampleRate, pitch);
      buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.getChannelData(0).set(data);
      if (ksCache.size > 48) ksCache.delete(ksCache.keys().next().value);
    }
    ksCache.set(key, buf);
    return buf;
  }

  defineInstrument('guitar', {
    name: 'Kytara',
    color: '#a9e34b',
    volume: 0.8,
    reverb: 0.25,
    center: 57,
    play(ctx, dest, pitch, time, dur, vel) {
      const v = new Voice(ctx, dest);
      const buf = ksBuffer(ctx, pitch);
      const src = v.buffer(buf);
      const tone = v.filter('lowpass', 1800 + 9000 * vel, 0.5); // silnější úhoz = jasnější tón
      const amp = v.gain(0);
      src.connect(tone).connect(amp).connect(v.out);
      const end = time + dur;
      amp.gain.setValueAtTime(1.0 * (0.35 + 0.65 * vel), time);
      amp.gain.setTargetAtTime(0, end, 0.05); // po konci noty struna ztlumena dlaní
      return v.play(time, Math.min(end + 0.3, time + buf.duration));
    },
  });

  // ---------------------------------------------------------------------------
  // Varhany: aditivní syntéza „rejstříků“ (sinusy na násobcích) + tremolo
  // ---------------------------------------------------------------------------
  defineInstrument('organ', {
    name: 'Varhany',
    color: '#ffa8a8',
    volume: 0.7,
    reverb: 0.3,
    center: 60,
    play(ctx, dest, pitch, time, dur, vel) {
      const v = new Voice(ctx, dest);
      const f = midiToFreq(pitch);
      const mix = v.gain(1);
      for (const [mult, g] of [[0.5, 0.5], [1, 0.8], [2, 0.45], [3, 0.25], [4, 0.2]]) {
        if (f * mult < 12000) v.osc('sine', f * mult).connect(v.gain(g)).connect(mix);
      }
      const trem = v.gain(1);
      v.osc('sine', 5.8).connect(v.gain(0.12)).connect(trem.gain);
      const amp = v.gain(0);
      mix.connect(trem).connect(amp).connect(v.out);
      const end = adsr(amp.gain, time, dur, { a: 0.008, d: 0.05, s: 1, r: 0.06 }, 0.16 * (0.6 + 0.4 * vel));
      return v.play(time, end + 0.02);
    },
  });

  // ---------------------------------------------------------------------------
  // Zvonky: FM syntéza s neharmonickým poměrem 3,5 → kovový, zvonivý tón
  // ---------------------------------------------------------------------------
  defineInstrument('bell', {
    name: 'Zvonky',
    color: '#66d9e8',
    volume: 0.75,
    reverb: 0.4,
    center: 76,
    play(ctx, dest, pitch, time, dur, vel) {
      const v = new Voice(ctx, dest);
      const f = midiToFreq(pitch);
      const ring = clamp(2.8 - (pitch - 60) * 0.04, 0.8, 3);
      const amp = v.gain(0);
      amp.connect(v.out);
      const car = v.osc('sine', f);
      const mod = v.osc('sine', f * 3.5);
      const index = v.gain(0);
      index.gain.setValueAtTime(f * 3 * (0.5 + vel), time);
      index.gain.setTargetAtTime(f * 0.2, time, ring * 0.2);
      mod.connect(index).connect(car.frequency);
      car.connect(amp);
      v.osc('sine', f * 2.001).connect(v.gain(0.15)).connect(amp);
      const g = amp.gain;
      const end = Math.max(time + dur, time + 0.003);
      g.setValueAtTime(0, time);
      g.linearRampToValueAtTime(0.33 * (0.4 + 0.6 * vel), time + 0.003);
      g.setTargetAtTime(0, time + 0.003, ring / 4);
      g.setTargetAtTime(0, end, 0.3); // po konci noty doznívá rychleji
      return v.play(time, Math.min(time + 0.003 + ring * 1.3, end + 1.5));
    },
  });

  // ---------------------------------------------------------------------------
  // Bicí: každý řádek mřížky je jiný nástroj. Vše syntetické (808 styl).
  // ---------------------------------------------------------------------------
  const DRUM_ROWS = [
    { id: 'kick', name: 'Kick' },
    { id: 'snare', name: 'Snare' },
    { id: 'clap', name: 'Clap' },
    { id: 'rim', name: 'Rimshot' },
    { id: 'tomLow', name: 'Tom hluboký' },
    { id: 'tomMid', name: 'Tom střední' },
    { id: 'tomHigh', name: 'Tom vysoký' },
    { id: 'hatClosed', name: 'Hi-hat zavřený' },
    { id: 'hatOpen', name: 'Hi-hat otevřený' },
    { id: 'ride', name: 'Ride' },
    { id: 'crash', name: 'Crash' },
    { id: 'cowbell', name: 'Cowbell' },
  ];
  const DRUM_INDEX = Object.fromEntries(DRUM_ROWS.map((d, i) => [d.id, i]));

  // Křivka měkkého zkreslení (tanh) – kicku dodá „punch“
  let softClipCurve = null;
  function softClip(ctx) {
    if (!softClipCurve) {
      softClipCurve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const x = (i / 1023) * 2 - 1;
        softClipCurve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
      }
    }
    const ws = ctx.createWaveShaper();
    ws.curve = softClipCurve;
    return ws;
  }

  /** Úderová obálka: rychlý náběh a exponenciální útlum s časovou konstantou tau. */
  function hit(param, t, peak, tau, attack = 0.001) {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + attack);
    param.setTargetAtTime(0, t + attack, tau);
  }

  /** Krátký šum přes filtr – základ virblu, tlesknutí, činelů. */
  function noiseHit(v, t, { type = 'highpass', freq = 2000, q = 0.7, peak, tau, length }) {
    const n = v.noise(length || tau * 7);
    const f = v.filter(type, freq, q);
    const g = v.gain(0);
    hit(g.gain, t, peak, tau);
    n.connect(f).connect(g);
    return g;
  }

  // „Kov“ 808: šest čtvercových oscilátorů na neharmonických frekvencích přes pásmovou propust
  const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];
  function metal(v, t, vel, { tau, mult = 1, bp = 10000, hp = 7000, peak = 1 }) {
    const mix = v.gain(1 / 6);
    for (const f of METAL) v.osc('square', f * mult).connect(mix);
    const g = v.gain(0);
    hit(g.gain, t, vel * peak, tau);
    mix.connect(v.filter('bandpass', bp, 0.8)).connect(v.filter('highpass', hp, 0.7)).connect(g);
    return g;
  }

  /** Otevřený hi-hat ztichne, když zahraje zavřený (jako u skutečné soupravy). */
  function chokeHats(state, t) {
    if (!state.openHats) return;
    state.openHats = state.openHats.filter((h) => {
      if (h.start < t && h.end > t) {
        h.node.gain.setValueAtTime(h.level, t);
        h.node.gain.linearRampToValueAtTime(0, t + 0.02);
        return false;
      }
      return h.end > t;
    });
  }

  function tom(v, t, vel, f0) {
    const o = v.osc('sine', f0);
    o.frequency.setValueAtTime(f0 * 1.6, t);
    o.frequency.exponentialRampToValueAtTime(f0, t + 0.09);
    const g = v.gain(0);
    hit(g.gain, t, vel * 0.85, 0.15, 0.003);
    o.connect(g).connect(v.out);
    noiseHit(v, t, { type: 'bandpass', freq: f0 * 5, q: 1, peak: vel * 0.25, tau: 0.015 }).connect(v.out);
  }

  /** Syntéza jednotlivých bicích – každá funkce postaví zvuk do hlasu v. */
  const DRUM_SYNTH = {
    kick(v, t, vel) {
      const o = v.osc('sine', 155);
      o.frequency.setValueAtTime(155, t);
      o.frequency.exponentialRampToValueAtTime(48, t + 0.11); // rychle klesající výška
      const g = v.gain(0);
      hit(g.gain, t, vel * 0.95, 0.13, 0.002);
      o.connect(softClip(v.ctx)).connect(g).connect(v.out);
      noiseHit(v, t, { freq: 1800, peak: vel * 0.3, tau: 0.006 }).connect(v.out); // klik paličky
    },
    snare(v, t, vel) {
      const body = v.osc('triangle', 220);
      body.frequency.setValueAtTime(220, t);
      body.frequency.exponentialRampToValueAtTime(160, t + 0.06);
      const bg = v.gain(0);
      hit(bg.gain, t, vel * 0.7, 0.035);
      body.connect(bg).connect(v.out);
      noiseHit(v, t, { freq: 1400, peak: vel * 0.6, tau: 0.055 }).connect(v.out); // struník
    },
    clap(v, t, vel) {
      const n = v.noise(0.4);
      const g = v.gain(0);
      // tři rychlá „tlesknutí“ těsně po sobě a pak doznění
      for (const dt of [0, 0.011, 0.022]) {
        g.gain.setValueAtTime(vel * 0.9, t + dt);
        g.gain.setTargetAtTime(vel * 0.12, t + dt + 0.001, 0.004);
      }
      g.gain.setValueAtTime(vel * 0.8, t + 0.033);
      g.gain.setTargetAtTime(0, t + 0.033, 0.07);
      n.connect(v.filter('bandpass', 1300, 1.1)).connect(v.filter('highpass', 700)).connect(g).connect(v.out);
    },
    rim(v, t, vel) {
      const bp = v.filter('bandpass', 1900, 2.5);
      v.osc('triangle', 1700).connect(bp);
      v.osc('square', 520).connect(v.gain(0.4)).connect(bp);
      const g = v.gain(0);
      hit(g.gain, t, vel * 0.7, 0.012);
      bp.connect(g).connect(v.out);
    },
    tomLow: (v, t, vel) => tom(v, t, vel, 95),
    tomMid: (v, t, vel) => tom(v, t, vel, 135),
    tomHigh: (v, t, vel) => tom(v, t, vel, 190),
    hatClosed(v, t, vel) {
      metal(v, t, vel, { tau: 0.018, peak: 1.6 }).connect(v.out);
      noiseHit(v, t, { freq: 8000, peak: vel * 0.18, tau: 0.02 }).connect(v.out);
    },
    hatOpen(v, t, vel) {
      metal(v, t, vel, { tau: 0.16, peak: 1.3 }).connect(v.out);
      noiseHit(v, t, { freq: 8000, peak: vel * 0.16, tau: 0.15 }).connect(v.out);
    },
    ride(v, t, vel) {
      metal(v, t, vel, { tau: 0.45, mult: 1.45, bp: 8000, hp: 5000, peak: 1.1 }).connect(v.out);
      const pg = v.gain(0);
      hit(pg.gain, t, vel * 0.05, 0.3);
      v.osc('sine', 3520).connect(pg).connect(v.out); // „cink“ zvonu činelu
    },
    crash(v, t, vel) {
      metal(v, t, vel, { tau: 0.6, mult: 1.2, bp: 7000, hp: 4000, peak: 1 }).connect(v.out);
      noiseHit(v, t, { freq: 5000, q: 0.5, peak: vel * 0.35, tau: 0.55, length: 2.8 }).connect(v.out);
    },
    cowbell(v, t, vel) {
      const mix = v.gain(0.5);
      v.osc('square', 540).connect(mix);
      v.osc('square', 800).connect(mix);
      const g = v.gain(0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel * 0.5, t + 0.001);
      g.gain.setTargetAtTime(vel * 0.15, t + 0.001, 0.015);
      g.gain.setTargetAtTime(0, t + 0.05, 0.1);
      mix.connect(v.filter('bandpass', 1100, 1.4)).connect(g).connect(v.out);
    },
  };

  /** Délka zvuku (s) – po ní je hlas ticho. */
  const DRUM_LENGTH = {
    kick: 0.8, snare: 0.4, clap: 0.45, rim: 0.12, tomLow: 0.9, tomMid: 0.9, tomHigh: 0.9,
    hatClosed: 0.16, hatOpen: 1, ride: 1.8, crash: 2.8, cowbell: 0.7,
  };

  /** Vyvážení hlasitostí jednotlivých bicích (změřeno offline renderem). */
  const DRUM_LEVEL = {
    kick: 0.85, snare: 0.8, clap: 2, rim: 1, tomLow: 0.8, tomMid: 0.8, tomHigh: 0.8,
    hatClosed: 1.6, hatOpen: 1.6, ride: 1.7, crash: 1, cowbell: 2,
  };

  // ---------------------------------------------------------------------------
  // Předrenderovaná bicí sada
  // ---------------------------------------------------------------------------
  // Syntéza hi-hatu nebo činelu (6 oscilátorů + filtry) je pro procesor drahá a
  // v rychlých rytmech jich zní spousta naráz. Proto se každý zvuk při startu jednou
  // vyrenderuje (stejnou syntézou jako výše) do AudioBufferu a pak se jen přehrává.
  // Šumové zvuky mají víc variant, ať opakované údery nezní strojově.

  const DRUM_VARIANTS = { snare: 2, clap: 2, hatClosed: 3, hatOpen: 2 };
  const drumKits = new Map(); // sampleRate → { buffers, promise }

  function prepareDrumKit(sampleRate) {
    let kit = drumKits.get(sampleRate);
    if (!kit) {
      kit = { buffers: null, promise: null };
      drumKits.set(sampleRate, kit);
      kit.promise = renderDrumKit(sampleRate)
        .then((buffers) => { kit.buffers = buffers; })
        .catch((err) => console.warn('[MB] bicí nejdou předrenderovat, hraje živá syntéza', err))
        .then(() => kit);
    }
    return kit.promise;
  }

  async function renderDrumKit(sampleRate) {
    // všechny zvuky za sebou do jednoho offline kontextu, pak výsledek rozstříháme
    const slots = [];
    let time = 0;
    for (const row of DRUM_ROWS) {
      for (let k = 0; k < (DRUM_VARIANTS[row.id] || 1); k++) {
        slots.push({ id: row.id, start: time });
        time += DRUM_LENGTH[row.id] + 0.02;
      }
    }
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(1, Math.ceil(time * sampleRate), sampleRate);
    for (const s of slots) {
      const v = new Voice(ctx, ctx.destination);
      DRUM_SYNTH[s.id](v, s.start, 1);
      v.play(s.start, s.start + DRUM_LENGTH[s.id]);
    }
    const data = (await ctx.startRendering()).getChannelData(0);
    const buffers = {};
    for (const s of slots) {
      const from = Math.round(s.start * sampleRate);
      const n = Math.round(DRUM_LENGTH[s.id] * sampleRate);
      const buf = ctx.createBuffer(1, n, sampleRate);
      buf.getChannelData(0).set(data.subarray(from, from + n));
      (buffers[s.id] = buffers[s.id] || []).push(buf);
    }
    return buffers;
  }

  defineInstrument('drums', {
    name: 'Bicí',
    kind: 'drums',
    color: '#ff6b6b',
    volume: 0.85,
    reverb: 0.08,
    rows: DRUM_ROWS,
    play(ctx, dest, row, time, dur, vel, state = {}) {
      const def = DRUM_ROWS[row];
      if (!def) return null;
      const id = def.id;
      const v = new Voice(ctx, dest);
      v.out.gain.value = DRUM_LEVEL[id];
      if (id === 'hatClosed' || id === 'hatOpen') chokeHats(state, time);
      if (id === 'hatOpen') {
        state.openHats = (state.openHats || []).concat({ node: v.out, level: DRUM_LEVEL[id], start: time, end: time + DRUM_LENGTH[id] });
      }
      const kit = drumKits.get(ctx.sampleRate);
      if (kit && kit.buffers) { // rychlá cesta: předrenderovaný úder
        const variants = kit.buffers[id];
        v.buffer(variants[Math.floor(Math.random() * variants.length)]).connect(v.gain(vel)).connect(v.out);
      } else {                  // sada ještě není hotová → živá syntéza
        DRUM_SYNTH[id](v, time, vel);
      }
      return v.play(time, time + DRUM_LENGTH[id]);
    },
  });

  // ===========================================================================
  // Engine – živý AudioContext, kanály stop a znějící hlasy
  // ===========================================================================

  const Engine = {
    ctx: null,
    master: null,
    strips: new Map(), // id stopy → kanál
    voices: [],        // hlasy, které ještě znějí nebo jsou naplánované
    masterVolume: 0.9,

    /** Vytvoří / probudí AudioContext. Volat z uživatelské akce (klik, klávesa). */
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.master = buildMaster(this.ctx);
        this.master.output.gain.value = this.masterVolume;
        this.ctx.onstatechange = () => MB.emit('audiostate', this.ctx.state);
        MB.emit('audiostate', this.ctx.state);
        prepareDrumKit(this.ctx.sampleRate); // na pozadí; do té doby bicí syntetizujeme živě
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },

    get running() {
      return !!this.ctx && this.ctx.state === 'running';
    },

    setMasterVolume(v) {
      this.masterVolume = clamp(v, 0, 1);
      if (this.ctx) this.master.output.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.02);
    },

    /** Srovná kanály se stopami projektu (nové vytvoří, smazané odpojí, nastaví hlasitosti). */
    syncTracks(project) {
      if (!this.ctx || !project) return;
      const anySolo = project.tracks.some((t) => t.solo);
      const alive = new Set();
      for (const track of project.tracks) {
        alive.add(track.id);
        let strip = this.strips.get(track.id);
        if (!strip) {
          strip = createStrip(this.ctx, this.master);
          this.strips.set(track.id, strip);
          applyStrip(this.ctx, strip, track, isAudible(track, anySolo), true);
        } else {
          applyStrip(this.ctx, strip, track, isAudible(track, anySolo), false);
        }
      }
      for (const [id, strip] of this.strips) {
        if (!alive.has(id)) {
          disconnectStrip(strip);
          this.strips.delete(id);
        }
      }
    },

    _strip(track) {
      if (!this.strips.has(track.id)) this.syncTracks(MB.State.project);
      return this.strips.get(track.id) || null;
    },

    /** Naplánuje notu stopy na přesný čas AudioContextu. */
    playNote(track, pitch, time, dur, vel) {
      const strip = this._strip(track);
      if (!strip) return null;
      const voice = getInstrument(track.instrument).play(this.ctx, strip.bus, pitch, time, dur, vel, strip.state);
      if (voice) this.voices.push(voice);
      return voice;
    },

    /**
     * Okamžitý náhled tónu (klik na klávesu / vložení noty). Zní i u ztlumené stopy.
     * Při úplně prvním kliknutí se AudioContext teprve rozbíhá – nota zazní hned, jak naběhne.
     */
    preview(track, pitch, dur = 0.4, vel = 0.8) {
      if (!this.ctx || this.ctx.state === 'closed') return null;
      const strip = this._strip(track);
      if (!strip) return null;
      const t = this.ctx.currentTime + 0.005;
      const voice = getInstrument(track.instrument).play(this.ctx, strip.preview, pitch, t, dur, vel, {});
      if (voice) this.voices.push(voice);
      return voice;
    },

    /** Umlčí vše, co zní nebo je naplánované (Stop / Pauza / skok). */
    silence() {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      for (const v of this.voices) v.cut(now);
      this.voices = [];
      for (const strip of this.strips.values()) strip.state = {};
    },

    pruneVoices() {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      if (this.voices.length > 64) this.voices = this.voices.filter((v) => v.endTime > now);
    },

    /**
     * Nahrávání toho, co právě zní (MediaRecorder). Vrací objekt se stop(),
     * který vrátí Promise s Blobem (webm/ogg podle prohlížeče).
     */
    startRecording() {
      const ctx = this.ensure();
      if (typeof MediaRecorder === 'undefined' || !ctx.createMediaStreamDestination) {
        throw new Error('Tenhle prohlížeč neumí nahrávat zvuk (chybí MediaRecorder).');
      }
      const dest = ctx.createMediaStreamDestination();
      this.master.output.connect(dest);
      const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
      const rec = new MediaRecorder(dest.stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const done = new Promise((resolve) => {
        rec.onstop = () => {
          try { this.master.output.disconnect(dest); } catch (err) { /* nic */ }
          resolve(new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' }));
        };
      });
      rec.start(250);
      return {
        mimeType: rec.mimeType || mimeType,
        stop() {
          if (rec.state !== 'inactive') rec.stop();
          return done;
        },
      };
    },
  };

  // ===========================================================================
  // Transport + scheduler („A Tale of Two Clocks“)
  // ===========================================================================
  // Časovač (Web Worker, aby ho prohlížeč nebrzdil na pozadí) každých 25 ms
  // probudí scheduler. Ten naplánuje všechny noty, které začínají v příštích
  // 120 ms, s přesným časem AudioContext.currentTime. Samotné zvuky tedy
  // spouští audio vlákno s přesností na vzorek, ne JavaScriptový časovač.

  function createTicker(callback) {
    let worker = null;
    let timer = null;
    let running = false;
    const fallback = () => {
      clearInterval(timer);
      timer = setInterval(callback, TICK_MS);
    };
    try {
      const code = `let id = null;
        onmessage = (e) => {
          clearInterval(id); id = null;
          if (e.data === 'start') id = setInterval(() => postMessage(0), ${TICK_MS});
        };`;
      worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      worker.onmessage = callback;
      worker.onerror = () => {
        worker = null;
        if (running) fallback();
      };
    } catch (err) {
      worker = null; // např. přísné zabezpečení – použijeme obyčejný setInterval
    }
    return {
      start() {
        running = true;
        if (worker) worker.postMessage('start');
        else fallback();
      },
      stop() {
        running = false;
        if (worker) worker.postMessage('stop');
        clearInterval(timer);
        timer = null;
      },
    };
  }

  const Transport = {
    playing: false,
    position: 0,      // tick kurzoru, když se nehraje
    playStartTick: 0, // odkud se naposledy začalo hrát (Stop se sem vrací)
    nextTick: 0,      // první tick, který ještě není naplánovaný
    anchors: [],      // kotvy {time, tick, spt} pro převod čas ↔ tick (smyčka, změna tempa)
    endTime: Infinity,
    ticker: null,

    get project() {
      return MB.State.project;
    },

    play() {
      const ctx = Engine.ensure();
      if (this.playing) return;
      const p = this.project;
      Engine.syncTracks(p);
      const songEnd = MB.songTicks(p);
      const [loopStart, loopEnd] = MB.loopRange(p);
      let tick = clamp(this.position, 0, songEnd);
      if (p.loop && tick >= loopEnd) tick = loopStart;
      if (!p.loop && tick >= songEnd) tick = 0;

      const spt = MB.secPerTick(p);
      const t0 = ctx.currentTime + 0.05; // malá rezerva, ať první nota nepřijde pozdě
      this.playing = true;
      this.playStartTick = tick;
      this.nextTick = tick;
      this.endTime = Infinity;
      this.anchors = [{ time: t0, tick, spt }];
      this._chaseNotes(p, tick, t0, spt);
      if (!this.ticker) this.ticker = createTicker(() => this._schedule());
      this.ticker.start();
      this._schedule();
      MB.emit('transport', 'play');
    },

    /** Zastaví a nechá kurzor tam, kde se hrálo. */
    pause() {
      if (!this.playing) return;
      this.position = clamp(this.currentTick(), 0, MB.songTicks(this.project));
      this._halt(true);
      MB.emit('transport', 'pause');
    },

    /** Zastaví a vrátí kurzor na místo, odkud se začalo hrát. Druhé Stop = na začátek. */
    stop() {
      if (this.playing) {
        this._halt(true);
        this.position = this.playStartTick;
      } else {
        this.position = this.project.loop ? MB.loopRange(this.project)[0] : 0;
      }
      MB.emit('transport', 'stop');
    },

    /** Mezerník: Play / Stop. */
    toggle() {
      if (this.playing) this.stop();
      else this.play();
    },

    seek(tick) {
      const tickClamped = clamp(Math.round(tick), 0, MB.songTicks(this.project));
      if (this.playing) {
        this._halt(true);
        this.position = tickClamped;
        this.play();
      } else {
        this.position = tickClamped;
        MB.emit('transport', 'seek');
      }
    },

    /** Aktuální pozice přehrávání v ticích (s ohledem na latenci výstupu). */
    currentTick() {
      if (!this.playing || !Engine.ctx) return this.position;
      const ctx = Engine.ctx;
      const t = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
      let a = this.anchors[0];
      for (let i = 1; i < this.anchors.length; i++) {
        if (this.anchors[i].time <= t) a = this.anchors[i];
        else break;
      }
      return a.tick + Math.max(0, t - a.time) / a.spt;
    },

    /** Volá se z requestAnimationFrame – záložní buzení scheduleru + konec skladby. */
    update() {
      if (!this.playing) return;
      this._schedule();
      if (Engine.ctx.currentTime >= this.endTime) {
        this._halt(false); // dozvuky necháme doznít
        this.position = this.playStartTick;
        MB.emit('transport', 'end');
      }
    },

    _halt(silence) {
      this.playing = false;
      if (this.ticker) this.ticker.stop();
      if (silence) Engine.silence();
    },

    /** Naplánuje vše, co začíná před (teď + LOOKAHEAD). */
    _schedule() {
      if (!this.playing) return;
      const ctx = Engine.ctx;
      const p = this.project;
      const horizon = ctx.currentTime + LOOKAHEAD;

      for (let guard = 0; guard < 64; guard++) {
        let a = this.anchors[this.anchors.length - 1];
        const nextTime = a.time + (this.nextTick - a.tick) * a.spt;
        if (nextTime >= horizon) break;

        const spt = MB.secPerTick(p);
        if (spt !== a.spt) { // změna tempa za běhu – nová kotva
          a = { time: nextTime, tick: this.nextTick, spt };
          this.anchors.push(a);
        }

        const [loopStart, loopEnd] = MB.loopRange(p);
        const regionEnd = p.loop ? loopEnd : MB.songTicks(p);
        if (this.nextTick >= regionEnd) {
          if (!p.loop) { // konec skladby – další noty už neplánujeme
            this.endTime = Math.min(this.endTime, nextTime);
            break;
          }
          this.nextTick = loopStart; // skok na začátek smyčky
          this.anchors.push({ time: nextTime, tick: loopStart, spt });
          this.endTime = Infinity;
          continue;
        }

        const toTick = Math.min(regionEnd, this.nextTick + (horizon - nextTime) / spt);
        this._scheduleRange(p, this.nextTick, toTick, a, regionEnd);
        this.nextTick = toTick;
      }

      // staré kotvy zahodíme (vždy necháme aspoň jednu, která už nastala)
      const old = ctx.currentTime - 1;
      while (this.anchors.length > 1 && this.anchors[1].time <= old) this.anchors.shift();
      Engine.pruneVoices();
    },

    /** Noty se začátkem v intervalu [from, to) – čas se počítá přesně z kotvy. */
    _scheduleRange(p, from, to, anchor, regionEnd) {
      const events = [];
      for (const track of p.tracks) {
        for (const n of track.notes) {
          if (n.start >= from && n.start < to) events.push([track, n]);
        }
      }
      // chronologicky (kvůli nástrojům se stavem, např. dusení hi-hatu)
      if (events.length > 1) events.sort((x, y) => x[1].start - y[1].start);
      for (const [track, n] of events) {
        const time = anchor.time + (n.start - anchor.tick) * anchor.spt;
        const len = Math.min(n.length, regionEnd - n.start); // na konci smyčky notu ořízneme
        Engine.playNote(track, n.pitch, time, len * anchor.spt, n.velocity);
      }
    },

    /** Při startu uprostřed dlouhé noty (např. pad) ji dohrajeme od aktuální pozice. */
    _chaseNotes(p, tick, time, spt) {
      for (const track of p.tracks) {
        if (getInstrument(track.instrument).kind !== 'melodic') continue;
        for (const n of track.notes) {
          if (n.start < tick && n.start + n.length > tick + 1) {
            Engine.playNote(track, n.pitch, time, (n.start + n.length - tick) * spt, n.velocity);
          }
        }
      }
    },
  };

  // ===========================================================================
  // Offline render celé skladby (export do WAV)
  // ===========================================================================

  /**
   * Vyrenderuje projekt do AudioBufferu přes OfflineAudioContext – stejné nástroje,
   * stejný mix i master jako při živém přehrávání, jen rychleji než v reálném čase.
   *
   * Noty se neplánují všechny najednou: tisíce čekajících uzlů by render brzdily.
   * Render se po sekundách pozastaví (suspend), naplánují se noty na další úsek
   * a doznělé hlasy se odpojí – stejný princip jako živý scheduler.
   */
  async function renderProject(project, { sampleRate = 44100, tail = 3, onProgress, chunk = 0.25 } = {}) {
    await prepareDrumKit(sampleRate);
    const spt = MB.secPerTick(project);
    const songEnd = MB.songTicks(project);
    const t0 = 0.02;
    const seconds = t0 + songEnd * spt + tail;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(2, Math.ceil(seconds * sampleRate), sampleRate);
    const master = buildMaster(ctx);
    const anySolo = project.tracks.some((t) => t.solo);

    const events = [];
    for (const track of project.tracks) {
      if (!isAudible(track, anySolo)) continue;
      const strip = createStrip(ctx, master);
      applyStrip(ctx, strip, track, true, true);
      const inst = getInstrument(track.instrument);
      for (const n of track.notes) {
        if (n.start >= songEnd) continue;
        const len = Math.min(n.length, songEnd - n.start);
        events.push({ time: t0 + n.start * spt, dur: len * spt, n, inst, strip });
      }
    }
    events.sort((a, b) => a.time - b.time);

    let next = 0;
    let voices = [];
    const scheduleUntil = (until) => {
      while (next < events.length && events[next].time < until) {
        const e = events[next++];
        const v = e.inst.play(ctx, e.strip.bus, e.n.pitch, e.time, e.dur, e.n.velocity, e.strip.state);
        if (v) voices.push(v);
      }
    };

    const CHUNK = chunk; // s – po kolika sekundách se render pozastaví a doplánuje
    if (typeof ctx.suspend === 'function') {
      scheduleUntil(2 * CHUNK);
      for (let t = CHUNK; t < seconds - 0.05; t += CHUNK) {
        ctx.suspend(t).then(() => {
          scheduleUntil(t + 2 * CHUNK);
          voices = voices.filter((v) => {
            if (v.endTime > t) return true;
            v.out.disconnect(); // doznělý hlas z grafu pryč
            return false;
          });
          if (onProgress) onProgress(t / seconds);
          ctx.resume();
        });
      }
    } else {
      scheduleUntil(Infinity); // prohlížeč bez offline suspend (Firefox) – vše najednou
    }
    return ctx.startRendering();
  }

  /** AudioBuffer → WAV (16 bit PCM). Ticho na konci (dozvuk už doznělo) se ořízne. */
  function encodeWav(buffer) {
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    let length = buffer.length;
    const threshold = 0.0003; // ≈ -70 dB
    while (length > 1 && channels.every((d) => Math.abs(d[length - 1]) < threshold)) length--;
    length = Math.min(buffer.length, length + Math.floor(buffer.sampleRate * 0.1));

    const numCh = channels.length;
    const blockAlign = numCh * 2;
    const dataSize = length * blockAlign;
    const view = new DataView(new ArrayBuffer(44 + dataSize));
    const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);          // velikost fmt bloku
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);          // bitů na vzorek
    str(36, 'data');
    view.setUint32(40, dataSize, true);
    let off = 44;
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return new Blob([view.buffer], { type: 'audio/wav' });
  }

  Object.assign(MB, {
    LOOKAHEAD, TICK_MS,
    renderProject, encodeWav,
    midiToFreq, adsr, Voice, getNoiseBuffer,
    Instruments, defineInstrument, getInstrument, DRUM_ROWS, DRUM_INDEX, prepareDrumKit,
    buildMaster, createStrip, applyStrip, isAudible,
    Engine, Transport,
  });
})(window.MB = window.MB || {});
