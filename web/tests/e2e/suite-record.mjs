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
}
export { run_ as run };
