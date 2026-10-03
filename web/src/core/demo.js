// Starter projects. Only uses the factory sample pack, so a fresh install makes sound at once.
import { STEP, BEAT } from './constants.js';
import { createProject, createChannel, createNote, createPattern, createClip, currentArrangement, barTicks, createFxSlot } from './project.js';
import { factoryId, FACTORY_BY_ID } from './factory.js';

// New projects get a safety limiter in the last master slot (ceiling −0.3 dB), so nothing clips by surprise;
// effects added to the master go in front of it.
export function addMasterLimiter(p) {
  const fx = p.mixer.tracks[0].fx;
  if (!fx.some((s) => s && s.type === 'limiter') && !fx[fx.length - 1]) fx[fx.length - 1] = createFxSlot('limiter');
  return p;
}

export function addFactorySampler(p, factoryKey, opts = {}) {
  const f = FACTORY_BY_ID.get(factoryId(factoryKey));
  const ch = createChannel(p, 'sampler', { name: opts.name || f.name, sample: { id: factoryId(factoryKey), name: f.name }, mixer: opts.mixer ?? 0, color: opts.color });
  p.channels.push(ch);
  return ch;
}

export function setSteps(p, patId, ch, steps, vel = 100, key = 60) {
  const pat = p.patterns[patId];
  const list = pat.notes[ch.id] || (pat.notes[ch.id] = []);
  for (const s of steps) list.push(createNote(p, s * STEP, STEP, key, vel));
  list.sort((a, b) => a.s - b.s);
}

export function emptyProject() {
  const p = createProject();
  p.tempo = 130;
  return addMasterLimiter(p);
}

// A 4-bar house groove in Pattern 1, a variation in Pattern 2, arranged in the playlist.
export function demoProject() {
  const p = createProject();
  p.meta.title = 'Demo: four on the floor';
  p.tempo = 124;
  p.swing = 0.1;
  const kick = addFactorySampler(p, 'kick-punch', { mixer: 1 });
  const clap = addFactorySampler(p, 'clap', { mixer: 2 });
  const hat = addFactorySampler(p, 'hat-closed', { mixer: 3 });
  const ohat = addFactorySampler(p, 'hat-open', { mixer: 3 });
  const perc = addFactorySampler(p, 'shaker', { mixer: 3 });
  const bass = addFactorySampler(p, 'sub-808', { name: 'Sub 808', mixer: 4 });
  kick.params.ignoreOff = 1; bass.params.ignoreOff = 0; bass.params.volEnvOn = 1;
  bass.params.volDec = 1.2; bass.params.volSus = 0.0; bass.params.volRel = 0.12; bass.params.root = 36; // C3
  hat.vol = 0.6; ohat.vol = 0.55; perc.vol = 0.45; clap.vol = 0.7; bass.vol = 0.72;
  hat.pan = -0.15; perc.pan = 0.25;
  ohat.params.cutItself = 1; hat.params.cutGroup = 1; ohat.params.cutBy = 1;
  p.mixer.tracks[1].name = 'Kick'; p.mixer.tracks[2].name = 'Clap'; p.mixer.tracks[3].name = 'Hats'; p.mixer.tracks[4].name = 'Bass';

  const pat1 = p.patterns[1]; pat1.name = 'Groove';
  setSteps(p, 1, kick, [0, 4, 8, 12], 112);
  setSteps(p, 1, clap, [4, 12], 100);
  setSteps(p, 1, hat, [0, 2, 4, 6, 8, 10, 12, 14], 70);
  setSteps(p, 1, hat, [1, 5, 9, 13], 45);
  setSteps(p, 1, ohat, [2, 6, 10, 14], 85);
  setSteps(p, 1, perc, [3, 7, 11, 15], 60);
  const line = [[0, 36, 3], [3, 36, 1], [6, 39, 2], [8, 36, 3], [11, 34, 1], [14, 31, 2]]; // C, C, Eb, C, Bb, G
  for (const [s, k, len] of line) (pat1.notes[bass.id] || (pat1.notes[bass.id] = [])).push(createNote(p, s * STEP, len * STEP, k, 100));

  const pat2 = createPattern(p, 2, 'Break');
  setSteps(p, 2, kick, [0, 3, 8, 10], 112);
  setSteps(p, 2, clap, [4, 12, 14, 15], 100);
  setSteps(p, 2, hat, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 55);
  setSteps(p, 2, ohat, [14], 85);

  const arr = currentArrangement(p);
  const bar = barTicks(p.timeSig);
  for (let b = 0; b < 8; b++) arr.clips.push(createClip(p, 'pattern', 1, b * bar, bar, b === 7 ? 2 : 1));
  arr.clips.sort((a, b) => a.s - b.s);
  p.currentPattern = 1;
  return addMasterLimiter(p);
}

export { BEAT };
