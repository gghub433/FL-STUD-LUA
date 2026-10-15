'use strict';
// Part of `--smoke`: VST3 / CLAP / VST2 (and on macOS Audio Unit) plugins in the real app window with the test plugins (native/out/<platform>/testplugins).
// Runs in the page; returns what it saw. Checked in main.js.
async function pageCheck() {
  const P = app.plugins, out = { available: P.available };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const peakOf = async (track, ms) => { let p = 0; const t0 = performance.now(); while (performance.now() - t0 < ms) { const [l, r] = app.host.peak(track); p = Math.max(p, l, r); await wait(20); } return p; };
  try {
    const cat = await P.scan(true);
    out.found = cat.plugins.map((p) => `${p.name}/${p.format}`).sort();
    const synth = cat.plugins.find((p) => p.name === 'FLLUA Test Synth');
    const clapSynth = cat.plugins.find((p) => p.name === 'FLLUA Test CLAP Synth');
    const clapGain = cat.plugins.find((p) => p.name === 'FLLUA Test CLAP Gain');
    const { emptyProject } = await import('./src/core/demo.js');
    await app.store.replaceProject(emptyProject());
    await app.host.resume();

    // a VST3 instrument on insert 1 with a CLAP effect after it
    const ch = P.addInstrument(synth);
    app.cmd.setMixerTarget(app.store, ch.id, 1);
    P.addEffect(1, 0, clapGain);
    await P.sync();
    const owner = `ch:${ch.id}`;
    out.status = (P.statusOf(owner) || {}).state;
    out.items = P.items.size;
    app.host.send({ t: 'noteOn', ch: ch.id, key: 69, vel: 1 });
    out.peak = await peakOf(1, 700);
    app.host.send({ t: 'noteOff', ch: ch.id, key: 69 });
    await wait(300);
    out.stats = P.stats();

    // automation from FL LUA: gain 0 silences it
    app.store.setParam(`ch:${ch.id}:p:0`, 0);
    app.host.send({ t: 'noteOn', ch: ch.id, key: 72, vel: 1 });
    out.quiet = await peakOf(1, 400);
    app.host.send({ t: 'noteOff', ch: ch.id, key: 72 });
    app.store.setParam(`ch:${ch.id}:p:0`, 0.5);

    // the plugin's window (the test plugin turns Tone to 0.75 when it opens)
    if (navigator.platform.startsWith('Linux') || navigator.platform.startsWith('Win')) {
      out.editor = await P.openEditor(owner);
      for (let i = 0; i < 30 && app.store.channel(ch.id).params['1'] !== 0.75; i++) await wait(50);
      out.tone = app.store.channel(ch.id).params['1'];
      await P.closeEditor(owner);
    }

    // its settings go into the project; the project reopens with them
    await P.capture(true);
    const c = app.store.channel(ch.id);
    out.state = (c.plugin.state || '').length;
    out.params = c.plugin.params.length;
    const bytes = app.files.encode(app.store.project);
    const { normalize } = await import('./src/core/project.js');
    await app.store.replaceProject(normalize(JSON.parse(new TextDecoder().decode(bytes))));
    await P.sync();
    out.reloaded = (P.statusOf(`ch:${ch.id}`) || {}).state;
    const vals = await P.refreshValues(`ch:${ch.id}`);
    out.toneAfterReopen = vals && vals['1'];

    // a CLAP instrument too
    const ch2 = P.addInstrument(clapSynth);
    app.cmd.setMixerTarget(app.store, ch2.id, 2);
    await P.sync();
    app.host.send({ t: 'noteOn', ch: ch2.id, key: 60, vel: 1 });
    out.clapPeak = await peakOf(2, 600);
    app.host.send({ t: 'noteOff', ch: ch2.id, key: 60 });

    // and a VST2 instrument
    const ch3 = P.addInstrument(cat.plugins.find((p) => p.name === 'FLLUA Test VST2 Synth'));
    app.cmd.setMixerTarget(app.store, ch3.id, 3);
    await P.sync();
    out.vst2Status = (P.statusOf(`ch:${ch3.id}`) || {}).state;
    app.host.send({ t: 'noteOn', ch: ch3.id, key: 64, vel: 1 });
    out.vst2Peak = await peakOf(3, 600);
    app.host.send({ t: 'noteOff', ch: ch3.id, key: 64 });

    // macOS: Apple's General MIDI synth as an Audio Unit
    let ch4 = null;
    const dls = cat.plugins.find((p) => p.format === 'au' && p.uid === '61756d75:646c7320:6170706c');
    if (navigator.platform.startsWith('Mac')) {
      out.auFound = !!dls;
      if (dls) {
        ch4 = P.addInstrument(dls);
        app.cmd.setMixerTarget(app.store, ch4.id, 4);
        await P.sync();
        out.auStatus = (P.statusOf(`ch:${ch4.id}`) || {}).state;
        app.host.send({ t: 'noteOn', ch: ch4.id, key: 60, vel: 1 });
        out.auPeak = await peakOf(4, 800);
        app.host.send({ t: 'noteOff', ch: ch4.id, key: 60 });
        await P.closeEditor(`ch:${ch4.id}`);
      }
    }

    // export with plugins: the same instances render the pattern
    app.cmd.setStep(app.store, ch.id, 0, true, { key: 69 });
    let wav = null;
    app.exportSink = (b) => { wav = b; };
    const { exportProject, defaultSettings } = await import('./src/app/export.js');
    await exportProject(app, { ...defaultSettings(app.store.project), format: 'wav', quality: '16', source: 'pat', rate: app.host.sampleRate, tail: 1 });
    app.exportSink = null;
    let ep = 0;
    if (wav) { const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength); for (let i = 44; i + 1 < wav.byteLength; i += 2) ep = Math.max(ep, Math.abs(dv.getInt16(i, true))); }
    out.exportPeak = ep / 32768;

    // removing the channels unloads the plugins
    app.cmd.removeChannel(app.store, ch.id);
    app.cmd.removeChannel(app.store, ch2.id);
    app.cmd.removeChannel(app.store, ch3.id);
    if (ch4) app.cmd.removeChannel(app.store, ch4.id);
    app.cmd.setFx(app.store, 1, 0, null);
    await P.sync();
    out.left = P.items.size;
  } catch (err) { out.error = String(err && err.stack || err); }
  return out;
}

async function run(w) {
  return w.webContents.executeJavaScript(`(${pageCheck.toString()})()`);
}

function ok(r) {
  return !!r && r.available && !r.error && r.status === 'ready' && r.items === 2 && r.peak > 0.05 && r.quiet < r.peak * 0.05
    && (r.editor === undefined || (r.editor === true && r.tone === 0.75)) && r.state > 0 && r.params === 2
    && r.reloaded === 'ready' && (r.toneAfterReopen === undefined || r.editor === undefined || Math.abs(r.toneAfterReopen - 0.75) < 1e-6)
    && r.clapPeak > 0.05 && r.vst2Status === 'ready' && r.vst2Peak > 0.05 && r.exportPeak > 0.05 && r.left === 0
    && (r.auFound === undefined || (r.auFound && r.auStatus === 'ready' && r.auPeak > 0.001));
}

module.exports = { run, ok };
