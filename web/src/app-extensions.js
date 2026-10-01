// Hook point where feature modules attach themselves to the app object, keeping app.js a thin wiring file.
import { createMixer } from './ui/mixer.js';
import { openFxEditor, fxPresetItems } from './ui/fx-window.js';
import { createPianoRoll } from './ui/piano-roll.js';
import { createPlaylist } from './ui/playlist.js';
import { openAutomationEditor } from './ui/automation-editor.js';
import { pickParam } from './ui/param-picker.js';
import { paramMenuItems, linkHovered } from './ui/linking.js';
import { MidiHub } from './host/midi.js';
import { formDialog } from './ui/forms.js';
import { samplerEditor, fpcEditor, slicerEditor, drumsEditor, synthEditor, fmEditor, organEditor, wavetableEditor, controllerEditor } from './ui/instrument-editors.js';

export function installExtensions(app) {
  // ---- dedicated instrument editors (types without an entry fall back to the generic parameter editor)
  app.editors = Object.assign(app.editors || {}, { sampler: samplerEditor, fpc: fpcEditor, slicer: slicerEditor, drums: drumsEditor, subsynth: synthEditor, fm: fmEditor, organ: organEditor, wavetable: wavetableEditor, controller: controllerEditor });
  app.store.bus.on('replaced', () => app.wm.closeDynamic());

  // ---- automation, controllers, MIDI
  app.midi = new MidiHub(app);
  app.midi.init().then((ok) => { if (ok) app.store.bus.emit('midi-devices', app.midi.inputs); });
  app.openAutomationEditor = (id) => openAutomationEditor(app, id);
  app.paramMenuItems = (addr) => paramMenuItems(app, addr);
  app.linkHovered = () => linkHovered(app);
  app.addAutomationChannel = async () => {
    const addr = await pickParam(app, { title: 'Automate which parameter?' });
    if (!addr) return;
    const made = app.cmd.createAutomationClip(app.store, addr, { start: app.playlist ? app.playlist.cursorT : 0 });
    if (made) app.openAutomationEditor(made.channel.id);
  };
  app.addControllerChannel = (mode) => { const c = app.cmd.addController(app.store, mode); app.openChannelEditor(c.id); };
  app.store.bus.on('midi-learn', (l) => document.body.classList.toggle('midi-learn', !!l));
  app.keyHooks.add((e) => { if (e.key === 'Escape' && app.midi.learn) return app.midi.cancelLearn(); return false; });
  const prevTools = app.toolsMenuExtra;
  app.toolsMenuExtra = () => [...(prevTools ? prevTools() : []), { sep: true },
    { label: 'MIDI input devices…', fn: () => app.midiSettings() },
    { label: 'Link hovered knob to MIDI controller', key: 'Ctrl+L', fn: () => app.linkHovered() }];
  app.midiSettings = async () => {
    const m = app.midi;
    if (!m.supported) { app.toast('Web MIDI is not available in this browser'); return; }
    const list = m.inputs;
    if (!list.length) { app.toast('No MIDI input devices found. Connect one and try again'); return; }
    const v = await formDialog('MIDI input devices', list.map((d, i) => ({ id: `d${i}`, label: d.name, type: 'check', value: d.on })), { ok: 'Apply', width: 420 });
    if (v) list.forEach((d, i) => m.setDeviceEnabled(d.name, !!v[`d${i}`]));
  };

  // ---- playlist
  app.wm.register('playlist', { title: 'Playlist', create: createPlaylist, rect: { x: 90, y: 50, w: 1060, h: 540 }, minW: 560, minH: 280 });
  app.addAudioClipChannel = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff,.m4a'; inp.style.display = 'none';
    inp.addEventListener('change', async () => {
      const f = inp.files[0];
      if (f) {
        try { const e = await app.bank.decode(f.name, await f.arrayBuffer()); app.cmd.addAudioChannel(app.store, { id: e.id, name: e.name }); app.toast(`Added audio clip source "${e.name}". Draw it in the Playlist`); }
        catch (err) { app.toast(`Could not decode ${f.name}`); }
      }
      inp.remove();
    });
    document.body.append(inp); inp.click();
  };

  // ---- piano roll
  app.wm.register('pianoroll', { title: 'Piano roll', create: createPianoRoll, rect: { x: 150, y: 80, w: 960, h: 540 }, minW: 520, minH: 320 });
  app.optionsMenuExtra = () => [
    { sep: true },
    { label: 'Typing keyboard to piano keyboard', checked: !!app.typingPiano, fn: () => { app.typingPiano = !app.typingPiano; if (app.pianoRoll) app.pianoRoll.refreshBtns(); } },
    { sep: true },
  ];

  // ---- mixer + effects
  app.wm.register('mixer', { title: 'Mixer', create: createMixer, rect: { x: 10, y: 360, w: 1180, h: 400 }, minW: 520, minH: 260 });
  app.openFxEditor = (track, slot) => openFxEditor(app, track, slot);
  app.fxPresetItems = (track, slot) => fxPresetItems(app, track, slot);
  app.mixerRewatch = () => {
    const w = app.wm.get('mixer');
    if (w && w.open && w.comp.watchSelected) w.comp.watchSelected(); else app.host.watch(null);
  };
}
