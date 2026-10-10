// AI assistant (TOOLS > AI assistant…, the ✦ button in the toolbar): a chat with Claude that works on the open project.
// Claude reads the project and changes it through the tools below (tempo, channels, steps, notes, effects, playlist);
// every change is an ordinary edit, so Ctrl+Z takes it back. The person brings their own Anthropic API key: it is kept
// in this browser profile only and the requests go straight from this computer to api.anthropic.com.
// The official SDK (@anthropic-ai/sdk) is bundled into src/vendor/anthropic-sdk.js and loaded on the first message.
import { h, clear } from '../ui/h.js';
import { modal, toast } from '../ui/dialog.js';
import { STEP, MIDDLE_C, MAX_INSERT, FX_SLOTS } from '../core/constants.js';
import { createNote, patternLength, barTicks, currentArrangement } from '../core/project.js';
import { INSTRUMENTS, instrumentSchema } from '../core/instruments/index.js';
import { effectList } from '../core/effects/index.js';

const KEY = 'fllua.ai.key';
export const MODEL = 'claude-opus-5-5';
const MAX_ROUNDS = 16;                     // tool rounds per message
const loadKey = () => { try { return localStorage.getItem(KEY) || ''; } catch (_) { return ''; } };
const saveKey = (k) => { try { if (k) localStorage.setItem(KEY, k); else localStorage.removeItem(KEY); } catch (_) { /* private mode */ } };

const SYSTEM = `You are the assistant inside FL LUA, a music production app (DAW) with FL Studio's workflow: a Channel Rack of instruments with a step sequencer, patterns of notes, a Playlist that arranges patterns into a song, and a Mixer with inserts and effects.
You help the person make music and learn the app. You can read and change the open project with the tools. Read the project with get_project before changing it, unless you already know what is there.
Units: time is counted in 16th-note steps (4 steps = 1 beat, 16 steps = 1 bar in 4/4). Notes use MIDI numbers where 60 is middle C (FL Studio calls it C5). Volumes are 0 to 1 (0.8 is the default), pans are -1 (left) to 1 (right). Mixer track 0 is the master; a channel plays through mixer track 0 unless it is routed to an insert.
When you write a beat or a melody, make it musical and fitting the tempo and style the person asked for. After changing the project, say briefly what you did and how to hear it (Space plays the pattern). Every change can be undone with Ctrl+Z.
To explain where something is in the app, name the menu or button: the menus are FILE, EDIT, ADD, PATTERNS, VIEW, OPTIONS, TOOLS, HELP; the windows are Playlist (F5), Channel rack (F6), Piano roll (F7), Browser (F8), Mixer (F9).
Answer in the language the person writes in. Keep answers short.`;

