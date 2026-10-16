// Sound files on the person's disk ("My sounds" in the Browser): which files count as audio, how a folder listing is
// cleaned and sorted, and the name index the Browser search uses. Pure functions without DOM, shared by the page and
// the unit tests; the desktop main process keeps a copy of the extension list (desktop/sound-folders.js).
export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'flac', 'aif', 'aiff', 'm4a'];
export const AUDIO_ACCEPT = `audio/*,${AUDIO_EXTENSIONS.map((e) => `.${e}`).join(',')}`;
const AUDIO_RE = new RegExp(`\\.(${AUDIO_EXTENSIONS.join('|')})$`, 'i');

// hidden files are skipped: sample packs copied from a Mac are full of "._kick.wav" resource forks
export const isAudioFile = (name) => typeof name === 'string' && name[0] !== '.' && AUDIO_RE.test(name);
// a file dropped from the system: by its extension, or by the type the system gives it
export const isAudioDrop = (f) => !!f && (isAudioFile(f.name) || (/^audio\//.test(f.type || '') && f.name[0] !== '.'));
export const extOf = (name) => { const m = /\.([^./]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; };
export const baseName = (rel) => String(rel).split('/').pop();
export const dirName = (rel) => { const i = String(rel).lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
export const soundName = (rel) => baseName(rel).replace(/\.[^.]+$/, '');
export const joinPath = (rel, name) => (rel ? `${rel}/${name}` : name);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// folders first, then files; "Kick 2" before "Kick 10"
export const compareEntries = (a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : collator.compare(a.name, b.name));

// A raw folder listing [{ name, dir }] -> the rows the Browser shows: visible folders and audio files, sorted.
export function cleanListing(raw, max = 20000) {
  const out = [];
  for (const e of raw || []) {
    if (!e || typeof e.name !== 'string' || !e.name || e.name[0] === '.') continue;
    if (e.dir) out.push({ name: e.name, dir: true });
    else if (isAudioFile(e.name)) out.push({ name: e.name, dir: false });
    if (out.length >= max) break;
  }
  return out.sort(compareEntries);
}

// rows of a folder in pages, so a folder with thousands of files stays quick to draw
export function pageOf(list, limit) {
  const shown = list.slice(0, Math.max(0, limit));
  return { shown, hidden: list.length - shown.length };
}

// Name index over the added folders for the Browser search. It is built on the first search, breadth first (shallow
// files are found first), one folder at a time, and stops at a cap, so a huge library never stalls the page.
//   roots: [{ id, name }]; list(root, rel) -> Promise<[{ name, dir }]> (an error skips that folder)
export class SoundIndex {
  constructor({ maxFiles = 50000, maxFolders = 5000, maxDepth = 12 } = {}) {
    this.maxFiles = maxFiles; this.maxFolders = maxFolders; this.maxDepth = maxDepth;
    this.files = [];          // { root, rel, name, hay }
    this.folders = 0; this.failed = 0;
    this.done = false; this.capped = false; this.cancelled = false;
  }

  cancel() { this.cancelled = true; }

  async build(roots, list, { onProgress = null, every = 25 } = {}) {
    const queue = roots.map((r) => ({ root: r, rel: '', depth: 0 }));
    while (queue.length && !this.cancelled) {
      if (this.folders >= this.maxFolders || this.files.length >= this.maxFiles) { this.capped = true; break; }
      const { root, rel, depth } = queue.shift();
      let entries;
      try { entries = await list(root, rel); } catch (_) { this.failed++; continue; }
      if (this.cancelled) break;
      this.folders++;
      for (const e of entries) {
        const p = joinPath(rel, e.name);
        if (e.dir) { if (depth < this.maxDepth) queue.push({ root, rel: p, depth: depth + 1 }); else this.capped = true; continue; }
        if (this.files.length >= this.maxFiles) { this.capped = true; break; }
        this.files.push({ root: root.id, rel: p, name: e.name, hay: `${root.name}/${p}`.toLowerCase() });
      }
      if (onProgress && this.folders % every === 0) onProgress(this);
    }
    this.done = !this.cancelled;
    if (onProgress) onProgress(this);
    return this;
  }

  // every word of the query must appear in the path (folder names count); files whose own name has every word come first
  search(query, limit = 200) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return { hits: [], total: 0 };
    const named = [], pathOnly = [];
    for (const f of this.files) {
      if (!words.every((w) => f.hay.includes(w))) continue;
      const nm = f.name.toLowerCase();
      (words.every((w) => nm.includes(w)) ? named : pathOnly).push(f);
    }
    const all = named.concat(pathOnly);
    return { hits: all.slice(0, limit), total: all.length };
  }
}
