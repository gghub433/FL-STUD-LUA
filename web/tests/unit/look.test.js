// Customize look (src/ui/look.js): stored values are cleaned up; the background's reverse filter undoes the page's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLook, lookFilters, LOOK_DEFAULT, LOOK_PRESETS } from '../../src/ui/look.js';

test('a stored look is cleaned up: ranges, choices, colours', () => {
  const l = normalizeLook({ hue: 400, sat: 'x', bright: 10, bg: 'video', bgColor: 'red', font: 'comic', radius: 99, opacity: 5, glass: 1 });
  assert.equal(l.hue, 180);
  assert.equal(l.sat, LOOK_DEFAULT.sat);
  assert.equal(l.bright, 50);
  assert.equal(l.bg, 'none');
  assert.equal(l.bgColor, LOOK_DEFAULT.bgColor);
  assert.equal(l.font, 'system');
  assert.equal(l.radius, 12);
  assert.equal(l.opacity, 40);
  assert.equal(l.glass, true);
  assert.deepEqual(normalizeLook(undefined), { ...LOOK_DEFAULT });
  for (const [, p] of LOOK_PRESETS) assert.deepEqual(normalizeLook({ ...LOOK_DEFAULT, ...p }), { ...LOOK_DEFAULT, ...p });
});

// the CSS filter functions as colour maths (no clipping), to check that reverse(page(x)) == x
const lum = [0.2126, 0.7152, 0.0722];
const ops = {
  'hue-rotate': (c, deg) => {
    const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const m = [
      [0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928],
      [0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140, 0.072 - cos * 0.072 - sin * 0.283],
      [0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072],
    ];
    return m.map((r) => r[0] * c[0] + r[1] * c[1] + r[2] * c[2]);
  },
  saturate: (c, s) => { const y = lum[0] * c[0] + lum[1] * c[1] + lum[2] * c[2]; return c.map((v) => y + s * (v - y)); },
  brightness: (c, b) => c.map((v) => v * b),
  contrast: (c, k) => c.map((v) => (v - 0.5) * k + 0.5),
  invert: (c) => c.map((v) => 1 - v),
};
const run = (filter, c) => filter.split(' ').filter(Boolean).reduce((x, f) => {
  const [, name, arg] = /^([a-z-]+)\(([-\d.]+)/.exec(f);
  return ops[name](x, parseFloat(arg));
}, c);

test('the background keeps its own colours: the reverse filter undoes the page filter', () => {
  for (const light of [false, true]) {
    for (const p of [{ hue: 170, sat: 140 }, { hue: -40, bright: 80, contrast: 120 }, { hue: 90, sat: 50, bright: 110, contrast: 90 }]) {
      const f = lookFilters(normalizeLook(p), light);
      for (const c of [[0.8, 0.3, 0.1], [0.2, 0.5, 0.7], [0.45, 0.45, 0.45]]) {
        const back = run(f.page, run(f.undo, c));
        back.forEach((v, i) => assert.ok(Math.abs(v - c[i]) < 1e-3, `${JSON.stringify(p)} light=${light}: ${back} vs ${c}`));
      }
    }
  }
  assert.equal(lookFilters(normalizeLook({}), false).page, '', 'the classic look needs no filter');
});