// ------------------------------------------------------------------------------------------------ tools
const int = (description, minimum, maximum) => ({ type: 'integer', description, minimum, maximum });
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
const str = (description) => ({ type: 'string', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function toolDefs() {
  const instruments = Object.keys(INSTRUMENTS).filter((t) => !['wam', 'midiout', 'controller'].includes(t));
  const effects = effectList().map((e) => e.id).filter((t) => t !== 'wam');
  const tools = [
    { name: 'get_project', description: 'Read the open project: tempo, channels, patterns with their notes per channel, mixer inserts with effects, and the playlist.', input_schema: obj({}) },
    { name: 'set_tempo', description: 'Set the project tempo in beats per minute.', input_schema: obj({ bpm: num('Tempo, 10 to 522 BPM', 10, 522) }, ['bpm']) },
    { name: 'add_channel', description: `Add an instrument channel to the Channel Rack. Instruments: ${instruments.map((t) => `${t} (${INSTRUMENTS[t].meta.name}${INSTRUMENTS[t].meta.description ? ': ' + INSTRUMENTS[t].meta.description : ''})`).join('; ')}. For drums use "drums" (a drum synth; set its "type" parameter for kick, snare, hat, etc.) or "fpc". Returns the new channel id.`,
      input_schema: obj({ instrument: { type: 'string', enum: instruments, description: 'Instrument type' }, name: str('Channel name') }, ['instrument']) },
    { name: 'edit_channel', description: 'Change a channel: name, volume, pan, or the mixer insert it plays through.',
      input_schema: obj({ channel_id: int('Channel id'), name: str('New name'), volume: num('0 to 1.25', 0, 1.25), pan: num('-1 to 1', -1, 1), mixer_track: int(`Mixer track 0 to ${MAX_INSERT}`, 0, MAX_INSERT) }, ['channel_id']) },
    { name: 'remove_channel', description: 'Delete a channel and its notes.', input_schema: obj({ channel_id: int('Channel id') }, ['channel_id']) },
    { name: 'get_instrument_params', description: 'List the sound parameters of a channel\'s instrument with their ranges, choices and current values.', input_schema: obj({ channel_id: int('Channel id') }, ['channel_id']) },
    { name: 'set_instrument_params', description: 'Set sound parameters of a channel\'s instrument (ids from get_instrument_params). For a choice parameter give the index of the option.',
      input_schema: obj({ channel_id: int('Channel id'), values: { type: 'object', description: 'Parameter id → value', additionalProperties: { type: 'number' } } }, ['channel_id', 'values']) },
    { name: 'new_pattern', description: 'Create a new empty pattern and make it the current one. Returns its id.', input_schema: obj({ name: str('Pattern name'), bars: int('Length in bars (default: automatic)', 1, 64) }) },
    { name: 'select_pattern', description: 'Make a pattern the current one (the one the Channel Rack shows and Space plays in pattern mode).', input_schema: obj({ pattern_id: int('Pattern id') }, ['pattern_id']) },
    { name: 'set_steps', description: 'Program the step sequencer: replaces all notes of the channel in the pattern with one short note on each given step. Good for drums.',
      input_schema: obj({ channel_id: int('Channel id'), steps: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 1023 }, description: '0-based 16th-note steps that play, e.g. [0,4,8,12] for four on the floor' }, pattern_id: int('Pattern id (default: the current pattern)'), key: int('MIDI note (default 60)', 0, 127), velocity: int('1 to 127 (default 100)', 1, 127) }, ['channel_id', 'steps']) },
    { name: 'write_notes', description: 'Write notes for a channel into a pattern (melodies, bass lines, chords). By default replaces the channel\'s notes in that pattern.',
      input_schema: obj({
        channel_id: int('Channel id'), pattern_id: int('Pattern id (default: the current pattern)'),
        notes: { type: 'array', description: 'Notes; several notes with the same start make a chord', items: obj({ key: int('MIDI note, 60 = middle C', 0, 127), start: num('Start in 16th-note steps from the pattern start', 0, 16384), length: num('Length in 16th-note steps', 0.25, 4096), velocity: int('1 to 127 (default 100)', 1, 127) }, ['key', 'start', 'length']) },
        replace: { type: 'boolean', description: 'Remove the channel\'s existing notes in the pattern first (default true)' },
      }, ['channel_id', 'notes']) },
    { name: 'add_effect', description: `Insert an effect on a mixer track (0 = master). Effects: ${effects.join(', ')}. Goes into the first free slot unless a slot is given. Route a channel to the track with edit_channel mixer_track.`,
      input_schema: obj({ track: int(`Mixer track 0 to ${MAX_INSERT}`, 0, MAX_INSERT), effect: { type: 'string', enum: effects }, slot: int(`Slot 0 to ${FX_SLOTS - 1}`, 0, FX_SLOTS - 1) }, ['track', 'effect']) },
    { name: 'edit_mixer_track', description: 'Change a mixer track: name, volume, pan.', input_schema: obj({ track: int(`0 to ${MAX_INSERT}`, 0, MAX_INSERT), name: str('Track name'), volume: num('0 to 1.25', 0, 1.25), pan: num('-1 to 1', -1, 1) }, ['track']) },
    { name: 'place_pattern', description: 'Put a pattern into the Playlist to build the song arrangement.',
      input_schema: obj({ pattern_id: int('Pattern id'), track: int('Playlist track, 1 and up', 1, 500), bar: int('Bar where it starts, 1 = the song start', 1, 2000), bars: int('Length in bars (default: the pattern length)', 1, 512) }, ['pattern_id', 'track', 'bar']) },
    { name: 'transport', description: 'Start or stop playback. mode "pattern" loops the current pattern, "song" plays the Playlist.', input_schema: obj({ action: { type: 'string', enum: ['play', 'stop'] }, mode: { type: 'string', enum: ['pattern', 'song'] } }, ['action']) },
  ];
  // tool inputs stream as they are generated; each one is checked against its schema before it runs (check() below)
  for (const t of tools) t.eager_input_streaming = true;
  return tools;
}

