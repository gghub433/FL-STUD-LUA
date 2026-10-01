// Parameter addresses. Any knob/fader in the project can be automated or linked to a MIDI
// controller because every one has a stable string address:
//
//   ch:<channelId>:vol | pan | pitch          channel built-ins
//   ch:<channelId>:p:<param>                  instrument parameter (schema of channel.type)
//   mx:<track>:vol|pan|sep|delay|eqLowG|...   mixer track built-ins (track 0 = master)
//   mx:<track>:fx:<slot>:mix | on             effect slot wet/dry and bypass
//   mx:<track>:fx:<slot>:p:<param>            effect parameter (schema of slot.type)
//   master:vol | pitch
//   transport:tempo | swing
import { def, clampParam } from './schema.js';
import { instrumentSchema } from './instruments/index.js';
import { effectSchema } from './effects/index.js';

export const CHANNEL_BUILTIN = [
  def('vol', 'Volume', 0, 1, 0.8),
  def('pan', 'Panning', -1, 1, 0),
  def('pitch', 'Pitch', -12, 12, 0, { unit: 'st', step: 0.01 }),
];

export const TRACK_BUILTIN = [
  def('vol', 'Volume', 0, 1, 0.8),
  def('pan', 'Panning', -1, 1, 0),
  def('sep', 'Stereo separation', -1, 1, 0),
  def('delay', 'Track delay', 0, 100, 0, { unit: 'ms', curve: 'pow', skew: 2 }),
  def('eqLowG', 'EQ low level', -18, 18, 0, { unit: 'dB' }),
  def('eqLowF', 'EQ low freq', 20, 600, 120, { unit: 'Hz', curve: 'log' }),
  def('eqMidG', 'EQ mid level', -18, 18, 0, { unit: 'dB' }),
  def('eqMidF', 'EQ mid freq', 100, 8000, 1200, { unit: 'Hz', curve: 'log' }),
  def('eqMidQ', 'EQ mid width', 0.2, 6, 1, { curve: 'log' }),
  def('eqHighG', 'EQ high level', -18, 18, 0, { unit: 'dB' }),
  def('eqHighF', 'EQ high freq', 1000, 18000, 8000, { unit: 'Hz', curve: 'log' }),
];

export const MASTER_BUILTIN = [
  def('vol', 'Master volume', 0, 1, 0.8),
  def('pitch', 'Master pitch', -12, 12, 0, { unit: 'st', step: 0.01 }),
];

export const TRANSPORT_BUILTIN = [
  def('tempo', 'Tempo', 10, 522, 130, { unit: 'BPM', step: 0.001 }),
  def('swing', 'Swing', 0, 1, 0),
];

const find = (list, id) => list.find((d) => d.id === id) || null;

export function parseAddr(addr) {
  if (typeof addr !== 'string') return null;
  const p = addr.split(':');
  switch (p[0]) {
    case 'ch':
      if (p.length === 3) return { kind: 'ch', id: +p[1], key: p[2] };
      if (p.length === 4 && p[2] === 'p') return { kind: 'chp', id: +p[1], key: p[3] };
      return null;
    case 'mx':
      if (p.length === 3) return { kind: 'mx', track: +p[1], key: p[2] };
      if (p.length === 5 && p[2] === 'fx' && (p[4] === 'mix' || p[4] === 'on')) return { kind: 'fxs', track: +p[1], slot: +p[3], key: p[4] };
      if (p.length === 6 && p[2] === 'fx' && p[4] === 'p') return { kind: 'fxp', track: +p[1], slot: +p[3], key: p[5] };
      return null;
    case 'master':
      return p.length === 2 ? { kind: 'master', key: p[1] } : null;
    case 'transport':
      return p.length === 2 ? { kind: 'transport', key: p[1] } : null;
    default:
      return null;
  }
}

export const chAddr = (id, key) => `ch:${id}:${key}`;
export const chpAddr = (id, key) => `ch:${id}:p:${key}`;
export const mxAddr = (track, key) => `mx:${track}:${key}`;
export const fxAddr = (track, slot, key) => `mx:${track}:fx:${slot}:${key}`;
export const fxpAddr = (track, slot, key) => `mx:${track}:fx:${slot}:p:${key}`;

export const findChannel = (project, id) => project.channels.find((c) => c.id === id) || null;

