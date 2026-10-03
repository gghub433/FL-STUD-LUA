import { page, open, ok, ev, sleep } from './harness.mjs';

// Diagnostic: the File System Access calls of a save, one at a time (which one takes the browser down in CI)
export async function run() {
  console.log('probe: file system access calls');
  const steps = [
    ['opfs write', async () => { const d = await navigator.storage.getDirectory(); const h = await d.getFileHandle('probe.txt', { create: true }); const w = await h.createWritable(); await w.write(new Uint8Array([1, 2, 3])); await w.close(); window.__h = h; return 'written'; }],
    ['queryPermission', async () => (window.__h.queryPermission ? window.__h.queryPermission({ mode: 'readwrite' }) : 'none')],
    ['isSameEntry', async () => String(await window.__h.isSameEntry(window.__h))],
    ['idb put handle', async () => { const { idbPut } = await import('/src/host/idb.js'); await idbPut('kv', 'probe-handle', { name: 'probe', handle: window.__h }); return 'stored'; }],
    ['idb get handle', async () => { const { idbGet } = await import('/src/host/idb.js'); const v = await idbGet('kv', 'probe-handle'); return v && v.handle ? v.handle.name : 'none'; }],
    ['getFile after idb', async () => { const { idbGet } = await import('/src/host/idb.js'); const v = await idbGet('kv', 'probe-handle'); const f = await v.handle.getFile(); return String(f.size); }],
  ];
  await open('/');
  for (const [name, fn] of steps) {
    console.log(`  probe: ${name} …`);
    try { const r = await page.evaluate(fn); console.log(`  probe: ${name} -> ${r}`); } catch (e) { console.log(`  probe: ${name} FAILED ${e.message.split('\n')[0]}`); return; }
    await sleep(500);
    try { await page.title(); } catch (e) { console.log(`  probe: the page or browser is gone after ${name}`); return; }
  }
  ok(true, '');
}
