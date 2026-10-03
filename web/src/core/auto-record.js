// Automation recording: knob moves captured while recording in Song mode become automation.
// samples = [{ t: song tick, v: normalised 0..1 }] in time order; startValue = the knob's value before the first move.
//   - a clip of an automation channel for the same parameter that covers the whole take: the take replaces the
//     curve inside that span (the rest of the curve stays)
//   - otherwise a new automation channel + clip, from the bar where the move started to the bar after it ended
// Takes are thinned with Ramer–Douglas–Peucker, so a slow sweep stays a handful of points.
import { createChannel, createClip, currentArrangement, barTicks } from './project.js';
import { evalPoints } from './automation.js';
import { paramLabel } from './addr.js';
import { MAX_TRACK, sortClips } from './playlist-ops.js';

const pt = (t, v) => ({ t: Math.max(0, Math.round(t)), v: Math.max(0, Math.min(1, v)), type: 'single', tension: 0, count: 4 });

export function thinPoints(samples, eps = 0.006) {
  if (samples.length <= 2) return samples.slice();
  const keep = new Uint8Array(samples.length);
  keep[0] = 1; keep[samples.length - 1] = 1;
  const stack = [[0, samples.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = samples[a], B = samples[b], dt = B.t - A.t || 1;
    let worst = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const line = A.v + (B.v - A.v) * ((samples[i].t - A.t) / dt);
      const d = Math.abs(samples[i].v - line);
      if (d > worst) { worst = d; idx = i; }
    }
    if (worst > eps) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return samples.filter((_, i) => keep[i]);
}

// one value per tick at most (the latest wins), in time order
function clean(samples) {
  const out = [];
  for (const s of samples) {
    const t = Math.round(s.t);
    if (out.length && out[out.length - 1].t === t) out[out.length - 1].v = s.v;
    else if (!out.length || t > out[out.length - 1].t) out.push({ t, v: s.v });
  }
  return out;
}

function freeTrack(arr, s, l) {
  for (let t = 1; t <= MAX_TRACK; t++) if (!arr.clips.some((c) => c.track === t && c.s < s + l && c.s + c.l > s)) return t;
  return MAX_TRACK;
}

export function applyRecordedAutomation(p, addr, rawSamples, { startValue = null } = {}) {
  const samples = thinPoints(clean(rawSamples));
  if (!samples.length) return null;
  const first = samples[0], last = samples[samples.length - 1];
  const hold = startValue ?? first.v;
  const arr = currentArrangement(p);

  for (const ch of p.channels) {
    if (ch.type !== 'automation' || ch.target !== addr) continue;
    const clip = arr.clips.find((c) => c.type === 'automation' && c.ref === ch.id && c.s <= first.t && c.s + c.l >= last.t);
    if (!clip) continue;
    const local = (t) => t - clip.s + (clip.o || 0);
    const a = local(first.t), b = local(last.t);
    const after = evalPoints(ch.points, b + 2);
    const kept = ch.points.filter((q) => q.t < a - 1 || q.t > b + 2);
    const before = evalPoints(ch.points, a - 1);
    const pts = [...kept, pt(a - 1, before ?? hold), ...samples.map((s) => pt(local(s.t), s.v))];
    if (after != null && b + 2 <= ch.len) pts.push(pt(b + 2, after));
    ch.points = pts.sort((x, y) => x.t - y.t).slice(0, 4096);
    return { channel: ch, clip, merged: true };
  }

  const bar = barTicks(p.timeSig);
  const t0 = Math.floor(first.t / bar) * bar;
  const len = Math.max(bar, Math.ceil((last.t + 1 - t0) / bar) * bar);
  const pts = [pt(0, hold)];
  if (first.t - t0 > 1) pts.push(pt(first.t - t0 - 1, hold));
  for (const s of samples) pts.push(pt(s.t - t0, s.v));
  pts.push(pt(len, last.v));
  const dedup = pts.filter((q, i) => i === 0 || q.t > pts[i - 1].t || q.v !== pts[i - 1].v);
  const ch = createChannel(p, 'automation', { name: paramLabel(p, addr), target: addr, len, points: dedup });
  p.channels.push(ch);
  const clip = createClip(p, 'automation', freeTrack(arr, t0, len), t0, len, ch.id);
  arr.clips.push(clip);
  arr.clips = sortClips(arr.clips);
  return { channel: ch, clip, merged: false };
}
