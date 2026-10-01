// Sample bank: the main thread keeps decoded PCM here, persists user samples in IndexedDB and
// streams each sample to the audio engine exactly once.
import { renderFactorySample, isFactoryId, FACTORY_BY_ID } from '../core/factory.js';
import { idbGet, idbPut } from './idb.js';

// cyrb53 string/array hash, used to give identical audio the same id
function hashPCM(ch, rate) {
  let h1 = 0xdeadbeef ^ rate, h2 = 0x41c6ce57 ^ ch[0].length;
  const a = ch[0];
  const stride = Math.max(1, Math.floor(a.length / 20000));
  for (let c = 0; c < ch.length; c++) {
    const d = ch[c];
    for (let i = 0; i < d.length; i += stride) {
      const v = Math.round(d[i] * 32767);
      h1 = Math.imul(h1 ^ v, 2654435761); h2 = Math.imul(h2 ^ v, 1597334677);
    }
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export class SampleBank {
  constructor(host, bus) {
    this.host = host;
    this.bus = bus;
    this.map = new Map();    // id -> { id, name, rate, channels: Float32Array[], length }
    this.sent = new Set();
    this.loading = new Map();
  }

  get(id) { return this.map.get(id) || null; }
  has(id) { return this.map.has(id); }

  name(id) {
    const e = this.map.get(id);
    if (e) return e.name;
    const f = FACTORY_BY_ID.get(id);
    return f ? f.name : id;
  }

  _send(e) {
    if (this.sent.has(e.id)) return;
    this.sent.add(e.id);
    // copies are transferred so the bank keeps its own PCM for waveform drawing / export
    const copies = e.channels.map((c) => c.slice());
    this.host.send({ t: 'sample', id: e.id, rate: e.rate, channels: copies }, copies.map((c) => c.buffer));
  }

  // Forget what the engine knows (after the worklet restarts).
  resend() { this.sent.clear(); for (const e of this.map.values()) this._send(e); }

  addPCM(name, rate, channels, id = null, persist = true) {
    id = id || 'user:' + hashPCM(channels, rate);
    const e = { id, name, rate, channels, length: channels[0].length };
    this.map.set(id, e);
    this._send(e);
    if (persist && !isFactoryId(id)) idbPut('samples', id, { name, rate, channels });
    this.bus.emit('samples');
    return e;
  }

  async decode(name, arrayBuffer) {
    const buf = await this.host.ctx.decodeAudioData(arrayBuffer.slice(0));
    const channels = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c).slice());
    return this.addPCM(name.replace(/\.[^.]+$/, ''), buf.sampleRate, channels);
  }

  // Make sure a sample is decoded/loaded and known to the engine. Resolves to the entry or null.
  ensure(id) {
    if (!id) return Promise.resolve(null);
    if (this.map.has(id)) { this._send(this.map.get(id)); return Promise.resolve(this.map.get(id)); }
    if (this.loading.has(id)) return this.loading.get(id);
    const p = (async () => {
      if (isFactoryId(id)) {
        const data = renderFactorySample(id, this.host.sampleRate);
        if (!data) return null;
        const f = FACTORY_BY_ID.get(id);
        return this.addPCM(f.name, this.host.sampleRate, [data], id, false);
      }
      const rec = await idbGet('samples', id);
      if (!rec) return null;
      return this.addPCM(rec.name, rec.rate, rec.channels, id, false);
    })();
    this.loading.set(id, p);
    p.finally(() => this.loading.delete(id));
    return p;
  }

  async ensureProject(project) {
    const ids = new Set();
    for (const ch of project.channels) {
      if (ch.sample && ch.sample.id) ids.add(ch.sample.id);
      for (const id of ch.extraSamples || []) ids.add(id);
    }
    const missing = [];
    await Promise.all([...ids].map(async (id) => { if (!(await this.ensure(id))) missing.push(id); }));
    return missing;
  }
}
