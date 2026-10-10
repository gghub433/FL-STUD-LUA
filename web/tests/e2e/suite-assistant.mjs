import { page, open, test, ok, ev, errors } from './harness.mjs';

// AI assistant: the Anthropic API is replaced by a scripted one (page.route), so the test needs no key or network.
// Each scripted reply is streamed as server-sent events like the real Messages API.
const sse = (msg) => {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev('message_start', { message: { id: `msg_${Math.random().toString(36).slice(2)}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  msg.content.forEach((b, index) => {
    if (b.type === 'text') {
      out += ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      for (const part of b.text.match(/.{1,12}/gs)) out += ev('content_block_delta', { index, delta: { type: 'text_delta', text: part } });
    } else {
      out += ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      for (let i = 0; i < json.length; i += 20) out += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 20) } });
    }
    out += ev('content_block_stop', { index });
  });
  out += ev('message_delta', { delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
  out += ev('message_stop', {});
  return out;
};

export async function run() {
  console.log('AI assistant: key, chat, tools that edit the project, undo, errors');
  await open('/');
  const requests = [];
  let script = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
    const body = JSON.parse(req.postData());
    requests.push({ url: req.url(), headers: req.headers(), body });
    let next = script.shift();
    if (typeof next === 'function') next = await next();
    if (typeof next === 'number') return route.fulfill({ status: next, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ type: 'error', error: { type: next === 401 ? 'authentication_error' : 'api_error', message: 'scripted' } }) });
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse(next) });
  });

  await test('the ✦ toolbar button opens the assistant; without a key it asks for one', async () => {
    await ev(() => localStorage.removeItem('fllua.ai.key'));
    await ev(() => app.assistant.setKey(''));
    await page.locator('#toolbar .btn[data-win="assistant"]').click();
    await page.waitForSelector('.ai-log');
    ok(await page.locator('.ai-hello .btn', { hasText: 'API key' }).isVisible(), 'asks for a key');
    await page.locator('.ai-hello .btn', { hasText: 'API key' }).click();
    await page.locator('.modal input[type=password]').fill('sk-ant-test-key');
    await page.locator('.modal .btn', { hasText: 'Save' }).click();
    ok((await ev(() => localStorage.getItem('fllua.ai.key'))) === 'sk-ant-test-key', 'key kept locally');
    ok((await page.locator('.ai-example').count()) >= 3, 'examples shown');
  });

  await test('"make a beat": Claude reads the project, sets the tempo, adds a drum channel with steps; the chat shows each step', async () => {
    const before = await ev(() => ({ n: app.store.project.channels.length, undo: app.store.history.length }));
    script = [
      { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me look at the project.' }, { type: 'tool_use', id: 'toolu_1', name: 'get_project', input: {} }] },
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'toolu_2', name: 'set_tempo', input: { bpm: 124 } },
        { type: 'tool_use', id: 'toolu_3', name: 'add_channel', input: { instrument: 'drums', name: 'AI Kick' } },
      ] },
      // the channel id is known once add_channel ran
      async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_4', name: 'set_steps', input: { channel_id: await ev(() => app.store.project.channels.find((c) => c.name === 'AI Kick').id), steps: [0, 4, 8, 12] } }] }),
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: a four-on-the-floor kick at 124 BPM. Press Space to hear it.' }] },
    ];
    await page.locator('.ai-input').fill('Make a house beat at 124 BPM');
    await page.locator('.ai-input').press('Enter');
    await page.waitForFunction(() => !app.assistant.busy && app.assistant.log.some((e) => /four-on-the-floor/.test(e.text)), null, { timeout: 15000 });
    const st = await ev(() => { const ch = app.store.project.channels.find((c) => c.name === 'AI Kick'); return { tempo: app.store.project.tempo, n: app.store.project.channels.length, type: ch && ch.type, steps: ch ? (app.store.pattern.notes[ch.id] || []).map((x) => x.s / 24) : [] }; });
    ok(st.tempo === 124 && st.n === before.n + 1 && st.type === 'drums' && st.steps.join() === '0,4,8,12', JSON.stringify(st));
    ok(requests.length === 4, `${requests.length} requests`);
    const r0 = requests[0];
    ok(r0.headers['x-api-key'] === 'sk-ant-test-key' && r0.body.model === 'claude-opus-5-5' && r0.body.stream === true, 'key, model, streaming');
    ok(r0.body.tools.some((t) => t.name === 'write_notes') && r0.body.tools.every((t) => t.eager_input_streaming === true), 'tools');
    ok(r0.body.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(r0.headers['anthropic-beta'] || ''), 'fallbacks');
    // the tool results went back in one user message after each assistant turn, in order
    const r2 = requests[2].body.messages;
    const last = r2[r2.length - 1];
    ok(last.role === 'user' && last.content.length === 2 && last.content.every((b) => b.type === 'tool_result') && last.content[0].tool_use_id === 'toolu_2', JSON.stringify(last).slice(0, 300));
    const summary = JSON.parse(requests[1].body.messages[2].content[0].content);
    ok(summary.tempo && Array.isArray(summary.channels) && summary.channels.length === before.n, 'get_project answered with the project');
    const lines = await page.locator('.ai-msg.tool').allInnerTexts();
    ok(lines.some((l) => l.includes('Tempo 124')) && lines.some((l) => l.includes('AI Kick')) && lines.some((l) => l.includes('Steps: 4')), lines.join(' | '));
    ok((await page.locator('.ai-msg.claude').last().innerText()).includes('Press Space'), 'streamed answer shown');
    await page.screenshot({ path: 'tests/e2e/out/assistant.png' });
    // undo takes the assistant's edits back one by one
    for (let i = 0; i < 3; i++) await ev(() => app.store.undo());
    ok(!(await ev(() => app.store.project.channels.some((c) => c.name === 'AI Kick'))), 'undone');
  });

  await test('bad tool input is answered with an error to Claude, not run; notes, effects and the playlist work', async () => {
    requests.length = 0;
    const pat = await ev(() => app.store.project.currentPattern);
    const chId = await ev(() => app.store.project.channels[0].id);
    script = [
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'toolu_a', name: 'write_notes', input: { channel_id: chId, notes: [{ key: 60, start: 0 }] } },
        { type: 'tool_use', id: 'toolu_b', name: 'write_notes', input: { channel_id: chId, notes: [{ key: 60, start: 0, length: 4 }, { key: 64, start: 0, length: 4 }, { key: 67, start: 4, length: 2, velocity: 90 }] } },
        { type: 'tool_use', id: 'toolu_c', name: 'add_effect', input: { track: 0, effect: 'reverb' } },
        { type: 'tool_use', id: 'toolu_d', name: 'place_pattern', input: { pattern_id: pat, track: 5, bar: 9 } },
        { type: 'tool_use', id: 'toolu_e', name: 'remove_channel', input: { channel_id: 99999 } },
      ] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Chord written.' }] },
    ];
    await ev(() => app.assistant.send('Write a chord'));
    await page.waitForFunction(() => !app.assistant.busy, null, { timeout: 15000 });
    const res = requests[1].body.messages.at(-1).content;
    ok(res[0].is_error && /length is missing/.test(res[0].content), res[0].content);
    ok(!res[1].is_error && !res[2].is_error && !res[3].is_error && res[4].is_error && /no channel/.test(res[4].content), JSON.stringify(res.map((r) => [r.is_error, r.content])));
    const st = await ev((chId) => { const p = app.store.project; const arr = p.playlist.arrangements.find((a) => a.id === p.playlist.current) || p.playlist.arrangements[0]; return { notes: (p.patterns[p.currentPattern].notes[chId] || []).map((n) => `${n.k}@${n.s}/${n.l}`).join(), fx: p.mixer.tracks[0].fx.some((f) => f && f.type === 'reverb'), clip: arr.clips.some((c) => c.track === 5 && c.ref === p.currentPattern) }; }, chId);
    ok(st.notes === '60@0/96,64@0/96,67@96/48' && st.fx && st.clip, JSON.stringify(st));
  });

  await test('a wrong key says so and the conversation can go on; New chat clears it', async () => {
    const n = await ev(() => app.assistant.messages.length);
    script = [401];
    await ev(() => app.assistant.send('Hello'));
    await page.waitForFunction(() => !app.assistant.busy, null, { timeout: 15000 });
    ok(/API key was not accepted/.test(await page.locator('.ai .collab-msg.err').innerText()), 'error shown');
    ok((await ev(() => app.assistant.messages.length)) === n, 'the failed message left no trace in the conversation');
    for (let i = errors.length - 1; i >= 0; i--) if (/status of 401/.test(errors[i])) errors.splice(i, 1);   // the browser logs the scripted 401
    await page.locator('.ai .btn', { hasText: 'New chat' }).click();
    ok((await ev(() => app.assistant.messages.length)) === 0 && (await page.locator('.ai-msg').count()) === 0, 'cleared');
    await ev(() => app.assistant.setKey(''));
  });
}
