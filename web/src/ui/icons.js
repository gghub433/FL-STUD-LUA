// Inline SVG icons (own drawings, 16x16 grid).
import { svg } from './h.js';

const P = {
  play: '<path d="M4 2.5v11l9-5.5z" fill="currentColor"/>',
  stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor"/>',
  pause: '<rect x="3.5" y="3" width="3.2" height="10" rx=".8" fill="currentColor"/><rect x="9.3" y="3" width="3.2" height="10" rx=".8" fill="currentColor"/>',
  record: '<circle cx="8" cy="8" r="4.6" fill="currentColor"/>',
  metro: '<path d="M5 14 6.6 3h2.8L11 14z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 11 11.5 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="10.6" cy="5.4" r="1.1" fill="currentColor"/>',
  countin: '<text x="8" y="12" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" font-family="monospace">1·</text>',
  overdub: '<rect x="2.5" y="3" width="8" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="5.5" y="8" width="8" height="5" rx="1" fill="currentColor" opacity=".85"/>',
  blend: '<circle cx="6" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="10" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  tap: '<path d="M8 2v7M5 6.5 8 9.6l3-3.1M3.5 13h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  playlist: '<rect x="2" y="3" width="12" height="2.6" fill="currentColor"/><rect x="2" y="6.8" width="7" height="2.6" fill="currentColor" opacity=".8"/><rect x="5" y="10.6" width="9" height="2.6" fill="currentColor" opacity=".65"/>',
  pianoroll: '<rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="2" y="2" width="4" height="12" fill="currentColor" opacity=".35"/><rect x="7" y="4" width="5" height="2" fill="currentColor"/><rect x="9" y="8" width="4" height="2" fill="currentColor"/>',
  rack: '<g fill="currentColor"><rect x="2" y="3" width="2" height="2"/><rect x="5.5" y="3" width="2" height="2"/><rect x="9" y="3" width="2" height="2"/><rect x="12" y="3" width="2" height="2"/><rect x="2" y="7" width="2" height="2"/><rect x="5.5" y="7" width="2" height="2" opacity=".4"/><rect x="9" y="7" width="2" height="2" opacity=".4"/><rect x="12" y="7" width="2" height="2"/><rect x="2" y="11" width="2" height="2" opacity=".4"/><rect x="5.5" y="11" width="2" height="2"/><rect x="9" y="11" width="2" height="2" opacity=".4"/><rect x="12" y="11" width="2" height="2" opacity=".4"/></g>',
  mixer: '<g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4 2v12M8 2v12M12 2v12"/></g><g fill="currentColor"><rect x="2.5" y="9" width="3" height="2.2"/><rect x="6.5" y="4.5" width="3" height="2.2"/><rect x="10.5" y="7" width="3" height="2.2"/></g>',
  browser: '<path d="M2 4h4.5l1.5 1.5H14V13H2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  picker: '<path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".6"/>',
  pencil: '<path d="M3 13l.8-3.2 7-7a1.4 1.4 0 0 1 2 0l.4.4a1.4 1.4 0 0 1 0 2l-7 7z" fill="currentColor" opacity=".9"/><path d="M9.8 3.8l2.4 2.4" stroke="#272a2d" stroke-width="1"/>',
  brush: '<path d="M10.5 2.5l3 3-5 5-3-3z" fill="currentColor"/><path d="M5 8.2c-2 .3-2.8 1.8-2.6 3.6.1 1.1-.4 1.7-.4 1.7s2.6.5 4-.6c1-.8 1.2-2 .3-3z" fill="currentColor" opacity=".7"/>',
  repeat: '<rect x="2" y="5" width="3.4" height="6" fill="currentColor"/><rect x="6.3" y="5" width="3.4" height="6" fill="currentColor" opacity=".75"/><rect x="10.6" y="5" width="3.4" height="6" fill="currentColor" opacity=".5"/>',
  trash: '<path d="M3.5 4.5h9M6.2 4.5V3h3.6v1.5M4.6 4.5l.6 8.5h5.6l.6-8.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>',
  mute: '<path d="M3 6h2.4L9 3v10L5.4 10H3z" fill="currentColor"/><path d="M11 5.5l3.5 5M14.5 5.5l-3.5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  slice: '<rect x="2" y="6" width="12" height="4" fill="currentColor" opacity=".55"/><path d="M8 2v12" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 1.4"/>',
  select: '<rect x="2.5" y="2.5" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.6 1.6"/>',
  zoom: '<circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10 10l3.6 3.6M5.4 7h3.2M7 5.4v3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  wrench: '<path d="M10.8 2.2a3.3 3.3 0 0 0-3.2 4.3L2.5 11.6a1.3 1.3 0 0 0 1.9 1.9l5.1-5.1a3.3 3.3 0 0 0 4.3-3.2l-2 2-1.9-.4-.4-1.9z" fill="currentColor"/>',
  loop: '<path d="M3 8a3.5 3.5 0 0 1 3.5-3.5H12M13 3v3h-3M13 8a3.5 3.5 0 0 1-3.5 3.5H4M3 13v-3h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
};

export function icon(name, size = 16) {
  const el = svg('svg', { viewBox: '0 0 16 16', width: size, height: size });
  el.innerHTML = P[name] || '';
  return el;
}
