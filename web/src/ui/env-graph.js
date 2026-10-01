// Small envelope previews (DAHDSR for the sampler, ADSR for synths).
export function drawEnv(canvas, stages, { color = '#ffb02e', sustainHold = 0.25 } = {}) {
  // stages: [{ t: seconds, to: level 0..1 }, ...]  (starting at level 0)
  const c = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  c.fillStyle = '#0e1012'; c.fillRect(0, 0, W, H);
  c.strokeStyle = '#1f2529'; c.lineWidth = 1;
  for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(0, (i / 4) * H); c.lineTo(W, (i / 4) * H); c.stroke(); }
  let total = 0; for (const s of stages) total += Math.max(0.0005, s.t);
  total *= 1 + sustainHold;
  const px = (t) => 4 + (t / total) * (W - 8), py = (v) => H - 4 - v * (H - 8);
  c.beginPath(); c.moveTo(px(0), py(0));
  let t = 0, v = 0;
  for (const s of stages) {
    const dt = Math.max(0.0005, s.t);
    if (s.curve === 'exp') { for (let k = 1; k <= 12; k++) { const u = k / 12; c.lineTo(px(t + dt * u), py(v + (s.to - v) * (1 - Math.exp(-4.6 * u)))); } }
    else c.lineTo(px(t + dt), py(s.to));
    t += dt; v = s.to;
    if (s.hold) { t += total * sustainHold / (1 + sustainHold); c.lineTo(px(t), py(v)); }
  }
  c.strokeStyle = color; c.lineWidth = 2; c.stroke();
  c.lineTo(px(t), py(0)); c.lineTo(px(0), py(0)); c.fillStyle = `${color}33`; c.fill();
}
