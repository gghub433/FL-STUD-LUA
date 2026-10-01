// Minimal ZIP: writer (stored, no compression: audio does not compress and projects are small) and a reader
// that handles stored entries synchronously and deflated ones through DecompressionStream when available.
const enc = new TextEncoder(), dec = new TextDecoder();

let table = null;
export function crc32(d, crc = 0) {
  if (!table) { table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } }
  let c = ~crc >>> 0;
  for (let i = 0; i < d.length; i++) c = table[(c ^ d[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosTime(date) { return [((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff, (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff]; }

// entries: [{ name, data: Uint8Array }] -> Uint8Array
export function zipStore(entries, date = new Date()) {
  const [t, dd] = dosTime(date);
  const parts = [], central = [];
  let offset = 0;
  const u16 = (n) => [n & 255, (n >> 8) & 255], u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  for (const e of entries) {
    const name = enc.encode(e.name), crc = crc32(e.data), size = e.data.length;
    const local = Uint8Array.from([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(t), ...u16(dd), ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...name]);
    parts.push(local, e.data);
    central.push(Uint8Array.from([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(t), ...u16(dd), ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name]));
    offset += local.length + size;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = Uint8Array.from([0x50, 0x4b, 5, 6, 0, 0, 0, 0, ...u16(entries.length), ...u16(entries.length), ...u32(cdSize), ...u32(offset), 0, 0]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let o = 0; for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}

// -> [{ name, data }] ; verifies CRCs
export async function unzip(bytes) {
  const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let e = d.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Not a ZIP file');
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Broken ZIP directory');
    const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const name = dec.decode(d.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    const lnlen = dv.getUint16(lho + 26, true), lxlen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lxlen;
    let data = d.subarray(start, start + csize);
    if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This ZIP uses compression the browser cannot unpack');
      const ds = new DecompressionStream('deflate-raw');
      data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer());
    } else if (method !== 0) throw new Error(`Unsupported ZIP method ${method}`);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch in ${name}`);
    if (!name.endsWith('/')) out.push({ name, data: data.slice() });
  }
  return out;
}
