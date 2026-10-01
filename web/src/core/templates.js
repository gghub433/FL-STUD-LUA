// Built-in project templates: each returns a fresh project made only of factory sounds and generated
// synths, so it plays at once with no downloads. The Browser lists them under "Templates".
import { STEP } from './constants.js';
import { createProject, createChannel, createNote, createPattern, createClip, currentArrangement, barTicks } from './project.js';
import { addFactorySampler, setSteps, demoProject, emptyProject } from './demo.js';

function name(p, n) { p.meta.title = n; return p; }
function mixerNames(p, names) { Object.entries(names).forEach(([k, v]) => { p.mixer.tracks[+k].name = v; }); }
function arrange(p, plan) {                                   // plan: [[patternId, bars]...] laid on track 1
  const arr = currentArrangement(p), bar = barTicks(p.timeSig);
  let t = 0;
  for (const [pat, bars] of plan) { arr.clips.push(createClip(p, 'pattern', 1, t, bars * bar, pat)); t += bars * bar; }
}
function notes(p, patId, ch, list) {                           // [[step, key, lenSteps, vel?]]
  const pat = p.patterns[patId];
  const out = pat.notes[ch.id] || (pat.notes[ch.id] = []);
  for (const [s, k, l, v] of list) out.push(createNote(p, s * STEP, l * STEP, k, v ?? 100));
  out.sort((a, b) => a.s - b.s || a.k - b.k);
}

