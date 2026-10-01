// Browser panel (F8): a tree of everything you can use — sound packs, plugin presets, saved channel and
// mixer presets, projects, rendered/recorded audio, scores, templates, the current project and backups.
// Click previews audio, double-click adds, drag onto the Channel rack / Mixer / Playlist / Piano roll.
import { h, clear } from './h.js';
import { contextMenu } from './menu.js';
import { confirmBox, promptText } from './dialog.js';
import { drawWave } from './waveform.js';
import { FACTORY, IRS, factoryId, collectFactorySamples } from '../core/factory.js';
import { INSTRUMENTS } from '../core/instruments/index.js';
import { EFFECTS } from '../core/effects/index.js';
import { INSTRUMENT_PRESETS, EFFECT_PRESETS } from '../core/presets.js';
import { TEMPLATES } from '../core/templates.js';
import { userPresets, saveUserPresets } from './presets-ui.js';
import { createProject, createChannel, createNote, createClip, currentArrangement, normalize, barTicks } from '../core/project.js';
import { renderOffline } from '../core/offline.js';
import { STEP } from '../core/constants.js';
import { channelSnapshot, mixerSnapshot, scoreSnapshot } from '../app/library.js';

const LS_OPEN = 'stepwise.browser.open';
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

class Previewer {
  constructor(app) { this.app = app; this.src = null; this.key = null; }
  stop() { if (this.src) { try { this.src.stop(); } catch (_) { /* already ended */ } this.src.disconnect(); this.src = null; } this.key = null; }
  // channels: Float32Array[]
  play(key, channels, rate) {
    const ctx = this.app.host.ctx;
    this.stop();
    if (!ctx || !channels || !channels[0] || !channels[0].length) return null;
    this.app.host.resume();
    const buf = ctx.createBuffer(channels.length > 1 ? 2 : 1, channels[0].length, rate);
    channels.slice(0, 2).forEach((c, i) => buf.copyToChannel(c, i));
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = 0.8;
    src.connect(g); g.connect(ctx.destination);
    src.onended = () => { if (this.src === src) { this.src = null; this.key = null; this.app.store.bus.emit('browser-preview', null); } };
    src.start();
    this.src = src; this.key = key;
    return buf.duration;
  }
}

export class Browser {
  constructor(app, root) {
    this.app = app; this.root = root;
    this.open = new Set(JSON.parse(localStorage.getItem(LS_OPEN) || '["packs"]'));
    this.query = '';
    this.cache = new Map();        // folder id -> loaded children
    this.prev = new Previewer(app);
    this.auto = true;
    this.loading = new Set();
    this.build();
    const bus = app.store.bus;
    const refresh = () => { this.cache.clear(); if (this.visible()) this.render(); };
    bus.on('library', refresh); bus.on('presets', refresh); bus.on('saved', refresh); bus.on('autosaved', () => { this.cache.delete('backup'); });
    bus.on('samples', () => { this.cache.delete('current'); });
    bus.on('project', refresh);
    bus.on('change', ({ paths }) => { if (this.visible() && this.open.has('current') && paths.some((p) => ['channels', 'patterns', 'playlist'].includes(p[0]))) { this.cache.delete('current'); this.renderSoon(); } });
  }

  visible() { return !this.root.classList.contains('hidden'); }
  onShow() { this.render(); }
  renderSoon() { clearTimeout(this._t); this._t = setTimeout(() => this.render(), 150); }

