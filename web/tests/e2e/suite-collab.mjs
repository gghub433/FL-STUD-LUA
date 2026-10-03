import { page, browser, port, open, test, ok, sleep, ev } from './harness.mjs';

// Collaboration on the local network: the test page hosts (the dev server carries the hub), a second browser
// profile joins as another computer would. TOOLS > Collaboration… and the status bar.
const view = (p) => p.evaluate(() => { const x = JSON.parse(JSON.stringify(app.store.project)); x.currentPattern = 0; x.seq = 0; x.mixer.selected = 0; x.playlist.current = 0; return JSON.stringify(x); });
const settle = () => sleep(400);

export async function run() {
  console.log('collaboration: host, join, shared edits, samples, undo, a new host');
  await open('/');
  let guestCtx = null, g = null, code = '';

  await test('TOOLS > Collaboration… starts a session on this computer: a code, the status bar shows it', async () => {
    await page.locator('#menubar .menu-top[data-menu="TOOLS"]').click();
    await page.locator('.popup .item', { hasText: 'Collaboration' }).click(); await sleep(200);
    ok((await page.locator('.modal-title').innerText()) === 'Collaboration', 'dialog');
    await page.locator('.modal input[placeholder="Your name"]').fill('Anna');
    await page.locator('.modal .btn', { hasText: 'Start session' }).click();
    await page.waitForSelector('.collab-code b', { timeout: 5000 });
    code = await page.locator('.collab-code b').innerText();
    ok(/^[A-Z2-9]{6}$/.test(code), `code ${code}`);
    ok((await page.locator('.collab-person').count()) === 1, 'one person');
    await page.screenshot({ path: 'tests/e2e/out/collab-host.png' });
    await page.keyboard.press('Escape');
    ok((await page.locator('#status-collab').innerText()).includes('Hosting · 1'), await page.locator('#status-collab').innerText());
  });

  await test('another computer joins with the address and the code and gets the host’s project', async () => {
    await ev(() => app.store.setParam('transport:tempo', 133));
    guestCtx = await browser.newContext({ viewport: { width: 1300, height: 800 } });
    g = await guestCtx.newPage();
    await g.goto(`http://localhost:${port}/?nopicker&empty`);
    await g.waitForFunction(() => window.__ready, null, { timeout: 15000 });
    await g.evaluate(() => app.collab.open());
    await g.locator('.modal input[placeholder="Your name"]').fill('Boris');
    await g.locator('.modal input[placeholder="192.168.1.20:47800"]').fill('localhost:1');
    await g.locator('.modal input[placeholder="ABC123"]').fill(code);
    await g.locator('.modal .btn', { hasText: 'Join' }).click();
    await g.waitForSelector('.collab-msg.err', { timeout: 10000 });
    ok((await g.locator('.collab-msg').innerText()).length > 5, 'a wrong address says why');
    await g.locator('.modal input[placeholder="192.168.1.20:47800"]').fill(`localhost:${port}`);
    await g.locator('.modal input[placeholder="ABC123"]').fill('ZZZZZZ');
    await g.locator('.modal .btn', { hasText: 'Join' }).click();
    await g.waitForFunction(() => /Wrong session code/.test(document.querySelector('.collab-msg').textContent), null, { timeout: 5000 });
    await g.locator('.modal input[placeholder="ABC123"]').fill(code.toLowerCase());
    await g.locator('.modal .btn', { hasText: 'Join' }).click();
    await g.waitForFunction(() => app.collab.state === 'on', null, { timeout: 10000 });
    ok((await g.evaluate(() => app.store.project.tempo)) === 133, 'the host’s project arrived');
    ok((await view(page)) === (await view(g)), 'identical projects');
    ok((await page.locator('#status-collab').innerText()).includes('· 2'), 'the host sees two people');
    ok((await g.locator('.collab-person').count()) === 2, 'the guest sees two people');
    await g.keyboard.press('Escape');
  });

  await test('edits go both ways: knobs, channels, notes, effects; each person keeps their own current pattern', async () => {
    await ev(() => { app.store.setParam('transport:tempo', 141); app.cmd.addChannel(app.store, 'subsynth', { name: 'Anna synth' }); });
    await g.evaluate(() => {
      const ch = app.store.project.channels[0];
      app.store.setParam(`ch:${ch.id}:vol`, 0.31);
      app.cmd.addChannel(app.store, 'pluck', { name: 'Boris pluck' });
      app.cmd.setFx(app.store, 2, 0, 'reverb');
      app.cmd.toggleStep ? app.cmd.toggleStep(app.store, ch.id, 3) : null;
    });
    await settle();
    const host = await ev(() => ({ tempo: app.store.project.tempo, names: app.store.project.channels.map((c) => c.name), vol: app.store.project.channels[0].vol, fx: app.store.project.mixer.tracks[2].fx[0] && app.store.project.mixer.tracks[2].fx[0].type }));
    ok(host.tempo === 141 && host.names.includes('Boris pluck') && host.names.includes('Anna synth') && Math.abs(host.vol - 0.31) < 1e-6 && host.fx === 'reverb', JSON.stringify(host));
    const ids = await ev(() => app.store.project.channels.map((c) => c.id));
    ok(new Set(ids).size === ids.length, 'no id was made twice');
    // a new pattern on the guest; the host stays on its own pattern
    const hostPat = await ev(() => app.store.project.currentPattern);
    await g.evaluate(() => { app.cmd.newPattern(app.store); });
    await settle();
    ok((await ev(() => app.store.project.currentPattern)) === hostPat, 'the host’s current pattern did not move');
    ok((await ev(() => Object.keys(app.store.project.patterns).length)) === (await g.evaluate(() => Object.keys(app.store.project.patterns).length)), 'the pattern exists on both');
    ok((await view(page)) === (await view(g)), 'identical projects');
  });

  await test('two people turning knobs at the same time end up with the same project', async () => {
    const storm = async (seed) => {
      const added = [], removed = [];
      let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
      const chs = app.store.project.channels;
      for (let i = 0; i < 50; i++) {
        const c = chs[Math.floor(rnd() * chs.length)], k = rnd();
        if (k < 0.5) app.store.setParam(`ch:${c.id}:vol`, rnd());
        else if (k < 0.7) app.store.setParam('transport:tempo', 60 + Math.round(rnd() * 100));
        else if (k < 0.9) app.store.setParam(`mx:${1 + Math.floor(rnd() * 4)}:pan`, rnd() * 2 - 1);
        else if (k < 0.8) app.store.edit('Rename', (p) => { const cc = p.channels.find((q) => q.id === c.id); if (cc) cc.name = `N${Math.floor(rnd() * 100)}`; }, [['channels']]);
        else if (k < 0.9) { const pat = app.store.project.currentPattern; app.cmd.addNotes ? null : app.store.edit('Note', (p) => { const { createNote } = window.__pm; const list = (p.patterns[pat].notes[c.id] = p.patterns[pat].notes[c.id] || []); list.push(createNote(p, Math.floor(rnd() * 16) * 24, 24, 48 + Math.floor(rnd() * 24), 100)); }, [['patterns', pat]]); }
        else if (k < 0.95) { app.cmd.addChannel(app.store, 'pluck', { name: `${seed}-${i}` }); added.push(`${seed}-${i}`); }
        else { const mineAdded = app.store.project.channels.filter((q) => q.name.startsWith(`${seed}-`)); if (mineAdded.length) { removed.push(mineAdded[0].name); app.cmd.removeChannel(app.store, mineAdded[0].id); } }
        await new Promise((r) => setTimeout(r, rnd() * 12));
      }
      return added.filter((n) => !removed.includes(n));
    };
    const pm = () => import('/src/core/project.js').then((m) => { window.__pm = m; });
    await ev(pm); await g.evaluate(pm);
    const [keepA, keepB] = await Promise.all([ev(storm, 7), g.evaluate(storm, 99)]);
    await sleep(1000);
    ok((await view(page)) === (await view(g)), 'converged');
    const names = await ev(() => app.store.project.channels.map((c) => c.name));
    ok([...keepA, ...keepB].every((n) => names.includes(n)), `channels added by both are there: ${[...keepA, ...keepB].join()} in ${names.join()}`);
  });

  await test('a recording made by one person reaches the others (fetched over the network)', async () => {
    const id = await g.evaluate(() => {
      const n = 22050, ch = new Float32Array(n); for (let i = 0; i < n; i++) ch[i] = Math.sin(i / 9) * 0.6;
      const e = app.bank.addPCM('Boris take', 44100, [ch]);
      app.cmd.addChannel(app.store, 'sampler', { name: 'Boris take', sample: { id: e.id, name: e.name } });
      return e.id;
    });
    await page.waitForFunction((id) => app.bank.has(id), id, { timeout: 10000 });
    const got = await ev((id) => { const e = app.bank.get(id); return { len: e.length, v: e.channels[0][100], rate: e.rate }; }, id);
    ok(got.len === 22050 && got.rate === 44100 && Math.abs(got.v - Math.sin(100 / 9) * 0.6) < 1e-6, JSON.stringify(got));
    await ev(async () => { await app.host.resume(); });
    const peak = await ev(async (id) => {
      const ch = app.store.project.channels.find((c) => c.sample && c.sample.id === id);
      app.host.send({ t: 'noteOn', ch: ch.id, key: 60, vel: 1 });
      let m = 0; const t0 = performance.now();
      while (performance.now() - t0 < 400) { for (let t = 0; t <= 8; t++) { const [l, r] = app.host.peak(t); m = Math.max(m, l, r); } await new Promise((r) => setTimeout(r, 20)); }
      return m;
    }, id);
    ok(peak > 0.05, `the host plays it: ${peak}`);
  });

  await test('undo takes back only your own edit; the others’ work stays', async () => {
    await g.evaluate(() => app.cmd.addChannel(app.store, 'organ', { name: 'Boris organ' }));
    await settle();
    await ev(() => app.store.setParam('transport:tempo', 99));
    await settle();
    await g.evaluate(() => app.store.undo());
    await settle();
    const names = await ev(() => app.store.project.channels.map((c) => c.name));
    ok(!names.includes('Boris organ') && (await ev(() => app.store.project.tempo)) === 99, `${names} / tempo kept`);
    ok((await view(page)) === (await view(g)), 'identical');
  });

  await test('the host stops: everyone keeps the project; another computer hosts the next session and the first one joins it', async () => {
    await ev(() => app.collab.leave());
    await g.waitForFunction(() => app.collab.state === 'off', null, { timeout: 5000 });
    ok(await g.evaluate(() => app.store.project.channels.some((c) => c.name === 'Boris take')), 'the guest kept the project');
    ok((await page.locator('#status-collab').isVisible()) === false, 'no session on the host any more');
    // the guest's computer is the server now (the dev server stands in for its FL LUA)
    const code2 = await g.evaluate(async () => { await app.collab.start('Boris'); return app.collab.code; });
    ok(/^[A-Z2-9]{6}$/.test(code2) && code2 !== code, 'a new session');
    await ev(async (c) => { await app.collab.join(location.host, c, 'Anna'); }, code2);
    ok((await ev(() => app.collab.host)) === false && (await g.evaluate(() => app.collab.host)) === true, 'roles swapped');
    await ev(() => app.store.setParam('transport:tempo', 150));
    await settle();
    ok((await g.evaluate(() => app.store.project.tempo)) === 150, 'edits flow in the new session');
    ok((await view(page)) === (await view(g)), 'identical');
    await g.evaluate(() => app.collab.leave());
    await page.waitForFunction(() => app.collab.state === 'off', null, { timeout: 5000 });
    // ids after the session continue above everything made in it
    const after = await ev(() => { const ch = app.cmd.addChannel(app.store, 'pluck', { name: 'after' }); return { id: ch.id, max: Math.max(...app.store.project.channels.filter((c) => c !== ch).map((c) => c.id)) }; });
    ok(after.id > after.max, JSON.stringify(after));
    await guestCtx.close();
  });
}
