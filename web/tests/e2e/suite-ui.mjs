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
}
