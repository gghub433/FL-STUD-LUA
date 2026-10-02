// Catalogs of downloadable plugin packs. A catalog is a JSON file next to the pack files it lists:
//   { "catalog": 1, "name": "…", "packs": [{ id, name, version, author, license, description, file, sha256, size, plugins:[{kind,name,description}] }] }
// `file` is resolved against the catalog's own address, `sha256` is checked before anything is installed.
// The catalog bundled with the app lives in packs/catalog.json; users can add more (a URL) in the Plugin store.
const LS = 'stepwise.catalogs';
export const BUNDLED_URL = new URL('../../packs/catalog.json', import.meta.url).href;

export const userCatalogs = () => { try { const v = JSON.parse(localStorage.getItem(LS) || '[]'); return Array.isArray(v) ? v.filter((u) => typeof u === 'string') : []; } catch (_) { return []; } };
export const saveUserCatalogs = (list) => { try { localStorage.setItem(LS, JSON.stringify(list)); } catch (_) { /* storage disabled */ } };

export async function fetchCatalog(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const j = await res.json();
  if (!j || !Array.isArray(j.packs)) throw new Error('That is not a plugin catalog');
  const packs = j.packs.filter((p) => p && typeof p.id === 'string' && typeof p.file === 'string' && typeof p.sha256 === 'string')
    .map((p) => ({ ...p, url: new URL(p.file, url).href, plugins: Array.isArray(p.plugins) ? p.plugins : [] }));
  return { url, name: typeof j.name === 'string' ? j.name : url, packs, bundled: url === BUNDLED_URL };
}

export async function fetchPackSource(entry) {
  const res = await fetch(entry.url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  return res.text();
}

// 1 if a is newer than b
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0), pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
}
