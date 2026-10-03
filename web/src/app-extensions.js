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
import { installBrowser } from './app-browser.js';
import { installAudioRecording } from './app/audio-rec.js';
import { createHistory } from './ui/history-window.js';
import { createLoudnessWindow } from './ui/loudness-window.js';
import { openExportDialog } from './ui/export-dialog.js';
import { openStartDialog } from './ui/start-dialog.js';
import { patcherEditor } from './ui/patcher.js';
import { openAudioEditor } from './ui/audio-editor.js';
import { createStore } from './ui/plugin-store.js';
import { openMidiSettings } from './ui/midi-settings.js';
import { confirmBox } from './ui/dialog.js';
import { samplerEditor, fpcEditor, slicerEditor, drumsEditor, synthEditor, fmEditor, organEditor, wavetableEditor, controllerEditor, midiOutEditor, multiEditor } from './ui/instrument-editors.js';

export function installExtensions(app) {
  // ---- dedicated instrument editors (types without an entry fall back to the generic parameter editor)
  app.editors = Object.assign(app.editors || {}, { sampler: samplerEditor, fpc: fpcEditor, slicer: slicerEditor, drums: drumsEditor, subsynth: synthEditor, fm: fmEditor, organ: organEditor, wavetable: wavetableEditor, controller: controllerEditor, patcher: patcherEditor, midiout: midiOutEditor, multi: multiEditor });
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
  app.keyHooks.add((e) => {
    if (e.key === 'Escape' && app.midi.learn) return app.midi.cancelLearn();
    if (e.key === 'Escape' && app.midi.transportLearn) { app.midi.transportLearn = null; app.toast('Learn cancelled'); return true; }
    return false;
  });
  const prevTools = app.toolsMenuExtra;
  app.toolsMenuExtra = () => [...(prevTools ? prevTools() : []), { sep: true },
    { label: 'Plugin store…', fn: () => app.openStore() },
    { label: 'Audio editor', fn: () => app.openAudioEditor() },
    { label: 'Edit an audio file…', fn: () => app.editAudioFile() },
    { label: 'MIDI settings…', fn: () => app.midiSettings() },
    { label: 'Link hovered knob to MIDI controller', key: 'Ctrl+L', fn: () => app.linkHovered() }];
  app.midiSettings = () => openMidiSettings(app);
  app.store.bus.on('plugins', () => app.midi.startScripts());

  installBrowser(app);
  installAudioRecording(app);

  // ---- plugin store (downloadable plugin packs) and projects that need packs which are not installed
  app.wm.register('store', { title: 'Plugin store', create: createStore, rect: { x: 220, y: 70, w: 760, h: 560 }, minW: 460, minH: 260 });
  app.openStore = () => app.openWindow('store');
  app.store.bus.on('missing-plugins', async (list) => {
    const lines = list.map((m) => `${m.pack === 'unknown' ? 'unknown pack' : m.pack}: ${m.types.join(', ')}`).join('\n');
    if (await confirmBox('Plugins are missing', `This project uses plugins that are not installed, so they were left out:\n${lines}\n\nInstall the pack, then open the project again. Saving this project now would lose those plugins for good.`, 'Open the Plugin store')) app.openStore();
  });

  // ---- audio editor: opens on a sample of the project, an audio file from disk, or empty (record into it)
  app.openAudioEditor = (opts = {}) => openAudioEditor(app, opts);
  app.editAudioFile = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff,.m4a'; inp.style.display = 'none';
    inp.addEventListener('change', async () => {
      const f = inp.files[0];
      if (f) {
        try {
          const buf = await app.host.ctx.decodeAudioData(await f.arrayBuffer());
          const channels = []; for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c).slice());
          app.openAudioEditor({ buf: { rate: buf.sampleRate, channels }, name: f.name.replace(/\.[^.]+$/, '') });
        } catch (err) { app.toast(`Could not decode ${f.name}`); }
      }
      inp.remove();
    });
    document.body.append(inp); inp.click();
  };

  // ---- export, history, start dialog
  app.wm.register('history', { title: 'Undo history', create: createHistory, rect: { x: 1060, y: 120, w: 280, h: 360 }, minW: 200, minH: 140 });
  app.wm.register('loudness', { title: 'Loudness meter', create: createLoudnessWindow, rect: { x: 640, y: 70, w: 560, h: 440 }, minW: 440, minH: 330 });
  const prevView = app.viewMenuExtra;
  app.viewMenuExtra = () => [...(prevView ? prevView() : []), { label: 'Loudness meter (LUFS)', checked: app.wm.isOpen('loudness'), fn: () => app.toggleWindow('loudness') }];
  app.exportMenu = () => [
    { label: 'Export…', key: 'Ctrl+R', fn: () => openExportDialog(app) },
    { label: 'Quick export', submenu: [
      { label: 'WAV 16-bit', fn: () => app.exportWav(16) }, { label: 'WAV 24-bit', fn: () => app.exportWav(24) }, { label: 'WAV 32-bit float', fn: () => app.exportWav(32) },
    ] },
  ];
  app.openExportDialog = () => openExportDialog(app);
  app.openStartDialog = () => openStartDialog(app);
  app.keyHooks.add((e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r' && !e.altKey) { openExportDialog(app); return true; } return false; });

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
