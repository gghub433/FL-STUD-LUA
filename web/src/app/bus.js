// Tiny synchronous event bus.
export class Bus {
  constructor() { this.map = new Map(); }

  on(evt, fn) {
    let s = this.map.get(evt);
    if (!s) { s = new Set(); this.map.set(evt, s); }
    s.add(fn);
    return () => s.delete(fn);
  }

  once(evt, fn) {
    const off = this.on(evt, (...a) => { off(); fn(...a); });
    return off;
  }

  emit(evt, ...args) {
    const s = this.map.get(evt);
    if (!s) return;
    for (const fn of [...s]) {
      try { fn(...args); } catch (err) { console.error(`[bus:${evt}]`, err); }
    }
  }
}