// a small JSON-schema check for the shapes used above: the parsed input of a streamed tool call can be cut short
export function check(schema, v, path = 'input') {
  if (schema.enum && !schema.enum.includes(v)) return `${path} must be one of ${schema.enum.join(', ')}`;
  switch (schema.type) {
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return `${path} must be an object`;
      for (const k of schema.required || []) if (v[k] === undefined) return `${path}.${k} is missing`;
      for (const [k, x] of Object.entries(v)) {
        const s = (schema.properties && schema.properties[k]) || (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null);
        if (!s) { if (schema.additionalProperties === false) return `${path}.${k} is not a known field`; continue; }
        const e = check(s, x, `${path}.${k}`); if (e) return e;
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(v)) return `${path} must be an array`;
      for (let i = 0; i < v.length; i++) { const e = check(schema.items, v[i], `${path}[${i}]`); if (e) return e; }
      return null;
    }
    case 'integer': case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v) || (schema.type === 'integer' && !Number.isInteger(v))) return `${path} must be ${schema.type === 'integer' ? 'an integer' : 'a number'}`;
      if ((schema.minimum !== undefined && v < schema.minimum) || (schema.maximum !== undefined && v > schema.maximum)) return `${path} must be from ${schema.minimum} to ${schema.maximum}`;
      return null;
    case 'string': return typeof v === 'string' ? null : `${path} must be a string`;
    case 'boolean': return typeof v === 'boolean' ? null : `${path} must be true or false`;
    default: return null;
  }
}

const round = (x, n = 3) => Math.round(x * 10 ** n) / 10 ** n;

function projectSummary(app) {
  const p = app.store.project, bar = barTicks(p.timeSig);
  const arr = currentArrangement(p);
  return {
    title: p.meta.title || '', tempo: p.tempo, time_signature: `${p.timeSig.num}/${p.timeSig.den}`,
    current_pattern: p.currentPattern, playing: !!app.transport.playing, play_mode: app.transport.mode === 'song' ? 'song' : 'pattern',
    channels: p.channels.map((c) => ({ id: c.id, name: c.name, instrument: c.type, volume: round(c.vol), pan: round(c.pan), mixer_track: c.mixer, ...(c.sample ? { sample: c.sample.name } : {}) })),
    patterns: Object.values(p.patterns).map((pat) => ({
      id: pat.id, name: pat.name, bars: round(patternLength(p, pat) / bar, 2),
      notes: Object.fromEntries(Object.entries(pat.notes).filter(([, l]) => l && l.length).map(([ch, l]) => [ch, l.length > 64
        ? `${l.length} notes`
        : l.map((n) => ({ key: n.k, start: round(n.s / STEP, 2), length: round(n.l / STEP, 2), velocity: n.v }))])),
    })),
    mixer: p.mixer.tracks.map((t, i) => ({ track: i, name: t.name || (i ? '' : 'Master'), volume: round(t.vol), pan: round(t.pan), effects: t.fx.map((f, s) => (f ? `${s}:${f.type}` : null)).filter(Boolean) }))
      .filter((t) => t.track === 0 || t.name || t.effects.length || p.channels.some((c) => c.mixer === t.track)),
    playlist: arr.clips.slice(0, 200).map((c) => ({ type: c.type, ref: c.ref, track: c.track, bar: round(c.s / bar + 1, 2), bars: round(c.l / bar, 2) })),
  };
}

