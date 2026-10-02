// FL LUA: application bootstrap and wiring.
import { h } from './ui/h.js';
import { AudioHost } from './host/audio-host.js';
import { SampleBank } from './host/sample-bank.js';
import { Store } from './app/store.js';
import { Transport } from './app/transport.js';
import * as cmd from './app/commands.js';
import { WindowManager } from './ui/window-manager.js';
import { Hint } from './ui/hint.js';
import { Toolbar } from './ui/toolbar.js';
import { buildMenuBar, closePopups } from './ui/menu.js';
import { wireKnobs } from './ui/knob.js';
import { createRack } from './ui/channel-rack.js';
import { createPicker } from './ui/plugin-picker.js';
import { openChannelEditor } from './ui/plugin-window.js';
import { toast, promptText, confirmBox, alertBox, modal } from './ui/dialog.js';
import { demoProject, emptyProject } from './core/demo.js';
import { createProject, normalize, createFxSlot } from './core/project.js';
import { FACTORY } from './core/factory.js';
import { INSTRUMENTS } from './core/instruments/index.js';
import { EFFECTS } from './core/effects/index.js';
import { downloadBlob } from './host/export/wav.js';
import { STEP, BEAT, SNAP } from './core/constants.js';
import { installExtensions } from './app-extensions.js';
import { PackManager } from './host/pack-manager.js';

const PIANO = { z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11, q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23, i: 24 };

export const SNAP_OPTIONS = [
  ['line', 'Line'], ['cell', 'Cell'], ['none', '(none)'], ['sixthStep', '1/6 step'], ['quarterStep', '1/4 step'], ['thirdStep', '1/3 step'],
  ['halfStep', '1/2 step'], ['step', 'Step'], ['sixthBeat', '1/6 beat'], ['quarterBeat', '1/4 beat'], ['thirdBeat', '1/3 beat'],
  ['halfBeat', '1/2 beat'], ['beat', 'Beat'], ['bar', 'Bar'],
];

const app = {
  cmd, editors: {}, held: new Map(), pianoBase: 60, typingPiano: true,
  keyHooks: new Set(),                       // windows register fn(event) -> true when they used the key
  hoverAddr: null,                           // parameter address of the knob under the pointer
  toast,
};

// ------------------------------------------------------------------------------ helpers
app.toast = (m) => toast(m);

app.snapTicks = (ctx = {}) => {
  const k = app.store.project.settings.snap;
  if (k === 'line') return ctx.line || BEAT;
  if (k === 'cell') return ctx.cell || STEP;
  return SNAP[k] || ctx.cell || STEP;
};

app.preview = (chId, key, vel = 100) => {
  const ch = app.store.channel(chId);
  if (!ch) return;
  const k = key ?? (ch.params && ch.params.root !== undefined ? ch.params.root : 60);
  app.host.resume();
  app.host.send({ t: 'noteOn', ch: chId, key: k, vel: vel / 127 });
  setTimeout(() => app.host.send({ t: 'noteOff', ch: chId, key: k }), 260);
};

app.selectPatternRel = (d) => {
  const ids = Object.keys(app.store.project.patterns).map(Number).sort((a, b) => a - b);
  const i = ids.indexOf(app.store.project.currentPattern);
  cmd.selectPattern(app.store, ids[Math.max(0, Math.min(ids.length - 1, i + d))]);
};

app.renamePatternDialog = async (id) => {
  const p = app.store.project.patterns[id];
  const n = await promptText('Rename pattern', 'Pattern name', p.name);
  if (n) cmd.renamePattern(app.store, id, n);
};

app.openWindow = (id) => {
  if (id === 'browser') { app.showBrowser(true); return; }
  app.wm.open(id);
};
app.toggleWindow = (id) => {
  if (id === 'browser') { app.showBrowser(!app.browserVisible()); return; }
  app.wm.toggle(id);
};
app.browserVisible = () => !document.getElementById('browser-pane').classList.contains('hidden');
app.showBrowser = (v) => {
  document.getElementById('browser-pane').classList.toggle('hidden', !v);
  document.getElementById('splitter').classList.toggle('hidden', !v);
  if (v && app.browser && app.browser.onShow) app.browser.onShow();
  app.store.bus.emit('window', { id: 'browser', open: v });
  setTimeout(() => app.wm.refit(), 0);
};
app.openChannelEditor = (id) => openChannelEditor(app, id);

