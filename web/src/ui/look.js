// The look of FL LUA on this computer (not part of the project): OPTIONS > Interface > Customize look…
//   colour     hue, saturation, brightness and contrast of the whole interface, like FL Studio's theme sliders. It is one
//              CSS filter on the page, so the canvases (playlist, piano roll, mixer, meters) follow without colours of
//              their own, as with the light theme.
//   background a colour, a gradient or a picture behind the interface, blurred and dimmed as you like; the interface
//              lets it through (opacity). The picture gets the reverse filter, so it keeps its own colours.
//   glass      menus and dialogs as frosted glass; in the desktop app on Windows 11 and macOS the window itself can
//              show the blurred desktop behind it.
//   font, corners
// Themes: presets, your own saved ones, export / import as .json (with the picture).
import { h, clear } from './h.js';
import { t as tr } from './i18n.js';
import { idbGet, idbPut, idbDelete } from '../host/idb.js';
import { downloadBlob } from '../host/export/wav.js';

export const LOOK_DEFAULT = Object.freeze({
  hue: 0, sat: 100, bright: 100, contrast: 100,
  bg: 'none', bgColor: '#1b1e22', bgColor2: '#3b2a52', bgAngle: 135, bgFit: 'cover', bgBlur: 0, bgDim: 30,
  opacity: 100, glass: false, desktop: 'none', font: 'system', radius: 3,
});

export const LOOK_PRESETS = [
  ['Classic', {}],
  ['Ocean', { hue: 170 }],
  ['Forest', { hue: 80, sat: 90 }],
  ['Grape', { hue: -125, sat: 110 }],
  ['Cherry', { hue: -40, sat: 115 }],
  ['Gold', { hue: 12, sat: 125, bright: 105 }],
  ['Mono', { sat: 0 }],
  ['Midnight', { hue: -170, sat: 80, bright: 85, contrast: 110 }],
  ['Neon', { hue: -100, sat: 170, contrast: 115 }],
  ['Sunset glass', { hue: -15, bg: 'gradient', bgColor: '#ff7a59', bgColor2: '#5b2a86', bgAngle: 135, bgDim: 35, opacity: 82, glass: true }],
  ['Aurora glass', { hue: 150, bg: 'gradient', bgColor: '#00c9a7', bgColor2: '#1e3a8a', bgAngle: 160, bgDim: 40, opacity: 80, glass: true }],
];

export const FONTS = {
  system: ['System', '"Segoe UI", "Inter", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif'],
  rounded: ['Rounded', '"Nunito", "Varela Round", "Quicksand", "Arial Rounded MT Bold", "Segoe UI", system-ui, sans-serif'],
  condensed: ['Condensed', '"Roboto Condensed", "Arial Narrow", "Segoe UI Semilight", system-ui, sans-serif'],
  serif: ['Serif', 'Georgia, Cambria, "Times New Roman", serif'],
  mono: ['Monospace', 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'],
};

const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : d);
const color = (v, d) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : d);

export function normalizeLook(l) {
  const o = l && typeof l === 'object' ? l : {};
  const d = LOOK_DEFAULT;
  return {
    hue: num(o.hue, -180, 180, d.hue), sat: num(o.sat, 0, 200, d.sat), bright: num(o.bright, 50, 150, d.bright), contrast: num(o.contrast, 50, 150, d.contrast),
    bg: ['none', 'color', 'gradient', 'image'].includes(o.bg) ? o.bg : d.bg,
    bgColor: color(o.bgColor, d.bgColor), bgColor2: color(o.bgColor2, d.bgColor2), bgAngle: num(o.bgAngle, 0, 360, d.bgAngle),
    bgFit: ['cover', 'contain', 'tile'].includes(o.bgFit) ? o.bgFit : d.bgFit,
    bgBlur: num(o.bgBlur, 0, 40, d.bgBlur), bgDim: num(o.bgDim, 0, 90, d.bgDim),
    opacity: num(o.opacity, 40, 100, d.opacity), glass: !!o.glass,
    desktop: ['none', 'acrylic', 'mica', 'vibrancy'].includes(o.desktop) ? o.desktop : d.desktop,
    font: FONTS[o.font] ? o.font : d.font, radius: num(o.radius, 0, 12, d.radius),
  };
}

const isDefaultTint = (l) => l.hue === 0 && l.sat === 100 && l.bright === 100 && l.contrast === 100;

