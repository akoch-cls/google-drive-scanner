#!/usr/bin/env node
/**
 * Serves docs/ at http://localhost:8080 (the camera needs localhost or https).
 *
 *   node dev/serve.js          real Google sign-in (add http://localhost:8080 to
 *                              your OAuth client's JavaScript origins)
 *   node dev/serve.js --mock   fake Drive/Classroom, no Google setup needed
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'docs');
const mock = process.argv.includes('--mock');
const port = Number(process.env.PORT) || 8080;
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

http.createServer((req, res) => {
  let file = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (file.endsWith('/')) file += 'index.html';
  let full = path.join(root, path.normalize(file));
  if (mock && file === '/google.js') full = path.join(__dirname, 'mock-api.js');
  if (!full.startsWith(root) && !full.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, () => console.log('Doc Scanner at http://localhost:' + port + (mock ? ' (mock Google APIs)' : '')));
