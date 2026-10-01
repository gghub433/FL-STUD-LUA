// End-to-end tests in a real Chromium: UI clicks + proof that the AudioWorklet produces sound.
import { finish } from './harness.mjs';
import { run as basic } from './suite-basic.mjs';
import { run as mixer } from './suite-mixer.mjs';
import { run as instruments } from './suite-instruments.mjs';

await basic();
await mixer();
await instruments();
await finish();
