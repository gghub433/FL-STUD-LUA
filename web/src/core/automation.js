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
