// Web MIDI input: notes play (and record into) the selected channel, CC messages drive the knobs that are
// linked to a controller number ("MIDI learn": pick a knob, move a control on the device). The same
// handle() entry point is used for real devices and by tests, which feed it raw bytes.
// Before that, incoming messages may be taken by a transport mapping (learned or from a profile) or by a
// controller script from a plugin pack.
// Web MIDI output: MIDI Out channels and MIDI clock. The engine stamps each message with its audio frame;
// it is sent with a timestamp that lines it up with the audio as it leaves the speakers.
import { paramDef, paramLabel } from '../core/addr.js';
import { fromNorm, toNorm } from '../core/schema.js';
import { controllerScripts } from '../core/packs.js';

const LS = 'stepwise.midi.disabled';
const LS_OUT = 'fllua.midi.out';
const LS_TRANSPORT = 'fllua.midi.transport';
const LS_SCRIPTS = 'fllua.midi.scripts';
const load = () => { try { return new Set(JSON.parse(localStorage.getItem(LS) || '[]')); } catch (_) { return new Set(); } };
const loadJSON = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch (_) { return { ...d }; } };
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } };

// transport actions a button on a controller can trigger
export const TRANSPORT_ACTIONS = [
  ['play', 'Play / Stop'], ['stop', 'Stop'], ['record', 'Record'], ['pause', 'Pause'], ['mode', 'Pattern / Song'],
  ['metronome', 'Metronome'], ['tap', 'Tap tempo'], ['nextPattern', 'Next pattern'], ['prevPattern', 'Previous pattern'], ['undo', 'Undo'],
];
// ready-made mappings: { name, map: [{ action, type: 'note'|'cc', num, chan (0 = any) }] }
export const TRANSPORT_PROFILES = [
  { name: 'Mackie Control buttons (notes 91–95)', map: [{ action: 'stop', type: 'note', num: 93, chan: 0 }, { action: 'play', type: 'note', num: 94, chan: 0 }, { action: 'record', type: 'note', num: 95, chan: 0 }, { action: 'prevPattern', type: 'note', num: 91, chan: 0 }, { action: 'nextPattern', type: 'note', num: 92, chan: 0 }, { action: 'metronome', type: 'note', num: 89, chan: 0 }] },
  { name: 'CC 115–119 (many keyboards: loop, back, forward, stop, play, record)', map: [{ action: 'prevPattern', type: 'cc', num: 115, chan: 0 }, { action: 'nextPattern', type: 'cc', num: 116, chan: 0 }, { action: 'stop', type: 'cc', num: 117, chan: 0 }, { action: 'play', type: 'cc', num: 118, chan: 0 }, { action: 'record', type: 'cc', num: 119, chan: 0 }] },
];

export class MidiHub {
  constructor(app) {
    this.app = app;
    this.access = null;
    this.inputs = [];                 // [{ id, name, on }]
    this.disabled = load();
    this.learn = null;                // { addr, label } while waiting for a controller move
    this.held = new Map();            // `${chan}:${key}` -> channel id the note went to
    this.lastCC = null;
    this.log = [];
    this.outputs = [];                // [{ id, name, clock }]
    this.virtual = new Map();         // name -> send(data, timestamp): test / loop-back outputs
    this.outCfg = loadJSON(LS_OUT, { clock: [] });          // names of outputs that receive MIDI clock
    this.transport = loadJSON(LS_TRANSPORT, { map: [] });   // learned / profile transport mapping
    this.transportLearn = null;
    this.scripts = new Map();         // running script id -> { def, inst }
    this.scriptCfg = loadJSON(LS_SCRIPTS, { on: [] });          // scripts are opt-in (TOOLS > MIDI settings)
    this.sent = [];                   // the last messages sent (for the MIDI monitor and tests)
    app.host.bus.on('midi', (m) => this.out(m.events));
    app.host.bus.on('restarted', () => this.syncClock());
  }

