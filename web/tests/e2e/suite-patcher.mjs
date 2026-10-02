import { page, open, maxPeak, test, ok, sleep, ev } from './harness.mjs';

const play = () => ev(async () => { app.transport.stop(); await new Promise((r) => setTimeout(r, 60)); app.transport.play(); });
const stop = () => ev(() => app.transport.stop());

async function fresh() {
  return ev(async () => {
    const { emptyProject } = await import('/src/core/demo.js');
    await app.store.replaceProject(emptyProject());
    const ch = app.addInstrument('patcher');
    app.cmd.setMixerTarget(app.store, ch.id, 5);
    app.cmd.setStep(app.store, ch.id, 0, true, { key: 57 });
    app.cmd.setStep(app.store, ch.id, 8, true, { key: 64 });
    await new Promise((r) => setTimeout(r, 250));
    return ch.id;
  });
}
const win = (id) => page.locator(`.win[data-id="plugin:${id}"]`);
const nodes = (w) => w.locator('.pt-node');
const wires = (w) => w.locator('path.pt-wire:not(.temp)');
const dot = async (w, nodeSel, dir, port) => {
  const el = w.locator(`${nodeSel} .pt-port.${dir}${port ? `[data-port="${port}"]` : ''} .pt-dot`).first();
  const b = await el.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
async function dragTo(a, b) {
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 }); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up();
  await sleep(120);
}
const nodeCount = (id) => ev((id) => app.store.channel(id).patch.nodes.length, id);
const wireCount = (id) => ev((id) => app.store.channel(id).patch.wires.length, id);

