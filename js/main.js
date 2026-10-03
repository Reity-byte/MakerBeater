/* MakerBeater – main.js
 * Propojení UI: horní lišta, seznam stop, projekt (import/export), klávesové
 * zkratky, stavový řádek a smyčka překreslování.
 */
(function (MB) {
  'use strict';

  const { State, Engine, Transport, Grid, PPQ, clamp } = MB;
  const $ = (id) => document.getElementById(id);

  State.init();
  const savedUi = State.loadUi();
  if (typeof savedUi.masterVolume === 'number') Engine.masterVolume = clamp(savedUi.masterVolume, 0, 1);

  // ---------------------------------------------------------------------------
  // Zvuk se smí spustit až po první akci uživatele (autoplay policy prohlížečů)
  // ---------------------------------------------------------------------------

  function unlockAudio() {
    Engine.ensure();
    Engine.syncTracks(State.project);
  }
  window.addEventListener('pointerdown', unlockAudio, true);
  window.addEventListener('keydown', unlockAudio, true);
  MB.on('audiostate', () => { $('audioHint').hidden = Engine.running; });

  // ---------------------------------------------------------------------------
  // Oznámení (toasty) a stahování souborů
  // ---------------------------------------------------------------------------

  function toast(message, { type = 'info', timeout = 3500, progress = false } = {}) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const msg = document.createElement('div');
    msg.textContent = message;
    el.appendChild(msg);
    let bar = null;
    if (progress) {
      const b = document.createElement('div');
      b.className = 'bar';
      bar = document.createElement('i');
      b.appendChild(bar);
      el.appendChild(b);
    }
    $('toasts').appendChild(el);
    const api = {
      set(text) { msg.textContent = text; return api; },
      progress(x) { if (bar) bar.style.width = `${Math.round(clamp(x, 0, 1) * 100)}%`; return api; },
      close(delay = 0) {
        setTimeout(() => {
          el.classList.add('out');
          setTimeout(() => el.remove(), 220);
        }, delay);
      },
    };
    if (timeout) api.close(timeout);
    return api;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /** Název souboru z názvu projektu: „Noční jízda“ → „nocni-jizda“. */
  function fileBase() {
    return (State.project.name || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')
      .toLowerCase() || 'makerbeater';
  }

  // ---------------------------------------------------------------------------
  // Editor
  // ---------------------------------------------------------------------------

  Grid.init({
    editor: $('editor'),
    ruler: $('rulerCanvas'),
    keys: $('keysCanvas'),
    wrap: $('gridWrap'),
    canvas: $('gridCanvas'),
    scroll: $('gridScroll'),
    spacer: $('gridSpacer'),
  });
  if (savedUi.beatW) {
    Grid.setView(savedUi.beatW, savedUi.rowHeight);
    Grid.centerOnTrack();
  } else {
    Grid.fitToSong();
  }

  MB.on('change', (kind) => {
    Engine.syncTracks(State.project);
    syncToolbar();
    if (kind === 'tracks' || kind === 'all') renderTracks();
    else refreshTracks();
    if (kind !== 'mixer') scheduleMinis();
    updateCorner();
    updateStatus();
  });

  MB.on('track', () => {
    refreshTracks();
    updateCorner();
    updateStatus();
    const el = trackList.querySelector('.track.active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  });

  MB.on('selection', updateStatus);
  MB.on('history', syncHistory);

  let zoomTimer = 0;
  MB.on('zoom', () => {
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => State.saveUi({ beatW: Grid.beatW, rowHeight: Grid.rowHeight }), 300);
  });

  // ---------------------------------------------------------------------------
  // Horní lišta
  // ---------------------------------------------------------------------------

  $('btnPlay').addEventListener('click', () => (Transport.playing ? Transport.pause() : Transport.play()));
  $('btnStop').addEventListener('click', () => Transport.stop());
  $('btnLoop').addEventListener('click', toggleLoop);

  function toggleLoop() {
    State.change((p) => { p.loop = !p.loop; }, 'project');
  }

  /** Číselné pole: hodnotu zkontroluje, ořízne a zapíše do projektu. */
  function bindNumber(id, key, lo, hi, fallback) {
    $(id).addEventListener('change', (e) => {
      const v = clamp(Math.round(+e.target.value) || fallback, lo, hi);
      if (v !== State.project[key]) State.change((p) => { p[key] = v; }, 'project');
      else e.target.value = v;
    });
  }
  bindNumber('inpBpm', 'bpm', 30, 300, 120);
  bindNumber('inpBars', 'bars', 1, 128, 8);

  $('selMeter').addEventListener('change', (e) => {
    State.change((p) => { p.beatsPerBar = +e.target.value; }, 'project');
  });

  $('selStep').addEventListener('change', (e) => {
    State.change((p) => { p.stepsPerBeat = +e.target.value; }, 'project');
    Grid.resetLastLength();
  });

  // Stupnice: základní tón (v češtině se B říká H) a typ
  $('selRoot').innerHTML = MB.NOTE_NAMES.map((n, i) => `<option value="${i}">${n === 'B' ? 'B (H)' : n}</option>`).join('');
  $('selScale').innerHTML = Object.entries(MB.SCALES).map(([id, s]) => `<option value="${id}">${s.name}</option>`).join('');
  $('selRoot').addEventListener('change', (e) => {
    State.change((p) => { p.scale = { root: +e.target.value, type: p.scale.type }; }, 'project');
  });
  $('selScale').addEventListener('change', (e) => {
    State.change((p) => { p.scale = { root: p.scale.root, type: e.target.value }; }, 'project');
  });
  $('btnSnap').addEventListener('click', toggleSnap);

  function toggleSnap() {
    State.change((p) => { p.snapToScale = !p.snapToScale; }, 'project');
    const p = State.project;
    if (p.snapToScale && !MB.scaleActive(p)) toast('Přichytávání funguje, až vybereš jinou než chromatickou stupnici.');
  }

  document.querySelectorAll('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  function setTool(tool) {
    State.ui.tool = tool;
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
    Grid.markDirty();
    updateStatus();
    State.saveUi();
  }

  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);

  function undo() {
    if (!Grid.dragging && !State.undo()) toast('Není co vrátit.');
  }

  function redo() {
    if (!Grid.dragging && !State.redo()) toast('Není co opakovat.');
  }

  function syncHistory() {
    $('btnUndo').disabled = !State.canUndo;
    $('btnRedo').disabled = !State.canRedo;
  }

  $('btnZoomXIn').addEventListener('click', () => Grid.zoomX(1.25));
  $('btnZoomXOut').addEventListener('click', () => Grid.zoomX(0.8));
  $('btnZoomYIn').addEventListener('click', () => Grid.zoomY(1.2));
  $('btnZoomYOut').addEventListener('click', () => Grid.zoomY(1 / 1.2));
  $('btnFollow').addEventListener('click', toggleFollow);
  $('btnGhosts').addEventListener('click', toggleGhosts);

  function toggleFollow() {
    State.ui.follow = !State.ui.follow;
    syncToolbar();
    State.saveUi();
  }

  function toggleGhosts() {
    State.ui.ghosts = !State.ui.ghosts;
    Grid.markDirty();
    syncToolbar();
    State.saveUi();
  }

  $('masterVol').value = Engine.masterVolume;
  $('masterVol').addEventListener('input', (e) => Engine.setMasterVolume(+e.target.value));
  $('masterVol').addEventListener('change', (e) => State.saveUi({ masterVolume: +e.target.value }));

  $('btnTracks').addEventListener('click', () => document.body.classList.toggle('tracks-open'));

  function syncToolbar() {
    const p = State.project;
    if (document.activeElement !== $('inpBpm')) $('inpBpm').value = p.bpm;
    if (document.activeElement !== $('inpBars')) $('inpBars').value = p.bars;
    $('selMeter').value = String(p.beatsPerBar);
    $('selStep').value = String(p.stepsPerBeat);
    $('selRoot').value = String(p.scale.root);
    $('selScale').value = p.scale.type;
    $('selRoot').disabled = !MB.scaleActive(p);
    $('btnSnap').classList.toggle('on', p.snapToScale);
    $('btnLoop').classList.toggle('on', p.loop);
    $('btnFollow').classList.toggle('on', State.ui.follow);
    $('btnGhosts').classList.toggle('on', State.ui.ghosts);
    document.title = `${p.name} – MakerBeater`;
  }

  // ---------------------------------------------------------------------------
  // Projekt: nový / demo / import / export / nahrávání
  // ---------------------------------------------------------------------------

  const projectMenu = $('projectMenu');

  $('btnProject').addEventListener('click', () => {
    projectMenu.hidden = !projectMenu.hidden;
    if (!projectMenu.hidden) $('inpName').value = State.project.name;
  });

  $('inpName').addEventListener('change', (e) => {
    const name = e.target.value.trim().slice(0, 80) || 'Bez názvu';
    State.change((p) => { p.name = name; }, 'project');
  });

  projectMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    projectMenu.hidden = true;
    switch (b.dataset.action) {
      case 'new':
        if (confirm('Začít nový prázdný projekt? Ten současný jde vrátit přes Ctrl+Z.')) openProject(MB.createEmptyProject());
        break;
      case 'demo':
        openProject(MB.createDemoProject());
        break;
      case 'house':
        openProject(MB.createHouseProject());
        toast('House starter pack: 125 BPM, bicí 909, sidechain na basu, piano a pad. Ctrl+Z vrátí předchozí projekt.', { type: 'ok', timeout: 6000 });
        break;
      case 'breakcore':
        openProject(MB.createBreakcoreProject());
        toast('Breakcore: 172 BPM, rozsekaný amen rytmus a rolly virblu. Zkus vybrat údery a klávesu R nebo posuvník Ladění.', { type: 'ok', timeout: 7000 });
        break;
      case 'import':
        $('fileImport').click();
        break;
      case 'export-json':
        download(new Blob([State.exportJSON()], { type: 'application/json' }), `${fileBase()}.json`);
        toast(`Projekt uložen jako ${fileBase()}.json`, { type: 'ok' });
        break;
      case 'export-wav':
        exportWav();
        break;
      case 'record':
        toggleRecording();
        break;
      case 'install':
        installApp();
        break;
      default:
        break;
    }
  });

  function openProject(project) {
    Transport.stop();
    Transport.position = 0;
    State.loadProject(project);
    Grid.fitToSong();
  }

  async function importFile(file) {
    if (!file) return;
    try {
      const textValue = await file.text();
      Transport.stop();
      Transport.position = 0;
      const p = State.importJSON(textValue);
      Grid.fitToSong();
      toast(`Načteno: ${p.name} (${p.tracks.length} stop)`, { type: 'ok' });
    } catch (err) {
      toast(`Import se nepovedl: ${err.message}`, { type: 'error', timeout: 6000 });
    }
  }

  $('fileImport').addEventListener('change', (e) => {
    importFile(e.target.files[0]);
    e.target.value = ''; // ať jde stejný soubor načíst znovu
  });

  // Přetažení .json souboru do okna = import
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    if (/\.json$/i.test(file.name) || file.type === 'application/json') importFile(file);
    else toast('Přetáhni sem soubor projektu .json.', { type: 'error' });
  });

  let exporting = false;
  async function exportWav() {
    if (exporting) return;
    exporting = true;
    const t = toast('Renderuji skladbu do WAV…', { timeout: 0, progress: true });
    try {
      const buffer = await MB.renderProject(State.project, { onProgress: (x) => t.progress(x) });
      t.progress(1).set('Ukládám WAV…');
      const blob = MB.encodeWav(buffer);
      download(blob, `${fileBase()}.wav`);
      t.set(`Hotovo: ${fileBase()}.wav (${(blob.size / 1048576).toFixed(1)} MB)`);
      t.close(3000);
    } catch (err) {
      console.error(err);
      t.close();
      toast(`Export se nepovedl: ${err.message}`, { type: 'error', timeout: 6000 });
    } finally {
      exporting = false;
    }
  }

  // Nahrávání přes MediaRecorder: začne přehrávat od začátku, Stop nahrávání ukončí
  let recording = null;
  let recordEndTimer = 0;

  function toggleRecording() {
    if (recording) {
      Transport.stop(); // posluchač 'transport' nahrávání uloží
      return;
    }
    Transport.stop();
    try {
      recording = Engine.startRecording();
    } catch (err) {
      toast(err.message, { type: 'error', timeout: 6000 });
      return;
    }
    $('recBadge').hidden = false;
    $('btnRecord').textContent = 'Zastavit nahrávání';
    $('btnRecord').classList.add('recording');
    Transport.seek(State.project.loop ? MB.loopRange(State.project)[0] : 0);
    Transport.play();
    toast('Nahrávám… Stop nebo mezerník nahrávání ukončí.');
  }

  async function finishRecording() {
    clearTimeout(recordEndTimer);
    const rec = recording;
    recording = null;
    if (!rec) return;
    $('recBadge').hidden = true;
    $('btnRecord').textContent = 'Nahrát živě (MediaRecorder)';
    $('btnRecord').classList.remove('recording');
    const blob = await rec.stop();
    const ext = /ogg/.test(blob.type) ? 'ogg' : /mp4/.test(blob.type) ? 'm4a' : 'webm';
    download(blob, `${fileBase()}.${ext}`);
    toast(`Nahrávka uložena: ${fileBase()}.${ext}`, { type: 'ok' });
  }

  MB.on('transport', (state) => {
    if (!recording) return;
    if (state === 'stop' || state === 'pause') finishRecording();
    else if (state === 'end') recordEndTimer = setTimeout(finishRecording, 2500); // ať doznějí dozvuky
    else if (state === 'play') clearTimeout(recordEndTimer);
  });

  // Ukládání do prohlížeče – stav ve stavovém řádku
  MB.on('saved', () => {
    const el = $('saveState');
    el.classList.remove('error');
    el.textContent = `Uloženo ${new Date(State.lastSaved).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}`;
  });
  let saveErrorShown = false;
  MB.on('saveerror', () => {
    const el = $('saveState');
    el.classList.add('error');
    el.textContent = 'Neuloženo!';
    if (!saveErrorShown) {
      saveErrorShown = true;
      toast('Prohlížeč nedovolil uložit projekt (soukromé okno nebo plné úložiště). Zálohuj přes Projekt → Exportovat JSON.', { type: 'error', timeout: 9000 });
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') State.flushSave();
  });

  // ---------------------------------------------------------------------------
  // Instalace jako aplikace (PWA) – jen na webu; ze souboru (file://) prohlížeč nedovolí
  // ---------------------------------------------------------------------------

  let installPrompt = null;
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = 'manifest.webmanifest';
    document.head.appendChild(link);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[MB] service worker', err));
    }
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); // nabídku ukážeme v menu Projekt
      installPrompt = e;
      document.querySelectorAll('.install-only').forEach((el) => { el.hidden = false; });
    });
    window.addEventListener('appinstalled', () => {
      installPrompt = null;
      document.querySelectorAll('.install-only').forEach((el) => { el.hidden = true; });
      toast('MakerBeater je nainstalovaný – najdeš ho na ploše a v nabídce Start.', { type: 'ok' });
    });
  }

  async function installApp() {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
  }

  // ---------------------------------------------------------------------------
  // Nápověda
  // ---------------------------------------------------------------------------

  const helpDialog = $('helpDialog');
  function toggleHelp() {
    if (helpDialog.open) helpDialog.close();
    else helpDialog.showModal();
  }
  $('btnHelp').addEventListener('click', toggleHelp);
  helpDialog.addEventListener('click', (e) => { if (e.target === helpDialog) helpDialog.close(); }); // klik vedle

  // ---------------------------------------------------------------------------
  // Seznam stop (vlevo)
  // ---------------------------------------------------------------------------

  const trackList = $('trackList');

  // Nabídka nástrojů (data z našeho registru, ne od uživatele → innerHTML je tu bezpečné)
  const instruments = Object.values(MB.Instruments);
  const optionsOf = (kind) => instruments.filter((d) => d.kind === kind)
    .map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
  const INSTRUMENT_OPTIONS = `<optgroup label="Melodické">${optionsOf('melodic')}</optgroup>` +
    `<optgroup label="Bicí">${optionsOf('drums')}</optgroup>`;

  const TRACK_HTML = `
    <div class="track-head">
      <label class="swatch" title="Barva stopy"><input type="color" class="t-color" tabindex="-1"></label>
      <span class="track-name" title="Dvojklik = přejmenovat"></span>
      <button class="tbtn t-mute" title="Ztlumit (Mute)">M</button>
      <button class="tbtn t-solo" title="Sólo – hrají jen sólové stopy">S</button>
    </div>
    <canvas class="track-mini"></canvas>
    <div class="track-body">
      <select class="t-inst" title="Nástroj">${INSTRUMENT_OPTIONS}</select>
      <label class="slider-row" title="Dvojklik = výchozí hodnota"><span>Hlasitost</span><input type="range" class="t-vol" min="0" max="1" step="0.01"><output></output></label>
      <label class="slider-row" title="Dvojklik = střed"><span>Panorama</span><input type="range" class="t-pan" min="-1" max="1" step="0.01"><output></output></label>
      <label class="slider-row" title="Dvojklik = výchozí hodnota"><span>Dozvuk</span><input type="range" class="t-rev" min="0" max="1" step="0.01"><output></output></label>
      <label class="slider-row" title="Ztlumení při každém kopáku – „pumpování“ jako v house (dvojklik = vypnout)"><span>Sidechain</span><input type="range" class="t-sc" min="0" max="1" step="0.01"><output></output></label>
      <label class="slider-row" title="Zkreslení – špinavější, agresivnější zvuk (dvojklik = vypnout)"><span>Zkreslení</span><input type="range" class="t-drv" min="0" max="1" step="0.01"><output></output></label>
      <div class="track-actions">
        <button class="tbtn wide t-dup" title="Duplikovat stopu i s notami">Duplikovat</button>
        <button class="tbtn wide t-del" title="Smazat stopu">Smazat</button>
      </div>
    </div>`;

  const fmtPan = (v) => (Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100));

  /** Kompletní přestavba seznamu (přidání / smazání / přejmenování stopy, undo…). */
  function renderTracks() {
    const cur = State.currentTrack();
    trackList.textContent = '';
    for (const t of State.project.tracks) {
      const el = document.createElement('div');
      el.className = 'track';
      el.dataset.id = t.id;
      el.innerHTML = TRACK_HTML;
      trackList.appendChild(el);
      updateTrackEl(el, t, t === cur);
    }
    scheduleMinis();
  }

  /** Aktualizace hodnot bez přestavby DOM (posuvník, který zrovna táhneš, zůstane živý). */
  function refreshTracks() {
    const cur = State.currentTrack();
    for (const el of trackList.children) {
      const t = State.trackById(el.dataset.id);
      if (t) updateTrackEl(el, t, t === cur);
    }
  }

  function updateTrackEl(el, t, active) {
    const anySolo = State.project.tracks.some((x) => x.solo);
    el.classList.toggle('active', active);
    el.classList.toggle('silent', !MB.isAudible(t, anySolo));
    el.style.setProperty('--track-color', t.color);
    el.querySelector('.track-name').textContent = t.name;
    el.querySelector('.t-color').value = t.color;
    el.querySelector('.t-mute').classList.toggle('on', t.mute);
    el.querySelector('.t-solo').classList.toggle('on', t.solo);
    el.querySelector('.t-inst').value = t.instrument;
    setSlider(el.querySelector('.t-vol'), t.volume, String(Math.round(t.volume * 100)));
    setSlider(el.querySelector('.t-pan'), t.pan, fmtPan(t.pan));
    setSlider(el.querySelector('.t-rev'), t.reverb, String(Math.round(t.reverb * 100)));
    setSlider(el.querySelector('.t-sc'), t.sidechain || 0, String(Math.round((t.sidechain || 0) * 100)));
    setSlider(el.querySelector('.t-drv'), t.drive || 0, String(Math.round((t.drive || 0) * 100)));
    el.querySelector('.t-del').disabled = State.project.tracks.length <= 1;
  }

  function setSlider(input, value, textValue) {
    if (+input.value !== value) input.value = value;
    input.nextElementSibling.textContent = textValue;
  }

  // Miniatury not v každé stopě (překreslují se nejvýš jednou za snímek)
  let minisQueued = false;
  function scheduleMinis() {
    if (minisQueued) return;
    minisQueued = true;
    requestAnimationFrame(drawMinis);
  }

  function drawMinis() {
    minisQueued = false;
    const p = State.project;
    const total = MB.songTicks(p);
    const dpr = window.devicePixelRatio || 1;
    for (const el of trackList.children) {
      const t = State.trackById(el.dataset.id);
      const c = el.querySelector('.track-mini');
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (!t || !w || !h) continue;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.fillStyle = 'rgba(255, 255, 255, 0.07)';
      for (let b = 1; b < p.bars; b++) g.fillRect(Math.round((b * MB.barTicks(p) * w) / total), 0, 1, h);
      if (!t.notes.length) continue;
      const drums = MB.getInstrument(t.instrument).kind === 'drums';
      let lo = 0;
      let hi = MB.DRUM_ROWS.length - 1;
      if (!drums) {
        lo = Math.min(...t.notes.map((n) => n.pitch)) - 2;
        hi = Math.max(...t.notes.map((n) => n.pitch)) + 2;
      }
      const range = Math.max(1, hi - lo);
      g.fillStyle = t.color;
      for (const n of t.notes) {
        const x = (n.start / total) * w;
        const y = h - 3 - ((n.pitch - lo) / range) * (h - 6);
        g.fillRect(x, y - 1.5, Math.max(1.5, (n.length / total) * w - 0.5), 3);
      }
    }
  }
  new ResizeObserver(scheduleMinis).observe(trackList);

  // --- interakce v seznamu (delegace událostí) ---

  const trackOf = (target) => {
    const el = target.closest('.track');
    return el ? State.trackById(el.dataset.id) : null;
  };

  trackList.addEventListener('click', (e) => {
    const t = trackOf(e.target);
    if (!t) return;
    if (e.target.closest('.t-mute')) return State.change(() => { t.mute = !t.mute; }, 'mixer');
    if (e.target.closest('.t-solo')) return State.change(() => { t.solo = !t.solo; }, 'mixer');
    if (e.target.closest('.t-dup')) return State.duplicateTrack(t.id);
    if (e.target.closest('.t-del')) return deleteTrack(t);
    State.selectTrack(t.id);
    if (e.target.closest('.track-mini')) document.body.classList.remove('tracks-open');
  });

  trackList.addEventListener('input', (e) => {
    const t = trackOf(e.target);
    if (!t) return;
    const el = e.target;
    if (el.matches('.t-color')) {
      State.beginGesture();
      t.color = el.value;
      State.changed('look');
      return;
    }
    if (!el.matches('input[type=range]')) return;
    State.beginGesture(); // celé tažení posuvníkem = jeden krok historie
    const v = +el.value;
    if (el.matches('.t-vol')) t.volume = v;
    else if (el.matches('.t-pan')) t.pan = Math.abs(v) < 0.04 ? 0 : v; // přichycení na střed
    else if (el.matches('.t-rev')) t.reverb = v;
    else if (el.matches('.t-sc')) t.sidechain = v;
    else if (el.matches('.t-drv')) t.drive = v;
    State.changed('mixer');
  });

  trackList.addEventListener('change', (e) => {
    const t = trackOf(e.target);
    if (!t) return;
    if (e.target.matches('.t-inst')) changeInstrument(t, e.target.value);
    else if (e.target.matches('.t-color')) State.endGesture('look');
    else if (e.target.matches('input[type=range]')) State.endGesture('mixer');
  });

  trackList.addEventListener('dblclick', (e) => {
    const t = trackOf(e.target);
    if (!t) return;
    if (e.target.matches('input[type=range]')) { // dvojklik na posuvník = výchozí hodnota
      const def = MB.getInstrument(t.instrument);
      State.change(() => {
        if (e.target.matches('.t-vol')) t.volume = def.volume;
        else if (e.target.matches('.t-pan')) t.pan = 0;
        else if (e.target.matches('.t-sc')) t.sidechain = 0;
        else if (e.target.matches('.t-drv')) t.drive = 0;
        else t.reverb = def.reverb;
      }, 'mixer');
      return;
    }
    const nameEl = e.target.closest('.track-name');
    if (nameEl) renameTrack(t, nameEl);
  });

  function renameTrack(t, nameEl) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'track-rename';
    input.maxLength = 40;
    input.value = t.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v && v !== t.name) State.change(() => { t.name = v; }, 'tracks');
      else renderTracks();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      else if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  function changeInstrument(t, id) {
    const oldDef = MB.getInstrument(t.instrument);
    const newDef = MB.getInstrument(id);
    const kindChange = oldDef.kind !== newDef.kind;
    if (kindChange && t.notes.length &&
        !confirm(`Stopa „${t.name}“ se změní na ${newDef.kind === 'drums' ? 'bicí' : 'melodický nástroj'} – její noty se smažou. Pokračovat?`)) {
      refreshTracks(); // vrátí původní hodnotu v <select>
      return;
    }
    State.change(() => {
      // výchozí jméno a barvu převezme od nového nástroje, vlastní nechá
      if (t.name === oldDef.name || t.name.startsWith(`${oldDef.name} `)) t.name = newDef.name + t.name.slice(oldDef.name.length);
      if (t.color === oldDef.color) t.color = newDef.color;
      if (kindChange) t.notes = [];
      t.instrument = id;
    }, 'tracks');
    Engine.preview(t, newDef.kind === 'drums' ? 0 : newDef.center || 60, 0.5);
  }

  function deleteTrack(t) {
    if (t.notes.length && !confirm(`Smazat stopu „${t.name}“ i s ${t.notes.length} notami? (Jde vrátit přes Ctrl+Z.)`)) return;
    State.removeTrack(t.id);
  }

  // --- přidání stopy ---

  const addMenu = $('addTrackMenu');
  for (const d of instruments) {
    const b = document.createElement('button');
    b.dataset.inst = d.id;
    b.innerHTML = `<span class="dot" style="background:${d.color}"></span>`;
    b.append(d.name);
    addMenu.appendChild(b);
  }
  $('btnAddTrack').addEventListener('click', () => { addMenu.hidden = !addMenu.hidden; });
  addMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-inst]');
    if (!b) return;
    addMenu.hidden = true;
    State.addTrack(b.dataset.inst);
  });

  // klik mimo nabídky je zavře
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#addTrackMenu, #btnAddTrack')) addMenu.hidden = true;
    if (!e.target.closest('#projectMenu, #btnProject')) projectMenu.hidden = true;
    if (document.body.classList.contains('tracks-open') && !e.target.closest('.tracks, #btnTracks')) {
      document.body.classList.remove('tracks-open');
    }
  });

  function updateCorner() {
    const t = State.currentTrack();
    const corner = $('corner');
    corner.style.setProperty('--track-color', t.color);
    corner.innerHTML = '<span class="dot"></span><span></span>';
    corner.lastChild.textContent = t.name;
    corner.title = `${t.name} – ${MB.getInstrument(t.instrument).name}`;
  }

  // ---------------------------------------------------------------------------
  // Stavový řádek
  // ---------------------------------------------------------------------------

  const HINTS = {
    draw: '<b>Klik</b> = nota · <b>tah doprava</b> = délka · <b>tah noty</b> = přesun · <b>pravý okraj</b> = délka · ' +
      '<b>pravé tlačítko</b> = smazat · <b>Shift/Ctrl + tah</b> = výběr · <b>Ctrl + tah noty</b> = kopie · <b>F1</b> = nápověda',
    select: '<b>Tah</b> = výběr obdélníkem · <b>Shift</b> = přidat k výběru · <b>dvojklik</b> = nová nota · ' +
      '<b>šipky</b> = posun · <b>Ctrl+C/V</b> = kopírovat/vložit · <b>Delete</b> = smazat',
    erase: '<b>Klik</b> nebo <b>tah</b> přes noty = mazání · přepnutí zpět na kreslení klávesou <b>D</b>',
  };

  const velocityBox = $('velocityBox');
  const velocityInput = $('inpVelocity');
  const tuneBox = $('tuneBox');
  const tuneInput = $('inpTune');

  function updateStatus() {
    $('statusHint').innerHTML = HINTS[State.ui.tool];
    const sel = Grid.selectedNotes();
    const t = State.currentTrack();
    const info = $('statusInfo');
    if (sel.length) {
      const n = sel.length;
      info.innerHTML = `Vybráno: <b>${n}</b> ${n === 1 ? 'nota' : n < 5 ? 'noty' : 'not'}`;
      const avg = sel.reduce((a, x) => a + x.velocity, 0) / n;
      if (document.activeElement !== velocityInput) velocityInput.value = avg;
      $('velocityOut').textContent = Math.round(avg * 100);
      const tune = Math.round(sel.reduce((a, x) => a + (x.tune || 0), 0) / n);
      if (document.activeElement !== tuneInput) tuneInput.value = tune;
      $('tuneOut').textContent = tune > 0 ? `+${tune}` : String(tune);
    } else {
      info.textContent = `${t.name}: `;
      info.insertAdjacentHTML('beforeend', `<b>${t.notes.length}</b> not`);
    }
    velocityBox.hidden = !sel.length;
    tuneBox.hidden = !sel.length || !Grid.isDrums;
  }

  velocityInput.addEventListener('input', () => Grid.setSelectionVelocity(+velocityInput.value));
  velocityInput.addEventListener('change', () => State.endGesture('notes'));

  tuneInput.addEventListener('input', () => Grid.setSelectionTune(+tuneInput.value));
  tuneInput.addEventListener('change', () => State.endGesture('notes'));
  tuneInput.addEventListener('dblclick', () => {
    Grid.setSelectionTune(0);
    State.endGesture('notes');
  });

  // ---------------------------------------------------------------------------
  // Klávesové zkratky
  // ---------------------------------------------------------------------------

  /** Píše uživatel zrovna do textového pole? Pak zkratky nekrademe. */
  function isTyping(el) {
    if (!el) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && !['range', 'checkbox', 'color', 'button', 'file'].includes(el.type);
  }

  document.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) {
      if (e.key === 'Escape' || e.key === 'Enter') e.target.blur();
      return;
    }
    if (helpDialog.open && e.key !== 'F1') return; // dialog si Esc řeší sám
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let handled = true;

    if (e.code === 'Space') {
      if (!e.repeat) Transport.toggle();
    } else if (mod && key === 'z') {
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && key === 'y') {
      redo();
    } else if (mod && key === 'c') {
      if (!Grid.copySelection()) toast('Nejdřív vyber noty, které chceš kopírovat.');
    } else if (mod && key === 'x') {
      Grid.cutSelection();
    } else if (mod && key === 'v') {
      if (!Grid.dragging) {
        const r = Grid.paste();
        if (typeof r === 'string') toast(r);
      }
    } else if (mod && key === 'd') {
      Grid.duplicateSelection();
    } else if (mod && key === 'a') {
      Grid.selectAll();
    } else if (mod && key === 's') {
      State.saveNow();
      toast('Projekt je uložený v prohlížeči. Do souboru: Projekt → Exportovat JSON.', { type: 'ok' });
    } else if (key === 'Delete' || key === 'Backspace') {
      Grid.deleteSelection();
    } else if (key === 'ArrowUp' || key === 'ArrowDown') {
      Grid.transposeSelection(key === 'ArrowUp' ? 1 : -1, e.shiftKey);
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      Grid.moveSelectionTime(key === 'ArrowRight' ? 1 : -1, e.shiftKey);
    } else if (key === 'Escape') {
      addMenu.hidden = true;
      projectMenu.hidden = true;
      Grid.clearSelection();
    } else if (key === 'Home') {
      Transport.seek(0);
    } else if (key === 'F1' || key === '?') {
      toggleHelp();
    } else if (mod || e.altKey) {
      handled = false; // ostatní zkratky s Ctrl/Alt nechá prohlížeč být
    } else if (key === 'd') {
      setTool('draw');
    } else if (key === 'v') {
      setTool('select');
    } else if (key === 'e') {
      setTool('erase');
    } else if (key === 's') {
      toggleSnap();
    } else if (key === 'q') {
      const n = Grid.quantize();
      toast(n ? `Kvantizováno: ${n} ${n === 1 ? 'nota' : n < 5 ? 'noty' : 'not'}` : 'Noty už jsou v mřížce i ve stupnici.');
    } else if (key === 'r') {
      const n = Grid.chopSelection();
      toast(n ? `Rozsekáno na ${n} not po ${$('selStep').selectedOptions[0].textContent}.` : 'Vyber noty delší než jeden krok mřížky (krok nastavíš v liště, např. 1/32).');
    } else if (key === 'l') {
      toggleLoop();
    } else if (key === 'f') {
      toggleFollow();
    } else if (key === 'g') {
      toggleGhosts();
    } else if (key === '+' || key === '=') {
      Grid.zoomX(1.25);
    } else if (key === '-') {
      Grid.zoomX(0.8);
    } else {
      handled = false;
    }
    if (handled) e.preventDefault(); // mj. aby mezerník „neklikl“ na naposledy použité tlačítko
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && !isTyping(e.target)) e.preventDefault();
  });

  // Vybraný <select> by jinak „žral“ šipky a mezerník – po výběru ho opustíme.
  document.addEventListener('change', (e) => {
    if (e.target.tagName === 'SELECT') e.target.blur();
  });

  // ---------------------------------------------------------------------------
  // Smyčka překreslování
  // ---------------------------------------------------------------------------

  function fmtPosition(tick) {
    const p = State.project;
    const bar = Math.floor(tick / MB.barTicks(p)) + 1;
    const beat = Math.floor((tick % MB.barTicks(p)) / PPQ) + 1;
    const six = Math.floor((tick % PPQ) / (PPQ / 4)) + 1;
    return `${bar}.${beat}.${six}`;
  }

  function fmtTime(sec) {
    const m = Math.floor(sec / 60);
    return `${m}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`;
  }

  let lastPos = '';
  function frame() {
    Transport.update();
    Grid.frame();
    const p = State.project;
    const tick = clamp(Transport.currentTick(), 0, MB.songTicks(p) - 1);
    const pos = `${fmtPosition(tick)}|${fmtTime(tick * MB.secPerTick(p))}`;
    if (pos !== lastPos) {
      lastPos = pos;
      const [a, b] = pos.split('|');
      $('posBar').textContent = a;
      $('posTime').textContent = b;
    }
    document.body.classList.toggle('playing', Transport.playing);
    requestAnimationFrame(frame);
  }

  setTool(State.ui.tool);
  syncToolbar();
  syncHistory();
  renderTracks();
  updateCorner();
  updateStatus();
  requestAnimationFrame(frame);
  if (State.restored) toast(`Obnoven rozpracovaný projekt „${State.project.name}“.`, { timeout: 2500 });
})(window.MB);
