// A VST3 / CLAP instrument from the desktop app's plugin host (see ../plugin-link.js). Notes and parameter changes
// go to the plugin through the shared ring; its sound comes back a few blocks later (reported as latency, so the
// mixer keeps everything aligned). Without the host (browser, offline worker without plugins) it is silent.
import { PluginPort, latencyOf } from '../plugin-link.js';
import { EV } from '../plugin-layout.js';

export const schema = [];
export const meta = { id: 'plugin', name: 'VST3 / CLAP plugin', kind: 'external', description: 'An instrument plugin installed on this computer (desktop app)' };

const clampKey = (k) => Math.max(0, Math.min(127, k));

export class PluginInstrument {
  constructor(sr, host) { this.sr = sr; this.host = host; this.port = new PluginPort(host); this.p = {}; this.held = new Map(); }
  get active() { return this.port.live; }
  get latency() { return latencyOf(this.host, this.port.link); }
  setData(ch) { this.port.owner = `ch:${ch.id}`; }
  syncParams(params) { for (const k in params) this.port.param(k, params[k], true); }
  setParam(key, v) { this.port.param(key, v); }
  noteOn(ev) {
    const k = clampKey(Math.round(ev.key + (ev.fine || 0) / 100));
    if (this.held.has(ev.key)) this.noteOff(ev.key);
    this.held.set(ev.key, k);
    this.port.event(EV.NOTE_ON, 0, k, -1, 0, Math.max(0.005, Math.min(1, ev.vel ?? 0.8)));
  }
  noteOff(key) {
    const k = this.held.get(key);
    if (k === undefined) return;
    this.held.delete(key);
    this.port.event(EV.NOTE_OFF, 0, k, -1, 0, 0);
  }
  allOff() { this.held.clear(); this.port.event(EV.ALL_OFF, 0, 0, -1, 0, 0); }
  chokeAll() { this.allOff(); }
  midi(type, channel, key, value) { this.port.event(type, channel & 15, key & 127, -1, 0, value); }
  process(L, R, a, b) {
    if (this.port.slot() < 0) return;
    this.port.readOut(L, R, a, b);
  }
}

export function create(sr, host) { return new PluginInstrument(sr, host); }