// the filter on the page, and its reverse (applied first) for the background, so the picture keeps its colours;
// undo: the reverse alone (theme swatches show their real colours whatever the current look)
export function lookFilters(l, light) {
  const page = [], back = [], undo = [];
  if (light) page.push('invert(1)', 'hue-rotate(180deg)');
  if (l.hue) page.push(`hue-rotate(${l.hue}deg)`);
  if (l.sat !== 100) page.push(`saturate(${l.sat / 100})`);
  if (l.bright !== 100) page.push(`brightness(${l.bright / 100})`);
  if (l.contrast !== 100) page.push(`contrast(${l.contrast / 100})`);
  if (l.bgBlur) back.push(`blur(${l.bgBlur}px)`);
  if (l.bgDim) back.push(`brightness(${(100 - l.bgDim) / 100})`);
  if (l.contrast !== 100) undo.push(`contrast(${100 / l.contrast})`);
  if (l.bright !== 100) undo.push(`brightness(${100 / l.bright})`);
  if (l.sat !== 100 && l.sat > 0) undo.push(`saturate(${100 / l.sat})`);
  if (l.hue) undo.push(`hue-rotate(${-l.hue}deg)`);
  if (light) undo.push('hue-rotate(180deg)', 'invert(1)');
  back.push(...undo);
  return { page: page.join(' '), back: back.join(' '), undo: undo.join(' ') };
}

let imageUrl = null, imageBlob = null;
export async function loadLookImage() {
  const b = await idbGet('kv', 'look.image');
  setImage(b instanceof Blob ? b : null);
}
function setImage(blob) {
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageBlob = blob;
  imageUrl = blob ? URL.createObjectURL(blob) : null;
}
export async function saveLookImage(blob) {
  setImage(blob);
  if (blob) await idbPut('kv', 'look.image', blob); else await idbDelete('kv', 'look.image');
}

// puts a look on the page; theme: the light / dark choice ('light' turns the palette over)
export function applyLook(look, light) {
  const l = normalizeLook(look);
  const root = document.documentElement, body = document.body;
  const f = lookFilters(l, light);
  root.style.filter = isDefaultTint(l) ? '' : f.page;      // '' leaves the light theme to the stylesheet
  const s = root.style;
  s.setProperty('--font', `11px/1.25 ${FONTS[l.font][1]}`);
  for (const [k, m] of [['--r2', 2 / 3], ['--r3', 1], ['--r4', 4 / 3], ['--r6', 2]]) s.setProperty(k, `${Math.round(l.radius * m * 10) / 10}px`);
  s.setProperty('--ui-opacity', String(l.opacity / 100));
  const desktop = l.desktop !== 'none' && !!(window.flluaDesktop && window.flluaDesktop.setMaterial);
  const wall = l.bg !== 'none' && !desktop;
  let w = document.getElementById('wallpaper');
  if (wall && !w) { w = document.createElement('div'); w.id = 'wallpaper'; body.prepend(w); }
  if (w) {
    w.style.display = wall ? '' : 'none';
    w.style.background = l.bg === 'color' ? l.bgColor
      : l.bg === 'gradient' ? `linear-gradient(${l.bgAngle}deg, ${l.bgColor}, ${l.bgColor2})`
      : imageUrl ? `${l.bgColor} url("${imageUrl}") center / ${l.bgFit === 'tile' ? 'auto' : l.bgFit} ${l.bgFit === 'tile' ? 'repeat' : 'no-repeat'}` : l.bgColor;
    w.style.filter = f.back;
    w.style.inset = l.bgBlur ? `-${l.bgBlur * 2}px` : '0';           // blurred edges stay outside the window
  }
  root.classList.toggle('look-wall', wall);
  root.classList.toggle('look-clear', desktop);
  root.classList.toggle('look-see', wall || desktop);
  body.classList.toggle('look-glass', l.glass);
  if (window.flluaDesktop && window.flluaDesktop.setMaterial) window.flluaDesktop.setMaterial(desktop ? l.desktop : 'none');
  return l;
}

// ---------------------------------------------------------------- your themes (this computer)
const THEMES_KEY = 'fllua.looks';
export function myThemes() { try { const a = JSON.parse(localStorage.getItem(THEMES_KEY) || '[]'); return Array.isArray(a) ? a.filter((t) => t && t.name) : []; } catch (_) { return []; } }
function saveMyThemes(list) { try { localStorage.setItem(THEMES_KEY, JSON.stringify(list)); } catch (_) { /* private mode */ } }

const blobToDataUrl = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(b); });
const dataUrlToBlob = async (u) => (await fetch(u)).blob();

