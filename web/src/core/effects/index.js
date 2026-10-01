// Effect registry. Each module exports { schema, meta, create(sr, host) }.
// create() returns an object with: setParam(id, v), process(L, R, n, ctx), reset(), latency (samples).
// ctx = { scL, scR } optional sidechain buffers (null when not routed).
export const EFFECTS = {};

export function registerEffect(type, mod) { EFFECTS[type] = mod; }
export const hasEffect = (type) => Object.prototype.hasOwnProperty.call(EFFECTS, type);
export const effectSchema = (type) => (hasEffect(type) ? EFFECTS[type].schema : null);
export const effectMeta = (type) => (hasEffect(type) ? EFFECTS[type].meta : null);
export const createEffect = (type, sr, host) => EFFECTS[type].create(sr, host);
export const effectList = () => Object.keys(EFFECTS).map((id) => ({ id, ...EFFECTS[id].meta }));
