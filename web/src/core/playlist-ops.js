// Pure playlist helpers: clips never overlap on one track (placing one over others trims, splits or
// removes what is underneath, as in FL Studio), clips can be split, and sources get default lengths.
// Audio clips are the exception: with auto crossfade on, the one underneath keeps a short overlap and the
// two crossfade there. Also: the takes of a loop recording, and cutting clips at the edges of a range.
import { PPQ } from './constants.js';
import { patternLength } from './project.js';

export const MAX_TRACK = 500;
export const XFADE_SEC = 0.05;            // longest automatic crossfade between overlapping audio clips
export const sortClips = (clips) => clips.sort((a, b) => a.s - b.s || a.track - b.track);

// How far (ticks) an audio clip may stay under another one placed over it: 0 when auto crossfade is off.
export const xfadeKeep = (project) => (project.settings && project.settings.xfade === 0 ? 0 : Math.ceil((XFADE_SEC * project.tempo * PPQ) / 60));

// Remove the parts of other clips that lie under any clip in `placed` (same track). Returns the new
// clip list (other clips may be trimmed in place, split in two, or dropped). keep (ticks): an audio clip cut
// by a placed audio clip keeps up to that much under the placed clip's edges (at most half of the cut when it
// stays on both sides), so the two overlap and crossfade (audioCrossfades).
export function resolveOverlaps(clips, placed, newId, keep = 0) {
  const placedSet = new Set(placed.map((c) => c.id));
  const out = [];
  for (const c of clips) {
    if (placedSet.has(c.id)) { out.push(c); continue; }
    const cs = c.s, ce = c.s + c.l, co = c.o, fi0 = c.fi, fo0 = c.fo;
    const cuts = [];
    for (const p of placed) if (p.track === c.track && p.s < ce && p.s + p.l > cs) cuts.push([Math.max(p.s, cs), Math.min(p.s + p.l, ce)]);
    if (!cuts.length) { out.push(c); continue; }
    cuts.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const iv of cuts) { const last = merged[merged.length - 1]; if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]); else merged.push([iv[0], iv[1]]); }
    const edge = (key, t) => keep > 0 && c.type === 'audio' && placed.some((p) => p.type === 'audio' && p.track === c.track && (key === 's' ? p.s : p.s + p.l) === t);
    const pieces = [];
    let pos = cs;
    for (const [a, b] of merged) {
      const left = a > pos && edge('s', a), right = b < ce && edge('e', b);
      const k = Math.min(keep, left && right ? Math.floor((b - a) / 2) : b - a);
      if (a > pos) pieces.push([pos, left ? a + k : a]);
      pos = right ? b - k : b;
    }
    if (pos < ce) pieces.push([pos, ce]);
    pieces.forEach(([a, b], i) => {
      const piece = i === 0 ? c : { ...c, id: newId() };
      piece.o = co + (a - cs); piece.s = a; piece.l = b - a;
      // a fade-in belongs to the clip's first piece only, a fade-out to its last
      if (i === 0 && fi0) piece.fi = fi0; else delete piece.fi;
      if (i === pieces.length - 1 && fo0) piece.fo = fo0; else delete piece.fo;
      out.push(piece);
    });
  }
  return sortClips(out);
}

// Cut one clip at tick t. Returns the new right-hand clip (the original keeps the left part), or null.
export function splitClip(clip, t, newId) {
  if (t <= clip.s || t >= clip.s + clip.l) return null;
  const right = { ...clip, id: newId(), s: t, l: clip.s + clip.l - t, o: clip.o + (t - clip.s) };
  delete right.fi; delete clip.fo;
  clip.l = t - clip.s;
  return right;
}

// Move the start of a clip to `ns` keeping its content in place (trim from the left / extend to the left).
// Audio clips cannot extend before their source start (o stays >= 0); patterns loop, so they can.
export function trimLeft(clip, ns, loopLen = 0) {
  const end = clip.s + clip.l;
  ns = Math.max(0, Math.min(end - 1, ns));
  let d = ns - clip.s;
  if (!loopLen && clip.o + d < 0) { d = -clip.o; ns = clip.s + d; }
  clip.s = ns; clip.l = end - ns;
  let o = clip.o + d;
  if (o < 0) o = ((o % loopLen) + loopLen) % loopLen;
  clip.o = o;
  return clip;
}

export function spanOf(clips) {
  if (!clips.length) return null;
  let s = Infinity, e = -Infinity, t0 = Infinity, t1 = -Infinity;
  for (const c of clips) { s = Math.min(s, c.s); e = Math.max(e, c.s + c.l); t0 = Math.min(t0, c.track); t1 = Math.max(t1, c.track); }
  return { s, e, t0, t1 };
}

// Default length (ticks) of a freshly placed clip.
export function defaultClipLength(project, type, ref, sample = null) {
  if (type === 'pattern') { const pat = project.patterns[ref]; return pat ? patternLength(project, pat) : PPQ * 4; }
  if (type === 'audio' && sample) return Math.max(1, Math.round((sample.length / sample.rate) * (project.tempo / 60) * PPQ));
  if (type === 'automation') {
    const ch = project.channels.find((c) => c.id === ref);
    if (ch && ch.len) return ch.len;
    const end = ch && ch.points && ch.points.length ? Math.max(...ch.points.map((pt) => pt.t)) : 0;
    return Math.max(PPQ * 4, Math.ceil(end / (PPQ * 4)) * PPQ * 4);
  }
  return PPQ * 4;
}

