// Minimal DOM helpers (no framework).

// h('div.cls#id', { class, style:{}, onclick, hint:'text', dataset:{}, ... }, ...children)
export function h(tag, props, ...children) {
  let name = tag, cls = '', id = '';
  const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  if (m) {
    name = m[1] || 'div';
    for (const part of m[2].match(/[.#][\w-]+/g) || []) {
      if (part[0] === '.') cls += (cls ? ' ' : '') + part.slice(1); else id = part.slice(1);
    }
  }
  const el = document.createElement(name);
  if (cls) el.className = cls;
  if (id) el.id = id;
  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    for (const k in props) {
      const v = props[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = (el.className ? el.className + ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'hint') el.dataset.hint = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && k !== 'list' && k !== 'type' && typeof v !== 'object') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  } else if (props !== undefined && props !== null) {
    children.unshift(props);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  for (const c of children) if (c) el.append(c);
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export function on(el, type, fn, opts) { el.addEventListener(type, fn, opts); return () => el.removeEventListener(type, fn, opts); }

// Pointer drag helper: calls move(dx, dy, ev) while the button is down, done(ev) on release.
export function drag(ev, move, done, opts = {}) {
  const startX = ev.clientX, startY = ev.clientY;
  const target = ev.target;
  if (target.setPointerCapture && ev.pointerId !== undefined) { try { target.setPointerCapture(ev.pointerId); } catch (_) { /* detached */ } }
  const mv = (e) => move(e.clientX - startX, e.clientY - startY, e);
  const up = (e) => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    document.body.classList.remove('dragging');
    if (target.releasePointerCapture && ev.pointerId !== undefined) { try { target.releasePointerCapture(ev.pointerId); } catch (_) { /* gone */ } }
    if (done) done(e);
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  if (!opts.keepCursor) document.body.classList.add('dragging');
}

// Throttle to one call per animation frame.
export function raf(fn) {
  let pending = false;
  return (...a) => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; fn(...a); });
  };
}
