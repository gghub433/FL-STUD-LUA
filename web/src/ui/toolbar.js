// Main toolbar: draggable sections (order persisted).
import { h, drag, clamp } from './h.js';
import { icon } from './icons.js';
import { Knob } from './knob.js';
import { showPopup } from './menu.js';
import { patternLength } from '../core/project.js';
import { format, parseValue } from '../core/schema.js';
import { TRANSPORT_BUILTIN } from '../core/addr.js';

const LS_ORDER = 'stepwise.toolbar.order.v1';
const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

export class Toolbar {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.timeSwap = localStorage.getItem('stepwise.timeSwap') === '1';
    this.scopeMode = 'scope';
    this.sections = new Map();
    const defs = [
      ['transport', () => this.transportSection()],
      ['time', () => this.timeSection()],
      ['tempo', () => this.tempoSection()],
      ['options', () => this.optionsSection()],
      ['master', () => this.masterSection()],
      ['pattern', () => this.patternSection()],
      ['windows', () => this.windowsSection()],
      ['monitor', () => this.monitorSection()],
    ];
    let order = defs.map((d) => d[0]);
    try {
      const saved = JSON.parse(localStorage.getItem(LS_ORDER) || 'null');
      if (Array.isArray(saved)) order = [...saved.filter((x) => order.includes(x)), ...order.filter((x) => !saved.includes(x))];
    } catch (_) { /* default order */ }
    const map = new Map(defs);
    for (const id of order) { const s = this.wrap(id, map.get(id)()); this.sections.set(id, s); el.append(s); }
    app.store.bus.on('transport', () => this.refreshButtons());
    app.store.bus.on('window', () => this.refreshButtons());
    app.store.bus.on('project', () => { this.refreshPattern(); this.refreshButtons(); });
    app.store.bus.on('change', ({ paths }) => { if (paths.some((p) => p[0] === 'patterns' || p[0] === 'currentPattern' || p[0] === 'settings')) { this.refreshPattern(); this.refreshButtons(); } });
    app.store.bus.on('param', (addr, v) => { if (addr === 'transport:tempo') this.drawTempo(v); });
    this.refreshButtons();
    this.refreshPattern();
    this.drawTempo(app.store.project.tempo);
    const loop = () => { this.tick(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // ---- section chrome + drag reorder
  wrap(id, content) {
    const grip = h('div.tb-grip', { hint: 'Drag to rearrange toolbar sections' });
    const sec = h('div.tb-section', { dataset: { section: id } }, grip, content);
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      let target = null, before = true;
      drag(e, (dx, dy, ev) => {
        for (const s of this.el.children) s.classList.remove('drop-before', 'drop-after');
        target = null;
        for (const s of this.el.children) {
          if (s === sec) continue;
          const r = s.getBoundingClientRect();
          if (ev.clientY >= r.top - 4 && ev.clientY <= r.bottom + 4 && ev.clientX >= r.left && ev.clientX <= r.right) {
            target = s; before = ev.clientX < r.left + r.width / 2;
            s.classList.add(before ? 'drop-before' : 'drop-after');
            break;
          }
        }
      }, () => {
        for (const s of this.el.children) s.classList.remove('drop-before', 'drop-after');
        if (target) {
          if (before) this.el.insertBefore(sec, target); else target.after(sec);
          try { localStorage.setItem(LS_ORDER, JSON.stringify([...this.el.children].map((s) => s.dataset.section))); } catch (_) { /* ignore */ }
        }
      });
    });
    return sec;
  }

  get store() { return this.app.store; }

  // ---- sections
  transportSection() {
    const t = this.app.transport;
    this.bPlay = h('div.btn.big', { hint: 'Play / Stop — Space. Starts from the song or pattern start (or the start marker)', onclick: () => t.toggle() }, icon('play', 18));
    this.bStop = h('div.btn.big', { hint: 'Stop — returns to the start position', onclick: () => t.stop() }, icon('stop', 18));
    this.bRec = h('div.btn.big.rec', { hint: 'Record — captures notes you play (keyboard/MIDI) into the current pattern', onclick: () => t.record() }, icon('record', 18));
    this.bPause = h('div.btn.big', { hint: 'Pause — Ctrl+Space. Click again to continue', onclick: () => t.togglePause() }, icon('pause', 18));
    this.bPat = h('div.btn', { hint: 'PAT mode — loops the current pattern (L toggles PAT/SONG)', onclick: () => t.setMode('pat') }, 'PAT');
    this.bSong = h('div.btn', { hint: 'SONG mode — plays the Playlist arrangement (L toggles PAT/SONG)', onclick: () => t.setMode('song') }, 'SONG');
    return h('div.tb-col', h('div.tb-row', this.bPlay, this.bStop, this.bRec, this.bPause), h('div.tb-row', h('div.seg', this.bPat, this.bSong)));
  }