export const TEMPLATES = [
  { id: 'empty', name: 'Empty project', description: 'Nothing in the rack, 130 BPM', build: () => name(emptyProject(), 'Untitled') },
  { id: 'demo', name: 'Four on the floor', description: 'The demo groove: kick, clap, hats, sub bass, two patterns', build: () => demoProject() },
  { id: 'drumkit', silent: true, name: 'Drum kit (8 channels)', description: 'Kick, snare, clap, closed/open hat, tom, shaker, cowbell with empty patterns', build: () => {
    const p = name(createProject(), 'Drum kit'); p.tempo = 120;
    [['kick-punch', 1], ['snare-tight', 2], ['clap', 2], ['hat-closed', 3], ['hat-open', 3], ['tom-mid', 4], ['shaker', 5], ['cowbell', 5]].forEach(([k, m]) => addFactorySampler(p, k, { mixer: m }));
    mixerNames(p, { 1: 'Kick', 2: 'Snare + Clap', 3: 'Hats', 4: 'Toms', 5: 'Perc' });
    return p;
  } },
  { id: 'hiphop', name: 'Hip-hop 90 BPM', description: 'Boom-bap drums, swung hats, sub bass line', build: () => {
    const p = name(createProject(), 'Hip-hop'); p.tempo = 90; p.swing = 0.28;
    const kick = addFactorySampler(p, 'kick-deep', { mixer: 1 }), snare = addFactorySampler(p, 'snare-fat', { mixer: 2 }), hat = addFactorySampler(p, 'hat-closed', { mixer: 3 });
    const ohat = addFactorySampler(p, 'hat-open', { mixer: 3 }), bass = addFactorySampler(p, 'sub-808', { name: 'Sub 808', mixer: 4 });
    bass.params.root = 36; bass.params.volEnvOn = 1; bass.params.volDec = 0.9; bass.params.volSus = 0.15; bass.vol = 0.7; hat.vol = 0.55; ohat.vol = 0.45;
    mixerNames(p, { 1: 'Kick', 2: 'Snare', 3: 'Hats', 4: 'Bass' });
    setSteps(p, 1, kick, [0, 7, 10], 115); setSteps(p, 1, snare, [4, 12], 110);
    setSteps(p, 1, hat, [0, 2, 4, 6, 8, 10, 12, 14], 70); setSteps(p, 1, ohat, [15], 70);
    notes(p, 1, bass, [[0, 36, 6], [7, 39, 3], [10, 34, 6]]);
    p.patterns[1].name = 'Beat';
    arrange(p, [[1, 8]]);
    return p;
  } },
  { id: 'trap', name: 'Trap 140 BPM', description: 'Rolling hats, 808 slides, half-time snare', build: () => {
    const p = name(createProject(), 'Trap'); p.tempo = 140;
    const kick = addFactorySampler(p, 'kick-short', { mixer: 1 }), clap = addFactorySampler(p, 'clap', { mixer: 2 }), hat = addFactorySampler(p, 'hat-closed', { mixer: 3 });
    const bass = addFactorySampler(p, 'kick-808', { name: '808', mixer: 4 });
    bass.params.root = 36; bass.params.volEnvOn = 0; bass.params.ignoreOff = 0; bass.vol = 0.75; hat.vol = 0.5;
    mixerNames(p, { 1: 'Kick', 2: 'Clap', 3: 'Hats', 4: '808' });
    setSteps(p, 1, kick, [0, 10], 115); setSteps(p, 1, clap, [8], 110);
    setSteps(p, 1, hat, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].filter((s) => s % 2 === 0 || s > 10), 60);
    notes(p, 1, bass, [[0, 36, 8, 110], [8, 41, 2, 100], [10, 39, 6, 105]]);
    p.patterns[1].name = 'Trap loop';
    arrange(p, [[1, 8]]);
    return p;
  } },
  { id: 'lofi', name: 'Lo-fi 78 BPM', description: 'Dusty drums, Rhodes-like FM chords, tape on the master', build: () => {
    const p = name(createProject(), 'Lo-fi'); p.tempo = 78; p.swing = 0.35;
    const kick = addFactorySampler(p, 'kick-deep', { mixer: 1 }), snare = addFactorySampler(p, 'snare-tight', { mixer: 2 }), hat = addFactorySampler(p, 'hat-closed', { mixer: 3 });
    kick.vol = 0.7; snare.vol = 0.6; hat.vol = 0.4;
    const keys = createChannel(p, 'fm', { name: 'Keys', mixer: 5 });
    Object.assign(keys.params, { algo: 2, index: 0.7, lvl2: 0.35, dec2: 0.6, sus2: 0.05, dec1: 1.8, sus1: 0.2 });
    p.channels.push(keys);
    mixerNames(p, { 1: 'Kick', 2: 'Snare', 3: 'Hats', 5: 'Keys' });
    p.mixer.tracks[0].fx[0] = { type: 'tape', on: 1, mix: 1, params: { drive: 9, bias: 0.2, bump: 3, tone: 6500, wow: 0.45, flutter: 0.3, hiss: -66 } };
    setSteps(p, 1, kick, [0, 6, 10], 100); setSteps(p, 1, snare, [4, 12], 90); setSteps(p, 1, hat, [0, 2, 4, 6, 8, 10, 12, 14], 55);
    const chord = (root, steps = 16, rel = [0, 3, 7, 10]) => rel.map((r) => [0, root + r, steps, 78]);
    notes(p, 1, keys, chord(57));                                     // Am7
    createPattern(p, 2, 'Turn');
    setSteps(p, 2, kick, [0, 6, 10], 100); setSteps(p, 2, snare, [4, 12], 90); setSteps(p, 2, hat, [0, 2, 4, 6, 8, 10, 12, 14], 55);
    notes(p, 2, keys, chord(53));                                     // Fmaj7-ish
    p.patterns[1].name = 'Am7';
    arrange(p, [[1, 2], [2, 1], [1, 2], [2, 1]]);
    return p;
  } },
  { id: 'synth', name: 'Synth sketch', description: 'Wavetable lead, Pluck arp and a sub-synth bass on an empty song', build: () => {
    const p = name(createProject(), 'Synth sketch'); p.tempo = 118;
    const lead = createChannel(p, 'wavetable', { name: 'Lead', mixer: 1 }); Object.assign(lead.params, { table: 0, pos: 0.66, uni: 3, unidet: 20, cutoff: 5200, ad: 0.5, as: 0.6 });
    const arp = createChannel(p, 'pluck', { name: 'Pluck', mixer: 2 }); Object.assign(arp.params, { decay: 1.4, damping: 0.4 });
    const bass = createChannel(p, 'subsynth', { name: 'Bass', mixer: 3 }); Object.assign(bass.params, { o1wave: 0, o2wave: 1, o2oct: -1, cutoff: 700, res: 0.15, mono: 1 });
    p.channels.push(lead, arp, bass);
    mixerNames(p, { 1: 'Lead', 2: 'Pluck', 3: 'Bass' });
    const aMin = [57, 60, 64, 67];
    notes(p, 1, lead, [[0, 69, 4], [4, 72, 4], [8, 76, 6], [14, 74, 2]]);
    notes(p, 1, arp, Array.from({ length: 16 }, (_, i) => [i, aMin[i % 4] + (i % 8 > 3 ? 12 : 0), 1, 80]));
    notes(p, 1, bass, [[0, 45, 8], [8, 41, 8]]);
    p.patterns[1].name = 'Sketch';
    arrange(p, [[1, 4]]);
    return p;
  } },
];

export const TEMPLATE_BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));
