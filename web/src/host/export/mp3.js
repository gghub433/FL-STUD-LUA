// MP3 export through the vendored lamejs (LAME, LGPL). The library is loaded as a separate script on first use.
let loading = null;

export function loadLame() {
  if (typeof globalThis.lamejs === 'function' && globalThis.lamejs.Mp3Encoder) return Promise.resolve(globalThis.lamejs);
  if (typeof globalThis.lamejs === 'object' && globalThis.lamejs.Mp3Encoder) return Promise.resolve(globalThis.lamejs);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../../../vendor/lamejs/lame.min.js', import.meta.url).href;
    s.onload = () => (globalThis.lamejs && globalThis.lamejs.Mp3Encoder ? resolve(globalThis.lamejs) : reject(new Error('lamejs did not initialise')));
    s.onerror = () => { loading = null; reject(new Error('Could not load the MP3 encoder')); };
    document.head.append(s);
  });
  return loading;
}

// lame: the lamejs namespace (see loadLame). left/right: Float32Array. Returns Uint8Array.
export async function encodeMp3(lame, left, right, sampleRate, { kbps = 192, channels = 2, dither = true, onProgress, shouldCancel } = {}) {
  const enc = new lame.Mp3Encoder(channels === 1 ? 1 : 2, sampleRate, kbps);
  const n = left.length, block = 1152 * 8;
  const parts = [];
  let seed = 0x13579bd;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const toI16 = (src, from, len, mix) => {
    const out = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      let x = mix ? (left[from + i] + right[from + i]) * 0.5 : src[from + i];
      x *= 32767; if (dither) x += rnd() - rnd();
      out[i] = Math.max(-32768, Math.min(32767, Math.round(x)));
    }
    return out;
  };
  let lastYield = Date.now();
  for (let i = 0; i < n; i += block) {
    const len = Math.min(block, n - i);
    const l = toI16(left, i, len, channels === 1);
    const r = channels === 1 ? l : toI16(right, i, len, false);
    const chunk = enc.encodeBuffer(l, r);
    if (chunk.length) parts.push(Uint8Array.from(chunk, (v) => v & 255));
    if (Date.now() - lastYield > 30) {                         // keep the page responsive during a long encode
      if (onProgress) onProgress(i / n);
      if (shouldCancel && shouldCancel()) return null;
      await new Promise((res) => setTimeout(res, 0));
      lastYield = Date.now();
    }
  }
  const end = enc.flush();
  if (end.length) parts.push(Uint8Array.from(end, (v) => v & 255));
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
