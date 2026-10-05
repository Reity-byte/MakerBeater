# MakerBeater

Webový hudební editor typu **piano roll / step sequencer** (inspirovaný BeepBoxem, BandLabem a piano rollem z FL Studia).
Čisté HTML, CSS a JavaScript, bez frameworků a bez build kroku. Zvuky se syntetizují přes Web Audio API,
jen klavíry hrají z nahrávek skutečného křídla (viz [Licence nahrávek](#licence-nahrávek)).

## Spuštění

**Online:** <https://reity-byte.github.io/MakerBeater/>. V Chrome nebo Edge jde pak nainstalovat jako aplikace
(ikona *Instalovat* v adresním řádku nebo *Projekt → Nainstalovat jako aplikaci*). Funguje i offline a sama se aktualizuje.

**Jako aplikace z disku (Windows):**

1. Dvojklikni na `Nainstalovat aplikaci.cmd`. Vytvoří zástupce **MakerBeater** na ploše, v nabídce Start
   (jde vyhledat) i ve složce projektu.
2. Zástupce otevře MakerBeater v samostatném okně Chrome (nebo Edge) v režimu aplikace: bez adresního řádku
   a záložek, přes celou obrazovku a s vlastní ikonou na hlavním panelu. **F11** přepne na celou obrazovku úplně.

**V prohlížeči:** stačí otevřít `index.html` (dvojklik). Server ani instalace nejsou potřeba.

Pak:

1. Klikni kamkoliv nebo stiskni klávesu. Prohlížeče dovolí zapnout zvuk až po akci uživatele.
2. Zmáčkni **mezerník**: zahraje ukázková skladba (A moll, bicí + bas + akordy + arpeggio + melodie).

Funguje v aktuálním Chrome, Edge, Firefoxu i Safari. Nejlíp v Chrome/Edge (nejrychlejší export do WAV).

## Sdílení

- **Jako soubor:** zabal složku do ZIPu (pravým tlačítkem → *Komprimovat do souboru ZIP*). Zástupce
  `MakerBeater.lnk` a složka `.claude` v něm být nemusí, jsou jen pro tvůj počítač. Pošli ho přes Discord,
  WhatsApp nebo Google Disk. Gmail soubory `.js` blokuje i uvnitř ZIPu.
- **Kamarád pak** ZIP rozbalí a otevře `index.html`. Ikonu aplikace si může přidat přes
  `Nainstalovat aplikaci.cmd`, jen u skriptu z internetu může Windows varovat
  (*Windows ochránil váš počítač* → *Další informace* → *Přesto spustit*).
- **Jako odkaz:** složku jde zdarma nahrát na web, třeba přes GitHub Pages nebo Netlify Drop. Aplikace pak jde
  otevřít i na mobilu nebo tabletu.
- **Jen skladbu:** *Projekt → Exportovat JSON*. Kamarád ji otevře přes *Importovat JSON* nebo přetažením
  souboru do okna.

## Co umí

- **Mřížka:** sloupce = čas, řádky = výška tónu (C1–C7). Klik vloží notu, tah ji přesune, tah za pravý okraj změní
  délku, pravé tlačítko nebo Delete maže. Vlevo je klaviatura, klik na ni zahraje tón.
- **Zvýraznění:** černé klávesy, tóny mimo stupnici (tmavší), základní tón stupnice (fialový), čáry po krocích,
  dobách a silnější po taktech. Noty ostatních stop jsou vidět jako průhlední „duchové“.
- **Stopy:** libovolný počet, každá má nástroj, hlasitost, panoramu, dozvuk, Mute, Solo, barvu a jméno.
- **Nástroje:** klavír (nahrávky křídla Yamaha C5), house piano (90s „M1“), lo-fi piano (kazeta),
  elektrické piano (Rhodes, FM), supersaw, bas, lead, pad, pluck, kytara (Karplus-Strong), varhany a zvonky (FM).
- **Bicí:** tři sady se stejnými řádky (jdou přepínat bez ztráty not): **808**, **909 (house)** a **breakbeat**
  (zvuk starého sampleru pro jungle a breakcore). Řádky: kick, snare, clap, rimshot, 3 tomy, hi-hat zavřený
  a otevřený, ride, crash, cowbell, shaker. Každý úder jde **přeladit** (−24 až +24 půltónů).
- **Efekty u stopy:** dozvuk, **sidechain** („pumpování“ do kopáku jako v house) a **zkreslení**.
- **Šablony:** *House starter pack* (125 BPM, 909, sidechain) a *Breakcore* (172 BPM, rozsekaný amen rytmus).
- **Přehrávání:** Play/Pauza/Stop, smyčka (oblast se nastaví tažením v pravítku), sledování kurzoru, změna tempa za běhu.
- **Tempo po úsecích:** v horním pruhu pravítka klik přidá změnu tempa od taktu, **skokem nebo postupně**
  (zrychlení / zpomalení za 1 dobu až 16 taktů), tah ji posune (Alt = po dobách), pravé tlačítko nebo prázdné
  pole ji smaže. Pruh ukazuje průběh tempa jako čáru. Pole **BPM** ukazuje a mění tempo úseku pod kurzorem.
- **Křivka hlasitosti stopy (K):** pruh pod mřížkou. Klik přidá bod, tah ho posune, pravé tlačítko smaže.
  Tlačítka **↗ náběh** a **↘ doznění** udělají plynulé zesílení z ticha / zeslabení do ticha v oblasti smyčky
  (tu nastavíš tažením v pravítku). Nové části skladby tak můžou nabíhat postupně místo „hned naplno“.
- **Hudební pomocníci:** stupnice (dur, moll, harmonická moll, pentatoniky, blues, dórská, chromatická),
  přichytávání ke stupnici, kvantizace (Q), takt 2/4 až 7/4, mřížka 1/4 až 1/64 včetně triol,
  rozsekání not na rychlé rolly (R).
- **Editace:** výběr obdélníkem, Ctrl+C/X/V, Ctrl+D, šipky (půltón nebo stupeň stupnice, Shift = oktáva/takt),
  síla úhozu vybraných not, Ctrl+Z / Ctrl+Y.
- **Ukládání:** automaticky do `localStorage`, export a import JSON (i přetažením souboru do okna),
  export do **WAV** (OfflineAudioContext) a živé nahrávání přes **MediaRecorder** (WebM/Ogg).
- **Ovládání myší i dotykem** (Pointer Events): ťuk = nota, tah = posun, dva prsty = zoom.

Všechny zkratky najdeš v aplikaci pod **?** nebo **F1**.

## Struktura projektu

```
index.html       rozložení stránky (lišta, seznam stop, editor, nápověda)
style.css        tmavý vzhled
Nainstalovat aplikaci.cmd   vytvoří zástupce aplikace (spouští app/nainstalovat.ps1)
app/             ikona aplikace a instalační skript zástupců
js/state.js      datový model, stupnice, undo/redo, localStorage, import/export JSON, sběrnice událostí
js/audio.js      Web Audio engine: nástroje, mix, scheduler, offline render, WAV, nahrávání
js/piano-samples.js  nahrávky klavíru (mp3 v base64, 2,4 MB, načítá se až po startu)
js/grid.js       piano roll: vykreslování na canvas, myš/dotyk, výběr, schránka, zoom
js/main.js       propojení UI: lišta, seznam stop, projekt, klávesové zkratky, smyčka překreslování
tests/test.html  automatické testy (otevři a klikni na „Spustit všechny testy“)
```

Skripty jsou obyčejné `<script>` (ne ES moduly), protože Chrome moduly z `file://` blokuje. Všechno visí
na jednom globálním objektu `window.MB` a moduly spolu mluví přes události `MB.on(...)` / `MB.emit(...)`.

## Architektura

**Tok dat.** Projekt se mění jen přes `State.change(fn, kind)`, při tažení myší přes `State.beginGesture()` …
`State.endGesture()`. Při každé změně:

1. uloží se snapshot pro undo (celé tažení = jeden krok),
2. rozešle se událost `change`, takže se překreslí mřížka, seznam stop a lišta a audio si srovná kanály,
3. za 0,4 s proběhne automatické uložení do `localStorage`.

**Audio řetězec.**

```
hlas → bus stopy → mute/solo → zkreslení → hlasitost → křivka hlasitosti → sidechain → panorama ─┬─→ master → kompresor → limiter → repro
                                                                                                  └─→ send → dozvuk (konvoluce) ─┘
```

**Scheduler** („A Tale of Two Clocks“). Časovač ve Web Workeru se probouzí každých 25 ms. Pokaždé naplánuje
všechny noty, které začínají v příštích 120 ms, s přesným časem `AudioContext.currentTime`. Zvuky tak spouští
audio vlákno s přesností na vzorek. Rytmus nerozhodí ani zaseknuté UI, ani karta na pozadí. Změny tempa a skoky
smyčky řeší „kotvy“ (čas ↔ tick).

**Export do WAV** používá stejné nástroje i master jako živé přehrávání, jen v `OfflineAudioContext`.
Render se po čtvrtsekundách pozastavuje a doplánovává noty, takže je i dlouhá skladba rychlá.

## Datový model

Projekt je obyčejný JSON (tak se i exportuje):

```json
{
  "version": 1,
  "name": "Můj beat",
  "bpm": 110,
  "bars": 8,
  "beatsPerBar": 4,
  "stepsPerBeat": 4,
  "scale": { "root": 9, "type": "minor" },
  "snapToScale": true,
  "loop": true, "loopStart": 0, "loopEnd": null,
  "tempoChanges": [ { "tick": 3072, "bpm": 140 }, { "tick": 4608, "bpm": 170, "ramp": 1536 } ],
  "tracks": [
    {
      "id": "k3f9a1x2", "name": "Bas", "instrument": "bass", "color": "#4dabf7",
      "volume": 0.8, "pan": 0, "reverb": 0.04, "mute": false, "solo": false,
      "volumeAuto": [ { "tick": 0, "value": 0 }, { "tick": 1536, "value": 1 } ],
      "notes": [ { "id": "x81kq0a9", "pitch": 45, "start": 0, "length": 72, "velocity": 0.9 } ]
    }
  ]
}
```

- **Čas je v ticích:** 1 doba (čtvrťová nota) = 96 tiků, 1/8 = 48, 1/16 = 24. Pozice not tak nezávisí na zvolené
  mřížce a jsou to vždy celá čísla.
- **`pitch`** je MIDI číslo (60 = C4). U bicí stopy je to číslo řádku (0 = kick, 1 = snare… viz `DRUM_ROWS`).
- **`loopEnd: null`** = smyčka až do konce skladby.
- **Tempo:** `bpm` platí od začátku, `tempoChanges` mění tempo od daného ticku dál (seřazené). `ramp` = přes
  kolik ticků se tempo na nové plynule rozjede (chybí = skokem). V rampě tempo roste lineárně s pozicí, takže
  `MB.tickToSec(p, tick)` počítá čas integrálem (logaritmus) – přesně, bez zaokrouhlování. Scheduler bere čas
  každé noty z mapy temp, změna tempa za běhu proto ovlivní jen to, co ještě není naplánované.
- **`volumeAuto`** = křivka hlasitosti stopy: body `{ tick, value }`, value 0–1 násobí hlasitost stopy, mezi body
  plynule. Při přehrávání se plánuje po úsecích na `GainNode` v kanálu stopy, při exportu celá předem.
- Při načtení (localStorage i import) projde projekt kontrolou `normalizeProject()`. Čísla se oříznou na rozumný
  rozsah, neznámý nástroj se nahradí klavírem a vadné noty se zahodí.

## Jak přidat nový nástroj

Nástroje jsou v registru v `js/audio.js` (sekce *Registr nástrojů*). Přidání je jedno volání `defineInstrument`.
Nový nástroj se pak sám objeví v nabídce **+ Stopa** i ve výběru nástroje u stopy.

```js
defineInstrument('flute', {
  name: 'Flétna',     // název v nabídce
  color: '#94d82d',   // barva nových stop
  volume: 0.75,       // výchozí hlasitost stopy (0–1)
  reverb: 0.3,        // výchozí dozvuk (0–1)
  center: 74,         // kolem které výšky (MIDI) se vycentruje mřížka
  play(ctx, dest, pitch, time, dur, vel) {
    const v = new Voice(ctx, dest);            // hlas = jedna nota
    const f = midiToFreq(pitch);
    const amp = v.gain(0);                     // hlasitost bude řídit obálka
    amp.connect(v.out);
    v.osc('sine', f).connect(amp);             // čistý tón
    v.osc('triangle', f * 2).connect(v.gain(0.08)).connect(amp);
    v.noise().connect(v.filter('bandpass', f * 2, 2)).connect(v.gain(0.05)).connect(amp); // dech
    const end = adsr(amp.gain, time, dur, { a: 0.06, d: 0.1, s: 0.8, r: 0.15 }, 0.35 * vel);
    return v.play(time, end);                  // spustí zdroje a naplánuje jejich konec
  },
});
```

Pravidla pro funkci `play`:

- `ctx` může být živý `AudioContext` i `OfflineAudioContext` (export), proto vždy používej předaný `ctx`, `time` a `dur`.
- Zdroje vytvářej přes `v.osc()`, `v.noise()` a `v.buffer()`. Hlas si je pamatuje, umí je zastavit při Stop
  a po doznění se sám odpojí.
- Všechno nakonec připoj do `v.out` a vrať `v.play(začátek, konec)`. Konec = kdy už je nota opravdu potichu,
  tedy včetně release.
- Hlasitost: jedna nota se silou 0,8 by měla mít špičku zhruba −6 až −10 dBFS. Test „Nástroje: každý zní…“
  v `tests/test.html` zkontroluje, že nový nástroj nemá NaN ani přebuzení.

**Nový bicí zvuk:** přidej řádek na konec `DRUM_ROWS`, funkci syntézy do `SYNTH_808` (ostatní sady ji zdědí,
nebo si ji přepíšou ve `SYNTH_909` / `SYNTH_BREAK`) a délku a hlasitost do `length` a `level` sad v `KITS`.
**Nová bicí sada** = nová položka v `KITS`. Bicí se při startu jednou vyrenderují do bufferů (kvůli výkonu)
a pak se jen přehrávají.

**Klavír** hraje z nahrávek v `js/piano-samples.js`: 25 tónů po malé tercii (C1–C7), mezilehlé tóny vzniknou
přeladěním té nejbližší o půltón. Nahrávky jsou v base64 uvnitř skriptu, protože z `file://` jde načíst skript,
ale ne mp3 přes `fetch`. Po dekódování se srovná hlasitost a stereo sousedních nahrávek (`decodePiano`).
Další piana nad nimi stačí postavit přes `playPiano(v, ctx, pitch, time, dur, vel, { level, filters })`
(viz *House piano* a *Lo-fi piano*). Než se nahrávky načtou (pár vteřin po startu), hraje záložní syntetický klavír.

**Nová stupnice:** přidej položku do `SCALES` v `js/state.js`, např. `mixolydian: { name: 'Mixolydická', steps: [0, 2, 4, 5, 7, 9, 10] }`.

## Testy

Otevři `tests/test.html` a klikni na **Spustit všechny testy** (živý audio test je potichu, pokud nezaškrtneš „nahlas“).
Testy ověří:

- přesnost scheduleru (simulované zasekávání UI, změna tempa, tempo po úsecích, smyčka, konec skladby),
- nástup noty přesně na vzorek,
- stupnice, undo/redo a kontrolu importu,
- export a import JSON beze ztráty,
- hlasitost všech nástrojů, vyrovnanost nahrávek klavíru, dusení hi-hatu, WAV export,
- živé přehrávání v AudioContextu.

## Tipy a omezení

- Automatické ukládání je v úložišti **konkrétního prohlížeče**. Na přenos nebo zálohu použij
  *Projekt → Exportovat JSON*. V anonymním okně se po zavření nic neuloží.
- Okno aplikace (zástupce MakerBeater) má **vlastní profil** prohlížeče ve složce `%LOCALAPPDATA%\MakerBeater`.
  Projekty rozpracované v něm tedy nevidíš v běžném prohlížeči a naopak. Přenést je jde přes export a import JSON.
- **Odinstalace:** smaž zástupce MakerBeater (plocha, nabídka Start, složka projektu) a složku
  `%LOCALAPPDATA%\MakerBeater` (v ní jsou i uložené projekty, takže si je předtím vyexportuj).
- Po přesunutí složky projektu spusť `Nainstalovat aplikaci.cmd` znovu, zástupci se opraví.
- Prohlížeče, které neumí pozastavit offline render (`OfflineAudioContext.suspend`, např. Firefox), exportují
  do WAV pomaleji. Výsledek je stejný.
- Nahrávání přes MediaRecorder ukládá WebM (Chrome, Firefox) nebo MP4/M4A (Safari) a nahrává i změny hlasitosti master.
  Export do WAV je bezeztrátový a nezávisí na rychlosti počítače.

## Licence nahrávek

Klavír používá **Salamander Grand Piano V3** od Alexandera Holma (nahráno na křídle Yamaha C5),
licence [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Zkrácené mp3 verze pocházejí z projektu
[Tone.js](https://github.com/Tonejs/audio). Při sdílení aplikace nebo skladeb s tímto klavírem stačí uvést autora.
Všechny ostatní zvuky jsou syntetické.
