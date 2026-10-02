// Project files: the plain .fllua JSON, and a self-contained .zip that also carries every user sample
// (32-bit float WAV, so nothing is lost) so a project can be moved to another machine or browser.
import { zipStore, unzip } from '../core/zip.js';
import { encodeWav, decodeWav } from '../host/export/wav.js';
import { normalize } from '../core/project.js';
import { isFactoryId } from '../core/factory.js';
import { projectPatchSampleIds } from '../core/patcher/spec.js';

// every sample id a project refers to (factory sounds are rebuilt from code and never stored)
export function userSampleIds(project) {
  const ids = new Set();
  for (const c of project.channels) {
    if (c.sample) { ids.add(c.sample.id); if (c.sample.use) ids.add(c.sample.use); }
    if (c.pads) for (const pd of c.pads) for (const l of pd.layers || []) ids.add(l.sample.id);
  }
  for (const t of project.mixer.tracks) for (const f of t.fx) if (f && f.extra && f.extra.irId) ids.add(f.extra.irId);
  for (const a of project.playlist.arrangements) for (const c of a.clips) if (c.use) ids.add(c.use);
  projectPatchSampleIds(project, ids);
  return [...ids].filter((id) => id && !isFactoryId(id) && !id.startsWith('stretch:'));
}

const safe = (id) => id.replace(/[^\w\-.]+/g, '_');

// bank: { get(id) -> { name, rate, channels } }
export function projectToZip(project, bank) {
  const files = [], samples = [];
  for (const id of userSampleIds(project)) {
    const e = bank.get(id);
    if (!e) continue;
    const file = `samples/${safe(id)}.wav`;
    const l = e.channels[0], r = e.channels[1] || e.channels[0];
    files.push({ name: file, data: encodeWav(l, r, e.rate, { bits: 32, channels: e.channels.length > 1 ? 2 : 1 }) });
    samples.push({ id, name: e.name, file, channels: e.channels.length, rate: e.rate });
  }
  files.unshift({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ format: 'fllua-zip', version: 1, samples })) },
    { name: 'project.fllua', data: new TextEncoder().encode(JSON.stringify(project)) });
  return zipStore(files);
}

// -> { project, restored: number }. bank.addPCM(name, rate, channels, id) receives the samples under their original ids.
export async function projectFromZip(bytes, bank) {
  const entries = await unzip(bytes);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const proj = byName.get('project.fllua');
  if (!proj) throw new Error('This ZIP has no project.fllua');
  const manifest = byName.has('manifest.json') ? JSON.parse(new TextDecoder().decode(byName.get('manifest.json'))) : { samples: [] };
  let restored = 0;
  for (const s of manifest.samples || []) {
    const data = byName.get(s.file);
    if (!data) continue;
    const w = decodeWav(data);
    bank.addPCM(s.name || s.id, w.rate, s.channels === 1 ? [w.channels[0]] : w.channels.slice(0, 2), s.id);
    restored++;
  }
  return { project: normalize(JSON.parse(new TextDecoder().decode(proj))), restored };
}
