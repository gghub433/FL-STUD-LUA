// Keyboard shortcuts as commands: every app-wide action has an id, a label and default keys; the person can change the
// keys (HELP > Keyboard shortcuts) and the changes are kept on this computer. Editors (piano roll, playlist, patcher,
// audio editor) still get the first look at a key while they are focused, as before.
const KEY = 'fllua.keys';

const desk = () => typeof window !== 'undefined' && !!window.flluaDesktop;

// keys: combos like 'Ctrl+Shift+S', 'Space', 'F5', 'Alt+T' (Ctrl also means Cmd on a Mac)
export function commands(app) {
  const t = () => app.transport, w = (id) => () => app.toggleWindow(id);
  const list = [
    ['transport.toggle', 'Play / Stop', ['Space'], () => t().toggle()],
    ['transport.pause', 'Pause / continue', ['Ctrl+Space'], () => t().togglePause()],
    ['transport.record', 'Record', [], () => (app.host.st.recording ? t().stop() : t().record())],
    ['transport.mode', 'Pattern / Song mode', ['L'], () => t().toggleMode(), { noRepeat: true }],
    ['transport.tap', 'Tap tempo', ['Alt+T'], () => t().tapTempo()],
    ['transport.metronome', 'Metronome on / off', ['Ctrl+M'], () => t().toggleSetting('metronome')],
    ['transport.panic', 'Panic: all notes off', [], () => app.host.send({ t: 'panic' })],
    ['window.playlist', 'Playlist', ['F5'], w('playlist')],
    ['window.rack', 'Channel rack', ['F6'], w('rack')],
    ['window.pianoroll', 'Piano roll', ['F7'], w('pianoroll')],
    ['window.browser', 'Browser', ['F8'], w('browser')],
    ['window.mixer', 'Mixer', ['F9'], w('mixer')],
    ['window.picker', 'Plugin picker', ['Alt+F8'], w('picker')],
    ['window.loudness', 'Loudness meter', [], w('loudness')],
    ['window.history', 'Undo history', [], w('history')],
    ['edit.undo', 'Undo', ['Ctrl+Z'], () => app.store.undo()],
    ['edit.redo', 'Redo', ['Ctrl+Y', 'Ctrl+Alt+Z', 'Ctrl+Shift+Z'], () => app.store.redo()],
    ['file.new', 'New project', ['Ctrl+N'], () => app.newProject()],
    ['file.open', 'Open…', ['Ctrl+O'], () => app.files.open()],
    ['file.save', 'Save', ['Ctrl+S'], () => app.files.save()],
    ['file.saveAs', 'Save as…', ['Ctrl+Shift+S'], () => app.files.saveAs()],
    ['file.export', 'Export…', ['Ctrl+R'], () => app.openExportDialog()],
    ['file.importMidi', 'Import MIDI file…', [], () => app.files.importMidi()],
    ['pattern.next', 'Next pattern', ['Ctrl+ArrowUp'], () => app.selectPatternRel(1)],
    ['pattern.prev', 'Previous pattern', ['Ctrl+ArrowDown'], () => app.selectPatternRel(-1)],
    ['pattern.new', 'New pattern', [], () => app.cmd.newPattern(app.store)],
    ['midi.link', 'Link hovered knob to MIDI controller', ['Ctrl+L'], () => app.linkHovered && app.linkHovered()],
    ['options.audio', 'Audio settings…', [], () => app.audioSettings()],
    ['options.midi', 'MIDI settings…', [], () => app.midiSettings && app.midiSettings()],
    ['view.zoomIn', 'Interface bigger', desk() ? ['Ctrl+='] : [], () => app.zoomStep && app.zoomStep(1)],
    ['view.zoomOut', 'Interface smaller', desk() ? ['Ctrl+-'] : [], () => app.zoomStep && app.zoomStep(-1)],
    ['view.zoomReset', 'Interface at 100 %', desk() ? ['Ctrl+0'] : [], () => app.setPref && app.setPref('scale', 1)],
    ['help.shortcuts', 'Keyboard shortcuts', ['F1'], () => app.shortcutsDialog()],
    ['help.tour', 'Take the tour', [], () => app.startTour && app.startTour()],
  ];
  return list.map(([id, label, keys, run, o]) => ({ id, label, defaults: keys, run, ...(o || {}) }));
}

const KEYNAMES = { ' ': 'Space', Spacebar: 'Space', '+': '=', Esc: 'Escape', Del: 'Delete' };
// the combo of a keyboard event, e.g. 'Ctrl+Shift+S'
export function comboOf(e) {
  let k = KEYNAMES[e.key] || e.key;
  if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return '';
  if (k.length === 1) k = k.toUpperCase();
  if (/^Digit\d$/.test(e.code) && e.shiftKey) k = e.code.slice(5);   // Shift+1 is '!' on the keyboard: use the key itself
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', k].filter(Boolean).join('+');
}

export class Keymap {
  constructor(app) {
    this.app = app;
    this.cmds = commands(app);
    this.byId = new Map(this.cmds.map((c) => [c.id, c]));
    this.custom = {};
    try { this.custom = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { /* private mode */ }
    this.rebuild();
  }
  keysOf(id) { return this.custom[id] || this.byId.get(id).defaults; }
  rebuild() {
    this.map = new Map();
    for (const c of this.cmds) for (const k of this.keysOf(c.id)) if (k) this.map.set(k, c);
  }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.custom)); } catch (_) { /* private mode */ } }
  // gives `combo` to command `id` (taking it from whoever had it); returns the command that lost it, if any
  assign(id, combo) {
    const prev = this.map.get(combo);
    if (prev && prev.id !== id) this.custom[prev.id] = this.keysOf(prev.id).filter((k) => k !== combo);
    this.custom[id] = [combo];
    this.save(); this.rebuild();
    return prev && prev.id !== id ? prev : null;
  }
  clear(id) { this.custom[id] = []; this.save(); this.rebuild(); }
  reset(id) { if (id) delete this.custom[id]; else this.custom = {}; this.save(); this.rebuild(); }
  // runs the command bound to the event's combo; true when one ran
  handle(e) {
    const c = this.map.get(comboOf(e));
    if (!c || (c.noRepeat && e.repeat)) return false;
    e.preventDefault();
    c.run();
    return true;
  }
}
