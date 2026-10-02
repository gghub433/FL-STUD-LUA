import { page, open, test, ok, sleep, ev } from './harness.mjs';

// every export is captured in the page instead of being downloaded
const capture = () => ev(() => { window.__exp = null; app.exportSink = (bytes, name, mime) => { window.__exp = { bytes, name, mime }; }; });
const fresh = async () => {
  await ev(async () => {
    const { demoProject } = await import('/src/core/demo.js');
    await app.store.replaceProject(demoProject());
    app.transport.setMode('song');
    for (const k of Object.keys(localStorage)) if (k.startsWith('stepwise.export')) localStorage.removeItem(k);
  });
  await capture();
};
const run = (cfg) => ev(async (cfg) => {
  const { exportProject, defaultSettings } = await import('/src/app/export.js');
  const r = await exportProject(app, { ...defaultSettings(app.store.project), ...cfg });
  return r ? { name: r.name, size: r.bytes.length, seconds: r.seconds, kind: r.kind, count: r.count } : null;
}, cfg);
const decode = () => ev(async () => {
  const copy = window.__exp.bytes.slice().buffer;
  const buf = await app.host.ctx.decodeAudioData(copy);
  let pk = 0; const l = buf.getChannelData(0); for (let i = 0; i < l.length; i += 7) pk = Math.max(pk, Math.abs(l[i]));
  return { dur: buf.duration, ch: buf.numberOfChannels, rate: buf.sampleRate, peak: pk };
});

