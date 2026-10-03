// UI-side transport: play/stop/record commands, PAT/SONG mode, tap tempo, recording of played notes.
import { PPQ, STEP } from '../core/constants.js';
import { patternLength, createNote } from '../core/project.js';
import { TimeMap } from '../core/timemap.js';

export class Transport {
  constructor(app) {
    this.app = app;
    this.mode = 'pat';
    this.taps = [];
    this.pending = new Map();      // `${ch}:${key}` -> { tick, vel }
    this.clearedChannels = new Set();
    app.host.bus.on('rec', (m) => this.onRec(m));
    app.host.bus.on('ended', () => app.store.bus.emit('transport'));
    app.host.bus.on('state', () => {});
  }

  get host() { return this.app.host; }
  get store() { return this.app.store; }
  get playing() { return this.host.st.playing; }

  startTick() {
    if (this.mode !== 'song') return undefined;
    const a = this.store.arrangement;
    return a.start != null ? a.start : a.loop ? a.loop.s : undefined;
  }

  play(from) {
    this.host.resume();
    this.host.send({ t: 'play', mode: this.mode, from });
    this.store.bus.emit('transport');
  }

  stop() {
    this.finishRecording();
    if (this.app.autoRec) this.app.autoRec.finish();
    if (this.app.audioRec && this.app.audioRec.recording) this.app.audioRec.end();
    this.host.send({ t: 'stop' });
    this.store.bus.emit('transport');
  }

  pause() {
    this.host.send({ t: 'pause' });
    this.store.bus.emit('transport');
  }

  toggle() { if (this.playing) this.stop(); else this.play(); }

  // FL-style: Pause button toggles between pause and continue
  togglePause() {
    if (this.playing) this.pause();
    else if (this.host.st.paused) this.play();
  }

  record() {
    this.host.resume();
    // an armed mixer track also records the audio input; the take lands in the playlist where recording started
    const s = this.store.project.settings;
    if (this.app.audioRec && s.recAudio !== 0) { const from = this.startTick(); this.app.audioRec.begin(this.mode === 'song' ? (from ?? 0) : 0); }
    this.clearedChannels.clear();
    this.pending.clear();
    this.host.send({ t: 'record', mode: this.mode, from: undefined, countIn: s.countIn ? 1 : 0 });
    this.store.bus.emit('transport');
  }

  // Performance mode: launch / stop playlist clips live (quant = ticks to wait for the next boundary)
  perfLaunch(clipId, quant = 0) { this.host.resume(); this.host.send({ t: 'perf', op: 'launch', clip: clipId, quant }); this.store.bus.emit('transport'); }
  perfStop(track, quant = 0) { this.host.send({ t: 'perf', op: 'stop', track, quant }); }
  perfStopAll(quant = 0) { this.host.send({ t: 'perf', op: 'stopAll', quant }); }

  seek(tick) { this.host.send({ t: 'seek', tick: Math.max(0, Math.round(tick)) }); }

  setMode(mode) {
    if (this.mode === mode) return;
    const was = this.playing;
    this.mode = mode;
    if (was) this.play();
    this.store.bus.emit('transport');
  }

  toggleMode() { this.setMode(this.mode === 'pat' ? 'song' : 'pat'); }

  toggleSetting(key) {
    const p = this.store.project;
    this.store.edit(`Toggle ${key}`, () => { p.settings[key] = p.settings[key] ? 0 : 1; }, [['settings']], { noUndo: true });
    this.store.bus.emit('transport');
  }

  tapTempo() {
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2200) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 8) this.taps.shift();
    if (this.taps.length >= 2) {
      const gaps = [];
      for (let i = 1; i < this.taps.length; i++) gaps.push(this.taps[i] - this.taps[i - 1]);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      this.store.setParam('transport:tempo', Math.round((60000 / avg) * 100) / 100, { coalesce: 'tap' });
    }
  }

  // loop bounds used to wrap the drawn playhead
  loopBounds() {
    const p = this.store.project;
    if (this.host.st.mode === 'perf' && this.playing) return [0, Infinity];
    if (this.mode === 'song') {
      const a = this.store.arrangement;
      return a.loop ? [a.loop.s, a.loop.e] : [0, Infinity];
    }
    return [0, patternLength(p, this.store.pattern)];
  }

  displayTick() {
    const [s, e] = this.loopBounds();
    return this.host.displayTick(s, e);
  }

  timeMap() { return new TimeMap(this.store.project.timeSig, this.store.arrangement.markers); }

  // ----- recording of live notes into the current pattern
  onRec(m) {
    const store = this.store, p = store.project;
    if (p.settings.recNotes === 0) return;
    const key = `${m.ch}:${m.key}`;
    if (m.on) { this.pending.set(key, { tick: m.tick, vel: m.vel }); return; }
    const st = this.pending.get(key);
    if (!st) return;
    this.pending.delete(key);
    const pat = store.pattern;
    const len = patternLength(p, pat);
    let s = st.tick;
    let l = Math.max(STEP / 2, m.tick - st.tick);
    if (m.tick < st.tick) l = STEP; // wrapped around the loop while held
    const start = ((Math.round(s) % len) + len) % len;
    store.edit('Record notes', () => {
      const list = pat.notes[m.ch] || (pat.notes[m.ch] = []);
      if (!p.settings.overdub && !this.clearedChannels.has(m.ch)) { this.clearedChannels.add(m.ch); list.length = 0; }
      if (p.settings.blend) {
        for (let i = list.length - 1; i >= 0; i--) if (list[i].k === m.key && list[i].s < start + l && list[i].s + list[i].l > start) list.splice(i, 1);
      }
      list.push(createNote(p, start, Math.round(Math.min(l, len - start)), m.key, Math.max(1, Math.round(st.vel * 127))));
      list.sort((a, b) => a.s - b.s || a.k - b.k);
    }, [['patterns', pat.id]], { coalesce: 'record' });
  }

  finishRecording() {
    // close notes still held when recording stops
    const t = this.host.st.tick;
    for (const [key] of this.pending) {
      const [ch, k] = key.split(':').map(Number);
      this.onRec({ on: 0, ch, key: k, tick: t });
    }
    this.pending.clear();
  }
}

export { PPQ };