// The marker that applies at a tick: used for display of time signature / pattern length changes.
export function markersOfType(markers, type) { return markers.filter((m) => m.type === type).sort((a, b) => a.t - b.t); }

// ---- auto crossfade
// Where an audio clip B starts inside an earlier audio clip A on the same track, A fades out and B fades in
// over their overlap, starting at B's start (equal power; the engine caps the length at XFADE_SEC). After the
// crossfade A is silent, as if B covered it. audible(clip) leaves out clips that do not sound (muted…).
// Returns Map clipId -> { xi } (fade-in length) and/or { xoAt, xo } (fade-out start from the clip start, length), in ticks.
export function audioCrossfades(clips, audible = () => true) {
  const byTrack = new Map();
  for (const c of clips) {
    if (c.type !== 'audio' || !audible(c)) continue;
    let list = byTrack.get(c.track);
    if (!list) byTrack.set(c.track, (list = []));
    list.push(c);
  }
  const out = new Map();
  const at = (c) => { let x = out.get(c.id); if (!x) out.set(c.id, (x = {})); return x; };
  for (const list of byTrack.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.s - b.s);
    for (let i = 0; i < list.length; i++) {
      const A = list[i], end = A.s + A.l;
      for (let j = i + 1; j < list.length && list[j].s < end; j++) {
        const B = list[j];
        if (B.s <= A.s) continue;                       // clips that start together both play
        const x = Math.min(end - B.s, B.l);
        Object.assign(at(A), { xoAt: B.s - A.s, xo: x });
        const b = at(B); b.xi = Math.max(b.xi || 0, x);
        break;
      }
    }
  }
  return out;
}

// ---- ranges
// The first track from `from` down (then from the top) with no clip in [s, s + l).
export function freeTrack(clips, s, l, from = 1) {
  const busy = (t) => clips.some((c) => c.track === t && c.s < s + l && c.s + c.l > s);
  for (let t = Math.max(1, from); t <= MAX_TRACK; t++) if (!busy(t)) return t;
  for (let t = 1; t < from; t++) if (!busy(t)) return t;
  return MAX_TRACK;
}

// Cut the clips `ids` where they cross s and e. Returns the new clip list and the pieces that lie inside [s, e).
export function splitAtRange(clips, ids, s, e, newId) {
  const set = new Set(ids), out = [], inner = [];
  for (const c of clips) {
    if (!set.has(c.id)) { out.push(c); continue; }
    const right = splitClip(c, e, newId);              // c keeps [c.s, e)
    const mid = splitClip(c, s, newId);                // c keeps [c.s, s), mid = [s, e)
    out.push(c);
    if (right) out.push(right);
    if (mid) { out.push(mid); inner.push(mid); } else if (c.s >= s && c.s < e) inner.push(c);
  }
  return { clips: sortClips(out), inner };
}

// ---- takes of a loop recording
// One recording made while the loop [ls, le) played over and over holds one take per pass. The recording
// started `lead` ticks (count-in) before the song position `start`, is `total` ticks long and its first `trim`
// ticks are input latency. Returns null when the loop never came round, else { pad, passes } where passes[k]
// is the recording position (ticks) that sounds at ls in pass k, and pad = silence (ticks) to put in front of
// the recording so a first pass that began inside the loop needs no negative offset. A last pass shorter
// than `minLast` is where the recording was stopped, not a take.
export function loopPasses({ start, lead = 0, trim = 0, total, ls, le, minLast = PPQ }) {
  const L = le - ls;
  if (!(L > 0)) return null;
  const st = start >= le ? ls + ((start - ls) % L) : start;     // the transport jumps into the loop like this
  const first = le - st, played = total - trim - lead;
  if (played <= first) return null;
  const passes = [trim + lead + ls - st];
  for (let v = first; v < played; v += L) {
    if (played - v < Math.min(minLast, L)) break;
    passes.push(trim + lead + v);
  }
  if (passes.length < 2) return null;
  const pad = Math.max(0, -Math.min(...passes));
  return { pad, passes: passes.map((o) => o + pad) };
}

// Make take `id` the one that plays. The clip keeps its place and length; its window into the recording moves by
// the distance between the two passes (recording seconds -> ticks at `tempo`, through the clip's time-stretch).
export function switchTake(clip, id, tempo) {
  const takes = clip.takes || [];
  const cur = takes.find((t) => t.id === clip.take) || takes[takes.length - 1], next = takes.find((t) => t.id === id);
  if (!cur || !next || next === cur) return false;
  let o = clip.o + Math.round(((next.t - cur.t) * (clip.stretch || 1) * tempo * PPQ) / 60);
  if (o < 0) { const d = Math.min(-o, clip.l - 1); clip.s += d; clip.l -= d; o = Math.max(0, o + d); }   // nothing recorded before the start
  clip.o = o; clip.take = id;
  return true;
}
