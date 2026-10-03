// New versions of the desktop app (HELP > Check for updates…). The desktop shell knows how this copy was installed:
//   auto - the Windows installer and the Linux AppImage download the update here and restart into it
//   page - the portable .exe, the .deb and macOS open the download of the new version
// Once a day, a few seconds after the start, the app checks quietly and offers a newer version; "Skip this version"
// and "Check automatically" are kept on this computer. The web version is always the latest and has none of this.
import { h } from '../ui/h.js';
import { modal } from '../ui/dialog.js';

const KEY = 'fllua.updates';
const DAY = 24 * 3600 * 1000;
const load = () => { try { return { auto: true, last: 0, skip: '', ...(JSON.parse(localStorage.getItem(KEY) || '{}') || {}) }; } catch (_) { return { auto: true, last: 0, skip: '' }; } };
const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) { /* private mode */ } };
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

export function installUpdates(app) {
  const desk = window.flluaDesktop;
  const bridge = desk && desk.update;
  const u = app.updates = { available: !!bridge, state: load(), info: null, progress: null, downloaded: false, dialog: null };
  if (!bridge) return u;

  const listeners = new Set();
  const changed = () => { for (const f of listeners) f(); };
  bridge.onProgress((p) => { u.progress = p; changed(); });
  bridge.onDownloaded(() => { u.downloaded = true; u.progress = null; changed(); });
  bridge.onError((m) => { u.error = m; u.progress = null; changed(); });

  u.check = async () => {
    u.error = null;
    u.info = await bridge.check();
    if (u.info.error) u.error = u.info.error;
    u.downloaded = !!u.info.downloaded;
    u.state.last = Date.now(); save(u.state);
    changed();
    return u.info;
  };
  u.setAuto = (on) => { u.state.auto = !!on; save(u.state); };

  // the person agreed: unsaved work is saved (or let go) first, then the new version takes over
  const restartInto = async () => {
    if (app.store.dirty && app.store.project.channels.length) {
      const r = await new Promise((resolve) => modal({
        title: 'Restart and update', body: h('div', 'Save the project before FL LUA restarts?'),
        buttons: [{ label: 'Cancel', value: 'cancel' }, { label: "Don't save", value: 'drop' }, { label: 'Save', primary: true, value: 'save' }],
        onClose: (v) => resolve(v || 'cancel'),
      }));
      if (r === 'cancel') return;
      if (r === 'save' && !(await app.files.save().catch(() => false))) return;
    }
    bridge.install();
  };

  u.open = (opts = {}) => {
    if (u.dialog) { u.dialog.close(); u.dialog = null; }
    const status = h('div', { style: { margin: '4px 0 8px', lineHeight: 1.5 } });
    const notes = h('div.dim', { style: { whiteSpace: 'pre-wrap', maxHeight: '180px', overflow: 'auto', fontSize: '11px', lineHeight: 1.45, display: 'none', border: '1px solid var(--line, #3a4249)', padding: '6px 8px', borderRadius: '3px' } });
    const bar = h('div.upd-bar', h('i'));
    const actions = h('div.row', { style: { gap: '6px', marginTop: '10px', flexWrap: 'wrap' } });
    const auto = h('input', { type: 'checkbox', checked: u.state.auto, onchange: () => u.setAuto(auto.checked) });
    const body = h('div.upd', status, bar, notes, actions,
      h('label.row', { style: { gap: '6px', marginTop: '12px', fontSize: '11px' } }, auto, h('span', 'Check for a new version once a day')));
    const btn = (label, fn, primary) => h('button.btn' + (primary ? '.primary' : ''), { onclick: fn }, label);
    const render = () => {
      const i = u.info;
      actions.textContent = ''; bar.style.display = 'none';
      if (!i) { status.textContent = 'Checking for a new version…'; return; }
      notes.style.display = i.available && i.notes ? '' : 'none';
      notes.textContent = (i.notes || '').replace(/\r/g, '').trim();
      if (u.error && !i.available) { status.textContent = `Could not check for updates: ${u.error}`; actions.append(btn('Try again', () => { u.info = null; render(); u.check(); })); return; }
      if (!i.available) { status.textContent = `FL LUA ${i.current} is the latest version.`; return; }
      status.textContent = `FL LUA ${i.latest} is available (this is ${i.current}).`;
      if (i.mode === 'auto') {
        if (u.downloaded) {
          status.textContent = `FL LUA ${i.latest} is downloaded. It is installed when FL LUA restarts (or the next time you close it).`;
          actions.append(btn('Restart and update', restartInto, true));
        } else if (u.progress) {
          bar.style.display = '';
          bar.firstChild.style.width = `${Math.max(2, Math.min(100, u.progress.percent || 0))}%`;
          status.textContent = `Downloading FL LUA ${i.latest}… ${mb(u.progress.transferred || 0)} of ${mb(u.progress.total || 0)}`;
        } else {
          if (u.error) status.textContent += ` The download failed: ${u.error}`;
          actions.append(btn('Download update', () => { u.error = null; u.progress = { percent: 0, transferred: 0, total: 0 }; render(); bridge.download().catch((e) => { u.error = e.message || String(e); u.progress = null; render(); }); }, true));
        }
      } else {
        actions.append(btn('Download', () => bridge.open('file'), true), btn('Release page', () => bridge.open('page')));
      }
      if (i.latest !== u.state.skip && !u.downloaded && !u.progress) actions.append(btn('Skip this version', () => { u.state.skip = i.latest; save(u.state); m.close(); }));
    };
    listeners.add(render);
    const m = u.dialog = modal({ title: 'Updates', body, width: 460, buttons: [{ label: 'Close', primary: false }], onClose: () => { listeners.delete(render); if (u.dialog === m) u.dialog = null; } });
    render();
    if (!opts.noCheck) u.check().catch((e) => { u.error = e.message || String(e); u.info = { current: '', available: false }; render(); });
    return m;
  };

  // the quiet daily check: only a newer version that was not skipped is shown
  u.autoCheck = async () => {
    if (!u.state.auto || Date.now() - (u.state.last || 0) < DAY) return;
    const i = await u.check().catch(() => null);
    if (i && i.available && i.latest !== u.state.skip && !app.tourActive && !document.querySelector('.modal-back')) u.open({ noCheck: true });
  };
  setTimeout(() => { u.autoCheck(); }, 8000);
  return u;
}
