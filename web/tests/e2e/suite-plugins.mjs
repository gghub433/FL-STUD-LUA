import { page, open, maxPeak, test, ok, sleep, ev } from './harness.mjs';

const play = () => ev(async () => { app.transport.stop(); await new Promise((r) => setTimeout(r, 60)); app.transport.play(); });
const stop = () => ev(() => app.transport.stop());

async function withInstrument(type) {
  return ev(async (type) => {
    const { emptyProject } = await import('/src/core/demo.js');
    await app.store.replaceProject(emptyProject());
    const ch = app.addInstrument(type);
    app.cmd.setMixerTarget(app.store, ch.id, 5);
    app.cmd.setStep(app.store, ch.id, 0, true, { key: 57 });
    app.cmd.setStep(app.store, ch.id, 8, true, { key: 64 });
    await new Promise((r) => setTimeout(r, 200));
    return ch.id;
  }, type);
}

export async function run() {
  console.log('plugins & branding');
  await open('/');

  await test('the app is called FL LUA: title, menu-bar brand with the new logo, favicon', async () => {
    ok((await page.title()) === 'FL LUA', `title ${await page.title()}`);
    ok((await page.locator('.app-name').innerText()).trim() === 'FL LUA', 'menu-bar brand');
    const logo = await page.locator('.app-name img.app-logo');
    ok(await logo.evaluate((i) => i.complete && i.naturalWidth > 0), 'logo image loads');
    const icon = await page.evaluate(() => document.querySelector('link[rel=icon]').href);
    ok(icon.endsWith('assets/icon.svg'), icon);
    const r = await page.request.get(icon); ok(r.ok(), 'icon served');
    await page.locator('.menu-top', { hasText: 'HELP' }).click();
    ok((await page.locator('.popup .item', { hasText: 'About FL LUA' }).count()) === 1, 'About FL LUA menu item');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: 'tests/e2e/out/brand.png', clip: { x: 0, y: 0, width: 520, height: 110 } });
  });

  await test('the plugin picker lists the new generators and effects', async () => {
    await ev(() => app.openWindow('picker'));
    await page.waitForSelector('.win[data-id="picker"]');
    const text = await page.locator('.win[data-id="picker"]').innerText();
    for (const n of ['Pluck', 'Organ', 'Wavetable', 'Tremolo / Auto-pan', 'Transient Shaper', 'Pitch Shifter', 'Frequency Shifter', 'Tape Saturator']) ok(text.includes(n), `picker lists ${n}`);
    await ev(() => app.wm.close('picker'));
  });

  for (const [type, label] of [['pluck', 'Pluck'], ['organ', 'Organ'], ['wavetable', 'Wavetable']]) {
    await test(`${label}: added from the menu path, editor opens, sound comes out of the AudioWorklet`, async () => {
      const id = await withInstrument(type);
      await page.waitForSelector(`.win[data-id="plugin:${id}"]`);
      await play();
      const loud = await maxPeak(5, 2300);
      ok(loud > 0.02, `${label} audible, peak=${loud}`);
      await stop();
      await page.screenshot({ path: `tests/e2e/out/plugin-${type}.png` });
    });
  }

  await test('organ drawbars: dragging a drawbar sets its level; registrations set all nine', async () => {
    const id = await withInstrument('organ');
    const bar = page.locator(`.win[data-id="plugin:${id}"] .organ-bar[data-bar="3"] .organ-track`);
    const b = await bar.boundingBox();
    await page.mouse.move(b.x + 4, b.y + 2); await page.mouse.down(); await page.mouse.move(b.x + 4, b.y + b.height * 0.75, { steps: 5 }); await page.mouse.up();
    const lv = await ev((id) => app.store.channel(id).params.d3, id);
    ok(lv === 6, `drawbar 4' dragged to 6, got ${lv}`);
    await page.locator(`.win[data-id="plugin:${id}"] .btn`, { hasText: 'Gospel' }).click(); await sleep(60);
    const p = await ev((id) => app.store.channel(id).params, id);
    ok([p.d0, p.d1, p.d2, p.d3, p.d4, p.d5, p.d6, p.d7, p.d8].join() === '8,8,8,6,4,4,2,2,4', 'Gospel registration');
    await play(); ok((await maxPeak(5, 1500)) > 0.02, 'still audible'); await stop();
  });

  await test('instrument presets: factory preset loads as one undo step and changes the sound; user presets can be saved', async () => {
    const id = await withInstrument('wavetable');
    await page.locator(`.win[data-id="plugin:${id}"] .btn`, { hasText: 'Presets' }).click();
    await page.locator('.popup .item', { hasText: 'Sweep bass' }).click(); await sleep(80);
    const p = await ev((id) => app.store.channel(id).params, id);
    ok(p.table === 3 && p.sub === 0.5 && p.cutoff === 1800, `preset applied: ${JSON.stringify({ t: p.table, s: p.sub, c: p.cutoff })}`);
    await ev(() => app.store.undo()); await sleep(80);
    ok((await ev((id) => app.store.channel(id).params.table, id)) === 0, 'one undo restores the previous sound');
    await ev((id) => { localStorage.removeItem('stepwise.instpresets.wavetable'); }, id);
    await page.locator(`.win[data-id="plugin:${id}"] .btn`, { hasText: 'Presets' }).click();
    await page.locator('.popup .item', { hasText: 'Save preset…' }).click();
    await page.locator('.modal input.field').fill('My lead'); await page.locator('.modal .btn.primary').click(); await sleep(80);
    await page.locator(`.win[data-id="plugin:${id}"] .btn`, { hasText: 'Presets' }).click();
    ok((await page.locator('.popup .item', { hasText: 'My lead' }).count()) === 1, 'saved preset listed under My presets');
    await page.keyboard.press('Escape');
    await play(); ok((await maxPeak(5, 1500)) > 0.02, 'audible after loading presets'); await stop();
  });

  await test('wavetable editor: dragging the display scans the position; table picker changes the picture', async () => {
    const id = await withInstrument('wavetable');
    const cv = page.locator(`.win[data-id="plugin:${id}"] canvas`).first();
    const b = await cv.boundingBox();
    await page.mouse.move(b.x + 20, b.y + 60); await page.mouse.down(); await page.mouse.move(b.x + b.width * 0.5, b.y + 60, { steps: 6 }); await page.mouse.up();
    const pos = await ev((id) => app.store.channel(id).params.pos, id);
    ok(pos > 0.3 && pos < 0.8, `position scanned: ${pos}`);
  });

  for (const [type, label, check] of [
    ['tremolo', 'Tremolo / Auto-pan', 'rate'], ['transient', 'Transient Shaper', 'attack'], ['pitchshift', 'Pitch Shifter', 'semi'], ['freqshift', 'Frequency Shifter', 'shift'], ['tape', 'Tape Saturator', 'drive'],
  ]) {
    await test(`${label}: loads in an insert, window shows its controls and presets, audio passes through`, async () => {
      await ev(async () => {
        const { demoProject } = await import('/src/core/demo.js');
        await app.store.replaceProject(demoProject());
      });
      await ev((type) => { app.cmd.selectTrack(app.store, 1); app.cmd.setFx(app.store, 1, 0, type); app.openFxEditor(1, 0); }, type);
      await page.waitForSelector('.win[data-id="fx:1:0"]');
      ok((await page.locator('.win[data-id="fx:1:0"] .knob').count()) >= 3, 'knobs present');
      await page.locator('.win[data-id="fx:1:0"] .btn', { hasText: 'Presets' }).click();
      ok((await page.locator('.popup .item', { hasText: /Factory|presets/i }).count()) >= 1 || (await page.locator('.popup .title').count()) >= 1, 'preset menu has factory entries');
      await page.keyboard.press('Escape');
      await play();
      const peak = await maxPeak(1, 2000);
      ok(peak > 0.02 && peak < 4, `audio flows through ${label}: ${peak}`);
      await stop();
      const v = await ev(({ check }) => app.store.project.mixer.tracks[1].fx[0].params[check], { check });
      ok(typeof v === 'number', 'parameter reachable');
      await page.screenshot({ path: `tests/e2e/out/fx-${type}.png` });
    });
  }
}
