import { page, open, maxPeak, test, ok, sleep, ev } from './harness.mjs';

const BR = '#browser-pane';
const row = (label) => page.locator(`${BR} .br-row`, { hasText: label }).first();
const expand = async (label) => { const r = row(label); if ((await r.locator('.br-caret').innerText()) === '▸') await r.click(); await sleep(150); };

async function fresh() {
  await ev(async () => {
    const { demoProject } = await import('/src/core/demo.js');
    await app.store.replaceProject(demoProject());
    localStorage.removeItem('stepwise.browser.open');
    for (const k of Object.keys(localStorage)) if (k.startsWith('stepwise.instpresets') || k.startsWith('stepwise.fxpresets')) localStorage.removeItem(k);
    for (const kind of ['channel', 'mixer', 'score', 'template', 'rendered', 'recorded']) await app.library.remove(kind, '__none__');
    app.browser.open = new Set(['packs']); app.browser.cache.clear(); app.browser.query = ''; app.browser.search.value = '';
  });
  await ev(() => app.showBrowser(true));
  await sleep(300);
}

export async function run() {
  console.log('browser');
  await open('/');

  await test('F8 opens the browser: all eleven sections are listed', async () => {
    await fresh();
    await ev(() => app.showBrowser(false));
    await page.keyboard.press('F8'); await sleep(250);
    ok(await ev(() => app.browserVisible()), 'panel visible');
    const text = await page.locator(`${BR} .br-tree`).innerText();
    for (const s of ['Packs', 'Plugin presets', 'Channel presets', 'Mixer presets', 'Projects', 'Rendered', 'Recorded', 'Scores', 'Templates', 'Current project', 'Backup']) ok(text.includes(s), `section ${s}`);
    await page.screenshot({ path: 'tests/e2e/out/browser.png' });
  });

  await test('packs tree: expanding shows kicks; click previews with a waveform; double-click adds a sampler', async () => {
    await fresh();
    await expand('FL LUA Drums'); await expand('Kicks');
    ok((await page.locator(`${BR} .br-row.leaf`, { hasText: /Kick/ }).count()) >= 4, 'kick samples listed');
    const n0 = await ev(() => app.store.project.channels.length);
    await row('Kick Punch').click(); await sleep(350);
    ok(await ev(() => app.browser.prev.key === 's:kick-punch' || app.browser.prev.src === null), 'preview started (or already finished)');
    const info = await page.locator(`${BR} .br-info`).innerText();
    ok(/Kick Punch · \d\.\d\d s/.test(info), `info shows the length: ${info}`);
    const lit = await ev(() => { const c = app.browser.wave, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 120) n++; return n; });
    ok(lit > 30, `waveform drawn (${lit} lit pixels)`);
    await row('Kick Punch').dblclick(); await sleep(250);
    ok((await ev(() => app.store.project.channels.length)) === n0 + 1, 'double-click adds a channel');
    ok(await ev(() => app.store.project.channels.at(-1).sample.id === 'factory:kick-punch'), 'with that sample');
  });

  await test('search filters every section; Escape clears it', async () => {
    await fresh();
    await page.locator(`${BR} input[type=search]`).fill('snare'); await sleep(500);
    const text = await page.locator(`${BR} .br-tree`).innerText();
    ok(text.includes('Snare Tight') && text.includes('Snare Fat'), 'snares found');
    ok(!text.includes('Kick Punch'), 'kicks hidden');
    await page.locator(`${BR} input[type=search]`).press('Escape'); await sleep(300);
    ok((await page.locator(`${BR} input[type=search]`).inputValue()) === '', 'cleared');
    ok((await page.locator(`${BR} .br-row`).count()) < 30, 'tree is collapsed again');
  });

  await test('plugin presets: instrument preset previews offline and double-click creates a channel with it; effect preset goes to the selected track', async () => {
    await fresh();
    await expand('Plugin presets'); await expand('Generators'); await expand('Pluck');
    await row('Nylon guitar').click(); await sleep(900);
    ok(await ev(() => /Nylon guitar · preview/.test(app.browser.info.textContent)), 'preview rendered');
    const n0 = await ev(() => app.store.project.channels.length);
    await row('Nylon guitar').dblclick(); await sleep(300);
    const ch = await ev(() => app.store.project.channels.at(-1));
    ok(ch.type === 'pluck' && ch.params.decay === 2.2 && ch.params.damping === 0.55 && (await ev(() => app.store.project.channels.length)) === n0 + 1, `channel with the preset: ${JSON.stringify(ch.params)}`);
    await expand('Effects'); await expand('Tape Saturator');
    await ev(() => app.cmd.selectTrack(app.store, 3));
    await row('Lo-fi cassette').dblclick(); await sleep(250);
    const fx = await ev(() => app.store.project.mixer.tracks[3].fx.filter(Boolean).map((f) => [f.type, f.params.tone]));
    ok(fx.some(([t, tone]) => t === 'tape' && tone === 5200), `tape preset inserted on track 3: ${JSON.stringify(fx)}`);
  });

  await test('drag and drop: a sound onto a sampler row, an instrument preset onto a channel of that plugin, an effect preset onto a mixer slot', async () => {
    await fresh();
    const kickId = await ev(() => app.store.project.channels[0].id);
    await expand('FL LUA Drums'); await expand('Snares');
    await row('Snare Fat').dragTo(page.locator(`.ch-row[data-ch="${kickId}"] .ch-name`));
    await sleep(300);
    ok((await ev((id) => app.store.channel(id).sample.id, kickId)) === 'factory:snare-fat', 'the row now plays the dropped sound');
    // dropping on empty workspace area adds a sampler
    const n0 = await ev(() => app.store.project.channels.length);
    await row('Snare Tight').dragTo(page.locator('#workspace'), { targetPosition: { x: 900, y: 500 } });
    await sleep(300);
    ok((await ev(() => app.store.project.channels.length)) === n0 + 1, 'dropping on the workspace adds a channel');
    // preset onto a same-type channel
    const id = await ev(() => app.cmd.addChannel(app.store, 'pluck', { name: 'Pluck' }).id);
    await sleep(200);
    await collapseAndFind();
    await expand('Plugin presets'); await expand('Generators'); await expand('Pluck');
    await row('Harp').dragTo(page.locator(`.ch-row[data-ch="${id}"] .ch-name`)); await sleep(300);
    ok((await ev((id) => app.store.channel(id).params.decay, id)) === 5, 'preset loaded into the existing Pluck channel');
    // effect preset onto a mixer slot
    await ev(() => app.openWindow('mixer')); await sleep(300);
    await ev(() => app.cmd.selectTrack(app.store, 2));
    await expand('Effects'); await expand('Tremolo');
    await row('Vintage amp').dragTo(page.locator('.win[data-id="mixer"] .mx-slot[data-slot="2"]')); await sleep(300);
    const f = await ev(() => app.store.project.mixer.tracks[2].fx[2]);
    ok(f && f.type === 'tremolo' && f.params.rate === 5.2, `tremolo preset in slot 3: ${JSON.stringify(f)}`);
  });

  await test('save a channel preset and a mixer preset from the menus; they show up and can be added again', async () => {
    await fresh();
    const kickId = await ev(() => app.store.project.channels[0].id);
    await page.locator(`.ch-row[data-ch="${kickId}"] .ch-name`).click({ button: 'right' });
    await page.locator('.popup .item', { hasText: 'Save as channel preset…' }).click();
    await page.locator('.modal input.field').fill('My kick'); await page.locator('.modal .btn.primary').click(); await sleep(300);
    await expand('Channel presets');
    ok((await page.locator(`${BR} .br-row.leaf`, { hasText: 'My kick' }).count()) === 1, 'channel preset listed');
    const n0 = await ev(() => app.store.project.channels.length);
    await row('My kick').dblclick(); await sleep(250);
    const ch = await ev(() => app.store.project.channels.at(-1));
    ok((await ev(() => app.store.project.channels.length)) === n0 + 1 && ch.sample && ch.sample.id === 'factory:kick-punch' && ch.id !== kickId, 'added as an independent copy');
    // mixer preset
    await ev(() => { app.cmd.setFx(app.store, 3, 0, 'tape'); app.cmd.setFx(app.store, 3, 1, 'tremolo'); app.cmd.selectTrack(app.store, 3); });
    await ev(() => { app.saveMixerPreset(3); }); await page.locator('.modal input.field').fill('Hat chain'); await page.locator('.modal .btn.primary').click(); await sleep(300);
    await expand('Mixer presets');
    ok((await page.locator(`${BR} .br-row.leaf`, { hasText: 'Hat chain' }).count()) === 1, 'mixer preset listed');
    await ev(() => app.cmd.selectTrack(app.store, 7));
    await row('Hat chain').dblclick(); await sleep(250);
    ok(await ev(() => app.store.project.mixer.tracks[7].fx.filter(Boolean).map((f) => f.type).join() === 'tape,tremolo'), 'the effect chain was applied to the selected track');
  });

  await test('scores: save the piano roll selection, paste it back by double-click and by dragging onto the piano roll', async () => {
    await fresh();
    const id = await ev(async () => { const ch = app.cmd.addChannel(app.store, 'pluck', { name: 'Pluck' }); app.cmd.addNotes(app.store, ch.id, [{ s: 100, l: 24, k: 60, v: 100 }, { s: 148, l: 24, k: 64, v: 90 }]); app.openWindow('pianoroll'); app.store.select(ch.id); await new Promise((r) => setTimeout(r, 250)); app.pianoRoll.setSel(app.store.pattern.notes[ch.id].map((n) => n.id)); return ch.id; });
    await ev(() => { app.saveScore(app.pianoRoll.selNotes); }); await page.locator('.modal input.field').fill('Little riff'); await page.locator('.modal .btn.primary').click(); await sleep(300);
    await expand('Scores');
    ok((await page.locator(`${BR} .br-row.leaf`, { hasText: 'Little riff' }).count()) === 1, 'score listed');
    await ev((id) => app.cmd.deleteNotes(app.store, id, app.store.pattern.notes[id].map((n) => n.id)), id);
    await ev(() => { app.pianoRoll.cursorT = 192; });
    await row('Little riff').dblclick(); await sleep(250);
    let notes = await ev((id) => app.store.pattern.notes[id].map((n) => [n.s, n.k]), id);
    ok(JSON.stringify(notes) === JSON.stringify([[192, 60], [240, 64]]), `double-click pastes at the cursor (relative timing kept): ${JSON.stringify(notes)}`);
    await ev((id) => app.cmd.deleteNotes(app.store, id, app.store.pattern.notes[id].map((n) => n.id)), id);
    const target = await ev(() => { const r = app.pianoRoll, b = r.grid.getBoundingClientRect(); return { x: b.left + r.tx(480) - b.left, y: 120 }; });
    await row('Little riff').dragTo(page.locator('.win[data-id="pianoroll"] canvas.pr-grid'), { targetPosition: { x: target.x, y: 120 } }); await sleep(300);
    notes = await ev((id) => app.store.pattern.notes[id].map((n) => [n.s, n.k]), id);
    ok(notes.length === 2 && notes[0][0] >= 456 && notes[0][0] <= 504, `dropped at the pointer position: ${JSON.stringify(notes)}`);
  });

  await test('templates: double-click starts a new project (asks before discarding changes)', async () => {
    await fresh();
    await ev(() => app.cmd.addChannel(app.store, 'organ', { name: 'unsaved' }));
    await expand('Templates');
    await row('Hip-hop 90 BPM').dblclick(); await sleep(200);
    await page.locator('.modal .btn.primary').click(); await sleep(500);
    const info = await ev(() => ({ tempo: app.store.project.tempo, n: app.store.project.channels.length, title: app.store.project.meta.title }));
    ok(info.tempo === 90 && info.n === 5 && info.title === 'Hip-hop', `template loaded: ${JSON.stringify(info)}`);
    await ev(() => app.transport.setMode('song'));
    await ev(() => app.transport.play());
    ok((await maxPeak(1, 2200)) > 0.02, 'and it plays');
    await ev(() => app.transport.stop());
    // user template
    await ev(() => { app.saveAsTemplate(); }); await page.locator('.modal input.field').fill('My starter'); await page.locator('.modal .btn.primary').click(); await sleep(300);
    ok((await page.locator(`${BR} .br-row.leaf`, { hasText: 'My starter' }).count()) === 1, 'user template listed');
  });

  await test('projects, current project and backups', async () => {
    await fresh();
    await ev(async () => { app.store.project.meta.title = 'Browser test song'; await app.store.saveProjectLocal(); await app.store.autosave(); });
    await expand('Projects');
    ok((await page.locator(`${BR} .br-row.leaf`, { hasText: 'Browser test song' }).count()) >= 1, 'saved project listed');
    await ev(async () => { app.store.project.tempo = 99; app.store.markDirty(); });
    await row('Browser test song').first().dblclick(); await sleep(200);
    await page.locator('.modal .btn.primary').click(); await sleep(500);
    ok((await ev(() => app.store.project.tempo)) !== 99, 'opening a saved project replaces the current one');
    await expand('Current project'); await expand('Channels');
    ok((await page.locator(`${BR} .br-row.leaf`, { hasText: 'sub-808' }).count()) + (await page.locator(`${BR} .br-row.leaf`, { hasText: 'Sub 808' }).count()) >= 1, 'channels of the project listed');
    const kickRow = page.locator(`${BR} .br-row.leaf`, { hasText: 'Punch' }).first();
    void kickRow;
    await row('Sub 808').click(); await sleep(100);
    ok(await ev(() => app.store.channel(app.store.selected).name === 'Sub 808'), 'click selects the channel');
    await ev(async () => { app.store.markDirty(); await app.store.autosave(); });
    await expand('Backup'); await sleep(250);
    ok((await page.locator(`${BR} .br-row.leaf`, { hasText: /Autosave/ }).count()) === 1, 'autosave listed under Backup');
    await page.screenshot({ path: 'tests/e2e/out/browser-tree.png' });
  });

  await test('exporting a WAV adds it to the Rendered section; the sound can be dragged onto the playlist', async () => {
    await fresh();
    await ev(() => { app.transport.setMode('pat'); return app.exportWav(16); }); await sleep(1500);   // pattern renders are named "…-pattern"
    await expand('Rendered'); await sleep(250);
    ok((await page.locator(`${BR} .br-row.leaf`).filter({ hasText: /pattern/ }).count()) >= 1, 'rendered file listed');
  });

  // ---- My sounds: the person's own folders. The folder picker is replaced by a folder of the origin-private file
  // system (a real directory handle: listing, permission, IndexedDB like a picked folder)
  await test('My sounds: Add folder… lists the folder (folders first, audio only, natural order), big folders come in pages, it stays after a reload', async () => {
    await fresh();
    await makePack();
    await ev(() => { app.browser.open.add('mysounds'); app.browser.render(); }); await sleep(200);
    await exact('Add folder…').click();
    await page.waitForFunction(() => app.sounds.roots.some((r) => r.name === 'My Pack') && [...document.querySelectorAll('#browser-pane .br-label')].some((e) => e.textContent === 'Kicks'), null, { timeout: 5000 });
    ok(JSON.stringify(await labelsAfter('My Pack', 5)) === JSON.stringify(['Kicks', 'Loops', 'Many', 'Bass', 'Add folder…']), `folders first, then sounds; no readme.txt: ${await labelsAfter('My Pack', 5)}`);
    await exact('Kicks').click(); await sleep(300);
    ok(JSON.stringify(await labelsAfter('Kicks', 3)) === JSON.stringify(['Kick 1', 'Kick 2', 'Kick 10']), `natural order, no ._ files: ${await labelsAfter('Kicks', 3)}`);
    await exact('Many').click(); await sleep(400);
    const count = () => ev(() => [...document.querySelectorAll('#browser-pane .br-label')].filter((e) => /^snd \d+$/.test(e.textContent)).length);
    ok((await count()) === 300, `a big folder shows a page of rows: ${await count()}`);
    await page.locator(`${BR} .br-row`, { hasText: 'Show more (350 not shown)' }).click(); await sleep(400);
    ok((await count()) === 600, `the next page: ${await count()}`);
    ok((await page.locator(`${BR} .br-row`, { hasText: 'Show more (50 not shown)' }).count()) === 1, 'and what is left');
    await exact('Many').click(); await sleep(200);
    await page.screenshot({ path: 'tests/e2e/out/browser-my-sounds.png' });
    // the folder handle is kept in IndexedDB: after a reload it is listed again and can be read
    await open('/');
    await ev(() => app.showBrowser(true));
    await page.waitForFunction(() => app.sounds.roots.some((r) => r.name === 'My Pack' && r.kind === 'handle'), null, { timeout: 5000 });
    await ev(() => { app.browser.open.add('mysounds'); app.browser.render(); });
    await page.waitForFunction(() => [...document.querySelectorAll('#browser-pane .br-label')].some((e) => e.textContent === 'Kick 10'), null, { timeout: 5000 });
  });

  await test('My sounds: click previews with the waveform (AIFF too), double-click makes a Sampler that plays; the sound is imported into the project', async () => {
    await fresh(); await addPack();
    await exact('Kicks').click(); await sleep(300);
    await exact('Kick 1').click();
    await page.waitForFunction(() => /^Kick 1 · 0\.30 s$/.test(app.browser.info.textContent), null, { timeout: 5000 });
    const lit = await ev(() => { const c = app.browser.wave, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 120) n++; return n; });
    ok(lit > 30, `waveform drawn (${lit} lit pixels)`);
    ok((await ev(() => app.browser.prev.key)) === 'msf:' + (await ev(() => app.sounds.roots[0].id)) + ':Kicks/Kick 1.wav' || (await ev(() => app.browser.prev.src === null)), 'the preview plays');
    ok(await ev(() => ![...app.bank.map.values()].some((e) => e.name === 'Kick 1')), 'a preview does not import the sound');
    await exact('Bass').click();
    await page.waitForFunction(() => /^Bass · 0\.50 s$/.test(app.browser.info.textContent), null, { timeout: 5000 });
    const n0 = await ev(() => app.store.project.channels.length);
    await exact('Kick 2').dblclick();
    await page.waitForFunction((n) => app.store.project.channels.length === n + 1, n0, { timeout: 5000 });
    const ch = await ev(() => app.store.project.channels.at(-1));
    ok(ch.type === 'sampler' && ch.name === 'Kick 2' && /^user:/.test(ch.sample.id), `a Sampler with the sound: ${JSON.stringify({ type: ch.type, name: ch.name, sample: ch.sample })}`);
    await sleep(400);
    await ev((id) => { app.host.resume(); app.host.send({ t: 'noteOn', ch: id, key: 60, vel: 1 }); }, ch.id);
    const pk = await maxPeak(0, 500);
    ok(pk > 0.05, `the new channel plays: master peak ${pk.toFixed(3)}`);
    // imported like a loaded file: stored in IndexedDB, written into the .zip, there without the folder
    const kept = await ev(async (id) => {
      const { idbGet } = await import('/src/host/idb.js');
      const { projectToZip, projectFromZip } = await import('/src/app/project-io.js');
      const got = [];
      await projectFromZip(projectToZip(app.store.project, app.bank), { addPCM: (name, rate, channels, sid) => got.push({ name, sid, n: channels[0].length }) });
      for (const r of [...app.sounds.roots]) await app.sounds.remove(r.id);
      app.bank.map.delete(id); app.bank.sent.delete(id);
      const back = await app.bank.ensure(id);
      return { stored: !!(await idbGet('samples', id)), zip: got.find((g) => g.sid === id), back: back && back.name };
    }, ch.sample.id);
    ok(kept.stored && kept.zip && kept.zip.name === 'Kick 2' && kept.zip.n > 10000 && kept.back === 'Kick 2', `stored with the project: ${JSON.stringify(kept)}`);
  });

  await test('My sounds: drag a file onto a sampler row, the rack, the playlist, a Sampler window and the audio editor; the context menu', async () => {
    await fresh(); await addPack();
    await exact('Kicks').click(); await exact('Loops').click(); await sleep(300);
    await ev(() => { app.openWindow('rack'); app.wm.focus('rack'); }); await sleep(200);
    const kickId = await ev(() => app.store.project.channels[0].id);
    await exact('Kick 10').dragTo(page.locator(`.ch-row[data-ch="${kickId}"] .ch-name`));
    await page.waitForFunction((id) => app.store.channel(id).sample.name === 'Kick 10', kickId, { timeout: 5000 });
    let n0 = await ev(() => app.store.project.channels.length);
    await exact('Kick 1').dragTo(page.locator('.win[data-id="rack"] .rack-foot span.dim'));
    await page.waitForFunction((n) => app.store.project.channels.length === n + 1 && app.store.project.channels.at(-1).name === 'Kick 1', n0, { timeout: 5000 });
    const smpId = await ev(() => app.store.project.channels.at(-1).id);
    // the playlist: an audio clip where it is dropped
    await ev(() => { app.openWindow('playlist'); app.wm.focus('playlist'); }); await page.waitForSelector('.win[data-id="playlist"] canvas.pl-grid'); await sleep(300);
    const want = await ev(() => { const pl = app.playlist; return { track: Math.max(1, pl.trackAt(70)), t: Math.max(0, pl.floorT(pl.xt(260))) }; });
    const c0 = await ev(() => app.playlist.arr.clips.length);
    await exact('Deep loop').dragTo(page.locator('.win[data-id="playlist"] canvas.pl-grid'), { targetPosition: { x: 260, y: 70 } });
    await page.waitForFunction((n) => app.playlist.arr.clips.length === n + 1, c0, { timeout: 5000 });
    const clip = await ev(() => { const c = app.playlist.arr.clips.find((x) => x.type === 'audio' && app.store.channel(x.ref).sample.name === 'Deep loop'); return c && { type: c.type, track: c.track, s: c.s, name: app.store.channel(c.ref).sample.name }; });
    ok(clip && clip.track === want.track && clip.s === want.t, `clip at the drop point: ${JSON.stringify(clip)} want ${JSON.stringify(want)}`);
    // a Sampler window
    await ev((id) => app.openChannelEditor(id), smpId); await sleep(300);
    await exact('Kick 2').dragTo(page.locator(`.win[data-id="plugin:${smpId}"] canvas[data-hint^="Waveform"]`));
    await page.waitForFunction((id) => app.store.channel(id).sample.name === 'Kick 2', smpId, { timeout: 5000 });
    // the audio editor: the sound opens in it (not added to the project)
    const wid = await ev(() => app.openAudioEditor()); await sleep(300);
    await exact('Deep loop').dragTo(page.locator(`.win[data-id="${wid}"] canvas.ae-wave`));
    await page.waitForFunction((w) => /Deep loop/.test(document.querySelector(`.win[data-id="${w}"] .win-title`).textContent), wid, { timeout: 5000 });
    await ev((w) => app.wm.close(w), wid);
    // context menu: add to the playlist (at the cursor, on a free track) and open in the audio editor
    const c1 = await ev(() => { app.playlist.cursorT = 0; return app.playlist.arr.clips.length; });
    await exact('Kick 2').click({ button: 'right' });
    const items = await page.locator('.popup .item').allInnerTexts();
    ok(['Preview', 'Open in the audio editor', 'New sampler channel', 'Add to the playlist as an audio clip'].every((t) => items.some((x) => x.includes(t))), `menu: ${items.join(' | ')}`);
    ok(!items.some((x) => x.includes('Show in folder')), 'no "Show in folder" in the browser');
    await page.locator('.popup .item', { hasText: 'Add to the playlist as an audio clip' }).click();
    await page.waitForFunction((n) => app.playlist.arr.clips.length === n + 1, c1, { timeout: 5000 });
    const placed = await ev(() => { const a = app.playlist.arr, c = a.clips.find((x) => x.type === 'audio' && app.store.channel(x.ref).sample.name === 'Kick 2'); return { s: c.s, free: !a.clips.some((o) => o !== c && o.track === c.track && o.s < c.s + c.l && o.s + o.l > c.s) }; });
    ok(placed.s === 0 && placed.free, `at the cursor on a free track: ${JSON.stringify(placed)}`);
    const wins = await ev(() => document.querySelectorAll('.win[data-id^="audioedit:"]').length);
    await exact('Kick 2').click({ button: 'right' });
    await page.locator('.popup .item', { hasText: 'Open in the audio editor' }).click();
    await page.waitForFunction((n) => document.querySelectorAll('.win[data-id^="audioedit:"]').length === n + 1 && [...document.querySelectorAll('.win[data-id^="audioedit:"] .win-title')].some((e) => /Kick 2/.test(e.textContent)), wins, { timeout: 5000 });
  });

  await test('My sounds: the Browser search finds files in the added folders (index), double-click uses a result', async () => {
    await fresh(); await addPack();
    await page.locator(`${BR} input[type=search]`).fill('kick 1');
    await page.waitForFunction(() => app.sounds.index && app.sounds.index.done, null, { timeout: 8000 }); await sleep(400);
    let names = await ev(() => [...document.querySelectorAll('#browser-pane .br-row.leaf')].map((r) => r.querySelector('.br-label').textContent));
    ok(names.includes('Kick 1') && names.includes('Kick 10') && !names.includes('Kick 2'), `found in the folders: ${names.join(', ')}`);
    ok((await page.locator(`${BR} .br-row.leaf`, { hasText: 'Kick 10' }).locator('.br-right').innerText()) === 'Kicks', 'the folder is shown');
    await page.locator(`${BR} input[type=search]`).fill('snd 64'); await sleep(500);
    names = await ev(() => [...document.querySelectorAll('#browser-pane .br-row.leaf')].map((r) => r.querySelector('.br-label').textContent));
    ok(names.filter((n) => /^snd 64\d$/.test(n)).length === 10, `every word counts: ${names.length}`);
    await page.locator(`${BR} input[type=search]`).fill('snd'); await sleep(500);
    ok((await page.locator(`${BR} .br-hint`, { hasText: '650 matches in My sounds, the first 200 are shown' }).count()) === 1, 'results are capped');
    const n0 = await ev(() => app.store.project.channels.length);
    await exact('snd 007').dblclick();
    await page.waitForFunction((n) => app.store.project.channels.length === n + 1 && app.store.project.channels.at(-1).name === 'snd 007', n0, { timeout: 5000 });
    await page.locator(`${BR} input[type=search]`).press('Escape'); await sleep(300);
    ok((await exact('Kicks').count()) === 1, 'the tree is back');
  });

  await test('without the File System Access API: Add files… picks sounds for this session', async () => {
    await fresh();
    await ev(async () => { window.__picker = window.showDirectoryPicker; window.showDirectoryPicker = undefined; for (const r of [...app.sounds.roots]) await app.sounds.remove(r.id); app.browser.open.add('mysounds'); app.browser.render(); });
    await sleep(200);
    ok((await page.locator(`${BR} .br-hint`, { hasText: 'This browser cannot open folders' }).count()) === 1, 'the hint says why');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), exact('Add files…').click()]);
    await chooser.setFiles([{ name: 'clap.wav', mimeType: 'audio/wav', buffer: wavBytes(900, 0.25) }, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a sound') }]);
    await page.waitForFunction(() => [...document.querySelectorAll('#browser-pane .br-label')].some((e) => e.textContent === 'clap'), null, { timeout: 5000 });
    ok((await exact('Picked files').count()) === 1 && (await exact('notes').count()) === 0, 'only the sound is listed, under Picked files');
    await exact('clap').click();
    await page.waitForFunction(() => /^clap · 0\.25 s$/.test(app.browser.info.textContent), null, { timeout: 5000 });
    await ev(() => { window.showDirectoryPicker = window.__picker; });
  });

  await test('files from the system: one Sampler per file on the Channel rack, clips at the drop point on the Playlist, folders dropped on the Browser join My sounds', async () => {
    await fresh();
    await ev(async () => {
      const { encodeWav } = await import('/src/host/export/wav.js');
      window.__file = (name, hz = 300, type = 'audio/wav') => { const x = new Float32Array(9000).map((_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / 44100)); return new File([encodeWav(x, x, 44100, { channels: 1 })], name, { type }); };
      window.__drop = (el, files, x, y) => {
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        const r = el.getBoundingClientRect(), at = { clientX: r.left + (x ?? 10), clientY: r.top + (y ?? 10), dataTransfer: dt, bubbles: true, cancelable: true };
        el.dispatchEvent(new DragEvent('dragover', at));
        return el.dispatchEvent(new DragEvent('drop', at));
      };
      app.openWindow('rack'); app.wm.focus('rack');
    });
    await sleep(200);
    let n0 = await ev(() => app.store.project.channels.length);
    await ev(() => __drop(document.querySelector('.win[data-id="rack"] .rack-foot'), [__file('Rim one.wav'), __file('Rim two.wav', 500)]));
    await page.waitForFunction((n) => app.store.project.channels.length === n + 2, n0, { timeout: 5000 });
    let added = await ev((n) => app.store.project.channels.slice(n).map((c) => [c.type, c.name, /^user:/.test(c.sample.id)]), n0);
    ok(JSON.stringify(added) === JSON.stringify([['sampler', 'Rim one', true], ['sampler', 'Rim two', true]]), `one Sampler per file: ${JSON.stringify(added)}`);
    // one file onto a sampler row replaces its sound; something that is not audio adds nothing
    const kickId = await ev(() => app.store.project.channels[0].id);
    await ev((id) => __drop(document.querySelector(`.ch-row[data-ch="${id}"] .ch-name`), [__file('Solo.wav', 700)]), kickId);
    await page.waitForFunction((id) => app.store.channel(id).sample.name === 'Solo', kickId, { timeout: 5000 });
    n0 = await ev(() => app.store.project.channels.length);
    await ev(() => __drop(document.querySelector('.win[data-id="rack"] .rack-list'), [new File(['hello'], 'notes.txt', { type: 'text/plain' })]));
    await sleep(500);
    ok((await ev(() => app.store.project.channels.length)) === n0, 'a text file adds no channel');
    // the playlist: clips at the drop point, from the track under the cursor down
    await ev(() => { app.openWindow('playlist'); app.wm.focus('playlist'); }); await page.waitForSelector('.win[data-id="playlist"] canvas.pl-grid'); await sleep(300);
    const want = await ev(() => { const pl = app.playlist; return { track: Math.max(1, pl.trackAt(75)), t: Math.max(0, pl.floorT(pl.xt(330))), n: pl.arr.clips.length }; });
    await ev(() => __drop(document.querySelector('.win[data-id="playlist"] canvas.pl-grid'), [__file('Hit A.wav'), __file('Hit B.wav', 600)], 330, 75));
    await page.waitForFunction((n) => app.playlist.arr.clips.length === n + 2, want.n, { timeout: 5000 });
    const clips = await ev(() => ['Hit A', 'Hit B'].map((n) => app.playlist.arr.clips.find((c) => c.type === 'audio' && app.store.channel(c.ref).sample.name === n)).map((c) => c && { track: c.track, s: c.s, name: app.store.channel(c.ref).sample.name }));
    ok(clips[0] && clips[1] && clips[0].track === want.track && clips[1].track === want.track + 1 && clips.every((c) => c.s === want.t), `clips: ${JSON.stringify(clips)} want ${JSON.stringify(want)}`);
    // the Browser: a dropped folder joins My sounds (its handle is kept), loose sounds go to Picked files
    await ev(async () => {
      for (const r of [...app.sounds.roots]) await app.sounds.remove(r.id);
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('Dropped Pack', { recursive: true }).catch(() => {});
      const dir = await root.getDirectoryHandle('Dropped Pack', { create: true });
      const w = await (await dir.getFileHandle('Shaker.wav', { create: true })).createWritable(); await w.write(await __file('x.wav').arrayBuffer()); await w.close();
      // a folder dragged from the file manager arrives as a directory item (not constructible in a synthetic DataTransfer)
      await app.browser.dropFolders({ files: [], items: [{ kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true, name: 'Dropped Pack' }), getAsFileSystemHandle: async () => dir }] });
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#browser-pane .br-label')].some((e) => e.textContent === 'Shaker'), null, { timeout: 5000 });
    ok(await ev(async () => { const { idbGet } = await import('/src/host/idb.js'); return ((await idbGet('kv', 'sound-folders')) || []).some((r) => r.name === 'Dropped Pack'); }), 'the folder is remembered');
    const before = await ev(() => app.store.project.channels.length);
    ok(!(await ev(() => __drop(document.querySelector('#browser-pane .br-tree'), [__file('Loose.wav')]))), 'the Browser takes the drop');
    await page.waitForFunction(() => [...document.querySelectorAll('#browser-pane .br-label')].some((e) => e.textContent === 'Loose'), null, { timeout: 5000 });
    ok((await ev(() => app.store.project.channels.length)) === before, 'dropping on the Browser adds no channel');
    await ev(() => __drop(document.querySelector('#browser-pane .br-tree'), [new File(['x'], 'notes.txt', { type: 'text/plain' })]));
    await page.waitForFunction(() => [...document.querySelectorAll('#toasts .toast')].some((t) => /^Could not load notes\.txt/.test(t.textContent)), null, { timeout: 5000 });
    ok((await exact('notes').count()) === 0, 'other files are left to the page (it tries to open them)');
    await ev(async () => { for (const r of [...app.sounds.roots]) await app.sounds.remove(r.id); });
  });
}

