// Production build: `npm run build` -> dist/
//
// The app is plain ES modules, so the build keeps the module graph (and every `new URL('./x.js', import.meta.url)`
// used for the AudioWorklet and the render worker) exactly as it is and only minifies each file in place:
//   dist/index.html, dist/assets/*, dist/vendor/*, dist/packs/* (plugin packs, untouched), dist/src/**/*.js (minified), dist/src/ui/theme.css (minified)
// Serve dist/ with any static server (`node tools/serve.mjs dist`) or pack it into one executable (`npm run exe`).
// Without esbuild installed the files are copied unminified.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const minify = !process.argv.includes('--no-minify');

let esbuild = null;
try { esbuild = await import('esbuild'); } catch (_) { console.warn('esbuild is not installed: copying files unminified (npm install to enable minification)'); }

// the catalog of downloadable plugin packs is regenerated first, so a release can never ship stale checksums
const { installPackHook } = await import('../src/core/packs.js');
installPackHook();
const { buildCatalog } = await import('./make-catalog.mjs');
fs.writeFileSync(path.join(root, 'packs', 'catalog.json'), `${JSON.stringify(await buildCatalog(), null, 2)}\n`);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const files = [];
function walk(dir, fn) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, fn); else fn(p); } }
const put = (rel, data) => { const f = path.join(out, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); files.push(rel.split(path.sep).join('/')); };

let before = 0, after = 0;
// plugin packs are copied byte for byte: their SHA-256 in packs/catalog.json must keep matching
for (const top of ['assets', 'vendor', 'packs']) walk(path.join(root, top), (p) => put(path.relative(root, p), fs.readFileSync(p)));
put('index.html', fs.readFileSync(path.join(root, 'index.html')));
walk(path.join(root, 'src'), (p) => {
  const rel = path.relative(root, p), src = fs.readFileSync(p);
  const ext = path.extname(p);
  if (esbuild && minify && (ext === '.js' || ext === '.css')) {
    const r = esbuild.transformSync(src.toString('utf8'), { loader: ext === '.js' ? 'js' : 'css', minify: true, target: 'es2022', legalComments: 'none' });
    before += src.length; after += r.code.length;
    put(rel, r.code);
  } else put(rel, src);
});

let sha = 'unknown';
try { sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch (_) { /* not a git checkout */ }
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
put('build-info.json', JSON.stringify({ name: 'FL LUA', version: pkg.version, commit: sha, built: new Date().toISOString(), minified: !!(esbuild && minify), files: files.length }, null, 1));
fs.writeFileSync(path.join(out, 'files.json'), JSON.stringify(files));
console.log(`dist/: ${files.length} files${before ? `, source ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB minified` : ''}`);