app.addInstrument = (type) => {
  const ch = cmd.addChannel(app.store, type, { name: INSTRUMENTS[type].meta.name });
  app.openChannelEditor(ch.id);
  return ch;
};

app.addEffectToSelected = (type) => {
  const p = app.store.project;
  const tn = p.mixer.selected;
  const t = p.mixer.tracks[tn];
  const slot = t.fx.findIndex((s) => !s);
  if (slot < 0) { toast('All 10 effect slots on this track are used'); return; }
  app.store.edit('Add effect', () => { t.fx[slot] = createFxSlot(type); }, [['mixer', 'tracks', tn]]);
  toast(`${EFFECTS[type].meta.name} added to ${tn === 0 ? 'Master' : 'insert ' + tn}, slot ${slot + 1}`);
};

app.pickSampleFor = (chId) => {
  const inp = h('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff,.m4a', style: { display: 'none' } });
  inp.addEventListener('change', async () => {
    const f = inp.files[0];
    if (!f) return;
    try {
      const e = await app.bank.decode(f.name, await f.arrayBuffer());
      cmd.setChannelSample(app.store, chId, { id: e.id, name: e.name });
      app.preview(chId);
    } catch (err) { toast(`Could not decode ${f.name}: ${err.message}`); }
    inp.remove();
  });
  document.body.append(inp);
  inp.click();
};

app.addChannelItems = () => [
  { label: 'Sampler', fn: () => { const ch = cmd.addChannel(app.store, 'sampler', { name: 'Sampler' }); app.openChannelEditor(ch.id); } },
  { label: 'Sampler with factory sample', submenu: () => FACTORY.map((f) => ({ label: `${f.cat} · ${f.name}`, fn: () => { const ch = cmd.addChannel(app.store, 'sampler', { name: f.name, sample: { id: `factory:${f.id}`, name: f.name } }); app.preview(ch.id); } })) },
  { label: 'Sampler from file…', fn: () => { const ch = cmd.addChannel(app.store, 'sampler', { name: 'Sampler' }); app.pickSampleFor(ch.id); } },
  { sep: true },
  { label: 'Audio clip', fn: () => app.addAudioClipChannel && app.addAudioClipChannel(), disabled: !app.addAudioClipChannel },
  { label: 'Automation clip', fn: () => app.addAutomationChannel && app.addAutomationChannel(), disabled: !app.addAutomationChannel },
  { label: 'Controller (LFO / Envelope)', submenu: [{ label: 'LFO', fn: () => app.addControllerChannel(0) }, { label: 'Envelope controller', fn: () => app.addControllerChannel(1) }] },
  { label: 'Layer', fn: () => cmd.addChannel(app.store, 'layer', { name: 'Layer' }) },
  { sep: true },
  { label: 'Instrument plugin', submenu: () => Object.keys(INSTRUMENTS).filter((t) => t !== 'sampler').map((t) => ({ label: INSTRUMENTS[t].meta.name, fn: () => app.addInstrument(t) })) },
  { label: 'Get more plugins…', fn: () => app.openStore && app.openStore() },
];

// ------------------------------------------------------------------------------ files
app.newProject = async () => {
  if (app.store.dirty && app.store.project.channels.length && !(await confirmBox('New project', 'Discard unsaved changes and start an empty project?', 'Discard'))) return;
  await app.store.replaceProject(emptyProject());
};

app.openDemo = async () => { await app.store.replaceProject(demoProject()); toast('Demo project loaded. Press Space to play'); };

app.openFile = () => {
  const inp = h('input', { type: 'file', accept: '.fllua,.stepwise,.json,.zip,application/json,application/zip', style: { display: 'none' } });
  inp.addEventListener('change', async () => {
    const f = inp.files[0];
    if (!f) return;
    try { await app.loadProjectFile(f); } catch (err) { alertBox('Could not open project', String(err.message || err)); }
    inp.remove();
  });
  document.body.append(inp);
  inp.click();
};

app.loadProjectFile = async (file) => {
  const name = file.name.replace(/\.[^.]+$/, '');
  if (/\.zip$/i.test(file.name)) {
    const { projectFromZip } = await import('./app/project-io.js');
    const { project, restored } = await projectFromZip(new Uint8Array(await file.arrayBuffer()), app.bank);
    await app.store.replaceProject(project, { fileName: name });
    toast(`Opened ${name} (${restored} sample${restored === 1 ? '' : 's'} restored)`);
    return;
  }
  const p = normalize(JSON.parse(await file.text()));
  await app.store.replaceProject(p, { fileName: name });
  toast(`Opened ${name}`);
};

