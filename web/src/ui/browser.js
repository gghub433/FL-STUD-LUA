// Browser panel (F8): a tree of everything you can use — the person's own sound folders (My sounds), sound packs,
// plugin presets, saved channel and mixer presets, projects, rendered/recorded audio, scores, templates, the current
// project and backups. Click previews audio, double-click adds, drag onto the Channel rack / Mixer / Playlist / Piano roll.
import { h, clear } from './h.js';
import { contextMenu } from './menu.js';
import { confirmBox, promptText } from './dialog.js';
import { drawWave } from './waveform.js';
import { FACTORY, IRS, factoryId, collectFactorySamples } from '../core/factory.js';
import { INSTRUMENTS } from '../core/instruments/index.js';
import { EFFECTS } from '../core/effects/index.js';
import { formatLabel } from '../core/plugin-schema.js';
import { INSTRUMENT_PRESETS, EFFECT_PRESETS } from '../core/presets.js';
import { TEMPLATES } from '../core/templates.js';
import { loadedPacks, packSounds } from '../core/packs.js';
import { userPresets, saveUserPresets } from './presets-ui.js';
import { createProject, createChannel, createNote, createClip, currentArrangement, normalize, barTicks } from '../core/project.js';
import { renderOffline } from '../core/offline.js';
import { STEP } from '../core/constants.js';
import { channelSnapshot, mixerSnapshot, scoreSnapshot } from '../app/library.js';
import { soundName, extOf, dirName, joinPath, pageOf, isAudioDrop } from '../core/sound-files.js';
import { MAX_TRACK, defaultClipLength } from '../core/playlist-ops.js';
import { SOUND_TYPE } from './sound-drop.js';