function runTool(app, name, input) {
  const store = app.store, cmd = app.cmd, p = store.project;
  const channel = (id) => { const c = store.channel(id); if (!c) throw new Error(`There is no channel ${id}`); return c; };
  const pattern = (id) => { const pat = id == null ? store.pattern : p.patterns[id]; if (!pat) throw new Error(`There is no pattern ${id}`); return pat; };
  switch (name) {
    case 'get_project': return projectSummary(app);
    case 'set_tempo': store.setParam('transport:tempo', input.bpm); return { tempo: p.tempo };
    case 'add_channel': {
      const ch = cmd.addChannel(store, input.instrument, input.name ? { name: input.name } : {});
      return { channel_id: ch.id, name: ch.name };
    }
    case 'edit_channel': {
      const c = channel(input.channel_id);
      if (input.name !== undefined) cmd.renameChannel(store, c.id, input.name);
      if (input.volume !== undefined) store.setParam(`ch:${c.id}:vol`, input.volume);
      if (input.pan !== undefined) store.setParam(`ch:${c.id}:pan`, input.pan);
      if (input.mixer_track !== undefined) cmd.setMixerTarget(store, c.id, input.mixer_track);
      return { ok: true };
    }
    case 'remove_channel': channel(input.channel_id); cmd.removeChannel(store, input.channel_id); return { ok: true };
    case 'get_instrument_params': {
      const c = channel(input.channel_id), schema = instrumentSchema(c.type) || [];
      return schema.map((d) => ({ id: d.id, name: d.name, min: d.min, max: d.max, value: c.params[d.id], ...(d.options ? { options: d.options } : {}), ...(d.unit ? { unit: d.unit } : {}) }));
    }
    case 'set_instrument_params': {
      const c = channel(input.channel_id), schema = instrumentSchema(c.type) || [];
      const out = {};
      for (const [k, v] of Object.entries(input.values)) {
        if (!schema.some((d) => d.id === k)) throw new Error(`${c.type} has no parameter "${k}"`);
        out[k] = store.setParam(`ch:${c.id}:p:${k}`, v);
      }
      return { set: out };
    }
    case 'new_pattern': {
      const id = cmd.newPattern(store);
      if (input.name) cmd.renamePattern(store, id, input.name);
      if (input.bars) cmd.setPatternLength(store, id, input.bars * barTicks(p.timeSig));
      return { pattern_id: id };
    }
    case 'select_pattern': pattern(input.pattern_id); cmd.selectPattern(store, input.pattern_id); return { ok: true };
    case 'set_steps': {
      const c = channel(input.channel_id), pat = pattern(input.pattern_id);
      const key = input.key ?? (p.settings.stepKey ?? MIDDLE_C), vel = input.velocity ?? 100;
      store.edit('AI: steps', () => {
        pat.notes[c.id] = [...new Set(input.steps)].sort((a, b) => a - b).map((s) => createNote(p, s * STEP, STEP, key, vel));
      }, [['patterns', pat.id]]);
      return { pattern_id: pat.id, steps: pat.notes[c.id].length };
    }
    case 'write_notes': {
      const c = channel(input.channel_id), pat = pattern(input.pattern_id);
      store.edit('AI: notes', () => {
        const list = input.replace === false ? (pat.notes[c.id] || []) : [];
        for (const n of input.notes) list.push(createNote(p, Math.round(n.start * STEP), Math.max(1, Math.round(n.length * STEP)), n.key, n.velocity ?? 100));
        list.sort((a, b) => a.s - b.s || a.k - b.k);
        pat.notes[c.id] = list;
      }, [['patterns', pat.id]]);
      store.select(c.id);
      return { pattern_id: pat.id, notes: pat.notes[c.id].length };
    }
    case 'add_effect': {
      const t = p.mixer.tracks[input.track];
      if (!t) throw new Error(`There is no mixer track ${input.track}`);
      const slot = input.slot ?? t.fx.findIndex((f) => !f);
      if (slot < 0) throw new Error(`All ${FX_SLOTS} effect slots of track ${input.track} are taken`);
      cmd.setFx(store, input.track, slot, input.effect);
      return { track: input.track, slot };
    }
    case 'edit_mixer_track': {
      if (!p.mixer.tracks[input.track]) throw new Error(`There is no mixer track ${input.track}`);
      if (input.name !== undefined) cmd.setTrackField(store, input.track, 'name', input.name, 'Rename track');
      if (input.volume !== undefined) store.setParam(`mx:${input.track}:vol`, input.volume);
      if (input.pan !== undefined) store.setParam(`mx:${input.track}:pan`, input.pan);
      return { ok: true };
    }
    case 'place_pattern': {
      const pat = pattern(input.pattern_id), bar = barTicks(p.timeSig);
      const l = input.bars ? input.bars * bar : Math.ceil(patternLength(p, pat) / bar) * bar;
      const [clip] = cmd.addClips(store, [{ type: 'pattern', track: input.track, s: (input.bar - 1) * bar, l, ref: pat.id }], 'AI: place pattern');
      return { clip_id: clip.id };
    }
    case 'transport': {
      if (input.mode) app.transport.setMode(input.mode === 'song' ? 'song' : 'pat');
      if (input.action === 'play') { app.host.resume && app.host.resume(); if (!app.transport.playing) app.transport.play(); } else app.transport.stop();
      return { playing: !!app.transport.playing };
    }
    default: throw new Error(`Unknown tool ${name}`);
  }
}

