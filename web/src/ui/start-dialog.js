// Project picker shown at start: templates, recent projects saved in this browser, recover the autosave,
// open a file, or just start. "Show at startup" is remembered.
import { h } from './h.js';
import { modal } from './dialog.js';
import { TEMPLATES } from '../core/templates.js';

const LS = 'stepwise.start.hide';
export const startDialogWanted = () => { try { return localStorage.getItem(LS) !== '1'; } catch (_) { return true; } };

export async function openStartDialog(app) {
  const recent = (await app.library.projects()).slice(0, 6);
  const auto = await app.library.autosave();
  const showAuto = auto && recent.every((r) => r.time < auto.time - 1000) && auto.json && JSON.parse(auto.json).channels && JSON.parse(auto.json).channels.length;
  let m;
  const close = () => m.close();
  const card = (title, sub, fn, cls = '') => h('div.start-card' + cls, { onclick: () => { close(); fn(); } }, h('b', title), h('span.dim', sub));
  const tplCards = TEMPLATES.map((t) => card(t.name, t.description, () => app.newFromTemplate({ build: t.build, name: t.name }, true)));
  const rec = recent.length ? recent.map((r) => card(r.name, new Date(r.time).toLocaleString(), () => app.openSavedProject(r, true), '.small')) : [h('div.dim', 'Projects you save with Ctrl+S appear here.')];
  const hide = h('input', { type: 'checkbox' });
  hide.addEventListener('change', () => { try { localStorage.setItem(LS, hide.checked ? '1' : '0'); } catch (_) { /* private mode */ } });
  m = modal({
    title: 'Welcome to FL LUA', width: 720,
    body: h('div.start',
      showAuto ? h('div.start-recover', h('b', 'Recover your last session?'), h('span.dim', `${auto.name} · ${new Date(auto.time).toLocaleString()}`), h('div.btn.primary', { onclick: () => { close(); app.openSavedProject(auto, true); } }, 'Recover')) : null,
      h('div.mx-title', { style: { margin: '6px 0' } }, 'Start a new project'), h('div.start-grid', ...tplCards),
      h('div.mx-title', { style: { margin: '10px 0 6px' } }, 'Recent projects'), h('div.start-grid', ...rec),
      h('div.row', { style: { marginTop: '12px', gap: '8px' } }, h('div.btn', { onclick: () => { close(); app.openFile(); } }, 'Open file…'), h('div.btn', { onclick: () => { close(); app.openDemo(); } }, 'Open the demo'), h('div.grow'),
        h('label.row', { style: { gap: '6px' } }, hide, 'Do not show this at startup'))),
    buttons: [{ label: 'Close', primary: true }],
  });
  return m;
}