  build() {
    this.search = h('input.field', { type: 'search', placeholder: 'Search the browser…', style: { flex: 1, minWidth: 0 }, hint: 'Search — filters every section by name' });
    this.search.addEventListener('input', () => { this.query = this.search.value.trim().toLowerCase(); this.render(); });
    this.search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { this.search.value = ''; this.query = ''; this.render(); } });
    this.autoBtn = h('div.btn.sm.on', { hint: 'Auto-play — preview a sound or preset when it is clicked', onclick: () => { this.auto = !this.auto; this.autoBtn.classList.toggle('on', this.auto); } }, '♪');
    this.tree = h('div.br-tree.scroll');
    this.info = h('div.br-info');
    this.wave = h('canvas', { width: 220, height: 38, style: { width: '100%', height: '38px', display: 'block', background: '#0e1012' } });
    this.stopBtn = h('div.btn.sm', { hint: 'Stop the preview', onclick: () => { this.prev.stop(); this.showInfo(null); } }, '■');
    this.foot = h('div.br-foot', h('div.row', { style: { gap: '6px' } }, this.info, h('div.grow'), this.stopBtn), this.wave);
    this.root.append(h('div.br-head', this.search, this.autoBtn), this.tree, this.foot);
    this.showInfo(null);
  }

  showInfo(text, entry) {
    this.info.textContent = text || 'Click a sound to hear it. Double-click or drag to use it.';
    drawWave(this.wave, entry || null, { label: ' ' });
  }

  // ------------------------------------------------------------------ data
  samplesNode(kind, label, empty) {
    return { id: kind, label, folder: true, load: async () => {
      const list = await this.app.library.list(kind);
      if (!list.length) return [{ label: empty, hintOnly: true }];
      return list.map((e) => ({ id: `${kind}:${e.name}`, label: e.name, sample: { id: e.data.id, name: e.name }, right: ago(e.time), menu: () => [{ label: 'Delete', fn: () => this.app.library.remove(kind, e.name) }] }));
    } };
  }

  sections() {
    const app = this.app, p = app.store.project;
    const cats = {};
    for (const f of FACTORY) (cats[f.cat] = cats[f.cat] || []).push(f);
    const packs = { id: 'packs', label: 'Packs', folder: true, children: () => [{ id: 'packs:fl', label: 'FL LUA Drums', folder: true, children: () => Object.entries(cats).map(([c, list]) => ({ id: `packs:fl:${c}`, label: c, folder: true, children: () => list.map((f) => ({ id: `s:${f.id}`, label: f.name, sample: { id: factoryId(f.id), name: f.name } })) })) },
      { id: 'packs:ir', label: 'Impulse responses', folder: true, children: () => IRS.map((f) => ({ id: `ir:${f.id}`, label: f.name, sample: { id: `factory:${f.id}`, name: f.name } })) }] };

    const instNodes = () => {
      const types = new Set([...Object.keys(INSTRUMENT_PRESETS)]);
      for (const t of Object.keys(INSTRUMENTS)) if (Object.keys(userPresets('inst', t)).length) types.add(t);
      return [...types].filter((t) => INSTRUMENTS[t]).map((t) => ({ id: `pi:${t}`, label: INSTRUMENTS[t].meta.name, folder: true, addPlugin: { kind: 'inst', type: t }, children: () => {
        const user = userPresets('inst', t);
        return [...Object.entries(INSTRUMENT_PRESETS[t] || {}).map(([n, params]) => ({ id: `ip:${t}:${n}`, label: n, preset: { kind: 'inst', type: t, name: n, params } })),
          ...Object.entries(user).map(([n, v]) => ({ id: `ipu:${t}:${n}`, label: n, right: 'mine', preset: { kind: 'inst', type: t, name: n, params: v.params }, menu: () => [{ label: 'Delete preset', fn: () => { const all = userPresets('inst', t); delete all[n]; saveUserPresets('inst', t, all); app.store.bus.emit('presets'); } }] }))];
      } }));
    };
    const fxNodes = () => {
      const types = new Set(Object.keys(EFFECT_PRESETS));
      for (const t of Object.keys(EFFECTS)) if (Object.keys(userPresets('fx', t)).length) types.add(t);
      return [...types].filter((t) => EFFECTS[t]).map((t) => ({ id: `pf:${t}`, label: EFFECTS[t].meta.name, folder: true, addPlugin: { kind: 'fx', type: t }, children: () => {
        const user = userPresets('fx', t);
        return [...Object.entries(EFFECT_PRESETS[t] || {}).map(([n, params]) => ({ id: `fp:${t}:${n}`, label: n, preset: { kind: 'fx', type: t, name: n, params } })),
          ...Object.entries(user).map(([n, v]) => ({ id: `fpu:${t}:${n}`, label: n, right: 'mine', preset: { kind: 'fx', type: t, name: n, params: v.params, extra: v.extra }, menu: () => [{ label: 'Delete preset', fn: () => { const all = userPresets('fx', t); delete all[n]; saveUserPresets('fx', t, all); app.store.bus.emit('presets'); } }] }))];
      } }));
    };
    const presets = { id: 'presets', label: 'Plugin presets', folder: true, children: () => [{ id: 'presets:inst', label: 'Generators', folder: true, children: instNodes }, { id: 'presets:fx', label: 'Effects', folder: true, children: fxNodes }] };

    const channelPresets = { id: 'channel', label: 'Channel presets', folder: true, load: async () => {
      const list = await app.library.list('channel');
      if (!list.length) return [{ label: 'Right-click a channel → Save as channel preset', hintOnly: true }];
      return list.map((e) => ({ id: `chp:${e.name}`, label: e.name, right: ago(e.time), chanPreset: e, menu: () => [{ label: 'Add to the project', fn: () => app.addChannelPreset(e.data) }, { label: 'Rename…', fn: async () => { const n = await promptText('Rename preset', 'Name', e.name); if (n) app.library.rename('channel', e.name, n); } }, { label: 'Delete', fn: () => app.library.remove('channel', e.name) }] }));
    } };
    const mixerPresets = { id: 'mixer', label: 'Mixer presets', folder: true, load: async () => {
      const list = await app.library.list('mixer');
      if (!list.length) return [{ label: 'Right-click a mixer strip → Save as mixer preset', hintOnly: true }];
      return list.map((e) => ({ id: `mxp:${e.name}`, label: e.name, right: ago(e.time), mixPreset: e, menu: () => [{ label: 'Apply to the selected track', fn: () => app.applyMixerPreset(e.data) }, { label: 'Delete', fn: () => app.library.remove('mixer', e.name) }] }));
    } };
    const projects = { id: 'project', label: 'Projects', folder: true, load: async () => {
      const list = await app.library.projects();
      if (!list.length) return [{ label: 'Nothing saved yet (Ctrl+S saves in this browser)', hintOnly: true }];
      return list.map((e) => ({ id: `prj:${e.key}`, label: e.name, right: ago(e.time), project: e, menu: () => [{ label: 'Open', fn: () => app.openSavedProject(e) }, { label: 'Download .fllua', fn: () => app.downloadJson(e.json, e.name) }, { label: 'Delete', fn: async () => { if (await confirmBox('Delete project', `Delete "${e.name}" from this browser?`, 'Delete')) app.library.deleteProject(e.key); } }] }));
    } };
    const scores = { id: 'score', label: 'Scores', folder: true, load: async () => {
      const list = await app.library.list('score');
      if (!list.length) return [{ label: 'Piano roll → Tools → Save selection as score', hintOnly: true }];
      return list.map((e) => ({ id: `sc:${e.name}`, label: e.name, right: `${e.data.length} notes`, score: e, menu: () => [{ label: 'Paste into the selected channel', fn: () => app.pasteScore(e.data) }, { label: 'Delete', fn: () => app.library.remove('score', e.name) }] }));
    } };
    const templates = { id: 'template', label: 'Templates', folder: true, load: async () => {
      const mine = await app.library.list('template');
      return [...TEMPLATES.map((t) => ({ id: `tpl:${t.id}`, label: t.name, right: t.description.length > 24 ? '' : t.description, tooltip: t.description, template: { build: t.build, name: t.name } })),
        ...mine.map((e) => ({ id: `tplu:${e.name}`, label: e.name, right: 'mine', template: { json: e.data, name: e.name }, menu: () => [{ label: 'Delete template', fn: () => app.library.remove('template', e.name) }] }))];
    } };
    const current = { id: 'current', label: 'Current project', folder: true, children: () => {
      const arr = currentArrangement(p);
      const used = new Map();
      for (const c of p.channels) if (c.sample) used.set(c.sample.id, c.sample.name);
      for (const c of p.channels) if (c.pads) for (const pad of c.pads) for (const l of pad.layers || []) used.set(l.sample.id, l.sample.name);
      return [
        { id: 'cur:ch', label: `Channels (${p.channels.length})`, folder: true, children: () => p.channels.map((c) => ({ id: `cur:ch:${c.id}`, label: c.name, right: c.type, channel: c.id })) },
        { id: 'cur:pat', label: `Patterns (${Object.keys(p.patterns).length})`, folder: true, children: () => Object.values(p.patterns).map((pt) => ({ id: `cur:pat:${pt.id}`, label: `${String(pt.id).padStart(2, '0')} ${pt.name}`, pattern: pt.id })) },
        { id: 'cur:smp', label: `Samples (${used.size})`, folder: true, children: () => [...used].map(([id, nm]) => ({ id: `cur:smp:${id}`, label: nm, sample: { id, name: nm } })) },
        { id: 'cur:clips', label: `Playlist clips (${arr.clips.length})`, folder: true, children: () => arr.clips.slice(0, 200).map((c) => ({ id: `cur:clip:${c.id}`, label: c.name || (c.type === 'pattern' ? p.patterns[c.ref]?.name : p.channels.find((x) => x.id === c.ref)?.name) || c.type, right: `track ${c.track}`, clip: c })) },
      ];
    } };
    const backup = { id: 'backup', label: 'Backup', folder: true, load: async () => {
      const auto = await app.library.autosave(), list = await app.library.backups();
      const out = [];
      if (auto) out.push({ id: 'bk:auto', label: `Autosave: ${auto.name}`, right: ago(auto.time), project: auto, restore: true });
      for (const b of list) out.push({ id: `bk:${b.key}`, label: b.name, right: ago(b.time), project: b, restore: true, menu: () => [{ label: 'Restore', fn: () => app.openSavedProject(b) }] });
      return out.length ? out : [{ label: 'Backups appear here while you work', hintOnly: true }];
    } };
    return [packs, presets, channelPresets, mixerPresets, projects, this.samplesNode('rendered', 'Rendered', 'Export audio and it shows up here'), this.samplesNode('recorded', 'Recorded', 'Audio you record appears here'), scores, templates, current, backup];
  }

  // ------------------------------------------------------------------ rendering
  persist() { try { localStorage.setItem(LS_OPEN, JSON.stringify([...this.open])); } catch (_) { /* private mode */ } }

  async kids(node) {
    if (node.children) return node.children();
    if (node.load) {
      if (this.cache.has(node.id)) return this.cache.get(node.id);
      if (this.loading.has(node.id)) return [{ label: 'Loading…', hintOnly: true }];
      this.loading.add(node.id);
      try { const k = await node.load(); this.cache.set(node.id, k); return k; } finally { this.loading.delete(node.id); }
    }
    return [];
  }

  async render() {
    if (!this.visible()) return;
    const token = ++this.renderToken || (this.renderToken = 1);
    const frag = [];
    const q = this.query;
    const walk = async (nodes, depth) => {
      for (const n of nodes) {
        if (token !== this.renderToken) return false;
        if (n.hintOnly) { if (!q) frag.push(h('div.br-hint', { style: { paddingLeft: `${10 + depth * 12}px` } }, n.label)); continue; }
        if (n.folder) {
          const kids = (q || this.open.has(n.id)) ? await this.kids(n) : null;
          let sub = [];
          if (kids) {
            const saved = frag.length;
            await walk(kids, depth + 1);
            sub = frag.splice(saved);
          }
          if (q && !sub.length && !n.label.toLowerCase().includes(q)) continue;
          const open = !!q || this.open.has(n.id);
          const row = h('div.br-row.folder', { style: { paddingLeft: `${4 + depth * 12}px` }, dataset: { node: n.id } }, h('span.br-caret', open ? '▾' : '▸'), h('span.br-label', n.label));
          row.addEventListener('click', () => { if (this.open.has(n.id)) this.open.delete(n.id); else this.open.add(n.id); this.persist(); this.render(); });
          if (n.addPlugin) row.addEventListener('dblclick', (e) => { e.stopPropagation(); this.addPlugin(n.addPlugin); });
          frag.push(row, ...sub);
        } else {
          if (q && !`${n.label} ${n.right || ''}`.toLowerCase().includes(q)) continue;
          frag.push(this.leaf(n, depth));
        }
      }
      return true;
    };
    await walk(this.sections(), 0);
    if (token !== this.renderToken) return;
    clear(this.tree);
    this.tree.append(...frag);
    if (q && !frag.length) this.tree.append(h('div.br-hint', { style: { padding: '12px' } }, 'No matches'));
  }

  leaf(n, depth) {
    const icon = n.sample ? '♪' : n.preset ? '◆' : n.chanPreset ? '▤' : n.mixPreset ? '≡' : n.project ? '▣' : n.score ? '♬' : n.template ? '❖' : n.channel ? '●' : n.pattern ? '▦' : n.clip ? '▬' : '·';
    const row = h('div.br-row.leaf', { style: { paddingLeft: `${16 + depth * 12}px` }, dataset: { node: n.id }, draggable: !!(n.sample || n.preset || n.chanPreset || n.mixPreset || n.score), hint: `${n.label} — ${n.tooltip || this.describe(n)}` },
      h('span.br-icon', icon), h('span.br-label', n.label), n.right ? h('span.br-right', n.right) : null);
    row.addEventListener('click', () => this.click(n, row));
    row.addEventListener('dblclick', () => this.activate(n));
    row.addEventListener('contextmenu', (e) => contextMenu(e, [{ label: 'Use', fn: () => this.activate(n) }, ...(n.sample || n.preset ? [{ label: 'Preview', fn: () => this.preview(n, true) }] : []), ...(n.menu ? [{ sep: true }, ...n.menu()] : [])]));
    row.addEventListener('dragstart', (e) => this.dragStart(e, n));
    return row;
  }

  describe(n) {
    if (n.sample) return 'click to preview, double-click to add as a channel, drag to the Channel rack, Playlist, FPC pad or Sampler';
    if (n.preset) return n.preset.kind === 'inst' ? 'click to preview, double-click to add a channel with this sound, drag onto a channel of the same plugin to load it' : 'click to preview on a drum loop, double-click to add to the selected mixer track, drag onto a mixer slot';
    if (n.template) return 'double-click to start a new project from it';
    if (n.project) return 'double-click to open';
    if (n.chanPreset) return 'double-click or drag to add the channel';
    if (n.mixPreset) return 'double-click to apply to the selected mixer track';
    if (n.score) return 'double-click to paste the notes into the selected channel';
    if (n.channel) return 'click to select, double-click to open its editor';
    if (n.pattern) return 'click to select the pattern';
    return n.label;
  }

  dragStart(e, n) {
    const dt = e.dataTransfer;
    dt.effectAllowed = 'copy';
    if (n.sample) dt.setData('application/x-stepwise-sample', JSON.stringify(n.sample));
    else if (n.preset) dt.setData(n.preset.kind === 'inst' ? 'application/x-stepwise-inst' : 'application/x-stepwise-fx', JSON.stringify({ type: n.preset.type, params: n.preset.params, extra: n.preset.extra }));
    else if (n.chanPreset) dt.setData('application/x-stepwise-chan', JSON.stringify(n.chanPreset.data));
    else if (n.mixPreset) dt.setData('application/x-stepwise-mixer', JSON.stringify(n.mixPreset.data));
    else if (n.score) dt.setData('application/x-stepwise-score', JSON.stringify(n.score.data));
    dt.setData('text/plain', n.label);
  }

  // ------------------------------------------------------------------ actions
  click(n, row) {
    for (const r of this.tree.querySelectorAll('.br-row.sel')) r.classList.remove('sel');
    row.classList.add('sel');
    const app = this.app;
    if (n.channel) { app.store.select(n.channel); return; }
    if (n.pattern) { app.cmd.selectPattern(app.store, n.pattern); return; }
    if (this.auto && (n.sample || n.preset)) this.preview(n);
  }

  async preview(n, force = false) {
    const app = this.app;
    if (this.prev.key === n.id && !force) { this.prev.stop(); this.showInfo(null); return; }
    if (n.sample) {
      const e = await app.bank.ensure(n.sample.id);
      if (!e) { app.toast('That sound is not available any more'); return; }
      const dur = this.prev.play(n.id, e.channels, e.rate);
      this.showInfo(`${n.label} · ${(e.length / e.rate).toFixed(2)} s`, e);
      void dur;
      return;
    }
    if (n.preset) {
      this.showInfo(`Rendering ${n.label}…`);
      await new Promise((r) => setTimeout(r, 10));
      const r = renderPreset(n.preset, app.host.sampleRate);
      if (!r) return;
      this.prev.play(n.id, [r.left, r.right], r.sampleRate);
      this.showInfo(`${n.label} · preview`, { channels: [r.left], length: r.left.length, rate: r.sampleRate });
    }
  }

  async activate(n) {
    const app = this.app;
    this.prev.stop();
    if (n.sample) { const e = await app.bank.ensure(n.sample.id); if (e) app.addSamplerFor(n.sample); return; }
    if (n.preset) { n.preset.kind === 'inst' ? app.addInstrumentPreset(n.preset.type, n.preset.params, n.preset.name) : app.addEffectPreset(n.preset.type, n.preset.params, n.preset.extra, n.preset.name); return; }
    if (n.chanPreset) { app.addChannelPreset(n.chanPreset.data); return; }
    if (n.mixPreset) { app.applyMixerPreset(n.mixPreset.data); return; }
    if (n.score) { app.pasteScore(n.score.data); return; }
    if (n.template) { app.newFromTemplate(n.template); return; }
    if (n.project) { app.openSavedProject(n.project); return; }
    if (n.channel) { app.store.select(n.channel); app.openChannelEditor(n.channel); return; }
    if (n.pattern) { app.cmd.selectPattern(app.store, n.pattern); app.openWindow('pianoroll'); return; }
    if (n.clip) { app.openWindow('playlist'); }
  }

  addPlugin(spec) { spec.kind === 'inst' ? this.app.addInstrument(spec.type) : this.app.addEffectToSelected(spec.type); }
}

