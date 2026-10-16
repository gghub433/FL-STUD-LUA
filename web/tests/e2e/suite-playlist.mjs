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
    app.cmd.setStep(app.store, ch.id, 0, true, { key: 60 });
    app.cmd.setStep(app.store, ch.id, 8, true, { key: 60 });
    app.transport.setMode('song');
    app.store.setState(['settings', 'snap'], 'cell');
    if (app.wm.isOpen('rack')) app.wm.close('rack');                // the floating channel rack would cover the clips
    app.openWindow('playlist');
    await new Promise((r) => setTimeout(r, 200));
    const pl = app.playlist;
    pl.setTool('draw'); pl.sel.clear(); pl.perf = false; pl.refreshBtns();
    pl.view.px = 0.12; pl.view.rowH = 44; pl.view.x0 = 0; pl.view.y0 = 0; pl.source = { type: 'pattern', ref: 1 };
    pl.layout(); pl.invalidate();
    return ch.id;
  });
}

const BAR = 384;
const at = (t, track, dy = 0.5, dx = 0) => ev(({ t, track, dy, dx }) => { const p = app.playlist, b = p.grid.getBoundingClientRect(); return { x: b.left + p.tx(t) + dx, y: b.top + p.ty(track) + p.view.rowH * dy }; }, { t, track, dy, dx });
const clips = () => ev(() => app.store.arrangement.clips.map((c) => ({ id: c.id, type: c.type, track: c.track, s: c.s, l: c.l, o: c.o, ref: c.ref, mute: c.mute || 0, rev: c.rev || 0, fi: c.fi || 0, use: c.use || null })));
const click = async (t, track, opts = {}) => { const p = await at(t, track, 0.7); await page.mouse.move(p.x, p.y); await page.mouse.down(opts); await page.mouse.up(opts); };

