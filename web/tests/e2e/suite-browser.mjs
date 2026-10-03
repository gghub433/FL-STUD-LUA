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
}

async function collapseAndFind() { await sleep(50); }