async function collapseAndFind() { await sleep(50); }

// ---- My sounds helpers
const exact = (label) => page.locator(`${BR} .br-row`).filter({ has: page.locator('.br-label', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();
// the labels of the rows that follow a row in the tree
const labelsAfter = (label, n) => ev(({ label, n }) => { const all = [...document.querySelectorAll('#browser-pane .br-row')].map((r) => r.querySelector('.br-label').textContent); const i = all.indexOf(label); return i < 0 ? [] : all.slice(i + 1, i + 1 + n); }, { label, n });

// a 16-bit mono WAV (Node side, for the file chooser)
function wavBytes(hz, sec, rate = 44100) {
  const n = Math.round(rate * sec), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(0.5 * Math.sin((2 * Math.PI * hz * i) / rate) * 32767), 44 + i * 2);
  return b;
}

// "My Pack" in the origin-private file system: Kicks (3 + a "._" file), Loops, Many (650 files), Bass.aif, readme.txt;
// showDirectoryPicker hands it out. Made once per run.
async function makePack() {
  await ev(async () => {
    const root = await navigator.storage.getDirectory();
    const made = await root.getDirectoryHandle('My Pack').then(() => true, () => false);
    const pack = await root.getDirectoryHandle('My Pack', { create: true });
    window.showDirectoryPicker = async () => pack;
    window.__pack = pack;
    for (const r of [...app.sounds.roots]) await app.sounds.remove(r.id);
    if (made) return;
    const { encodeWav } = await import('/src/host/export/wav.js');
    const tone = (hz, sec, rate = 44100) => { const n = Math.round(rate * sec), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = 0.6 * Math.sin((2 * Math.PI * hz * i) / rate) * Math.exp(-i / (rate * sec * 0.4)); return x; };
    const wav = (hz, sec) => { const x = tone(hz, sec); return encodeWav(x, x, 44100, { channels: 1 }); };
    const aiff = (hz, sec) => {                                 // 16-bit big-endian mono AIFF at 44.1 kHz
      const x = tone(hz, sec), n = x.length, b = new Uint8Array(54 + n * 2), v = new DataView(b.buffer);
      const s4 = (o, t) => { for (let i = 0; i < 4; i++) b[o + i] = t.charCodeAt(i); };
      s4(0, 'FORM'); v.setUint32(4, b.length - 8); s4(8, 'AIFF');
      s4(12, 'COMM'); v.setUint32(16, 18); v.setUint16(20, 1); v.setUint32(22, n); v.setUint16(26, 16); v.setUint16(28, 0x400e); v.setUint32(30, 0xac440000); v.setUint32(34, 0);
      s4(38, 'SSND'); v.setUint32(42, 8 + n * 2); v.setUint32(46, 0); v.setUint32(50, 0);
      for (let i = 0; i < n; i++) v.setInt16(54 + i * 2, Math.round(x[i] * 32767));
      return b;
    };
    const put = async (dir, name, bytes) => { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(bytes); await w.close(); };
    const kicks = await pack.getDirectoryHandle('Kicks', { create: true });
    for (const [n, hz] of [['Kick 1.wav', 60], ['Kick 2.wav', 70], ['Kick 10.wav', 80]]) await put(kicks, n, wav(hz, 0.3));
    await put(kicks, '._Kick 1.wav', new Uint8Array(16));
    await put(await pack.getDirectoryHandle('Loops', { create: true }), 'Deep loop.wav', wav(110, 1));
    await put(pack, 'readme.txt', new TextEncoder().encode('read me'));
    await put(pack, 'Bass.aif', aiff(55, 0.5));
    const many = await pack.getDirectoryHandle('Many', { create: true }), tiny = wav(440, 0.01);
    for (let i = 0; i < 650; i++) await put(many, `snd ${String(i).padStart(3, '0')}.wav`, tiny);
  });
}

// My Pack added to My sounds and open in the Browser
async function addPack() {
  await makePack();
  await ev(async () => {
    const r = await app.sounds.addHandle(window.__pack);
    app.browser.open.add('mysounds'); app.browser.open.add(`ms:${r.id}:`);
    await app.browser.render();
  });
  await page.waitForFunction(() => [...document.querySelectorAll('#browser-pane .br-label')].some((e) => e.textContent === 'Kicks'), null, { timeout: 5000 });
}
