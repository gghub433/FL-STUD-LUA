import { page, open, test, ok, sleep, ev } from './harness.mjs';

// OPTIONS > Cloud backup…: the folder picker is replaced by a folder of the origin-private file system
export async function run() {
  console.log('cloud backup: copies of the project in a chosen folder');
  await open('/');
  await test('choose a folder: a copy is written at once, then again after changes and the interval; it opens as a project', async () => {
    await ev(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('cloud-folder', { create: true });
      window.showDirectoryPicker = async () => dir;
    });
    await page.locator('#menubar .menu-top[data-menu="OPTIONS"]').click();
    await page.locator('.popup .item', { hasText: 'Cloud backup' }).click(); await sleep(200);
    ok((await page.locator('.modal-title').innerText()) === 'Cloud backup', 'dialog');
    await page.locator('.modal .btn', { hasText: 'Choose folder' }).click();
    await page.waitForFunction(() => app.backup.last > 0, null, { timeout: 5000 });
    ok((await page.locator('.backup-folder').innerText()) === 'cloud-folder', 'folder shown');
    const list = () => ev(async () => { const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('cloud-folder')).getDirectoryHandle('FL LUA backups'); const out = []; for await (const [n] of d.entries()) out.push(n); return out.sort(); });
    let files = await list();
    ok(files.length === 1 && /\.fllua$/.test(files[0]), files.join());
    await page.keyboard.press('Escape');
    // the next copy waits for a change and the interval
    await ev(() => { app.backup.last = 0; app.store.setParam('transport:tempo', 137); });
    await ev(() => app.store.autosave());
    await page.waitForFunction(() => app.backup.last > 0, null, { timeout: 5000 });
    await sleep(1100);
    files = await list();
    ok(files.length === 2, `second copy: ${files.join()}`);
    const tempo = await ev(async (name) => {
      const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('cloud-folder')).getDirectoryHandle('FL LUA backups');
      const text = await (await (await d.getFileHandle(name)).getFile()).text();
      return JSON.parse(text).tempo;
    }, files[1]);
    ok(tempo === 137, `the copy holds the project: ${tempo}`);
    ok((await ev(() => app.backup.prefs.minutes)) === 5, 'every 5 minutes by default');
  });
}
