// Hosting WAM 2.0 plugins (Web Audio Modules, https://www.webaudiomodules.com): third-party instruments and effects
// published as ES modules. Each plugin is its own Web Audio node; a WamRig wires plugins to the engine node of one
// AudioContext (the live one, or an OfflineAudioContext for export) through 16 stereo ports:
//   instrument   plugin ─▶ stereo up-mix ─▶ split ─▶ merger ─▶ engine input (channels 2p, 2p+1)
//   effect       engine output 1 (2p, 2p+1) ─▶ merge ─▶ plugin ─▶ delay ─▶ split ─▶ merger ─▶ engine input
// The loop of an effect needs a delay node; Web Audio makes it exactly one block (128 frames), which the engine
// reports as the slot's latency. Notes reach instrument processors directly in the AudioWorklet scope
// (see core/wam-link.js), so the page is not in the timing path.
import { WAM_PORTS } from '../core/wam-link.js';

let sdk = null;
const loadSdk = () => (sdk = sdk || import('../../vendor/wam-sdk.js'));
const modules = new Map();           // absolute url -> Promise<WAM class>

export const absoluteUrl = (url) => new URL(url, location.href).href;

// the plugin's class (default export of its module); throws when the address is not a WAM 2.0 plugin
export function loadPlugin(url) {
  const abs = absoluteUrl(url);
  if (!modules.has(abs)) {
    const p = import(/* webpackIgnore: true */ abs).then((m) => {
      const W = m && m.default;
      if (!W || !(W.isWebAudioModuleConstructor || typeof W.createInstance === 'function')) throw new Error('This address is not a WAM 2.0 plugin (its module has no WebAudioModule default export)');
      return W;
    });
    p.catch(() => modules.delete(abs));            // a failed load may be retried
    modules.set(abs, p);
  }
  return modules.get(abs);
}

export class WamRig {
  // send(message) posts to the engine node of `ctx`
  constructor(ctx, engineNode, send) {
    this.ctx = ctx; this.node = engineNode; this.send = send;
    this.items = new Map();            // owner -> { inst, port, kind, url, nodes }
    this.free = Array.from({ length: WAM_PORTS }, (_, i) => i);
    this.ready = null;
  }

  init() {
    if (!this.ready) {
      this.ready = (async () => {
        const { initializeWamHost } = await loadSdk();
        const [id, key] = await initializeWamHost(this.ctx);
        this.groupId = id;
        this.send({ t: 'wam', op: 'group', id, key });
        this.merger = this.ctx.createChannelMerger(WAM_PORTS * 2);
        this.merger.connect(this.node, 0, 0);
        this.splitter = this.ctx.createChannelSplitter(WAM_PORTS * 2);
        this.node.connect(this.splitter, 1, 0);
      })();
    }
    return this.ready;
  }

  // creates the plugin from `url` with `state` and links it to `owner` ('ch:<id>' or 'fx:<id>'); returns the instance
  async attach(owner, kind, url, state) {
    await this.init();
    if (this.items.has(owner)) this.detach(owner);
    if (!this.free.length) throw new Error(`At most ${WAM_PORTS} WAM plugins can run at the same time`);
    const W = await loadPlugin(url);
    const inst = await W.createInstance(this.groupId, this.ctx, state || undefined);
    const node = inst.audioNode;
    if (!node) throw new Error('The plugin did not create an audio node');
    if (state && typeof node.setState === 'function') { try { await node.setState(state); } catch (_) { /* the plugin keeps its defaults */ } }
    if (this.items.has(owner)) this.detach(owner);          // attached again while this one was loading
    const port = this.free.shift();
    const ctx = this.ctx, nodes = [];
    const up = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });   // mono plugins sound on both sides
    const ret = ctx.createChannelSplitter(2);
    if (kind === 'fx') {
      const inM = ctx.createChannelMerger(2);
      this.splitter.connect(inM, port * 2, 0); this.splitter.connect(inM, port * 2 + 1, 1);
      inM.connect(node);
      const d = ctx.createDelay(1); d.delayTime.value = 0;
      node.connect(d); d.connect(up);
      nodes.push(inM, d);
    } else node.connect(up);
    up.connect(ret);
    ret.connect(this.merger, 0, port * 2); ret.connect(this.merger, 1, port * 2 + 1);
    nodes.push(up, ret);
    let latency = 0;
    try { if (typeof node.getCompensationDelay === 'function') latency = Math.max(0, Math.min(48000, Math.round((await node.getCompensationDelay()) || 0))); } catch (_) { /* none */ }
    this.items.set(owner, { inst, port, kind, url, nodes });
    this.send({ t: 'wam', op: 'port', owner, port, instanceId: inst.instanceId, latency });
    return inst;
  }

  detach(owner) {
    const it = this.items.get(owner);
    if (!it) return;
    this.items.delete(owner);
    this.send({ t: 'wam', op: 'unport', owner });
    for (const n of it.nodes) { try { n.disconnect(); } catch (_) { /* gone */ } }
    try { it.inst.audioNode.disconnect(); } catch (_) { /* gone */ }
    try { if (typeof it.inst.audioNode.destroy === 'function') it.inst.audioNode.destroy(); } catch (_) { /* gone */ }
    if (it.kind === 'fx') { try { this.splitter.disconnect(it.nodes[0]); } catch (_) { /* gone */ } }     // the send into the plugin
    this.free.push(it.port);
    this.free.sort((a, b) => a - b);
  }

  instance(owner) { const it = this.items.get(owner); return it ? it.inst : null; }

  async stateOf(owner) {
    const it = this.items.get(owner);
    if (!it || typeof it.inst.audioNode.getState !== 'function') return null;
    try { return await withTimeout(it.inst.audioNode.getState(), 2000); } catch (_) { return null; }
  }

  close() { for (const o of [...this.items.keys()]) this.detach(o); }
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// every WAM plugin a project uses: [{ owner, kind, url, state, name }]
export function wamUses(project) {
  const out = [];
  for (const ch of project.channels) if (ch.type === 'wam' && ch.wam && ch.wam.url) out.push({ owner: `ch:${ch.id}`, kind: 'inst', url: ch.wam.url, state: ch.wam.state, name: ch.wam.name || ch.name, data: ch.wam });
  project.mixer.tracks.forEach((t) => t.fx.forEach((s) => {
    const w = s && s.type === 'wam' && s.extra && s.extra.wam;
    if (w && w.url && w.id) out.push({ owner: `fx:${w.id}`, kind: 'fx', url: w.url, state: w.state, name: w.name, data: w });
  }));
  return out;
}
