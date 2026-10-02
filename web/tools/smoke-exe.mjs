// Starts the packed executable, checks that it serves the app and its worklet, then stops it.  node tools/smoke-exe.mjs [path]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.argv[2] || path.join(root, 'dist-exe', process.platform === 'win32' ? 'fl-lua.exe' : 'fl-lua');
const port = 18000 + Math.floor(Math.random() * 1000);
const child = spawn(exe, ['--no-open', '--port', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
let ready = false;
child.stdout.on('data', (d) => { if (String(d).includes('is running')) ready = true; });
const fail = (m) => { console.error(`smoke test failed: ${m}`); child.kill(); process.exit(1); };
const t0 = Date.now();
while (!ready && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 100));
if (!ready) fail('the executable did not start');
for (const [url, needle] of [['/', '<title>FL LUA</title>'], ['/src/app.js', 'worklet'], ['/src/worklet/processor.js', 'registerProcessor'], ['/vendor/lamejs/lame.min.js', 'lamejs'], ['/build-info.json', 'FL LUA']]) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`);
  const body = await res.text();
  if (res.status !== 200 || !body.includes(needle)) fail(`${url}: ${res.status}`);
}
if ((await fetch(`http://127.0.0.1:${port}/nope`)).status !== 404) fail('missing files must be 404');
console.log(`ok: ${path.basename(exe)} serves the app on port ${port}`);
child.kill();
process.exit(0);