  get supported() { return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'; }

  async init() {
    if (!this.supported) return false;
    try { this.access = await navigator.requestMIDIAccess({ sysex: false }); } catch (_) { return false; }
    this.access.onstatechange = () => this.rescan();
    this.rescan();
    this.syncClock();
    return true;
  }

  rescan() {
    if (!this.access) return;
    this.inputs = [];
    for (const input of this.access.inputs.values()) {
      const on = !this.disabled.has(input.name);
      input.onmidimessage = on ? (e) => this.handle(e.data, input.name) : null;
      this.inputs.push({ id: input.id, name: input.name, on });
    }
    this.outputs = [];
    for (const o of this.access.outputs.values()) this.outputs.push({ id: o.id, name: o.name, clock: this.outCfg.clock.includes(o.name) });
    for (const name of this.virtual.keys()) this.outputs.push({ id: `virtual:${name}`, name, clock: this.outCfg.clock.includes(name), virtual: true });
    this.app.store.bus.emit('midi-devices', this.inputs);
    this.app.store.bus.emit('midi-outputs', this.outputs);
    this.startScripts();
  }

  // ---- output
  addVirtualOutput(name, send) { this.virtual.set(name, send); this.rescan(); if (!this.access) this.outputs.push({ id: `virtual:${name}`, name, clock: this.outCfg.clock.includes(name), virtual: true }); this.syncClock(); }
  outputNames() { return [...new Set([...this.outputs.map((o) => o.name), ...this.virtual.keys()])]; }

  setClock(name, on) {
    const set = new Set(this.outCfg.clock);
    if (on) set.add(name); else set.delete(name);
    this.outCfg.clock = [...set];
    saveJSON(LS_OUT, this.outCfg);
    for (const o of this.outputs) o.clock = set.has(o.name);
    this.syncClock();
  }

  syncClock() { this.app.host.send({ t: 'clock', on: this.outCfg.clock.length > 0 }); }

  // audio frame -> performance.now() time at which that frame is heard
  _time(frame) {
    const ctx = this.app.host.ctx;
    if (!ctx) return 0;
    const sr = ctx.sampleRate;
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime) return ts.performanceTime + (frame / sr - ts.contextTime) * 1000;
    return performance.now() + (frame / sr - ctx.currentTime) * 1000 + ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000;
  }

  _send(name, data, at) {
    const now = performance.now(), when = at > now ? at : 0;
    if (this.virtual.has(name)) { try { this.virtual.get(name)(data, when); } catch (_) { /* test output */ } }
    else if (this.access) {
      for (const o of this.access.outputs.values()) if (o.name === name) { try { if (when) o.send(data, when); else o.send(data); } catch (_) { /* device gone */ } }
    }
    this.sent.push({ name, data: Array.from(data), at: when || now });
    if (this.sent.length > 256) this.sent.splice(0, 64);
  }

  // events from the engine: [{ port, data, frame, clock }]
  out(events) {
    const names = this.outputNames();
    if (!names.length) return;
    for (const e of events) {
      const at = this._time(e.frame);
      if (e.clock) { for (const n of this.outCfg.clock) if (names.includes(n)) this._send(n, e.data, at); continue; }
      const target = e.port && names.includes(e.port) ? e.port : (!e.port ? names[0] : null);
      if (target) this._send(target, e.data, at);
    }
  }

  // ---- transport mapping
  setTransportMap(map) { this.transport.map = map.slice(0, 64); saveJSON(LS_TRANSPORT, this.transport); }
  learnTransport(action) {
    this.transportLearn = action;
    this.app.toast(`Press the button on your controller for “${(TRANSPORT_ACTIONS.find((a) => a[0] === action) || [0, action])[1]}” (Esc cancels)`);
  }

  _transport(type, chan, num, value) {
    if (this.transportLearn) {
      if (value === 0) return true;
      const action = this.transportLearn; this.transportLearn = null;
      this.setTransportMap([...this.transport.map.filter((m) => m.action !== action), { action, type, num, chan: chan + 1 }]);
      this.app.toast(`Linked ${type === 'note' ? 'note' : 'CC'} ${num} to “${(TRANSPORT_ACTIONS.find((a) => a[0] === action) || [0, action])[1]}”`);
      this.app.store.bus.emit('midi-transport');
      return true;
    }
    const hit = this.transport.map.find((m) => m.type === type && m.num === num && (!m.chan || m.chan === chan + 1));
    if (!hit) return false;
    if (value > 0 && (type === 'note' || value >= 64)) this.runAction(hit.action);
    return true;
  }