const MIX_DEF = def('mix', 'Mix', 0, 1, 1);
const ON_DEF = def('on', 'Enabled', 0, 1, 1, { bool: true });

// Schema definition of an address (null if unknown / not automatable).
export function paramDef(project, addr) {
  const a = typeof addr === 'string' ? parseAddr(addr) : addr;
  if (!a) return null;
  switch (a.kind) {
    case 'ch': return find(CHANNEL_BUILTIN, a.key);
    case 'chp': {
      const ch = findChannel(project, a.id);
      const s = ch && instrumentSchema(ch.type);
      return s ? find(s, a.key) : null;
    }
    case 'mx': return find(TRACK_BUILTIN, a.key);
    case 'fxs': return a.key === 'mix' ? MIX_DEF : ON_DEF;
    case 'fxp': {
      const slot = project.mixer.tracks[a.track]?.fx[a.slot];
      const s = slot && effectSchema(slot.type);
      return s ? find(s, a.key) : null;
    }
    case 'master': return find(MASTER_BUILTIN, a.key);
    case 'transport': return find(TRANSPORT_BUILTIN, a.key);
    default: return null;
  }
}

// Human-readable label, e.g. "Kick · Volume" or "Insert 3 / Slot 2 · Threshold".
export function paramLabel(project, addr) {
  const a = parseAddr(addr);
  const d = paramDef(project, a);
  if (!a || !d) return String(addr);
  switch (a.kind) {
    case 'ch': case 'chp': return `${findChannel(project, a.id)?.name ?? 'Channel'} · ${d.name}`;
    case 'mx': return `${trackName(project, a.track)} · ${d.name}`;
    case 'fxs': case 'fxp': return `${trackName(project, a.track)} / slot ${a.slot + 1} · ${d.name}`;
    case 'master': return `Master · ${d.name}`;
    default: return d.name;
  }
}

export function trackName(project, n) {
  const t = project.mixer.tracks[n];
  if (n === 0) return 'Master';
  return t && t.name ? t.name : `Insert ${n}`;
}

// Read the current value from the project model.
export function getParam(project, addr) {
  const a = typeof addr === 'string' ? parseAddr(addr) : addr;
  if (!a) return undefined;
  switch (a.kind) {
    case 'ch': { const c = findChannel(project, a.id); return c ? c[a.key] : undefined; }
    case 'chp': { const c = findChannel(project, a.id); return c ? c.params[a.key] : undefined; }
    case 'mx': { const t = project.mixer.tracks[a.track]; return t ? t[a.key] : undefined; }
    case 'fxs': { const s = project.mixer.tracks[a.track]?.fx[a.slot]; return s ? (a.key === 'mix' ? s.mix : s.on) : undefined; }
    case 'fxp': { const s = project.mixer.tracks[a.track]?.fx[a.slot]; return s ? s.params[a.key] : undefined; }
    case 'master': return a.key === 'vol' ? project.mixer.tracks[0].vol : project.masterPitch;
    case 'transport': return project[a.key];
    default: return undefined;
  }
}

// Write a value into the project model (clamped to the schema). Returns the stored value or undefined.
export function setParam(project, addr, value) {
  const a = typeof addr === 'string' ? parseAddr(addr) : addr;
  const d = paramDef(project, a);
  if (!a || !d) return undefined;
  const v = clampParam(d, value);
  switch (a.kind) {
    case 'ch': { const c = findChannel(project, a.id); if (!c) return undefined; c[a.key] = v; break; }
    case 'chp': { const c = findChannel(project, a.id); if (!c) return undefined; c.params[a.key] = v; break; }
    case 'mx': { const t = project.mixer.tracks[a.track]; if (!t) return undefined; t[a.key] = v; break; }
    case 'fxs': { const s = project.mixer.tracks[a.track]?.fx[a.slot]; if (!s) return undefined; s[a.key] = v; break; }
    case 'fxp': { const s = project.mixer.tracks[a.track]?.fx[a.slot]; if (!s) return undefined; s.params[a.key] = v; break; }
    case 'master': if (a.key === 'vol') project.mixer.tracks[0].vol = v; else project.masterPitch = v; break;
    case 'transport': project[a.key] = v; break;
    default: return undefined;
  }
  return v;
}
