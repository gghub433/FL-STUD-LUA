// A short guided tour: each step points at a part of the window and says what it is for. Next / Back / Close;
// arrow keys and Esc work too. The windows a step talks about are opened for it.
import { h } from './h.js';

const STEPS = [
  { title: 'Welcome to FL LUA', text: 'A quick look around: what each part of the window does. It takes a minute; Esc ends the tour at any time.' },
  { sel: '#toolbar [data-section="transport"]', title: 'Transport', text: 'Play and stop with Space. PAT plays the current pattern over and over, SONG plays the Playlist. The round button records what you play.' },
  { sel: '#toolbar [data-section="tempo"]', title: 'Tempo', text: 'Drag the number up or down, or tap the beat on TAP. Everything follows: patterns, delays, audio clips that follow the tempo.' },
  { sel: '.win[data-id="rack"]', open: 'rack', title: 'Channel rack', text: 'Your instruments, one per row. Click the squares to switch steps on: that is a beat. Double-click a name to open the instrument.' },
  { sel: '#toolbar [data-section="pattern"]', title: 'Patterns', text: 'A pattern holds the notes of all channels. Make several (a verse beat, a chorus beat) and switch with the arrows or Ctrl+↑↓.' },
  { sel: '.win[data-id="pianoroll"]', open: 'pianoroll', title: 'Piano roll (F7)', text: 'Melodies and chords for the selected channel: click to draw notes, drag to move them, right-click to delete. Tools has quantize, strum, arpeggiator and more.' },
  { sel: '.win[data-id="playlist"]', open: 'playlist', title: 'Playlist (F5)', text: 'The song: place patterns, audio and automation clips on the tracks. Press SONG and play to hear the arrangement.' },
  { sel: '.win[data-id="mixer"]', open: 'mixer', title: 'Mixer (F9)', text: 'Each channel goes to a mixer track. Add effects in the ten slots on the right, balance the faders, and watch the master meter.' },
  { sel: '#browser-pane', browser: true, title: 'Browser (F8)', text: 'Sounds, presets, projects and templates. Click to listen, double-click or drag to use. More sounds come with the packs of the Plugin store.' },
  { sel: '#menubar', title: 'Menus', text: 'FILE saves to disk (Ctrl+S) and exports (Ctrl+R). TOOLS has the Plugin store, the audio editor and MIDI settings. OPTIONS has audio and interface settings, including the language.' },
  { title: 'That is it', text: 'Open the demo from FILE to see a finished beat, or start from a template. HELP > Take the tour shows this again.' },
];

export function startTour(app) {
  let i = 0;
  const shade = h('div.tour-shade');
  const ring = h('div.tour-ring');
  const title = h('div.tour-title'), text = h('div.tour-text'), count = h('span.dim');
  const back = h('div.btn', { onclick: () => go(i - 1) }, 'Back');
  const next = h('div.btn.primary', { onclick: () => go(i + 1) }, 'Next');
  const bubble = h('div.tour-bubble', title, text, h('div.row', { style: { gap: '6px', marginTop: '10px' } }, count, h('div.grow'), h('div.btn', { onclick: () => end() }, 'Close'), back, next));
  document.body.append(shade, ring, bubble);
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); end(); } else if (e.key === 'ArrowRight') go(i + 1); else if (e.key === 'ArrowLeft') go(i - 1); };
  window.addEventListener('keydown', key, true);
  function place() {
    const s = STEPS[i];
    const el = s.sel ? document.querySelector(s.sel) : null;
    const W = window.innerWidth, H = window.innerHeight, bw = 340;
    if (!el) {
      ring.style.display = 'none'; shade.style.display = '';
      bubble.style.left = `${(W - bw) / 2}px`; bubble.style.top = `${H * 0.3}px`;
      return;
    }
    shade.style.display = 'none';
    const r = el.getBoundingClientRect();
    Object.assign(ring.style, { display: '', left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
    const below = r.bottom + 12 + 160 < H;
    bubble.style.left = `${Math.max(8, Math.min(W - bw - 8, r.left))}px`;
    bubble.style.top = `${below ? r.bottom + 12 : Math.max(8, r.top - 12 - bubble.offsetHeight)}px`;
  }
  function go(n) {
    if (n < 0) return;
    if (n >= STEPS.length) { end(); return; }
    i = n;
    const s = STEPS[i];
    if (s.open && !app.wm.isOpen(s.open)) app.openWindow(s.open);
    if (s.open) app.wm.focus(s.open);
    if (s.browser && app.showBrowser) app.showBrowser(true);
    title.textContent = s.title; text.textContent = s.text; count.textContent = `${i + 1} / ${STEPS.length}`;
    back.classList.toggle('disabled', i === 0);
    next.textContent = i === STEPS.length - 1 ? 'Done' : 'Next';
    requestAnimationFrame(place);
  }
  function end() {
    window.removeEventListener('keydown', key, true); window.removeEventListener('resize', place);
    shade.remove(); ring.remove(); bubble.remove();
    try { localStorage.setItem('fllua.tour', 'done'); } catch (_) { /* private mode */ }
    app.tourActive = false;
  }
  window.addEventListener('resize', place);
  app.tourActive = true;
  go(0);
  return { end, go, get step() { return i; } };
}
