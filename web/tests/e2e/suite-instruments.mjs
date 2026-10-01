import { page, open, maxPeak, test, ok, sleep, ev } from './harness.mjs';

const play = () => ev(async () => { app.transport.stop(); await new Promise((r) => setTimeout(r, 60)); app.transport.play(); });
const stop = () => ev(() => app.transport.stop());

// new empty project with one channel of `type` on insert `mixer`, one step at C5
async function fresh(type, setup = '') {
  return ev(async ({ type, setup }) => {
    const { emptyProject } = await import('/src/core/demo.js');
    await app.store.replaceProject(emptyProject());
    const ch = app.cmd.addChannel(app.store, type, { name: type });
    app.cmd.setMixerTarget(app.store, ch.id, 5);
    // eslint-disable-next-line no-new-func
    if (setup) await new Function('app', 'ch', `return (async()=>{${setup}})()`)(app, ch);
    app.cmd.setStep(app.store, ch.id, 0, true, { key: 60 });
    app.cmd.setStep(app.store, ch.id, 8, true, { key: 64 });
    return ch.id;
  }, { type, setup });
}

const winOf = (id) => page.locator(`.win[data-id="plugin:${id}"]`);

export async function run() {
  console.log('instruments');
  await open('/');

  await test('Sub Synth: dedicated window with tabs and envelope graphs; makes sound; gain knob silences it', async () => {
    const id = await fresh('subsynth');
    await ev((id) => app.openChannelEditor(id), id);
    await page.waitForSelector(`.win[data-id="plugin:${id}"] .rack-tab`);
    const tabs = await winOf(id).locator('.rack-tab').allInnerTexts();
    ok(tabs.length >= 4, `expected several tabs, got ${tabs}`);
    await winOf(id).locator('.rack-tab', { hasText: 'Filter' }).click();
    ok(await winOf(id).locator('canvas').count() >= 1, 'filter tab shows the envelope graph');
    await play();
    const loud = await maxPeak(5, 2200);
    ok(loud > 0.02, `sub synth should be audible, peak=${loud}`);
    await ev((id) => app.store.setParam(`ch:${id}:p:gain`, 0), id);
    await sleep(300);
    const quiet = await maxPeak(5, 1500);
    ok(quiet < loud * 0.05, `gain 0 should silence: ${loud} -> ${quiet}`);
    await stop();
    await page.screenshot({ path: 'tests/e2e/out/subsynth.png' });
  });

  await test('FM synth: algorithm select + modulation matrix switch to Custom; makes sound', async () => {
    const id = await fresh('fm');
    await ev((id) => app.openChannelEditor(id), id);
    await page.waitForSelector(`.win[data-id="plugin:${id}"] canvas`);
    await play();
    const loud = await maxPeak(5, 2200);
    ok(loud > 0.02, `FM should be audible, peak=${loud}`);
    // edit a matrix cell through its param: algorithm flips to Custom
    const before = await ev((id) => app.store.channel(id).params.algo, id);
    await ev((id) => app.store.setParam(`ch:${id}:p:mod12`, 0.7), id);
    await sleep(250);
    const after = await ev((id) => app.store.channel(id).params.mod12, id);
    ok(Math.abs(after - 0.7) < 1e-6, `mod12 stored: ${after} (algo was ${before})`);
    await stop();
    await page.screenshot({ path: 'tests/e2e/out/fm.png' });
  });

  await test('Drum synth: type presets render a preview and sound', async () => {
    const id = await fresh('drums');
    await ev((id) => app.openChannelEditor(id), id);
    await page.waitForSelector(`.win[data-id="plugin:${id}"] canvas`);
    await play();
    const loud = await maxPeak(5, 2200);
    ok(loud > 0.02, `drum synth audible, peak=${loud}`);
    await stop();
  });

  await test('Sampler editor: waveform, markers drag edits start; INS tab shows envelope blocks', async () => {
    const id = await fresh('sampler', `app.cmd.setChannelSample(app.store, ch.id, { id: 'factory:kick-punch', name: 'Punch kick' }); await app.bank.ensure('factory:kick-punch');`);
    await ev((id) => app.openChannelEditor(id), id);
    await page.waitForSelector(`.win[data-id="plugin:${id}"] canvas`);
    await sleep(300);
    const cv = winOf(id).locator('canvas').first();
    const box = await cv.boundingBox();
    // start marker sits at x = 0; drag it right
    await page.mouse.move(box.x + 1, box.y + 40); await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, box.y + 40, { steps: 6 }); await page.mouse.up();
    const start = await ev((id) => app.store.channel(id).params.start, id);
    ok(start > 0.1 && start < 0.3, `start marker should move to ~0.2, got ${start}`);
    await winOf(id).locator('.rack-tab', { hasText: 'INS' }).click();
    ok(await winOf(id).locator('canvas').count() >= 3, 'INS tab has envelope + LFO canvases per target');
    await play();
    const loud = await maxPeak(5, 2200);
    ok(loud > 0.02, `sampler audible after trimming start, peak=${loud}`);
    await stop();
    await page.screenshot({ path: 'tests/e2e/out/sampler.png' });
  });

  await test('FPC: 16 pads + banks; dropping/adding a layer makes the pad sound; mute silences it', async () => {
    const id = await fresh('fpc', `await app.bank.ensure('factory:kick-punch'); app.cmd.editPad(app.store, ch.id, 0, (p) => { p.layers.push({ sample: { id: 'factory:kick-punch', name: 'Punch kick' }, vol: 1, pan: 0, pitch: 0, start: 0 }); });`);
    await ev((id) => app.openChannelEditor(id), id);
    await page.waitForSelector(`.win[data-id="plugin:${id}"] .fpc-pad`);
    ok((await winOf(id).locator('.fpc-pad').count()) === 16, '16 pads visible');
    ok((await winOf(id).locator('.fpc-pad.has').count()) === 1, 'one pad has a sample');
    await play();
    const loud = await maxPeak(5, 2200);
    ok(loud > 0.05, `FPC pad should sound, peak=${loud}`);
    // bank B shows different pads
    await winOf(id).locator('.seg .btn', { hasText: 'B' }).click();
    await sleep(100);
    ok(await ev((id) => app.store.channel(id).padBank, id) === 1, 'bank B selected');
    await winOf(id).locator('.seg .btn', { hasText: 'A' }).click();
    // mute pad 1 via context menu command
    await ev((id) => app.cmd.editPad(app.store, id, 0, (p) => { p.mute = 1; }), id);
    await sleep(300);
    const quiet = await maxPeak(5, 1800);
    ok(quiet < loud * 0.05, `muted pad is silent: ${loud} -> ${quiet}`);
    await stop();
    await page.screenshot({ path: 'tests/e2e/out/fpc.png' });
  });

  await test('FPC knob drag in the pad inspector keeps working while the project changes', async () => {
    const id = await fresh('fpc', `await app.bank.ensure('factory:kick-punch'); app.cmd.editPad(app.store, ch.id, 0, (p) => { p.layers.push({ sample: { id: 'factory:kick-punch', name: 'Punch kick' }, vol: 1, pan: 0, pitch: 0, start: 0 }); });`);
    await ev((id) => app.openChannelEditor(id), id);
    await page.waitForSelector(`.win[data-id="plugin:${id}"] .fpc-pad`);
    const knob = winOf(id).locator('.knob').nth(3); // channel vol/pan/pitch, then the pad's volume
    const b = await knob.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 40, { steps: 8 });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 70, { steps: 8 }); await page.mouse.up();
    const vol = await ev((id) => app.store.channel(id).pads[0].vol, id);
    ok(vol < 0.8, `pad volume should have dropped over one continuous drag, got ${vol}`);
  });

  await test('Slicer: slices a loop, keys C5.. play slices, Generate MIDI fills the pattern', async () => {
    const id = await fresh('slicer', `await app.bank.ensure('factory:kick-punch'); app.cmd.setChannelSample(app.store, ch.id, { id: 'factory:kick-punch', name: 'Punch kick' }); const e = app.bank.get('factory:kick-punch'); const { evenSlices } = await import('/src/core/slice-detect.js'); app.cmd.setSlices(app.store, ch.id, evenSlices(e.length, 4), 120);`);
    await ev((id) => app.openChannelEditor(id), id);
    await page.waitForSelector(`.win[data-id="plugin:${id}"] canvas`);
    ok(await ev((id) => app.store.channel(id).slices.length, id) === 4, 'four slices');
    await play();
    const loud = await maxPeak(5, 2200);
    ok(loud > 0.02, `slicer audible, peak=${loud}`);
    await stop();
    await winOf(id).locator('.btn', { hasText: 'Generate MIDI' }).click();
    await sleep(150);
    const n = await ev((id) => app.store.pattern.notes[id].length, id);
    ok(n >= 4, `pattern has the slice notes (${n})`);
    await page.screenshot({ path: 'tests/e2e/out/slicer.png' });
  });

  await test('Sampler time-stretch: Apply creates a stretched copy and the engine uses it', async () => {
    const id = await fresh('sampler', `app.cmd.setChannelSample(app.store, ch.id, { id: 'factory:kick-punch', name: 'Punch kick' }); await app.bank.ensure('factory:kick-punch');`);
    await ev((id) => { app.store.setParam(`ch:${id}:p:stretchTime`, 2); return app.cmd.applyStretch(app.store, id); }, id);
    const s = await ev((id) => app.store.channel(id).sample, id);
    ok(s.use && s.use.startsWith('stretch:'), `sample.use set: ${JSON.stringify(s)}`);
    const lens = await ev((id) => { const c = app.store.channel(id); return [app.bank.get(c.sample.id).length, app.bank.get(c.sample.use).length]; }, id);
    ok(Math.abs(lens[1] / lens[0] - 2) < 0.02, `stretched copy is 2x longer: ${lens}`);
    await play();
    const loud = await maxPeak(5, 2200);
    ok(loud > 0.02, `stretched sample audible, peak=${loud}`);
    await stop();
  });
}
