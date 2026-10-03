// A small interface shared by the example plugins: one control per parameter of the plugin's node.
// A WAM plugin may build its interface with anything (plain DOM here); the host only appends the returned element.
export async function createParamsGui(plugin, accent) {
  const node = plugin.audioNode;
  const info = await node.getParameterInfo();
  const values = await node.getParameterValues(false);
  const root = document.createElement('div');
  root.style.cssText = `font: 12px system-ui, sans-serif; color: #dfe6ea; background: linear-gradient(#2c3238, #22272b); padding: 14px 16px; border-radius: 6px; border: 1px solid #14171a; min-width: 300px;`;
  const title = document.createElement('div');
  title.textContent = plugin.descriptor.name;
  title.style.cssText = `font-weight: 700; letter-spacing: .04em; color: ${accent}; margin-bottom: 10px; text-transform: uppercase;`;
  root.append(title);
  const fmt = (v, p) => (p.units === 's' && v < 1 ? `${Math.round(v * 1000)} ms` : `${Math.abs(v) >= 100 ? Math.round(v) : (+v).toFixed(2)}${p.units ? ` ${p.units}` : ''}`);
  for (const id of Object.keys(info)) {
    const p = info[id], v = values[id] ? values[id].value : p.defaultValue;
    const row = document.createElement('label');
    row.style.cssText = 'display: grid; grid-template-columns: 70px 1fr 64px; gap: 8px; align-items: center; margin: 6px 0;';
    const name = document.createElement('span'); name.textContent = p.label || id;
    const out = document.createElement('span'); out.style.cssText = 'color: #8e989f; text-align: right;';
    let ctl;
    if (p.type === 'choice') {
      ctl = document.createElement('select');
      ctl.style.cssText = 'background: #171a1d; color: #dfe6ea; border: 1px solid #3a4249; border-radius: 3px; padding: 2px 4px; font: inherit;';
      p.choices.forEach((c, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = c; ctl.append(o); });
      ctl.value = String(Math.round(v));
      ctl.onchange = () => node.setParameterValues({ [id]: { id, value: +ctl.value, normalized: false } });
    } else {
      ctl = document.createElement('input');
      ctl.type = 'range'; ctl.min = '0'; ctl.max = '1'; ctl.step = '0.001';
      ctl.value = String(normalized(p, v));
      out.textContent = fmt(v, p);
      ctl.oninput = () => { const x = denormalized(p, +ctl.value); out.textContent = fmt(x, p); node.setParameterValues({ [id]: { id, value: x, normalized: false } }); };
    }
    ctl.style.accentColor = accent;
    ctl.dataset.param = id;
    row.append(name, ctl, out);
    root.append(row);
  }
  return root;
}

// the same curve as WamParameterInfo (exponent bends the slider towards the low end)
const normalized = (p, v) => { const x = (v - p.minValue) / (p.maxValue - p.minValue) || 0; return p.exponent ? x ** (1.5 ** -p.exponent) : x; };
const denormalized = (p, x) => (p.exponent ? x ** (1.5 ** p.exponent) : x) * (p.maxValue - p.minValue) + p.minValue;
