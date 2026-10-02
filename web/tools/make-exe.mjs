// Packs the production build into ONE self-contained executable (Node single-executable application).
//   npm run exe        ->  dist-exe/fl-lua  (fl-lua.exe on Windows)
// Double-click it: it starts a local server on http://localhost:8080 (next free port if busy) and opens the browser.
// Everything the app needs (HTML, JS, worklets, icons, MP3 encoder) is inside the file; nothing is installed.
// The executable is built for the platform it is built on (build the Windows one on Windows: see .github/workflows/web.yml).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist'), outDir = path.join(root, 'dist-exe');
const require = createRequire(import.meta.url);
const major = +process.versions.node.split('.')[0];
if (major < 20) { console.error(`Node 20 or newer is required for single-executable builds (this is ${process.version})`); process.exit(1); }

execFileSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], { stdio: 'inherit' });
const files = JSON.parse(fs.readFileSync(path.join(dist, 'files.json'), 'utf8'));
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// ---- the launcher that runs inside the executable (CommonJS, built-ins only)
const launcher = String.raw`'use strict';
// FL LUA launcher: serves the embedded app on localhost and opens the browser.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
let sea = null;
try { const s = require('node:sea'); if (s.isSea()) sea = s; } catch (_) { /* running from source */ }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wav': 'audio/wav', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
const read = (rel) => {
  if (sea) { try { return Buffer.from(sea.getAsset(rel)); } catch (_) { return null; } }
  const f = path.join(__dirname, '..', 'dist', rel);
  return fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f) : null;
};

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log('FL LUA\n  --port N     port to listen on (default 8080)\n  --no-open    do not open the browser\n  --host H     address to bind (default 127.0.0.1)'); process.exit(0); }
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const host = opt('--host', '127.0.0.1');
let port = Number(opt('--port', process.env.PORT || 8080));

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const data = rel.includes('..') ? null : read(rel);
  if (!data) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(data);
});

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch (_) { /* the URL is printed anyway */ }
}

let tries = 0;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && tries++ < 25) { port++; server.listen(port, host); } else { console.error(e.message); process.exit(1); }
});
server.on('listening', () => {
  const url = 'http://localhost:' + port + '/';
  console.log('FL LUA is running at ' + url + '\nClose this window (or press Ctrl+C) to stop it.');
  if (!args.includes('--no-open')) openBrowser(url);
});
server.listen(port, host);
`;
fs.writeFileSync(path.join(outDir, 'launcher.cjs'), launcher);

// ---- Node SEA: blob with the launcher and every dist file as an asset
const assets = {};
for (const f of files.concat(['build-info.json'])) assets[f] = path.join(dist, f);
const cfg = { main: path.join(outDir, 'launcher.cjs'), output: path.join(outDir, 'sea.blob'), disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets };
fs.writeFileSync(path.join(outDir, 'sea-config.json'), JSON.stringify(cfg, null, 1));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(outDir, 'sea-config.json')], { stdio: 'inherit' });

const win = process.platform === 'win32', mac = process.platform === 'darwin';
const exe = path.join(outDir, win ? 'fl-lua.exe' : 'fl-lua');
fs.copyFileSync(process.execPath, exe);
fs.chmodSync(exe, 0o755);
if (mac) { try { execFileSync('codesign', ['--remove-signature', exe]); } catch (_) { /* unsigned node */ } }
const { inject } = require('postject');
await inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(path.join(outDir, 'sea.blob')), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(mac ? { machoSegmentName: 'NODE_SEA' } : {}),
});
if (mac) { try { execFileSync('codesign', ['--sign', '-', exe]); } catch (_) { /* ad-hoc signing is best effort */ } }
console.log(`${path.relative(root, exe)}: ${(fs.statSync(exe).size / 1048576).toFixed(0)} MB, ${files.length} embedded files (${os.platform()}-${os.arch()}, Node ${process.version})`);
