// End-to-end tests in a real Chromium: UI clicks + proof that the AudioWorklet produces sound.
import { finish } from './harness.mjs';
import { run as basic } from './suite-basic.mjs';
import { run as mixer } from './suite-mixer.mjs';

await basic();
await mixer();
await finish();
