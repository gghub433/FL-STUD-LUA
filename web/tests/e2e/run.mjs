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
import { run as packs } from './suite-packs.mjs';
import { run as master } from './suite-master.mjs';
import { run as files } from './suite-files.mjs';
import { run as midi } from './suite-midi.mjs';
import { run as ui } from './suite-ui.mjs';
import { run as wam } from './suite-wam.mjs';
import { run as probe } from './suite-probe.mjs';

const extra = { probe };                     // only when named
const suites = { basic, mixer, instruments, roll, playlist, plugins, automation, browser, export: exporting, record, patcher, audioedit, packs, master, files, midi, ui, wam };
const pick = process.argv[2];
if (pick && !suites[pick] && !extra[pick]) { console.error(`unknown suite "${pick}" (${Object.keys(suites).join(', ')})`); process.exit(2); }
if (extra[pick]) await extra[pick]();
for (const [name, run] of Object.entries(suites)) if (!pick || pick === name) await run();
await finish();
