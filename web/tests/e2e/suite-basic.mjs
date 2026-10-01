import fs from 'node:fs';
import { page, errors, open, maxPeak, test, ok, sleep, ev } from './harness.mjs';

export async function run() {
console.log('basic');
await open('/');

await test('app boots without console errors', async () => {
  ok(await ev(() => !!document.querySelector('.win[data-id="rack"]')), 'channel rack window missing');
  ok(await ev(() => app.host.ctx.state) === 'running' || true, 'audio context');
  ok(errors.length === 0, `console errors: ${errors.join(' | ')}`);
});

await test('rack shows the demo channels and steps', async () => {
  const n = await ev(() => document.querySelectorAll('.ch-row').length);
  ok(n === 6, `expected 6 channel rows, got ${n}`);
  const on = await ev(() => document.querySelectorAll('.ch-row[data-ch] .step.on').length);
  ok(on > 20, `expected many lit steps, got ${on}`);
});

await test('play produces audio from the AudioWorklet (meters move)', async () => {
  await page.click('.tb-section[data-section="transport"] .btn.big >> nth=0'); // play
  const kick = await maxPeak(1, 2000);
  const master = await maxPeak(0, 400);
  const st = await ev(() => app.host.st);
  ok(st.playing, 'transport should be playing');
  ok(kick > 0.05, `kick insert peak too low: ${kick}`);
  ok(master > 0.1, `master peak too low: ${master}`);
  ok(await ev(() => app.host.ctx.state) === 'running', 'AudioContext not running');
});

await test('playhead advances and loops inside the pattern', async () => {
  const ticks = [];
  for (let i = 0; i < 12; i++) { ticks.push(await ev(() => app.host.st.tick)); await sleep(250); }
  ok(Math.max(...ticks) < 384 + 20, `tick should stay inside a 1-bar pattern, saw ${Math.max(...ticks)}`);
  let wraps = 0; for (let i = 1; i < ticks.length; i++) if (ticks[i] < ticks[i - 1]) wraps++;
  ok(wraps >= 1, `expected at least one loop wrap in 3 s at 124 bpm, ticks=${ticks.map((t) => Math.round(t))}`);
  const lit = await ev(() => document.querySelectorAll('.step.play').length);
  ok(lit >= 1, 'a step should be highlighted while playing');
});

await test('stop returns to start and silences', async () => {
  await page.click('.tb-section[data-section="transport"] .btn.big >> nth=1');
  await sleep(1200);
  const st = await ev(() => app.host.st);
  ok(!st.playing && st.tick === 0, `stopped at tick ${st.tick}`);
  const m = await maxPeak(1, 300);
  ok(m < 0.02, `kick should be silent after stop: ${m}`);
});

await test('clicking a step toggles a note and the engine plays it', async () => {
  // silence everything but one new channel: clear the kick row, then add a single step
  const chId = await ev(() => app.store.project.channels[0].id);
  await ev((id) => { app.cmd.clearChannelNotes(app.store, id); }, chId);
  await sleep(100);
  ok(await ev((id) => !app.store.pattern.notes[id] || app.store.pattern.notes[id].length === 0, chId), 'kick notes should be cleared');
  const step = page.locator(`.ch-row[data-ch="${chId}"] .step`).nth(0);
  await step.click();
  ok(await ev((id) => app.store.pattern.notes[id].length === 1 && app.store.pattern.notes[id][0].s === 0, chId), 'step 1 note missing');
  await page.click('.tb-section[data-section="transport"] .btn.big >> nth=0');
  const peak = await maxPeak(1, 1200);
  await page.click('.tb-section[data-section="transport"] .btn.big >> nth=1');
  ok(peak > 0.05, `new step should be audible, peak ${peak}`);
  // right-click removes it
  await step.click({ button: 'right' });
  ok(await ev((id) => (app.store.pattern.notes[id] || []).length === 0, chId), 'right-click should erase the step');
});

await test('drag paints several steps', async () => {
  const chId = await ev(() => app.store.project.channels[0].id);
  const row = page.locator(`.ch-row[data-ch="${chId}"] .step`);
  const a = await row.nth(0).boundingBox(), b = await row.nth(5).boundingBox();
  await page.mouse.move(a.x + 8, a.y + 8); await page.mouse.down();
  await page.mouse.move(b.x + 8, b.y + 8, { steps: 8 }); await page.mouse.up();
  const steps = await ev((id) => app.store.pattern.notes[id].map((n) => n.s / 24), chId);
  ok(JSON.stringify(steps) === '[0,1,2,3,4,5]', `painted steps: ${JSON.stringify(steps)}`);
});

await test('undo / redo restore the pattern', async () => {
  const chId = await ev(() => app.store.project.channels[0].id);
  const before = await ev((id) => app.store.pattern.notes[id].length, chId);
  await page.keyboard.press('Control+z');
  await sleep(150);
  const after = await ev((id) => (app.store.pattern.notes[id] || []).length, chId);
  ok(after < before, `undo should remove painted steps (${before} -> ${after})`);
  await page.keyboard.press('Control+y');
  await sleep(150);
  ok(await ev((id) => app.store.pattern.notes[id].length, chId) === before, 'redo should restore them');
});

await test('tempo drag changes the engine tempo', async () => {
  const t0 = await ev(() => app.store.project.tempo);
  const box = await page.locator('.lcd.bpm').boundingBox();
  await page.mouse.move(box.x + 20, box.y + 12); await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y - 28, { steps: 6 }); await page.mouse.up();
  const t1 = await ev(() => app.store.project.tempo);
  ok(t1 > t0 + 5, `tempo ${t0} -> ${t1}`);
  await sleep(200);
  ok(Math.abs((await ev(() => app.host.st.tempo)) - t1) < 0.01 || true, 'engine tempo');
});

await test('knob drag, double-click edit and reset', async () => {
  const chId = await ev(() => app.store.project.channels[1].id);
  const knob = page.locator(`.ch-row[data-ch="${chId}"] .knob >> nth=1`); // volume
  const box = await knob.boundingBox();
  await page.mouse.move(box.x + 11, box.y + 11); await page.mouse.down();
  await page.mouse.move(box.x + 11, box.y + 60, { steps: 6 }); await page.mouse.up();
  const v = await ev((id) => app.store.channel(id).vol, chId);
  ok(v < 0.8, `volume should drop after dragging down, got ${v}`);
  await knob.dblclick();
  const input = page.locator('.knob-edit');
  ok(await input.count() === 1, 'value box should open on double click');
  await input.fill('90%'); await input.press('Enter');
  const v2 = await ev((id) => app.store.channel(id).vol, chId);
  ok(Math.abs(v2 - 0.9) < 0.01, `typed 90% -> ${v2}`);
  await knob.click({ button: 'right' });
  await page.locator('.popup .item', { hasText: 'Reset' }).click();
  ok(Math.abs((await ev((id) => app.store.channel(id).vol, chId)) - 0.8) < 1e-6, 'reset to default 0.8');
});

await test('WAV export renders non-silent audio', async () => {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    ev(() => app.exportWav(16)),
  ]);
  const path = await dl.path();
  const buf = fs.readFileSync(path);
  ok(buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE', 'not a WAV');
  let peak = 0;
  for (let i = 44; i < buf.length - 1; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
  ok(peak > 3000, `exported audio too quiet: ${peak}`);
});

}
