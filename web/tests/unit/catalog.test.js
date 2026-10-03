import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { installPackHook } from '../../src/core/packs.js';
import { buildCatalog, PACKS_DIR } from '../../tools/make-catalog.mjs';

installPackHook();

test('packs/catalog.json is up to date: every pack file is listed with its real checksum, size and plugin list', async () => {
  const fresh = await buildCatalog();
  const onDisk = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, 'catalog.json'), 'utf8'));
  assert.deepEqual(onDisk, fresh, 'run: node tools/make-catalog.mjs');
  const files = fs.readdirSync(PACKS_DIR).filter((f) => f.endsWith('.flpack.js'));
  assert.deepEqual(onDisk.packs.map((p) => p.file).sort(), files.sort());
  for (const e of onDisk.packs) {
    const text = fs.readFileSync(path.join(PACKS_DIR, e.file), 'utf8');
    assert.equal(e.sha256, crypto.createHash('sha256').update(text).digest('hex'), `${e.file} checksum`);
    assert.equal(e.size, Buffer.byteLength(text));
    assert.ok((e.plugins.length > 0 || e.sounds > 0) && e.plugins.every((p) => ['instrument', 'effect', 'controller'].includes(p.kind) && p.name && p.description), `${e.id} plugin list`);
    assert.match(e.version, /^\d+\.\d+\.\d+/);
  }
  assert.equal(onDisk.packs.reduce((n, p) => n + p.plugins.length, 0), 20, 'ten generators, seven effects and three controller scripts are shipped');
  assert.equal(onDisk.packs.reduce((n, p) => n + (p.sounds || 0), 0), 52, 'and 52 sounds');
});

test('pack files are self-contained: no imports, no network, no eval', () => {
  for (const f of fs.readdirSync(PACKS_DIR).filter((x) => x.endsWith('.flpack.js'))) {
    const text = fs.readFileSync(path.join(PACKS_DIR, f), 'utf8');
    assert.equal(/^\s*import\s/m.test(text) || /\bimport\s*\(/.test(text), false, `${f} imports nothing`);
    assert.equal(/\b(fetch|XMLHttpRequest|WebSocket|eval|Function)\s*\(/.test(text), false, `${f} makes no network calls and does not eval`);
    assert.equal(/\b(document|window|localStorage|indexedDB)\b/.test(text), false, `${f} does not touch the page`);
  }
});