export async function run_() {
  console.log('export, projects, history, start');
  await open('/');

  await test('Ctrl+R opens the Export dialog; quality choices follow the format; MIDI disables audio options', async () => {
    await fresh();
    await page.keyboard.press('Control+r'); await sleep(250);
    ok((await page.locator('.modal-title').innerText()) === 'Export', 'dialog open');
    const fmt = page.locator('.modal select').first();
    const opts = await fmt.locator('option').allInnerTexts();
    ok(['WAV', 'FLAC (lossless)', 'MP3', 'OGG (Opus)', 'MIDI file'].every((n) => opts.includes(n)), `formats: ${opts}`);
    const q = page.locator('.modal select').nth(1);
    ok((await q.locator('option').allInnerTexts()).join() === '16-bit,24-bit,32-bit float', 'WAV qualities');
    await fmt.selectOption('mp3'); ok((await q.locator('option').allInnerTexts()).join() === '128 kbps,192 kbps,256 kbps,320 kbps', 'MP3 bitrates');
    await fmt.selectOption('mid'); ok(await q.isDisabled(), 'no quality for MIDI');
    await fmt.selectOption('ogg'); ok(await page.locator('.modal select').nth(3).isDisabled(), 'OGG fixes the sample rate');
    await page.screenshot({ path: 'tests/e2e/out/export-dialog.png' });
    await page.keyboard.press('Escape'); await sleep(100);
    ok((await page.locator('.modal').count()) === 0, 'Escape closes it');
  });

  await test('WAV 24-bit: renders the whole song in a worker, correct header, normalise sets the peak, copy lands in Rendered', async () => {
    await fresh();
    const r = await run({ format: 'wav', quality: '24', name: 'e2e song' });
    ok(r && r.kind === 'audio' && r.seconds > 10, `rendered ${JSON.stringify(r)}`);
    const hdr = await ev(() => { const b = window.__exp.bytes; return { tag: String.fromCharCode(...b.slice(0, 4)), bits: b[34] | (b[35] << 8), name: window.__exp.name }; });
    ok(hdr.tag === 'RIFF' && hdr.bits === 24 && hdr.name === 'e2e song.wav', JSON.stringify(hdr));
    const rendered = await ev(async () => (await app.library.list('rendered')).some((e) => e.name === 'e2e song'));
    ok(rendered, 'kept in the Rendered section');
    await run({ format: 'wav', quality: '32', normalize: true, keep: false });
    const pk = await ev(() => { const b = window.__exp.bytes, dv = new DataView(b.buffer, b.byteOffset); let m = 0; for (let o = 44; o < b.length; o += 4) m = Math.max(m, Math.abs(dv.getFloat32(o, true))); return m; });
    ok(Math.abs(pk - 0.98855) < 0.002, `normalised peak ${pk}`);
  });

  await test('pattern / loop-region sources and the tail setting change the length', async () => {
    await fresh();
    const song = await run({ format: 'wav', quality: '16', tail: 'cut', keep: false });
    const pat = await run({ format: 'wav', quality: '16', source: 'pat', tail: 'cut', keep: false });
    ok(pat.seconds < song.seconds && Math.abs(pat.seconds - 60 / 124 * 4) < 0.05, `pattern is one bar: ${pat.seconds} vs song ${song.seconds}`);
    const tail4 = await run({ format: 'wav', quality: '16', source: 'pat', tail: 4, keep: false });
    ok(Math.abs(tail4.seconds - (pat.seconds + 4)) < 0.05, `4 s tail: ${tail4.seconds}`);
    const err = await ev(async () => { try { const { exportProject, defaultSettings } = await import('/src/app/export.js'); await exportProject(app, { ...defaultSettings(app.store.project), source: 'loop' }); return null; } catch (e) { return e.message; } });
    ok(/no loop region/i.test(err || ''), `loop source without a loop explains itself: ${err}`);
    await ev(() => app.cmd.setLoop(app.store, { s: 384, e: 768 }));
    const loop = await run({ format: 'wav', quality: '16', source: 'loop', tail: 'cut', keep: false });
    ok(Math.abs(loop.seconds - 60 / 124 * 4) < 0.05, `loop region is one bar: ${loop.seconds}`);
  });

  await test('FLAC export decodes in the browser and matches the WAV render sample for sample', async () => {
    await fresh();
    await run({ format: 'wav', quality: '24', source: 'pat', keep: false });
    const wav = await ev(async () => { const { decodeWav } = await import('/src/host/export/wav.js'); const w = decodeWav(window.__exp.bytes); return { n: w.channels[0].length, rate: w.rate, sample: Array.from(w.channels[0].slice(2000, 2020)) }; });
    await run({ format: 'flac', quality: '24', source: 'pat', keep: false, dither: false });
    const d = await decode();
    ok(d.ch === 2 && d.rate === wav.rate && d.dur > 1.9, `decoded by Chromium: ${JSON.stringify(d)}`);
    const exact = await ev(async (ref) => { const buf = await app.host.ctx.decodeAudioData(window.__exp.bytes.slice().buffer); const l = buf.getChannelData(0); let worst = 0; for (let i = 0; i < ref.length; i++) worst = Math.max(worst, Math.abs(l[2000 + i] - ref[i])); return worst; }, wav.sample);
    ok(exact < 2 / 8388607, `FLAC equals the 24-bit WAV (worst difference ${exact})`);
  });

  await test('MP3 export produces a decodable MPEG file of the right length', async () => {
    await fresh();
    const r = await run({ format: 'mp3', quality: '192', source: 'pat', tail: 'cut', keep: false });
    ok(r.name.endsWith('.mp3') && r.size > 10000, `${JSON.stringify(r)}`);
    const d = await decode();
    ok(d.ch === 2 && Math.abs(d.dur - r.seconds) < 0.15 && d.peak > 0.1, `decoded: ${JSON.stringify(d)}`);
    ok(await ev(() => { const b = window.__exp.bytes; return b[0] === 0xff && (b[1] & 0xe0) === 0xe0; }), 'MPEG frame sync');
  });

  await test('OGG (Opus) export is a valid Ogg stream that Chromium decodes, at 48 kHz', async () => {
    await fresh();
    const supported = await ev(() => typeof AudioEncoder !== 'undefined');
    if (!supported) { console.log('       (WebCodecs missing: skipped)'); return; }
    const r = await run({ format: 'ogg', quality: '192', source: 'pat', tail: 'cut', keep: false });
    ok(r.name.endsWith('.ogg'), r.name);
    ok(await ev(() => String.fromCharCode(...window.__exp.bytes.slice(0, 4)) === 'OggS'), 'Ogg capture pattern');
    const d = await decode();
    ok(Math.abs(d.dur - r.seconds) < 0.12 && d.peak > 0.1, `decoded: ${JSON.stringify(d)} vs ${r.seconds}`);
  });

  await test('MIDI export contains the notes; stems export is a zip with one decodable file per mixer track', async () => {
    await fresh();
    await run({ format: 'mid', source: 'song' });
    const m = await ev(async () => { const { readMidi } = await import('/src/core/midi-file.js'); const r = readMidi(window.__exp.bytes); return { tracks: r.tracks.length, notes: r.tracks.reduce((a, t) => a + t.notes.length, 0), tempo: r.tempo, names: r.tracks.map((t) => t.name) }; });
    ok(m.tracks >= 7 && m.notes > 100 && Math.abs(m.tempo - 124) < 0.01 && m.names.includes('Sub 808'), `midi: ${JSON.stringify(m)}`);
    const s = await run({ format: 'wav', quality: '16', source: 'pat', stems: true, tail: 'cut', keep: false });
    ok(s.kind === 'stems' && s.count === 4, `stems: ${JSON.stringify(s)}`);
    const files = await ev(async () => {
      const { unzip } = await import('/src/core/zip.js'); const { decodeWav } = await import('/src/host/export/wav.js');
      const out = await unzip(window.__exp.bytes);
      return out.map((f) => { const w = decodeWav(f.data); let pk = 0; for (const v of w.channels[0]) pk = Math.max(pk, Math.abs(v)); return { name: f.name, peak: +pk.toFixed(3) }; });
    });
    ok(files.length === 4 && files.every((f) => f.peak > 0.01) && files[0].name.startsWith('01 ') && files.some((f) => /Kick/.test(f.name)), `stem files: ${JSON.stringify(files)}`);
  });

  await test('cancel stops a running export; the dialog shows progress and reports errors', async () => {
    await fresh();
    await ev(async () => { const cfg = (await import('/src/app/export.js')).defaultSettings(app.store.project); window.__cancelled = null; const { exportProject } = await import('/src/app/export.js'); let cancelFn; const p = exportProject(app, { ...cfg, keep: false }, { progress() {}, cancelled: () => false, onCancel: (fn) => { cancelFn = fn; } }); setTimeout(() => cancelFn && cancelFn(), 30); window.__cancelled = await p; });
    ok((await ev(() => window.__cancelled)) === null, 'cancelled export resolves to null and nothing is saved');
    ok(await ev(() => window.__exp === null), 'no file was produced');
    // dialog flow through the real buttons
    await ev(() => app.openExportDialog()); await sleep(200);
    await page.locator('.modal select').first().selectOption('wav');
    await page.locator('.modal input[type=text]').fill('dialog export');
    await ev(() => { window.__exp = null; });
    await page.locator('.modal .btn.primary', { hasText: 'Export' }).click();
    await page.waitForSelector('.modal progress', { state: 'visible' });
    await page.waitForFunction(() => window.__exp && window.__exp.name === 'dialog export.wav', null, { timeout: 60000 });
    await sleep(300);
    ok((await page.locator('.modal').count()) === 0, 'dialog closes after a successful export');
    // an error surfaces in the dialog instead of failing silently
    await ev(async () => { const { emptyProject } = await import('/src/core/demo.js'); await app.store.replaceProject(emptyProject()); });
    await ev(() => app.openExportDialog()); await sleep(200);
    await page.locator('.modal .btn.primary', { hasText: 'Export' }).click(); await sleep(1500);
    ok(/nothing to render/i.test(await page.locator('.modal').innerText()), 'empty project: "Nothing to render" shown in the dialog');
    await page.keyboard.press('Escape');
  });

  await test('project ZIP carries user samples: download -> open restores the same sound under the same id', async () => {
    await fresh();
    const id = await ev(async () => {
      const n = 4000, d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = Math.sin(i / 8) * 0.6;
      const e = app.bank.addPCM('zip test', 44100, [d]);
      app.cmd.addChannel(app.store, 'sampler', { name: 'Zipper', sample: { id: e.id, name: e.name } });
      const { projectToZip } = await import('/src/app/project-io.js');
      window.__zip = projectToZip(app.store.project, app.bank);
      return e.id;
    });
    await ev(async (id) => { app.bank.map.delete(id); const { emptyProject } = await import('/src/core/demo.js'); await app.store.replaceProject(emptyProject()); }, id);
    ok(await ev((id) => !app.bank.has(id), id), 'sample gone from the bank');
    await ev(async () => { await app.loadProjectFile(new File([window.__zip], 'moved.zip')); });
    const back = await ev((id) => ({ ch: app.store.project.channels.map((c) => c.name), has: app.bank.has(id), len: app.bank.get(id)?.length, v: app.bank.get(id)?.channels[0][100] }), id);
    ok(back.ch.includes('Zipper') && back.has && back.len === 4000 && Math.abs(back.v - Math.sin(100 / 8) * 0.6) < 1e-6, `restored: ${JSON.stringify(back)}`);
  });

  await test('undo history window lists edits newest first and jumps back to the clicked state', async () => {
    await fresh();
    await ev(() => { app.store.history.length = 0; app.store.future.length = 0; });
    await ev(() => { app.store.setParam('transport:tempo', 100, { coalesce: 'a' }); });
    await ev(() => { app.cmd.addChannel(app.store, 'organ', { name: 'History organ' }); });
    await ev(() => { app.store.setParam('transport:tempo', 150); });
    await ev(() => app.openWindow('history')); await sleep(250);
    const labels = await page.locator('.win[data-id="history"] .hist-row .hist-label').allInnerTexts();
    ok(labels.length === 3 && /Tempo|tempo/.test(labels[0]) && /organ/i.test(labels[1]), `entries: ${labels}`);
    await page.locator('.win[data-id="history"] .hist-row').nth(1).click(); await sleep(400);          // jump to before "Add History organ"
    const st = await ev(() => ({ tempo: app.store.project.tempo, organ: app.store.project.channels.some((c) => c.name === 'History organ') }));
    ok(st.tempo === 100 && !st.organ, `state before the clicked edit: ${JSON.stringify(st)}`);
    ok((await page.locator('.win[data-id="history"] .hist-row.redo').count()) === 2, 'the undone edits are listed as redo steps');
    await page.locator('.win[data-id="history"] .hist-row.redo').first().click(); await sleep(400);
    ok(await ev(() => app.store.project.channels.some((c) => c.name === 'History organ')), 'clicking a redo step re-applies it');
  });

  await test('start dialog: templates start a project, recent projects reopen, autosave can be recovered', async () => {
    await fresh();
    await ev(async () => { app.store.project.meta.title = 'Picker song'; app.store.project.tempo = 111; await app.store.saveProjectLocal(); });
    await ev(() => app.openStartDialog()); await sleep(400);
    ok((await page.locator('.modal-title').innerText()).includes('Welcome'), 'dialog open');
    ok((await page.locator('.start-card', { hasText: 'Picker song' }).count()) === 1, 'recent project listed');
    await page.locator('.start-card', { hasText: 'Trap 140 BPM' }).click(); await sleep(500);
    ok((await ev(() => app.store.project.tempo)) === 140 && (await page.locator('.modal').count()) === 0, 'template card starts a new project and closes the dialog');
    await ev(() => app.openStartDialog()); await sleep(400);
    await page.locator('.start-card', { hasText: 'Picker song' }).click(); await sleep(500);
    ok((await ev(() => app.store.project.tempo)) === 111, 'recent card reopens the saved project');
    await ev(async () => { app.store.project.tempo = 99; app.store.project.meta.title = 'Crash recovery'; app.store.markDirty(); await app.store.autosave(); await new Promise((r) => setTimeout(r, 1200)); });
    await ev(() => app.openStartDialog()); await sleep(400);
    ok((await page.locator('.start-recover').count()) === 1, 'recover offer shown when the autosave is newer than every saved project');
    await page.locator('.start-recover .btn').click(); await sleep(500);
    ok((await ev(() => app.store.project.tempo)) === 99, 'autosave recovered');
  });
}
export { run_ as run };
