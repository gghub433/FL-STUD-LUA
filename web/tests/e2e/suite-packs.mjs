import fs from 'node:fs';
import { page, open, maxPeak, test, ok, sleep, ev, port } from './harness.mjs';

const play = () => ev(async () => { app.transport.stop(); await new Promise((r) => setTimeout(r, 60)); app.transport.play(); });
const stop = () => ev(() => app.transport.stop());
const store = '.win[data-id="store"]';
const card = (name) => page.locator(`${store} .ps-card`, { has: page.locator('.ps-name', { hasText: name }) });
const clearPacks = () => page.evaluate(async () => {
  await new Promise((resolve) => { const r = indexedDB.open('stepwise-daw', 1); r.onsuccess = () => { const db = r.result; const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete('packs'); t.oncomplete = () => { db.close(); resolve(); }; }; r.onerror = () => resolve(); });
});
const openStore = async () => { await ev(() => app.openStore()); await page.waitForSelector(`${store} .ps-card`); await sleep(200); };
const acidProject = (steps = true) => ev(async (steps) => {
  const { emptyProject } = await import('/src/core/demo.js');
  await app.store.replaceProject(emptyProject());
  const ch = app.addInstrument('fllua-synths.acid');
  app.cmd.setMixerTarget(app.store, ch.id, 5);
  if (steps) { app.cmd.setStep(app.store, ch.id, 0, true, { key: 45 }); app.cmd.setStep(app.store, ch.id, 8, true, { key: 52 }); }
  await new Promise((r) => setTimeout(r, 200));
  return ch.id;
}, steps);

