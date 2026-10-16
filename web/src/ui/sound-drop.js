// Sounds dropped on the Channel rack, the Playlist, a Sampler or the audio editor. Three kinds arrive the same way:
// a sound from the Browser that is already in the sample bank, a file from My sounds (imported when it is dropped)
// and audio files dragged from the system file manager.
import { isAudioDrop } from '../core/sound-files.js';
import { decodeAudioBytes } from '../host/sample-bank.js';

export const SAMPLE_TYPE = 'application/x-stepwise-sample';   // { id, name } of a sample in the bank
export const SOUND_TYPE = 'application/x-fllua-sound';        // { root, rel, name } of a file in My sounds

const types = (dt) => (dt && dt.types ? [...dt.types] : []);
export const hasSounds = (dt) => { const t = types(dt); return t.includes(SAMPLE_TYPE) || t.includes(SOUND_TYPE) || t.includes('Files'); };
// what the Browser already handles itself (its own sounds) is left to the existing handlers
export const hasNewSounds = (dt) => { const t = types(dt); return !t.includes(SAMPLE_TYPE) && (t.includes(SOUND_TYPE) || t.includes('Files')); };

// Everything is read from the DataTransfer at once: after the event (the first await) the browser empties it.
export function takeSounds(dt, max = Infinity) {
  const get = (t) => { try { const v = dt.getData(t); return v ? JSON.parse(v) : null; } catch (_) { return null; } };
  const all = [...(dt.files || [])], files = all.filter(isAudioDrop);
  return { sample: get(SAMPLE_TYPE), disk: get(SOUND_TYPE), files: files.slice(0, Math.max(0, max)), other: all.filter((f) => !isAudioDrop(f)), max };
}

const warnOthers = (app, taken) => { if (taken.other.length && !taken.sample && !taken.disk && !taken.files.length) app.toast(`Not an audio file: ${taken.other[0].name}`); };

// -> [{ id, name }] in the sample bank: imported like any loaded file, so the project keeps them
export async function importSounds(app, taken) {
  const out = [];
  if (taken.sample && (await app.bank.ensure(taken.sample.id))) out.push({ id: taken.sample.id, name: taken.sample.name });
  if (taken.disk && app.sounds) {
    try { out.push(await app.sounds.use(taken.disk.root, taken.disk.rel)); } catch (err) { app.toast(`Could not load ${taken.disk.name}: ${err.message}`); }
  }
  for (const f of taken.files) {
    if (out.length >= taken.max) break;
    try { const e = await app.bank.decode(f.name, await f.arrayBuffer()); out.push({ id: e.id, name: e.name }); } catch (_) { app.toast(`Could not decode ${f.name}`); }
  }
  warnOthers(app, taken);
  return out.slice(0, taken.max);
}
export const droppedSounds = (app, dt, max) => importSounds(app, takeSounds(dt, max));

// -> [{ name, rate, channels }] decoded but not added to the project (the audio editor works on its own copy)
export async function bufferSounds(app, taken) {
  const out = [];
  const copy = (e, name) => ({ name, rate: e.rate, channels: e.channels.map((c) => c.slice()) });
  if (taken.sample) { const e = await app.bank.ensure(taken.sample.id); if (e) out.push(copy(e, taken.sample.name)); }
  if (taken.disk && app.sounds) {
    try { out.push(copy(await app.sounds.decode(taken.disk.root, taken.disk.rel), taken.disk.name)); } catch (err) { app.toast(`Could not load ${taken.disk.name}: ${err.message}`); }
  }
  for (const f of taken.files) {
    if (out.length >= taken.max) break;
    try { out.push({ name: f.name.replace(/\.[^.]+$/, ''), ...(await decodeAudioBytes(app.host.ctx, await f.arrayBuffer())) }); } catch (_) { app.toast(`Could not decode ${f.name}`); }
  }
  warnOthers(app, taken);
  return out.slice(0, taken.max);
}

const usable = (t) => !!(t.sample || t.disk || t.files.length);

// el accepts sounds: onSounds(list) gets them imported, or decoded only with { buffers: true }. A drop without any
// sound in it (a project file, say) is left to the page.
export function wireSoundDrop(el, app, onSounds, { max = Infinity, buffers = false, accept = hasSounds } = {}) {
  el.addEventListener('dragover', (e) => { if (accept(e.dataTransfer)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; } });
  el.addEventListener('drop', async (e) => {
    if (e.defaultPrevented || !accept(e.dataTransfer)) return;
    const taken = takeSounds(e.dataTransfer, max);
    if (!usable(taken)) return;
    e.preventDefault(); e.stopPropagation();
    const list = buffers ? await bufferSounds(app, taken) : await importSounds(app, taken);
    if (list.length) onSounds(list, e);
  });
}

// ---- Channel rack
// A row: one sound replaces the sample of a Sampler or audio channel (Browser sounds are handled by the rack itself).
// Several files, or a row of another kind, fall through to the rack: a new Sampler for each.
export function wireRackRowDrop(app, el, channel) {
  const fits = (dt) => { const c = channel(); return !!c && (c.type === 'sampler' || c.type === 'audio') && hasNewSounds(dt) && !((dt.items && [...dt.items].filter((i) => i.kind === 'file').length > 1)); };
  el.addEventListener('dragover', (e) => { if (fits(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; el.classList.add('drop'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', async (e) => {
    el.classList.remove('drop');
    if (e.defaultPrevented || !fits(e.dataTransfer)) return;
    const taken = takeSounds(e.dataTransfer, 1);
    if (!usable(taken)) return;
    e.preventDefault(); e.stopPropagation();
    const [s] = await importSounds(app, taken);
    const c = channel();
    if (!s || !c) return;
    app.cmd.setChannelSample(app.store, c.id, s);
    app.preview(c.id);
  });
}

// The rest of the rack: a new Sampler for each sound
export function wireRackDrop(app, el) {
  wireSoundDrop(el, app, (list) => {
    let ch = null;
    for (const s of list) ch = app.cmd.addChannel(app.store, 'sampler', { name: s.name, sample: { id: s.id, name: s.name } });
    if (ch && list.length === 1) app.preview(ch.id);
    if (list.length > 1) app.toast(`Added ${list.length} Sampler channels`);
  }, { accept: hasNewSounds });
}