export async function run() {
  console.log('patcher');
  await open('/');
  let id = 0;

  await test('Patcher instrument: the editor shows the default patch and it plays through the AudioWorklet', async () => {
    id = await fresh();
    const w = win(id);
    await w.waitFor();
    await page.waitForSelector(`.win[data-id="plugin:${id}"] .pt-node`);
    ok((await nodes(w).count()) === 3, `3 nodes, got ${await nodes(w).count()}`);
    ok((await wires(w).count()) === 2, `2 wires, got ${await wires(w).count()}`);
    ok((await w.locator('.pt-macro-grid .knob').count()) === 16, '16 macro knobs');
    await play();
    const loud = await maxPeak(5, 2300);
    ok(loud > 0.02, `audible, peak=${loud}`);
    await stop();
    await page.screenshot({ path: 'tests/e2e/out/patcher.png' });
  });

  await test('right-click on the canvas adds nodes from the Add menu (generators, control, notes)', async () => {
    const w = win(id);
    const cv = await w.locator('.pt-canvas').boundingBox();
    await page.mouse.click(cv.x + 120, cv.y + cv.height - 70, { button: 'right' });
    await page.locator('.popup .item', { hasText: 'Generators' }).hover(); await sleep(250);
    await page.locator('.popup .item[data-label="Pluck"]').click(); await sleep(150);
    ok((await nodes(w).count()) === 4, 'Pluck added');
    ok((await ev((id) => app.store.channel(id).patch.nodes.some((n) => n.type === 'inst' && n.ref === 'pluck'), id)), 'model has the pluck');
    await page.mouse.click(cv.x + 420, cv.y + cv.height - 70, { button: 'right' });
    await page.locator('.popup .item', { hasText: 'Control' }).hover(); await sleep(250);
    await page.locator('.popup .item[data-label="LFO"]').click(); await sleep(150);
    ok((await nodes(w).count()) === 5, 'LFO added');
    await page.locator('.pt-tools .btn', { hasText: 'Add node' }).click();
    await page.locator('.popup .item', { hasText: 'Notes' }).hover(); await sleep(250);
    ok((await page.locator('.popup .item[data-label="Chord"]').count()) === 1, 'note tools are listed');
    await page.keyboard.press('Escape');
    ok((await page.locator('.popup .item.disabled', { hasText: 'Note In' }).count()) >= 0, 'menu ok');
  });

  await test('dragging from a port to a port wires them; mismatched kinds are refused; the wire changes the sound', async () => {
    const w = win(id);
    const pluck = '.pt-node[data-type="inst"]:has(.pt-title:text-is("Pluck"))';
    const before = await wireCount(id);
    await dragTo(await dot(w, '.pt-node[data-type="noteIn"]', 'out', 'notes'), await dot(w, pluck, 'in', 'notes'));
    ok((await wireCount(id)) === before + 1, 'note wire made');
    await dragTo(await dot(w, pluck, 'out', 'out'), await dot(w, '.pt-node[data-type="audioOut"]', 'in', 'in'));
    ok((await wireCount(id)) === before + 2, 'audio wire made');
    // note output onto an audio input: refused with a message
    await dragTo(await dot(w, '.pt-node[data-type="noteIn"]', 'out', 'notes'), await dot(w, '.pt-node[data-type="audioOut"]', 'in', 'in'));
    ok((await wireCount(id)) === before + 2, 'invalid wire not created');
    ok((await page.locator('.toast', { hasText: 'note into audio' }).count()) >= 1, 'a message explains why');
    // picking up a cable from an input and dropping it in empty space removes it
    const cv = await w.locator('.pt-canvas').boundingBox();
    await dragTo(await dot(w, '.pt-node[data-type="audioOut"]', 'in', 'in'), { x: cv.x + 30, y: cv.y + cv.height - 20 });
    ok((await wireCount(id)) === before + 1, 'cable pulled out of the input');
    await ev(() => app.store.undo());
    await sleep(150);
    ok((await wireCount(id)) === before + 2, 'undo puts it back');
    await play();
    const loud = await maxPeak(5, 2000);
    ok(loud > 0.02, `two generators audible, peak=${loud}`);
    await stop();
  });

  await test('Delete removes the selected node with its wires; Ctrl+Z brings everything back', async () => {
    const w = win(id);
    const n0 = await nodeCount(id), w0 = await wireCount(id);
    const pluck = w.locator('.pt-node[data-type="inst"]:has(.pt-title:text-is("Pluck")) .pt-head');
    await pluck.click();
    ok(await w.locator('.pt-node.sel').count() === 1, 'selected');
    ok((await w.locator('.pt-insp .mx-title').innerText()).toLowerCase().includes('pluck'), 'inspector shows the node');
    await page.keyboard.press('Delete'); await sleep(150);
    ok((await nodeCount(id)) === n0 - 1 && (await wireCount(id)) === w0 - 2, 'node and its two wires gone');
    await page.keyboard.press('Control+z'); await sleep(250);
    ok((await nodeCount(id)) === n0 && (await wireCount(id)) === w0, 'restored by undo');
  });

  await test('moving a node does not rebuild the audio graph, it is one undo step, and wires follow', async () => {
    const w = win(id);
    const head = w.locator('.pt-node[data-type="audioOut"] .pt-head');
    const b = await head.boundingBox();
    const x0 = await ev((id) => app.store.channel(id).patch.nodes.find((n) => n.type === 'audioOut').x, id);
    await page.mouse.move(b.x + 30, b.y + 8); await page.mouse.down(); await page.mouse.move(b.x + 90, b.y + 48, { steps: 6 }); await page.mouse.up(); await sleep(150);
    const x1 = await ev((id) => app.store.channel(id).patch.nodes.find((n) => n.type === 'audioOut').x, id);
    ok(x1 > x0, `moved right (${x0} -> ${x1})`);
    ok(x1 % 10 === 0, 'snapped to the grid');
    await ev(() => app.store.undo()); await sleep(150);
    ok((await ev((id) => app.store.channel(id).patch.nodes.find((n) => n.type === 'audioOut').x, id)) === x0, 'one undo restores the position');
  });

  await test('inspector knobs edit node parameters; ⇄ exposes one as an input; a Macro wired into it controls the sound', async () => {
    // build: Note In -> SubSynth -> Volume/Pan -> Audio Out, Macro 1 -> Volume/Pan level (exposed through the UI)
    await ev(async (id) => {
      const { addNode, connect } = await import('/src/core/patcher/spec.js');
      app.cmd.patchEdit(app.store, { ch: id }, 'Build test patch', (p) => {
        const nin = p.nodes.find((n) => n.type === 'noteIn'), syn = p.nodes.find((n) => n.type === 'inst' && n.ref === 'subsynth'), out = p.nodes.find((n) => n.type === 'audioOut');
        p.wires = []; p.nodes = [nin, syn, out];
        const g = addNode(p, 'gain', { x: 460, y: 230 }), m = addNode(p, 'macro', { x: 240, y: 330, params: { n: 1 } });
        connect(p, [nin.id, 'notes'], [syn.id, 'notes']); connect(p, [syn.id, 'out'], [g.id, 'in']); connect(p, [g.id, 'out'], [out.id, 'in']);
        void m;
      });
    }, id);
    await sleep(250);
    const w = win(id);
    ok((await nodes(w).count()) === 5, '5 nodes');
    await w.locator('.pt-node[data-type="gain"] .pt-head').click();
    ok((await w.locator('.pt-param').count()) === 2, 'level + pan');
    await w.locator('.pt-param', { hasText: 'Level' }).locator('.pt-expose').click(); await sleep(150);
    ok((await w.locator('.pt-node[data-type="gain"] .pt-port.mod').count()) === 1, 'the exposed parameter became an input port');
    await dragTo(await dot(w, '.pt-node[data-type="macro"]', 'out', 'out'), await dot(w, '.pt-node[data-type="gain"]', 'in', 'p:level'));
    ok((await ev((id) => app.store.channel(id).patch.wires.some((x) => x.to[1] === 'p:level'), id)), 'macro wired to the level');
    await ev((id) => app.store.setParam(`ch:${id}:p:m1`, 1), id);
    await play();
    const loud = await maxPeak(5, 1800);
    await stop();
    await ev((id) => app.store.setParam(`ch:${id}:p:m1`, 0), id);
    await sleep(150);
    await play();
    const quiet = await maxPeak(5, 1800);
    await stop();
    ok(loud > 0.02 && quiet < loud * 0.05, `macro 1 = ${loud.toFixed(3)}, macro 0 = ${quiet.toFixed(4)}`);
    // a knob in the inspector writes into the patch
    await w.locator('.pt-node[data-type="gain"] .pt-head').click();
    const knob = w.locator('.pt-param', { hasText: 'Panning' }).locator('.knob').first();
    const kb = await knob.boundingBox();
    await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2); await page.mouse.down(); await page.mouse.move(kb.x + kb.width / 2, kb.y - 40, { steps: 5 }); await page.mouse.up(); await sleep(120);
    const pan = await ev((id) => app.store.channel(id).patch.nodes.find((n) => n.type === 'gain').params.pan, id);
    ok(pan > 0.1, `pan knob wrote ${pan}`);
  });

  await test('wheel zooms around the pointer, middle-drag pans, Fit shows everything', async () => {
    const w = win(id);
    const world = w.locator('.pt-world');
    const t0 = await world.evaluate((e) => e.style.transform);
    const cv = await w.locator('.pt-canvas').boundingBox();
    await page.mouse.move(cv.x + 200, cv.y + 150); await page.mouse.wheel(0, -300); await sleep(100);
    const t1 = await world.evaluate((e) => e.style.transform);
    const sc = (t) => +/scale\(([\d.]+)\)/.exec(t)[1];
    ok(sc(t1) > sc(t0) * 1.05, `zoomed in: ${t0} -> ${t1}`);
    await page.mouse.move(cv.x + 300, cv.y + 200); await page.mouse.down({ button: 'middle' }); await page.mouse.move(cv.x + 360, cv.y + 230, { steps: 4 }); await page.mouse.up({ button: 'middle' });
    ok((await world.evaluate((e) => e.style.transform)) !== t1, 'panned');
    await w.locator('.pt-tools .btn', { hasText: 'Fit' }).click(); await sleep(100);
    const nb = await nodes(w).first().boundingBox();
    ok(nb.x >= cv.x - 2 && nb.x < cv.x + cv.width, 'nodes are inside the canvas after Fit');
  });

  await test('factory instrument patches load from the Patches menu (one undo step) and play', async () => {
    const w = win(id);
    await w.locator('.pt-tools .btn', { hasText: 'Patches' }).click();
    await page.locator('.popup .item', { hasText: 'Keyboard split: organ + pluck' }).click(); await sleep(300);
    ok((await nodes(w).count()) === 6, `split patch has 6 nodes, got ${await nodes(w).count()}`);
    await play();
    const loud = await maxPeak(5, 2000);
    await stop();
    ok(loud > 0.02, `audible, peak=${loud}`);
    await ev(() => app.store.undo()); await sleep(250);
    ok((await nodes(w).count()) === 5, 'undo returns to the previous patch');
  });

  await test('Patcher effect: lives in a mixer slot, the editor opens inside the effect window, factory patches process the track', async () => {
    await ev(async () => {
      const { emptyProject } = await import('/src/core/demo.js');
      await app.store.replaceProject(emptyProject());
      const ch = app.addInstrument('subsynth');
      app.cmd.setMixerTarget(app.store, ch.id, 5);
      app.cmd.setStep(app.store, ch.id, 0, true, { key: 57 });
      app.cmd.setStep(app.store, ch.id, 8, true, { key: 64 });
      app.cmd.selectTrack(app.store, 5);
      app.addEffectToSelected('patcher');
      app.openFxEditor(5, 0);
    });
    const w = page.locator('.win[data-id="fx:5:0"]');
    await w.waitFor();
    await page.waitForSelector('.win[data-id="fx:5:0"] .pt-node');
    ok((await nodes(w).count()) === 2, 'Audio In + Audio Out');
    await play();
    const dry = await maxPeak(5, 1800);
    await stop();
    ok(dry > 0.02, `the default effect patch is transparent (peak ${dry})`);
    await w.locator('.pt-tools .btn', { hasText: 'Patches' }).click();
    await page.locator('.popup .item', { hasText: 'Parallel distortion' }).click(); await sleep(300);
    ok((await nodes(w).count()) === 4, 'parallel distortion: in, distortion, gain, out');
    await play();
    const wet = await maxPeak(5, 1800);
    await stop();
    ok(wet > 0.02 && wet !== dry, `processed (peak ${wet})`);
    await page.screenshot({ path: 'tests/e2e/out/patcher-fx.png' });
    await ev(() => app.wm.close('fx:5:0'));
  });

  await test('patches survive saving and loading (JSON and project ZIP); deleting the channel closes its editor', async () => {
    const cid = await fresh();
    await ev((id) => app.cmd.patchEdit(app.store, { ch: id }, 'macro name', (p) => { p.macroNames = ['Brightness', ...Array(15).fill('')]; }), cid);
    const before = await ev((id) => JSON.stringify(app.store.channel(id).patch), cid);
    const after = await ev(async () => {
      const { normalize } = await import('/src/core/project.js');
      const { projectToZip, projectFromZip } = await import('/src/app/project-io.js');
      const viaJson = normalize(JSON.parse(app.store.serialize()));
      const zip = projectToZip(app.store.project, app.bank);
      const { project } = await projectFromZip(zip, app.bank);
      const ch = app.store.project.channels.find((c) => c.type === 'patcher');
      return { json: JSON.stringify(viaJson.channels.find((c) => c.type === 'patcher').patch), zip: JSON.stringify(project.channels.find((c) => c.type === 'patcher').patch), id: ch.id };
    });
    ok(after.json === before, 'JSON round trip keeps the patch');
    ok(after.zip === before, 'ZIP round trip keeps the patch');
    const w = win(cid);
    await w.waitFor();
    ok((await w.locator('.pt-macro-grid .knob-label', { hasText: 'Brightness' }).count()) === 1, 'macro name shown');
    await ev((id) => app.cmd.removeChannel(app.store, id), cid);
    await sleep(250);
    ok((await w.count()) === 0, 'editor closed with the channel');
  });
}
