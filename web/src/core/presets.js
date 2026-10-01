// Factory presets (plain parameter sets) for instruments and effects. A preset only lists the
// parameters it changes: loading it first resets the plugin to its defaults. The Browser shows them
// under "Plugin presets"; tests check that every key exists and every value is inside its range.
export const INSTRUMENT_PRESETS = {
  pluck: {
    'Nylon guitar': { decay: 2.2, damping: 0.55, pickPos: 0.18, bright: 0.45, velBright: 0.5, width: 0.35 },
    'Steel guitar': { decay: 3.5, damping: 0.2, pickPos: 0.22, bright: 0.85, velBright: 0.6, width: 0.5 },
    'Harp': { decay: 5, damping: 0.3, pickPos: 0.12, bright: 0.6, velBright: 0.3, width: 0.8, detune: 8 },
    'Muted bass': { decay: 0.9, damping: 0.75, pickPos: 0.3, bright: 0.35, velBright: 0.5, width: 0.1, release: 60 },
    'Koto': { decay: 1.6, damping: 0.1, pickPos: 0.08, bright: 1, velBright: 0.7, width: 0.6 },
  },
  organ: {
    'Full organ': { d0: 8, d1: 8, d2: 8, d3: 8, d4: 8, d5: 8, d6: 8, d7: 8, d8: 8, perc: 0, rotary: 1 },
    'Jazz (888)': { d0: 8, d1: 8, d2: 8, d3: 0, perc: 1, percHarm: 1, percDecay: 0, percLevel: 0.6, vibrato: 0.3 },
    'Gospel': { d0: 8, d1: 8, d2: 8, d3: 6, d4: 4, d5: 4, d6: 2, d7: 2, d8: 4, rotary: 2, rotDepth: 0.7, drive: 0.3 },
    'Rock': { d0: 8, d1: 8, d2: 8, d3: 8, d4: 0, d5: 0, d6: 0, d7: 0, d8: 0, drive: 0.55, rotary: 2 },
    'Soft flute': { d0: 0, d1: 0, d2: 8, d3: 0, d4: 0, d5: 0, d6: 0, d7: 0, d8: 0, click: 0.05, drive: 0 },
    'Reed': { d0: 0, d1: 0, d2: 8, d3: 6, d4: 8, d5: 6, d6: 4, d7: 3, d8: 0 },
  },
  wavetable: {
    'Sweep bass': { table: 3, pos: 0.1, posEnv: 0.6, md: 0.35, uni: 1, sub: 0.5, cutoff: 1800, res: 0.25, fenv: 0.5, as: 0.8, ar: 0.12 },
    'Vowel pad': { table: 2, pos: 0.3, lpos: 0.4, lrate: 0.25, uni: 4, unidet: 22, aa: 0.6, ar: 1.8, as: 0.9, cutoff: 5000, fenv: 0 },
    'PWM lead': { table: 1, pos: 0.2, lpos: 0.6, lrate: 4.5, lshape: 1, uni: 2, unidet: 12, mono: 1, glide: 60, cutoff: 9000 },
    'Digital bell': { table: 5, pos: 0.5, posEnv: -0.7, md: 1.2, as: 0, ad: 1.6, ar: 1.4, cutoff: 12000, fenv: 0, uni: 2, unidet: 8 },
    'Analog saw stack': { table: 0, pos: 0.66, uni: 5, unidet: 28, cutoff: 3500, res: 0.18, fenv: 0.35, ad: 0.6, as: 0.65 },
    'Odd/even organ': { table: 4, pos: 0.4, lpos: 0.25, lrate: 5.5, aa: 0.01, ar: 0.12, as: 1, ftype: 3 },
  },
  subsynth: {
    'Saw lead': { o1wave: 0, o2wave: 0, o2level: 0.7, o2fine: 8, cutoff: 4500, res: 0.2, fenv: 0.3, mono: 1, legato: 1, glide: 40, uni: 2, unidet: 14 },
    'Sub bass': { o1wave: 3, o2wave: 2, o2oct: -1, o2level: 0.6, cutoff: 900, res: 0.1, fenv: 0.2, ad: 0.4, as: 0.8, mono: 1 },
    'Warm pad': { o1wave: 0, o2wave: 1, o2level: 0.5, o2fine: -9, cutoff: 2200, res: 0.15, aa: 0.5, ar: 1.4, as: 0.9, uni: 3, unidet: 20, fenv: 0.1 },
    'Pluck synth': { o1wave: 1, o2wave: 0, o2level: 0.4, cutoff: 900, res: 0.35, fenv: 0.7, fd: 0.18, fs: 0, ad: 0.25, as: 0 },
  },
  fm: {
    'E-piano': { algo: 2, index: 0.8, ratio1: 1, ratio2: 1, lvl2: 0.4, dec2: 0.5, sus2: 0.1, dec1: 1.5, sus1: 0.15 },
    'Bell': { algo: 12, index: 1, ratio2: 3.5, ratio4: 1.41, dec1: 2.4, sus1: 0, dec3: 1.6, sus3: 0 },
    'FM bass': { algo: 0, index: 0.9, ratio1: 1, ratio2: 1, lvl2: 0.7, dec2: 0.25, sus2: 0.2, fb2: 0.3 },
  },
  drums: {
    '808 kick': { type: 0, pitch: -3, pitchEnv: 0.5, pitchDecay: 70, decay: 900, noise: 0.05, click: 0.2, drive: 0.15 },
    'Tight kick': { type: 0, pitchEnv: 0.7, pitchDecay: 28, decay: 220, noise: 0.1, click: 0.5, drive: 0.35 },
    'Snappy snare': { type: 1, decay: 180, noise: 0.85, noiseDecay: 140, noiseColor: 0.65, click: 0.4 },
    'Closed hat': { type: 2, decay: 45, noiseDecay: 40, noiseColor: 0.85 },
    'Open hat': { type: 2, decay: 380, noiseDecay: 320, noiseColor: 0.8 },
    'Low tom': { type: 3, pitch: -7, decay: 650, pitchDecay: 110 },
  },
};

