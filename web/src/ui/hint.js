// Hint bar: hovering any element with data-hint shows "Name — description" bottom-left.
import { h } from './h.js';

export class Hint {
  constructor(el) {
    this.el = el;
    this.cur = null;
    document.addEventListener('pointerover', (e) => {
      const t = e.target.closest ? e.target.closest('[data-hint]') : null;
      this.cur = t;
      this.render(t);
    });
    document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) { this.cur = null; this.render(null); } });
  }

  render(t) {
    const text = t ? t.dataset.hint : '';
    this.el.textContent = '';
    if (!text) return;
    const i = text.indexOf(' — ');
    if (i > 0) this.el.append(h('b', text.slice(0, i)), text.slice(i + 3));
    else this.el.append(text);
  }

  // re-render when the hovered element's hint text changed (knob values while dragging)
  update(el) { if (this.cur === el) this.render(el); }
}
