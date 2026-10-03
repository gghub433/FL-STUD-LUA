// Interface language. The app is written in English; another language is a dictionary of exact phrases (and a few
// patterns for messages with numbers in them). A MutationObserver translates text and tooltips as they appear, so
// every window, menu, dialog and toast is covered without touching the code that builds them. Switching back restores
// the original English text.
const ATTRS = ['title', 'placeholder', 'aria-label'];
let dict = null, patterns = [], observer = null, current = 'en';
const originals = new WeakMap();           // text node -> English text
const attrOriginals = new WeakMap();       // element -> { attr: English }

export const LANGS = [['en', 'English'], ['ru', 'Русский']];
export const lang = () => current;

function translate(s) {
  if (!dict || !s) return null;
  const t = s.trim();
  if (!t || t.length > 600) return null;
  let r = dict.get(t);
  if (r === undefined) {
    for (const [re, fn] of patterns) {
      const m = re.exec(t);
      if (!m) continue;
      r = typeof fn === 'function' ? fn(m, (x) => translate(x) ?? x) : t.replace(re, fn);
      if (r !== null && r !== undefined) break;
    }
  }
  if (r === undefined || r === null) return null;
  return s === t ? r : s.replace(t, r);
}

function doText(node) {
  const v = node.nodeValue;
  if (!v || !/[A-Za-z]/.test(v)) return;
  const p = node.parentNode;
  if (p && (p.nodeName === 'SCRIPT' || p.nodeName === 'STYLE' || p.nodeName === 'TEXTAREA' || (p.closest && p.closest('[data-no-i18n]')))) return;
  const r = translate(v);
  if (r !== null && r !== v) { originals.set(node, v); node.nodeValue = r; }
}

function doAttrs(el) {
  for (const a of ATTRS) {
    const v = el.getAttribute && el.getAttribute(a);
    if (!v || !/[A-Za-z]/.test(v)) continue;
    const r = translate(v);
    if (r !== null && r !== v) {
      const o = attrOriginals.get(el) || {};
      o[a] = v; attrOriginals.set(el, o);
      el.setAttribute(a, r);
    }
  }
}

function walk(root) {
  if (root.nodeType === 3) { doText(root); return; }
  if (root.nodeType !== 1) return;
  doAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n;
  while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
}

function restore(root) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n;
  while ((n = w.nextNode())) {
    if (n.nodeType === 3) { const o = originals.get(n); if (o !== undefined) { n.nodeValue = o; originals.delete(n); } }
    else { const o = attrOriginals.get(n); if (o) { for (const [a, v] of Object.entries(o)) n.setAttribute(a, v); attrOriginals.delete(n); } }
  }
}

// translate a string from code (e.g. text drawn on a canvas, hints shown elsewhere)
export const t = (s) => translate(s) ?? s;

export async function setLang(code) {
  if (code === current && (code === 'en' || dict)) return;
  if (observer) { observer.disconnect(); observer = null; }
  if (current !== 'en') restore(document.body);
  current = code;
  document.documentElement.lang = code;
  if (code === 'en') { dict = null; patterns = []; return; }
  const mod = await import(`./i18n-${code}.js`);
  dict = new Map(Object.entries(mod.default));
  patterns = mod.patterns || [];
  walk(document.body);
  observer = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') doAttrs(m.target);
      else for (const n of m.addedNodes) walk(n);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
