// Instrument registry. A channel's `type` selects the module; `params` hold schema values.
import * as sampler from './sampler.js';
import * as drums from './drumsynth.js';
import * as fpc from './fpc.js';
import * as slicer from './slicer.js';
import * as subsynth from './subsynth.js';
import * as fm from './fmsynth.js';

export const INSTRUMENTS = { sampler, fpc, slicer, subsynth, fm, drums };

export function registerInstrument(type, mod) { INSTRUMENTS[type] = mod; }
export const hasInstrument = (type) => Object.prototype.hasOwnProperty.call(INSTRUMENTS, type);
export const instrumentSchema = (type) => (hasInstrument(type) ? INSTRUMENTS[type].schema : null);
export const instrumentMeta = (type) => (hasInstrument(type) ? INSTRUMENTS[type].meta : null);
export const createInstrument = (type, sr, host) => INSTRUMENTS[type].create(sr, host);
