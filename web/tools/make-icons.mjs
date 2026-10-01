// Renders assets/icon.svg to PNGs (favicon / touch icons). Needs Playwright: node tools/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../tests/e2e/pw.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const svg = fs.readFileSync(path.join(root, 'icon.svg'), 'utf8');
const pw = await loadPlaywright();
const browser = await (pw.chromium || pw.default.chromium).launch();
for (const size of [32, 64, 192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: path.join(root, `icon-${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
console.log('icons written to', root);