const LS_OPEN = 'stepwise.browser.open';
const PAGE = 300;                   // rows of one My sounds folder drawn at a time
const HITS = 200;                   // My sounds search results shown
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
    this.open = new Set(JSON.parse(localStorage.getItem(LS_OPEN) || '["mysounds","packs"]'));
    this.pages = new Map();        // My sounds folder id -> rows shown (big folders grow page by page)
    this.query = '';
    this.cache = new Map();        // folder id -> loaded children
    this.prev = new Previewer(app);
    this.auto = true;
    this.loading = new Set();
    this.build();
    const bus = app.store.bus;
    const refresh = () => { this.cache.clear(); if (this.visible()) this.render(); };
    bus.on('library', refresh); bus.on('presets', refresh); bus.on('plugins-catalog', refresh); bus.on('saved', refresh); bus.on('autosaved', () => { this.cache.delete('backup'); });
    bus.on('samples', () => { this.cache.delete('current'); });
    bus.on('project', refresh);
    // My sounds: folders added, removed or refreshed; search results while the index is being built
    bus.on('sounds', () => { for (const k of [...this.cache.keys()]) if (k.startsWith('ms:')) this.cache.delete(k); if (this.visible()) this.render(); });
    bus.on('sounds-index', () => { if (this.query && this.visible()) this.renderSoon(); });
    bus.on('plugins', refresh);                                           // a pack with sounds was installed or removed
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
    // folders dropped from the system become My sounds (loose audio files go to Picked files)
    const files = (e) => !!(this.app.sounds && e.dataTransfer && [...e.dataTransfer.types].includes('Files'));
    this.root.addEventListener('dragover', (e) => { if (files(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; this.root.classList.add('br-drop'); } });
    this.root.addEventListener('dragleave', (e) => { if (!this.root.contains(e.relatedTarget)) this.root.classList.remove('br-drop'); });
    // only folders and sounds: a project or MIDI file dropped here is opened by the page as usual
    const takes = (dt) => [...dt.items].some((i) => i.kind === 'file' && i.webkitGetAsEntry && (i.webkitGetAsEntry() || {}).isDirectory) || [...dt.files].some(isAudioDrop);
    this.root.addEventListener('drop', (e) => { this.root.classList.remove('br-drop'); if (files(e) && takes(e.dataTransfer)) { e.preventDefault(); this.dropFolders(e.dataTransfer); } });
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
      { id: 'packs:ir', label: 'Impulse responses', folder: true, children: () => IRS.map((f) => ({ id: `ir:${f.id}`, label: f.name, sample: { id: `factory:${f.id}`, name: f.name } })) },
      // sound packs from the Plugin store: their samples are made by the pack's code when first used
      ...loadedPacks().filter((pk) => pk.sounds > 0).map((pk) => ({ id: `packs:p:${pk.id}`, label: pk.name, folder: true, children: () => {
        const byCat = {};
        for (const [id, s] of packSounds) if (s.pack === pk.id) (byCat[s.cat] = byCat[s.cat] || []).push({ id: `ps:${id}`, label: s.name, sample: { id, name: s.name } });
        return Object.entries(byCat).map(([c, list]) => ({ id: `packs:p:${pk.id}:${c}`, label: c, folder: true, children: () => list }));
      } }))] };

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
    // installed VST / CLAP plugins (desktop app): double-click adds one
    const P = app.plugins;
    const pluginDb = P && P.available ? { id: 'plugdb', label: 'Plugin database', folder: true, children: () => {
      const all = P.catalog.plugins || [];
      if (!all.length) return [{ label: P.catalog.scannedAt ? 'No VST / CLAP plugins found (OPTIONS > Manage plugins…)' : 'OPTIONS > Manage plugins… > Find plugins', hintOnly: true }];
      const node = (kind, label) => ({ id: `plugdb:${kind}`, label, folder: true, children: () => {
        const byVendor = new Map();
        for (const p of all.filter((x) => x.kind === kind)) { const v = p.vendor || 'Other'; if (!byVendor.has(v)) byVendor.set(v, []); byVendor.get(v).push(p); }
        return [...byVendor].sort((a, b) => a[0].localeCompare(b[0])).map(([v, ps]) => ({ id: `plugdb:${kind}:${v}`, label: v, folder: true, children: () => ps.map((p) => ({ id: `plugdb:${p.format}:${p.uid}:${p.path}`, label: p.name, right: formatLabel(p.format), installed: p })) }));
      } });
      return [node('instrument', 'Generators'), node('effect', 'Effects')];
    } } : null;
    const S = app.sounds;
    const mySounds = S ? { id: 'mysounds', label: 'My sounds', folder: true, tooltip: 'Folders with your own samples: click to preview, double-click or drag to use',
      menu: () => [{ label: S.canPickFolder ? 'Add folder…' : 'Add files…', fn: () => this.addSoundFolder() }, { label: 'Refresh', fn: () => S.refresh() }],
      children: () => (this.query ? this.soundHits(this.query) : this.soundRoots()) } : null;
    return [mySounds, pluginDb, packs, presets, channelPresets, mixerPresets, projects, this.samplesNode('rendered', 'Rendered', 'Export audio and it shows up here'), this.samplesNode('recorded', 'Recorded', 'Audio you record appears here'), scores, templates, current, backup].filter(Boolean);
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
        if (n.hintOnly) { if (!q || n.always) frag.push(h('div.br-hint', { style: { paddingLeft: `${10 + depth * 12}px` } }, n.label)); continue; }
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
          const row = h('div.br-row.folder', { style: { paddingLeft: `${4 + depth * 12}px` }, dataset: { node: n.id }, hint: n.tooltip ? `${n.label} — ${n.tooltip}` : undefined }, h('span.br-caret', open ? '▾' : '▸'), h('span.br-label', n.label), n.right ? h('span.br-right', n.right) : null);
          row.addEventListener('click', () => { if (this.open.has(n.id)) this.open.delete(n.id); else { this.open.add(n.id); if (n.onOpen) n.onOpen(); } this.persist(); this.render(); });
          if (n.menu) row.addEventListener('contextmenu', (e) => contextMenu(e, n.menu()));
          if (n.addPlugin) row.addEventListener('dblclick', (e) => { e.stopPropagation(); this.addPlugin(n.addPlugin); });
          frag.push(row, ...sub);
        } else {
          if (q && !n.matched && !`${n.label} ${n.right || ''}`.toLowerCase().includes(q)) continue;
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
    if (n.action) {                                       // "Add folder…", "Show more", "Allow access…"
      const row = h('div.br-row.leaf.br-action', { style: { paddingLeft: `${16 + depth * 12}px` }, dataset: { node: n.id }, hint: n.label }, h('span.br-icon', '＋'), h('span.br-label', n.label));
      row.addEventListener('click', () => n.action());
      return row;
    }
    const icon = n.sample || n.disk ? '♪' : n.preset ? '◆' : n.chanPreset ? '▤' : n.mixPreset ? '≡' : n.project ? '▣' : n.score ? '♬' : n.template ? '❖' : n.channel ? '●' : n.pattern ? '▦' : n.clip ? '▬' : '·';
    const row = h('div.br-row.leaf', { style: { paddingLeft: `${16 + depth * 12}px` }, dataset: { node: n.id }, draggable: !!(n.sample || n.disk || n.preset || n.chanPreset || n.mixPreset || n.score), hint: `${n.label} — ${n.tooltip || this.describe(n)}` },
      h('span.br-icon', icon), h('span.br-label', n.label), n.right ? h('span.br-right', n.right) : null);
    row.addEventListener('click', () => this.click(n, row));
    row.addEventListener('dblclick', () => this.activate(n));
    row.addEventListener('contextmenu', (e) => contextMenu(e, n.disk ? this.diskMenu(n) : [{ label: 'Use', fn: () => this.activate(n) }, ...(n.sample || n.preset ? [{ label: 'Preview', fn: () => this.preview(n, true) }] : []), ...(n.sample && this.app.openAudioEditor ? [{ label: 'Open in the audio editor', fn: () => this.app.openAudioEditor({ sampleId: n.sample.id, name: n.sample.name }) }] : []), ...(n.menu ? [{ sep: true }, ...n.menu()] : [])]));
    row.addEventListener('dragstart', (e) => this.dragStart(e, n));
    return row;
  }

  describe(n) {
    if (n.sample) return 'click to preview, double-click to add as a channel, drag to the Channel rack, Playlist, FPC pad or Sampler';
    if (n.disk) return 'click to preview, double-click to add a Sampler channel, drag to the Channel rack, Playlist, a Sampler or the audio editor';
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
    else if (n.disk) dt.setData(SOUND_TYPE, JSON.stringify(n.disk));
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
    if (this.auto && (n.sample || n.disk || n.preset)) this.preview(n);
  }

  async preview(n, force = false) {
    const app = this.app;
    if (this.prev.key === n.id && !force) { this.prev.stop(); this.showInfo(null); return; }
    this.wanted = n.id;
    if (n.disk) {                                         // a file from My sounds: decoded, not added to the project
      this.showInfo(`Loading ${n.label}…`);
      let d;
      try { d = await app.sounds.decode(n.disk.root, n.disk.rel); } catch (err) { if (this.wanted === n.id) { this.showInfo(null); app.toast(`Could not play ${n.label}: ${err.message}`); } return; }
      if (this.wanted !== n.id) return;                   // another sound was clicked meanwhile
      this.prev.play(n.id, d.channels, d.rate);
      this.showInfo(`${n.label} · ${(d.length / d.rate).toFixed(2)} s`, d);
      return;
    }
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
    if (n.disk) { const s = await this.useDisk(n); if (s) app.addSamplerFor(s); return; }
    if (n.preset) { n.preset.kind === 'inst' ? app.addInstrumentPreset(n.preset.type, n.preset.params, n.preset.name) : app.addEffectPreset(n.preset.type, n.preset.params, n.preset.extra, n.preset.name); return; }
    if (n.chanPreset) { app.addChannelPreset(n.chanPreset.data); return; }
    if (n.installed) {
      const p = n.installed;
      if (p.kind === 'instrument') { const ch = app.plugins.addInstrument(p); app.openChannelEditor(ch.id); return; }
      const pr = app.store.project, tn = pr.mixer.selected, slot = pr.mixer.tracks[tn].fx.findIndex((s) => !s);
      if (slot < 0) { app.toast('All 10 effect slots on this track are used'); return; }
      app.plugins.addEffect(tn, slot, p);
      app.toast(`${p.name} added to ${tn === 0 ? 'Master' : `insert ${tn}`}, slot ${slot + 1}`);
      return;
    }
    if (n.mixPreset) { app.applyMixerPreset(n.mixPreset.data); return; }
    if (n.score) { app.pasteScore(n.score.data); return; }
    if (n.template) { app.newFromTemplate(n.template); return; }
    if (n.project) { app.openSavedProject(n.project); return; }
    if (n.channel) { app.store.select(n.channel); app.openChannelEditor(n.channel); return; }
    if (n.pattern) { app.cmd.selectPattern(app.store, n.pattern); app.openWindow('pianoroll'); return; }
    if (n.clip) { app.openWindow('playlist'); }
  }

  // ------------------------------------------------------------------ My sounds (app/sound-folders.js)
  soundRoots() {
    const S = this.app.sounds, out = [];
    if (!S.roots.length) out.push({ label: S.canPickFolder ? 'Add the folders with your samples, or drop a folder here' : 'This browser cannot open folders: pick files (for this session), or use Chrome, Edge or the desktop app', hintOnly: true });
    for (const r of S.roots) out.push(this.soundFolder(r, '', r.name));
    out.push({ id: 'ms:add', label: S.canPickFolder ? 'Add folder…' : 'Add files…', action: () => this.addSoundFolder() });
    return out;
  }

  soundFolder(r, rel, label) {
    const S = this.app.sounds, top = !rel;
    return { id: `ms:${r.id}:${rel}`, label, folder: true, load: () => this.soundKids(r, rel),
      right: top ? (r.session ? 'this session' : r.missing ? 'not found' : '') : '',
      tooltip: top ? (r.path || (r.session ? 'Only for this session' : '')) : '',
      onOpen: top && r.kind === 'handle' ? () => S.allow(r.id) : null,       // a click may ask for the permission again
      menu: () => [{ label: 'Refresh', fn: () => S.refresh(r.id) }, ...(S.desk ? [{ label: 'Show in folder', fn: () => S.show(r.id, rel) }] : []),
        ...(top ? [{ sep: true }, { label: 'Remove from My sounds', fn: () => S.remove(r.id) }] : [])] };
  }

  soundFile(rootId, rel, right) { return { id: `msf:${rootId}:${rel}`, label: soundName(rel), right, disk: { root: rootId, rel, name: soundName(rel) } }; }

  async soundKids(r, rel) {
    const S = this.app.sounds;
    let list;
    try { list = await S.list(r.id, rel); } catch (err) {
      if (err.code === 'permission') return [{ id: `ms:allow:${r.id}`, label: `Allow access to “${r.name}”…`, action: async () => { if (!(await S.allow(r.id))) this.app.toast('Access was not allowed'); } }];
      return [{ label: err.message, hintOnly: true }];
    }
    if (!list.length) return [{ label: 'No audio files here', hintOnly: true }];
    const key = `ms:${r.id}:${rel}`, { shown, hidden } = pageOf(list, this.pages.get(key) || PAGE);
    const out = shown.map((e) => (e.dir ? this.soundFolder(r, joinPath(rel, e.name), e.name) : this.soundFile(r.id, joinPath(rel, e.name), extOf(e.name))));
    if (hidden) out.push({ id: `${key}:more`, label: `Show more (${hidden} not shown)`, action: () => { this.pages.set(key, (this.pages.get(key) || PAGE) + PAGE); this.cache.delete(key); this.render(); } });
    return out;
  }

  // search: matches from the name index of all added folders, with the folder on the right
  soundHits(q) {
    const S = this.app.sounds;
    if (!S.roots.length) return [];
    const ix = S.searchIndex(), r = ix.search(q, HITS);
    const out = r.hits.map((f) => ({ ...this.soundFile(f.root, f.rel, dirName(f.rel) || (S.root(f.root) || {}).name || ''), matched: true }));
    if (!ix.done) out.push({ label: `Searching My sounds… ${ix.files.length} files so far`, hintOnly: true, always: true });
    else if (r.total > r.hits.length) out.push({ label: `${r.total} matches in My sounds, the first ${r.hits.length} are shown`, hintOnly: true, always: true });
    else if (ix.capped && r.total) out.push({ label: `Only the first ${ix.files.length} files of My sounds were searched`, hintOnly: true, always: true });
    return out;
  }

  async addSoundFolder() {
    let r;
    try { r = await this.app.sounds.addFolder(); } catch (err) { this.app.toast(`Could not add the folder: ${err.message}`); return; }
    if (!r) return;
    this.open.add('mysounds'); this.open.add(`ms:${r.id}:`); this.persist();
    this.render();
  }

  async dropFolders(dt) {
    const r = await this.app.sounds.addDropped(dt);
    this.open.add('mysounds');
    for (const f of r.folders) this.open.add(`ms:${f.id}:`);
    if (r.files) this.open.add('ms:picked:');
    this.persist();
    if (r.folders.length === 1) this.app.toast(`Added “${r.folders[0].name}” to My sounds`);
    else if (r.folders.length) this.app.toast(`Added ${r.folders.length} folders to My sounds`);
    else if (r.files) this.app.toast(`Added ${r.files} sounds to Picked files`);
    else this.app.toast('Drop folders with sounds here to add them to My sounds');
    this.render();
  }

  // imports the file into the project's sample bank (like any loaded file); null when it cannot be read
  async useDisk(n) {
    try { return await this.app.sounds.use(n.disk.root, n.disk.rel); } catch (err) { this.app.toast(`Could not load ${n.label}: ${err.message}`); return null; }
  }

  diskMenu(n) {
    const app = this.app, S = app.sounds, d = n.disk;
    return [
      { label: 'Preview', fn: () => this.preview(n, true) },
      { sep: true },
      { label: 'Open in the audio editor', fn: async () => {
        try { const b = await S.decode(d.root, d.rel); app.openAudioEditor({ buf: { rate: b.rate, channels: b.channels.map((c) => c.slice()) }, name: n.label }); } catch (err) { app.toast(`Could not load ${n.label}: ${err.message}`); }
      } },
      { label: 'New sampler channel', fn: () => this.activate(n) },
      { label: 'Add to the playlist as an audio clip', fn: () => this.diskToPlaylist(n) },
      ...(S.desk ? [{ sep: true }, { label: 'Show in folder', fn: () => S.show(d.root, d.rel) }] : []),
    ];
  }

  // an audio clip at the playlist cursor, on the first track that is free there
  async diskToPlaylist(n) {
    const app = this.app, s = await this.useDisk(n);
    if (!s) return;
    app.openWindow('playlist');
    const pl = app.playlist;
    if (!pl) return;
    const p = app.store.project, t = pl.cursorT || 0, len = defaultClipLength(p, 'audio', null, app.bank.get(s.id));
    const busy = new Set(currentArrangement(p).clips.filter((c) => c.s < t + len && c.s + c.l > t).map((c) => c.track));
    let track = 1;
    while (busy.has(track) && track < MAX_TRACK) track++;
    pl.addAudioAt(s, track, t);
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
