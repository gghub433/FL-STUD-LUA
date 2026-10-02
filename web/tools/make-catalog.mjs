// Builds packs/catalog.json: the list of downloadable plugin packs with their checksums (what the Plugin store reads).
//   node tools/make-catalog.mjs          writes packs/catalog.json
//   node tools/make-catalog.mjs --check  exits with an error when the file is out of date (used by the tests and CI)
// Every packs/*.flpack.js is loaded the same way the app loads it, so a pack that fails its self-test fails here too.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installPackHook, registerPack } from '../src/core/packs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKS_DIR = path.join(root, 'packs');

export async function buildCatalog(dir = PACKS_DIR) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.flpack.js')).sort();
  const packs = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    let info = null;
    const prev = globalThis.__flluaRegisterPack;
    globalThis.__flluaRegisterPack = (desc) => { info = registerPack(desc); };      // validates the pack (shape + self-test) like the app does
    try { await import(`${pathToFileURL(path.join(dir, file)).href}?catalog=${Date.now()}`); } finally { globalThis.__flluaRegisterPack = prev; }
    if (!info) throw new Error(`${file} did not register a pack`);
    packs.push({
      id: info.id, name: info.name, version: info.version, author: info.author, license: info.license, description: info.description,
      file, size: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex'),
      plugins: info.plugins.map((p) => ({ kind: p.kind, name: p.name, description: p.description })),
    });
  }
  return { catalog: 1, name: 'FL LUA plugin packs', packs };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  installPackHook();
  const target = path.join(PACKS_DIR, 'catalog.json');
  const text = `${JSON.stringify(await buildCatalog(), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) { console.error('packs/catalog.json is out of date: run  node tools/make-catalog.mjs'); process.exit(1); }
    console.log('packs/catalog.json is up to date');
  } else { fs.writeFileSync(target, text); console.log(`packs/catalog.json: ${JSON.parse(text).packs.length} packs`); }
}
