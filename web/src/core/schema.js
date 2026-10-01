// Parameter schema. One definition drives the engine (ranges, defaults), the UI (knob
// range, value text) and automation (normalized 0..1 <-> real value).
//
//   def(id, name, min, max, default, { unit, curve, step, int, options, group, skew, bool })
//
// curve: 'lin' (default), 'log' (min must be > 0), 'pow' (skew exponent, e.g. 2 = more
// resolution at the low end). Enum params use options: ['Sine','Saw',...] and are integers.

export function def(id, name, min, max, dflt, o = {}) {
  const d = {
    id, name, min, max, def: dflt,
    unit: o.unit || '', curve: o.curve || 'lin', skew: o.skew || 2,
    step: o.step, int: !!(o.int || o.options || o.bool), options: o.options || null, bool: !!o.bool,
    group: o.group || '',
  };
  if (d.options) { d.min = 0; d.max = d.options.length - 1; }
  if (d.bool) { d.min = 0; d.max = 1; }
  return d;
}

export const bool = (id, name, dflt = 0, o = {}) => def(id, name, 0, 1, dflt ? 1 : 0, { ...o, bool: true });
export const choice = (id, name, options, dflt = 0, o = {}) => def(id, name, 0, options.length - 1, dflt, { ...o, options });

export function clampParam(d, v) {
  if (typeof v !== 'number' || v !== v) return d.def;
  v = v < d.min ? d.min : v > d.max ? d.max : v;
  if (d.int) v = Math.round(v);
  return v;
}

export function toNorm(d, v) {
  const span = d.max - d.min;
  if (span <= 0) return 0;
  let n = (clampParam(d, v) - d.min) / span;
  if (d.curve === 'log' && d.min > 0) n = Math.log(clampParam(d, v) / d.min) / Math.log(d.max / d.min);
  else if (d.curve === 'pow') n = Math.pow(n, 1 / d.skew);
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function fromNorm(d, n) {
  n = n < 0 ? 0 : n > 1 ? 1 : n;
  let v;
  if (d.curve === 'log' && d.min > 0) v = d.min * Math.pow(d.max / d.min, n);
  else if (d.curve === 'pow') v = d.min + (d.max - d.min) * Math.pow(n, d.skew);
  else v = d.min + (d.max - d.min) * n;
  if (d.step && !d.int) v = Math.round(v / d.step) * d.step;
  return clampParam(d, v);
}

export function format(d, v) {
  if (d.options) return d.options[clampParam(d, v)] ?? String(v);
  if (d.bool) return v ? 'On' : 'Off';
  const a = Math.abs(v);
  let s;
  if (d.int) s = String(Math.round(v));
  else if (d.unit === 'Hz' || d.unit === 'ms' || d.unit === 's') {
    if (d.unit === 'Hz' && a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 1 : 2) + ' kHz';
    s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
  } else s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
  return d.unit ? `${s} ${d.unit}` : s;
}

// Parse text typed into the knob value box. Accepts "12", "-6 dB", "1.5k", "50%".
export function parseValue(d, text) {
  if (d.options) {
    const t = text.trim().toLowerCase();
    const i = d.options.findIndex((o) => o.toLowerCase() === t || o.toLowerCase().startsWith(t));
    if (i >= 0) return i;
  }
  const m = String(text).trim().toLowerCase().match(/^(-?\d*\.?\d+)\s*(k|%)?/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (m[2] === 'k') v *= 1000;
  if (m[2] === '%') v = d.min + (d.max - d.min) * (v / 100);
  return clampParam(d, v);
}

export function defaults(schema) {
  const o = {};
  for (const d of schema) o[d.id] = d.def;
  return o;
}

export function schemaMap(schema) {
  const m = new Map();
  for (const d of schema) m.set(d.id, d);
  return m;
}
