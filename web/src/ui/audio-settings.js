// OPTIONS → Audio settings: output device, sample rate and buffer size (latency). Changing the rate or the
// buffer starts a new audio engine (the project and the samples are sent to it again); the device can switch live.
import { h } from './h.js';
import { modal } from './dialog.js';
import { AudioHost, LATENCIES, RATES, saveAudioSettings } from '../host/audio-host.js';

export async function openAudioSettings(app) {
  const host = app.host;
  const cur = host.info();
  const sel = (opts, value) => { const el = h('select.select', { style: { flex: 1 } }, opts.map(([v, l]) => h('option', { value: String(v) }, l))); el.value = String(value); if (el.selectedIndex < 0) el.selectedIndex = 0; return el; };
  const row = (label, ...els) => h('div.row', { style: { margin: '6px 0', gap: '6px' } }, h('span', { style: { width: '110px', flex: 'none' } }, label), ...els);

  const outSel = h('select.select', { style: { flex: 1 } });
  const fillOutputs = async () => {
    const list = await host.outputs().catch(() => []);
    outSel.textContent = '';
    outSel.append(h('option', { value: '' }, 'System default'), ...list.map((d) => h('option', { value: d.id }, d.label)));
    outSel.value = cur.settings.sinkId || '';
    if (outSel.selectedIndex < 0) outSel.value = '';
    names.style.display = list.length && list.every((d) => /^Output \d+$/.test(d.label)) ? '' : 'none';
  };
  // browsers hide device names until the page may use a microphone; asking once reveals them
  const names = h('div.btn', { hint: 'Device names are hidden until audio input is allowed once', onclick: async () => {
    try { const st = await navigator.mediaDevices.getUserMedia({ audio: true }); st.getTracks().forEach((t) => t.stop()); } catch (_) { /* denied */ }
    await fillOutputs();
  } }, 'Show names');
  const selectable = AudioHost.outputSelectable();
  outSel.disabled = !selectable;
  const rateSel = sel(RATES, cur.settings.sampleRate || 0);
  const latSel = sel(LATENCIES, cur.settings.latency);
  const info = h('div.dim', { style: { fontSize: '11px', lineHeight: 1.5, marginTop: '8px', whiteSpace: 'pre-line' } });
  const showInfo = () => {
    const i = host.info();
    info.textContent = `Running at ${i.sampleRate} Hz · buffer ${(i.baseLatency * 1000).toFixed(1)} ms · output latency ${(i.outputLatency * 1000).toFixed(1)} ms · ${i.state}`
      + (i.warning ? `\n⚠ ${i.warning}` : '')
      + (selectable ? '' : '\nThis browser cannot choose the output device (the desktop app and Chrome/Edge can).');
  };
  const note = h('div.dim', { style: { fontSize: '10px', marginTop: '4px' } }, 'Smaller buffers lower the delay between a key press and the sound but need more CPU headroom; raise the buffer if you hear crackles.');
  const body = h('div', row('Output device', outSel, names), row('Sample rate', rateSel), row('Buffer', latSel), note, info);
  await fillOutputs();
  showInfo();

  return new Promise((resolve) => {
    modal({
      title: 'Audio settings', body, width: 500,
      buttons: [{ label: 'Close', fn: () => resolve(false) }, { label: 'Apply', primary: true, fn: () => {
        const next = { sampleRate: +rateSel.value, latency: /^\d+$/.test(latSel.value) ? +latSel.value : latSel.value, sinkId: outSel.value };
        apply(app, next).then(resolve);
      } }],
      onClose: () => resolve(false),
    });
  });
}

// applies settings: only the device changed → switch live; otherwise restart the engine
export async function apply(app, next) {
  const host = app.host, prev = host.info().settings;
  const restart = (next.sampleRate || 0) !== (prev.sampleRate || 0) || String(next.latency) !== String(prev.latency);
  if (restart && app.audioRec && app.audioRec.recording) { app.toast('Stop recording first'); return false; }
  try {
    if (restart) {
      if (app.transport && host.st.playing) app.transport.stop();
      await host.restart(next);
    } else if (next.sinkId !== (prev.sinkId || '')) await host.setOutput(next.sinkId);
    saveAudioSettings(host.settings);
    const i = host.info();
    app.toast(i.warning || `Audio: ${i.sampleRate} Hz, buffer ${(i.baseLatency * 1000).toFixed(1)} ms`);
    return true;
  } catch (err) {
    app.toast(`Audio settings: ${err.message || err}`);
    return false;
  }
}
