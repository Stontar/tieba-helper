// Mock server: serves /f -> forum.html, /p/* -> thread.html, whatever the Host header says.
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = parseInt(process.argv[2] || '8088', 10);
const ROOT = path.join(__dirname);

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let file = null;
  if (u.pathname === '/f' || u.pathname === '/') file = 'forum.html';
  else if (u.pathname.startsWith('/p/')) file = 'thread.html';
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  const body = fs.readFileSync(path.join(ROOT, file));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}).listen(PORT, '127.0.0.1', () => console.log('mock server on ' + PORT));
