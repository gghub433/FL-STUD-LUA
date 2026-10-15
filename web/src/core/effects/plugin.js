// A VST3 / CLAP effect in a mixer slot (see ../plugin-link.js): the slot hands its signal to the plugin host and takes
// back what the plugin returned a few blocks earlier; that delay plus the plugin's own is reported as latency, so the
// mixer keeps the tracks aligned. Without the host the signal passes unchanged.
import { PluginPort, latencyOf } from '../plugin-link.js';

export const schema = [];
export const meta = { id: 'plugin', name: 'VST / CLAP plugin', category: 'External', description: 'An effect plugin installed on this computer (desktop app)' };

class PluginEffect {
  constructor(sr, host) { this.sr = sr; this.host = host; this.port = new PluginPort(host); }
  get latency() { return latencyOf(this.host, this.port.link); }
  setExtra(x) { this.port.owner = x && x.plugin && x.plugin.id ? `fx:${x.plugin.id}` : null; }
  syncParams(params) { for (const k in params) this.port.param(k, params[k], true); }
  setParam(key, v) { this.port.param(key, v); }
  reset() {}
  process(L, R, n) {
    if (!this.port.live) return;
    this.port.writeIn(L, R, n);
    this.port.readOut(L, R, 0, n, true);
  }
}

export function create(sr, host) { return new PluginEffect(sr, host); }
