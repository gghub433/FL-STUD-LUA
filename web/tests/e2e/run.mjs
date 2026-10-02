// End-to-end tests in a real Chromium: UI clicks + proof that the AudioWorklet produces sound.
// usage: node tests/e2e/run.mjs [suite] [test-name-filter]
import { finish } from './harness.mjs';
import { run as basic } from './suite-basic.mjs';
import { run as mixer } from './suite-mixer.mjs';
import { run as instruments } from './suite-instruments.mjs';
import { run as roll } from './suite-roll.mjs';
import { run as playlist } from './suite-playlist.mjs';
import { run as plugins } from './suite-plugins.mjs';
import { run as automation } from './suite-automation.mjs';
import { run as browser } from './suite-browser.mjs';
import { run as exporting } from './suite-export.mjs';
import { run as record } from './suite-record.mjs';
import { run as patcher } from './suite-patcher.mjs';
import { run as audioedit } from './suite-audioedit.mjs';

const suites = { basic, mixer, instruments, roll, playlist, plugins, automation, browser, export: exporting, record, patcher, audioedit };
const pick = process.argv[2];
if (pick && !suites[pick]) { console.error(`unknown suite "${pick}" (${Object.keys(suites).join(', ')})`); process.exit(2); }
for (const [name, run] of Object.entries(suites)) if (!pick || pick === name) await run();
await finish();
