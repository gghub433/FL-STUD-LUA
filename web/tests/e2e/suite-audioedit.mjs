import { page, open, test, ok, sleep, ev } from './harness.mjs';

// evaluate a function with the newest editor instance (functions are serialised, so they may only use their arguments)
const withEd = (fn, arg) => page.evaluate(({ src, arg }) => { const ed = Object.values(app.audioEditors || {}).at(-1); return (new Function('ed', 'arg', `return (${src})(ed, arg)`))(ed, arg); }, { src: fn.toString(), arg });
const winSel = '.win[data-id^="audioedit:"]';
const canvas = () => page.locator(`${winSel} .ae-wave`).last();
const menu = async (label) => { await page.locator(`${winSel} .rack-head .btn`, { hasText: label }).last().click(); await sleep(120); };
const item = async (text) => { await page.locator('.popup .item', { hasText: text }).first().click(); await sleep(150); };
const sub = async (parent, text) => { await page.locator('.popup .item', { hasText: parent }).first().hover(); await sleep(250); await page.locator('.popup .item', { hasText: text }).last().click(); await sleep(150); };
const setRange = (i, v) => page.evaluate(({ i, v }) => { const el = document.querySelectorAll('.modal input[type=range]')[i]; el.value = v; el.dispatchEvent(new Event('input')); }, { i, v });
const applyDialog = async (label = 'Apply') => { await page.locator('.modal .btn', { hasText: label }).first().click(); await sleep(250); };
const frames = () => withEd((ed) => ed.frames);
const closePlugins = () => ev(() => { for (const c of app.store.project.channels) app.wm.close(`plugin:${c.id}`); });
const pk = () => withEd((ed) => { let m = 0; for (const c of ed.buf.channels) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i])); return m; });

async function fresh() {
  await ev(async () => {
    const { emptyProject } = await import('/src/core/demo.js');
    await app.store.replaceProject(emptyProject());
    for (const id of Object.keys(app.audioEditors || {})) app.wm.close(id);
  });
}
async function openTone() {
  const id = await ev(() => {
    const n = 44100, l = new Float32Array(n), r = new Float32Array(n);
    for (let i = 0; i < n; i++) { l[i] = 0.25 * Math.sin(i * 2 * Math.PI * 440 / 44100); r[i] = 0.2 * Math.sin(i * 2 * Math.PI * 660 / 44100); }
    const e = app.bank.addPCM('Test tone', 44100, [l, r]);
    app.openAudioEditor({ sampleId: e.id, name: 'Test tone' });
    return e.id;
  });
  await page.waitForFunction(() => Object.values(app.audioEditors || {}).at(-1)?.frames > 0, null, { timeout: 5000 });
  await sleep(300);
  return id;
}
const drag = async (x0, x1) => {
  const b = await canvas().boundingBox();
  await page.mouse.move(b.x + x0, b.y + 60); await page.mouse.down(); await page.mouse.move(b.x + (x0 + x1) / 2, b.y + 60, { steps: 4 }); await page.mouse.move(b.x + x1, b.y + 60, { steps: 4 }); await page.mouse.up(); await sleep(120);
};