export async function run() {
  console.log('playlist');
  await open('/');

  await test('F5 opens the playlist with tabs, track names and the source list', async () => {
    await fresh();
    await page.keyboard.press('F5'); await sleep(100);
    await page.keyboard.press('F5'); await sleep(200);
    await page.waitForSelector('.win[data-id="playlist"] canvas.pl-grid');
    ok((await page.locator('.pl-head .seg .btn').count()) === 8, 'eight tools');
    ok((await page.locator('.pl-tabs .btn').count()) === 2, 'one arrangement tab plus the add button');
    ok((await page.locator('.pl-src').count()) >= 1, 'pattern 1 listed as a source');
    const sized = await ev(() => { const p = app.playlist; return p.grid.width > 100 && p.names.height > 40 && p.ruler.height > 20; });
    ok(sized, 'canvases sized');
  });

  await test('draw tool places a pattern clip on the snapped bar; song mode plays it; right-click deletes', async () => {
    await fresh();
    await click(BAR * 2 + 40, 3);
    let c = await clips();
    ok(c.length === 1 && c[0].s === BAR * 2 && c[0].track === 3 && c[0].l === BAR && c[0].type === 'pattern', `clip placed: ${JSON.stringify(c)}`);
    await ev(() => app.transport.stop());
    await playSong();
    const peak = await maxPeak(5, 5200);
    ok(peak > 0.02, `song plays the clip at bar 3, peak=${peak}`);
    await stop();
    const p = await at(BAR * 2 + 40, 3, 0.7);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    ok((await clips()).length === 0, 'right-click deleted');
    await ev(() => app.store.undo()); await sleep(60);
    ok((await clips()).length === 1, 'undo restores');
  });

  await test('moving a clip changes track and time in one undo step; edges resize and trim', async () => {
    await fresh();
    await click(0, 1);
    const a = await at(60, 1, 0.7), b = await at(60 + BAR * 3, 4, 0.7);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 }); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
    let c = await clips();
    ok(c.length === 1 && c[0].s === BAR * 3 && c[0].track === 4, `moved: ${JSON.stringify(c)}`);
    // extend to the right: clip is 1 bar long, grab the right edge and drag 2 bars further
    const e1 = await at(BAR * 4 - 2, 4, 0.7), e2 = await at(BAR * 6, 4, 0.7);
    await page.mouse.move(e1.x, e1.y); await page.mouse.down(); await page.mouse.move(e2.x, e2.y, { steps: 8 }); await page.mouse.up();
    c = await clips();
    ok(c[0].l === BAR * 3, `extended to 3 bars (pattern repeats): ${c[0].l}`);
    // trim from the left by one bar
    const l1 = await at(BAR * 3 + 2, 4, 0.7), l2 = await at(BAR * 4, 4, 0.7);
    await page.mouse.move(l1.x, l1.y); await page.mouse.down(); await page.mouse.move(l2.x, l2.y, { steps: 6 }); await page.mouse.up();
    c = await clips();
    ok(c[0].s === BAR * 4 && c[0].l === BAR * 2 && c[0].o === BAR, `trimmed (content stays in place): ${JSON.stringify(c[0])}`);
    await ev(() => app.store.undo()); await sleep(40); await ev(() => app.store.undo()); await sleep(40); await ev(() => app.store.undo()); await sleep(60);
    c = await clips();
    ok(c.length === 1 && c[0].s === 0 && c[0].track === 1, `three undos return to the placed clip: ${JSON.stringify(c)}`);
  });

  await test('placing over a clip overwrites it; slice, mute and select+delete tools', async () => {
    await fresh();
    await ev((BAR) => app.cmd.addClips(app.store, [{ type: 'pattern', track: 2, s: 0, l: BAR * 4, ref: 1 }]), BAR);
    await click(BAR * 8, 1);                              // a 1-bar clip, dragged onto the middle of the long one
    {
      const a = await at(BAR * 8 + 200, 1, 0.7), b = await at(BAR + 200, 2, 0.7);
      await page.mouse.move(a.x, a.y); await page.mouse.down();
      // pass over the end of the long clip first: it must come back when the drag moves on
      const mid = await at(BAR * 3 + 200, 2, 0.7);
      await page.mouse.move(mid.x, mid.y, { steps: 5 });
      await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
    }
    let c = (await clips()).sort((x, y) => x.s - y.s);
    ok(c.length === 3 && c[0].l === BAR && c[1].s === BAR && c[1].l === BAR && c[2].s === BAR * 2 && c[2].l === BAR * 2 && c[2].o === BAR * 2, `split around the dropped clip, nothing lost from the pass-over: ${JSON.stringify(c.map((x) => [x.s, x.l, x.o]))}`);
    await ev(() => app.store.undo()); await sleep(60);
    c = (await clips()).sort((x, y) => x.s - y.s);
    ok(c.length === 2 && c[0].l === BAR * 4 && c[1].s === BAR * 8, `one undo brings back the long clip: ${JSON.stringify(c.map((x) => [x.s, x.l]))}`);
    await ev(() => app.store.redo()); await sleep(60);
    await ev(() => app.playlist.setTool('slice'));
    const a = await at(BAR * 3, 2, 0.1), b = await at(BAR * 3, 2, 0.9);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up();
    c = (await clips()).sort((x, y) => x.s - y.s);
    ok(c.length === 4 && c[2].l === BAR && c[3].s === BAR * 3, `sliced at bar 4: ${JSON.stringify(c.map((x) => [x.s, x.l]))}`);
    await ev(() => app.playlist.setTool('mute'));
    await click(BAR * 3 + 10, 2);
    ok((await clips()).find((x) => x.s === BAR * 3).mute === 1, 'mute tool toggles');
    await ev(() => app.playlist.setTool('select'));
    const s0 = await at(BAR * 2 + 8, 1, 0.05), s1 = await at(BAR * 4 - 8, 3, 0.95);
    await page.mouse.move(s0.x, s0.y); await page.mouse.down(); await page.mouse.move(s1.x, s1.y, { steps: 8 }); await page.mouse.up();
    ok((await ev(() => app.playlist.sel.size)) === 2, 'rectangle selects the two clips');
    await page.keyboard.press('Delete'); await sleep(50);
    ok((await clips()).length === 2, 'Delete removes the selection');
  });

  await test('Ctrl+drag copies a clip; copy and paste; duplicate', async () => {
    await fresh();
    await click(0, 1);
    const a = await at(200, 1, 0.7), b = await at(200 + BAR * 2, 2, 0.7);
    await page.keyboard.down('Control');
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up();
    await page.keyboard.up('Control');
    let c = await clips();
    ok(c.length === 2 && c.some((x) => x.s === 0 && x.track === 1) && c.some((x) => x.s === BAR * 2 && x.track === 2), `original kept, copy moved: ${JSON.stringify(c.map((x) => [x.s, x.track]))}`);
    await page.keyboard.press('Control+a'); await page.keyboard.press('Control+d'); await sleep(60);
    c = await clips();
    ok(c.length === 4, `duplicate adds the copies after the selection: ${c.length}`);
  });

  await test('markers: add marker / time signature / pattern length, loop region, start marker', async () => {
    await fresh();
    const box = await ev(() => { const r = app.playlist.ruler.getBoundingClientRect(); return { x: r.left, y: r.top }; });
    const rx = await ev((t) => app.playlist.tx(t), BAR * 2);
    await page.mouse.click(box.x + rx, box.y + 30, { button: 'right' });
    await page.locator('.popup .item', { hasText: 'Add time signature…' }).click();
    await page.locator('.modal input[type=number]').first().fill('3');
    await page.locator('.modal .btn.primary').click(); await sleep(60);
    let m = await ev(() => app.store.arrangement.markers);
    ok(m.length === 1 && m[0].type === 'timesig' && m[0].num === 3 && m[0].t === BAR * 2, `3/4 marker at bar 3: ${JSON.stringify(m)}`);
    ok(await ev((t) => app.playlist.tm.bbt(t).bar, BAR * 2 + 288) === 4, 'bar counting follows the 3/4 marker (bar 4 starts 288 ticks later)');
    await page.mouse.click(box.x + rx, box.y + 6, { button: 'right' });
    await page.locator('.popup .item', { hasText: 'Add marker…' }).click();
    await page.locator('.modal input.field').first().fill('Drop');
    await page.locator('.modal .btn.primary').click(); await sleep(60);
    m = await ev(() => app.store.arrangement.markers);
    ok(m.some((x) => x.type === 'marker' && x.name === 'Drop'), 'named marker added');
    await page.mouse.click(box.x + rx, box.y + 30, { button: 'right' });
    await page.locator('.popup .item', { hasText: 'Set start marker here' }).click(); await sleep(40);
    ok((await ev(() => app.store.arrangement.start)) === BAR * 2, 'start marker');
    // shift-drag loop
    const x0 = box.x + (await ev((t) => app.playlist.tx(t), BAR)), x1 = box.x + (await ev((t) => app.playlist.tx(t), BAR * 3));
    await page.keyboard.down('Shift');
    await page.mouse.move(x0, box.y + 30); await page.mouse.down(); await page.mouse.move(x1, box.y + 30, { steps: 6 }); await page.mouse.up();
    await page.keyboard.up('Shift');
    const loop = await ev(() => app.store.arrangement.loop);
    ok(loop && loop.s === BAR && loop.e === BAR * 3, `loop region: ${JSON.stringify(loop)}`);
    await page.screenshot({ path: 'tests/e2e/out/playlist-markers.png' });
  });

  await test('arrangements: each has its own clips; switching changes what plays', async () => {
    await fresh();
    await click(0, 1);
    await page.locator('.pl-tabs .btn', { hasText: '+' }).click(); await sleep(80);
    ok((await page.locator('.pl-tabs .btn').count()) === 3, 'second arrangement tab');
    ok((await clips()).length === 0, 'new arrangement starts empty');
    await playSong();
    ok((await maxPeak(5, 1500)) < 0.005, 'empty arrangement is silent');
    await stop();
    await page.locator('.pl-tabs .btn').first().click(); await sleep(80);
    ok((await clips()).length === 1, 'switching back shows the first arrangement');
    await playSong();
    ok((await maxPeak(5, 1500)) > 0.02, 'and it plays');
    await stop();
  });

  await test('track mute button silences the track; track names are editable', async () => {
    await fresh();
    await click(0, 1);
    const nb = await ev(() => { const p = app.playlist, b = p.names.getBoundingClientRect(); return { x: b.left + 132 - 35, y: b.top + p.ty(1) + p.view.rowH - 10 }; });
    await page.mouse.click(nb.x, nb.y); await sleep(60);
    ok(await ev(() => !!app.store.arrangement.tracks[1]?.mute), 'M button mutes track 1');
    await playSong();
    ok((await maxPeak(5, 1500)) < 0.005, 'muted track is silent');
    await stop();
    await page.mouse.click(nb.x, nb.y); await sleep(60);
    ok(await ev(() => !app.store.arrangement.tracks[1]), 'unmute clears the override');
  });

  await test('audio clips: drop sample, reverse, fade, time-stretch (derived sample) and playback', async () => {
    const kick = await fresh();
    void kick;
    const info = await ev(async () => {
      await app.bank.ensure('factory:snare-tight');
      const ch = app.cmd.addAudioChannel(app.store, { id: 'factory:snare-tight', name: 'Snare loop' });
      app.cmd.setMixerTarget(app.store, ch.id, 6);
      const entry = app.bank.get('factory:snare-tight');
      const len = app.cmd.defaultClipLength(app.store.project, 'audio', ch.id, entry);
      const made = app.cmd.addClips(app.store, [{ type: 'audio', track: 2, s: 0, l: len, ref: ch.id }]);
      return { chId: ch.id, clipId: made[0].id, len };
    });
    await ev((i) => app.cmd.updateClips(app.store, [i.clipId], (c) => { c.rev = 1; c.fi = 24; }, 'x'), info);
    let c = (await clips()).find((x) => x.id === info.clipId);
    ok(c.rev === 1 && c.fi === 24, 'reverse + fade stored');
    await playSong();
    const loud = await maxPeak(6, 1800);
    ok(loud > 0.02, `audio clip plays through its mixer track: ${loud}`);
    await stop();
    const ok2 = await ev((i) => app.cmd.stretchClip(app.store, i.clipId, 2, 0), info);
    ok(ok2, 'stretch ran');
    c = (await clips()).find((x) => x.id === info.clipId);
    ok(c.use && c.use.startsWith('stretch:') && Math.abs(c.l - info.len * 2) <= 1, `clip points at a stretched copy, twice as long: ${JSON.stringify(c)} vs ${info.len}`);
    await playSong();
    ok((await maxPeak(6, 1800)) > 0.02, 'stretched clip plays');
    await stop();
    await page.screenshot({ path: 'tests/e2e/out/playlist-audio.png' });
  });

  await test('performance mode: clicking a clip launches it live, clicking again stops it', async () => {
    await fresh();
    await ev((BAR) => app.cmd.addClips(app.store, [{ type: 'pattern', track: 1, s: 0, l: BAR, ref: 1 }]), BAR);
    await ev(() => { app.transport.stop(); const p = app.playlist; p.quant = 0; p.quantSel.value = '0'; p.setPerf(true); });
    const p0 = await at(40, 1, 0.7);
    await page.mouse.click(p0.x, p0.y);
    const loud = await maxPeak(5, 2300);
    ok(loud > 0.02, `launched clip is audible: ${loud}`);
    ok(await ev(() => app.playlist.perfEntries.length === 1 && app.host.st.mode === 'perf'), 'engine reports the launched clip');
    await page.mouse.click(p0.x, p0.y); await sleep(250);
    ok(await ev(() => app.playlist.perfEntries.every((e) => e.stop != null)), 'second click schedules the stop');
    await sleep(2500);
    ok((await maxPeak(5, 1200)) < 0.005, 'silent after the clip is stopped');
    await ev(() => { app.playlist.setPerf(false); app.transport.stop(); });
  });

  await test('visual check: clips of all kinds, markers, loop, selection', async () => {
    await fresh();
    await ev(async () => {
      const cmd = app.cmd, st = app.store;
      cmd.newPattern(st); cmd.newPattern(st);
      const ch = st.project.channels[0];
      st.project.patterns[2].color = '#5b86e0'; st.project.patterns[3].color = '#5cc46a';
      cmd.setStep(st, ch.id, 4, true); cmd.setStep(st, ch.id, 6, true); cmd.setStep(st, ch.id, 12, true);
      await app.bank.ensure('factory:snare-tight'); await app.bank.ensure('factory:kick-punch');
      const a = cmd.addAudioChannel(st, { id: 'factory:snare-tight', name: 'Snare' });
      const au = cmd.addChannel(st, 'automation', { name: 'Filter sweep' });
      au.points = [{ t: 0, v: 0.1, type: 'single' }, { t: 384, v: 0.9, type: 'single' }]; au.len = 384; au.target = 'ch:2:vol';
      cmd.addClips(st, [
        { type: 'pattern', track: 1, s: 0, l: 384 * 4, ref: 1 }, { type: 'pattern', track: 2, s: 384, l: 384 * 3, ref: 2 }, { type: 'pattern', track: 3, s: 0, l: 384 * 2, ref: 3, name: 'Fill' },
        { type: 'audio', track: 4, s: 384, l: 384 * 2, ref: a.id, fi: 0.05 }, { type: 'automation', track: 5, s: 0, l: 384 * 4, ref: au.id },
      ]);
      cmd.addMarker(st, { type: 'marker', t: 384 * 2, name: 'Drop' }); cmd.addMarker(st, { type: 'timesig', t: 384 * 4, num: 3, den: 4 }); cmd.addMarker(st, { type: 'patlen', t: 384 * 6, len: 192 });
      cmd.setLoop(st, { s: 384, e: 384 * 3 }); cmd.setStartMarker(st, 0);
      app.playlist.sel = new Set([st.arrangement.clips[1].id]);
      app.playlist.view.px = 0.1; app.playlist.layout();
    });
    await sleep(300);
    await page.screenshot({ path: 'tests/e2e/out/playlist-visual.png' });
  });

  await test('clip tempo: detect a 100 BPM loop, fit it to 124 BPM, follow a tempo change; audio editor tools', async () => {
    const r = await ev(async () => {
      const { emptyProject } = await import('/src/core/demo.js');
      await app.store.replaceProject(emptyProject());
      app.store.setParam('transport:tempo', 124, { noUndo: true });
      // a 4-bar drum loop at 100 BPM
      const SR = 44100, bpm = 100, beat = 60 / bpm, beats = 16, n = Math.round(beats * beat * SR), x = new Float32Array(n);
      let q = 7; const rnd = () => { q = (q * 16807) % 2147483647; return q / 2147483647 - 0.5; };
      for (let b = 0; b < beats; b++) {
        const s0 = Math.round(b * beat * SR);
        for (let i = 0; i < 0.3 * SR && s0 + i < n; i++) { const t = i / SR; x[s0 + i] += Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 9) * 0.8; }
        if (b % 2) for (let i = 0; i < 0.15 * SR && s0 + i < n; i++) x[s0 + i] += rnd() * Math.exp(-i / SR * 18) * 0.6;
        for (const h2 of [0, 0.5]) { const s1 = Math.round((b + h2) * beat * SR); for (let i = 0; i < 0.04 * SR && s1 + i < n; i++) x[s1 + i] += rnd() * Math.exp(-i / SR * 60) * 0.25; }
      }
      const e = app.bank.addPCM('Loop 100', SR, [x]);
      const ch = app.cmd.addAudioChannel(app.store, { id: e.id, name: e.name });
      const natural = Math.round(beats * beat * 124 * 96 / 60);      // ticks at 124 BPM before fitting
      const [clip] = app.cmd.addClips(app.store, [{ type: 'audio', track: 1, s: 0, l: natural, ref: ch.id }]);
      return { id: clip.id, natural };
    });
    // the dialog from the clip menu
    await ev(() => app.openWindow('playlist')); await sleep(300);
    await ev((id) => { const pl = app.playlist; const clip = pl.arr.clips.find((c) => c.id === id); pl.tempoDialog(clip); }, r.id);
    await sleep(500);
    const first = await page.locator('.modal select').first().inputValue();
    ok(Math.abs(+first - 100) < 0.2, `detected ${first}`);
    await page.locator('.modal .btn', { hasText: 'Apply' }).click();
    await page.waitForFunction((id) => { const c = app.store.arrangement.clips.find((x) => x.id === id); return c && c.bpm; }, r.id, { timeout: 10000 });
    const fitted = await ev((id) => { const c = app.store.arrangement.clips.find((x) => x.id === id); return { l: c.l, stretch: c.stretch, bpm: c.bpm, use: !!c.use }; }, r.id);
    ok(Math.abs(fitted.l - 16 * 96) <= 2 && Math.abs(fitted.stretch - 100 / 124) < 0.01 && fitted.use, `fitted to 4 bars: ${JSON.stringify(fitted)}`);
    // change the project tempo: the clip follows, its length in bars stays
    await ev(() => app.store.setParam('transport:tempo', 140));
    await page.waitForFunction((id) => { const c = app.store.arrangement.clips.find((x) => x.id === id); return Math.abs(c.stretch - 100 / 140) < 0.001; }, r.id, { timeout: 10000 });
    const after = await ev((id) => { const c = app.store.arrangement.clips.find((x) => x.id === id); return { l: c.l, use: c.use }; }, r.id);
    ok(after.l === fitted.l && /:0\.7143:/.test(after.use), `follows: ${JSON.stringify(after)}`);
    // the stretched audio really lasts 4 bars at 140 BPM
    const len = await ev((use) => { const e = app.bank.get(use); return e.length / e.rate; }, after.use);
    ok(Math.abs(len - 16 * 60 / 140) < 0.05, `stretched length ${len} s`);
    // audio editor: detect tempo
    const t = await ev(async (id) => {
      const c = app.store.arrangement.clips.find((x) => x.id === id), ch = app.store.channel(c.ref);
      const ed = app.openAudioEditor({ sampleId: ch.sample.id, chId: ch.id, name: ch.sample.name });
      await new Promise((res) => setTimeout(res, 300));
      const ed2 = ed && ed.detectTempo ? ed : Object.values(app.audioEditors).at(-1);
      const res = await ed2.detectTempo();
      return res.bpm;
    }, r.id);
    ok(Math.abs(t - 100) < 0.2, `audio editor detects ${t}`);
  });

  // the song rendered offline with the engine, notes ringing past the end (consolidated clips keep their tails)
  const renderSong = (key) => ev(async (key) => {
    const { renderOffline } = await import('/src/core/offline.js');
    const samples = new Map([...app.bank.map].map(([id, e]) => [id, { rate: e.rate, channels: e.channels }]));
    window.__renders = window.__renders || {};
    window.__renders[key] = renderOffline(app.store.project, samples, { mode: 'song', sampleRate: 44100, tail: 3, ring: true });
  }, key);
  const compareRenders = (a, b) => ev(({ a, b }) => {
    const x = window.__renders[a], y = window.__renders[b], n = Math.min(x.left.length, y.left.length);
    let d = 0, pk = 0;
    // (the new clip, like every clip, fades in over its first 24 frames against clicks: they are left out)
    for (let i = x.left.findIndex((v) => v !== 0) + 32; i < n; i++) { d = Math.max(d, Math.abs(x.left[i] - y.left[i]), Math.abs(x.right[i] - y.right[i])); pk = Math.max(pk, Math.abs(x.left[i])); }
    return { d, pk };
  }, { a, b });

  await test('consolidate: selected clips become one audio clip that sounds like them; one undo restores', async () => {
    await fresh();
    const ids = await ev(async (BAR) => {
      await app.bank.ensure('factory:snare-tight');
      const sn = app.cmd.addAudioChannel(app.store, { id: 'factory:snare-tight', name: 'Snare' });
      app.cmd.setMixerTarget(app.store, sn.id, 6);
      app.cmd.setFx(app.store, 5, 0, 'delay');                         // a tail that must survive the consolidation
      const made = app.cmd.addClips(app.store, [{ type: 'pattern', track: 1, s: 0, l: BAR * 2, ref: 1 }, { type: 'audio', track: 2, s: BAR / 2, l: BAR / 2, ref: sn.id }]);
      app.playlist.setTool('select');
      app.playlist.setSel(made.map((c) => c.id));
      return made.map((c) => c.id);
    }, BAR);
    await renderSong('before');
    const m = await at(BAR * 2, 1, 0, -8);                              // the ▾ menu button in the clip header
    await page.mouse.click(m.x, m.y + 7);
    await page.locator('.popup .item', { hasText: 'Consolidate to audio clip…' }).click();
    ok((await page.locator('.modal select').first().inputValue()) === 'clips', 'selected clips only by default');
    await page.locator('.modal input.field').first().fill('2');
    await page.locator('.modal .btn.primary').click();
    await page.waitForFunction(() => app.store.arrangement.clips.length === 3, null, { timeout: 20000 });
    const r = await ev((ids) => {
      const arr = app.store.arrangement, made = arr.clips.find((c) => !ids.includes(c.id)), ch = app.store.channel(made.ref);
      return { made, mixer: ch.mixer, name: ch.name, sample: !!app.bank.get(ch.sample.id), muted: arr.clips.filter((c) => ids.includes(c.id)).map((c) => c.mute), sel: [...app.playlist.sel] };
    }, ids);
    ok(r.made.type === 'audio' && r.made.s === 0 && r.made.track === 3 && r.made.o === 0, `audio clip at the range start on a free track: ${JSON.stringify(r.made)}`);
    ok(r.made.l > BAR * 2, `the delay tail is in the clip: ${r.made.l}`);
    ok(r.mixer === 0 && r.sample, 'the clip plays its rendered sample into the master');
    ok(r.muted.every((v) => v === 1), 'originals muted');
    ok(r.sel.length === 1 && r.sel[0] === r.made.id, 'the new clip is selected');
    const kept = await ev(async (name) => (await app.library.list('rendered')).some((x) => x.name === name), r.name);
    ok(kept, 'the audio is kept in Browser > Rendered');
    await renderSong('after');
    const cmp = await compareRenders('before', 'after');
    ok(cmp.pk > 0.05 && cmp.d < cmp.pk * 3e-3, `sounds like the originals: largest difference ${cmp.d} of ${cmp.pk}`);
    await playSong();
    const live = await maxPeak(0, 1500);
    ok(live > 0.02 && (await maxPeak(5, 300)) < 0.005, `plays live from the new clip, the originals are silent: ${live}`);
    await stop();
    await ev(() => app.store.undo()); await sleep(80);
    const u = await ev((ids) => ({ n: app.store.arrangement.clips.length, mute: app.store.arrangement.clips.map((c) => c.mute), audio: app.store.project.channels.filter((c) => c.type === 'audio').length }), ids);
    ok(u.n === 2 && u.mute.every((v) => !v) && u.audio === 1, `one undo restores everything: ${JSON.stringify(u)}`);
  });

  await test('render a playlist track to an audio clip, removing the originals', async () => {
    await fresh();
    await ev((BAR) => app.cmd.addClips(app.store, [{ type: 'pattern', track: 3, s: BAR, l: BAR, ref: 1 }]), BAR);
    const nb = await ev(() => { const p = app.playlist, b = p.names.getBoundingClientRect(); return { x: b.left + 40, y: b.top + p.ty(3) + 10 }; });
    await page.mouse.click(nb.x, nb.y, { button: 'right' });
    await page.locator('.popup .item', { hasText: 'Render track to audio clip…' }).click();
    await page.locator('.modal select').last().selectOption('remove');
    await page.locator('.modal .btn.primary').click();
    await page.waitForFunction(() => app.store.arrangement.clips.length === 1 && app.store.arrangement.clips[0].type === 'audio', null, { timeout: 20000 });
    const c = (await clips())[0];
    ok(c.track === 3 && c.s === BAR, `the clip takes the track's place: ${JSON.stringify(c)}`);
    await playSong();
    ok((await maxPeak(0, 2500)) > 0.02, 'and plays');
    await stop();
    await ev(() => app.playlist.setSel([]));
  });

  await test('auto crossfade: an audio clip dropped over another keeps 50 ms under it; export and the live engine crossfade alike', async () => {
    await fresh();
    const ids = await ev(() => {
      app.store.setParam('transport:tempo', 120, { noUndo: true });          // 192 ticks = 1 s
      const mk = (name, v) => { const e = app.bank.addPCM(name, 44100, [new Float32Array(88200).fill(v)]); return app.cmd.addAudioChannel(app.store, { id: e.id, name }); };
      const a = mk('Flat A', 0.4), b = mk('Flat B', 0.3);
      const [ca, cb] = app.cmd.addClips(app.store, [{ type: 'audio', track: 1, s: 0, l: 192, ref: a.id }, { type: 'audio', track: 2, s: 400, l: 192, ref: b.id }]);
      const pl = app.playlist; pl.setTool('draw'); pl.view.px = 1; pl.view.x0 = 0; pl.layout();
      return { a: ca.id, b: cb.id };
    });
    // drag B onto the end of A (Alt: no snapping)
    const g0 = await at(480, 2, 0.7), g1 = await at(480 - 220, 1, 0.7);
    await page.keyboard.down('Alt');
    await page.mouse.move(g0.x, g0.y); await page.mouse.down(); await page.mouse.move(g1.x, g1.y, { steps: 8 }); await page.mouse.up();
    await page.keyboard.up('Alt');
    const c = await ev((ids) => { const all = app.store.arrangement.clips; return { a: all.find((x) => x.id === ids.a), b: all.find((x) => x.id === ids.b), n: all.length }; }, ids);
    ok(c.n === 2 && c.b.track === 1 && c.b.s > 150 && c.b.s < 192, `B dropped over the end of A: ${JSON.stringify(c)}`);
    ok(c.a.l === c.b.s - c.a.s + 10, `A keeps ceil(50 ms) = 10 ticks under B: ${c.a.l}`);
    const r = await ev(async (bs) => {
      const job = () => ({ project: JSON.parse(JSON.stringify(app.store.project)), samples: [...app.bank.map].map(([id, e]) => ({ id, rate: e.rate, channels: e.channels })), opts: { mode: 'song', sampleRate: 44100, tail: 0 } });
      const { renderInWorker } = await import('/src/host/export/render-client.js');
      const { renderWithWebAudio } = await import('/src/host/export/render-webaudio.js');
      const exp = (await renderInWorker(job()).promise).result.left;
      const live = (await renderWithWebAudio(job(), {}, { workletUrl: app.host.workletUrl, moduleHooks: app.host.moduleHooks || [] }).promise).result.left;
      const lat = exp.findIndex((v) => Math.abs(v) > 1e-6), x0 = lat + Math.ceil((bs / 192) * 44100), xf = Math.round(0.05 * 44100);
      let diff = 0, jump = 0;
      for (let i = 0; i < Math.min(exp.length, live.length); i++) diff = Math.max(diff, Math.abs(exp[i] - live[i]));
      for (let i = x0 - 300; i < x0 + xf + 300; i++) jump = Math.max(jump, Math.abs(exp[i] - exp[i - 1]));
      return { diff, jump, a: exp[x0 - 200], mid: exp[x0 + (xf >> 1)], b: exp[x0 + xf + 200] };
    }, c.b.s);
    ok(r.diff < 1e-4, `export and the AudioWorklet engine give the same samples: ${r.diff}`);
    ok(Math.abs(r.b / r.a - 0.75) < 0.01, `A then B: ${r.a} → ${r.b}`);
    ok(Math.abs(r.mid / r.a - (0.7 * Math.SQRT1_2) / 0.4) < 0.02, `equal power in the middle (-3 dB each): ${r.mid / r.a}`);
    ok(r.jump < r.a * 0.01, `no clicks: ${r.jump}`);
    // the project setting turns it off
    await ev(() => app.projectSettings());
    await page.locator('.modal input[type=checkbox]').uncheck();
    await page.locator('.modal .btn.primary').click(); await sleep(60);
    ok((await ev(() => app.store.project.settings.xfade)) === 0, 'Auto crossfade off');
    await ev(() => app.store.undo()); await sleep(60);
    ok((await ev(() => app.store.project.settings.xfade)) === 1, 'undo turns it back on');
    await page.screenshot({ path: 'tests/e2e/out/playlist-crossfade.png' });
  });
}
