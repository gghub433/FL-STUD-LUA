import { page, browser, port, open, test, ok, sleep, ev } from './harness.mjs';

// interface: sharp canvases, theme, size, language, keyboard shortcuts, tour
export async function run() {
  console.log('interface: HiDPI, theme, size, language, shortcuts, tour');
  await open('/');
  await ev(() => { for (const k of ['fllua.ui', 'fllua.keys', 'fllua.tour']) localStorage.removeItem(k); });

  await test('HiDPI: canvases get device pixels and keep their size on screen', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 });
    const p2 = await ctx.newPage();
    await p2.goto(`http://localhost:${port}/?nopicker`);
    await p2.waitForFunction(() => window.__ready, null, { timeout: 15000 });
    await p2.evaluate(() => { app.openWindow('mixer'); app.openWindow('loudness'); });
    await p2.waitForTimeout(600);
    const r = await p2.evaluate(() => {
      const sp = document.querySelector('.mx-spectrum'), sc = document.querySelector('canvas.scope');
      return { sp: [sp.width, sp.lw, sp.getBoundingClientRect().width > 0], sc: [sc.width, sc.lw, Math.round(sc.getBoundingClientRect().width)] };
    });
    ok(r.sp[0] === r.sp[1] * 2 && r.sp[2], `mixer spectrum ${JSON.stringify(r.sp)}`);
    ok(r.sc[0] === 224 && r.sc[1] === 112 && r.sc[2] === 112, `scope ${JSON.stringify(r.sc)}`);
    await p2.screenshot({ path: 'tests/e2e/out/hidpi.png' });
    await ctx.close();
  });

  await test('OPTIONS > Interface: light theme, size and language; all kept for the next start', async () => {
    await page.locator('#menubar .menu-top[data-menu="OPTIONS"]').click();
    await page.locator('.popup .item', { hasText: 'Interface' }).hover(); await sleep(200);
    await page.locator('.popup[data-level="1"] .item', { hasText: 'Light' }).click();
    await sleep(200);
    ok((await ev(() => document.documentElement.dataset.theme)) === 'light', 'light theme on');
    ok((await ev(() => getComputedStyle(document.documentElement).filter)).includes('invert'), 'the palette is turned over');
    await ev(async () => { const { demoProject } = await import('/src/core/demo.js'); await app.store.replaceProject(demoProject()); app.openWindow('mixer'); app.openWindow('playlist'); });
    await sleep(500);
    await page.screenshot({ path: 'tests/e2e/out/theme-light.png' });
    await ev(() => app.setPref('scale', 1.25));
    ok((await ev(() => document.documentElement.style.zoom)) === '1.25', 'browser zoom applied');
    await ev(() => app.setPref('scale', 1));
    await ev(() => app.setPref('theme', 'dark'));
    ok((await ev(() => document.documentElement.dataset.theme)) === 'dark', 'back to dark');
    await ev(() => app.setPref('lang', 'ru'));
    await sleep(300);
    ok((await page.locator('#menubar .menu-top[data-menu="FILE"]').innerText()) === 'ФАЙЛ', 'menus in Russian');
    ok((await page.locator('.win[data-id="mixer"] .win-title .t').innerText()).startsWith('Микшер'), 'window titles in Russian');
    await page.locator('#menubar .menu-top[data-menu="FILE"]').click(); await sleep(200);
    const items = await page.locator('.popup .item').allInnerTexts();
    ok(items.some((t) => t.startsWith('Сохранить')) && items.some((t) => t.startsWith('Открыть')), `FILE menu: ${items.slice(0, 6).join(' | ')}`);
    await page.keyboard.press('Escape');
    // the hint bar
    await page.locator('#toolbar [data-section="transport"] .btn').first().hover(); await sleep(150);
    ok(/Пуск|Стоп/.test(await page.locator('#hint').innerText()), `hint: ${await page.locator('#hint').innerText()}`);
    await page.screenshot({ path: 'tests/e2e/out/lang-ru.png' });
    const saved = await ev(() => JSON.parse(localStorage.getItem('fllua.ui')));
    ok(saved.lang === 'ru' && saved.theme === 'dark', JSON.stringify(saved));
    // a reload starts in Russian
    await page.reload(); await page.waitForFunction(() => window.__ready, null, { timeout: 15000 }); await sleep(300);
    ok((await page.locator('#menubar .menu-top[data-menu="EDIT"]').innerText()) === 'ПРАВКА', 'still Russian after a reload');
    await ev(() => app.setPref('lang', 'en'));
    await sleep(200);
    ok((await page.locator('#menubar .menu-top[data-menu="FILE"]').innerText()) === 'FILE', 'English again');
  });

  await test('keyboard shortcuts: F1 lists the commands; a new key works, the old one is free; reset', async () => {
    await page.keyboard.press('F1'); await sleep(300);
    ok((await page.locator('.modal-title').innerText()) === 'Keyboard shortcuts', 'F1 opens the list');
    ok((await page.locator('.ks-row[data-cmd]').count()) > 25, 'commands listed');
    const row = page.locator('.ks-row[data-cmd="window.mixer"]');
    ok((await row.innerText()).includes('F9'), 'Mixer is on F9');
    await row.locator('.btn', { hasText: 'Change' }).click();
    await page.keyboard.press('Control+Shift+KeyK'); await sleep(150);
    ok((await row.innerText()).includes('Ctrl+Shift+K'), 'new key shown');
    await page.locator('.modal .btn', { hasText: 'Close' }).click(); await sleep(150);
    const was = await ev(() => app.wm.isOpen('mixer'));
    await page.keyboard.press('Control+Shift+KeyK'); await sleep(200);
    ok((await ev(() => app.wm.isOpen('mixer'))) !== was, 'the new key toggles the mixer');
    await page.keyboard.press('F9'); await sleep(200);
    ok((await ev(() => app.wm.isOpen('mixer'))) !== was, 'F9 does nothing now');
    ok((await ev(() => JSON.parse(localStorage.getItem('fllua.keys'))['window.mixer'][0])) === 'Ctrl+Shift+K', 'kept on this computer');
    await ev(() => app.keymap.reset());
    await page.keyboard.press('F9'); await sleep(200);
    ok((await ev(() => app.wm.isOpen('mixer'))) === was, 'after a reset F9 is back');
  });

  await test('the tour points at the parts of the window and opens what it talks about', async () => {
    await ev(() => { app.wm.get('rack').close(); app.startTour(); });
    await sleep(300);
    ok((await page.locator('.tour-title').innerText()) === 'Welcome to FL LUA', 'first step');
    for (let i = 0; i < 3; i++) { await page.locator('.tour-bubble .btn', { hasText: 'Next' }).click(); await sleep(250); }
    ok((await page.locator('.tour-title').innerText()) === 'Channel rack' && (await ev(() => app.wm.isOpen('rack'))), 'the channel rack step opened the rack');
    const ring = await page.locator('.tour-ring').boundingBox(), rack = await page.locator('.win[data-id="rack"]').boundingBox();
    ok(Math.abs(ring.x - (rack.x - 4)) < 3 && Math.abs(ring.width - (rack.width + 8)) < 3, 'the ring surrounds the rack');
    await page.screenshot({ path: 'tests/e2e/out/tour.png' });
    await page.keyboard.press('Escape'); await sleep(200);
    ok((await page.locator('.tour-bubble').count()) === 0 && !(await ev(() => app.tourActive)), 'Esc ends it');
  });

  await test('updates (desktop): HELP > Check for updates downloads the new version and restarts into it; other installs open the download', async () => {
    let items = await (async () => { await page.locator('#menubar .menu-top[data-menu="HELP"]').click(); await sleep(150); const t = await page.locator('.popup .item').allInnerTexts(); await page.keyboard.press('Escape'); return t; })();
    ok(!items.some((t) => t.startsWith('Check for updates')), 'a browser has no updates to check');
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 820 } });
    await ctx.addInitScript(() => {
      const on = { progress: [], downloaded: [], error: [] };
      window.__upd = { mode: 'auto', current: '0.3.0', latest: '0.4.0', available: true, notes: 'New: faster engine' };
      window.flluaDesktop = {
        platform: 'linux', setDocument() {}, onOpenPath() {}, onSaveBeforeClose() {}, pendingOpen: async () => null, recent: async () => [], setZoom() {},
        info: async () => ({ version: window.__upd.current, platform: 'linux', arch: 'x64', updates: window.__upd.mode }),
        update: {
          check: async () => ({ ...window.__upd, url: 'https://example.invalid/FL-LUA-linux-x64.deb' }),
          download: async () => { for (const p of [10, 55, 100]) { await new Promise((r) => setTimeout(r, 60)); on.progress.forEach((f) => f({ percent: p, transferred: p * 1e6, total: 100e6 })); } on.downloaded.forEach((f) => f(window.__upd.latest)); return true; },
          install: () => { window.__installed = true; },
          open: (which) => { window.__opened = which; },
          onProgress: (f) => on.progress.push(f), onDownloaded: (f) => on.downloaded.push(f), onError: (f) => on.error.push(f),
        },
      };
      try { localStorage.removeItem('fllua.updates'); } catch (_) {}
    });
    const p2 = await ctx.newPage();
    await p2.goto(`http://localhost:${port}/?nopicker`);
    await p2.waitForFunction(() => window.__ready, null, { timeout: 15000 });
    await p2.locator('#menubar .menu-top[data-menu="HELP"]').click(); await p2.waitForTimeout(150);
    await p2.locator('.popup .item', { hasText: 'Check for updates' }).click(); await p2.waitForTimeout(300);
    const body = () => p2.locator('.modal .upd').innerText();
    ok((await body()).includes('FL LUA 0.4.0 is available (this is 0.3.0).') && (await body()).includes('New: faster engine'), await body());
    await p2.locator('.modal .btn', { hasText: 'Download update' }).click();
    await p2.waitForSelector('.modal .btn:has-text("Restart and update")', { timeout: 3000 });
    ok((await body()).includes('is downloaded'), 'downloaded');
    await p2.evaluate(() => { app.store.edit('test', () => { app.store.project.tempo = 133; }, [['tempo']]); });
    await p2.locator('.modal .btn', { hasText: 'Restart and update' }).click(); await p2.waitForTimeout(200);
    ok((await p2.locator('.modal-title').last().innerText()) === 'Restart and update', 'unsaved work is asked about first');
    await p2.locator('.modal .btn', { hasText: "Don't save" }).click(); await p2.waitForTimeout(100);
    ok(await p2.evaluate(() => window.__installed === true), 'the new version takes over');
    await p2.keyboard.press('Escape');
    // a portable / .deb / Mac copy opens the download instead
    await p2.evaluate(() => { window.__upd.mode = 'page'; app.updates.downloaded = false; app.updates.open(); });
    await p2.waitForSelector('.modal .btn:has-text("Release page")');
    await p2.locator('.modal .btn', { hasText: /^Download$/ }).click();
    ok(await p2.evaluate(() => window.__opened === 'file'), 'Download opens the file of the new version');
    await p2.locator('.modal .btn', { hasText: 'Skip this version' }).click(); await p2.waitForTimeout(100);
    ok(await p2.evaluate(() => JSON.parse(localStorage.getItem('fllua.updates')).skip === '0.4.0'), 'skipped version kept');
    // the daily check stays quiet about a skipped version, and offers the next one
    await p2.evaluate(async () => { app.updates.state.last = 0; await app.updates.autoCheck(); });
    ok((await p2.locator('.modal .upd').count()) === 0, 'quiet about the skipped version');
    await p2.evaluate(async () => { window.__upd.latest = '0.4.1'; app.updates.state.last = 0; await app.updates.autoCheck(); });
    await p2.waitForTimeout(150);
    ok((await body()).includes('FL LUA 0.4.1 is available'), 'the next version is offered');
    await p2.keyboard.press('Escape');
    await p2.evaluate(() => { window.__upd.available = false; window.__upd.latest = '0.3.0'; app.updates.open(); });
    await p2.waitForTimeout(200);
    ok((await body()).includes('FL LUA 0.3.0 is the latest version.'), await body());
    await ctx.close();
  });
}
