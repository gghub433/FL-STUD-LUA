// Channel Rack: channel list + step sequencer for the current pattern, graph editor, groups.
import { h, drag, clamp } from './h.js';
import { Knob } from './knob.js';
import { contextMenu, showPopup } from './menu.js';
import { pickColor, promptText } from './dialog.js';
import { STEP, keyName } from '../core/constants.js';
import { patternLength } from '../core/project.js';
import { instrumentMeta } from '../core/instruments/index.js';
import { INSTRUMENTS } from '../core/instruments/index.js';
import { icon } from './icons.js';

const STEP_W = 20, STEP_GAP = 2, GROUP_GAP = 5;
const stepX = (i) => Math.floor(i / 4) * (4 * STEP_W + 3 * STEP_GAP + GROUP_GAP) + (i % 4) * (STEP_W + STEP_GAP);
const gridWidth = (n) => stepX(n - 1) + STEP_W;

const PROPS = {
  vel: { name: 'Velocity', min: 1, max: 127, def: 100, get: (n) => n.v, set: (n, v) => { n.v = v; } },
  pan: { name: 'Pan', min: -64, max: 64, def: 0, bipolar: true, get: (n) => n.pan || 0, set: (n, v) => { if (v) n.pan = v; else delete n.pan; } },
  fine: { name: 'Pitch', min: -120, max: 120, def: 0, bipolar: true, get: (n) => n.fine || 0, set: (n, v) => { if (v) n.fine = v; else delete n.fine; } },
  shift: { name: 'Shift', min: -11, max: 11, def: 0, bipolar: true, get: (n, step) => n.s - step * STEP, set: (n, v, step) => { n.s = Math.max(0, step * STEP + v); } },
  rel: { name: 'Release', min: 0, max: 127, def: 64, get: (n) => (n.rel === undefined ? 64 : n.rel), set: (n, v) => { if (v === 64) delete n.rel; else n.rel = v; } },
  mx: { name: 'Mod X', min: 0, max: 255, def: 128, get: (n) => (n.mx === undefined ? 128 : n.mx), set: (n, v) => { if (v === 128) delete n.mx; else n.mx = v; } },
  my: { name: 'Mod Y', min: 0, max: 255, def: 128, get: (n) => (n.my === undefined ? 128 : n.my), set: (n, v) => { if (v === 128) delete n.my; else n.my = v; } },
  key: { name: 'Keys', min: 0, max: 120, def: 60, get: (n) => n.k, set: (n, v) => { n.k = v; } },
};

export function noteStep(n) { return Math.round(n.s / STEP); }
const isStepLike = (n) => Math.abs(n.s - noteStep(n) * STEP) <= 11 && n.l <= STEP;

