// Gets the app ready for the desktop shell: builds the web app (../dist) and copies it to desktop/app,
// together with the icon electron-builder needs. Run by `npm start`, `npm run smoke` and `npm run dist`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url)), web = path.join(here, '..');
execFileSync(process.execPath, [path.join(web, 'tools', 'build.mjs')], { stdio: 'inherit', cwd: web });
fs.rmSync(path.join(here, 'app'), { recursive: true, force: true });
fs.cpSync(path.join(web, 'dist'), path.join(here, 'app'), { recursive: true });
fs.mkdirSync(path.join(here, 'build'), { recursive: true });
fs.copyFileSync(path.join(web, 'assets', 'icon-512.png'), path.join(here, 'build', 'icon.png'));
console.log('desktop/app is ready');