app.downloadProjectZip = async () => {
  const { projectToZip } = await import('./app/project-io.js');
  const name = (app.store.project.meta.title || 'project').replace(/[^\w\- ]+/g, '_');
  const zip = projectToZip(app.store.project, app.bank);
  downloadBlob(zip, `${name}.zip`, 'application/zip');
  toast(`Saved ${name}.zip with its samples`);
};

app.saveProject = async () => {
  const title = await app.store.saveProjectLocal();
  toast(`Saved "${title}" in this browser`);
};

app.downloadProject = () => {
  const p = app.store.project;
  const name = (p.meta.title || 'project').replace(/[^\w\- ]+/g, '_');
  downloadBlob(new TextEncoder().encode(app.store.serialize()), `${name}.fllua`, 'application/json');
};

app.sampleMap = () => {
  const m = new Map();
  for (const [id, e] of app.bank.map) m.set(id, { rate: e.rate, channels: e.channels });
  return m;
};

// quick export of the current mode as WAV (the Export… dialog offers every format)
app.exportWav = async (bits = 16) => {
  const { exportProject, defaultSettings } = await import('./app/export.js');
  toast('Rendering…');
  const cfg = { ...defaultSettings(app.store.project), format: 'wav', quality: String(bits), source: app.transport.mode === 'song' ? 'song' : 'pat', rate: app.host.sampleRate };
  try {
    const r = await exportProject(app, cfg);
    if (r) toast(`Exported ${r.seconds.toFixed(1)} s (${bits === 32 ? '32-bit float' : bits + '-bit'} WAV)`);
  } catch (err) { toast(String(err.message || err)); }
};

// ------------------------------------------------------------------------------ menus
function buildMenus() {
  const st = app.store, t = app.transport, wm = app.wm;
  const win = (id, label, key) => ({ label, key, checked: id === 'browser' ? app.browserVisible() : wm.isOpen(id), fn: () => app.toggleWindow(id) });
  const defs = [
    { label: 'FILE', items: () => [
      { label: 'New project', key: 'Ctrl+N', fn: () => app.newProject() },
      { label: 'Open project file…', key: 'Ctrl+O', fn: () => app.openFile() },
      { label: 'Open demo project', fn: () => app.openDemo() },
      ...(app.fileMenuExtra ? app.fileMenuExtra() : []),
      { sep: true },
      { label: 'Save in browser', key: 'Ctrl+S', fn: () => app.saveProject() },
      { label: 'Download project file (.fllua)', fn: () => app.downloadProject() },
      { label: 'Download project with samples (.zip)', fn: () => app.downloadProjectZip() },
      { sep: true },
      ...(app.exportMenu ? app.exportMenu() : [
        { label: 'Export WAV 16-bit', fn: () => app.exportWav(16) },
        { label: 'Export WAV 24-bit', fn: () => app.exportWav(24) },
        { label: 'Export WAV 32-bit float', fn: () => app.exportWav(32) },
      ]),
    ] },
    { label: 'EDIT', items: () => [
      { label: `Undo${st.history.length ? ': ' + st.history[st.history.length - 1].label : ''}`, key: 'Ctrl+Z', disabled: !st.history.length, fn: () => st.undo() },
      { label: `Redo${st.future.length ? ': ' + st.future[st.future.length - 1].label : ''}`, key: 'Ctrl+Alt+Z', disabled: !st.future.length, fn: () => st.redo() },
      { label: 'Undo history…', fn: () => app.openWindow('history') },
      ...(app.editMenuExtra ? app.editMenuExtra() : []),
    ] },
    { label: 'ADD', items: () => [
      ...app.addChannelItems(),
      { sep: true },
      { label: 'New pattern', fn: () => cmd.newPattern(st) },
    ] },
    { label: 'PATTERNS', items: () => {
      const p = st.project;
      const ids = Object.keys(p.patterns).map(Number).sort((a, b) => a - b);
      return [
        { label: 'New pattern', fn: () => cmd.newPattern(st) },
        { label: 'Clone pattern', fn: () => cmd.clonePattern(st, p.currentPattern) },
        { label: 'Rename…', fn: () => app.renamePatternDialog(p.currentPattern) },
        { label: 'Delete pattern', fn: () => cmd.deletePattern(st, p.currentPattern) },
        { sep: true }, { title: 'Go to pattern' },
        ...ids.map((id) => ({ label: `${String(id).padStart(2, '0')}  ${p.patterns[id].name}`, checked: id === p.currentPattern, fn: () => cmd.selectPattern(st, id) })),
      ];
    } },
    { label: 'VIEW', items: () => [
      win('playlist', 'Playlist', 'F5'), win('rack', 'Channel rack', 'F6'), win('pianoroll', 'Piano roll', 'F7'),
      win('mixer', 'Mixer', 'F9'), win('browser', 'Browser', 'F8'), win('picker', 'Plugin picker', 'Alt+F8'),
      { sep: true },
      { label: 'Reset window layout', fn: () => wm.resetLayout() },
    ] },
    { label: 'OPTIONS', items: () => [
      { label: 'Metronome', checked: !!st.project.settings.metronome, fn: () => t.toggleSetting('metronome') },
      { label: 'Count-in before recording', checked: !!st.project.settings.countIn, fn: () => t.toggleSetting('countIn') },
      { label: 'Overdub', checked: !!st.project.settings.overdub, fn: () => t.toggleSetting('overdub') },
      { label: 'Blend recorded notes', checked: !!st.project.settings.blend, fn: () => t.toggleSetting('blend') },
      { sep: true },
      { label: 'Project settings…', fn: () => app.projectSettings() },
      ...(app.optionsMenuExtra ? app.optionsMenuExtra() : []),
      { label: 'Audio info…', fn: () => app.audioInfo() },
    ] },
    { label: 'TOOLS', items: () => [
      { label: 'Tap tempo', key: 'Alt+T', fn: () => t.tapTempo() },
      { label: 'Panic: all notes off', fn: () => app.host.send({ t: 'panic' }) },
      ...(app.toolsMenuExtra ? app.toolsMenuExtra() : []),
    ] },
    { label: 'HELP', items: () => [
      { label: 'Keyboard shortcuts', fn: () => app.shortcutsDialog() },
      { label: 'About FL LUA', fn: () => app.about() },
    ] },
  ];
  const brand = h('div.app-name', h('img.app-logo', { src: 'assets/icon.svg', alt: '', width: 18, height: 18, draggable: false }), 'FL LUA');
  buildMenuBar(document.getElementById('menubar'), defs, brand);
}

