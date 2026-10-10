// Native plugins (VST3 / CLAP) in the project:
//   channel  { type: 'plugin', plugin: PluginRef, params: { "<param id>": normalized value } }
//   fx slot  { type: 'plugin', params: {...}, extra: { plugin: PluginRef } }
//   PluginRef = { id, format, path, uid, name, vendor, kind, state (base64 or null), params: [[id, name, def, steps, unit]] }
// Parameters are the plugin's own (normalized 0..1). Only values FL LUA set are stored in `params`; everything else
// lives in the plugin's saved state. The parameter list is kept so automation and knobs work without the plugin.
import { def } from './schema.js';
import { instrumentSchema } from './instruments/index.js';
import { effectSchema } from './effects/index.js';

const cache = new WeakMap();
const MAX_PARAMS = 4096;
const MAX_STATE = 32 << 20;          // base64 characters

export function pluginSchema(ref) {
  if (!ref || !Array.isArray(ref.params)) return [];
  let s = cache.get(ref.params);
  if (!s) {
    s = ref.params.map(([id, name, d, steps, unit]) => def(String(id), name || `Parameter ${id}`, 0, 1, Math.max(0, Math.min(1, +d || 0)), { group: 'Plugin', unit: unit || '', steps: steps | 0 }));
    for (const d of s) d.plugin = true;
    cache.set(ref.params, s);
  }
  return s;
}

export const channelSchema = (ch) => (ch.type === 'plugin' ? pluginSchema(ch.plugin) : instrumentSchema(ch.type));
export const slotSchema = (slot) => (slot.type === 'plugin' ? pluginSchema(slot.extra && slot.extra.plugin) : effectSchema(slot.type));

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

export function normalizePluginRef(o, withId = false) {
  const r = o && typeof o === 'object' ? o : {};
  const out = {
    format: r.format === 'clap' ? 'clap' : 'vst3',
    path: str(r.path, 4096), uid: str(r.uid, 256), name: str(r.name, 120), vendor: str(r.vendor, 120),
    kind: r.kind === 'effect' ? 'effect' : 'instrument',
    state: typeof r.state === 'string' && r.state.length < MAX_STATE && /^[A-Za-z0-9+/=]*$/.test(r.state.slice(0, 64)) ? r.state : null,
    params: [],
  };
  if (Array.isArray(r.params)) {
    for (const p of r.params.slice(0, MAX_PARAMS)) {
      if (!Array.isArray(p) || !Number.isInteger(p[0]) || p[0] < 0) continue;
      out.params.push([p[0], str(p[1], 80), Math.max(0, Math.min(1, +p[2] || 0)), Math.max(0, Math.min(1 << 20, p[3] | 0)), str(p[4], 16)]);
    }
  }
  if (withId || r.id) out.id = /^[\w-]{1,40}$/.test(r.id || '') ? r.id : `p${Math.random().toString(36).slice(2, 10)}`;
  return out;
}

// only the values FL LUA set, for parameters the plugin has
export function normalizePluginParams(ref, raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const ids = new Set((ref.params || []).map((p) => String(p[0])));
  for (const k of Object.keys(raw)) if (ids.has(k) && typeof raw[k] === 'number' && raw[k] >= 0 && raw[k] <= 1) out[k] = raw[k];
  return out;
}

// the parameter list from the host: visible, automatable parameters
export function paramListOf(params) {
  return (params || []).filter((p) => !p.hidden && !p.readOnly && p.automatable !== false).slice(0, MAX_PARAMS)
    .map((p) => [p.id, p.name || '', p.def || 0, p.steps || 0, p.unit || '']);
}