export class ChannelRack {
  constructor(win, app) {
    this.win = win;
    this.app = app;
    this.group = 'All';
    this.graphOpen = false;
    this.prop = 'vel';
    this.rows = new Map();     // chId -> { el, stepEls[] }
    this.playStep = -1;
    this.steps = 16;

    const store = app.store;
    this.swing = h('input', { type: 'range', min: 0, max: 100, value: 0, hint: 'Swing — delays every second step. Applies to all channels (right-click resets)' });
    this.swing.addEventListener('input', () => store.setParam('transport:swing', this.swing.value / 100, { coalesce: 'swing' }));
    this.swing.addEventListener('contextmenu', (e) => { e.preventDefault(); store.setParam('transport:swing', 0); });
    this.stepsSel = h('select.select', { hint: 'Pattern length in steps', onchange: () => app.cmd.setPatternSteps(store, store.project.currentPattern, +this.stepsSel.value) });
    this.graphBtn = h('div.btn', { hint: 'Graph editor — edit velocity, pan, pitch, shift, release and mod X/Y per step', onclick: () => this.toggleGraph() }, 'GRAPH');
    this.keyBtn = h('div.btn', { hint: 'Keyboard editor — set the key of each step on a mini keyboard', onclick: () => { this.prop = 'key'; this.setGraph(true); } }, icon('pianoroll', 14), 'KEYS');
    this.head = h('div.rack-head',
      h('div.swing', h('span.dim', 'Swing'), this.swing),
      h('span.dim', 'Steps'), this.stepsSel,
      h('div.grow'), this.graphBtn, this.keyBtn);
    this.groupsEl = h('div.rack-groups');
    this.list = h('div.rack-list');
    this.list.addEventListener('scroll', () => { this.graphWrap.scrollLeft = this.list.scrollLeft; });
    this.graphBar = h('div.graph-bar', { style: { display: 'none' } });
    this.canvas = h('canvas');
    this.graphWrap = h('div.graph', { style: { display: 'none', overflow: 'hidden' } }, this.canvas);
    this.foot = h('div.rack-foot',
      h('div.btn', { hint: 'Add channel — Sampler, Audio clip, Automation clip, Layer or an instrument plugin', onclick: (e) => this.addMenu(e) }, '＋'),
      h('span.dim', 'Click a step to toggle, drag to paint, right-click to erase. Double-click a name to open its editor.'));
    this.root = h('div.rack', this.head, this.groupsEl, this.list, this.graphBar, this.graphWrap, this.foot);
    this.el = this.root;

    for (const k of Object.keys(PROPS)) {
      if (k === 'key') continue;
      const b = h('div.btn.sm', { dataset: { prop: k }, onclick: () => { this.prop = k; this.drawGraph(); this.refreshBar(); } }, PROPS[k].name);
      this.graphBar.append(b);
    }
    this.graphBar.append(h('div.btn.sm', { dataset: { prop: 'key' }, onclick: () => { this.prop = 'key'; this.drawGraph(); this.refreshBar(); } }, 'Keys'));

    this.canvas.addEventListener('pointerdown', (e) => this.graphDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.graphHover(e));

    const rebuild = () => { this.buildGroups(); this.buildRows(); this.refreshAll(); };
    store.bus.on('project', rebuild);
    store.bus.on('change', ({ paths }) => {
      const first = new Set(paths.map((p) => p[0]));
      if (first.has('channels') || first.has('groups')) rebuild();
      else if (first.has('patterns') || first.has('currentPattern') || first.has('timeSig')) this.refreshAll();
      if (first.has('swing') || first.has('transport')) this.refreshSwing();
    });
    store.bus.on('param', (a) => { if (a === 'transport:swing') this.refreshSwing(); });
    store.bus.on('selection', () => { this.markSelection(); this.drawGraph(); });
    store.bus.on('pattern', () => this.refreshAll());
    app.store.bus.on('window', () => {});
    rebuild();
    this.raf = () => { this.tickPlay(); this.rafId = requestAnimationFrame(this.raf); };
    this.rafId = requestAnimationFrame(this.raf);
  }

  get store() { return this.app.store; }
  destroy() { cancelAnimationFrame(this.rafId); }

  onResize() { this.drawGraph(); }

