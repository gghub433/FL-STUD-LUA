// Effect registry. Each module exports { schema, meta, create(sr, host) }.
// create() returns an object with: setParam(id, v), process(L, R, n, ctx), reset(), latency (samples),
// optional setExtra(obj) for non-parameter data (impulse response id, curves) and meters[] for the UI.
// ctx = { scL, scR } sidechain buffers (null when nothing is routed as sidechain).
import * as eq from './eq.js';
import * as compressor from './compressor.js';
import * as limiter from './limiter.js';
import * as gate from './gate.js';
import * as multiband from './multiband.js';
import * as reverb from './reverb.js';
import * as delay from './delay.js';
import * as mod from './modulation.js';
import * as distortion from './distortion.js';
import * as bitcrusher from './bitcrusher.js';
import * as filter from './filter.js';
import * as stereo from './stereo.js';
import * as convolver from './convolver.js';
import * as vocoder from './vocoder.js';
import * as grossbeat from './grossbeat.js';
import * as tremolo from './tremolo.js';
import * as transient from './transient.js';
import * as pitchshift from './pitchshift.js';
import * as freqshift from './freqshift.js';
import * as tape from './tape.js';
import * as patcher from './patcher.js';

export const EFFECTS = {
  eq, compressor, multiband, limiter, gate,
  reverb, delay, convolver,
  chorus: { schema: mod.chorusSchema, meta: mod.chorusMeta, create: mod.createChorus },
  flanger: { schema: mod.flangerSchema, meta: mod.flangerMeta, create: mod.createFlanger },
  phaser: { schema: mod.phaserSchema, meta: mod.phaserMeta, create: mod.createPhaser },
  distortion, bitcrusher, filter, stereo, vocoder, grossbeat,
  tremolo, transient, pitchshift, freqshift, tape, patcher,
};

export function registerEffect(type, m) { EFFECTS[type] = m; }
export const hasEffect = (type) => Object.prototype.hasOwnProperty.call(EFFECTS, type);
export const effectSchema = (type) => (hasEffect(type) ? EFFECTS[type].schema : null);
export const effectMeta = (type) => (hasEffect(type) ? EFFECTS[type].meta : null);
export const createEffect = (type, sr, host) => EFFECTS[type].create(sr, host);
export const effectList = () => Object.keys(EFFECTS).map((id) => ({ id, ...EFFECTS[id].meta }));