  runAction(action) {
    const app = this.app, t = app.transport;
    switch (action) {
      case 'play': t.toggle(); break;
      case 'stop': t.stop(); break;
      case 'record': if (app.host.st.recording) t.stop(); else t.record(); break;
      case 'pause': t.togglePause(); break;
      case 'mode': t.toggleMode(); break;
      case 'metronome': t.toggleSetting('metronome'); break;
      case 'tap': t.tapTempo(); break;
      case 'nextPattern': app.selectPatternRel && app.selectPatternRel(1); break;
      case 'prevPattern': app.selectPatternRel && app.selectPatternRel(-1); break;
      case 'undo': app.store.undo(); break;
      default: break;
    }
  }

  // ---- controller scripts from plugin packs
  scriptApi() {
    const app = this.app;
    return {
      play: () => app.transport.play(), stop: () => app.transport.stop(), record: () => app.transport.record(), toggle: () => app.transport.toggle(),
      action: (a) => this.runAction(a),
      get playing() { return app.host.st.playing; },
      get tempo() { return app.store.project.tempo; },
      setTempo: (bpm) => app.store.setParam('transport:tempo', bpm, { coalesce: 'script-tempo' }),
      get selected() { return app.store.selected; },
      channels: () => app.store.project.channels.map((c) => ({ id: c.id, name: c.name, type: c.type })),
      select: (id) => { if (app.store.channel(id)) app.store.select(id); },
      noteOn: (key, vel = 100, ch = app.store.selected) => { if (ch != null) { app.host.resume(); app.host.send({ t: 'noteOn', ch, key, vel: vel / 127 }); } },
      noteOff: (key, ch = app.store.selected) => { if (ch != null) app.host.send({ t: 'noteOff', ch, key }); },
      // parameters as 0..1 (the knob's travel), by address or by index among the selected channel's knobs
      setParam: (addr, norm) => { const d = paramDef(app.store.project, addr); if (d) app.store.setParam(addr, fromNorm(d, Math.max(0, Math.min(1, norm))), { coalesce: `script:${addr}` }); },
      getParam: (addr) => { const d = paramDef(app.store.project, addr); return d ? toNorm(d, app.store.getParam(addr)) : null; },
      channelParams: (id = app.store.selected) => { const c = app.store.channel(id); return c && c.params ? Object.keys(c.params).map((k) => `ch:${c.id}:p:${k}`).filter((a) => paramDef(app.store.project, a)) : []; },
      mixerVolume: (track, norm) => { const a = `mx:${track}:vol`; const d = paramDef(app.store.project, a); if (d) app.store.setParam(a, fromNorm(d, norm), { coalesce: `script:${a}` }); },
      send: (data, port) => { const names = this.outputNames(); const n = port || names[0]; if (n) this._send(n, data, 0); },
      toast: (m) => app.toast(String(m).slice(0, 200)),
    };
  }

  setScriptEnabled(id, on) {
    const set = new Set(this.scriptCfg.on);
    if (on) set.add(id); else set.delete(id);
    this.scriptCfg.on = [...set];
    saveJSON(LS_SCRIPTS, this.scriptCfg);
    this.startScripts();
  }

  startScripts() {
    const api = this.scriptApi(), on = new Set(this.scriptCfg.on);
    for (const [id, def] of controllerScripts) {
      if (this.scripts.has(id) || !on.has(id)) continue;
      try { this.scripts.set(id, { def, inst: def.create(api) || {} }); } catch (err) { console.warn(`[midi] script ${id}`, err); }
    }
    for (const id of [...this.scripts.keys()]) if (!controllerScripts.has(id) || !on.has(id)) { const s = this.scripts.get(id); try { if (s.inst.dispose) s.inst.dispose(); } catch (_) { /* ignore */ } this.scripts.delete(id); }
  }