// a line in the chat for a tool call
const TOOL_LABEL = {
  get_project: () => 'Read the project', set_tempo: (i) => `Tempo ${i.bpm} BPM`, add_channel: (i) => `Added ${i.name || i.instrument}`,
  edit_channel: () => 'Changed a channel', remove_channel: () => 'Removed a channel', get_instrument_params: () => 'Read instrument settings',
  set_instrument_params: () => 'Changed the sound', new_pattern: (i) => `New pattern${i.name ? ' ' + i.name : ''}`, select_pattern: () => 'Switched pattern',
  set_steps: (i) => `Steps: ${i.steps.length}`, write_notes: (i) => `Notes: ${i.notes.length}`, add_effect: (i) => `${i.effect} on mixer track ${i.track}`,
  edit_mixer_track: () => 'Changed a mixer track', place_pattern: (i) => `Pattern in the playlist, bar ${i.bar}`, transport: (i) => (i.action === 'play' ? 'Play' : 'Stop'),
};

// ------------------------------------------------------------------------------------------------ chat
export function installAssistant(app) {
  const a = app.assistant = {
    key: loadKey(), messages: [], log: [], busy: false, error: '', abort: null,
    baseURL: null,                         // tests: a local stand-in for api.anthropic.com
    open: () => app.wm.open('assistant'),
  };
  const emit = () => app.store.bus.emit('assistant', a);
  let client = null, clientKey = '';

  const getClient = async () => {
    if (client && clientKey === `${a.key} ${a.baseURL}`) return client;
    const { default: Anthropic } = await import('../vendor/anthropic-sdk.js');
    // the key belongs to the person using this computer and the page talks to the API directly
    client = new Anthropic({ apiKey: a.key, dangerouslyAllowBrowser: true, maxRetries: 2, ...(a.baseURL ? { baseURL: a.baseURL } : {}) });
    clientKey = `${a.key} ${a.baseURL}`;
    return client;
  };

  a.setKey = (k) => { a.key = String(k || '').trim(); saveKey(a.key); client = null; a.error = ''; emit(); };
  a.clear = () => { if (a.abort) a.abort(); a.messages = []; a.log = []; a.error = ''; emit(); };
  a.stop = () => { if (a.abort) a.abort(); };

  a.send = async (text) => {
    text = String(text || '').trim();
    if (!text || a.busy) return;
    if (!a.key) { a.error = 'Add your Anthropic API key first (the key button above).'; emit(); return; }
    const mark = a.messages.length, logMark = a.log.length;
    a.busy = true; a.error = '';
    a.messages.push({ role: 'user', content: text });
    a.log.push({ who: 'you', text });
    emit();
    let stream = null, aborted = false;
    a.abort = () => { aborted = true; if (stream) stream.abort(); };
    try {
      const Anthropic = (await import('../vendor/anthropic-sdk.js')).default;
      const c = await getClient();
      const tools = a.tools || (a.tools = toolDefs());
      let jsonRetries = 0;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const entry = { who: 'claude', text: '' };
        a.log.push(entry); emit();
        stream = c.beta.messages.stream({
          model: MODEL,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',                         // a declined request is answered by a fallback model
          output_config: { effort: 'medium' },
          cache_control: { type: 'ephemeral' },
          system: SYSTEM,
          tools,
          messages: a.messages,
        });
        stream.on('text', (d) => { entry.text += d; emit(); });
        let msg;
        try {
          msg = await stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          if (aborted || err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
          a.log.splice(a.log.indexOf(entry), 1);       // a tool input that could not be parsed: ask again
          continue;
        }
        if (!entry.text) a.log.splice(a.log.indexOf(entry), 1);
        if (msg.stop_reason === 'refusal') { a.messages.push({ role: 'assistant', content: msg.content }); a.log.push({ who: 'note', text: 'Claude declined this request.' }); break; }
        a.messages.push({ role: 'assistant', content: msg.content });
        if (msg.stop_reason === 'pause_turn') continue;
        const calls = msg.content.filter((b) => b.type === 'tool_use');
        if (!calls.length) break;
        if (msg.stop_reason === 'max_tokens') throw new Error('The answer was too long and was cut off. Ask for less at a time.');
        const results = [];
        for (const call of calls) {
          const tool = tools.find((t) => t.name === call.name);
          const bad = tool ? check(tool.input_schema, call.input) : `Unknown tool ${call.name}`;
          if (bad) { results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: JSON.stringify({ INVALID_INPUT: bad, received: call.input }) }); continue; }
          try {
            const r = runTool(app, call.name, call.input);
            results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(r) });
            if (call.name !== 'get_project' && call.name !== 'get_instrument_params') a.log.push({ who: 'tool', text: (TOOL_LABEL[call.name] || (() => call.name))(call.input) });
          } catch (err) {
            results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: String(err && err.message || err) });
          }
        }
        a.messages.push({ role: 'user', content: results });
        emit();
        if (round === MAX_ROUNDS - 1) a.log.push({ who: 'note', text: 'Stopped after many steps. Say "continue" to go on.' });
      }
    } catch (err) {
      // the conversation goes back to where it was before this message, so it can be sent again
      a.messages.length = mark;
      if (!aborted) {
        a.log.length = logMark + 1;
        a.error = describeError(err);
      } else a.log.push({ who: 'note', text: 'Stopped.' });
    } finally {
      a.busy = false; a.abort = null; stream = null;
      emit();
    }
  };

  // on the right side of the workspace, over the playlist
  const ws = document.getElementById('workspace');
  const W = (ws && ws.clientWidth) || window.innerWidth, H = (ws && ws.clientHeight) || window.innerHeight - 140;
  const w = Math.min(420, W - 40);
  app.wm.register('assistant', { title: 'AI assistant', create: (win) => createAssistantWindow(win, app), rect: { x: Math.max(10, W - w - 10), y: 10, w, h: Math.max(260, Math.min(620, H - 20)) }, minW: 300, minH: 260 });
  return a;
}

