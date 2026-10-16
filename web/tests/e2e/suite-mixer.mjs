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
  // ---- Scope, Peak controller, Polish: start from the demo again (the tests above rearranged its mixer)
  const demo = () => ev(async () => {
    const { demoProject } = await import('/src/core/demo.js');
    app.transport.stop();
    await app.store.replaceProject(demoProject());
    for (const [wid, w] of app.wm.wins) if (!['mixer', 'rack'].includes(wid) && w.open) app.wm.close(wid);
    app.openWindow('mixer');
    app.cmd.selectTrack(app.store, 1);
    await new Promise((r) => setTimeout(r, 200));
  });
  const nextView = (track, slot, ms = 3000) => ev(({ track, slot, ms }) => new Promise((res) => {
    const off = app.host.bus.on('fxview', (m) => { if (m.track === track && m.slot === slot && m.view.peak[0] > 0.05) { off(); res({ peak: m.view.peak, cols: m.view.wave.length, corr: m.view.corr }); } });
    setTimeout(() => { off(); res(null); }, ms);
  }), { track, slot, ms });

  await test('Scope: picked from the slot menu, its window draws the live signal; closed, the engine stops sending', async () => {
    await demo();
    await page.locator('.mx-slot[data-slot="0"] .mx-slotname').click();
    await page.locator('.popup .item[data-label="Scope"]').click();
    ok(await ev(() => app.store.project.mixer.tracks[1].fx[0]?.type === 'scope'), 'Scope sits in slot 1');
    await page.locator('.mx-slot[data-slot="0"] .mx-slotname').click();
    await page.waitForSelector('.win[data-id="fx:1:0"] canvas.fx-scope');
    await play.click();
    const v = await nextView(1, 0);
    ok(v && v.cols === 1024 && v.peak[0] > 0.05, `scope views arrive while the window is open: ${JSON.stringify(v)}`);
    await sleep(600);
    const drawn = await ev(() => {
      const cv = document.querySelector('.win[data-id="fx:1:0"] canvas.fx-scope');
      const g = cv.getContext('2d'), d = g.getImageData(0, 0, cv.width, Math.floor(cv.height / 2)).data;
      let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 120 && d[i + 1] > 80) lit++;       // the orange trace of the left channel
      return { frames: +cv.dataset.frames || 0, lit };
    });
    ok(drawn.frames > 5 && drawn.lit > 200, `the oscilloscope is drawn: ${JSON.stringify(drawn)}`);
    ok(await maxPeak(1, 800) > 0.05, 'the kick still sounds through the Scope');
    await page.screenshot({ path: 'tests/e2e/out/scope.png' });
    await page.locator('.win[data-id="fx:1:0"] select').first().selectOption('2');            // View: Spectrum
    ok(await ev(() => app.store.project.mixer.tracks[1].fx[0].params.view === 2), 'view switched to the spectrum');
    await ev(() => app.wm.close('fx:1:0'));
    await sleep(300);
    ok((await nextView(1, 0, 1200)) === null, 'no views once the window is closed');
    await stop.click();
  });

  await test('Peak controller: a knob linked through its menu moves with the kick; the window lists the link; undo', async () => {
    await demo();
    await page.locator('.mx-slot[data-slot="1"] .mx-slotname').click();
    await page.locator('.popup .item[data-label="Peak controller"]').click();
    ok(await ev(() => app.store.project.mixer.tracks[1].fx[1]?.type === 'peakctl'), 'Peak controller in slot 2');
    const clap = await ev(() => app.store.project.channels.find((c) => c.mixer === 2).id);
    await ev(() => { app.openWindow('rack'); app.wm.focus('rack'); });
    const vol = page.locator(`.ch-row[data-ch="${clap}"] .knob`).nth(1);
    const b = await vol.boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
    await page.locator('.popup .item', { hasText: 'Link to controller' }).hover();
    await page.locator('.popup .item[data-label="Peak controller · Kick / slot 2"]').click(); await sleep(200);
    const link = await ev(() => app.store.project.mixer.tracks[1].fx[1].links);
    ok(link.length === 1 && link[0].addr === `ch:${clap}:vol`, `linked: ${JSON.stringify(link)}`);
    ok(await ev((id) => !!document.querySelector(`.ch-row[data-ch="${id}"] .knob.ctl`), clap), 'the knob shows it is driven by a controller');
    await ev(() => { app.store.setParam('mx:1:fx:1:p:release', 60); app.store.setParam('mx:1:fx:1:p:gain', 6); });
    await play.click();
    const seen = await ev(async (id) => { const v = []; const t0 = performance.now(); while (performance.now() - t0 < 1500) { v.push(app.store.channel(id).vol); await new Promise((r) => setTimeout(r, 15)); } return v; }, clap);
    const lo = Math.min(...seen), hi = Math.max(...seen);
    ok(hi - lo > 0.15 && lo >= link[0].min - 0.02 && hi <= link[0].max + 0.02, `the clap volume follows the kick: ${lo.toFixed(2)}..${hi.toFixed(2)} in ${link[0].min.toFixed(2)}..${link[0].max.toFixed(2)}`);
    await ev(() => app.openFxEditor(1, 1));
    await page.waitForSelector('.win[data-id="fx:1:1"] .fx-link');
    ok((await page.locator('.win[data-id="fx:1:1"]').innerText()).toLowerCase().includes('linked parameters'), 'its window lists the link');
    const m = await ev(async () => new Promise((res) => { const off = app.host.bus.on('fxmeter', (x) => { if (x.track === 1 && x.slot === 1 && x.values[0] > 0.1) { off(); res(x.values); } }); setTimeout(() => res(null), 3000); }));
    ok(m && m.length === 2, `level / output meters arrive: ${JSON.stringify(m)}`);
    await page.screenshot({ path: 'tests/e2e/out/peak-controller.png' });
    await stop.click();
    await page.locator('.win[data-id="fx:1:1"] .fx-link .btn', { hasText: '✕' }).click();
    ok(await ev(() => app.store.project.mixer.tracks[1].fx[1].links.length === 0), 'removed in the window');
    await ev(() => app.store.undo()); await sleep(100);
    ok(await ev(() => app.store.project.mixer.tracks[1].fx[1].links.length === 1), 'undo brings the link back');
  });

  await test('Polish: preset from the Browser, mode buttons, the plugin picker; the track never goes over 0 dBFS', async () => {
    await demo();
    const row = (label) => page.locator('#browser-pane .br-row', { hasText: label }).first();
    const expand = async (label) => { const r = row(label); if ((await r.locator('.br-caret').innerText()) === '▸') await r.click(); await sleep(150); };
    await ev(() => { app.browser.open = new Set(); app.browser.cache.clear(); app.browser.query = ''; app.browser.search.value = ''; app.showBrowser(true); });
    await sleep(250);
    await expand('Plugin presets'); await expand('Effects'); await expand('Polish');
    await row('Drum bus punch').dblclick(); await sleep(250);
    const fx = await ev(() => app.store.project.mixer.tracks[1].fx.find((f) => f && f.type === 'polish'));
    ok(fx && fx.params.amount === 65 && fx.params.mode === 3, `Polish preset on the kick track: ${JSON.stringify(fx && fx.params)}`);
    const slot = await ev(() => app.store.project.mixer.tracks[1].fx.findIndex((f) => f && f.type === 'polish'));
    await ev((s) => app.openFxEditor(1, s), slot);
    await page.locator(`.win[data-id="fx:1:${slot}"] [data-mode="2"]`).click();
    ok(await ev((s) => app.store.project.mixer.tracks[1].fx[s].params.mode === 2, slot), 'the Wide button sets the mode');
    await page.screenshot({ path: 'tests/e2e/out/polish.png' });
    await ev((s) => { app.store.setParam(`mx:1:fx:${s}:p:amount`, 100); app.store.setParam('mx:1:vol', 0.8); app.store.setParam('ch:' + app.store.project.channels[0].id + ':vol', 1); }, slot);
    await play.click();
    const pk = await maxPeak(1, 1500);
    ok(pk > 0.1 && pk < 1, `kick track through Polish at 100 %: peak ${pk}`);
    await stop.click();
    // the Plugin picker offers all three
    await ev(() => app.openWindow('picker'));
    const text = await page.locator('.win[data-id="picker"]').innerText();
    ok(['Scope', 'Peak controller', 'Polish'].every((n) => text.includes(n)), 'listed in the Plugin picker');
    await page.locator('.win[data-id="picker"] .item', { hasText: 'Scope' }).first().click();
    await page.locator('.win[data-id="picker"] .btn.primary').click(); await sleep(150);
    ok(await ev(() => app.store.project.mixer.tracks[1].fx.some((f) => f && f.type === 'scope')), 'Add puts it on the selected track');
    await ev(() => app.showBrowser(false));
  });
}
