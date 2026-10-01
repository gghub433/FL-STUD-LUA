// Automation clip interpolation. Shared by the engine (sample-accurate playback) and the
// automation editor (drawing the curve), so what you see is what you hear.
//
// A clip is { points: [{ t, v, type, tension, count }], len }. Values are normalized 0..1;
// the engine maps them through the target's schema (fromNorm). `type` describes how the
// segment STARTING at that point behaves:
//   single        power curve, tension -1..1 (0 = straight line)
//   hold          keep the value until the next point
//   stairs        `count` hard steps from this value to the next
//   smooth-stairs `count` eased steps
//   pulse         square wave between the two values, `count` cycles
//   wave          sine between the two values, `count` cycles
//   half-sine     ease in/out (sine)
//   smooth        smoothstep ease
export const CURVE_TYPES = [
  { id: 'single', name: 'Single curve' },
  { id: 'hold', name: 'Hold' },
  { id: 'stairs', name: 'Stairs' },
  { id: 'smooth-stairs', name: 'Smooth stairs' },
  { id: 'pulse', name: 'Pulse' },
  { id: 'wave', name: 'Wave' },
  { id: 'half-sine', name: 'Half sine' },
  { id: 'smooth', name: 'Smooth' },
];

const smoothstep = (u) => u * u * (3 - 2 * u);

// Shape a position u (0..1) inside a segment from value a to b.
export function segmentValue(type, a, b, u, tension = 0, count = 4) {
  switch (type) {
    case 'hold': return a;
    case 'stairs': {
      const n = Math.max(1, count);
      if (n === 1) return a;
      const k = Math.min(n - 1, Math.floor(u * n));
      return a + ((b - a) * k) / (n - 1);
    }
    case 'smooth-stairs': {
      const n = Math.max(1, count);
      const s = u * n, k = Math.min(n - 1, Math.floor(s));
      return a + ((b - a) * (k + smoothstep(s - k))) / n;
    }
    case 'pulse': return ((u * Math.max(1, count)) % 1) < 0.5 ? a : b;
    case 'wave': return a + (b - a) * (0.5 - 0.5 * Math.cos(2 * Math.PI * Math.max(1, count) * u));
    case 'half-sine': return a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * u));
    case 'smooth': return a + (b - a) * smoothstep(u);
    default: // single curve
      return a + (b - a) * Math.pow(u, Math.pow(2, tension * 3));
  }
}

// Value at time t (ticks from clip start). `points` must be sorted by t.
export function evalPoints(points, t) {
  const n = points.length;
  if (n === 0) return null;
  if (t <= points[0].t) return points[0].v;
  const last = points[n - 1];
  if (t >= last.t) return last.v;
  // binary search for the segment containing t
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid; else hi = mid;
  }
  const p0 = points[lo], p1 = points[hi];
  const span = p1.t - p0.t;
  const u = span > 0 ? (t - p0.t) / span : 1;
  return segmentValue(p0.type || 'single', p0.v, p1.v, u, p0.tension || 0, p0.count || 4);
}

export function sortPoints(points) { return points.sort((a, b) => a.t - b.t); }

// Sample a curve for drawing: returns Float32Array of `n` values over [0, len].
export function renderCurve(points, len, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = evalPoints(points, (i / (n - 1)) * len) ?? 0;
  return out;
}

// ---- LFO tool: write a periodic shape into an automation clip ---------------------------------
export const LFO_TOOL_SHAPES = ['Sine', 'Triangle', 'Saw up', 'Saw down', 'Square', 'Random', 'Smooth random'];

const lfoValue = (shape, u) => {              // u = position in the cycle 0..1 -> -1..1
  switch (shape) {
    case 1: return u < 0.5 ? 4 * u - 1 : 3 - 4 * u;
    case 2: return 2 * u - 1;
    case 3: return 1 - 2 * u;
    case 4: return u < 0.5 ? 1 : -1;
    default: return Math.sin(2 * Math.PI * u);
  }
};

// opts: { shape, cycles (over `len` ticks), amp 0..1, center 0..1, phase 0..1 (fraction of a cycle),
//         pointsPerCycle (sine), seed, from, to (ticks; default the whole clip) } -> sorted points in [from, to].
// Triangle, saw and square are written with exactly the points they need; sine uses pointsPerCycle line segments.
export function generateLfoPoints(len, opts = {}) {
  const { shape = 0, cycles = 4, amp = 1, center = 0.5, phase = 0, pointsPerCycle = 24, seed = 1, from = 0, to = len } = opts;
  const cycleLen = len / Math.max(0.01, cycles);
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const pts = [];
  const put = (t, v, type = 'single') => pts.push({ t: Math.max(from, Math.min(to, Math.round(t))), v: clamp01(center + (amp * v) / 2), type, tension: 0, count: 4 });
  const uAt = (t) => (((t / cycleLen + phase) % 1) + 1) % 1;
  if (shape === 5 || shape === 6) {            // random: a new value every quarter cycle, held (5) or eased (6)
    let s = (seed >>> 0) || 1;
    const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5) >>> 0; return s / 4294967296; };
    const step = cycleLen / 4;
    for (let t = from; t < to; t += step) put(t, rnd() * 2 - 1, shape === 5 ? 'hold' : 'smooth');
    put(to, rnd() * 2 - 1, 'single');
    return dedupe(pts);
  }
  if (shape === 0) {                           // sine: dense line segments
    const step = cycleLen / Math.max(6, pointsPerCycle);
    for (let t = from; t < to; t += step) put(t, lfoValue(0, uAt(t)));
    put(to, lfoValue(0, uAt(to)));
    return dedupe(pts);
  }
  // triangle / saw / square: breakpoints at cycle fractions (value, type of the segment that STARTS there)
  const bps = shape === 1 ? [[0, -1], [0.5, 1]] : shape === 4 ? [[0, 1, 'hold'], [0.5, -1, 'hold']] : shape === 2 ? [[0, -1], [1, 1]] : [[0, 1], [1, -1]];
  put(from, lfoValue(shape, uAt(from)), shape === 4 ? 'hold' : 'single');
  const k0 = Math.floor(from / cycleLen - phase) - 1, k1 = Math.ceil(to / cycleLen - phase) + 1;
  for (let k = k0; k <= k1; k++) {
    for (const [u, v, type] of bps) {
      // saw: the end of one cycle and the start of the next are one tick apart (a vertical edge)
      const t = (k + u - phase) * cycleLen - (u === 1 ? 1 : 0);
      if (t <= from || t >= to) continue;
      put(t, v, type || 'single');
    }
  }
  put(to, lfoValue(shape, uAt(to)), shape === 4 ? 'hold' : 'single');
  return dedupe(pts);
}

function dedupe(pts) {
  pts.sort((a, b) => a.t - b.t);
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.t === p.t) { last.v = p.v; last.type = p.type; } else out.push(p);
  }
  return out;
}

// Remove points that lie (within `tol`) on the straight line between their neighbours (single-curve segments only).
export function thinPoints(points, tol = 0.004) {
  if (points.length < 3) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1], b = points[i], c = points[i + 1];
    const straight = (a.type || 'single') === 'single' && (b.type || 'single') === 'single' && !(a.tension || b.tension);
    const u = (b.t - a.t) / Math.max(1, c.t - a.t), lin = a.v + (c.v - a.v) * u;
    if (!(straight && Math.abs(lin - b.v) < tol)) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}
