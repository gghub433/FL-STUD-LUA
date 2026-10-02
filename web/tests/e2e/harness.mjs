// End-to-end tests in a real Chromium: UI clicks + proof that the AudioWorklet produces sound.
import fs from 'node:fs';
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import { createServer } from '../../tools/serve.mjs';

const only = process.argv[3];
const pw = await loadPlaywright();
const chromium = pw.chromium || pw.default.chromium;
const srv = createServer(process.env.E2E_ROOT ? path.resolve(process.env.E2E_ROOT) : undefined).listen(0);   // E2E_ROOT=dist tests the production build
const port = srv.address().port;
fs.mkdirSync('tests/e2e/out', { recursive: true });

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 860 }, acceptDownloads: true, permissions: ['microphone'] });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

let passed = 0, failed = 0;
async function test(name, fn) {
  if (only && !name.includes(only)) return;
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); await page.screenshot({ path: `tests/e2e/out/fail-${name.replace(/\W+/g, '_')}.png` }).catch(() => {}); }
}
const ok = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => page.waitForTimeout(ms);
const ev = (fn, arg) => page.evaluate(fn, arg);

async function open(url = '/') {
  const u = url.includes('nopicker') ? url : url + (url.includes('?') ? '&' : '?') + 'nopicker';
  await page.goto(`http://localhost:${port}${u}`);
  await page.waitForFunction(() => window.__ready, null, { timeout: 15000 });
  await sleep(300);
}

async function maxPeak(trackIdx, ms = 1500) {
  // sample the engine meters for a while and keep the maximum
  return ev(async ({ trackIdx, ms }) => {
    let m = 0; const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const [l, r] = app.host.peak(trackIdx);
      m = Math.max(m, l, r);
      await new Promise((r2) => setTimeout(r2, 12));
    }
    return m;
  }, { trackIdx, ms });
}


export { pw, browser, ctx, page, errors, srv, port, open, maxPeak, test, ok, sleep, ev };
export const summary = () => ({ passed, failed });
export async function finish() {
  await sleep(200);
  await page.screenshot({ path: 'tests/e2e/out/final.png' });
  console.log(`\n${passed} passed, ${failed} failed${errors.length ? `, ${errors.length} console errors:\n  ${errors.slice(0, 5).join('\n  ')}` : ''}`);
  await browser.close(); srv.close();
  process.exit(failed || errors.length ? 1 : 0);
}