export const EFFECT_PRESETS = {
  tape: {
    'Warm glue': { drive: 7, bias: 0.12, bump: 2.5, tone: 10000, wow: 0.1, flutter: 0.08, hiss: -90 },
    'Lo-fi cassette': { drive: 12, bias: 0.25, bump: 3, tone: 5200, wow: 0.55, flutter: 0.4, hiss: -62 },
    'Hot tape': { drive: 22, bias: 0.3, bump: 1, tone: 8000, wow: 0.05, flutter: 0.05, output: -3 },
  },
  tremolo: {
    'Vintage amp': { mode: 0, rate: 5.2, depth: 0.55, shape: 0, mix: 1 },
    'Slow pan': { mode: 1, rate: 0.35, depth: 0.8, shape: 0 },
    'Synced chop': { mode: 0, sync: 1, division: 5, depth: 1, shape: 2, smooth: 0.4 },
  },
  transient: {
    'Punchy drums': { attack: 60, sustain: -20 },
    'Tight & dry': { attack: 25, sustain: -70 },
    'Room bloom': { attack: -30, sustain: 55 },
  },
  pitchshift: {
    'Octave up': { semi: 12, mix: 0.5, grain: 40 },
    'Octave down': { semi: -12, mix: 0.5, grain: 70 },
    'Detune (thicken)': { semi: 0, fine: 14, mix: 0.45, grain: 45 },
    'Fifth up': { semi: 7, mix: 0.4, grain: 40 },
  },
  freqshift: {
    'Metallic shimmer': { mode: 0, shift: 35, feedback: 0.35, mix: 0.5 },
    'Ring bell': { mode: 1, shift: 220, mix: 0.7 },
    'Stereo spread': { mode: 0, shift: 6, stereo: 1, mix: 0.6 },
  },
  reverb: {
    'Small room': { size: 0.5, decay: 0.8, damping: 0.5, predelay: 5, wet: -8 },
    'Hall': { size: 1.4, decay: 3.2, damping: 0.35, predelay: 20, wet: -6 },
    'Cathedral': { size: 2, decay: 9, damping: 0.25, predelay: 35, wet: -9 },
  },
  delay: {
    'Slapback': { sync: 0, time: 110, feedback: 0.15, wet: -9 },
    'Ping-pong 1/8': { sync: 1, division: 5, feedback: 0.5, pingpong: 1, wet: -8 },
    'Dotted echo': { sync: 1, division: 6, feedback: 0.45, wet: -8 },
  },
  compressor: {
    'Drum bus': { threshold: -18, ratio: 4, attack: 12, release: 120, knee: 6, gain: 3 },
    'Vocal smooth': { threshold: -22, ratio: 3, attack: 8, release: 180, knee: 12, gain: 4 },
    'Pump': { threshold: -26, ratio: 10, attack: 3, release: 90, knee: 3, gain: 6 },
  },
  distortion: {
    'Tube warmth': { type: 2, drive: 10, tone: 8000, wet: -6 },
    'Fuzz': { type: 1, drive: 28, tone: 5000, wet: 0, dry: -60 },
    'Wavefolder': { type: 3, drive: 14, wet: -3 },
  },
  chorus: {
    'Classic chorus': { rate: 0.6, depth: 0.5, delay: 13, voices: 1 },
    'Lush ensemble': { rate: 0.35, depth: 0.7, delay: 18, voices: 2, width: 1 },
  },
};

export function instrumentPresets(type) { return INSTRUMENT_PRESETS[type] || {}; }
export function effectPresets(type) { return EFFECT_PRESETS[type] || {}; }
