// Modal dialogs and toasts.
import { h } from './h.js';
import { COLORS } from '../core/project.js';
import { showPopup, closePopups } from './menu.js';

export function modal({ title, body, buttons = [], width, onClose }) {
  const back = h('div.modal-back');
  const foot = h('div.modal-foot');
  const box = h('div.modal', { style: width ? { width: `${width}px` } : null, role: 'dialog' },
    h('div.modal-title', title), h('div.modal-body', body), buttons.length ? foot : null);
  back.append(box);
  const close = (result) => {
    window.removeEventListener('keydown', key, true);
    back.remove();
    if (onClose) onClose(result);
  };
  const key = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(null); }
  };
  for (const b of buttons) {
    foot.append(h('button.btn' + (b.primary ? '.primary' : ''), {
      onclick: () => { if (b.fn && b.fn() === false) return; close(b.value); },
    }, b.label));
  }
  back.addEventListener('pointerdown', (e) => { if (e.target === back && !buttons.length) close(null); });
  window.addEventListener('keydown', key, true);
  document.body.append(back);
  return { close, el: box };
}

export function promptText(title, label, value = '', okLabel = 'OK') {
  return new Promise((resolve) => {
    const inp = h('input.field', { type: 'text', value, style: { width: '100%' } });
    let m, settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); m.close(); };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(inp.value); });
    m = modal({
      title, body: [h('div.dim', label), inp],
      buttons: [
        { label: 'Cancel', fn: () => { finish(null); return false; } },
        { label: okLabel, primary: true, fn: () => { finish(inp.value); return false; } },
      ],
      onClose: () => finish(null),
    });
    inp.focus(); inp.select();
  });
}

export function confirmBox(title, message, okLabel = 'OK') {
  return new Promise((resolve) => {
    modal({
      title, body: h('div', message),
      buttons: [{ label: 'Cancel', value: false }, { label: okLabel, primary: true, value: true }],
      onClose: (r) => resolve(!!r),
    });
  });
}

export function alertBox(title, message) {
  return new Promise((resolve) => {
    modal({ title, body: h('div', { style: { whiteSpace: 'pre-wrap', userSelect: 'text' } }, message), buttons: [{ label: 'OK', primary: true, value: true }], onClose: () => resolve() });
  });
}

// Small palette popup. cb(color) is called on selection.
export function pickColor(x, y, current, cb) {
  const body = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(8, 22px)', gap: '4px', padding: '8px' } },
    COLORS.map((c) => h('div', {
      style: { width: '22px', height: '22px', background: c, border: c === current ? '2px solid #fff' : '1px solid #000', borderRadius: '3px', cursor: 'pointer' },
      onclick: () => { closePopups(); cb(c); },
    })));
  const el = showPopup([], x, y);
  el.append(body);
  el.style.minWidth = '0';
}

export function toast(msg, ms = 2400) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div#toasts'); document.body.append(box); }
  const t = h('div.toast', msg);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}
