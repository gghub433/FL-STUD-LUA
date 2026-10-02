// Plugin store: browse, install, update and remove plugin packs (see core/packs.js for what a pack is).
import { h, clear } from './h.js';
import { modal, confirmBox, promptText } from './dialog.js';
import { BUNDLED_URL, fetchCatalog, fetchPackSource, userCatalogs, saveUserCatalogs, compareVersions } from '../host/pack-catalog.js';

const KIND = { instrument: 'generator', effect: 'effect' };

export function createStore(win, app) {
  win.setTitle('Plugin store');
  const bus = app.store.bus;
  const status = h('span.dim', '');
  const body = h('div.scroll.ps-body', { style: { flex: 1, minHeight: 0, padding: '8px 12px' } });
  let catalogs = [];                            // [{ url, name, packs, bundled } | { url, error }]
  let busy = new Set();

  const note = (msg) => { status.textContent = msg; };

  const confirmInstall = async (title, source, sha, origin) => {
    const lines = [
      h('div', 'A plugin pack is program code. It runs inside FL LUA with the same access as the app itself (your projects and samples in this browser). Install packs only from people you trust.'),
      h('div', { style: { marginTop: '8px' } }, h('span.dim', 'Source: '), origin),
      h('div', { style: { marginTop: '4px', fontFamily: 'var(--mono)', fontSize: '11px', wordBreak: 'break-all' } }, h('span.dim', 'SHA-256: '), sha),
    ];
    return new Promise((resolve) => modal({ title, body: lines, width: 460, buttons: [{ label: 'Cancel', value: false }, { label: 'Install', primary: true, value: true }], onClose: (r) => resolve(!!r) }));
  };

  const run = async (key, fn) => {
    if (busy.has(key)) return;
    busy.add(key); render();
    try { await fn(); } catch (err) { app.toast(String(err.message || err)); note(String(err.message || err)); } finally { busy.delete(key); render(); }
  };

  const done = (rec) => { app.toast(`Installed ${rec.name}: ${rec.plugins.map((p) => p.name).join(', ')}. Find them in the plugin picker (Alt+F8) and the ADD menu`); note(`${rec.name} installed`); };

  const installEntry = (cat, entry) => run(`i:${entry.id}`, async () => {
    const source = await fetchPackSource(entry);
    if (!cat.bundled) {
      const sha = await (await import('../host/pack-manager.js')).sha256(source);
      if (sha !== entry.sha256) throw new Error('The downloaded file does not match the checksum of the catalog: it was not installed');
      if (!(await confirmInstall(`Install ${entry.name}?`, source, sha, cat.url))) return;
    }
    done(await app.packs.install(source, { from: cat.name, sha: entry.sha256 }));
  });

  const installFile = () => {
    const inp = h('input', { type: 'file', accept: '.js,.mjs,.flpack,.flpack.js,text/javascript', style: { display: 'none' } });
    inp.addEventListener('change', () => run('file', async () => {
      const f = inp.files[0];
      if (!f) return;
      const source = await f.text();
      const sha = await (await import('../host/pack-manager.js')).sha256(source);
      if (!(await confirmInstall(`Install ${f.name}?`, source, sha, `file ${f.name}`))) return;
      done(await app.packs.install(source, { from: `file ${f.name}` }));
    }));
    document.body.append(inp); inp.click(); setTimeout(() => inp.remove(), 60000);
  };

  const installUrl = async () => {
    const url = await promptText('Install from a web address', 'Address of a .flpack.js file', 'https://');
    if (!url || !/^https?:\/\//.test(url)) return;
    run('url', async () => {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
      const source = await res.text();
      const sha = await (await import('../host/pack-manager.js')).sha256(source);
      if (!(await confirmInstall('Install this pack?', source, sha, url))) return;
      done(await app.packs.install(source, { from: url }));
    });
  };

  const addCatalog = async () => {
    const url = await promptText('Add a catalog', 'Address of a catalog.json', 'https://');
    if (!url || !/^https?:\/\//.test(url)) return;
    const list = userCatalogs();
    if (!list.includes(url)) saveUserCatalogs([...list, url]);
    await reload();
  };

  const removeCatalog = async (url) => { saveUserCatalogs(userCatalogs().filter((u) => u !== url)); await reload(); };

  const remove = (rec) => run(`r:${rec.id}`, async () => {
    const used = app.packs.usage(rec.id);
    const msg = `Remove "${rec.name}"?${used ? ` ${used} channel(s) or effect(s) of the open project use it and will disappear.` : ''} The pack is deleted from this browser now; the program has to be reloaded to finish.`;
    if (!(await confirmBox('Remove plugin pack', msg, 'Remove'))) return;
    await app.packs.remove(rec.id);
    if (await confirmBox('Reload FL LUA?', 'Reload now to unload the removed plugins? Unsaved changes of the project are kept in the autosave.', 'Reload')) { await app.store.autosave(); location.reload(); }
  });

  const chips = (plugins) => h('div.ps-chips', plugins.map((p) => h('span.ps-chip.' + (p.kind === 'instrument' ? 'gen' : 'fx'), { hint: p.description || p.name }, h('b', p.name), ` ${KIND[p.kind] || p.kind}`)));

  const card = (info, actions, extra) => h('div.ps-card',
    h('div.ps-head', h('b.ps-name', info.name), h('span.dim', ` v${info.version}${info.author ? ' · ' + info.author : ''}${info.license ? ' · ' + info.license : ''}`), h('div.grow'), ...actions),
    info.description ? h('div.ps-desc', info.description) : null, chips(info.plugins || []), extra || null);

  const render = () => {
    clear(body);
    const installed = new Map(app.packs.list().map((r) => [r.id, r]));
    const seen = new Set();
    if (app.packs.pendingRemoval.size) body.append(h('div.ps-banner', `${app.packs.pendingRemoval.size} pack(s) removed: reload to unload them. `, h('div.btn.sm', { onclick: async () => { await app.store.autosave(); location.reload(); } }, 'Reload now')));
    for (const cat of catalogs) {
      body.append(h('div.mx-title', cat.bundled ? 'Included with FL LUA' : cat.name || cat.url,
        cat.bundled ? null : h('span', { style: { float: 'right' } }, h('div.btn.sm', { onclick: () => removeCatalog(cat.url) }, 'Forget this catalog'))));
      if (cat.error) { body.append(h('div.ps-desc.err', `Could not load this catalog: ${cat.error}`)); continue; }
      if (!cat.packs.length) body.append(h('div.ps-desc', 'No packs in this catalog.'));
      for (const e of cat.packs) {
        seen.add(e.id);
        const rec = installed.get(e.id), gone = app.packs.pendingRemoval.has(e.id);
        const newer = rec && compareVersions(e.version, rec.version) > 0, key = `i:${e.id}`;
        const acts = [];
        if (rec && !gone) {
          acts.push(h('span.ps-state' + (newer ? '.upd' : ''), newer ? `v${rec.version} installed` : '✓ Installed'));
          if (newer) acts.push(h('div.btn.primary', { onclick: () => installEntry(cat, e) }, busy.has(key) ? 'Updating…' : `Update to v${e.version}`));
          acts.push(h('div.btn', { onclick: () => remove(rec) }, 'Remove'));
        } else acts.push(h('div.btn.primary', { onclick: () => installEntry(cat, e), class: busy.has(key) ? 'disabled' : '' }, busy.has(key) ? 'Installing…' : gone ? 'Install again' : 'Install'));
        body.append(card(e, acts));
      }
    }
    const mine = [...installed.values()].filter((r) => !seen.has(r.id));
    if (mine.length) {
      body.append(h('div.mx-title', 'Installed from files and addresses'));
      for (const r of mine) body.append(card(r, [h('span.ps-state', '✓ Installed'), h('div.btn', { onclick: () => remove(r) }, 'Remove')], h('div.dim.ps-desc', `from ${r.from} · SHA-256 ${r.sha256.slice(0, 16)}…`)));
    }
    if (app.packs.failed.size) for (const [id, err] of app.packs.failed) body.append(h('div.ps-desc.err', `${id} did not load: ${err}`));
  };

  const reload = async () => {
    note('Loading catalogs…');
    const urls = [BUNDLED_URL, ...userCatalogs()];
    catalogs = await Promise.all(urls.map((u) => fetchCatalog(u).catch((err) => ({ url: u, name: u, packs: [], error: String(err.message || err) }))));
    note(`${app.packs.list().length} installed`);
    render();
  };

  const head = h('div.rack-head',
    h('div.btn', { hint: 'Install a pack from a .flpack.js file on this computer', onclick: installFile }, 'Install from file…'),
    h('div.btn', { hint: 'Install a pack from a web address', onclick: installUrl }, 'From address…'),
    h('div.btn', { hint: 'Add another catalog of packs (its address ends with catalog.json)', onclick: addCatalog }, 'Add catalog…'),
    h('div.btn.sm', { hint: 'Load the catalogs again', onclick: reload }, '⟳'),
    h('div.grow'), status);
  const el = h('div.rack', head, body);
  const sub = bus.on('plugins', render);
  reload();
  return { el, onShow: reload, destroy() { sub(); } };
}