export async function run() {
  console.log('plugin packs and the plugin store');
  await open('/');
  await clearPacks();
  await open('/');

  await test('Tools → Plugin store lists the bundled packs with their plugins; nothing is installed yet', async () => {
    await page.locator('.menu-top', { hasText: 'TOOLS' }).click();
    await page.locator('.popup .item', { hasText: 'Plugin store' }).click();
    await page.waitForSelector(`${store} .ps-card`);
    ok((await page.locator(`${store} .ps-card`).count()) === 2, 'two packs');
    const text = await page.locator(store).innerText();
    for (const n of ['FL LUA Synths', 'FL LUA Effects', 'Acid Bass', 'Tri-Osc', 'Chip', 'Additive', 'Soft Clipper', 'Maximizer', 'Hyper Chorus', 'Waveshaper', 'Overdrive', 'Delay Bank', 'Pitcher']) ok(text.includes(n), `lists ${n}`);
    ok((await page.locator(`${store} .ps-state`).count()) === 0, 'nothing installed');
    await page.screenshot({ path: 'tests/e2e/out/store.png' });
  });

  await test('Install: one click installs the Synths pack; its generators appear in the picker and the ADD menu', async () => {
    await card('FL LUA Synths').locator('.btn', { hasText: 'Install' }).click();
    await page.waitForSelector(`${store} .ps-card:has-text("FL LUA Synths") .ps-state`, { timeout: 15000 });
    ok((await card('FL LUA Synths').locator('.ps-state').innerText()).includes('Installed'), 'installed state');
    ok(await ev(() => app.packs.has('fllua-synths')), 'registered in the manager');
    const types = await ev(async () => { const m = await import('/src/core/instruments/index.js'); return Object.keys(m.INSTRUMENTS).filter((t) => t.startsWith('fllua-synths.')); });
    ok(types.length === 4, `four generators registered: ${types}`);
    await ev(() => app.openWindow('picker')); await sleep(300);
    const picker = await page.locator('.win[data-id="picker"]').innerText();
    ok(['Acid Bass', 'Tri-Osc', 'Chip', 'Additive'].every((n) => picker.includes(n)), 'plugin picker lists them');
    await page.locator('.menu-top', { hasText: 'ADD' }).click();
    await page.locator('.popup .item', { hasText: 'Instrument plugin' }).hover(); await sleep(250);
    ok((await page.locator('.popup .item', { hasText: 'Acid Bass' }).count()) === 1, 'ADD menu lists Acid Bass');
    ok((await page.locator('.popup .item', { hasText: 'Get more plugins' }).count()) === 1, 'ADD menu offers the store');
    await page.keyboard.press('Escape');
    ok((await ev(async () => (await import('/src/core/presets.js')).INSTRUMENT_PRESETS['fllua-synths.acid']['Classic squelch'] !== undefined)), 'factory presets arrived with the pack');
  });

  await test('the installed generator plays through the AudioWorklet (the pack was evaluated on the audio thread)', async () => {
    const id = await acidProject();
    await page.waitForSelector(`.win[data-id="plugin:${id}"]`);
    ok((await page.locator(`.win[data-id="plugin:${id}"]`).innerText()).includes('Filter'), 'generic editor shows the parameter groups');
    await play();
    const loud = await maxPeak(5, 2200);
    await stop();
    ok(loud > 0.02, `Acid Bass is audible, peak=${loud}`);
    await page.screenshot({ path: 'tests/e2e/out/pack-acid.png' });
  });

  await test('install the Effects pack; an effect from it processes an insert and opens its editor', async () => {
    await openStore();
    await card('FL LUA Effects').locator('.btn', { hasText: 'Install' }).click();
    await page.waitForSelector(`${store} .ps-card:has-text("FL LUA Effects") .ps-state`, { timeout: 15000 });
    await acidProject();
    const quiet = await (async () => { await play(); const m = await maxPeak(5, 1800); await stop(); return m; })();
    await ev(() => { app.cmd.selectTrack(app.store, 5); app.addEffectToSelected('fllua-effects.waveshaper'); app.openFxEditor(5, 0); });
    await page.waitForSelector('.win[data-id="fx:5:0"]');
    ok((await page.locator('.win[data-id="fx:5:0"]').innerText()).includes('Waveshaper'), 'effect editor opens');
    await ev(() => app.store.setParam('mx:5:fx:0:p:drive', 30));
    await play();
    const driven = await maxPeak(5, 1800);
    await stop();
    ok(driven > 0.02 && Math.abs(driven - quiet) > 0.005, `the waveshaper changes the signal (${quiet.toFixed(3)} -> ${driven.toFixed(3)})`);
  });

  await test('packs survive a reload; projects that use them save and reopen complete', async () => {
    await acidProject();
    await ev(() => { app.cmd.selectTrack(app.store, 5); app.addEffectToSelected('fllua-effects.maximizer'); });
    const json = await ev(() => app.store.serialize());
    await page.reload();
    await page.waitForFunction(() => window.__ready, null, { timeout: 15000 });
    await sleep(500);
    ok(await ev(() => app.packs.has('fllua-synths') && app.packs.has('fllua-effects')), 'both packs are still installed');
    await ev(async (j) => { await app.store.loadJSON(j); }, json);
    const st = await ev(() => ({ ch: app.store.project.channels.map((c) => c.type), fx: app.store.project.mixer.tracks[5].fx.filter(Boolean).map((f) => f.type) }));
    ok(st.ch.includes('fllua-synths.acid') && st.fx.includes('fllua-effects.maximizer'), `reopened complete: ${JSON.stringify(st)}`);
    await play();
    const m = await maxPeak(5, 1800);
    await stop();
    ok(m > 0.02, `and it plays after the reload (${m.toFixed(3)})`);
  });

  await test('Export renders pack plugins in the worker exactly as they sound', async () => {
    await acidProject();
    await ev(() => { window.__exp = null; app.exportSink = (bytes, name) => { window.__exp = { bytes, name }; }; });
    const r = await ev(async () => {
      const { exportProject, defaultSettings } = await import('/src/app/export.js');
      app.transport.setMode('pat');
      const out = await exportProject(app, { ...defaultSettings(app.store.project), format: 'wav', source: 'pat', tail: 0.5 });
      const buf = await app.host.ctx.decodeAudioData(window.__exp.bytes.slice().buffer);
      let pk = 0; const l = buf.getChannelData(0); for (let i = 0; i < l.length; i += 5) pk = Math.max(pk, Math.abs(l[i]));
      return { ok: !!out, dur: buf.duration, pk };
    });
    ok(r.ok && r.dur > 0.5 && r.pk > 0.02, `the exported WAV contains the Acid Bass (peak ${r.pk.toFixed(3)}, ${r.dur.toFixed(2)} s)`);
  });

  await test('a project that needs a pack which is not installed opens with a clear message instead of silently losing plugins', async () => {
    await ev(async () => {
      const { emptyProject } = await import('/src/core/demo.js');
      const p = JSON.parse(JSON.stringify(emptyProject()));
      p.channels.push({ id: 90, type: 'ghost-pack.lead', name: 'Ghost', params: {}, mixer: 1 });
      const { normalize } = await import('/src/core/project.js');
      app.store.replaceProject(normalize(p));
    });
    await page.waitForSelector('.modal-title');
    ok((await page.locator('.modal-title').innerText()).includes('Plugins are missing'), 'dialog title');
    const body = await page.locator('.modal').innerText();
    ok(body.includes('ghost-pack') && body.includes('ghost-pack.lead'), 'names the pack and the plugin');
    await page.locator('.modal .btn', { hasText: 'Cancel' }).click(); await sleep(200);
  });

  await test('install from a file (with the security confirmation) and from a web address; broken packs are refused', async () => {
    await openStore();
    fs.mkdirSync('tests/e2e/out', { recursive: true });
    const good = `globalThis.__flluaRegisterPack({ id: 'e2e-pack', name: 'E2E Pack', version: '2.0.1', author: 'tests', license: 'MIT', description: 'made by the test', api: 1,
      plugins: (api) => { const { def, defaults } = api.params; const sch = [def('level', 'Level', 0, 2, 1)];
        return { effects: { amp: { schema: sch, meta: { name: 'E2E Amp', category: 'Utility', description: 'gain' }, create: () => { const p = defaults(sch); return { p, setParam(i, v) { p[i] = v; }, process(L, R, n) { for (let i = 0; i < n; i++) { L[i] *= p.level; R[i] *= p.level; } } }; } } } }; } });`;
    fs.writeFileSync('tests/e2e/out/e2e.flpack.js', good);
    fs.writeFileSync('tests/e2e/out/broken.flpack.js', 'globalThis.__flluaRegisterPack({ id: "BROKEN id", name: "x", version: "1.0.0", plugins: () => ({}) });');
    // good file
    let [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator(`${store} .btn`, { hasText: 'Install from file' }).click()]);
    await chooser.setFiles('tests/e2e/out/e2e.flpack.js');
    await page.waitForSelector('.modal-title');
    ok((await page.locator('.modal').innerText()).includes('program code'), 'security warning is shown');
    ok(/SHA-256: [0-9a-f]{64}/.test(await page.locator('.modal').innerText()), 'with the checksum');
    await page.locator('.modal .btn', { hasText: 'Install' }).last().click();
    await page.waitForSelector(`${store} .ps-card:has-text("E2E Pack")`, { timeout: 10000 });
    ok(await ev(async () => (await import('/src/core/effects/index.js')).hasEffect('e2e-pack.amp')), 'the effect is registered');
    ok((await page.locator(store).innerText()).toLowerCase().includes('installed from files'), 'listed under files');
    // broken file
    [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator(`${store} .btn`, { hasText: 'Install from file' }).click()]);
    await chooser.setFiles('tests/e2e/out/broken.flpack.js');
    await page.waitForSelector('.modal-title');
    await page.locator('.modal .btn', { hasText: 'Install' }).last().click();
    await page.waitForSelector('.toast', { timeout: 5000 });
    await sleep(300);
    ok((await page.locator('.toast').allInnerTexts()).some((t) => /id must be/.test(t)), 'the broken pack is refused with its reason');
    ok(!(await ev(() => app.packs.has('BROKEN id'))), 'and not installed');
    // from an address (the test server also serves the packs folder)
    await page.locator(`${store} .btn`, { hasText: 'From address' }).click();
    await page.waitForSelector('.modal input');
    await page.locator('.modal input').fill(`http://localhost:${port}/packs/synths.flpack.js`);
    await page.locator('.modal .btn', { hasText: 'OK' }).click();
    await page.waitForSelector('.modal-title:has-text("Install this pack")');
    await page.locator('.modal .btn', { hasText: 'Install' }).last().click();
    await sleep(800);
    ok(await ev(() => app.packs.has('fllua-synths')), 'installed again from the address (an update of the same pack)');
  });

  await test('Remove: the pack leaves storage at once and is gone after a reload', async () => {
    await openStore();
    await card('E2E Pack').locator('.btn', { hasText: 'Remove' }).click();
    await page.locator('.modal .btn', { hasText: 'Remove' }).last().click();
    await page.waitForSelector('.modal-title:has-text("Reload")');
    await page.locator('.modal .btn', { hasText: 'Cancel' }).click(); await sleep(300);
    ok((await page.locator(store).innerText()).includes('removed'), 'the banner asks for a reload');
    await page.reload();
    await page.waitForFunction(() => window.__ready, null, { timeout: 15000 });
    await sleep(500);
    ok(!(await ev(() => app.packs.has('e2e-pack'))) && (await ev(() => app.packs.has('fllua-synths'))), 'the removed pack is gone, the others remain');
    ok(!(await ev(async () => (await import('/src/core/effects/index.js')).hasEffect('e2e-pack.amp'))), 'its effect is unregistered');
    await clearPacks();
  });
}
