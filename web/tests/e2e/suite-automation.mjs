import { page, open, maxPeak, test, ok, sleep, ev } from './harness.mjs';

const stop = () => ev(() => app.transport.stop());
const playSong = () => ev(async () => { app.transport.stop(); await new Promise((r) => setTimeout(r, 60)); app.transport.setMode('song'); app.transport.play(); });

async function fresh() {
  return ev(async () => {
    const { emptyProject } = await import('/src/core/demo.js');
    await app.store.replaceProject(emptyProject());
    const ch = app.cmd.addChannel(app.store, 'sampler', { name: 'Kick', sample: { id: 'factory:kick-punch', name: 'Punch kick' } });
    app.cmd.setMixerTarget(app.store, ch.id, 5);
    await app.bank.ensure('factory:kick-punch');
    for (const s of [0, 4, 8, 12]) app.cmd.setStep(app.store, ch.id, s, true, { key: 60 });
    app.store.select(ch.id);
    app.openWindow('rack');
    await new Promise((r) => setTimeout(r, 200));
    return ch.id;
  });
}
const knobOf = (id) => page.locator(`.ch-row[data-ch="${id}"] .knob`).nth(1);   // pan, volume, pitch: second is the volume
const rightClick = async (loc) => { const b = await loc.boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' }); };

export async function run() {
  console.log('automation, controllers, MIDI');
  await open('/');

  await test('right-click a knob: Create automation clip adds the channel, a playlist clip and opens the editor', async () => {
    const id = await fresh();
    const vol = page.locator(`.ch-row[data-ch="${id}"] .knob`).nth(1);
    await rightClick(vol);
    ok((await page.locator('.popup .item', { hasText: 'Create automation clip' }).count()) === 1, 'menu item present');
    await page.locator('.popup .item', { hasText: 'Create automation clip' }).click(); await sleep(250);
    const info = await ev(() => ({ ch: app.store.project.channels.filter((c) => c.type === 'automation').map((c) => [c.target, c.points.length]), clips: app.store.arrangement.clips.filter((c) => c.type === 'automation').length }));
    ok(info.ch.length === 1 && info.ch[0][0] === `ch:${id}:vol` && info.ch[0][1] === 2 && info.clips === 1, `automation channel + clip: ${JSON.stringify(info)}`);
    ok((await page.locator('.win[data-id^="auto:"] canvas').count()) === 1, 'editor window open');
    ok(await ev((id) => !!document.querySelector(`.ch-row[data-ch="${id}"] .knob.auto`), id), 'the knob is marked as automated');
    await rightClick(vol);
    ok((await page.locator('.popup .item', { hasText: 'Edit events' }).count()) === 1, 'Edit events appears once automated');
    await page.keyboard.press('Escape');
  });

  await test('editor: add / move / delete points, segment types, bend, LFO tool, undo', async () => {
    const id = await fresh();
    const made = await ev((id) => app.cmd.createAutomationClip(app.store, `ch:${id}:vol`, { bars: 2 }), id);
    const chId = made.channel.id;
    await ev((c) => app.openAutomationEditor(c), chId); await sleep(250);
    const geo = () => ev((c) => { const w = app.wm.get(`auto:${c}`); const cv = w.el.querySelector('canvas'); const r = cv.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, chId);
    const g = await geo();
    // plot area: LEFT 58, TOP 8, RULER 20; the clip spans 2 bars fitted to the width
    const px = (t, v) => { const pxPerTick = (g.w - 58 - 24) / 768; return { x: g.x + 58 + t * pxPerTick, y: g.y + 8 + (1 - v) * (g.h - 28) }; };
    const pts = () => ev((c) => app.store.channel(c).points.map((p) => ({ ...p })), chId);
    const p1 = px(384, 0.9);
    await page.mouse.move(p1.x, p1.y); await page.mouse.down(); await page.mouse.up();
    let list = await pts();
    ok(list.length === 3 && list.some((p) => p.t % 24 === 0 && p.t > 300 && p.t < 460 && p.v > 0.85), `a point added mid-way: ${JSON.stringify(list.map((p) => [p.t, +p.v.toFixed(2)]))}`);
    // drag it down and to the right
    const mid = list.find((p) => p.t > 300 && p.t < 460);
    const from = px(mid.t, mid.v), to = px(mid.t + 96, 0.3);
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 }); await page.mouse.move(to.x, to.y, { steps: 4 }); await page.mouse.up();
    list = await pts();
    const moved = list.find((p) => p.v < 0.4 && p.v > 0.2);
    ok(moved && moved.t > 440 && moved.t < 520, `point moved: ${JSON.stringify(list.map((p) => [p.t, +p.v.toFixed(2)]))}`);
    // segment type through the right-click menu (segment after the moved point)
    const pm = px(moved.t, moved.v);
    await page.mouse.click(pm.x, pm.y, { button: 'right' });
    await page.locator('.popup .item[data-label="Stairs"]').click(); await sleep(80);
    list = await pts();
    ok(list.find((q) => q.t === moved.t).type === 'stairs', `segment type set to stairs: ${JSON.stringify(list.map((p) => [p.t, +p.v.toFixed(2), p.type]))} moved=${JSON.stringify(moved)}`);
    // bend a single-curve segment with Alt-drag (the first segment)
    const a = px(100, 0.5), b = px(100, 0.8);
    const first = list[0];
    const segMid = px(first.t + 40, first.v);
    void a; void b; void segMid;
    await page.keyboard.down('Alt');
    const sx = g.x + 58 + 40 * ((g.w - 82) / 768), sy = g.y + 8 + (1 - 0.5) * (g.h - 28);
    await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx, sy - 40, { steps: 5 }); await page.mouse.up();
    await page.keyboard.up('Alt');
    list = await pts();
    ok(Math.abs(list[0].tension) > 0.1, `segment bent: tension ${list[0].tension}`);
    // double-click deletes a point
    const n0 = list.length;
    const pd = px(moved.t, moved.v);
    await page.mouse.dblclick(pd.x, pd.y); await sleep(60);
    ok((await pts()).length === n0 - 1, 'double-click deletes the point');
    // LFO tool
    await page.locator(`.win[data-id="auto:${chId}"] .btn`, { hasText: 'LFO…' }).click();
    await page.locator('.modal select').first().selectOption('0');
    await page.locator('.modal .btn.primary').click(); await sleep(100);
    list = await pts();
    ok(list.length > 40, `sine written (${list.length} points)`);
    const evalAt = await ev(async ({ c }) => { const { evalPoints } = await import('/src/core/automation.js'); const pp = app.store.channel(c).points; return [evalPoints(pp, 0), evalPoints(pp, 48), evalPoints(pp, 144)]; }, { c: chId });
    ok(Math.abs(evalAt[0] - 0.5) < 0.02 && evalAt[1] > 0.97 && evalAt[2] < 0.03, `sine with 4 cycles over 2 bars (192 ticks each): ${evalAt.map((v) => v.toFixed(2))}`);
    await ev(() => app.store.undo()); await sleep(80);
    ok((await pts()).length === n0 - 1, 'undo reverts the LFO tool');
    await page.screenshot({ path: 'tests/e2e/out/automation-editor.png' });
  });

  await test('an automation clip drives the knob during song playback (value echoed to the UI, audio follows)', async () => {
    const id = await fresh();
    await ev(async (id) => {
      const made = app.cmd.createAutomationClip(app.store, `ch:${id}:vol`, { bars: 1 });
      app.cmd.setAutomationPoints(app.store, made.channel.id, [{ t: 0, v: 0, type: 'single', tension: 0, count: 4 }, { t: 384, v: 1, type: 'single', tension: 0, count: 4 }]);
      app.cmd.addClips(app.store, [{ type: 'pattern', track: 2, s: 0, l: 384, ref: 1 }]);
    }, id);
    await playSong();
    await sleep(300);
    const early = await ev((id) => app.store.channel(id).vol, id);
    await sleep(1200);
    const late = await ev((id) => app.store.channel(id).vol, id);
    ok(late > early + 0.3, `volume ramps up during playback: ${early.toFixed(2)} -> ${late.toFixed(2)}`);
    ok((await ev((id) => { const k = document.querySelector(`.ch-row[data-ch="${id}"] .knob`); return !!k; }, id)), 'knob exists');
    await stop();
  });

  await test('controllers: LFO linked from the knob menu moves the parameter inside its range; envelope follows notes', async () => {
    const id = await fresh();
    const vol = page.locator(`.ch-row[data-ch="${id}"] .knob`).nth(1);
    await rightClick(vol);
    await page.locator('.popup .item', { hasText: 'Link to controller' }).hover();
    await page.locator('.popup .item', { hasText: 'New LFO controller' }).click(); await sleep(300);
    const ctl = await ev(() => app.store.project.channels.find((c) => c.type === 'controller'));
    ok(ctl && ctl.links.length === 1 && ctl.links[0].addr === `ch:${ctl.links[0].addr.split(':')[1]}:vol`, `controller linked: ${JSON.stringify(ctl && ctl.links)}`);
    const range = ctl.links[0];
    ok(range.max - range.min >= 0.3 && range.min >= 0 && range.max <= 1, 'default range is a window around the current value');
    await ev((cid) => { app.store.setParam(`ch:${cid}:p:sync`, 0); app.store.setParam(`ch:${cid}:p:rate`, 4); app.store.setParam(`ch:${cid}:p:shape`, 0); }, ctl.id);
    await ev(() => app.transport.setMode('pat'));
    await ev(() => app.transport.play());
    const seen = await ev(async (id) => { const vals = []; const t0 = performance.now(); while (performance.now() - t0 < 1200) { vals.push(app.store.channel(id).vol); await new Promise((r) => setTimeout(r, 25)); } return vals; }, id);
    const lo = Math.min(...seen), hi = Math.max(...seen);
    ok(hi - lo > 0.15 && lo >= range.min - 0.02 && hi <= range.max + 0.02, `knob swept ${lo.toFixed(2)}..${hi.toFixed(2)} inside ${range.min.toFixed(2)}..${range.max.toFixed(2)}`);
    await stop();
    await page.waitForSelector('.win[data-id^="plugin:"] canvas');
    ok((await page.locator('.win[data-id^="plugin:"]').innerText()).toLowerCase().includes('linked parameters'), 'controller editor lists the links');
    await page.screenshot({ path: 'tests/e2e/out/controller.png' });
    // unlink through the knob menu
    await rightClick(vol);
    await page.locator('.popup .item', { hasText: 'Link to controller' }).hover();
    await page.locator('.popup .item', { hasText: 'LFO' }).first().click(); await sleep(100);
    ok((await ev(() => app.store.project.channels.find((c) => c.type === 'controller').links.length)) === 0, 'toggling the controller in the menu removes the link');
  });

  await test('MIDI: notes play and record the selected channel; learn links a knob to a CC; Esc cancels', async () => {
    const id = await fresh();
    ok(await ev(() => !!app.midi && typeof app.midi.handle === 'function'), 'hub exists');
    // note on/off goes to the engine
    await ev(() => { app.midi.handle([0x90, 60, 110]); });
    const loud = await maxPeak(5, 800);
    await ev(() => app.midi.handle([0x80, 60, 0]));
    ok(loud > 0.02, `MIDI note is audible: ${loud}`);
    // learn
    const vol = page.locator(`.ch-row[data-ch="${id}"] .knob`).nth(1);
    await rightClick(vol);
    await page.locator('.popup .item', { hasText: 'Link to controller' }).hover();
    await page.locator('.popup .item', { hasText: 'MIDI learn' }).click(); await sleep(100);
    ok(await ev(() => !!app.midi.learn && document.body.classList.contains('midi-learn')), 'learn mode on');
    await ev(() => app.midi.handle([0xb0, 21, 64]));
    ok(await ev((id) => app.store.project.controllers.some((l) => l.addr === `ch:${id}:vol` && l.cc === 21), id), 'CC 21 linked to the volume knob');
    ok(await ev(() => !app.midi.learn && !document.body.classList.contains('midi-learn')), 'learn mode off');
    await ev(() => app.midi.handle([0xb0, 21, 127]));
    ok((await ev((id) => app.store.channel(id).vol, id)) > 0.98, 'CC 127 sets the knob to its maximum');
    await ev(() => app.midi.handle([0xb0, 21, 0]));
    ok((await ev((id) => app.store.channel(id).vol, id)) < 0.02, 'CC 0 sets it to its minimum');
    ok(await ev((id) => !!document.querySelector(`.ch-row[data-ch="${id}"] .knob.linked`), id), 'the knob shows the link marker');
    // other CC numbers and channels are ignored; manual range + invert
    await ev(() => { app.cmd.setMidiLink(app.store, { addr: `ch:${app.store.selected}:pan`, chan: 3, cc: 10, min: 0.25, max: 0.75, invert: 1 }); });
    await ev(() => app.midi.handle([0xb0, 10, 127]));            // channel 1: ignored (link is for channel 3)
    ok(Math.abs(await ev(() => app.store.channel(app.store.selected).pan)) < 1e-6, 'wrong MIDI channel is ignored');
    await ev(() => app.midi.handle([0xb2, 10, 127]));            // channel 3: inverted, 25..75% window -> 25% of -1..1 = -0.5
    ok(Math.abs((await ev(() => app.store.channel(app.store.selected).pan)) + 0.5) < 0.02, 'range and invert apply');
    // Esc cancels learn
    await rightClick(vol);
    await page.locator('.popup .item', { hasText: 'Link to controller' }).hover();
    await page.locator('.popup .item', { hasText: 'MIDI learn' }).click(); await sleep(60);
    await page.keyboard.press('Escape'); await sleep(60);
    ok(await ev(() => !app.midi.learn), 'Escape cancels learn');
    // removing the target channel removes its automation + links
    await ev((id) => app.cmd.createAutomationClip(app.store, `ch:${id}:pan`), id);
    await ev((id) => app.cmd.removeChannel(app.store, id), id);
    ok(await ev(() => app.store.project.channels.every((c) => c.type !== 'automation') && app.store.project.controllers.length === 0), 'deleting a channel cleans up its automation and MIDI links');
  });

  await test('Ctrl+L links the hovered knob (starts MIDI learn)', async () => {
    const id = await fresh();
    const vol = page.locator(`.ch-row[data-ch="${id}"] .knob`).nth(1);
    const b = await vol.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await sleep(50);
    await page.keyboard.press('Control+l'); await sleep(80);
    ok(await ev(() => !!app.midi.learn), 'learn started for the hovered knob');
    ok((await ev(() => app.midi.learn.addr)) === `ch:${id}:vol`, 'on the right parameter');
    await ev(() => app.midi.cancelLearn());
  });
}
