// Starts a built desktop app with --smoke and reports the result:  node smoke.mjs <path to the executable>
// The app loads itself, waits until it is ready, plays the demo project and checks that audio comes out (see main.js).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) { console.error(`smoke: executable not found: ${exe}`); process.exit(2); }
const out = path.join(os.tmpdir(), `fllua-smoke-${Date.now()}.json`);
const args = ['--smoke'];
if (process.platform === 'linux') args.unshift('--no-sandbox');                    // CI containers run as root
const child = spawn(exe, args, { env: { ...process.env, FLLUA_SMOKE_OUT: out }, stdio: 'inherit' });
const timer = setTimeout(() => { console.error('smoke: timed out after 150 s'); child.kill(); }, 150000);
child.on('exit', (code) => {
  clearTimeout(timer);
  let r = null;
  try { r = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (_) { /* never started */ }
  console.log(`smoke: ${r ? JSON.stringify(r) : 'no result file'} (exit code ${code})`);
  process.exit(r && r.ok ? 0 : 1);
});
