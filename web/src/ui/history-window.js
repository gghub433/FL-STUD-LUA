// Undo history: every edit as a list; click one to jump back to the state before it (Ctrl+Z / Ctrl+Alt+Z step one at a time).
import { h, clear } from './h.js';

export function createHistory(win, app) {
  const store = app.store;
  win.setTitle('Undo history');
  const list = h('div.scroll', { style: { flex: 1, minHeight: 0, padding: '4px 0' } });
  const fmt = (t) => (t ? new Date(t).toLocaleTimeString() : '');
  const render = () => {
    clear(list);
    const hist = store.history, fut = store.future;
    const row = (cls, label, time, onclick, hint) => h('div.hist-row' + cls, { onclick, hint }, h('span.hist-label', label), h('span.dim', fmt(time)));
    // newest first, like a stack of edits; the "now" line separates what can be undone from what can be redone
    for (let k = 0; k < fut.length; k++) { const j = fut.length - 1 - k; list.append(row('.redo', fut[j].label, 0, async () => { for (let n = 0; n <= j; n++) await store.redo(); }, 'Redo up to and including this edit')); }
    list.append(h('div.hist-now', 'Now'));
    for (let i = hist.length - 1; i >= 0; i--) list.append(row('', hist[i].label, hist[i].time, () => store.undoTo(i), 'Undo this edit and everything after it'));
    if (!hist.length && !fut.length) list.append(h('div.empty-note', 'Nothing to undo yet.'));
  };
  const el = h('div.rack', h('div.rack-head', h('div.btn', { onclick: () => store.undo(), hint: 'Undo (Ctrl+Z)' }, '↶ Undo'), h('div.btn', { onclick: () => store.redo(), hint: 'Redo (Ctrl+Alt+Z)' }, '↷ Redo'), h('div.grow'), h('span.dim', 'newest first')), list);
  const subs = [store.bus.on('history', render), store.bus.on('project', render)];
  render();
  return { el, onShow: render, destroy() { for (const s of subs) s(); } };
}
