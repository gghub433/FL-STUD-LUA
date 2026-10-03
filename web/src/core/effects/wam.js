// A WAM 2.0 plugin in a mixer slot (see ../wam-link.js): the slot hands its signal to the plugin and takes back what
// the plugin returned for the previous block. Without a linked plugin (offline worker, plugin not loaded) the signal
// passes unchanged. The latency it reports lets the mixer keep the other tracks aligned.
import { BLOCK } from '../constants.js';
import { linkOf } from '../wam-link.js';

export const schema = [];
export const meta = { id: 'wam', name: 'WAM plugin…', category: 'External', description: 'A Web Audio Modules 2.0 effect loaded from an address (URL)' };

class WamEffect {
  constructor(sr, host) { this.sr = sr; this.host = host; this.owner = null; }
  get link() { return linkOf(this.host, this.owner); }
  get latency() { const l = this.link; return l ? BLOCK + (l.latency || 0) : 0; }
  setParam() {}
  setExtra(x) { this.owner = x && x.wam && x.wam.id ? `fx:${x.wam.id}` : null; }
  reset() {}
  process(L, R, n) {
    const l = this.link, out = this.host.extOut, inp = this.host.extIn;
    if (!l || !out || !inp) return;
    const ol = out[l.port * 2], or = out[l.port * 2 + 1], il = inp[l.port * 2], ir = inp[l.port * 2 + 1] || il;
    if (!ol || !or || !il) return;
    for (let i = 0; i < n; i++) { ol[i] = L[i]; or[i] = R[i]; L[i] = il[i]; R[i] = ir[i]; }
  }
}

export function create(sr, host) { return new WamEffect(sr, host); }