  // ----------------------------------------------------------------- groups
  buildGroups() {
    const p = this.store.project;
    if (!p.groups.includes(this.group)) this.group = 'All';
    this.groupsEl.textContent = '';
    for (const g of p.groups) {
      const tab = h('div.rack-tab', { class: g === this.group ? 'on' : '', hint: `${g} — channel group. Right-click for options`, onclick: () => { this.group = g; this.buildGroups(); this.buildRows(); this.refreshAll(); } }, g);
      if (g !== 'All') tab.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Rename group…', fn: async () => { const n = await promptText('Rename group', 'Group name', g); if (n) this.renameGroup(g, n); } },
        { label: 'Delete group (channels stay in All)', fn: () => this.deleteGroup(g) },
      ]));
      this.groupsEl.append(tab);
    }
    this.groupsEl.append(h('div.rack-tab.add', { hint: 'Add a channel group', onclick: async () => { const n = await promptText('New group', 'Group name', 'Group'); if (n) { this.app.cmd.addGroup(this.store, n.slice(0, 20)); this.group = n.slice(0, 20); this.buildGroups(); this.buildRows(); } } }, '＋'));
  }

  renameGroup(old, name) {
    this.store.edit('Rename group', (p) => { p.groups[p.groups.indexOf(old)] = name; for (const c of p.channels) if (c.group === old) c.group = name; }, [['groups'], ['channels']]);
    this.group = name;
  }

  deleteGroup(g) {
    this.store.edit('Delete group', (p) => { p.groups = p.groups.filter((x) => x !== g); for (const c of p.channels) if (c.group === g) c.group = ''; }, [['groups'], ['channels']]);
    this.group = 'All';
  }

  // ----------------------------------------------------------------- rows
  visibleChannels() {
    const all = this.store.project.channels.filter((c) => c.type !== 'automation' || true);
    return this.group === 'All' ? all : all.filter((c) => c.group === this.group);
  }

  buildRows() {
    this.list.textContent = '';
    this.rows.clear();
    const chans = this.visibleChannels();
    if (!chans.length) this.list.append(h('div.empty-note', this.store.project.channels.length ? 'No channels in this group.' : 'The rack is empty. Use ＋ to add a Sampler or an instrument.'));
    for (const ch of chans) {
      const row = this.buildRow(ch);
      this.rows.set(ch.id, row);
      this.list.append(row.el);
    }
    this.markSelection();
  }

  buildRow(ch) {
    const store = this.store, app = this.app;
    const isAudio = ch.type === 'audio', isAuto = ch.type === 'automation', isLayer = ch.type === 'layer';
    const led = h('div.led', { class: ch.enabled ? 'on' : '', hint: 'Channel on/off — click to mute. Muted channels do not play', onclick: (e) => { e.stopPropagation(); app.cmd.setChannelField(store, ch.id, 'enabled', ch.enabled ? 0 : 1, 'Toggle channel'); } });
    const pan = new Knob(app, { addr: `ch:${ch.id}:pan`, size: 'sm', title: `${ch.name} · Panning` });
    const vol = new Knob(app, { addr: `ch:${ch.id}:vol`, size: 'sm', title: `${ch.name} · Volume` });
    const fx = h('div.lcd.small.ch-fx', { hint: `Mixer track — drag, wheel or double-click. 0 = Master`, dataset: { fx: ch.id } }, String(ch.mixer));
    this.wireFx(fx, ch);
    const pitch = isAuto || isLayer ? null : new Knob(app, { addr: `ch:${ch.id}:pitch`, size: 'sm', title: `${ch.name} · Pitch` });
    const name = h('div.ch-name', { style: { '--ch': ch.color }, hint: `${ch.name} — click: select + preview, double-click: open editor, right-click: menu`, dataset: { ch: ch.id } }, ch.name);
    name.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      store.select(ch.id);
      app.preview(ch.id);
    });
    name.addEventListener('dblclick', () => app.openChannelEditor(ch.id));
    name.addEventListener('contextmenu', (e) => { store.select(ch.id); contextMenu(e, this.channelMenu(ch)); });
    const meta = h('div.ch-meta', led, pan.el, vol.el, fx, pitch ? pitch.el : h('div', { style: { width: '22px' } }), name);
    const stepsEl = h('div.steps');
    const el = h('div.ch-row', { dataset: { ch: ch.id } }, meta, stepsEl);
    el.addEventListener('pointerdown', (e) => { if (!e.target.closest('.step') && !e.target.closest('.mini-roll')) store.select(ch.id); });
    return { el, stepsEl, ch, stepEls: [], mini: null, miniKey: '' };
  }

  wireFx(el, ch) {
    const store = this.store;
    const set = (v) => { v = clamp(Math.round(v), 0, 125); this.app.cmd.setMixerTarget(store, ch.id, v); el.textContent = String(v); };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const start = store.channel(ch.id).mixer;
      drag(e, (dx, dy) => set(start - dy / 6));
    });
    el.addEventListener('wheel', (e) => { e.preventDefault(); set(store.channel(ch.id).mixer + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
    el.addEventListener('dblclick', async () => {
      const v = await promptText('Mixer track', `Route "${ch.name}" to mixer track (0 = Master, 1–125 = inserts)`, String(store.channel(ch.id).mixer));
      if (v !== null && v !== '' && !Number.isNaN(+v)) set(+v);
    });
    el.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Route to Master (0)', fn: () => set(0) },
      { label: 'Route to next free insert', fn: () => { const used = new Set(store.project.channels.map((c) => c.mixer)); let n = 1; while (used.has(n) && n < 125) n++; set(n); } },
    ]));
  }

  channelMenu(ch) {
    const store = this.store, app = this.app, cmd = app.cmd;
    const isInst = !!instrumentMeta(ch.type);
    const items = [
      { label: 'Rename…', fn: async () => { const n = await promptText('Rename channel', 'Name', ch.name); if (n) cmd.renameChannel(store, ch.id, n); } },
      { label: 'Color…', fn: () => pickColor(innerWidth / 2 - 100, innerHeight / 3, ch.color, (c) => cmd.setChannelColor(store, ch.id, c)) },
      { sep: true },
      { label: 'Clone', fn: () => cmd.cloneChannel(store, ch.id) },
      { label: 'Delete', fn: () => cmd.removeChannel(store, ch.id) },
      { label: 'Move up', fn: () => cmd.moveChannel(store, ch.id, -1) },
      { label: 'Move down', fn: () => cmd.moveChannel(store, ch.id, 1) },
      { sep: true },
      { label: 'Fill each 2 steps', fn: () => cmd.fillEvery(store, ch.id, 2) },
      { label: 'Fill each 4 steps', fn: () => cmd.fillEvery(store, ch.id, 4) },
      { label: 'Fill each 8 steps', fn: () => cmd.fillEvery(store, ch.id, 8) },
      { label: 'Randomize', fn: () => cmd.randomizeSteps(store, ch.id) },
      { label: 'Clear steps in this pattern', fn: () => cmd.clearChannelNotes(store, ch.id) },
      { sep: true },
      { label: 'Piano roll', key: 'F7', fn: () => { store.select(ch.id); app.openWindow('pianoroll'); } },
    ];
    if (isInst) {
      items.push({ label: 'Cut itself', checked: !!ch.params.cutItself, fn: () => store.setParam(`ch:${ch.id}:p:cutItself`, ch.params.cutItself ? 0 : 1) });
      items.push({ label: 'Insert / Replace plugin', submenu: () => Object.keys(INSTRUMENTS).map((t) => ({ label: INSTRUMENTS[t].meta.name, checked: t === ch.type, fn: () => cmd.setChannelInstrument(store, ch.id, t) })) });
    }
    items.push({ label: 'Move to group', submenu: () => store.project.groups.filter((g) => g !== 'All').map((g) => ({ label: g, checked: ch.group === g, fn: () => cmd.setChannelGroup(store, ch.id, g) })).concat([{ label: 'All (no group)', checked: !ch.group, fn: () => cmd.setChannelGroup(store, ch.id, 'All') }]) });
    items.push({ sep: true }, { label: 'Open editor', fn: () => app.openChannelEditor(ch.id) });
    return items;
  }

  addMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    showPopup(this.app.addChannelItems(), r.left, r.top - 4 - 22 * 6, r);
  }

  // ----------------------------------------------------------------- steps
  refreshAll() {
    const p = this.store.project, pat = this.store.pattern;
    if (!pat) return;
    this.steps = Math.max(1, Math.ceil(patternLength(p, pat) / STEP));
    // steps selector
    const opts = [...new Set([8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, this.steps])].sort((a, b) => a - b);
    this.stepsSel.textContent = '';
    for (const o of opts) this.stepsSel.append(h('option', { value: o, selected: o === this.steps }, String(o)));
    this.refreshSwing();
    for (const [id, row] of this.rows) this.refreshRow(row, pat);
    this.drawGraph();
    this.refreshBar();
  }

  refreshSwing() { this.swing.value = Math.round(this.store.project.swing * 100); }

  refreshRow(row, pat) {
    const ch = this.store.channel(row.ch.id);
    if (!ch) return;
    row.ch = ch;
    const list = pat.notes[ch.id] || [];
    if (ch.type === 'audio' || ch.type === 'automation') {
      if (!row.info) {
        row.stepsEl.textContent = ''; row.stepEls = []; row.mini = null;
        row.info = h('span.dim', { style: { padding: '0 8px' } }, ch.type === 'audio' ? 'Audio clip — place it in the Playlist' : 'Automation clip — place it in the Playlist and edit its curve');
        row.stepsEl.append(row.info);
      }
      row.el.classList.toggle('off', !ch.enabled);
      row.el.querySelector('.led').classList.toggle('on', !!ch.enabled);
      const nm0 = row.el.querySelector('.ch-name'); nm0.textContent = ch.name; nm0.style.setProperty('--ch', ch.color);
      return;
    }
    const stepLike = list.every(isStepLike);
    const color = ch.color;
    const needStepBtns = stepLike;
    // build or rebuild the step buttons when the count or mode changed
    if (needStepBtns) {
      if (row.stepEls.length !== this.steps || row.mini) {
        row.stepsEl.textContent = '';
        row.stepEls = [];
        row.mini = null;
        let grp = null;
        for (let i = 0; i < this.steps; i++) {
          if (i % 4 === 0) { grp = h('div.step-group'); row.stepsEl.append(grp); }
          const s = h('div.step', { class: Math.floor(i / 4) % 2 === 0 ? '' : 'g1', dataset: { step: i }, hint: `Step ${i + 1} — click to toggle, drag to paint, right-click to erase` });
          s.addEventListener('pointerdown', (e) => this.stepDown(e, ch.id, i));
          s.addEventListener('contextmenu', (e) => e.preventDefault());
          grp.append(s);
          row.stepEls.push(s);
        }
      }
      const on = new Map();
      for (const n of list) on.set(noteStep(n), n);
      for (let i = 0; i < row.stepEls.length; i++) {
        const s = row.stepEls[i], n = on.get(i);
        s.classList.toggle('on', !!n);
        s.style.setProperty('--ch', color);
        s.style.opacity = n ? String(0.45 + 0.55 * (n.v / 127)) : '';
      }
    } else {
      // channel has piano-roll notes: draw a miniature roll instead of buttons
      const W = gridWidth(this.steps);
      if (!row.mini) {
        row.stepsEl.textContent = '';
        row.stepEls = [];
        row.mini = h('canvas.mini-roll', { hint: 'Contains piano-roll notes — click to open the Piano roll' });
        row.mini.addEventListener('pointerdown', (e) => { if (e.button === 0) { this.store.select(row.ch.id); this.app.openWindow('pianoroll'); } });
        row.stepsEl.append(row.mini);
      }
      const dpr = window.devicePixelRatio || 1;
      row.mini.width = W * dpr; row.mini.height = 22 * dpr; row.mini.style.width = `${W}px`; row.mini.style.height = '22px';
      const c = row.mini.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, 22);
      const total = this.steps * STEP;
      let lo = 127, hi = 0;
      for (const n of list) { lo = Math.min(lo, n.k); hi = Math.max(hi, n.k); }
      const span = Math.max(8, hi - lo + 1);
      c.fillStyle = color;
      for (const n of list) {
        const x = (n.s / total) * W, w = Math.max(2, (n.l / total) * W - 1);
        const y = 20 - ((n.k - lo) / span) * 18;
        c.fillRect(x, y - 1, w, 3);
      }
    }
    row.el.classList.toggle('off', !ch.enabled);
    row.el.querySelector('.led').classList.toggle('on', !!ch.enabled);
    const nm = row.el.querySelector('.ch-name');
    nm.textContent = ch.name; nm.style.setProperty('--ch', ch.color);
    row.el.querySelector('.ch-fx').textContent = String(ch.mixer);
  }

  markSelection() {
    for (const [id, row] of this.rows) row.el.classList.toggle('sel', id === this.store.selected);
  }

  stepDown(e, chId, step) {
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    const store = this.store, cmd = this.app.cmd;
    const pat = store.pattern;
    const had = !!store.pattern.notes[chId]?.some((n) => cmd.isStepNote(n, step));
    const mode = e.button === 2 ? 'erase' : had ? 'erase' : 'paint';
    store.select(chId);
    const apply = (st) => {
      const changed = cmd.setStep(store, chId, st, mode === 'paint');
      if (changed && mode === 'paint') this.app.preview(chId, undefined, 90);
    };
    apply(step);
    let last = step;
    const rowEl = this.rows.get(chId)?.el;
    drag(e, (dx, dy, ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const s = el && el.closest ? el.closest('.step') : null;
      if (!s || !rowEl || !rowEl.contains(s)) return;
      const st = +s.dataset.step;
      if (st === last) return;
      const [a, b] = st > last ? [last + 1, st] : [st, last - 1];
      for (let i = a; i <= b; i++) apply(i);
      last = st;
    }, null, { keepCursor: true });
  }

  tickPlay() {
    const app = this.app, st = app.host.st;
    let step = -1;
    if (st.playing && app.transport.mode === 'pat') step = Math.floor(app.transport.displayTick() / STEP) % this.steps;
    if (step === this.playStep) return;
    for (const row of this.rows.values()) {
      if (this.playStep >= 0 && row.stepEls[this.playStep]) row.stepEls[this.playStep].classList.remove('play');
      if (step >= 0 && row.stepEls[step]) row.stepEls[step].classList.add('play');
    }
    this.playStep = step;
  }

  // ----------------------------------------------------------------- graph editor
  toggleGraph() { this.setGraph(!this.graphOpen); }

  setGraph(open) {
    this.graphOpen = open;
    this.graphWrap.style.display = open ? '' : 'none';
    this.graphBar.style.display = open ? 'flex' : 'none';
    this.graphBtn.classList.toggle('on', open);
    this.keyBtn.classList.toggle('on', open && this.prop === 'key');
    this.refreshBar();
    requestAnimationFrame(() => this.drawGraph());
  }

  refreshBar() {
    for (const b of this.graphBar.children) b.classList.toggle('on', b.dataset.prop === this.prop);
    this.keyBtn.classList.toggle('on', this.graphOpen && this.prop === 'key');
  }

  graphGeom() {
    const first = this.list.querySelector('.steps');
    const left = first ? first.offsetLeft : 280;
    return { left, W: left + gridWidth(this.steps) + 12, H: this.graphWrap.clientHeight || 96 };
  }

  drawGraph() {
    if (!this.graphOpen) return;
    const ch = this.store.channel(this.store.selected), pat = this.store.pattern;
    const g = this.graphGeom();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = g.W * dpr; this.canvas.height = g.H * dpr;
    this.canvas.style.width = `${g.W}px`; this.canvas.style.height = `${g.H}px`;
    const c = this.canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#1b1e21'; c.fillRect(0, 0, g.W, g.H);
    const P = PROPS[this.prop];
    c.fillStyle = '#8e989f'; c.font = '10px sans-serif';
    c.fillText(`${P.name}${ch ? ' · ' + ch.name : ''}`, 8, 13);
    if (this.prop === 'key') this.drawKeyStrip(c, g);
    // grid
    for (let i = 0; i < this.steps; i++) {
      c.fillStyle = Math.floor(i / 4) % 2 === 0 ? '#22262a' : '#272c30';
      c.fillRect(g.left + stepX(i) - 1, 0, STEP_W + 2, g.H);
    }
    if (P.bipolar) { c.fillStyle = '#3a4046'; c.fillRect(g.left, g.H / 2, g.W, 1); }
    if (!ch) return;
    const notes = pat.notes[ch.id] || [];
    const top = 16, bot = g.H - 4, span = bot - top;
    c.fillStyle = ch.color;
    for (const n of notes) {
      const st = noteStep(n);
      if (st >= this.steps || !isStepLike(n)) continue;
      const v = P.get(n, st);
      const x = g.left + stepX(st);
      if (P.bipolar) {
        const mid = top + span / 2, y = mid - (v / P.max) * (span / 2);
        c.fillRect(x, Math.min(mid, y), STEP_W, Math.max(2, Math.abs(y - mid)));
      } else {
        const y = bot - ((v - P.min) / (P.max - P.min)) * span;
        c.fillRect(x, y, STEP_W, bot - y);
        if (this.prop === 'key') { c.fillStyle = '#111'; c.font = '9px sans-serif'; c.fillText(keyName(v), x + 1, y + 10); c.fillStyle = ch.color; }
      }
    }
  }

  drawKeyStrip(c, g) {
    // a tiny keyboard on the left edge of the graph, one octave per band
    const bot = g.H - 4, top = 16;
    for (let k = 0; k <= 120; k += 12) {
      const y = bot - (k / 120) * (bot - top);
      c.fillStyle = '#3a4046'; c.fillRect(0, y, g.left - 6, 1);
      c.fillStyle = '#8e989f'; c.font = '9px sans-serif'; c.fillText(`C${k / 12}`, 2, y - 1);
    }
  }

  graphPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    const g = this.graphGeom();
    const x = e.clientX - r.left - g.left, y = e.clientY - r.top;
    let step = -1;
    for (let i = 0; i < this.steps; i++) if (x >= stepX(i) - 1 && x <= stepX(i) + STEP_W + 1) { step = i; break; }
    if (step < 0) step = clamp(Math.round((x - STEP_W / 2) / (STEP_W + STEP_GAP + GROUP_GAP / 4)), 0, this.steps - 1);
    const P = PROPS[this.prop];
    const top = 16, bot = g.H - 4;
    const t = clamp(1 - (y - top) / (bot - top), 0, 1);
    let v = P.min + t * (P.max - P.min);
    v = Math.round(v);
    if (P.bipolar && Math.abs(v) <= (P.max - P.min) * 0.02) v = 0;
    return { step, v };
  }

  graphHover(e) {
    const ch = this.store.channel(this.store.selected);
    if (!ch) return;
    const { step, v } = this.graphPoint(e);
    const n = this.store.pattern.notes[ch.id]?.find((x) => noteStep(x) === step);
    this.canvas.dataset.hint = `${PROPS[this.prop].name} — step ${step + 1}${n ? `: ${this.prop === 'key' ? keyName(PROPS.key.get(n)) : PROPS[this.prop].get(n, step)}` : ' (no note)'}. Click or drag to paint values`;
    this.app.hint.update(this.canvas);
  }

  graphDown(e) {
    if (e.button !== 0) return;
    const ch = this.store.channel(this.store.selected);
    if (!ch) return;
    const P = PROPS[this.prop], pat = this.store.pattern, store = this.store;
    let last = null;
    const paint = (ev) => {
      const { step, v } = this.graphPoint(ev);
      const from = last === null ? step : last.step, fromV = last === null ? v : last.v;
      store.edit(`Edit ${P.name}`, () => {
        const list = pat.notes[ch.id] || [];
        const a = Math.min(from, step), b = Math.max(from, step);
        for (let s = a; s <= b; s++) {
          const n = list.find((x) => noteStep(x) === s);
          if (!n) continue;
          const t = a === b ? 1 : (s - from) / (step - from);
          P.set(n, Math.round(fromV + (v - fromV) * clamp(t, 0, 1)), s);
        }
      }, [['patterns', pat.id]], { coalesce: `graph:${this.prop}` });
      last = { step, v };
    };
    paint(e);
    drag(e, (dx, dy, ev) => paint(ev), null, { keepCursor: true });
  }
}

export function createRack(win, app) {
  win.setTitle('Channel rack');
  const rack = new ChannelRack(win, app);
  return rack;
}
