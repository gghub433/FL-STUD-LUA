import { page, open, test, ok, sleep, ev } from './harness.mjs';

// A virtual output stands in for a device: it records what would be sent and the Web MIDI timestamp.
const setup = () => ev(async () => {
  const { emptyProject } = await import('/src/core/demo.js');
  await app.store.replaceProject(emptyProject());
  window.__out = [];
  if (!app.midi.virtual.has('Test Synth')) app.midi.addVirtualOutput('Test Synth', (data, ts) => window.__out.push({ data: Array.from(data), ts, now: performance.now() }));
  app.store.setParam('transport:tempo', 120, { noUndo: true });
});

export async function run() {
  console.log('MIDI out, clock, transport buttons, controller scripts');
  await open('/');

  await test('MIDI Out channel: pattern notes reach the device with timestamps a step apart; the editor monitors them', async () => {
    await setup();
    const id = await ev(() => {
      const ch = app.cmd.addChannel(app.store, 'midiout', { name: 'Hardware synth' });
      app.cmd.setChannelField(app.store, ch.id, 'port', 'Test Synth');
      for (const s of [0, 1, 2, 3]) app.cmd.setStep(app.store, ch.id, s, true, { key: 60 + s });
      return ch.id;
    });
    await ev(() => app.transport.play());
    await sleep(900);
    await ev(() => app.transport.stop());
    await sleep(100);
    const out = await ev(() => window.__out);
    const ons = out.filter((m) => (m.data[0] & 0xf0) === 0x90);
    ok(ons.length >= 4, `notes sent: ${JSON.stringify(out.slice(0, 6))}`);
    ok(ons.slice(0, 4).map((m) => m.data[1]).join() === '60,61,62,63', 'the right keys');
    const gaps = [1, 2, 3].map((i) => ons[i].ts - ons[i - 1].ts);
    ok(gaps.every((g) => Math.abs(g - 125) < 4), `a sixteenth apart at 120 BPM: ${gaps.map((g) => g.toFixed(1))}`);
    ok(out.some((m) => (m.data[0] & 0xf0) === 0x80), 'note offs');
    await ev((id) => app.openChannelEditor(id), id);
    await page.waitForSelector(`.win[data-id="plugin:${id}"]`);
    const txt = await page.locator(`.win[data-id="plugin:${id}"]`).innerText();
    ok(txt.includes('Test Synth') && /note on\s+C5/.test(txt), `editor: ${txt.slice(0, 300)}`);
    await page.screenshot({ path: 'tests/e2e/out/midi-out.png' });
    await ev((id) => app.wm.get(`plugin:${id}`).close(), id);
  });

  await test('MIDI clock: Start, 24 clocks per beat while playing, Stop', async () => {
    await setup();
    await ev(() => app.midi.setClock('Test Synth', true));
    await sleep(100);
    await ev(() => { window.__out = []; app.transport.play(); });
    await sleep(1000);
    await ev(() => app.transport.stop());
    await sleep(100);
    const out = await ev(() => window.__out.map((m) => ({ b: m.data[0], ts: m.ts })));
    ok(out[0] && out[0].b === 0xfa, `starts with Start: ${out.slice(0, 3).map((m) => m.b.toString(16))}`);
    const clocks = out.filter((m) => m.b === 0xf8);
    ok(clocks.length >= 44 && clocks.length <= 52, `${clocks.length} clocks in about a second at 120 BPM`);
    const dt = (clocks.at(-1).ts - clocks[0].ts) / (clocks.length - 1);
    ok(Math.abs(dt - 500 / 24) < 0.5, `clock interval ${dt.toFixed(2)} ms`);
    ok(out.at(-1).b === 0xfc, 'ends with Stop');
    await ev(() => app.midi.setClock('Test Synth', false));
  });

  await test('MIDI settings: learn a transport button; a profile; the button plays and stops', async () => {
    await setup();
    await page.locator('.menu-top', { hasText: 'TOOLS' }).click();
    await page.locator('.popup .item', { hasText: 'MIDI settings' }).click();
    await sleep(300);
    const txt = (await page.locator('.modal').innerText()).toLowerCase();       // section titles are upper-cased by CSS
    ok(txt.includes('output devices') && txt.includes('test synth') && txt.includes('transport buttons'), 'dialog sections');
    await page.screenshot({ path: 'tests/e2e/out/midi-settings.png' });
    await page.locator('.modal .ms-row', { hasText: 'Play / Stop' }).locator('.btn', { hasText: 'Learn' }).click();
    await ev(() => { app.midi.handle([0x90, 94, 100]); app.midi.handle([0x80, 94, 0]); });
    await sleep(200);
    ok((await page.locator('.modal .ms-row', { hasText: 'Play / Stop' }).innerText()).includes('Note 94'), 'learned note 94');
    await page.locator('.modal .btn', { hasText: 'Close' }).click();
    await ev(() => app.midi.handle([0x90, 94, 100]));
    await sleep(300);
    ok(await ev(() => app.host.st.playing), 'the button starts playback');
    await ev(() => app.midi.handle([0x90, 94, 100]));
    await sleep(300);
    ok(!(await ev(() => app.host.st.playing)), 'and stops it');
    const notes = await ev(() => { const before = app.host.st.playing; app.midi.handle([0x90, 60, 100]); return before; });
    ok(notes === false, 'other notes still play the selected channel');
    // a profile replaces the mapping
    const { TRANSPORT_PROFILES } = await ev(async () => { const m = await import('/src/host/midi.js'); app.midi.setTransportMap(m.TRANSPORT_PROFILES[1].map); return { TRANSPORT_PROFILES: m.TRANSPORT_PROFILES.length }; });
    ok(TRANSPORT_PROFILES >= 2, 'profiles');
    await ev(() => app.midi.handle([0xb0, 119, 127]));
    await sleep(300);
    ok(await ev(() => app.host.st.recording), 'CC 119 records (CC profile)');
    await ev(() => { app.midi.handle([0xb0, 117, 127]); app.midi.setTransportMap([]); });
    await sleep(200);
    ok(!(await ev(() => app.host.st.playing)), 'CC 117 stops');
  });

  await test('controller scripts from a pack: off until enabled; knobs move the selected channel', async () => {
    await setup();
    await ev(async () => {
      const src = await (await fetch('/packs/controllers.flpack.js')).text();
      if (!app.packs.has('fllua-controllers')) await app.packs.install(src);
      const ch = app.cmd.addChannel(app.store, 'subsynth', { name: 'Synth' });
      app.store.select(ch.id);
    });
    const before = await ev(() => { const c = app.store.channel(app.store.selected); return JSON.stringify(c.params); });
    await ev(() => app.midi.handle([0xb0, 21, 0]));
    ok((await ev(() => JSON.stringify(app.store.channel(app.store.selected).params))) === before, 'disabled scripts do nothing');
    await ev(() => app.midi.setScriptEnabled('fllua-controllers.knobs', true));
    const r = await ev(() => {
      const c = app.store.channel(app.store.selected), first = app.midi.scriptApi().channelParams()[0];
      app.midi.handle([0xb0, 21, 0]);
      const lo = app.store.getParam(first);
      app.midi.handle([0xb0, 21, 127]);
      return { first, lo, hi: app.store.getParam(first), name: c.name };
    });
    ok(r.hi > r.lo, `CC 21 sweeps ${r.first}: ${r.lo} → ${r.hi}`);
    await ev(() => app.midi.setScriptEnabled('fllua-controllers.knobs', false));
  });
}