app.projectSettings = () => {
  const p = app.store.project;
  const title = h('input.field', { type: 'text', value: p.meta.title, style: { width: '100%' } });
  const author = h('input.field', { type: 'text', value: p.meta.author, style: { width: '100%' } });
  const num = h('input.field', { type: 'number', min: 1, max: 32, value: p.timeSig.num, style: { width: '56px' } });
  const den = h('select.select', [1, 2, 4, 8, 16, 32].map((d) => h('option', { value: d, selected: d === p.timeSig.den }, String(d))));
  modal({
    title: 'Project settings',
    body: [h('div.dim', 'Title'), title, h('div.dim', 'Author'), author, h('div.dim', 'Time signature'), h('div.row', num, h('span', '/'), den)],
    buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, fn: () => {
      app.store.edit('Project settings', (pr) => {
        pr.meta.title = title.value.slice(0, 80) || 'Untitled'; pr.meta.author = author.value.slice(0, 80);
        pr.timeSig = { num: Math.max(1, Math.min(32, +num.value || 4)), den: +den.value };
      }, [['timeSig']]);
      app.store.bus.emit('project', app.store.project);
    } }],
  });
};

app.audioInfo = () => {
  const c = app.host.ctx;
  alertBox('Audio engine', [
    `Sample rate: ${app.host.sampleRate} Hz`,
    `Base latency: ${(c.baseLatency * 1000).toFixed(1)} ms`,
    `Output latency: ${((c.outputLatency || 0) * 1000).toFixed(1)} ms`,
    `State: ${c.state}`,
    `Engine: AudioWorklet, 128-frame blocks, sample-accurate event scheduling`,
  ].join('\n'));
};

app.about = () => alertBox('FL LUA', 'A browser DAW with a pattern-based workflow (Channel rack → Playlist).\nAudio engine in an AudioWorklet; the same engine renders exports offline.\nOpen source (MIT). Not affiliated with any other DAW vendor.');

