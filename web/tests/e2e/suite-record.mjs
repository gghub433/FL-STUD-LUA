import { page, open, test, ok, sleep, ev } from './harness.mjs';

export async function run_() {
  console.log('audio input recording');
  await open('/');

  await test('the mixer shows an input select next to the arm button', async () => {
    await ev(() => { app.cmd.selectTrack(app.store, 1); });
    await ev(() => app.wm.open('mixer'));
    await sleep(400);
    const sel = page.locator('.mx-dhead select');
    ok(await sel.count() === 1, 'input select rendered');
    const opts = await sel.locator('option').allInnerTexts();
    ok(opts[0] === 'Default input', `first option: ${opts[0]}`);
    ok(opts.length >= 2, `the fake device is listed: ${opts}`);
  });

  await test('Record with an armed track captures the input into an audio channel, a clip and the Recorded folder', async () => {
    await ev(async () => {
      const { createProject } = await import('/src/core/project.js');
      await app.store.replaceProject(createProject());
      app.transport.setMode('song');
      app.cmd.toggleTrackFlag(app.store, 3, 'arm');
    });
    ok(await ev(() => app.store.project.mixer.tracks[3].arm), 'track 3 armed');
    await ev(() => app.transport.record());
    await sleep(2500);
    ok(await ev(() => app.audioRec.recording), 'recording flag on');
    await ev(() => app.transport.stop());
    await page.waitForFunction(() => !app.audioRec.recording && app.store.arrangement.clips.some((c) => c.type === 'audio'), null, { timeout: 8000 });
    const r = await ev(() => {
      const clip = app.store.arrangement.clips.find((c) => c.type === 'audio');
      const ch = app.store.channel(clip.ref);
      const smp = app.bank.map.get(ch.sample.id);
      let pk = 0; const d = smp.channels[0]; for (let i = 0; i < d.length; i += 3) pk = Math.max(pk, Math.abs(d[i]));
      return { type: ch.type, mixer: ch.mixer, start: clip.s, seconds: d.length / smp.rate, peak: pk, clipTicks: clip.l };
    });
    ok(r.type === 'audio', `channel type ${r.type}`);
    ok(r.mixer === 3, `routed to insert 3, got ${r.mixer}`);
    ok(r.start === 0, `clip at song start, got ${r.start}`);
    ok(r.seconds > 2 && r.seconds < 4, `take length ${r.seconds}`);
    ok(r.peak > 0.01, `the fake mic beeps; peak ${r.peak}`);
    const names = await ev(async () => { const l = await app.library.list('recorded'); return l.map((x) => x.name); });
    ok(names.length >= 1, `Recorded folder has the take: ${names}`);
  });

  await test('Record without an armed track does not touch the microphone', async () => {
    await ev(async () => {
      const { createProject } = await import('/src/core/project.js');
      await app.store.replaceProject(createProject());
    });
    const before = await ev(() => app.store.arrangement.clips.length);
    await ev(() => app.transport.record());
    await sleep(300);
    ok(!(await ev(() => app.audioRec.recording)), 'not recording');
    await ev(() => app.transport.stop());
    await sleep(200);
    ok((await ev(() => app.store.arrangement.clips.length)) === before, 'no clip created');
  });

  await test('The recorded clip is undoable in one step', async () => {
    await ev(async () => {
      const { createProject } = await import('/src/core/project.js');
      await app.store.replaceProject(createProject());
      app.transport.setMode('song');
      app.cmd.toggleTrackFlag(app.store, 2, 'arm');
      await app.transport.record();
    });
    await sleep(1200);
    await ev(() => app.transport.stop());
    await page.waitForFunction(() => app.store.arrangement.clips.some((c) => c.type === 'audio'), null, { timeout: 8000 });
    await ev(() => app.store.undo());
    ok((await ev(() => app.store.arrangement.clips.filter((c) => c.type === 'audio').length)) === 0, 'clip removed by one undo');
  });

  await test('Recording while the song loops gives one clip over the loop with a take per pass; takes switch and clean up', async () => {
    await ev(async () => {
      const { createProject } = await import('/src/core/project.js');
      await app.store.replaceProject(createProject());
      app.store.setParam('transport:tempo', 240, { noUndo: true });           // one bar = 1 s
      app.transport.setMode('song');
      app.cmd.setLoop(app.store, { s: 0, e: 384 });
      app.cmd.toggleTrackFlag(app.store, 3, 'arm');
    });
    await ev(() => app.transport.record());
    await sleep(3700);                                                          // three passes and a bit
    await ev(() => app.transport.stop());
    await page.waitForFunction(() => !app.audioRec.recording && app.store.arrangement.clips.some((c) => c.type === 'audio'), null, { timeout: 8000 });
    const r = await ev(() => {
      const arr = app.store.arrangement, c = arr.clips.find((x) => x.type === 'audio');
      return { n: arr.clips.length, s: c.s, l: c.l, o: c.o, id: c.id, takes: c.takes, take: c.take, mixer: app.store.channel(c.ref).mixer };
    });
    ok(r.n === 1 && r.s === 0 && r.l === 384 && r.mixer === 3, `one clip over the loop region: ${JSON.stringify(r)}`);
    ok(r.takes && r.takes.length >= 3, `a take per pass: ${JSON.stringify(r.takes)}`);
    ok(r.take === r.takes[r.takes.length - 1].id, 'the newest take plays');
    for (let i = 1; i < r.takes.length; i++) ok(Math.abs(r.takes[i].t - r.takes[i - 1].t - 1) < 1e-6, `passes are one loop (1 s) apart in the recording: ${r.takes[i].t - r.takes[i - 1].t}`);
    // Takes ▸ Take 1 in the clip menu
    await ev((id) => { app.openWindow('playlist'); const pl = app.playlist; pl.view.px = 0.5; pl.view.x0 = 0; pl.view.y0 = 0; pl.layout(); pl.setSel([id]); }, r.id);
    await sleep(200);
    const m = await ev(() => { const p = app.playlist, b = p.grid.getBoundingClientRect(), c = p.arr.clips[0]; return { x: b.left + p.tx(c.s + c.l) - 8, y: b.top + p.ty(c.track) + 7 }; });
    await page.mouse.click(m.x, m.y);
    await page.locator('.popup .item', { hasText: 'Takes' }).hover();
    await page.locator('.popup[data-level="1"] .item', { hasText: 'Take 1' }).click();
    const o1 = await ev(() => app.store.arrangement.clips[0]);
    ok(o1.take === r.takes[0].id && o1.o === r.o - (r.takes.length - 1) * 384 && o1.s === 0 && o1.l === 384, `take 1 plays: ${JSON.stringify([o1.o, r.o])}`);
    await page.mouse.click(m.x, m.y);
    await page.locator('.popup .item', { hasText: 'Takes' }).hover();
    await page.locator('.popup[data-level="1"] .item', { hasText: 'Delete other takes' }).click();
    const c2 = await ev(() => app.store.arrangement.clips[0]);
    ok(!c2.takes && !c2.take && c2.o === o1.o, 'only the playing take is left');
    await ev(() => app.store.undo()); await sleep(60);
    ok((await ev(() => app.store.arrangement.clips[0].takes.length)) === r.takes.length, 'undo brings the takes back');
    await ev(() => { app.cmd.setLoop(app.store, null); app.cmd.toggleTrackFlag(app.store, 3, 'arm'); });
  });
}
export { run_ as run };
