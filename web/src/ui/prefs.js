// Interface preferences (this computer, not the project): theme, size, language.
//   theme  'dark' | 'light' | 'system'. The light theme turns the whole dark palette over (lightness inverted, hues kept),
//          so every editor, canvas and plugin window follows without colours of its own.
//   scale  0.75 … 2. The desktop app zooms its window (sharp at any size); a browser uses CSS zoom, and the canvases
//          draw with that many more pixels.
//   lang   'en' | 'ru'
const KEY = 'fllua.ui';
export const SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

function systemLang() { try { return /^ru\b/i.test(navigator.language || '') ? 'ru' : 'en'; } catch (_) { return 'en'; } }

export function loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { /* private mode */ }
  return { theme: ['dark', 'light', 'system'].includes(p.theme) ? p.theme : 'dark', scale: SCALES.includes(p.scale) ? p.scale : 1, lang: ['en', 'ru'].includes(p.lang) ? p.lang : systemLang() };
}

export function savePrefs(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (_) { /* private mode */ } }

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

export function applyTheme(theme) {
  const light = theme === 'light' || (theme === 'system' && media && media.matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
}

export function applyScale(scale) {
  const desk = window.flluaDesktop;
  if (desk && desk.setZoom) { desk.setZoom(scale); globalThis.__uiZoom = 1; document.documentElement.style.zoom = ''; }
  else { document.documentElement.style.zoom = scale === 1 ? '' : String(scale); globalThis.__uiZoom = scale; }
  window.dispatchEvent(new Event('resize'));
}

export function installPrefs(app, { setLang } = {}) {
  const p = app.prefs = loadPrefs();
  applyTheme(p.theme); applyScale(p.scale);
  if (media) media.addEventListener('change', () => { if (app.prefs.theme === 'system') applyTheme('system'); });
  app.setPref = (k, v) => {
    app.prefs[k] = v; savePrefs(app.prefs);
    if (k === 'theme') applyTheme(v);
    if (k === 'scale') applyScale(v);
    if (k === 'lang' && setLang) setLang(v);
    app.store.bus.emit('prefs', app.prefs);
  };
  return p;
}
