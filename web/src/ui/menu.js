// Popup menus (context menus, menu-bar dropdowns, submenus).
import { h } from './h.js';

let stack = [];          // open popup elements, outermost first
let cleanup = null;

export function closePopups() {
  for (const el of stack) el.remove();
  stack = [];
  if (cleanup) { cleanup(); cleanup = null; }
  document.dispatchEvent(new CustomEvent('popup-closed'));
}

export const isPopupOpen = () => stack.length > 0;

// item: { label, key, fn, checked, disabled, sep, title, submenu: [...] | () => [...] }
function build(items, level) {
  const el = h('div.popup', { dataset: { level } });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { el.append(h('div.sep')); continue; }
    if (it.title) { el.append(h('div.title', it.title)); continue; }
    const row = h('div.item', { class: it.disabled ? 'disabled' : '', dataset: { label: it.label } },
      h('span', it.checked !== undefined ? h('span.check', it.checked ? '✓' : '') : null, it.label),
      it.submenu ? h('span.arrow', '▸') : (it.key ? h('span.key', it.key) : null));
    if (it.submenu) {
      let timer;
      row.addEventListener('pointerenter', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          while (stack.length > level + 1) stack.pop().remove();
          const r = row.getBoundingClientRect();
          const sub = build(typeof it.submenu === 'function' ? it.submenu() : it.submenu, level + 1);
          place(sub, r.right - 2, r.top - 3, r);
        }, 90);
      });
      row.addEventListener('pointerleave', () => clearTimeout(timer));
    } else {
      row.addEventListener('pointerenter', () => { while (stack.length > level + 1) stack.pop().remove(); });
      row.addEventListener('click', (e) => {
        if (it.disabled) return;
        e.stopPropagation();
        closePopups();
        if (it.fn) it.fn();
      });
    }
    el.append(row);
  }
  return el;
}

function place(el, x, y, anchor) {
  document.body.append(el);
  stack.push(el);
  const r = el.getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  if (x + r.width > W - 4) x = anchor ? Math.max(4, anchor.left - r.width + 2) : Math.max(4, W - r.width - 4);
  if (y + r.height > H - 4) y = Math.max(4, H - r.height - 4);
  el.style.left = `${x}px`; el.style.top = `${y}px`;
  if (r.height > H - 8) { el.style.maxHeight = `${H - 8}px`; el.style.overflowY = 'auto'; }
}

export function showPopup(items, x, y, anchorRect) {
  closePopups();
  const el = build(items, 0);
  place(el, x, y, anchorRect);
  const down = (e) => { if (!e.target.closest || !e.target.closest('.popup')) closePopups(); };
  const key = (e) => { if (e.key === 'Escape') closePopups(); };
  const blur = () => closePopups();
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('keydown', key, true);
  window.addEventListener('blur', blur);
  cleanup = () => {
    window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', blur);
  };
  return el;
}

export function contextMenu(ev, items) {
  ev.preventDefault();
  ev.stopPropagation();
  return showPopup(items, ev.clientX, ev.clientY);
}

// Menu bar: defs = [{ label, items: () => [...] }]
export function buildMenuBar(container, defs, brand) {
  container.append(brand);
  let openIdx = -1;
  const tops = defs.map((d, i) => {
    const el = h('div.menu-top', { dataset: { menu: d.label } }, d.label);
    const open = () => {
      const r = el.getBoundingClientRect();
      for (const t of tops) t.classList.remove('open');
      el.classList.add('open');
      showPopup(d.items(), r.left, r.bottom, r);
      openIdx = i;
    };
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); if (openIdx === i && isPopupOpen()) { closePopups(); } else open(); });
    el.addEventListener('pointerenter', () => { if (isPopupOpen() && openIdx !== i && openIdx >= 0) open(); });
    container.append(el);
    return el;
  });
  document.addEventListener('popup-closed', () => { openIdx = -1; for (const t of tops) t.classList.remove('open'); });
  return tops;
}