// Offline preview of a preset: instruments play a short phrase, effects process a drum loop.
export function renderPreset(preset, sr = 44100) {
  const p = createProject(); p.tempo = 120;
  if (preset.kind === 'inst') {
    const ch = createChannel(p, preset.type, { name: 'preview', mixer: 0, params: preset.params });
    p.channels.push(ch);
    const drums = INSTRUMENTS[preset.type].meta.kind === 'drums';
    const phrase = drums ? [[0, 60, 4]] : [[0, 57, 4], [4, 60, 4], [8, 64, 8]];
    p.patterns[1].notes[ch.id] = phrase.map(([s, k, l]) => createNote(p, s * STEP, l * STEP, k, 100));
  } else {
    const mk = (key, mixer) => { const c = createChannel(p, 'sampler', { name: key, mixer, sample: { id: `factory:${key}`, name: key } }); p.channels.push(c); return c; };
    const kick = mk('kick-punch', 1), snare = mk('snare-tight', 1), hat = mk('hat-closed', 1);
    const put = (c, steps, v) => { p.patterns[1].notes[c.id] = steps.map((s) => createNote(p, s * STEP, STEP, 60, v)); };
    put(kick, [0, 4, 8, 12], 115); put(snare, [4, 12], 105); put(hat, [0, 2, 4, 6, 8, 10, 12, 14], 70);
    p.mixer.tracks[1].fx[0] = { type: preset.type, on: 1, mix: 1, params: { ...Object.fromEntries(EFFECTS[preset.type].schema.map((d) => [d.id, d.def])), ...preset.params } };
    if (preset.extra) p.mixer.tracks[1].fx[0].extra = JSON.parse(JSON.stringify(preset.extra));
  }
  const r = renderOffline(p, collectFactorySamples(p, sr), { mode: 'pat', sampleRate: sr, tail: preset.kind === 'inst' ? 1.2 : 0.8 });
  return r && r.frames ? r : null;
}

export { channelSnapshot, mixerSnapshot, scoreSnapshot, createClip, normalize, barTicks };
