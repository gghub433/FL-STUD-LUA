// Consolidate / render to audio clip. A range of the arrangement is rendered offline with the same engine as
// playback and replaced by one audio clip. Pure parts: which clips sound (consolidateSources), the project the
// renderer plays (prepareRender), how long the clip is (renderedLength) and the edit that puts it in
// (applyConsolidate). app/consolidate.js runs the render in between.
import { PPQ } from './constants.js';
import { clone, currentArrangement, createChannel, createClip, nextId } from './project.js';
import { splitAtRange, freeTrack, sortClips, spanOf } from './playlist-ops.js';
import { parseAddr } from './addr.js';

export const isSource = (c) => c.type === 'pattern' || c.type === 'audio';

// a parameter of the master track (its fader and effects; the master pitch belongs to the instruments)
const isMasterAddr = (addr) => {
  const a = parseAddr(addr);
  return !!a && ((a.kind === 'master' && a.key === 'vol') || ((a.kind === 'mx' || a.kind === 'fxs' || a.kind === 'fxp') && a.track === 0));
};

function trackAudible(arr) {
  const soloed = Object.keys(arr.tracks).filter((k) => arr.tracks[k].solo).map(Number);
  return (t) => !(arr.tracks[t] && arr.tracks[t].mute) && (!soloed.length || soloed.includes(t));
}

// opts: { s, e, ids (selected clips), track (a playlist track), mode: 'clips' (only those sound) | 'mix' (everything
// that plays in the range) }. Returns the pattern and audio clips whose sound is rendered: the "originals".
export function consolidateSources(arr, { s, e, ids = null, track = null, mode = 'clips' }) {
  const inRange = (c) => isSource(c) && c.s < e && c.s + c.l > s;
  if (mode === 'mix') { const audible = trackAudible(arr); return arr.clips.filter((c) => inRange(c) && !c.mute && audible(c.track)); }
  if (track != null) return arr.clips.filter((c) => inRange(c) && c.track === track);
  const set = new Set(ids || []);
  return arr.clips.filter((c) => inRange(c) && set.has(c.id));
}

// The project the renderer plays: the sources cut to [s, e) (nothing past e is rendered but tails) and all the
// automation; in 'clips' mode the sources sound even if they or their tracks are muted. The clip goes into the
// master, so the render is what reaches the master: the master's effects and fader stay neutral here and act on
// the clip when it plays.
export function prepareRender(project, sourceIds, { s, e, mode = 'clips' }) {
  const p = clone(project), arr = currentArrangement(p), set = new Set(sourceIds);
  const masterAutos = new Set(p.channels.filter((c) => c.type === 'automation' && c.target && isMasterAddr(c.target)).map((c) => c.id));
  let tmp = 2e9;
  const keep = arr.clips.filter((c) => set.has(c.id) || (c.type === 'automation' && !masterAutos.has(c.ref)));
  const { clips, inner } = splitAtRange(keep, sourceIds, s, e, () => ++tmp);
  const innerIds = new Set(inner.map((c) => c.id));
  arr.clips = clips.filter((c) => c.type === 'automation' || innerIds.has(c.id));
  if (mode === 'clips') {
    for (const c of inner) c.mute = 0;
    for (const k of Object.keys(arr.tracks)) {
      delete arr.tracks[k].solo;
      if (inner.some((c) => c.track === +k)) delete arr.tracks[k].mute;
    }
  }
  arr.loop = null; arr.punch = null;
  const m = p.mixer.tracks[0];
  Object.assign(m, { vol: 0.8, pan: 0, sep: 0, delay: 0, eqLowG: 0, eqMidG: 0, eqHighG: 0, mute: 0, swapLR: 0, invertPhase: 0 });
  m.fx = m.fx.map(() => null);
  for (const c of p.channels) if (c.type === 'controller' && c.links) c.links = c.links.filter((l) => !isMasterAddr(l.addr));
  p.controllers = p.controllers.filter((l) => !isMasterAddr(l.addr));
  return p;
}

// How much of a render to keep: the range itself and, with a tail, what still rings after it (silence at the end
// is cut). Returns { frames, ticks } for a render that starts at tick s.
export function renderedLength(left, right, sampleRate, { s, e, tempo, tail = 0 }) {
  const n = left.length, perTick = (60 / (tempo * PPQ)) * sampleRate;
  const body = Math.min(n, Math.round((e - s) * perTick));
  let frames = body;
  if (tail > 0) {
    let last = body - 1;
    for (let i = n - 1; i >= body; i--) if (Math.abs(left[i]) > 1e-4 || Math.abs(right[i]) > 1e-4) { last = i; break; }
    frames = Math.min(n, last + 1 + Math.round(sampleRate * 0.01));
  }
  return { frames, ticks: frames > body ? Math.max(e - s, Math.round(frames / perTick)) : e - s };
}

// The edit (inside store.edit): an audio channel for the rendered sample (into the master), the originals cut at
// the range edges and muted (or removed), and the clip at s: on a free track, or on `track` for a track render
// (muted originals then move together to a free track). plan: { s, e, sources, track, remove, sample, l, name }.
export function applyConsolidate(p, arr, { s, e, sources, track = null, remove = false, sample, l, name }) {
  const channel = createChannel(p, 'audio', { name: name || sample.name, sample: { id: sample.id, name: sample.name }, mixer: 0 });
  p.channels.push(channel);
  const { clips, inner } = splitAtRange(arr.clips, sources, s, e, () => nextId(p));
  const innerIds = new Set(inner.map((c) => c.id));
  const list = remove ? clips.filter((c) => !innerIds.has(c.id)) : clips;
  if (!remove) for (const c of inner) c.mute = 1;
  let dest;
  if (track != null) {
    dest = track;
    if (!remove && inner.length) {
      const sp = spanOf(inner), rest = list.filter((c) => !innerIds.has(c.id));
      const to = freeTrack(rest.concat([{ track, s, l }]), sp.s, sp.e - sp.s, track + 1);
      for (const c of inner) c.track = to;
    }
  } else dest = freeTrack(list, s, l, inner.length ? spanOf(inner).t0 : 1);
  const clip = createClip(p, 'audio', dest, s, l, channel.id);
  list.push(clip);
  arr.clips = sortClips(list);
  return { clip, channel };
}