function describeError(err) {
  const s = err && err.status;
  if (s === 401) return 'The API key was not accepted. Check it (the key button above).';
  if (s === 403) return 'This API key may not use this model.';
  if (s === 429) return 'Too many requests or the credit ran out. Wait a moment or check your Anthropic account.';
  if (s === 529 || s >= 500) return 'Anthropic is busy right now. Try again in a minute.';
  if (err && /fetch|network|Connection/i.test(String(err.message || err))) return 'No connection to api.anthropic.com. Check the internet connection.';
  return String(err && err.message || err);
}

export function openKeyDialog(app) {
  const a = app.assistant;
  const input = h('input.input', { type: 'password', placeholder: 'sk-ant-…', value: a.key, style: { width: '100%' }, autocomplete: 'off', spellcheck: false });
  const body = h('div.collab-p',
    h('p', 'The assistant runs on Claude from Anthropic with your own API key. Create a key at console.anthropic.com (API keys) and paste it here.'),
    input,
    h('p.dim', 'The key is kept on this computer only. Your messages and the project summary go straight to Anthropic; using the API is paid by your Anthropic account.'));
  modal({ title: 'Anthropic API key', body, width: 480, buttons: [
    ...(a.key ? [{ label: 'Remove key', fn: () => a.setKey('') }] : []),
    { label: 'Cancel' },
    { label: 'Save', primary: true, fn: () => { a.setKey(input.value); if (a.key) toast('API key saved'); } },
  ] });
  setTimeout(() => input.focus(), 30);
}

