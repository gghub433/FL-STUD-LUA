import { page, open, test, ok, sleep, ev, maxPeak } from './harness.mjs';

// WAM 2.0 plugins (Web Audio Modules): the two example plugins in web/wam/ stand in for third-party ones
const SYNTH = 'wam/example-synth/index.js', TREM = 'wam/example-tremolo/index.js';
const ready = (owner) => page.waitForFunction((o) => { const s = app.wam.statusOf(o); return s && s.state !== 'loading'; }, owner, { timeout: 15000 });
const status = (owner) => ev((o) => app.wam.statusOf(o), owner);
const empty = () => ev(async () => {
  const { createProject } = await import('/src/core/project.js');
  const p = createProject(); p.channels = []; p.tempo = 120;
  await app.store.replaceProject(p);
  for (const w of [...document.querySelectorAll('.win')]) { const id = w.dataset.id; if (id && (id.startsWith('plugin:') || id.startsWith('fx:'))) app.wm.get(id).close(); }
});
// plays a held note on the channel for a while and returns the master peak
const notePeak = async (chId, ms = 500) => {
  await ev((id) => app.host.send({ t: 'noteOn', ch: id, key: 57, vel: 1 }), chId);
  const pk = await maxPeak(0, ms);
  await ev((id) => app.host.send({ t: 'noteOff', ch: id, key: 57 }), chId);
  await sleep(300);
  return pk;
};
const setParam = (owner, id, value) => ev(async ({ owner, id, value }) => { await app.wam.instance(owner).audioNode.setParameterValues({ [id]: { id, value, normalized: false } }); }, { owner, id, value });

