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
// Tools > Scripts > item (and an item of its submenu)
const scriptMenu = async (item, sub) => {
  await page.locator('.pr-head .btn', { hasText: 'Tools' }).click();
  await page.locator('.popup .item', { hasText: 'Scripts' }).first().hover(); await sleep(250);
  if (sub) { await page.locator('.popup .item', { hasText: item }).last().hover(); await sleep(250); }
  await page.locator('.popup .item', { hasText: sub || item }).last().click(); await sleep(150);
};
// sets a field of the open dialog by its label, like a person would (range: input event, others: change)
const setField = (label, value) => ev(({ label, value }) => {
  const row = [...document.querySelectorAll('.modal .row')].find((r) => r.firstChild && r.firstChild.textContent === label);
  const el = row.querySelector('input, select');
  if (el.type === 'checkbox') el.checked = !!value; else el.value = String(value);
  el.dispatchEvent(new Event(el.type === 'range' ? 'input' : 'change', { bubbles: true }));
}, { label, value });
const history = () => ev(() => app.store.history.length);
const scriptError = () => ev(() => { const e = document.querySelector('.modal .rs-error'); return e && e.style.display !== 'none' ? e.textContent : ''; });
const SCRIPTS_KEY = 'stepwise.rollscripts';
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

  await test('scripts: a factory script previews live, Cancel restores, OK is one undo step', async () => {
    const id = await fresh();
    await ev((id) => app.cmd.addNotes(app.store, id, [0, 24, 48, 72, 96].map((s) => ({ s, l: 24, k: 60, v: 100 }))), id);
    const vels = async () => (await notes(id)).map((n) => n.v).join();
    const h0 = await history();
    await scriptMenu('Velocity curve…');
    await page.waitForSelector('.modal .rs-desc'); await sleep(150);
    ok(await vels() === '40,60,80,100,120', `preview with the defaults: ${await vels()}`);
    await setField('Lowest velocity', 20); await sleep(150);
    ok(await vels() === '20,45,70,95,120', `a slider change applies at once: ${await vels()}`);
    ok(await history() === h0, 'the preview adds no undo step');
    await page.screenshot({ path: 'tests/e2e/out/roll-script.png' });
    await page.locator('.modal .btn', { hasText: 'Cancel' }).click(); await sleep(100);
    ok(await vels() === '100,100,100,100,100', `Cancel restores: ${await vels()}`);
    ok(await history() === h0, 'Cancel leaves the history alone');
    await scriptMenu('Velocity curve…');
    await page.waitForSelector('.modal .rs-desc');
    await setField('Shape', 'down'); await sleep(150);
    await page.locator('.modal .btn.primary').click(); await sleep(150);
    ok(await vels() === '120,100,80,60,40', `OK keeps the result: ${await vels()}`);
    ok(await history() === h0 + 1, 'exactly one undo step');
    ok(await ev(() => app.store.history[app.store.history.length - 1].label) === 'Script: Velocity curve', 'labelled with the script');
    await ev(() => app.store.undo()); await sleep(100);
    ok(await vels() === '100,100,100,100,100', 'undo restores the notes');
    // a generator on an empty roll: Euclidean rhythm fills the pattern
    await ev((id) => app.cmd.deleteNotes(app.store, id, app.store.pattern.notes[id].map((n) => n.id)), id);
    await scriptMenu('Euclidean rhythm…');
    await page.waitForSelector('.modal .rs-desc');
    await setField('Steps', 8); await setField('Pulses', 3); await sleep(150);
    await page.locator('.modal .btn.primary').click(); await sleep(150);
    ok((await notes(id)).map((n) => n.s).join() === '0,72,144,192,264,336', `3 in 8: ${(await notes(id)).map((n) => n.s)}`);
  });

  await test('scripts: the Scripts menu and the script dialog in Russian', async () => {
    const id = await fresh();
    await ev((id) => app.cmd.addNotes(app.store, id, [{ s: 0, l: 24, k: 60, v: 100 }]), id);
    await ev(() => app.setPref('lang', 'ru')); await sleep(300);
    try {
      await ev(() => app.pianoRoll.toolsBtn.click()); await sleep(150);
      await page.locator('.popup .item', { hasText: 'Скрипты' }).first().hover(); await sleep(300);
      const items = await page.locator('.popup').last().locator('.item').allInnerTexts();
      ok(items.includes('Очеловечить…') && items.includes('Евклидов ритм…') && items.includes('Новый скрипт…'), `submenu: ${items.join(' | ')}`);
      await page.locator('.popup .item', { hasText: 'Кривая силы…' }).last().click();
      await page.waitForSelector('.modal .rs-desc'); await sleep(200);
      ok((await page.locator('.modal .modal-title').innerText()) === 'Кривая силы', 'dialog title');
      const body = await page.locator('.modal .modal-body').innerText();
      ok(body.includes('Наименьшая сила') && body.includes('Задаёт силу нажатия по кривой') && body.includes('Нарастание') && body.includes('Новое зерно'), `dialog: ${body.slice(0, 200)}`);
      await page.screenshot({ path: 'tests/e2e/out/roll-script-ru.png' });
      await page.locator('.modal .btn', { hasText: 'Отмена' }).click(); await sleep(100);
      ok((await notes(id))[0].v === 100, 'cancelled');
    } finally { await ev(() => app.setPref('lang', 'en')); await sleep(200); }
  });

  await test('scripts: write a user script, it survives a reload and runs on the selection', async () => {
    await ev((k) => localStorage.removeItem(k), SCRIPTS_KEY);
    await fresh();
    await scriptMenu('New script…');
    await page.waitForSelector('.modal textarea.rs-code');
    ok((await page.locator('.modal textarea').inputValue()).includes('export default'), 'the editor starts with an example');
    await page.locator('.modal details.rs-help summary').click();
    ok(await page.locator('.modal .rs-api code').count() >= 10, 'API reference');
    await page.screenshot({ path: 'tests/e2e/out/roll-script-editor.png' });
    await page.locator('.modal input.field[type=text]').first().fill('Octave up (test)');
    await page.locator('.modal textarea').fill("export default {\n  name: 'Octave up',\n  params: [{ id: 'oct', name: 'Octaves', type: 'slider', min: 1, max: 3, value: 1 }],\n  run(ctx) { for (const n of ctx.notes) n.key += 12 * ctx.params.oct; },\n};\n");
    await page.locator('.modal .btn', { hasText: /^Save$/ }).click();
    await page.waitForSelector('.modal', { state: 'detached' });
    ok(await ev((k) => !!JSON.parse(localStorage.getItem(k))['Octave up (test)'], SCRIPTS_KEY), 'kept in the browser');
    await open('/');
    const id = await fresh();
    await ev((id) => app.cmd.addNotes(app.store, id, [{ s: 0, l: 24, k: 60, v: 100 }, { s: 48, l: 24, k: 64, v: 100 }]), id);
    await ev(() => { const r = app.pianoRoll; r.setSel([r.notes[1].id]); });
    const keys = async () => (await notes(id)).map((n) => n.k).join();
    const h0 = await history();
    await scriptMenu('Octave up (test)');
    await page.waitForFunction((id) => app.store.pattern.notes[id].some((n) => n.k === 76), id);
    ok(await keys() === '60,76', `only the selected note moves: ${await keys()}`);
    await setField('Octaves', 2);
    await page.waitForFunction((id) => app.store.pattern.notes[id].some((n) => n.k === 88), id);
    await page.locator('.modal .btn.primary').click(); await sleep(200);
    ok(await keys() === '60,88', `OK: ${await keys()}`);
    ok(await history() === h0 + 1, 'one undo step');
    ok(await ev(() => app.pianoRoll.selNotes.map((n) => n.k).join()) === '88', 'the result stays selected');
    await ev(() => app.store.undo()); await sleep(100);
    ok(await keys() === '60,64', 'undo');
  });

  await test('scripts: a failing script shows its error and changes nothing', async () => {
    const id = await fresh();
    await ev((id) => app.cmd.addNotes(app.store, id, [{ s: 0, l: 24, k: 60, v: 100 }, { s: 48, l: 24, k: 64, v: 100 }]), id);
    const scripts = {
      'Throws (test)': "export default { params: [{ id: 'a', type: 'slider' }], run(ctx) { ctx.notes[0].key = 1; throw new Error('boom'); } };",
      'Bad key (test)': "export default { params: [{ id: 'a', name: 'Shift', type: 'slider', min: 0, max: 40, value: 0 }], run(ctx) { ctx.notes[0].key = 100 + ctx.params.a; } };",
      'Loops (test)': 'export default { run(ctx) { for (;;) {} } };',
    };
    await ev(({ k, scripts }) => localStorage.setItem(k, JSON.stringify(Object.fromEntries(Object.entries(scripts).map(([name, source]) => [name, { name, source, time: 1 }])))), { k: SCRIPTS_KEY, scripts });
    const before = JSON.stringify(await notes(id)), h0 = await history();
    const same = async () => JSON.stringify(await notes(id)) === before && await history() === h0;
    // an exception: its message, OK disabled, the notes untouched
    await scriptMenu('Throws (test)');
    await page.waitForFunction(() => { const e = document.querySelector('.modal .rs-error'); return e && e.style.display !== 'none'; });
    ok((await scriptError()) === 'Script error (line 1): boom', `error shown with its line: ${await scriptError()}`);
    ok(await page.locator('.modal .btn.primary').isDisabled(), 'OK is disabled');
    ok(await same(), 'nothing changed');
    await page.locator('.modal .btn', { hasText: 'Cancel' }).click(); await sleep(100);
    ok(await same(), 'nothing changed after Cancel');
    // invalid output for some values: the preview goes back to the original notes
    await scriptMenu('Bad key (test)');
    await page.waitForFunction((id) => app.store.pattern.notes[id].some((n) => n.k === 100), id);
    await setField('Shift', 30);
    await page.waitForFunction(() => document.querySelector('.modal .rs-error').textContent.includes('outside'));
    ok((await scriptError()) === 'Note 1: key 130 is outside 0–120', `invalid key: ${await scriptError()}`);
    ok(await same(), 'invalid output changes nothing');
    await setField('Shift', 4);
    await page.waitForFunction((id) => app.store.pattern.notes[id].some((n) => n.k === 104), id);
    ok((await scriptError()) === '' && !(await page.locator('.modal .btn.primary').isDisabled()), 'a good value clears the error');
    await page.keyboard.press('Escape'); await sleep(100);
    ok(await same(), 'Escape cancels');
    // an endless loop is stopped after a few seconds
    await scriptMenu('Loops (test)');
    await page.waitForSelector('.modal', { timeout: 8000 });
    const msg = await page.locator('.modal .modal-body').innerText();
    ok(msg.includes('did not finish'), `timeout reported: ${msg}`);
    await page.locator('.modal .btn.primary').click();
    ok(await same(), 'the endless loop changed nothing');
    // a script that does not load is not saved by the editor
    await scriptMenu('New script…');
    await page.locator('.modal input.field[type=text]').first().fill('Broken (test)');
    await page.locator('.modal textarea').fill('export default { run( {');
    await page.locator('.modal .btn', { hasText: /^Save$/ }).click();
    await page.waitForFunction(() => { const e = document.querySelector('.modal .rs-error'); return e && e.textContent.includes('could not be loaded'); });
    ok(!(await ev((k) => !!JSON.parse(localStorage.getItem(k))['Broken (test)'], SCRIPTS_KEY)), 'not saved');
    await page.locator('.modal .btn', { hasText: 'Cancel' }).click();
  });

  await test('scripts: export a user script as a .js file, import it back, delete it', async () => {
    const source = "export default { name: 'Shared script', params: [], run(ctx) { return ctx.notes.map((n) => ({ ...n, velocity: 50 })); } };\n";
    await ev(({ k, source }) => localStorage.setItem(k, JSON.stringify({ 'Export me (test)': { name: 'Export me (test)', source, time: 1 } })), { k: SCRIPTS_KEY, source });
    const id = await fresh();
    await ev(() => { window.__exp = null; app.exportSink = (bytes, name, mime) => { window.__exp = { text: new TextDecoder().decode(bytes), name, mime }; }; });
    await scriptMenu('Export script (.js)', 'Export me (test)');
    const exp = await ev(() => { const e = window.__exp; app.exportSink = null; return e; });
    ok(exp && exp.name === 'Export me (test).js' && exp.mime === 'text/javascript', `file: ${JSON.stringify(exp && exp.name)}`);
    const text = exp.text;
    ok(text === source, 'the file is the script');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), scriptMenu('Import script (.js)…')]);
    await fc.setFiles({ name: 'shared.js', mimeType: 'text/javascript', buffer: Buffer.from(text) });
    await page.waitForFunction((k) => !!JSON.parse(localStorage.getItem(k))['Shared script'], SCRIPTS_KEY);
    // a script without parameters runs at once
    await ev((id) => app.cmd.addNotes(app.store, id, [{ s: 0, l: 24, k: 60, v: 100 }]), id);
    await scriptMenu('Shared script');
    await page.waitForFunction((id) => app.store.pattern.notes[id][0].v === 50, id);
    await scriptMenu('Delete script', 'Shared script');
    await page.locator('.modal .btn.primary', { hasText: 'Delete' }).click(); await sleep(100);
    ok(await ev((k) => Object.keys(JSON.parse(localStorage.getItem(k))).join(), SCRIPTS_KEY) === 'Export me (test)', 'deleted');
    await ev((k) => localStorage.removeItem(k), SCRIPTS_KEY);
  });

  await test('channel rack: rotate, invert, fill and clear steps from the channel menu', async () => {
    const id = await fresh();
    await ev(async (id) => { app.cmd.setStep(app.store, id, 0, true); app.cmd.setStep(app.store, id, 4, true); app.openWindow('rack'); await new Promise((r) => setTimeout(r, 100)); }, id);
    const steps = () => ev((id) => (app.store.pattern.notes[id] || []).map((n) => n.s / 24).join(), id);
    const menu = async (label) => {
      await ev(() => app.wm.focus('rack'));
      const b = await page.locator(`.ch-row[data-ch="${id}"] .ch-name`).boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
      await page.locator('.popup .item', { hasText: label }).first().click(); await sleep(100);
    };
    await menu('Rotate right');
    ok(await steps() === '1,5', `rotate right: ${await steps()}`);
    await menu('Rotate left'); await menu('Rotate left');
    ok(await steps() === '3,15', `rotate left wraps: ${await steps()}`);
    await menu('Invert steps');
    ok(await steps() === '0,1,2,4,5,6,7,8,9,10,11,12,13,14', `invert: ${await steps()}`);
    ok(await page.locator(`.ch-row[data-ch="${id}"] .step.on`).count() === 14, 'the step buttons follow');
    await menu('Fill each 4 steps');
    ok(await steps() === '0,4,8,12', `fill: ${await steps()}`);
    await menu('Clear steps in this pattern');
    ok(await steps() === '', 'clear');
    await ev(() => app.store.undo()); await ev(() => app.store.undo()); await sleep(100);
    ok(await steps() === '0,1,2,4,5,6,7,8,9,10,11,12,13,14', `undo twice: ${await steps()}`);
  });
}
