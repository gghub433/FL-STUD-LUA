// Wires the Browser panel and the user library into the app: save/load of channel presets, mixer presets,
// scores and templates, and the drop targets the Browser drags onto.
import { Library, channelSnapshot, mixerSnapshot, scoreSnapshot } from './app/library.js';
import { Browser } from './ui/browser.js';
import { confirmBox, promptText } from './ui/dialog.js';
import { instrumentMeta } from './core/instruments/index.js';
import { normalize } from './core/project.js';
import { downloadBlob } from './host/export/wav.js';

export function installBrowser(app) {
  const store = app.store, cmd = app.cmd;
  app.library = new Library(store.bus);
  const pane = document.getElementById('browser-pane');
  app.browser = new Browser(app, pane);

  // ---- splitter
  const sp = document.getElementById('splitter');
  const saved = +localStorage.getItem('stepwise.browser.width') || 0;
  if (saved) pane.style.width = `${Math.max(160, Math.min(520, saved))}px`;
  sp.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = pane.getBoundingClientRect().width;
    sp.setPointerCapture(e.pointerId);
    const mv = (ev) => { pane.style.width = `${Math.max(160, Math.min(520, w0 + ev.clientX - x0))}px`; };
    const up = () => { sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); try { localStorage.setItem('stepwise.browser.width', String(Math.round(pane.getBoundingClientRect().width))); } catch (_) { /* private mode */ } app.wm.refit(); };
    sp.addEventListener('pointermove', mv); sp.addEventListener('pointerup', up);
  });

  // ---- adding things
  app.addSamplerFor = (s) => { const ch = cmd.addChannel(store, 'sampler', { name: s.name, sample: { id: s.id, name: s.name } }); app.preview(ch.id); return ch; };
  app.addInstrumentPreset = (type, params, name) => {
    const ch = cmd.addChannel(store, type, { name: name || instrumentMeta(type).name, params });
    app.openChannelEditor(ch.id);
    return ch;
  };
  app.addEffectPreset = (type, params, extra, name) => {
    const tn = store.project.mixer.selected;
    const slot = cmd.setFxPreset(store, tn, -1, type, params, extra);
    app.toast(slot < 0 ? 'All 10 effect slots on this track are used' : `${name || type} added to ${tn === 0 ? 'Master' : 'insert ' + tn}, slot ${slot + 1}`);
    return slot;
  };
  app.addChannelPreset = (data) => cmd.addChannelSnapshot(store, data);
  app.applyMixerPreset = (data) => { const tn = store.project.mixer.selected; cmd.applyMixerSnapshot(store, tn, data); app.toast(`Mixer preset applied to ${tn === 0 ? 'Master' : 'insert ' + tn}`); };
  app.pasteScore = (notes, chId = store.selected, at = app.pianoRoll ? app.pianoRoll.cursorT : 0) => {
    if (chId == null || !store.channel(chId)) { app.toast('Select a channel first'); return []; }
    const made = cmd.pasteNotes(store, chId, notes, at, 0, 'Paste score');
    app.toast(`Pasted ${made.length} notes into ${store.channel(chId).name}`);
    return made;
  };

  // ---- projects
  const askDiscard = async (what) => !(store.dirty && store.project.channels.length) || confirmBox(what, 'Discard unsaved changes in the current project?', 'Discard');
  app.newFromTemplate = async (tpl, force = false) => {
    if (!force && !(await askDiscard('New project from template'))) return;
    const p = tpl.build ? tpl.build() : normalize(JSON.parse(JSON.stringify(tpl.json)));
    await store.replaceProject(p);
    app.toast(`New project: ${tpl.name}`);
  };
  app.openSavedProject = async (entry, force = false) => {
    if (!force && !(await askDiscard('Open project'))) return;
    try { await store.replaceProject(normalize(JSON.parse(entry.json)), { fileName: entry.name }); app.toast(`Opened ${entry.name}`); }
    catch (err) { app.toast(`Could not open ${entry.name}: ${err.message}`); }
  };
  app.downloadJson = (json, name) => downloadBlob(new TextEncoder().encode(json), `${String(name || 'project').replace(/[^\w\- ]+/g, '_')}.fllua`, 'application/json');

  // ---- saving
  app.saveChannelPreset = async (chId) => {
    const ch = store.channel(chId); if (!ch) return;
    const name = await promptText('Save channel preset', 'Preset name', ch.name);
    if (!name) return;
    await app.library.save('channel', name, channelSnapshot(ch));
    app.toast(`Saved channel preset "${name}"`);
  };
  app.saveMixerPreset = async (track) => {
    const t = store.project.mixer.tracks[track];
    const name = await promptText('Save mixer preset', 'Preset name', t.name || (track === 0 ? 'Master chain' : `Insert ${track} chain`));
    if (!name) return;
    await app.library.save('mixer', name, mixerSnapshot(t));
    app.toast(`Saved mixer preset "${name}"`);
  };
  app.saveScore = async (notes) => {
    if (!notes.length) { app.toast('Select some notes first'); return; }
    const name = await promptText('Save score', 'Score name', 'Score');
    if (!name) return;
    await app.library.save('score', name, scoreSnapshot(notes));
    app.toast(`Saved score "${name}" (${notes.length} notes)`);
  };
  app.saveAsTemplate = async () => {
    const name = await promptText('Save as template', 'Template name', store.project.meta.title || 'Template');
    if (!name) return;
    await app.library.save('template', name, JSON.parse(store.serialize()));
    app.toast(`Saved template "${name}"`);
  };
  const prevFile = app.fileMenuExtra;
  app.fileMenuExtra = () => [...(prevFile ? prevFile() : []), { label: 'Save project as template…', fn: () => app.saveAsTemplate() }];

  // ---- drops from the Browser on empty workspace areas; windows with their own handlers stop propagation first
  const ws = document.getElementById('workspace');
  const TYPES = ['application/x-stepwise-sample', 'application/x-stepwise-inst', 'application/x-stepwise-chan', 'application/x-stepwise-fx', 'application/x-stepwise-score', 'application/x-stepwise-mixer'];
  ws.addEventListener('dragover', (e) => { if (e.dataTransfer && TYPES.some((t) => e.dataTransfer.types.includes(t))) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  ws.addEventListener('drop', async (e) => {
    if (e.defaultPrevented || !e.dataTransfer) return;
    const get = (t) => { const v = e.dataTransfer.getData(t); return v ? JSON.parse(v) : null; };
    const sample = get(TYPES[0]), inst = get(TYPES[1]), chan = get(TYPES[2]), fx = get(TYPES[3]), score = get(TYPES[4]), mix = get(TYPES[5]);
    if (!(sample || inst || chan || fx || score || mix)) return;
    e.preventDefault();
    if (sample) { await app.bank.ensure(sample.id); app.addSamplerFor(sample); }
    else if (inst) app.addInstrumentPreset(inst.type, inst.params, instrumentMeta(inst.type).name);
    else if (chan) app.addChannelPreset(chan);
    else if (fx) app.addEffectPreset(fx.type, fx.params, fx.extra);
    else if (score) app.pasteScore(score);
    else if (mix) app.applyMixerPreset(mix);
  });

}