const EXAMPLES = ['Make a house beat at 124 BPM', 'Add a bass line to this pattern', 'Put reverb on the snare', 'How do I record a melody from the keyboard?'];

function createAssistantWindow(win, app) {
  const a = app.assistant, store = app.store;
  win.setTitle('AI assistant');
  const list = h('div.ai-log.scroll');
  const input = h('textarea.input.ai-input', { rows: 2, placeholder: 'Ask or tell what to make… (Enter sends, Shift+Enter: new line)' });
  const sendBtn = h('div.btn.primary', { onclick: () => submit() }, 'Send');
  const submit = () => { if (a.busy) { a.stop(); return; } const t = input.value; input.value = ''; a.send(t); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } e.stopPropagation(); });
  input.addEventListener('keyup', (e) => e.stopPropagation());
  const keyBtn = h('div.btn', { onclick: () => openKeyDialog(app) });
  const render = () => {
    clear(list);
    if (!a.log.length) {
      list.append(h('div.ai-hello',
        h('p', 'Tell me what to make or ask how something works. I can change the tempo, add instruments, write beats and melodies, add effects and build the song.'),
        a.key ? h('div.ai-examples', EXAMPLES.map((t) => h('div.btn.ai-example', { onclick: (e) => a.send(e.currentTarget.textContent) }, t))) : h('div.btn.primary', { onclick: () => openKeyDialog(app) }, 'Add your Anthropic API key…')));
    }
    for (const e of a.log) {
      if (e.who === 'claude' && !e.text) { list.append(h('div.ai-msg.claude.dim', '…')); continue; }
      list.append(h(`div.ai-msg.${e.who}`, e.who === 'tool' ? `✓ ${e.text}` : e.text));
    }
    if (a.busy && (!a.log.length || a.log[a.log.length - 1].who !== 'claude')) list.append(h('div.ai-msg.claude.dim', '…'));
    if (a.error) list.append(h('div.collab-msg.err', a.error));
    list.scrollTop = list.scrollHeight;
    sendBtn.textContent = a.busy ? 'Stop' : 'Send';
    keyBtn.textContent = a.key ? 'API key ✓' : 'API key…';
  };
  const el = h('div.rack.ai',
    h('div.rack-head', keyBtn, h('div.btn', { onclick: () => a.clear(), hint: 'Start a new conversation' }, 'New chat'), h('div.grow'), h('span.dim', 'Claude · Ctrl+Z undoes its edits')),
    list,
    h('div.ai-compose', input, sendBtn));
  const off = store.bus.on('assistant', render);
  render();
  return { el, onShow: () => { render(); setTimeout(() => input.focus(), 30); }, destroy() { off(); } };
}
