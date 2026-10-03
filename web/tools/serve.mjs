// Zero-dependency static server for development: `npm start` -> http://localhost:8080
// AudioWorklet needs a secure context; http://localhost qualifies.
// It also carries the collaboration hub (desktop/collab-hub.js) on /collab: a page on this computer can host a
// session (TOOLS > Collaboration), FL LUA on other computers joins it with this computer's address and the code.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { createHub } = createRequire(import.meta.url)('../desktop/collab-hub.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.wav': 'audio/wav', '.ico': 'image/x-icon', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

export function createServer(dir = root) {
  const hub = createHub();
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  server.on('upgrade', (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head, { allowHost: true })) socket.destroy(); });
  server.hub = hub;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 8080;
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : root;      // `node tools/serve.mjs dist` serves the production build
  createServer(dir).listen(port, () => console.log(`FL LUA: http://localhost:${port}/ (${dir})`));
}
