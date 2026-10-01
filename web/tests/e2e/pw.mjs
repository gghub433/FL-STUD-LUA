// Resolve Playwright from the project, a global install, or the sandbox default.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

export async function loadPlaywright() {
  try { return await import('playwright'); } catch (_) { /* fall through */ }
  const require = createRequire(import.meta.url);
  const candidates = [process.env.PLAYWRIGHT_MODULE, '/opt/node22/lib/node_modules/playwright', '/usr/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright'].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return import(pathToFileURL(require.resolve(c)).href);
  }
  throw new Error('Playwright not found. Run `npm i -D playwright` or set PLAYWRIGHT_MODULE.');
}

export function chromiumPath() {
  const dirs = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
  for (const d of dirs) if (fs.existsSync(d)) return d;
  return undefined;
}
