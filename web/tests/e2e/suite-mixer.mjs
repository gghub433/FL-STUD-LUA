import { page, open, maxPeak, test, ok, sleep, ev } from './harness.mjs';

// deterministic transport helpers (clicking the Play button toggles, which is fragile after a failed test)
const play = { click: async () => ev(async () => { app.transport.stop(); await new Promise((r) => setTimeout(r, 60)); app.transport.play(); }) };
const stop = { click: async () => ev(() => app.transport.stop()) };
const playBtn = 'PLAY', stopBtn = 'STOP';

export async function run() {
  console.log('mixer');
  await open('/');

  await test('F9 opens the mixer with 126 strips; clicking selects a track', async () => {
    await page.keyboard.press('F9');
    await page.waitForSelector('.win[data-id="mixer"]');
    ok((await page.locator('.mx-strip').count()) === 126, 'expected master + 125 inserts');
    await page.locator('.mx-strip[data-track="1"]').click({ position: { x: 30, y: 20 } });
    ok(await ev(() => app.store.project.mixer.selected === 1), 'track 1 should be selected');
    ok((await page.locator('.mx-dname').innerText()).includes('Kick'), 'detail panel shows the Kick track');
    ok(await page.locator('.mx-linked .chip').count() === 1, 'one channel is linked to track 1');
  });

  await test('fader drag changes the volume and the metered level', async () => {
    await play.click();
    const before = await maxPeak(1, 1500);
    const fader = page.locator('.mx-strip[data-track="1"] .fader');
    const box = await fader.boundingBox();
    await page.mouse.move(box.x + 12, box.y + 40); await page.mouse.down();
    await page.mouse.move(box.x + 12, box.y + 100, { steps: 6 }); await page.mouse.up();
    const vol = await ev(() => app.store.project.mixer.tracks[1].vol);
    ok(vol < 0.7, `fader should have dropped, vol=${vol}`);
    await sleep(300);
    const after = await maxPeak(1, 1500);
    ok(after < before * 0.7, `meter should fall: ${before} -> ${after}`);
    await fader.dblclick();
    ok(Math.abs(await ev(() => app.store.project.mixer.tracks[1].vol) - 0.8) < 1e-6, 'double-click resets to 0 dB');
    await stop.click();
  });

  await test('empty slot opens the effect list; EQ editor shows a live spectrum from the engine', async () => {
    await page.locator('.mx-slot[data-slot="0"] .mx-slotname').click();
    await page.locator('.popup .item', { hasText: 'Parametric EQ' }).click();
    ok(await ev(() => app.store.project.mixer.tracks[1].fx[0]?.type === 'eq'), 'EQ should sit in slot 1');
    await page.locator('.mx-slot[data-slot="0"] .mx-slotname').click();
    await page.waitForSelector('.win[data-id="fx:1:0"]');
    await play.click();
    await sleep(900);
    const has = await ev(() => { const w = app.wm.get('fx:1:0'); return !!w; });
    ok(has, 'fx window open');
    // the engine posts spectrum frames for the watched slot
    const got = await ev(async () => new Promise((res) => { const off = app.host.bus.on('spectrum', (m) => { off(); res({ track: m.track, slot: m.slot, max: Math.max(...m.mags) }); }); setTimeout(() => res(null), 3000); }));
    ok(got && got.track === 1 && got.slot === 0 && got.max > -60, `spectrum frame: ${JSON.stringify(got)}`);
    await stop.click();
  });

  await test('dragging an EQ node edits frequency and gain', async () => {
    const canvas = page.locator('.win[data-id="fx:1:0"] canvas').first();
    const box = await canvas.boundingBox();
    // band 4 sits at 1 kHz, 0 dB: x = log(1000/20)/log(1000) * W
    const x = box.x + (Math.log(1000 / 20) / Math.log(1000)) * box.width, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + 60, y - 40, { steps: 8 }); await page.mouse.up();
    const p = await ev(() => app.store.project.mixer.tracks[1].fx[0].params);
    ok(p.b4freq > 1200, `frequency should move up: ${p.b4freq}`);
    ok(p.b4gain > 3, `gain should rise: ${p.b4gain}`);
  });

  await test('compressor: gain-reduction meter messages arrive and the sound is reduced', async () => {
    await ev(() => app.cmd.setFx(app.store, 2, 0, 'compressor'));
    await ev(() => { app.store.setParam('mx:2:fx:0:p:threshold', -40); app.store.setParam('mx:2:fx:0:p:ratio', 20); });
    await play.click();
    await ev(() => app.cmd.selectTrack(app.store, 2));
    await ev(() => app.openFxEditor(2, 0));
    await sleep(500);
    const m = await ev(async () => new Promise((res) => { const off = app.host.bus.on('fxmeter', (x) => { if (x.track === 2 && x.values[0] < -3) { off(); res(x.values); } }); setTimeout(() => res(null), 4000); }));
    ok(m && m[0] < -3, `gain reduction should show: ${JSON.stringify(m)}`);
    await stop.click();
  });

  await test('routing: arrow adds a send, Shift makes it a sidechain, loops are refused', async () => {
    await ev(() => app.cmd.selectTrack(app.store, 1));
    await page.locator('.mx-strip[data-track="5"] .mx-route').click();
    ok(await ev(() => app.store.project.mixer.tracks[1].routes.some((r) => r[0] === 5 && !r[2])), 'send 1 -> 5');
    await page.locator('.mx-strip[data-track="6"] .mx-route').click({ modifiers: ['Shift'] });
    ok(await ev(() => app.store.project.mixer.tracks[1].routes.some((r) => r[0] === 6 && r[2] === 1)), 'sidechain 1 -> 6');
    await ev(() => app.cmd.selectTrack(app.store, 5));
    await page.locator('.mx-strip[data-track="1"] .mx-route').click();
    ok(await ev(() => !app.store.project.mixer.tracks[5].routes.some((r) => r[0] === 1)), 'a loop 5 -> 1 must be refused');
    await page.locator('.mx-strip[data-track="5"] .mx-route').click(); // 5 -> master toggle
    ok(await ev(() => app.store.project.mixer.tracks[5].routes.length === 0), 'toggling the master arrow removes the route');
  });

  await test('solo keeps the routing chain; mute silences', async () => {
    await ev(() => { app.store.project.mixer.tracks[5].routes = [[0, 1, 0]]; app.store.touch([['mixer', 'tracks', 5]]); });
    await play.click();
    await page.locator('.mx-strip[data-track="3"] .mx-btns .btn >> nth=1').click();
    await sleep(500);
    const hats = await maxPeak(3, 800), kick = await maxPeak(1, 800), master = await maxPeak(0, 400);
    ok(hats > 0.02, `soloed hats must play: ${hats}`);
    ok(kick < 0.01, `unsoloed kick must be silent: ${kick}`);
    ok(master > 0.02, 'master still passes the soloed track');
    await page.locator('.mx-strip[data-track="3"] .mx-btns .btn >> nth=1').click();
    await page.locator('.mx-strip[data-track="1"] .mx-btns .btn >> nth=0').click();
    await sleep(500);
    ok(await maxPeak(1, 800) < 0.01, 'muted kick silent');
    await page.locator('.mx-strip[data-track="1"] .mx-btns .btn >> nth=0').click();
    await stop.click();
  });

  await test('effect slots can be reordered by dragging', async () => {
    const before = await ev(() => app.store.project.mixer.tracks[1].fx.map((f) => f && f.type));
    ok(before[0] === 'eq', 'precondition');
    await ev(() => app.cmd.selectTrack(app.store, 1));
    const a = await page.locator('.mx-slot[data-slot="0"] .mx-slotname').boundingBox();
    const b = await page.locator('.mx-slot[data-slot="3"] .mx-slotname').boundingBox();
    await page.mouse.move(a.x + 30, a.y + 8); await page.mouse.down();
    await page.mouse.move(b.x + 30, b.y + 8, { steps: 10 }); await page.mouse.up();
    const after = await ev(() => app.store.project.mixer.tracks[1].fx.map((f) => f && f.type));
    ok(after[3] === 'eq' && after[0] === null, `EQ should now be in slot 4: ${JSON.stringify(after)}`);
  });

  await test('gross-beat style effect: pick a slot, edit a curve point', async () => {
    await ev(() => { app.cmd.setFx(app.store, 4, 0, 'grossbeat'); app.openFxEditor(4, 0); });
    await page.waitForSelector('.win[data-id="fx:4:0"]');
    await page.locator('.win[data-id="fx:4:0"] [data-slot="11"]').click();
    ok(await ev(() => app.store.project.mixer.tracks[4].fx[0].params.slot === 11), 'slot 12 selected');
    const cv = page.locator('.win[data-id="fx:4:0"] canvas').first();
    const box = await cv.boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
    const slots = await ev(() => app.store.project.mixer.tracks[4].fx[0].extra && app.store.project.mixer.tracks[4].fx[0].extra.slots);
    ok(slots && slots.length === 36, '36 slots materialized after editing');
    ok(slots[0].time.some((p) => Math.abs(p[0] - 0.5) < 0.02), 'a new point was added near the middle');
  });

  await test('convolution reverb: choosing an IR adds a tail', async () => {
    await ev(() => { app.cmd.setFx(app.store, 7, 0, 'convolver'); });
    await ev(async () => { await app.bank.ensure('factory:ir-hall'); app.cmd.setFxExtra(app.store, 7, 0, { irId: 'factory:ir-hall' }); });
    await ev(() => { const ch = app.store.project.channels[1]; app.cmd.setMixerTarget(app.store, ch.id, 7); app.store.setParam('mx:7:fx:0:p:dry', -60); app.store.setParam('mx:7:fx:0:p:wet', 0); });
    await play.click();
    await sleep(1500);
    ok(await maxPeak(7, 1500) > 0.01, 'convolver output should be audible');
    await stop.click();
  });
}