export async function run() {
  console.log('audio editor');
  await open('/');

  await test('Tools → Audio editor opens an empty editor; a project sample opens with its waveform, rate and levels', async () => {
    await fresh();
    await page.locator('.menu-top', { hasText: 'TOOLS' }).click();
    await page.locator('.popup .item', { hasText: 'Audio editor' }).click(); await sleep(400);
    ok((await page.locator(winSel).count()) === 1, 'window open');
    ok((await page.locator(`${winSel} .ae-status`).innerText()).startsWith('Empty'), 'empty message');
    await ev(() => Object.keys(app.audioEditors).forEach((k) => app.wm.close(k)));
    await openTone();
    const status = await page.locator(`${winSel} .ae-status`).innerText();
    ok(/44100 Hz · stereo/.test(status) && /peak -12\.0 dB/.test(status), `status: ${status}`);
    ok((await page.locator(`${winSel} .win-title, .win .win-title`).filter({ hasText: 'Test tone' }).count()) >= 1, 'title shows the sample name');
    const painted = await canvas().evaluate((cv) => { const d = cv.getContext('2d').getImageData(0, 30, cv.width, 100).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 2] < 90) n++; return n; });
    ok(painted > 500, `orange waveform pixels painted (${painted})`);
    await page.screenshot({ path: 'tests/e2e/out/audioedit.png' });
  });

  await test('drag selects, shift-click extends, double-click selects all; copy / paste / cut / delete and undo behave', async () => {
    const W = (await canvas().boundingBox()).width;
    await drag(W * 0.25, W * 0.5);
    let s = await withEd((ed) => ed.sel);
    ok(s && Math.abs(s.a / 44100 - 0.25) < 0.02 && Math.abs(s.b / 44100 - 0.5) < 0.02, `selected 0.25..0.5 s (${JSON.stringify(s)})`);
    ok((await page.locator(`${winSel} .lcd`).last().innerText()).includes('Sel 0:00.2'), 'readout shows the selection');
    const n0 = await frames();
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Delete'); await sleep(100);
    ok((await frames()) < n0 - 10000, 'selection deleted');
    ok((await page.locator(`.win .win-title`).filter({ hasText: '•' }).count()) >= 1, 'modified marker in the title');
    await page.keyboard.press('Control+v'); await sleep(100);
    ok((await frames()) === n0, 'pasted back: same length');
    await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await sleep(100);
    ok((await frames()) === n0, 'two undos return to the original');
    await page.keyboard.press('Control+y'); await sleep(100);
    ok((await frames()) < n0 - 10000, 'redo');
    await page.keyboard.press('Control+z'); await sleep(50);
    await canvas().dblclick({ position: { x: 100, y: 80 } });
    s = await withEd((ed) => ed.sel);
    ok(s && s.a === 0 && s.b === n0, 'double-click selects everything');
    await page.keyboard.press('Control+x'); await sleep(100);
    ok((await frames()) === 0, 'cut everything');
    await page.keyboard.press('Control+z'); await sleep(100);
    ok((await frames()) === n0, 'undo');
  });

  await test('Process menu: normalize, fade, reverse, gain, mono and stereo conversions; all undoable', async () => {
    await withEd((ed) => { ed.sel = null; ed.dirty = true; });
    await menu('Process'); await item('Normalize…');
    await setRange(0, -3); await applyDialog();
    const p = await pk();
    ok(Math.abs(20 * Math.log10(p) + 3) < 0.05, `normalized to -3 dB (peak ${p})`);
    await menu('Process'); await sub('Fade in', 'Linear');
    ok(Math.abs(await withEd((ed) => ed.buf.channels[0][0])) < 1e-6, 'fade in starts silent');
    await menu('Process'); await item('Reverse');
    ok(Math.abs(await withEd((ed) => ed.buf.channels[0][ed.frames - 1])) < 1e-6, 'reversed: the silent start is now the end');
    await menu('Process'); await item('Gain…'); await setRange(0, -6); await applyDialog();
    ok(Math.abs(20 * Math.log10(await pk()) + 9) < 0.1, 'gain applied on top');
    await menu('Process'); await item('Make mono');
    ok((await withEd((ed) => ed.buf.channels.length)) === 1, 'mono');
    await menu('Process'); await item('Make stereo');
    ok((await withEd((ed) => ed.buf.channels.length)) === 2, 'stereo again');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Control+z');
    await sleep(100);
    ok(Math.abs(20 * Math.log10(await pk()) + 12.04) < 0.1, 'six undos restore the original level');
  });

  await test('time-stretch changes the length, resampling changes the rate, Trim keeps the selection', async () => {
    const n0 = await frames();
    await menu('Process'); await item('Time-stretch'); await setRange(0, 200); await applyDialog();
    const n1 = await frames();
    ok(Math.abs(n1 / n0 - 2) < 0.03, `twice as long (${n1 / n0})`);
    await page.keyboard.press('Control+z'); await sleep(100);
    await menu('Process'); await item('Resample…');
    await page.locator('.modal select').selectOption('22050'); await applyDialog();
    ok((await withEd((ed) => ed.buf.rate)) === 22050 && Math.abs((await frames()) - n0 / 2) <= 2, 'rate halved, half the frames');
    await page.keyboard.press('Control+z'); await sleep(100);
    const W = (await canvas().boundingBox()).width;
    await drag(W * 0.1, W * 0.4);
    await menu('Edit'); await item('Trim to selection');
    const n2 = await frames();
    ok(Math.abs(n2 / 44100 - 0.3) < 0.03, `trimmed to 0.3 s (${n2 / 44100})`);
    await page.keyboard.press('Control+z'); await sleep(100);
  });

  await test('any mixer effect runs on the selection (filter), reverb tail extends the sample', async () => {
    const W = (await canvas().boundingBox()).width;
    await drag(W * 0.2, W * 0.6);
    await withEd((ed) => { window.__before = ed.buf.channels[0].slice(); });
    await menu('Effects'); await sub('Filter', 'Filter');
    ok((await page.locator('.modal-title').innerText()).toLowerCase().includes('filter'), 'dialog titled with the effect');
    ok((await page.locator('.modal input[type=range]').count()) >= 4, 'parameters listed');
    await applyDialog();
    const d = await withEd((ed) => {
      const a = ed.buf.channels[0], b = window.__before; let inside = 0, outside = 0;
      for (let i = 0; i < a.length; i++) { const x = Math.abs(a[i] - b[i]); if (i >= ed.sel.a + 2000 && i < ed.sel.b - 100) inside = Math.max(inside, x); else if (i < ed.sel.a - 10 || i > ed.sel.b + 10) outside = Math.max(outside, x); }
      return { inside, outside };
    });
    ok(d.inside > 0.02, `the filter changed the selected part (max difference ${d.inside.toFixed(3)})`);
    ok(d.outside < 1e-6, `and left the rest alone (${d.outside})`);
    await page.keyboard.press('Control+z'); await sleep(100);
    const n0 = await frames();
    await withEd((ed) => { ed.sel = null; });
    await menu('Effects'); await sub('Space', 'Reverb');
    await applyDialog();
    ok((await frames()) >= n0 + 2 * 44100 - 5, `reverb tail added (${(await frames()) - n0} frames)`);
    await page.keyboard.press('Control+z'); await sleep(100);
  });

  await test('zoom (wheel, buttons), scrolling, spectrogram, regions', async () => {
    const b = await canvas().boundingBox();
    const spp0 = await withEd((ed) => ed.view.spp);
    await page.mouse.move(b.x + 200, b.y + 80); for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -120); await sleep(30); } await sleep(120);
    const spp1 = await withEd((ed) => ed.view.spp);
    ok(spp1 < spp0 * 0.5, `zoomed in (${spp0.toFixed(1)} -> ${spp1.toFixed(1)})`);
    await page.keyboard.down('Shift'); await page.mouse.wheel(0, 300); await page.keyboard.up('Shift'); await sleep(120);
    ok((await withEd((ed) => ed.view.start)) > 0, 'scrolled right');
    await page.locator(`${winSel} .rack-head .btn`, { hasText: 'All' }).last().click(); await sleep(100);
    ok(Math.abs((await withEd((ed) => ed.view.spp)) - spp0) < 1e-6, 'All fits the sample');
    await page.locator(`${winSel} .rack-head .btn`, { hasText: 'Spectrogram' }).last().click(); await sleep(700);
    const lit = await page.locator(`${winSel} canvas`).last().evaluate((cv) => { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) n++; return n; });
    ok(lit > 200, `spectrogram drawn (${lit} bright pixels)`);
    await page.locator(`${winSel} .rack-head .btn`, { hasText: 'Spectrogram' }).last().click();
    await menu('Regions'); await item('Split into equal parts'); await applyDialog();
    ok((await withEd((ed) => ed.regions.length)) === 8, '8 equal regions');
    await menu('Regions'); await item('Clear all regions');
    ok((await withEd((ed) => ed.regions.length)) === 0, 'cleared');
  });

  await test('Play / stop: the play head runs, and ▶ turns into ■', async () => {
    await withEd((ed) => { ed.sel = { a: 0, b: 30000 }; ed.dirty = true; });
    await page.locator(`${winSel} .rack-head .btn`).first().click(); await sleep(350);
    const st = await withEd((ed) => ({ playing: !!ed.playing, ph: ed.playhead() }));
    ok(st.playing && st.ph > 1000, `playing, head at ${st.ph}`);
    ok((await page.locator(`${winSel} .rack-head .btn`).first().innerText()) === '■', 'stop symbol');
    await page.locator(`${winSel} .rack-head .btn`).first().click(); await sleep(150);
    ok(!(await withEd((ed) => !!ed.playing)), 'stopped');
  });

  await test('Send: new sampler channel, replace the source sample, Browser → Recorded, export WAV', async () => {
    await fresh();
    const { chId, sid } = await ev(() => {
      const n = 22050, l = new Float32Array(n); for (let i = 0; i < n; i++) l[i] = 0.5 * Math.sin(i * 2 * Math.PI * 300 / 44100);
      const e = app.bank.addPCM('Source', 44100, [l]);
      const ch = app.cmd.addChannel(app.store, 'sampler', { name: 'Src sampler', sample: { id: e.id, name: e.name } });
      app.openChannelEditor(ch.id);
      return { chId: ch.id, sid: e.id };
    });
    // the sampler editor has an Edit… button that opens the audio editor on its sample
    await page.waitForSelector(`.win[data-id="plugin:${chId}"]`);
    await page.locator(`.win[data-id="plugin:${chId}"] .btn`, { hasText: 'Edit…' }).click();
    await page.waitForFunction(() => Object.values(app.audioEditors || {}).at(-1)?.frames > 0, null, { timeout: 5000 });
    ok((await withEd((ed) => ed.src.chId)) === chId, 'opened with the source channel');
    await page.keyboard.press('Control+a'); await menu('Process'); await item('Reverse'); await sleep(100);
    await closePlugins();
    await menu('Send'); await item('Replace the sample of'); await sleep(200);
    const now = await ev((id) => app.store.channel(id).sample.id, chId);
    ok(now !== sid, 'the channel points at a new sample');
    ok(/edited/.test(await ev((id) => app.store.channel(id).sample.name, chId)), 'named as edited');
    const n0 = await ev(() => app.store.project.channels.length);
    await closePlugins();
    await menu('Send'); await item('New sampler channel'); await sleep(200); await closePlugins();
    ok((await ev(() => app.store.project.channels.length)) === n0 + 1, 'sampler channel added');
    await menu('Send'); await item('Save to the Browser'); await sleep(250);
    ok((await ev(async () => (await app.library.list('recorded')).length)) >= 1, 'saved in the Browser library');
    await ev(() => { window.__exp = null; app.exportSink = (bytes, name) => { window.__exp = { bytes, name }; }; });
    await menu('Send'); await page.locator('.popup .item', { hasText: 'Export as WAV' }).hover(); await sleep(250); await page.locator('.popup .item', { hasText: '16-bit' }).click(); await sleep(250);
    const wav = await ev(async () => { const { decodeWav } = await import('/src/host/export/wav.js'); const w = decodeWav(window.__exp.bytes); return { name: window.__exp.name, rate: w.rate, n: w.channels[0].length, ch: w.channels.length }; });
    ok(wav.rate === 44100 && wav.n === 22050 && wav.ch === 1 && wav.name.endsWith('.wav'), `WAV ${JSON.stringify(wav)}`);
  });

  await test('Regions at the hits make a Slicer channel; recording (●) adds the microphone to the sample', async () => {
    await fresh();
    await ev(() => {
      const n = 44100 * 2, l = new Float32Array(n);
      for (const t of [0, 0.5, 1, 1.5]) for (let i = 0; i < 3000; i++) l[Math.floor(t * 44100) + i] += Math.sin(i / 3) * Math.exp(-i / 700) * 0.8;
      const e = app.bank.addPCM('Hits', 44100, [l]);
      app.openAudioEditor({ sampleId: e.id, name: 'Hits' });
    });
    await page.waitForFunction(() => Object.values(app.audioEditors || {}).at(-1)?.frames > 0, null, { timeout: 5000 });
    await menu('Regions'); await item('Detect regions'); await applyDialog();
    const regs = await withEd((ed) => ed.regions.length);
    ok(regs >= 4, `${regs} regions found`);
    const n0 = await ev(() => app.store.project.channels.length);
    await menu('Send'); await item('Slicer channel from the regions'); await sleep(250);
    const slicer = await ev(() => app.store.project.channels.at(-1));
    ok(slicer.type === 'slicer' && slicer.slices.length === regs && slicer.slices[0] === 0, `slicer with ${slicer.slices.length} slices`);
    ok((await ev(() => app.store.project.channels.length)) === n0 + 1, 'channel added');
    // recording
    await ev(() => { for (const c of app.store.project.channels) app.wm.close(`plugin:${c.id}`); });
    await withEd((ed) => { ed.sel = null; ed.cursor = ed.frames; });
    const n1 = await frames();
    await page.locator(`${winSel} .rack-head .btn.rec`).last().click(); await sleep(1600);
    await page.locator(`${winSel} .rack-head .btn.rec`).last().click(); await sleep(900);
    const grown = (await frames()) - n1;
    ok(grown > 44100 * 1.0 && grown < 44100 * 3, `recorded ${(grown / 44100).toFixed(2)} s`);
    ok(await withEd((ed, n) => { let m = 0; const c = ed.buf.channels[0]; for (let i = n; i < c.length; i++) m = Math.max(m, Math.abs(c[i])); return m > 0.01; }, n1), 'the take contains the input signal');
  });
}
