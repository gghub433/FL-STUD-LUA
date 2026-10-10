// Builds the native parts of the desktop app and puts them in native/out/<platform>-<arch>/:
//   fllua-plughost(.exe)   the VST3 / CLAP host (CMake)
//   fllua_bridge.node      the page-process bridge (Node-API)
//   testplugins/           the test VST3 and CLAP plugins in their usual bundle layout (only for tests)
// Usage: node native/build.mjs [--no-test-plugins]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const plat = `${process.platform}-${process.arch}`;
const build = path.join(here, 'build', plat);
const out = path.join(here, 'out', plat);
const testPlugins = !process.argv.includes('--no-test-plugins');
const win = process.platform === 'win32', mac = process.platform === 'darwin';
const run = (cmd, args, opts = {}) => { console.log(`> ${cmd} ${args.join(' ')}`); execFileSync(cmd, args, { stdio: 'inherit', ...opts }); };

fs.mkdirSync(build, { recursive: true });
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// ---------------------------------------------------------------- host, bridge, test plugins (CMake)
const cfg = ['-S', here, '-B', build, '-DCMAKE_BUILD_TYPE=Release', `-DFLLUA_TEST_PLUGINS=${testPlugins ? 'ON' : 'OFF'}`];
if (mac) cfg.push('-DCMAKE_OSX_ARCHITECTURES=' + (process.arch === 'arm64' ? 'arm64' : 'x86_64'));
if (win) cfg.push('-A', 'x64');
run('cmake', cfg);
run('cmake', ['--build', build, '--config', 'Release', '--parallel']);
const art = (name) => [path.join(build, 'Release', name), path.join(build, name)].find((p) => fs.existsSync(p));
const exe = win ? 'fllua-plughost.exe' : 'fllua-plughost';
fs.copyFileSync(art(exe), path.join(out, exe));
if (!win) fs.chmodSync(path.join(out, exe), 0o755);
fs.copyFileSync(art('fllua_bridge.node'), path.join(out, 'fllua_bridge.node'));

// ---------------------------------------------------------------- test plugins in their bundle layout
if (testPlugins) {
  const tp = path.join(out, 'testplugins');
  fs.mkdirSync(tp, { recursive: true });
  const vst3 = path.join(tp, 'FLLUA Test VST3.vst3');
  if (mac) {
    fs.cpSync(art('FLLUA Test VST3.vst3'), vst3, { recursive: true });
    fs.cpSync(art('FLLUA Test CLAP.clap'), path.join(tp, 'FLLUA Test CLAP.clap'), { recursive: true });
  } else {
    const arch = win ? 'x86_64-win' : process.arch === 'arm64' ? 'aarch64-linux' : 'x86_64-linux';
    const dir = path.join(vst3, 'Contents', arch);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(art(win ? 'FLLUA Test VST3.dll' : 'FLLUA Test VST3.so'), path.join(dir, win ? 'FLLUA Test VST3.vst3' : 'FLLUA Test VST3.so'));
    fs.copyFileSync(art('FLLUA Test CLAP.clap'), path.join(tp, 'FLLUA Test CLAP.clap'));
  }
}
console.log(`native parts in ${path.relative(process.cwd(), out) || out}`);
