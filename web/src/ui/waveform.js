// Waveform drawing with a per-width peak cache.
export function peaksFor(entry, width) {
  const key = `_pk${width}`;
  if (entry[key]) return entry[key];
  const out = new Float32Array(width * 2);
  const ch = entry.channels, n = entry.length;
  for (let x = 0; x < width; x++) {
    const a = Math.floor((x / width) * n), b = Math.max(a + 1, Math.floor(((x + 1) / width) * n));
    let mn = 0, mx = 0;
    const step = Math.max(1, (b - a) >> 6);
    for (const c of ch) for (let i = a; i < b; i += step) { const v = c[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    out[x * 2] = mn; out[x * 2 + 1] = mx;
  }
  entry[key] = out;
  return out;
}

export function drawWave(canvas, entry, { color = '#ffb02e', bg = '#0e1012', dim = null, label = '' } = {}) {
  const c = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  c.fillStyle = '#1b2024'; c.fillRect(0, H / 2, W, 1);
  if (!entry) { c.fillStyle = '#5b666e'; c.font = '11px sans-serif'; c.fillText(label || 'No sample. Use Load or drop a file here', 12, H / 2 - 6); return; }
  const pk = peaksFor(entry, W);
  c.fillStyle = color;
  for (let x = 0; x < W; x++) {
    if (dim && (x < dim[0] * W || x > dim[1] * W)) c.fillStyle = '#5a4a28'; else c.fillStyle = color;
    const mn = pk[x * 2], mx = pk[x * 2 + 1];
    c.fillRect(x, H / 2 - mx * (H / 2 - 2), 1, Math.max(1, (mx - mn) * (H / 2 - 2)));
  }
}