// ---------------------------------------------------------------- the window
export function createLookWindow(win, app) {
  win.setTitle('Customize look');
  const el = h('div.look');
  const set = (patch) => app.setLook(patch);
  const cur = () => app.prefs.look;

  const slider = (key, label, min, max, unit, step = 1) => {
    const out = h('span.look-val');
    const input = h('input', { type: 'range', min, max, step, dataset: { key } });
    const show = () => { out.textContent = `${cur()[key]}${unit}`; };
    input.addEventListener('input', () => { set({ [key]: +input.value }); show(); });
    input.addEventListener('dblclick', () => { set({ [key]: LOOK_DEFAULT[key] }); sync(); });
    return { row: h('label.look-row', { hint: 'Double-click resets' }, h('span', label), input, out), sync: () => { input.value = cur()[key]; show(); } };
  };
  const select = (key, label, options) => {
    const s = h('select.select', { dataset: { key } }, options.map(([v, l]) => h('option', { value: v }, tr(l))));
    s.addEventListener('change', () => { set({ [key]: s.value }); sync(); });
    return { row: h('label.look-row', h('span', label), s), sync: () => { s.value = cur()[key]; } };
  };
  const colorIn = (key) => {
    const c = h('input', { type: 'color', dataset: { key } });
    c.addEventListener('input', () => set({ [key]: c.value }));
    return { el: c, sync: () => { c.value = cur()[key]; } };
  };
  const check = (key, label, hint) => {
    const c = h('input', { type: 'checkbox', dataset: { key } });
    c.addEventListener('change', () => set({ [key]: c.checked }));
    return { row: h('label.look-row.check', { hint }, c, h('span', label)), sync: () => { c.checked = !!cur()[key]; } };
  };

  // themes
  const presets = h('div.look-presets');
  for (const [name, p] of LOOK_PRESETS) {
    const l = normalizeLook({ ...LOOK_DEFAULT, ...p });
    const sw = h('div.look-swatch', { style: { background: l.bg === 'gradient' ? `linear-gradient(${l.bgAngle}deg, ${l.bgColor}, ${l.bgColor2})` : '#2a2e33' } },
      h('span.look-dot', { style: { background: `hsl(${37 + l.hue}deg ${Math.min(100, 95 * l.sat / 100)}% ${Math.min(70, 56 * l.bright / 100)}%)` } }));
    presets.append(h('div.look-preset', { dataset: { preset: name }, onclick: async () => { await useTheme(l, null); } }, sw, h('span', tr(name))));
  }
  const mine = h('div.look-mine');
  const renderMine = () => {
    clear(mine);
    const list = myThemes();
    if (!list.length) mine.append(h('span.dim', 'Save the look you made and it appears here'));
    for (const t of list) {
      mine.append(h('div.look-my', { dataset: { theme: t.name } },
        h('span.grow', { onclick: async () => { await useTheme(t.look, t.image ? await idbGet('kv', `look.image:${t.name}`) : null); } }, t.name),
        h('div.btn.sm', { hint: 'Delete this theme', onclick: async () => { saveMyThemes(myThemes().filter((x) => x.name !== t.name)); await idbDelete('kv', `look.image:${t.name}`); renderMine(); } }, '✕')));
    }
  };
  async function useTheme(look, image) {
    if (image !== undefined && look.bg === 'image') await saveLookImage(image instanceof Blob ? image : null);
    app.setLook({ ...LOOK_DEFAULT, ...look }, true);
    sync();
  }

  const nameIn = h('input.field', { type: 'text', placeholder: tr('Theme name'), style: { width: '140px' } });
  nameIn.addEventListener('keydown', (e) => e.stopPropagation());
  const saveBtn = h('div.btn', { onclick: async () => {
    const name = nameIn.value.trim().slice(0, 40) || `${tr('My theme')} ${myThemes().length + 1}`;
    const l = cur();
    const withImage = l.bg === 'image' && imageBlob;
    if (withImage) await idbPut('kv', `look.image:${name}`, imageBlob);
    saveMyThemes([...myThemes().filter((t) => t.name !== name), { name, look: l, image: !!withImage }]);
    nameIn.value = '';
    renderMine();
    app.toast(`${tr('Saved')}: ${name}`);
  } }, 'Save as theme');
  const exportBtn = h('div.btn', { hint: 'A .json file with this look (and its picture) to keep or share', onclick: async () => {
    const l = cur();
    const json = { fllua: 'look', version: 1, look: l, image: l.bg === 'image' && imageBlob ? await blobToDataUrl(imageBlob) : null };
    downloadBlob(new TextEncoder().encode(JSON.stringify(json)), 'FL LUA look.json', 'application/json');
  } }, 'Export…');
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!j || j.fllua !== 'look' || !j.look) throw new Error(tr('not an FL LUA look'));
      await useTheme(normalizeLook(j.look), typeof j.image === 'string' && j.image.startsWith('data:image/') ? await dataUrlToBlob(j.image) : null);
      app.toast(tr('Look imported'));
    } catch (err) { app.toast(`${tr('Could not import')}: ${err.message}`); }
  });
  const importBtn = h('div.btn', { onclick: () => fileIn.click() }, 'Import…');
  const resetBtn = h('div.btn', { hint: 'Back to the classic look', onclick: async () => { await useTheme({ ...LOOK_DEFAULT }, null); } }, 'Reset');

  // colour
  const hue = slider('hue', 'Hue', -180, 180, '°'), sat = slider('sat', 'Saturation', 0, 200, ' %'), bright = slider('bright', 'Brightness', 50, 150, ' %'), contrast = slider('contrast', 'Contrast', 50, 150, ' %');

  // background
  const bg = select('bg', 'Background', [['none', 'None'], ['color', 'Colour'], ['gradient', 'Gradient'], ['image', 'Picture']]);
  const c1 = colorIn('bgColor'), c2 = colorIn('bgColor2');
  const colors = h('label.look-row', h('span', 'Colours'), c1.el, c2.el);
  const angle = slider('bgAngle', 'Gradient angle', 0, 360, '°', 5);
  const picIn = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  picIn.addEventListener('change', async () => {
    const f = picIn.files[0];
    picIn.value = '';
    if (!f) return;
    if (f.size > 40 * 1024 * 1024) { app.toast(tr('The picture is too big (40 MB at most)')); return; }
    await saveLookImage(f);
    const l = cur();
    app.setLook({ bg: 'image', opacity: l.opacity === 100 ? 85 : l.opacity });
    sync();
  });
  const picBtn = h('div.btn', { onclick: () => picIn.click() }, 'Choose picture…');
  const picRow = h('label.look-row', h('span', 'Picture'), picBtn, picIn);
  const fit = select('bgFit', 'Picture fit', [['cover', 'Fill'], ['contain', 'Fit'], ['tile', 'Tile']]);
  const blur = slider('bgBlur', 'Blur', 0, 40, ' px'), dim = slider('bgDim', 'Dim', 0, 90, ' %');

  // interface
  const opacity = slider('opacity', 'Interface opacity', 40, 100, ' %');
  const glass = check('glass', 'Frosted glass menus and dialogs', 'Menus, dialogs and messages let the background through, blurred');
  const mats = (window.flluaDesktop && window.flluaDesktop.materials) || [];
  const desktop = select('desktop', 'See-through window', [['none', 'Off'], ...mats.map((m) => [m, m === 'acrylic' ? 'Acrylic (blurred desktop)' : m === 'mica' ? 'Mica (tinted desktop)' : 'Blurred desktop'])]);
  if (!mats.length) { desktop.row.querySelector('select').disabled = true; desktop.row.dataset.hint = tr('The desktop app on Windows 11 or macOS can show the blurred desktop behind its window'); }
  const font = select('font', 'Font', Object.entries(FONTS).map(([k, [l]]) => [k, l]));
  const radius = slider('radius', 'Corners', 0, 12, ' px');

  const parts = [hue, sat, bright, contrast, bg, c1, c2, angle, fit, blur, dim, opacity, glass, desktop, font, radius];
  function sync() {
    for (const p of parts) p.sync();
    presets.style.filter = lookFilters(cur(), document.documentElement.dataset.theme === 'light').undo;
    const b = cur().bg;
    colors.style.display = b === 'color' || b === 'gradient' || b === 'image' ? '' : 'none';
    c2.el.style.display = b === 'gradient' ? '' : 'none';
    angle.row.style.display = b === 'gradient' ? '' : 'none';
    picRow.style.display = fit.row.style.display = b === 'image' ? '' : 'none';
    blur.row.style.display = dim.row.style.display = b === 'none' ? 'none' : '';
  }

  const section = (title, ...rows) => h('div.look-sec', h('div.look-h', title), ...rows);
  el.append(
    section('Themes', presets, h('div.look-h2', 'My themes'), mine, h('div.look-row.btns', nameIn, saveBtn, exportBtn, importBtn, fileIn, resetBtn)),
    section('Colour of the interface', hue.row, sat.row, bright.row, contrast.row),
    section('Background', bg.row, colors, angle.row, picRow, fit.row, blur.row, dim.row),
    section('Interface', opacity.row, glass.row, desktop.row, font.row, radius.row),
  );
  renderMine();
  sync();
  const off = app.store.bus.on('prefs', sync);
  return { el, onShow: () => { renderMine(); sync(); }, destroy() { off(); } };
}