app.shortcutsDialog = () => {
  const rows = [
    ['Space', 'Play / Stop'], ['Ctrl+Space', 'Pause'], ['L', 'Toggle PAT / SONG'], ['Alt+T', 'Tap tempo'],
    ['F5 / F6 / F7 / F9', 'Playlist / Channel rack / Piano roll / Mixer'], ['F8', 'Browser'], ['Alt+F8', 'Plugin picker'],
    ['Ctrl+Z', 'Undo'], ['Ctrl+Alt+Z, Ctrl+Y', 'Redo'], ['Ctrl+S', 'Save in browser'], ['Ctrl+N / Ctrl+O', 'New / Open'],
    ['Ctrl+↑ / Ctrl+↓', 'Next / previous pattern'], ['Z S X D C V G B H N J M', 'Play the selected channel from the keyboard (C–B)'], ['Q 2 W 3 E R 5 T 6 Y 7 U I', 'Same, one octave higher'],
    ['Ctrl+L', 'Link hovered control to a MIDI controller'], ['Ctrl+R', 'Export (WAV / FLAC / MP3 / OGG / MIDI / stems)'],
    ['Patcher: Del · Ctrl+D · Ctrl+A', 'Delete / duplicate / select all nodes; wheel zooms, middle mouse (or Space) pans'],
    ['Audio editor: Space · Ctrl+C/X/V · Del', 'Play · copy / cut / paste · delete the selection; Ctrl+Z / Ctrl+Y undo inside the editor; wheel zooms'],
  ];
  modal({ title: 'Keyboard shortcuts', body: h('div', { style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 18px' } }, rows.flatMap(([k, d]) => [h('b', { style: { color: 'var(--accent)' } }, k), h('span', d)])), buttons: [{ label: 'Close', primary: true }] });
};

// ------------------------------------------------------------------------------ keyboard
function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function onKeyDown(e) {
  if (isTyping(e) || document.querySelector('.modal-back')) return;
  const ctrl = e.ctrlKey || e.metaKey, key = e.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  // the focused editor window (piano roll, playlist…) gets the first chance at the key
  for (const hook of app.keyHooks) if (hook(e)) { e.preventDefault(); return; }
  if (ctrl) {
    if (lower === 'z' && !e.shiftKey && !e.altKey) { e.preventDefault(); app.store.undo(); return; }
    if ((lower === 'z' && (e.altKey || e.shiftKey)) || lower === 'y') { e.preventDefault(); app.store.redo(); return; }
    if (lower === 's') { e.preventDefault(); app.saveProject(); return; }
    if (lower === 'o') { e.preventDefault(); app.openFile(); return; }
    if (lower === 'n') { e.preventDefault(); app.newProject(); return; }
    if (key === ' ') { e.preventDefault(); app.transport.togglePause(); return; }
    if (key === 'ArrowUp') { e.preventDefault(); app.selectPatternRel(1); return; }
    if (key === 'ArrowDown') { e.preventDefault(); app.selectPatternRel(-1); return; }
    if (lower === 'l' && app.linkHovered) { e.preventDefault(); app.linkHovered(); return; }
    return;
  }
  if (e.altKey) {
    if (lower === 't') { e.preventDefault(); app.transport.tapTempo(); return; }
    if (key === 'F8') { e.preventDefault(); app.toggleWindow('picker'); return; }
    return;
  }
  const fmap = { F5: 'playlist', F6: 'rack', F7: 'pianoroll', F8: 'browser', F9: 'mixer' };
  if (fmap[key]) { e.preventDefault(); app.toggleWindow(fmap[key]); return; }
  if (key === ' ') { e.preventDefault(); app.transport.toggle(); return; }
  if (lower === 'l' && !e.repeat) { app.transport.toggleMode(); return; }
  if (key === 'Escape') { closePopups(); return; }
  // typing-to-piano on the selected channel
  if (app.typingPiano && !e.repeat && PIANO[lower] !== undefined && !e.shiftKey) {
    const ch = app.store.selected;
    if (ch == null) return;
    const note = app.pianoBase + PIANO[lower];
    if (app.held.has(lower)) return;
    app.held.set(lower, { ch, note });
    app.host.resume();
    app.host.send({ t: 'noteOn', ch, key: note, vel: 0.8 });
  }
}

function onKeyUp(e) {
  const lower = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const h_ = app.held.get(lower);
  if (h_) { app.held.delete(lower); app.host.send({ t: 'noteOff', ch: h_.ch, key: h_.note }); }
}

// ------------------------------------------------------------------------------ snap selector
function buildSnap() {
  const el = document.getElementById('snapsel');
  const sel = h('select.select', { hint: 'Snap — grid used when drawing and moving notes, clips and automation points (all editors)', onchange: () => {
    app.store.edit('Snap', (p) => { p.settings.snap = sel.value; }, [['settings']], { noUndo: true });
    app.store.bus.emit('snap', sel.value);
  } }, SNAP_OPTIONS.map(([v, l]) => h('option', { value: v }, l)));
  const sync = () => { sel.value = app.store.project.settings.snap || 'cell'; };
  app.store.bus.on('project', sync);
  sync();
  el.append(h('span', 'Snap'), sel);
}

// ------------------------------------------------------------------------------ files dropped on the page
function wireDrop() {
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    if (e.defaultPrevented) return;
    e.preventDefault();
    for (const f of e.dataTransfer.files) {
      if (/\.(fllua|stepwise|json|zip)$/i.test(f.name)) { try { await app.loadProjectFile(f); } catch (err) { toast(`Could not open ${f.name}: ${err.message}`); } continue; }
      try {
        const smp = await app.bank.decode(f.name, await f.arrayBuffer());
        const ch = cmd.addChannel(app.store, 'sampler', { name: smp.name, sample: { id: smp.id, name: smp.name } });
        app.preview(ch.id);
      } catch (err) { toast(`Could not load ${f.name}: ${err.message}`); }
    }
  });
}

// ------------------------------------------------------------------------------ boot
export async function boot() {
  const params = new URLSearchParams(location.search);
  const host = new AudioHost();
  app.host = host;
  app.bank = new SampleBank(host, host.bus);
  app.store = new Store(host, app.bank);
  app.transport = new Transport(app);
  app.hint = new Hint(document.getElementById('hint'));
  app.wm = new WindowManager(document.getElementById('workspace'), app.store.bus, app);
  wireKnobs(app);

  const status = document.getElementById('status-audio');
  try {
    await host.init(new URL('./worklet/processor.js', import.meta.url).href);
    status.textContent = `audio: ${host.sampleRate} Hz`;
  } catch (err) {
    status.textContent = 'audio: unavailable';
    status.style.color = 'var(--red)';
    alertBox('Audio engine failed to start', String(err.message || err));
  }
  // installed plugin packs come online before any project is loaded, so projects that use them open complete
  app.packs = new PackManager(app);
  await app.packs.loadAll();
  host.bus.on('error', (m) => toast(`Engine error: ${m}`));
  host.bus.on('auto', (m) => { for (const [addr, v] of m.values) app.store.engineParam(addr, v); });
  host.bus.on('ended', () => app.store.bus.emit('transport'));

  app.wm.register('rack', { title: 'Channel rack', create: createRack, rect: { x: 10, y: 10, w: 700, h: 330 }, minW: 380, minH: 140 });
  app.wm.register('picker', { title: 'Plugin picker', create: createPicker, rect: { x: 300, y: 120, w: 300, h: 380 }, minW: 220, minH: 160 });
  installExtensions(app);

  const p = params.has('empty') ? emptyProject() : demoProject();
  await app.store.replaceProject(p);
  new Toolbar(app, document.getElementById('toolbar'));
  buildMenus();
  buildSnap();
  wireDrop();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => { for (const [k, v] of app.held) app.host.send({ t: 'noteOff', ch: v.ch, key: v.note }); app.held.clear(); });
  window.addEventListener('beforeunload', (e) => { if (app.store.dirty && app.store.project.channels.length) { app.store.autosave(); } });

  for (const id of ['rack', ...(app.defaultWindows || [])]) {
    const was = app.wm.wasOpen(id);
    if (was !== false) app.wm.open(id);
  }
  app.store.bus.emit('project', app.store.project);
  window.app = app;
  window.__ready = true;
  // the project picker is for people, not for automated runs (?nopicker) and can be switched off
  if (!params.has('nopicker') && !params.has('empty')) { const { startDialogWanted } = await import('./ui/start-dialog.js'); if (startDialogWanted()) app.openStartDialog(); }
  return app;
}

boot().catch((err) => { console.error(err); document.body.append(h('pre', { style: { color: 'tomato', padding: '20px' } }, String(err.stack || err))); });
