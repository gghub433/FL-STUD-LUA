// End-to-end test of the native plugin path without Electron: the plugin host process, the bridge addon (loaded in
// Node instead of the page) and the test plugins. Run after `node build.mjs`: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as L from '../../../src/core/plugin-layout.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.env.FLLUA_NATIVE_OUT || path.join(here, '..', 'out', `${process.platform}-${process.arch}`);
const exe = path.join(out, process.platform === 'win32' ? 'fllua-plughost.exe' : 'fllua-plughost');
const tp = path.join(out, 'testplugins');
const vst3 = path.join(tp, 'FLLUA Test VST3.vst3');
const clap = path.join(tp, process.platform === 'darwin' ? 'FLLUA Test CLAP.clap' : 'FLLUA Test CLAP.clap');
const require = createRequire(import.meta.url);

function host() {
  const name = `fllua-t${process.pid}-${Date.now() % 100000}`;
  const p = spawn(exe, ['--serve', name], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map(), events = [];
  let buf = '', id = 0, ready;
  const isReady = new Promise((r) => { ready = r; });
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = JSON.parse(line);
      if (m.ev === 'ready') ready(m);
      else if (m.ev) events.push(m);
      else if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  const cmd = (c) => new Promise((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ ...c, id: n }) + '\n'); });
  return { p, name, cmd, events, isReady };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('scan: both test files list their plugins', { skip: !fs.existsSync(exe) && 'native build missing' }, async () => {
  for (const [file, names] of [[vst3, ['FLLUA Test Synth', 'FLLUA Test Gain']], [clap, ['FLLUA Test CLAP Synth', 'FLLUA Test CLAP Gain']]]) {
    const r = await new Promise((res) => { const p = spawn(exe, ['--scan', file]); let o = ''; p.stdout.on('data', (d) => { o += d; }); p.on('close', () => res(JSON.parse(o))); });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.plugins.map((x) => x.name), names);
    assert.equal(r.plugins[0].kind, 'instrument');
    assert.equal(r.plugins[1].kind, 'effect');
  }
});