  timeSection() {
    this.timeBig = h('span', '001:01:00');
    this.timeSmall = h('span', '0:00:00.00');
    this.timeEl = h('div.lcd.time', {
      hint: 'Song position — click to swap bars:beats:ticks and hours:minutes:seconds. Click the ruler in the Playlist to set it',
      onclick: () => { this.timeSwap = !this.timeSwap; localStorage.setItem('stepwise.timeSwap', this.timeSwap ? '1' : '0'); this.tick(true); },
    }, this.timeBig, h('small', this.timeSmall));
    this.timeLabel = h('div.tb-label', 'BAR:BEAT:TICK');
    return h('div.tb-col', this.timeEl, this.timeLabel);
  }

  tempoSection() {
    this.tempoEl = h('div.lcd.bpm', { hint: 'Tempo — drag up/down (Shift = decimals), mouse wheel, double-click to type, right-click resets to 130' });
    let editing = false;
    this.tempoEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || editing) return;
      const start = this.store.project.tempo;
      drag(e, (dx, dy, ev) => {
        const step = ev.shiftKey || ev.ctrlKey ? 0.01 : 0.25;
        this.store.setParam('transport:tempo', Math.round((start - dy * step) * 1000) / 1000, { coalesce: 'tempo-drag' });
      });
    });
    this.tempoEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.store.setParam('transport:tempo', this.store.project.tempo + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.1 : 1), { coalesce: 'tempo-wheel' });
    }, { passive: false });
    this.tempoEl.addEventListener('contextmenu', (e) => { e.preventDefault(); this.store.setParam('transport:tempo', 130); });
    this.tempoEl.addEventListener('dblclick', () => {
      editing = true;
      const inp = h('input', { type: 'text', value: String(this.store.project.tempo) });
      this.tempoEl.textContent = ''; this.tempoEl.append(inp);
      inp.focus(); inp.select();
      const done = (ok) => {
        if (!editing) return;
        editing = false;
        if (ok) { const v = parseValue(TRANSPORT_BUILTIN[0], inp.value); if (v !== null) this.store.setParam('transport:tempo', v); }
        this.drawTempo(this.store.project.tempo);
      };
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
      inp.addEventListener('blur', () => done(true));
    });
    this.bTap = h('div.btn', { hint: 'Tap tempo — Alt+T. Tap in time to set the BPM', onclick: () => this.app.transport.tapTempo() }, icon('tap', 14), 'TAP');
    return h('div.tb-col', h('div.tb-row', this.tempoEl, this.bTap), h('div.tb-label', 'BPM'));
  }

  drawTempo(v) {
    if (this.tempoEl.querySelector('input')) return;
    this.tempoEl.textContent = v.toFixed(2);
  }

  optionsSection() {
    const t = this.app.transport;
    const mk = (key, ic, hint) => h('div.btn', { hint, onclick: () => t.toggleSetting(key), dataset: { opt: key } }, icon(ic, 15));
    this.optBtns = {
      metronome: mk('metronome', 'metro', 'Metronome — click on every beat while playing, accent on the first beat of the bar'),
      countIn: mk('countIn', 'countin', 'Count-in — one bar of metronome clicks before recording starts'),
      overdub: mk('overdub', 'overdub', 'Overdub — keep notes already in the pattern when recording (off: the recorded channel is cleared on its first new note)'),
      blend: mk('blend', 'blend', 'Blend recorded notes — new notes replace same-key notes they overlap instead of stacking on top'),
    };
    return h('div.tb-col', h('div.tb-row', this.optBtns.metronome, this.optBtns.countIn, this.optBtns.overdub, this.optBtns.blend), h('div.tb-label', 'MET · CNT · OVR · BLD'));
  }

  masterSection() {
    this.kVol = new Knob(this.app, { addr: 'master:vol', size: 'lg', title: 'Master volume' });
    this.kPitch = new Knob(this.app, { addr: 'master:pitch', size: '', title: 'Master pitch (semitones)' });
    return h('div.tb-row', h('div.tb-col', this.kVol.el, h('div.tb-label', 'VOL')), h('div.tb-col', this.kPitch.el, h('div.tb-label', 'PITCH')));
  }

  patternSection() {
    this.patEl = h('div.lcd.input', { style: { cursor: 'pointer', minWidth: '150px', height: '26px', justifyContent: 'flex-start', gap: '6px', color: 'var(--text)', fontFamily: 'inherit' },
      hint: 'Pattern selector — click for the list, wheel changes pattern, Ctrl+↑↓ steps through them',
      onclick: (e) => this.patternMenu(e),
      onwheel: (e) => { e.preventDefault(); this.app.selectPatternRel(e.deltaY < 0 ? 1 : -1); } });
    this.patEl.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    const prev = h('div.btn.sm', { hint: 'Previous pattern', onclick: () => this.app.selectPatternRel(-1) }, '◀');
    const next = h('div.btn.sm', { hint: 'Next pattern', onclick: () => this.app.selectPatternRel(1) }, '▶');
    const add = h('div.btn.sm', { hint: 'New pattern', onclick: () => this.app.cmd.newPattern(this.store) }, '+');
    return h('div.tb-col', h('div.tb-row', prev, this.patEl, next, add), h('div.tb-label', 'PATTERN'));
  }

  refreshPattern() {
    const p = this.store.project, pat = this.store.pattern;
    if (!pat) return;
    this.patEl.textContent = '';
    const color = pat.color || '#8aa0b4';
    this.patEl.append(h('span', { style: { width: '8px', height: '14px', background: color, borderRadius: '2px', flex: 'none' } }), h('span', { style: { color: 'var(--accent)', fontFamily: 'var(--mono)' } }, String(pat.id).padStart(2, '0')), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, pat.name));
  }

  patternMenu(e) {
    const p = this.store.project;
    const r = this.patEl.getBoundingClientRect();
    const ids = Object.keys(p.patterns).map(Number).sort((a, b) => a - b);
    const items = ids.map((id) => ({ label: `${String(id).padStart(2, '0')}  ${p.patterns[id].name}`, checked: id === p.currentPattern, fn: () => this.app.cmd.selectPattern(this.store, id) }));
    items.push({ sep: true }, { label: 'New pattern', fn: () => this.app.cmd.newPattern(this.store) },
      { label: 'Clone current pattern', fn: () => this.app.cmd.clonePattern(this.store, p.currentPattern) },
      { label: 'Rename…', fn: () => this.app.renamePatternDialog(p.currentPattern) },
      { label: 'Delete current pattern', fn: () => this.app.cmd.deletePattern(this.store, p.currentPattern) });
    showPopup(items, r.left, r.bottom + 1, r);
  }

  windowsSection() {
    const wm = this.app.wm;
    this.winBtns = {};
    const mk = (id, ic, hint) => {
      const b = h('div.btn', { hint, onclick: () => this.app.toggleWindow(id), dataset: { win: id } }, icon(ic, 16));
      this.winBtns[id] = b;
      return b;
    };
    const row = h('div.tb-row',
      mk('playlist', 'playlist', 'Playlist — F5. Arrange pattern, audio and automation clips'),
      mk('pianoroll', 'pianoroll', 'Piano roll — F7. Edit notes of the selected channel'),
      mk('rack', 'rack', 'Channel rack — F6. Instruments and the step sequencer'),
      mk('mixer', 'mixer', 'Mixer — F9. Inserts, effects and routing'),
      mk('browser', 'browser', 'Browser — F8. Samples, presets and projects'),
      mk('picker', 'picker', 'Plugin picker — Alt+F8. Add instruments and effects'));
    return h('div.tb-col', row, h('div.tb-label', 'WINDOWS'));
  }

  monitorSection() {
    this.scope = h('canvas.scope', { width: 224, height: 68, hint: 'Oscilloscope — click to switch to the spectrum analyser', onclick: () => { this.scopeMode = this.scopeMode === 'scope' ? 'spectrum' : 'scope'; } });
    this.cpuBar = h('i');
    this.cpuTxt = h('span', { style: { fontSize: '9px', color: 'var(--dim)' } }, 'CPU 0%');
    this.cpu = h('div.cpu', { hint: 'Audio engine load' }, this.cpuBar);
    this.lufs = h('span.tb-lufs', { hint: 'Short-term loudness of the master (LUFS) — click for the loudness meter', onclick: () => this.app.toggleWindow('loudness') }, '−∞ LUFS');
    this.time = new Float32Array(2048);
    this.freq = new Uint8Array(1024);
    this.sctx = this.scope.getContext('2d');
    this.scope.style.width = '112px'; this.scope.style.height = '34px';
    return h('div.tb-row', this.scope, h('div.tb-col', this.cpu, this.cpuTxt, this.lufs));
  }

  // ---- updates
  refreshButtons() {
    const st = this.app.host.st, t = this.app.transport, s = this.store.project.settings;
    this.bPlay.classList.toggle('on', st.playing && !st.recording);
    this.bRec.classList.toggle('on', st.recording);
    this.bPause.classList.toggle('on', st.paused);
    this.bPat.classList.toggle('on', t.mode === 'pat');
    this.bSong.classList.toggle('on', t.mode === 'song');
    for (const k in this.optBtns) this.optBtns[k].classList.toggle('on', !!s[k]);
    for (const id in this.winBtns) this.winBtns[id].classList.toggle('on', id === 'browser' ? this.app.browserVisible() : this.app.wm.isOpen(id));
  }

  tick(force) {
    const app = this.app, st = app.host.st;
    if (this.lastPlaying !== st.playing || this.lastRec !== st.recording || this.lastPaused !== st.paused) {
      this.lastPlaying = st.playing; this.lastRec = st.recording; this.lastPaused = st.paused;
      this.refreshButtons();
    }
    const tick = app.transport.displayTick();
    const sec = (Math.max(0, tick) * 60) / (this.store.project.tempo * 96);
    if (force || tick !== this.lastTick) {
      this.lastTick = tick;
      const tm = app.transport.timeMap();
      const b = tm.bbt(tick);
      const bbt = `${pad(b.bar, 3)}:${pad(b.beat)}:${pad(b.tick)}`;
      const h_ = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      const hms = `${h_}:${pad(m)}:${pad(Math.floor(s))}.${pad((s % 1) * 100)}`;
      const big = this.timeSwap ? hms : bbt, small = this.timeSwap ? bbt : hms;
      if (this.timeBig.textContent !== big) this.timeBig.textContent = big;
      if (this.timeSmall.textContent !== small) this.timeSmall.textContent = small;
      this.timeLabel.textContent = this.timeSwap ? 'H:MM:SS.CS' : 'BAR:BEAT:TICK';
      this.timeEl.style.fontSize = this.timeSwap ? '17px' : '';
    }
    const cpu = clamp(st.cpu || 0, 0, 1);
    this.cpuBar.style.width = `${cpu * 100}%`;
    const txt = `CPU ${Math.round(cpu * 100)}%`;
    if (this.cpuTxt.textContent !== txt) this.cpuTxt.textContent = txt;
    const s = app.host.loud[1], tp = app.host.loud[4];
    const lt = `${Number.isFinite(s) && s > -70 ? s.toFixed(1).replace('-', '−') : '−∞'} LUFS`;
    if (this.lufs.textContent !== lt) this.lufs.textContent = lt;
    this.lufs.classList.toggle('hot', tp > -0.1);
    this.drawScope();
  }

  drawScope() {
    const a = this.app.host.analyser, c = this.sctx;
    if (!a || !c) return;
    const W = this.scope.width, H = this.scope.height;
    c.fillStyle = '#0e1012'; c.fillRect(0, 0, W, H);
    c.strokeStyle = '#1d2226'; c.lineWidth = 1; c.beginPath(); c.moveTo(0, H / 2); c.lineTo(W, H / 2); c.stroke();
    if (this.scopeMode === 'scope') {
      a.getFloatTimeDomainData(this.time);
      c.strokeStyle = '#ffb02e'; c.lineWidth = 1.6; c.beginPath();
      // trigger on a rising zero crossing so the picture holds still
      let s = 0;
      for (let i = 1; i < 1024; i++) if (this.time[i - 1] < 0 && this.time[i] >= 0) { s = i; break; }
      for (let x = 0; x < W; x++) {
        const v = this.time[s + Math.floor((x / W) * 900)] || 0;
        const y = H / 2 - clamp(v, -1, 1) * (H / 2 - 2);
        if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
    } else {
      a.getByteFrequencyData(this.freq);
      const bins = 160;
      c.fillStyle = '#ffb02e';
      for (let x = 0; x < W; x += 2) {
        const f = Math.pow(x / W, 2.2) * bins + 1;
        const v = this.freq[Math.floor(f)] / 255;
        c.fillRect(x, H - v * (H - 2), 1.6, v * (H - 2));
      }
    }
  }
}