  _scripts(data, source) {
    if (!this.scripts.size) return false;
    for (const [, s] of this.scripts) {
      const ports = s.def.ports || [];
      if (ports.length && !ports.some((p) => String(source).toLowerCase().includes(String(p).toLowerCase()))) continue;
      try { if (s.inst.onMidi && s.inst.onMidi(Array.from(data), source) === true) return true; } catch (err) { console.warn('[midi] script error', err); }
    }
    return false;
  }

  setDeviceEnabled(name, on) {
    if (on) this.disabled.delete(name); else this.disabled.add(name);
    try { localStorage.setItem(LS, JSON.stringify([...this.disabled])); } catch (_) { /* private mode */ }
    this.rescan();
  }

  // ---- parameter linking
  startLearn(addr) {
    const label = paramLabel(this.app.store.project, addr);
    this.learn = { addr, label };
    this.app.toast(`MIDI learn: move a control on your device to link “${label}” (Esc cancels)`);
    this.app.store.bus.emit('midi-learn', this.learn);
  }

  cancelLearn() {
    if (!this.learn) return false;
    this.learn = null;
    this.app.store.bus.emit('midi-learn', null);
    this.app.toast('MIDI learn cancelled');
    return true;
  }

  // ---- incoming bytes
  handle(data, source = '') {
    if (!data || data.length < 2) return;
    const st = data[0], type = st >> 4, chan = st & 15;
    const a = data[1], b = data.length > 2 ? data[2] : 0;
    this.log.push([st, a, b]); if (this.log.length > 64) this.log.shift();
    if (this._scripts(data, source)) return;
    if ((type === 9 || type === 8) && this._transport('note', chan, a, type === 9 ? b : 0)) return;
    if (type === 11 && this._transport('cc', chan, a, b)) return;
    if (type === 9 && b > 0) this.noteOn(chan, a, b);
    else if (type === 8 || (type === 9 && b === 0)) this.noteOff(chan, a);
    else if (type === 11) this.cc(chan, a, b);
    else if (type === 14) this.bend(chan, a | (b << 7));
  }

  noteOn(chan, key, vel) {
    const app = this.app, ch = app.store.selected;
    if (ch == null || !app.store.channel(ch)) return;
    app.host.resume();
    this.held.set(`${chan}:${key}`, ch);
    app.host.send({ t: 'noteOn', ch, key, vel: vel / 127 });
  }

  noteOff(chan, key) {
    const id = `${chan}:${key}`, ch = this.held.get(id);
    if (ch === undefined) return;
    this.held.delete(id);
    this.app.host.send({ t: 'noteOff', ch, key });
  }

  // pitch wheel: +-2 semitones on the selected channel's pitch while it is held away from the centre
  bend(chan, v14) {
    const app = this.app, ch = app.store.selected;
    if (ch == null || !app.store.channel(ch) || !this.bendEnabled) return;
    app.store.setParam(`ch:${ch}:pitch`, ((v14 - 8192) / 8192) * 2, { noUndo: true });
  }

  cc(chan, cc, value) {
    const store = this.app.store, p = store.project;
    this.lastCC = { chan, cc, value };
    store.bus.emit('midi-cc', this.lastCC);
    if (this.learn) {
      const { addr, label } = this.learn;
      this.learn = null;
      this.app.cmd.setMidiLink(store, { addr, chan: chan + 1, cc, min: 0, max: 1, invert: 0 });
      store.bus.emit('midi-learn', null);
      this.app.toast(`“${label}” linked to CC ${cc} (channel ${chan + 1})`);
      return;
    }
    for (const l of p.controllers) {
      if (l.cc !== cc || (l.chan !== 0 && l.chan !== chan + 1)) continue;
      const d = paramDef(p, l.addr);
      if (!d) continue;
      const x = value / 127, n = l.min + (l.max - l.min) * (l.invert ? 1 - x : x);
      store.setParam(l.addr, fromNorm(d, n), { noUndo: true });
    }
  }
}
