// Pure playlist helpers: clips never overlap on one track (placing one over others trims, splits or
// removes what is underneath, as in FL Studio), clips can be split, and sources get default lengths.
import { PPQ } from './constants.js';
import { patternLength } from './project.js';

export const MAX_TRACK = 500;
export const sortClips = (clips) => clips.sort((a, b) => a.s - b.s || a.track - b.track);

// Remove the parts of other clips that lie under any clip in `placed` (same track). Returns the new
// clip list (other clips may be trimmed in place, split in two, or dropped).
export function resolveOverlaps(clips, placed, newId) {
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
    const pieces = [];
    let pos = cs;
    for (const [a, b] of merged) { if (a > pos) pieces.push([pos, a]); pos = b; }
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