export async function run() {
  console.log('WAM plugins: instruments, effects, state, export');
  await open('/');
  await ev(() => app.host.resume());
  await ev(() => { try { localStorage.removeItem('fllua.wam.recent'); } catch (_) { /* */ } });

  let chId = null;
  await test('ADD > Instrument plugin > WAM plugin…: pick the example, it loads, shows its interface and plays', async () => {
    await empty();
    await page.locator('#menubar .menu-top[data-menu="ADD"]').click(); await sleep(150);
    await page.locator('.popup .item', { hasText: 'Instrument plugin' }).hover(); await sleep(200);
    await page.locator('.popup[data-level="1"] .item', { hasText: 'WAM plugin' }).click(); await sleep(250);
    ok((await page.locator('.modal-title').innerText()) === 'WAM instrument', 'the chooser opens');
    ok((await page.locator('.wam-pick').count()) >= 1, 'examples are offered');
    await page.locator('.wam-pick', { hasText: 'FL LUA Example Synth' }).click();
    ok((await page.locator('.modal input.field').inputValue()) === SYNTH, 'clicking fills the address');
    await page.locator('.modal .btn', { hasText: 'Add' }).click();
    chId = await ev(() => app.store.project.channels.find((c) => c.type === 'wam').id);
    await ready(`ch:${chId}`);
    const st = await status(`ch:${chId}`);
    ok(st.state === 'ready' && st.name === 'FL LUA Example Synth' && st.vendor === 'FL LUA', JSON.stringify(st));
    await page.waitForSelector(`.win[data-id="plugin:${chId}"] .wam-gui select`, { timeout: 5000 });
    ok((await page.locator(`.win[data-id="plugin:${chId}"] .wam-gui`).innerText()).includes('Cutoff'), 'the plugin’s own interface');
    const pk = await notePeak(chId);
    ok(pk > 0.03, `the plugin sounds through the mixer (peak ${pk})`);
    await page.screenshot({ path: 'tests/e2e/out/wam-synth.png' });
  });

  await test('the plugin’s state is kept with the project: saved, loaded again, restored into a new instance', async () => {
    const owner = `ch:${chId}`;
    await setParam(owner, 'level', 0);
    ok((await notePeak(chId)) < 0.002, 'level 0 is silent');
    await ev(() => app.wam.capture());
    const saved = await ev((id) => app.store.channel(id).wam.state, chId);
    ok(saved && saved.parameterValues && saved.parameterValues.level.value === 0, JSON.stringify(saved).slice(0, 200));
    // the project goes through a file and comes back
    await ev(async () => {
      const { normalize } = await import('/src/core/project.js');
      await app.store.replaceProject(normalize(JSON.parse(JSON.stringify(app.store.project))));
    });
    await sleep(200);
    await ready(owner);
    ok((await status(owner)).state === 'ready', 'loaded again');
    ok((await notePeak(chId)) < 0.002, 'still silent: the state came back');
    await setParam(owner, 'level', 0.8);
    ok((await notePeak(chId)) > 0.03, 'and plays when turned up');
  });

  await test('a WAM effect in a mixer slot processes the track; its output level is the plugin’s', async () => {
    await ev(() => app.openWindow('mixer'));
    await ev(() => { app.store.project.mixer.selected = 0; });
    await ev(() => app.wam.setEffect(0, 2, 'wam/example-tremolo/index.js'));
    const fxId = await ev(() => app.store.project.mixer.tracks[0].fx[2].extra.wam.id);
    await ready(`fx:${fxId}`);
    ok((await status(`fx:${fxId}`)).name === 'FL LUA Example Tremolo', 'effect loaded');
    await setParam(`fx:${fxId}`, 'depth', 0);
    const on = await notePeak(chId);
    await setParam(`fx:${fxId}`, 'output', 0);
    const off = await notePeak(chId);
    ok(on > 0.03 && off < 0.002, `the master goes through the plugin (${on} → ${off})`);
    await setParam(`fx:${fxId}`, 'output', 1);
    // the slot opens the plugin's window
    await ev(() => app.openFxEditor(0, 2)); await sleep(400);
    ok((await page.locator('.win[data-id="fx:0:2"] .wam-gui').innerText()).includes('Spread'), 'effect interface');
    // a copied slot is a second instance with its own id
    await ev(() => app.cmd.copyFx(app.store, 0, 2, 0, 3));
    const ids = await ev(() => app.store.project.mixer.tracks[0].fx.slice(2, 4).map((s) => s.extra.wam.id));
    ok(ids[0] !== ids[1], 'copy has a new id');
    await ready(`fx:${ids[1]}`);
    ok((await ev(() => app.wam.rig.items.size)) === 3, 'three plugins running');
    await ev(() => app.cmd.setFx(app.store, 0, 3, null));
    await sleep(200);
    ok((await ev(() => app.wam.rig.items.size)) === 2, 'removing the slot stops its plugin');
  });

  await test('undo and redo bring a deleted WAM channel back with its plugin', async () => {
    await ev((id) => app.cmd.removeChannel(app.store, id), chId);
    await sleep(200);
    ok((await ev(() => app.wam.rig.items.size)) === 1, 'plugin stopped with its channel');
    await ev(() => app.store.undo()); await sleep(200);
    await ready(`ch:${chId}`);
    ok((await ev(() => app.wam.rig.items.size)) === 2, 'back after undo');
    ok((await notePeak(chId)) > 0.03, 'and plays');
  });

  await test('export renders the WAM plugins through Web Audio (WAV and stems)', async () => {
    await ev(async (id) => {
      const { createNote } = await import('/src/core/project.js');
      const { STEP } = await import('/src/core/constants.js');
      app.store.edit('notes', (p) => { const pat = p.patterns[p.currentPattern]; pat.notes[id] = [createNote(p, 0, STEP * 4, 57, 110), createNote(p, STEP * 8, STEP * 4, 64, 110)]; }, [['patterns']]);
      app.store.edit('mixer', (p) => { const c = p.channels.find((x) => x.id === id); c.mixer = 1; }, [['channels']]);
      window.__exp = null; app.exportSink = (bytes, name, mime) => { window.__exp = { bytes, name, mime }; };
    }, chId);
    const r = await ev(async () => {
      const { exportProject, defaultSettings } = await import('/src/app/export.js');
      const out = await exportProject(app, { ...defaultSettings(app.store.project), source: 'pat', tail: 1, format: 'wav', quality: '16' });
      const buf = await app.host.ctx.decodeAudioData(window.__exp.bytes.slice().buffer);
      const l = buf.getChannelData(0); let pk = 0, early = 0;
      for (let i = 0; i < l.length; i++) { pk = Math.max(pk, Math.abs(l[i])); if (i < buf.sampleRate * 0.05) early = Math.max(early, Math.abs(l[i])); }
      return { name: out.name, dur: buf.duration, peak: pk, early };
    });
    // one bar at 120 BPM = 2 s, plus one second of tail
    ok(r.peak > 0.03 && Math.abs(r.dur - 3) < 0.1, `rendered with the plugin: ${JSON.stringify(r)}`);
    ok(r.early > 0.001, 'the first note starts at the beginning');
    const s = await ev(async () => {
      const { exportProject, defaultSettings } = await import('/src/app/export.js');
      const out = await exportProject(app, { ...defaultSettings(app.store.project), source: 'pat', tail: 0, stems: true, format: 'wav' });
      return { kind: out.kind, count: out.count };
    });
    ok(s.kind === 'stems' && s.count === 1, JSON.stringify(s));
  });

  await test('a new audio device (engine restart) loads the plugins again with their state', async () => {
    const owner = `ch:${chId}`;
    await setParam(owner, 'cutoff', 500);
    await ev(() => app.host.restart());
    await sleep(300);
    await ready(owner);
    ok((await status(owner)).state === 'ready', 'loaded in the new context');
    const v = await ev(async (o) => (await app.wam.instance(o).audioNode.getParameterValues(false)).cutoff.value, owner);
    ok(Math.abs(v - 500) < 1, `state kept: cutoff ${v}`);
    ok((await notePeak(chId)) > 0.01, 'plays after the restart');
  });

  await test('an address that is not a plugin shows why, in the editor and a message', async () => {
    const id = await ev(() => app.wam.addInstrument('src/core/constants.js').then((c) => c.id));     // a module, but not a plugin
    await ready(`ch:${id}`);
    const st = await status(`ch:${id}`);
    ok(st.state === 'error' && /not a WAM 2.0 plugin/.test(st.error), JSON.stringify(st));
    await sleep(200);
    ok((await page.locator(`.win[data-id="plugin:${id}"] .wam-msg`).innerText()).includes('could not be loaded'), 'editor explains');
  });
}
