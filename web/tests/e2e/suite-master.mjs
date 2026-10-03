import { page, open, test, ok, sleep, ev, maxPeak } from './harness.mjs';

// master section: safety limiter, live loudness meter, loudness targets on export
const fresh = () => ev(async () => {
  const { demoProject } = await import('/src/core/demo.js');
  await app.store.replaceProject(demoProject());
  app.transport.setMode('song');
  window.__exp = null; app.exportSink = (bytes, name, mime) => { window.__exp = { bytes, name, mime }; };
  for (const k of Object.keys(localStorage)) if (k.startsWith('stepwise.export')) localStorage.removeItem(k);
});

export async function run() {
  console.log('master: limiter, loudness meter, loudness targets');
  await open('/');

  await test('new projects have a limiter in the last master slot; the demo no longer goes over 0 dBFS', async () => {
    await fresh();
    const slot = await ev(() => { const fx = app.store.project.mixer.tracks[0].fx; return fx[fx.length - 1] && fx[fx.length - 1].type; });
    ok(slot === 'limiter', `last master slot: ${slot}`);
    await ev(() => app.transport.play());
    const pk = await maxPeak(0, 2500);
    await ev(() => app.transport.stop());
    ok(pk > 0.3 && pk <= 0.967, `master peak ${pk}`);
  });

  await test('live meter: short-term LUFS in the toolbar, loudness window with integrated, range, true peak and correlation', async () => {
    await fresh();
    await ev(() => app.transport.play());
    await sleep(3500);
    const loud = await ev(() => app.host.loud.slice());
    ok(loud[0] > -30 && loud[0] < 0 && loud[1] > -30 && loud[1] < 0, `momentary/short-term ${loud}`);
    ok(loud[2] > -30 && loud[2] < 0, `integrated ${loud[2]}`);
    ok(loud[4] > -12 && loud[4] <= 0.5, `true peak ${loud[4]}`);
    ok(loud[7] > 0.3 && loud[7] <= 1, `correlation ${loud[7]}`);
    const tb = await page.locator('.tb-lufs').innerText();
    ok(/^−\d+\.\d LUFS$/.test(tb), `toolbar readout "${tb}"`);
    await page.locator('#menubar .menu-top', { hasText: 'VIEW' }).click();
    await page.locator('.popup .item', { hasText: 'Loudness meter' }).click();
    await sleep(400);
    const big = await page.locator('.ld-big').innerText();
    ok(/^−\d+\.\d$/.test(big), `integrated shown: ${big}`);
    ok((await page.locator('.ld-cell').count()) === 6, 'six readouts');
    await page.screenshot({ path: 'tests/e2e/out/loudness-window.png' });
    await ev(() => app.transport.stop());
    // playback restarts the integrated measurement
    await sleep(300);
    await ev(() => app.host.resetLoudness());
    await sleep(600);
    ok((await ev(() => app.host.loud[2])) === -Infinity, 'reset clears the integrated value');
  });

  await test('Analyse song renders offline and reports the loudness of the whole song', async () => {
    await fresh();
    await ev(() => app.openWindow('loudness'));
    await page.locator('.ld .btn', { hasText: 'Analyse song' }).click();
    await page.waitForFunction(() => /integrated/.test(document.querySelector('.ld-report').textContent), null, { timeout: 60000 });
    const txt = await page.locator('.ld-report').innerText();
    ok(/LUFS integrated · range \d+\.\d LU · true peak −\d+\.\d dBTP/.test(txt), txt);
    const b = await ev(() => app.lastLoudness);
    ok(b.integrated > -25 && b.integrated < -5 && b.truePeak <= 0, JSON.stringify(b));
    await ev(() => app.wm.get('loudness').close());
  });

  await test('export to −14 LUFS: the decoded file measures −14 ±0.3 LUFS and stays under the −1 dBTP ceiling', async () => {
    await fresh();
    const r = await ev(async () => {
      const { exportProject, defaultSettings } = await import('/src/app/export.js');
      const res = await exportProject(app, { ...defaultSettings(app.store.project), format: 'wav', quality: '32', target: -14, ceiling: -1, keep: false });
      const { decodeWav } = await import('/src/host/export/wav.js');
      const { measureLoudness } = await import('/src/core/loudness.js');
      const w = decodeWav(window.__exp.bytes);
      const m = measureLoudness(w.channels[0], w.channels[1], w.rate);
      return { report: res.loudness, measured: m };
    });
    ok(Math.abs(r.measured.integrated + 14) <= 0.3, `measured ${r.measured.integrated}`);
    ok(r.measured.truePeak <= -0.95, `true peak ${r.measured.truePeak}`);
    ok(Math.abs(r.report.after.integrated - r.measured.integrated) < 0.2, 'the report matches the file');
  });

  await test('export dialog: loudness target and ceiling; the toast reports the loudness', async () => {
    await fresh();
    await page.keyboard.press('Control+r'); await sleep(250);
    const sels = page.locator('.modal select');
    const target = sels.nth(5), ceil = sels.nth(6);
    const opts = await target.locator('option').allInnerTexts();
    ok(opts.includes('Off') && opts.some((o) => o.startsWith('−14 LUFS')) && opts.some((o) => o.startsWith('−23 LUFS')), `targets ${opts}`);
    ok(await ceil.isDisabled(), 'ceiling only for LUFS targets');
    await target.selectOption('-16');
    ok(!(await ceil.isDisabled()), 'ceiling enabled');
    await page.locator('.modal input[type=text]').fill('loud test');
    await page.locator('.modal .btn', { hasText: 'Export' }).last().click();
    await page.waitForFunction(() => window.__exp && window.__exp.name === 'loud test.wav', null, { timeout: 60000 });
    await sleep(300);
    const toast = await page.locator('.toast').last().innerText();
    ok(/−1[56]\.\d LUFS, −\d+\.\d dBTP/.test(toast), `toast: ${toast}`);
    const saved = await ev(() => JSON.parse(localStorage.getItem('stepwise.export')));
    ok(saved.target === -16 && saved.ceiling === -1, `remembered ${JSON.stringify(saved)}`);
  });

  await test('audio settings: a restart at another sample rate and buffer keeps the project playing; settings persist', async () => {
    await fresh();
    await page.locator('#menubar .menu-top', { hasText: 'OPTIONS' }).click();
    await page.locator('.popup .item', { hasText: 'Audio settings' }).click();
    await sleep(300);
    ok((await page.locator('.modal-title').innerText()) === 'Audio settings', 'dialog open');
    const sels = page.locator('.modal select');
    ok((await sels.count()) === 3, 'device, rate, buffer');
    ok((await sels.nth(1).locator('option').allInnerTexts()).includes('48 kHz'), 'rates');
    await page.screenshot({ path: 'tests/e2e/out/audio-settings.png' });
    await sels.nth(1).selectOption('48000');
    await sels.nth(2).selectOption('balanced');
    await page.locator('.modal .btn', { hasText: 'Apply' }).click();
    await page.waitForFunction(() => app.host.sampleRate === 48000 && app.host.ready, null, { timeout: 10000 });
    ok((await page.locator('#status-audio').innerText()) === 'audio: 48000 Hz', 'status bar');
    const saved = await ev(() => JSON.parse(localStorage.getItem('fllua.audio')));
    ok(saved.sampleRate === 48000 && saved.latency === 'balanced', JSON.stringify(saved));
    await ev(() => app.transport.play());
    const pk = await maxPeak(0, 2000);
    await ev(() => app.transport.stop());
    ok(pk > 0.1, `plays after the restart: ${pk}`);
    const back = await ev(async () => { const m = await import('/src/ui/audio-settings.js'); return m.apply(app, { sampleRate: 0, latency: 'interactive', sinkId: '' }); });
    ok(back && (await ev(() => app.host.ready)), 'back to the defaults');
    await ev(() => localStorage.removeItem('fllua.audio'));
  });
}
