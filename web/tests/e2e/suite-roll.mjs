import { page, open, maxPeak, test, ok, sleep, ev } from './harness.mjs';

const play = () => ev(async () => { app.transport.stop(); await new Promise((r) => setTimeout(r, 60)); app.transport.play(); });
const stop = () => ev(() => app.transport.stop());

async function fresh() {
  return ev(async () => {
    const { emptyProject } = await import('/src/core/demo.js');
    await app.store.replaceProject(emptyProject());
    const ch = app.cmd.addChannel(app.store, 'sampler', { name: 'Keys', sample: { id: 'factory:kick-punch', name: 'Punch kick' } });
    app.cmd.setMixerTarget(app.store, ch.id, 5);
    await app.bank.ensure('factory:kick-punch');
    app.store.select(ch.id);
    app.openWindow('pianoroll');
    await new Promise((r) => setTimeout(r, 150));
    const r = app.pianoRoll;
    r.setTool('draw'); r.lastLen = 24; r.sel.clear(); r.chord.on = false; r.stamp = null; r.scale.lock = false; r.scale.id = 'chromatic';
    r.view.px = 0.5; r.view.rowH = 14; r.view.x0 = 0; r.centerOn(60); r.invalidate();
    app.store.setState(['settings', 'snap'], 'cell');
    return ch.id;
  });
}

// pixel position (page coords) of tick t / key k in the grid
const at = (t, k, dy = 0.5) => ev(({ t, k, dy }) => { const r = app.pianoRoll, b = r.grid.getBoundingClientRect(); return { x: b.left + r.tx(t), y: b.top + r.ky(k) + r.view.rowH * dy }; }, { t, k, dy });
const notes = (id) => ev((id) => app.store.pattern.notes[id] || [], id);
const click = async (t, k, opts = {}) => { const p = await at(t + (opts.dt || 0), k); await page.mouse.move(p.x, p.y); await page.mouse.down(opts); await page.mouse.up(opts); };

