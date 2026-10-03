// Fine-grained changes of JSON values, for shared sessions (app/collab.js). diffOps(a, b) lists what turns a into b:
//   { p: [...], v }         set the value at p (keys, indexes, or { id } selecting an item of an id-keyed array)
//   { p: [...], del: true } remove the key at p
//   { p: [...], rm: id }    remove the item with this id from the array at p
//   { p: [...], add: item, after: id | null }   insert (or replace) an item of the array at p, after the item `after`
//   { p: [...], order: [ids] }                  the order of the items of the array at p
// Arrays whose items all have an id (channels, notes, clips, markers…) are compared item by item, so two people who
// add, change or remove different items at the same time both keep their work; anything else is replaced as a whole.
// applyOps(root, ops) applies them where they still fit (an item someone else removed is skipped) and returns the root.

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const hasId = (x) => isObj(x) && (typeof x.id === 'number' || typeof x.id === 'string');
const idArray = (x) => Array.isArray(x) && x.every(hasId);
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function diffOps(a, b, skip = null, at = [], ops = []) {
  if (a === b) return ops;
  if (Array.isArray(a) && Array.isArray(b) && idArray(a) && idArray(b) && (a.length || b.length)) {
    const am = new Map(a.map((x) => [x.id, x])), bm = new Map(b.map((x) => [x.id, x]));
    for (const x of a) if (!bm.has(x.id)) ops.push({ p: at, rm: x.id });
    let prev = null;
    for (const y of b) {
      const x = am.get(y.id);
      if (!x) ops.push({ p: at, add: y, after: prev });
      else diffOps(x, y, skip, [...at, { id: y.id }], ops);
      prev = y.id;
    }
    const common = b.filter((y) => am.has(y.id)).map((y) => y.id);
    const before = a.filter((x) => bm.has(x.id)).map((x) => x.id);
    if (common.some((id, i) => id !== before[i])) ops.push({ p: at, order: b.map((y) => y.id) });
    return ops;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) if (!(k in b) && !(skip && skip([...at, k]))) ops.push({ p: [...at, k], del: true });
    for (const k of Object.keys(b)) if (!(skip && skip([...at, k]))) diffOps(a[k], b[k], skip, [...at, k], ops);
    return ops;
  }
  if (!same(a, b)) ops.push({ p: at, v: b });
  return ops;
}

// the container at p (all steps but the last), or undefined when it no longer exists
function resolve(root, p, upto) {
  let o = root;
  for (let i = 0; i < upto; i++) {
    const k = p[i];
    if (o == null || typeof o !== 'object') return undefined;
    if (isObj(k)) { if (!Array.isArray(o)) return undefined; o = o.find((x) => hasId(x) && x.id === k.id); }
    else o = o[k];
  }
  return o;
}

const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function applyOps(root, ops) {
  for (const op of ops) {
    const p = op.p || [];
    if ('v' in op && !p.length) { root = copy(op.v); continue; }
    if ('rm' in op || 'add' in op || 'order' in op) {
      const arr = resolve(root, p, p.length);
      if (!Array.isArray(arr)) continue;
      if ('rm' in op) { const i = arr.findIndex((x) => hasId(x) && x.id === op.rm); if (i >= 0) arr.splice(i, 1); }
      else if ('add' in op) {
        const item = copy(op.add), i = arr.findIndex((x) => hasId(x) && x.id === item.id);
        if (i >= 0) { arr[i] = item; continue; }
        const j = op.after == null ? -1 : arr.findIndex((x) => hasId(x) && x.id === op.after);
        arr.splice(j + 1, 0, item);
      } else {
        const pos = new Map(op.order.map((id, i) => [id, i]));
        const known = arr.filter((x) => hasId(x) && pos.has(x.id)).sort((x, y) => pos.get(x.id) - pos.get(y.id));
        const rest = arr.filter((x) => !(hasId(x) && pos.has(x.id)));
        arr.splice(0, arr.length, ...known, ...rest);
      }
      continue;
    }
    const parent = resolve(root, p, p.length - 1), k = p[p.length - 1];
    if (parent == null || typeof parent !== 'object') continue;
    if (isObj(k)) {                                                     // an item as a whole
      if (!Array.isArray(parent)) continue;
      const i = parent.findIndex((x) => hasId(x) && x.id === k.id);
      if (op.del) { if (i >= 0) parent.splice(i, 1); } else if (i >= 0) parent[i] = copy(op.v);
      continue;
    }
    if (op.del) { if (Array.isArray(parent)) parent[k] = null; else delete parent[k]; }
    else parent[k] = copy(op.v);
  }
  return root;
}