test('process: synths sound on notes, effects process the input with their latency, parameters, state, editor edits', { skip: !fs.existsSync(exe) && 'native build missing' }, async () => {
  const h = host();
  await h.isReady;
  const bridge = require(path.join(out, 'fllua_bridge.node'));
  assert.ok(L.matches(bridge.layout()), JSON.stringify(bridge.layout()));
  const sab = new SharedArrayBuffer(L.SAB_SIZE);
  const v = L.views(sab);
  const opened = bridge.open(h.name, new Uint8Array(sab));
  assert.equal(opened.ok, true, JSON.stringify(opened));

  const sr = 48000;
  const loads = [
    { format: 'vst3', path: vst3, uid: '464C4C554154535453594E5448000001', slot: 0 },
    { format: 'vst3', path: vst3, uid: '464C4C55415453544741494E00000002', slot: 1 },
    { format: 'clap', path: clap, uid: 'org.fllua.test.synth', slot: 2 },
    { format: 'clap', path: clap, uid: 'org.fllua.test.gain', slot: 3 },
  ];
  const inst = [];
  for (const l of loads) {
    const r = await h.cmd({ cmd: 'load', sampleRate: sr, ...l });
    assert.equal(r.ok, true, JSON.stringify(r));
    inst.push(r);
  }
  assert.equal(inst[0].params.length, 2);
  assert.equal(inst[1].latency, 64);
  assert.equal(inst[0].hasEditor, process.platform !== 'darwin');
  assert.equal(inst[1].hasInput, true);
  assert.equal(inst[2].params.find((p) => p.id === 10).name, 'Gain');

  // run blocks the way the engine does: write block seq, publish, wait for it
  let seq = 0;
  const outputs = [[], [], [], []];
  async function block(events = {}, input = 0.5) {
    seq++;
    L.writeFrame(v, seq, 128, sr, { flags: L.FLAG.PLAYING, tempo: 120 });
    for (let s = 0; s < 4; s++) {
      L.beginSlot(v, seq, s);
      for (const e of events[s] || []) L.addEvent(v, seq, s, ...e);
      const il = L.inIndex(seq, s, 0), ir = L.inIndex(seq, s, 1);
      v.f32.fill(input, il, il + 128); v.f32.fill(input, ir, ir + 128);
    }
    Atomics.store(v.u32, L.H.reqSeq, seq);
    for (let t = 0; Atomics.load(v.u32, L.H.doneSeq) !== seq; t++) { if (t > 2000) throw new Error(`no answer for block ${seq}`); await sleep(1); }
    for (let s = 0; s < 4; s++) {
      assert.equal(L.outSeqOf(v, seq, s), seq);
      const o = L.outIndex(seq, s, 0);
      outputs[s].push(...v.f32.subarray(o, o + 128));
    }
  }
  await block({ 0: [[10, L.EV.NOTE_ON, 0, 69, -1, 0, 1]], 2: [[10, L.EV.NOTE_ON, 0, 69, 7, 0, 1]] });
  for (let i = 0; i < 20; i++) await block();
  const peak = (a, from = 0) => a.slice(from).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  assert.ok(peak(outputs[0]) > 0.1, `VST3 synth: ${peak(outputs[0])}`);
  assert.ok(peak(outputs[2]) > 0.1, `CLAP synth: ${peak(outputs[2])}`);
  assert.ok(outputs[0].slice(0, 10).every((x) => x === 0), 'the note starts at its offset');
  // VST3 gain: 64 samples late, gain 2 * 0.5 = 1
  assert.equal(outputs[1][63], 0);
  assert.ok(Math.abs(outputs[1][64] - 0.5) < 1e-6, `effect after its latency: ${outputs[1][64]}`);
  assert.ok(Math.abs(outputs[3][5] - 0.5) < 1e-6, `CLAP gain 1: ${outputs[3][5]}`);

  // a parameter change from FL LUA (automation) reaches the plugin at its offset
  await block({ 1: [[0, L.EV.PARAM, 0, 0, -1, 0, 0.25]], 3: [[0, L.EV.PARAM, 0, 0, -1, 10, 0.25]] });
  const lastBlock = (s) => outputs[s].slice(-128);
  assert.ok(Math.abs(lastBlock(1)[100] - 0.25) < 1e-6, `VST3 gain 0.5: ${lastBlock(1)[100]}`);
  assert.ok(Math.abs(lastBlock(3)[100] - 0.25) < 1e-6, `CLAP gain 0.5 (normalized 0.25 of 0..2): ${lastBlock(3)[100]}`);
  await sleep(100);
  const p = await h.cmd({ cmd: 'params', inst: inst[1].inst });
  assert.ok(Math.abs(p.values['0'] - 0.25) < 1e-9, 'the controller follows the automation');

  // note off: the synth fades out
  await block({ 0: [[0, L.EV.NOTE_OFF, 0, 69, -1, 0, 0]], 2: [[0, L.EV.NOTE_OFF, 0, 69, 7, 0, 0]] });
  for (let i = 0; i < 60; i++) await block();
  assert.ok(peak(lastBlock(0)) < 0.01 && peak(lastBlock(2)) < 0.01, 'released');

  // reset (an export starts): voices and delay lines are gone at once, without a release tail
  await block({ 0: [[0, L.EV.NOTE_ON, 0, 60, -1, 0, 1]], 2: [[0, L.EV.NOTE_ON, 0, 60, 8, 0, 1]] });
  for (let i = 0; i < 4; i++) await block();
  assert.ok(peak(lastBlock(0)) > 0.05 && peak(lastBlock(2)) > 0.05, 'playing before the reset');
  const reset = [[0, L.EV.RESET, 0, 0, -1, 0, 0]];
  await block({ 0: reset, 1: reset, 2: reset }, 0);
  assert.equal(peak(lastBlock(0)), 0, 'VST3 synth silent right after a reset');
  assert.equal(peak(lastBlock(2)), 0, 'CLAP synth silent right after a reset');
  assert.equal(peak(lastBlock(1)), 0, 'the VST3 effect forgot its delay line');

  // state: save, change, restore
  const st = await h.cmd({ cmd: 'getState', inst: inst[1].inst });
  assert.equal(st.ok, true);
  await block({ 1: [[0, L.EV.PARAM, 0, 0, -1, 0, 0.9]] });
  const back = await h.cmd({ cmd: 'setState', inst: inst[1].inst, data: st.data });
  assert.equal(back.ok, true);
  assert.ok(Math.abs(back.values['0'] - 0.25) < 1e-9, JSON.stringify(back.values));
  const cst = await h.cmd({ cmd: 'getState', inst: inst[3].inst });
  assert.equal(cst.ok, true);

  // text of a value
  const tx = await h.cmd({ cmd: 'paramText', inst: inst[0].inst, items: [{ id: 1, value: 0.5 }] });
  assert.equal(tx.texts[0], '50%');

  // the editor: opening it makes the test plugin "turn" Tone to 0.75, which FL LUA hears about
  if (process.platform === 'linux' && process.env.DISPLAY) {
    const ed = await h.cmd({ cmd: 'editor', inst: inst[0].inst, show: true, title: 'Test' });
    assert.equal(ed.open, true, JSON.stringify(ed));
    const ce = await h.cmd({ cmd: 'editor', inst: inst[2].inst, show: true, title: 'Test CLAP' });
    assert.equal(ce.open, true);
    for (let i = 0; i < 10; i++) await block();
    await sleep(200);
    assert.ok(h.events.some((e) => e.ev === 'param' && e.inst === inst[0].inst && e.id === 1 && Math.abs(e.value - 0.75) < 1e-9), JSON.stringify(h.events));
    assert.ok(h.events.some((e) => e.ev === 'param' && e.inst === inst[2].inst && e.id === 11 && Math.abs(e.value - 0.75) < 1e-9), JSON.stringify(h.events));
    await h.cmd({ cmd: 'editor', inst: inst[0].inst, show: false });
    await h.cmd({ cmd: 'editor', inst: inst[2].inst, show: false });
  }

  // unload one; its slot now answers "no plugin"
  await h.cmd({ cmd: 'unload', inst: inst[3].inst });
  await block();
  assert.equal(L.statusOf(v, seq, 3), 1);
  const stats = bridge.stats();
  assert.ok(stats.cycles >= seq && stats.timeouts === 0, JSON.stringify(stats));
  bridge.close();
  await h.cmd({ cmd: 'quit' });
  await new Promise((r) => { if (h.p.exitCode !== null) r(); else h.p.on('exit', r); });
});
