import { page, open, test, ok, sleep, ev } from './harness.mjs';

// The file pickers are native dialogs, so they are replaced by handles from the origin-private file system:
// real FileSystemFileHandle objects, written with the same createWritable() path as a file on disk.
const mockPickers = () => ev(async () => {
  const dir = await navigator.storage.getDirectory();
  window.__picks = { save: 0, open: 0 };
  window.showSaveFilePicker = async (o) => { window.__picks.save++; return dir.getFileHandle(window.__saveName || o.suggestedName, { create: true }); };
  window.showOpenFilePicker = async () => { window.__picks.open++; return [await dir.getFileHandle(window.__openName)]; };
});
const readOpfs = (name) => ev(async (name) => { const dir = await navigator.storage.getDirectory(); const f = await (await dir.getFileHandle(name)).getFile(); return Array.from(new Uint8Array(await f.arrayBuffer())); }, name);
const step = (m) => { if (process.env.E2E_TRACE) console.log(`       · ${m}`); };
const fresh = () => ev(async () => { const { demoProject } = await import('/src/core/demo.js'); await app.store.replaceProject(demoProject()); });

export async function run() {
  console.log('files: save / open / recent / MIDI import');
  await open('/');
  step('page open');
  await mockPickers();
  step('file pickers replaced by the origin-private file system');

  await test('Save as writes a .fllua file, the title shows its name; edits mark it; Ctrl+S saves in place', async () => {
    await fresh();
    step('demo project loaded');
    ok((await page.title()) === 'FL LUA', `fresh title ${await page.title()}`);
    await ev(() => { window.__saveName = 'My song.fllua'; });
    await page.keyboard.press('Control+Shift+s'); await sleep(400);
    step('saved as');
    ok((await page.title()) === 'My song - FL LUA', `title ${await page.title()}`);
    let bytes = await readOpfs('My song.fllua');
    let saved = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
    ok(saved.channels.length === 6 && saved.tempo === 124, 'project JSON written');
    await ev(() => app.store.edit('Tempo', (p) => { p.tempo = 133; }, [['tempo']]));
    await sleep(100);
    ok((await page.title()) === '● My song - FL LUA', `dirty title ${await page.title()}`);
    await page.keyboard.press('Control+s'); await sleep(400);
    ok((await page.title()) === 'My song - FL LUA', 'clean again');
    ok((await ev(() => window.__picks.save)) === 1, 'no second picker: saved in place');
    bytes = await readOpfs('My song.fllua');
    saved = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
    ok(saved.tempo === 133, 'the edit is in the file');
  });

  await test('Open recent brings the saved file back; loading another project forgets the file', async () => {
    await ev(async () => { const { emptyProject } = await import('/src/core/demo.js'); await app.store.replaceProject(emptyProject()); });
    ok((await page.title()) === 'FL LUA', 'another project has no file');
    const recent = await ev(() => (app.recentFiles || []).map((r) => r.name));
    ok(recent[0] === 'My song', `recent ${recent}`);
    await page.locator('#menubar .menu-top', { hasText: 'FILE' }).click();
    await page.locator('.popup .item', { hasText: 'Open recent' }).hover(); await sleep(200);
    await page.locator('.popup[data-level="1"] .item', { hasText: 'My song' }).click();
    await sleep(500);
    ok((await ev(() => app.store.project.tempo)) === 133 && (await page.title()) === 'My song - FL LUA', 'reopened from the recent list');
    await page.locator('#menubar .menu-top', { hasText: 'FILE' }).click();
    const items = await page.locator('.popup .item').allInnerTexts();
    ok(['Save', 'Save as…', 'Import MIDI file…', 'Save a copy in the browser'].every((l) => items.some((t) => t.startsWith(l))), `FILE menu: ${items.join(' | ')}`);
    await page.keyboard.press('Escape');
  });

  await test('a project with a recorded sample is saved as one file with the sample inside', async () => {
    await fresh();
    await ev(() => {
      const n = 22050, ch = new Float32Array(n); for (let i = 0; i < n; i++) ch[i] = Math.sin(i / 7) * 0.5;
      const e = app.bank.addPCM('Take 1', 44100, [ch]);
      app.cmd.addChannel(app.store, 'sampler', { name: 'Take 1', sample: { id: e.id, name: e.name } });
      window.__saveName = 'With sample.fllua';
    });
    await ev(() => app.files.saveAs());
    const bytes = await readOpfs('With sample.fllua');
    ok(bytes[0] === 0x50 && bytes[1] === 0x4b, 'ZIP inside the .fllua');
    const r = await ev(async () => {
      const id = app.store.project.channels.at(-1).sample.id;
      app.bank.map.delete(id);                                   // as if opened on another machine
      window.__openName = 'With sample.fllua';
      await app.files.open();
      return { has: app.bank.has(id), title: document.title, n: app.store.project.channels.length };
    });
    ok(r.has && r.n === 7 && r.title === 'With sample - FL LUA', JSON.stringify(r));
  });

  await test('Import MIDI: tracks become channels, patterns and playlist clips; dropping a .mid file imports it', async () => {
    await ev(async () => { const { emptyProject } = await import('/src/core/demo.js'); await app.store.replaceProject(emptyProject()); });
    const r = await ev(async () => {
      const { demoProject } = await import('/src/core/demo.js');
      const { writeMidi } = await import('/src/core/midi-file.js');
      const bytes = writeMidi(demoProject(), { mode: 'song' });
      window.__mid = Array.from(bytes);
      await app.files.importMidiBytes(bytes, 'groove.mid');
      const p = app.store.project;
      return { ch: p.channels.length, clips: app.store.arrangement.clips.length, tempo: p.tempo, undo: app.store.history.at(-1).label };
    });
    ok(r.ch === 6 && r.clips === 6 && r.tempo === 124 && r.undo === 'Import MIDI groove', JSON.stringify(r));
    // drag and drop
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(window.__mid)], 'dropped.mid', { type: 'audio/midi' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await sleep(600);
    ok((await ev(() => app.store.project.channels.length)) === 12, 'dropped file added six more channels');
    await ev(() => app.transport.setMode('song'));
    await ev(() => app.transport.play());
    await sleep(1500);
    const pk = await ev(() => Math.max(...[0, 1, 2, 3, 4, 5, 6].map((t) => Math.max(...app.host.peak(t)))));
    await ev(() => app.transport.stop());
    ok(pk > 0.02, `the imported song plays: ${pk}`);
    await page.screenshot({ path: 'tests/e2e/out/midi-import.png' });
  });
}