export async function run() {
  console.log('piano roll');
  await open('/');

  await test('F7 opens the piano roll; the grid, keys and event editor render', async () => {
    const id = await fresh();
    await page.keyboard.press('F7'); await sleep(100);       // toggles it closed...
    await page.keyboard.press('F7'); await sleep(200);       // ...and open again
    await page.waitForSelector('.win[data-id="pianoroll"] canvas.pr-grid');
    const sizes = await ev(() => { const r = app.pianoRoll; return [r.grid.width, r.grid.height, r.keys.height, r.laneCv.height].map((x) => x > 50); });
    ok(sizes.every(Boolean), `canvases sized: ${sizes}`);
    ok((await page.locator('.pr-head .seg .btn').count()) === 9, 'nine tool buttons');
    ok((await page.locator('.win[data-id="pianoroll"] .win-title').innerText()).includes('Keys'), 'title shows the channel');
    void id;
  });

  await test('draw tool: click adds a snapped note, sound plays; right-click deletes; one undo per gesture', async () => {
    const id = await fresh();
    await click(48 + 5, 64);                       // a bit after beat 1.5, E5 row
    let n = await notes(id);
    ok(n.length === 1, `one note, got ${n.length}`);
    ok(n[0].s === 48 && n[0].k === 64 && n[0].l === 24, `snapped to the grid: ${JSON.stringify(n[0])}`);
    await play();
    const loud = await maxPeak(5, 2200);
    ok(loud > 0.02, `note audible, peak=${loud}`);
    await stop();
    const p = await at(48 + 5, 64);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    n = await notes(id);
    ok(n.length === 0, 'right-click deleted it');
    await ev(() => app.store.undo()); await sleep(80);
    ok((await notes(id)).length === 1, 'undo brings it back');
  });

  await test('dragging moves a note in time and pitch as one undo step; edge drag resizes', async () => {
    const id = await fresh();
    await click(0, 60);
    const a = await at(10, 60), b = await at(10 + 96, 64);
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 }); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up();
    let n = await notes(id);
    ok(n.length === 1 && n[0].s === 96 && n[0].k === 64, `moved to beat 2, E5: ${JSON.stringify(n)}`);
    // resize: grab the right edge (note is 24 ticks long, edge at tick 96+24)
    const e1 = await at(96 + 24 - 1, 64), e2 = await at(96 + 24 + 48, 64);
    await page.mouse.move(e1.x, e1.y); await page.mouse.down(); await page.mouse.move(e2.x, e2.y, { steps: 6 }); await page.mouse.up();
    n = await notes(id);
    ok(n[0].l === 72, `resized to 72 ticks: ${n[0].l}`);
    // undo twice: resize, then move
    await ev(() => app.store.undo()); await sleep(60);
    ok((await notes(id))[0].l === 24, 'undo resize');
    await ev(() => app.store.undo()); await sleep(60);
    const u = (await notes(id))[0];
    ok(u.s === 0 && u.k === 60, `undo move restores creation spot: ${JSON.stringify(u)}`);
  });

  await test('paint tool fills cells while dragging; select rectangle + Delete', async () => {
    const id = await fresh();
    await ev(() => app.pianoRoll.setTool('paint'));
    const a = await at(0, 62), b = await at(24 * 7, 62);
    await page.mouse.move(a.x + 2, a.y); await page.mouse.down(); await page.mouse.move(b.x + 2, b.y, { steps: 12 }); await page.mouse.up();
    let n = await notes(id);
    ok(n.length === 8 && n.every((x, i) => x.s === i * 24 && x.k === 62), `eight painted cells: ${n.map((x) => x.s)}`);
    await ev(() => app.pianoRoll.setTool('select'));
    const s0 = await at(49, 64, 0), s1 = await at(143, 60, 1);
    await page.mouse.move(s0.x, s0.y); await page.mouse.down(); await page.mouse.move(s1.x, s1.y, { steps: 6 }); await page.mouse.up();
    ok(await ev(() => app.pianoRoll.sel.size) === 4, `four cells selected (cells 2..5)`);
    await page.keyboard.press('Delete'); await sleep(60);
    n = await notes(id);
    ok(n.length === 4 && n.every((x) => x.s < 48 || x.s >= 144), `deleted the selection: ${n.map((x) => x.s)}`);
    await page.keyboard.press('Control+a');
    ok(await ev(() => app.pianoRoll.sel.size) === 4, 'Ctrl+A selects all');
  });

  await test('chord tool places a triad; Tools: chop and glue; slice tool cuts', async () => {
    const id = await fresh();
    await ev(() => { const r = app.pianoRoll; r.chord.on = true; r.chord.id = 'min'; r.lastLen = 96; });
    await click(0, 60);
    let n = await notes(id);
    ok(n.length === 3 && n.map((x) => x.k).join() === '60,63,67', `C minor triad: ${n.map((x) => x.k)}`);
    ok(await ev(() => app.pianoRoll.propChord.textContent) === 'Cm', 'properties panel names the chord');
    await ev(() => { app.pianoRoll.chord.on = false; app.pianoRoll.refreshBtns(); });
    // Tools menu -> Chop (dialog)
    await page.locator('.pr-head .btn', { hasText: 'Tools' }).click();
    await page.locator('.popup .item', { hasText: 'Chop…' }).click();
    await page.locator('.modal input[type=number]').first().fill('2');
    await page.locator('.modal .btn.primary').click(); await sleep(80);
    n = await notes(id);
    ok(n.length === 6 && n.filter((x) => x.s === 48).length === 3, `each of 3 notes split in two: ${n.length}`);
    await page.locator('.pr-head .btn', { hasText: 'Tools' }).click();
    await page.locator('.popup .item', { hasText: 'Glue' }).click(); await sleep(80);
    n = await notes(id);
    ok(n.length === 3 && n.every((x) => x.l === 96), `glued back: ${JSON.stringify(n.map((x) => x.l))}`);
    // slice
    await ev(() => app.pianoRoll.setTool('slice'));
    const a = await at(48, 68), b = await at(48, 58);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
    n = await notes(id);
    ok(n.length === 6 && n.every((x) => x.l === 48), `three notes cut in half: ${n.length}`);
  });

  await test('event editor lane edits velocity; properties panel edits the selection', async () => {
    const id = await fresh();
    await click(0, 60);
    const vel0 = (await notes(id))[0].v;
    ok(vel0 === 100, 'default velocity');
    const lane = await ev(() => { const r = app.pianoRoll, b = r.laneCv.getBoundingClientRect(); return { x: b.left + r.tx(0) + 1, top: b.top, h: b.height }; });
    await page.mouse.move(lane.x, lane.top + lane.h * 0.5); await page.mouse.down(); await page.mouse.move(lane.x, lane.top + lane.h * 0.85, { steps: 4 }); await page.mouse.up();
    const v1 = (await notes(id))[0].v;
    ok(v1 < 50, `velocity dragged down: ${v1}`);
    await ev(() => { app.pianoRoll.propsOpen = true; app.pianoRoll.refreshBtns(); app.pianoRoll.layout(); });
    const inp = page.locator('.pr-props input[data-prop="v"]');
    await inp.fill('77'); await inp.press('Enter'); await sleep(60);
    ok((await notes(id))[0].v === 77, 'properties panel sets velocity');
    await page.locator('.pr-props input[data-prop="k"]').fill('D#5'); await page.keyboard.press('Enter'); await sleep(60);
    ok((await notes(id))[0].k === 63, 'key typed as a note name');
  });

  await test('scale highlight + lock to scale; slide notes; arrow keys move the selection', async () => {
    const id = await fresh();
    await ev(() => { const r = app.pianoRoll; r.scale.id = 'major'; r.scale.root = 0; r.scale.lock = true; r.invalidate(); });
    await click(0, 61);                       // C#5 is not in C major -> snaps to C5
    ok((await notes(id))[0].k === 60, 'lock snaps into the scale');
    await page.keyboard.press('ArrowUp'); await sleep(40);
    ok((await notes(id))[0].k === 61, 'arrow up moves one semitone');
    await page.keyboard.press('Shift+ArrowUp'); await sleep(40);
    ok((await notes(id))[0].k === 73, 'shift+arrow moves an octave');
    await page.keyboard.press('ArrowRight'); await sleep(40);
    ok((await notes(id))[0].s === 24, 'arrow right moves by the snap');
    await page.locator('.pr-head .btn', { hasText: 'Slide' }).click(); await sleep(40);
    ok((await notes(id))[0].slide === 1, 'slide flag set');
    await page.screenshot({ path: 'tests/e2e/out/roll.png' });
  });

  await test('Ctrl+drag copies notes in one undo step', async () => {
    const id = await fresh();
    await click(0, 60);
    const a = await at(12, 60), b = await at(12 + 96, 64);
    await page.keyboard.down('Control');
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up();
    await page.keyboard.up('Control');
    let n = await notes(id);
    ok(n.length === 2 && n.some((x) => x.s === 0 && x.k === 60) && n.some((x) => x.s === 96 && x.k === 64), `copy left the original: ${JSON.stringify(n.map((x) => [x.s, x.k]))}`);
    await ev(() => app.store.undo()); await sleep(60);
    n = await notes(id);
    ok(n.length === 1 && n[0].s === 0, 'one undo removes the copy');
  });

  await test('arpeggiator turns a chord into a run, selection follows into view', async () => {
    const id = await fresh();
    await ev((id) => { app.cmd.addNotes(app.store, id, [60, 64, 67].map((k) => ({ s: 0, l: 96, k, v: 100 }))); }, id);
    await page.keyboard.press('Control+a');
    await page.locator('.pr-head .btn', { hasText: 'Tools' }).click();
    await page.locator('.popup .item', { hasText: 'Arpeggiator…' }).click();
    await page.locator('.modal .btn.primary').click(); await sleep(80);
    const n = await notes(id);
    ok(n.length === 4 && n.map((x) => x.k).join() === '60,64,67,60' && n.map((x) => x.s).join() === '0,24,48,72', `up arpeggio: ${JSON.stringify(n.map((x) => [x.s, x.k]))}`);
    // far-away notes are scrolled into view by reveal()
    await ev((id) => { app.cmd.addNotes(app.store, id, [{ s: 1920, l: 48, k: 100, v: 100 }]); app.pianoRoll.setSel(app.store.pattern.notes[id].filter((x) => x.k === 100).map((x) => x.id)); app.pianoRoll.reveal(); }, id);
    const vis = await ev(() => { const r = app.pianoRoll; return r.xt(0) <= 1920 && r.xt(r.W) >= 1968 && r.yk(0) >= 100 && r.yk(r.gridH) <= 100; });
    ok(vis, 'selection revealed');
  });

  await test('visual check: notes, colours, slide, velocity, ghost notes, minor scale', async () => {
    const id = await fresh();
    await ev(async (id) => {
      const r = app.pianoRoll;
      const other = app.cmd.addChannel(app.store, 'sampler', { name: 'Ghost' });
      app.store.select(id);
      app.cmd.addNotes(app.store, other.id, [0, 48, 96, 144, 192, 240, 288, 336].map((s, i) => ({ s, l: 24, k: 48 + (i % 3) * 7, v: 90 })));
      const mel = [[0, 48, 69], [48, 24, 72], [72, 24, 71], [96, 96, 69], [192, 48, 67], [240, 48, 64], [288, 96, 62]];
      app.cmd.addNotes(app.store, id, mel.map(([s, l, k], i) => ({ s, l, k, v: 60 + i * 9, slide: i === 2 ? 1 : undefined, c: i === 5 ? 6 : undefined })));
      app.cmd.addNotes(app.store, id, [57, 60, 64].map((k) => ({ s: 192, l: 192, k, v: 80 })));
      r.scale.id = 'minor'; r.scale.root = 9; r.scaleSel.value = 'minor'; r.scaleRoot.value = '9'; r.propsOpen = true; r.refreshBtns(); r.layout();
      r.centerOn(63); r.view.px = 0.9; r.setSel(app.store.pattern.notes[id].filter((n) => n.k === 69).map((n) => n.id)); r.invalidate();
    }, id);
    await sleep(300);
    await page.screenshot({ path: 'tests/e2e/out/roll-visual.png' });
  });

  await test('Ctrl+C / Ctrl+V duplicate notes at the cursor', async () => {
    const id = await fresh();
    await click(0, 60); await click(48, 62);
    await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c');
    await click(192 + 0, 70);                          // moves the paste cursor (draws a note too)
    await ev((id) => { const r = app.pianoRoll; r.cursorT = 384; r.setSel([]); }, id);
    await ev(() => app.pianoRoll.setSel(app.pianoRoll.notes.filter((n) => n.k !== 70).map((n) => n.id)));
    await page.keyboard.press('Control+c');
    await ev(() => { app.pianoRoll.cursorT = 384; });
    await page.keyboard.press('Control+v'); await sleep(60);
    const n = await notes(id);
    ok(n.filter((x) => x.s >= 384).length === 2 && n.length === 5, `pasted two notes at bar 2: ${JSON.stringify(n.map((x) => [x.s, x.k]))}`);
  });

  await test('zoom: Ctrl+wheel zooms time; quantize snaps off-grid notes; playback tool plays', async () => {
    const id = await fresh();
    const px0 = await ev(() => app.pianoRoll.view.px);
    const p = await at(100, 60);
    await page.mouse.move(p.x, p.y);
    await page.keyboard.down('Control'); await page.mouse.wheel(0, -200); await page.keyboard.up('Control'); await sleep(60);
    ok((await ev(() => app.pianoRoll.view.px)) > px0 * 1.1, 'horizontal zoom increased');
    await ev(() => { app.pianoRoll.view.px = 0.5; app.pianoRoll.view.x0 = 0; app.pianoRoll.invalidate(); });
    await ev((id) => app.cmd.addNotes(app.store, id, [{ s: 13, l: 20, k: 60, v: 100 }, { s: 61, l: 20, k: 62, v: 100 }]), id);
    await page.keyboard.press('Control+a'); await page.keyboard.press('Control+q'); await sleep(60);
    const n = await notes(id);
    ok(n.map((x) => x.s).join() === '24,72', `quick quantize to the 1/16 grid: ${n.map((x) => x.s)}`);
    await ev(() => app.pianoRoll.setTool('playback'));
    const a = await at(0, 60);
    await page.mouse.move(a.x + 1, a.y); await page.mouse.down();
    const peak = await maxPeak(5, 1500);
    await page.mouse.up(); await sleep(150);
    ok(peak > 0.02, `playback tool plays the pattern: ${peak}`);
    ok(!(await ev(() => app.transport.playing)), 'stops on release');
  });

  await test('riff machine and arpeggiator generate in-key, audible notes', async () => {
    const id = await fresh();
    await ev(() => { const r = app.pianoRoll; r.scale.id = 'minor'; r.scale.root = 9; r.invalidate(); });
    await page.locator('.pr-head .btn', { hasText: 'Tools' }).click();
    await page.locator('.popup .item', { hasText: 'Riff machine…' }).click();
    await page.locator('.modal .btn.primary').click(); await sleep(100);
    const n = await notes(id);
    ok(n.length >= 6, `riff generated ${n.length} notes`);
    ok(await ev(async (id) => { const { inScale } = await import('/src/core/scales.js'); return app.store.pattern.notes[id].every((x) => inScale(x.k, 9, 'minor')); }, id), 'riff stays in A minor');
    await play();
    ok((await maxPeak(5, 2500)) > 0.02, 'riff is audible');
    await stop();
  });
}
