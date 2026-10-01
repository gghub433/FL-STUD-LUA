// "Pick a parameter" dialog: category -> item -> parameter, resolving to an address string such as
// ch:3:p:cutoff or mx:2:fx:0:p:threshold. Used for automation targets and controller links.
import { h } from './h.js';
import { modal } from './dialog.js';
import { CHANNEL_BUILTIN, TRACK_BUILTIN, MASTER_BUILTIN, TRANSPORT_BUILTIN, trackName } from '../core/addr.js';
import { instrumentSchema } from '../core/instruments/index.js';
import { effectSchema, effectMeta } from '../core/effects/index.js';

// every automatable parameter of the project as { group, item, label, addr }
export function listParams(project) {
  const out = [];
  for (const c of project.channels) {
    if (c.type === 'automation' || c.type === 'layer') continue;
    const group = `Channel: ${c.name}`;
    for (const d of CHANNEL_BUILTIN) out.push({ group, label: d.name, addr: `ch:${c.id}:${d.id}`, def: d });
    for (const d of instrumentSchema(c.type) || []) out.push({ group, label: d.name, addr: `ch:${c.id}:p:${d.id}`, def: d, section: d.group || '' });
  }
  project.mixer.tracks.forEach((t, n) => {
    const used = n === 0 || t.name || t.fx.some(Boolean) || project.channels.some((c) => c.mixer === n);
    if (!used) return;
    const group = `Mixer: ${trackName(project, n)}`;
    for (const d of TRACK_BUILTIN) out.push({ group, label: d.name, addr: `mx:${n}:${d.id}`, def: d });
    t.fx.forEach((s, i) => {
      if (!s) return;
      const g = `${group} / ${i + 1}: ${effectMeta(s.type).name}`;
      out.push({ group: g, label: 'Wet / dry mix', addr: `mx:${n}:fx:${i}:mix` }, { group: g, label: 'Enabled', addr: `mx:${n}:fx:${i}:on` });
      for (const d of effectSchema(s.type) || []) out.push({ group: g, label: d.name, addr: `mx:${n}:fx:${i}:p:${d.id}`, def: d });
    });
  });
  for (const d of MASTER_BUILTIN) out.push({ group: 'Master', label: d.name, addr: `master:${d.id}`, def: d });
  for (const d of TRANSPORT_BUILTIN) out.push({ group: 'Project', label: d.name, addr: `transport:${d.id}`, def: d });
  return out;
}

export function pickParam(app, { title = 'Choose a parameter', current = null } = {}) {
  return new Promise((resolve) => {
    const all = listParams(app.store.project);
    const groups = [...new Set(all.map((p) => p.group))];
    const cur = current ? all.find((p) => p.addr === current) : null;
    const gSel = h('select.select', { style: { width: '100%' }, size: 9 }, groups.map((g) => h('option', { value: g }, g)));
    const pSel = h('select.select', { style: { width: '100%' }, size: 9 });
    const fill = () => {
      pSel.textContent = '';
      for (const p of all.filter((x) => x.group === gSel.value)) pSel.append(h('option', { value: p.addr }, p.label));
      if (pSel.options.length) pSel.selectedIndex = 0;
    };
    gSel.addEventListener('change', fill);
    gSel.value = cur ? cur.group : groups[0];
    fill();
    if (cur) pSel.value = cur.addr;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const ok = () => { if (pSel.value) finish(pSel.value); else return false; };
    pSel.addEventListener('dblclick', () => { finish(pSel.value); m.close(); });
    const m = modal({
      title, width: 560,
      body: h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
        h('div', h('div.dim', 'Where'), gSel), h('div', h('div.dim', 'Parameter'), pSel)),
      buttons: [{ label: 'Cancel', fn: () => { finish(null); } }, { label: 'Choose', primary: true, fn: ok }],
      onClose: () => finish(null),
    });
  });
}
