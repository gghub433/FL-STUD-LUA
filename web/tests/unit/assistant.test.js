import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDefs, check, MODEL } from '../../src/app/assistant.js';

test('assistant tools: valid definitions, inputs checked against their schemas', () => {
  const tools = toolDefs();
  assert.equal(MODEL, 'claude-opus-5-5');
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'unique names');
  for (const t of tools) {
    assert.match(t.name, /^[a-z_]{1,64}$/);
    assert.ok(t.description.length > 10 && t.input_schema.type === 'object' && t.eager_input_streaming === true, t.name);
  }
  const s = (n) => tools.find((t) => t.name === n).input_schema;
  assert.equal(check(s('set_tempo'), { bpm: 128 }), null);
  assert.match(check(s('set_tempo'), {}), /bpm is missing/);
  assert.match(check(s('set_tempo'), { bpm: 2000 }), /from 10 to 522/);
  assert.match(check(s('add_channel'), { instrument: 'banjo' }), /one of/);
  assert.equal(check(s('add_channel'), { instrument: 'pluck', name: 'Lead' }), null);
  assert.equal(check(s('write_notes'), { channel_id: 3, notes: [{ key: 60, start: 0, length: 4 }] }), null);
  assert.match(check(s('write_notes'), { channel_id: 3, notes: [{ key: 60, start: 0 }] }), /notes\[0\]\.length is missing/);
  assert.match(check(s('set_steps'), { channel_id: 1.5, steps: [0] }), /integer/);
  assert.match(check(s('edit_channel'), { channel_id: 1, colour: 'red' }), /not a known field/);
  assert.equal(check(s('set_instrument_params'), { channel_id: 1, values: { cutoff: 0.4 } }), null);
  assert.match(check(s('set_instrument_params'), { channel_id: 1, values: { cutoff: 'high' } }), /number/);
});
