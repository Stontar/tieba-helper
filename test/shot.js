// Screenshot helper: node shot.js <cdpPort> <localPort> <out.png> [withScript=1]
const fs = require('fs');
const path = require('path');
const http = require('http');

const CDP_PORT = parseInt(process.argv[2] || '9350', 10);
const LOCAL_PORT = parseInt(process.argv[3] || '8088', 10);
const OUT = process.argv[4] || path.join(__dirname, 'shot.png');
const WITH_SCRIPT = (process.argv[5] || '1') !== '0';
const usCode = fs.readFileSync(path.join(__dirname, '..', 'tieba-helper.user.js'), 'utf8');

const httpJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (r) => {
    let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
class S {
  constructor(u) {
    this.seq = 0; this.p = new Map();
    this.ws = new WebSocket(u);
    this.ready = new Promise((r, j) => { this.ws.addEventListener('open', r); this.ws.addEventListener('error', j); });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.p.has(m.id)) { const q = this.p.get(m.id); this.p.delete(m.id); m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result); }
    });
  }
  send(m, p = {}) { const id = ++this.seq; return new Promise((r, j) => { this.p.set(id, { resolve: r, reject: j }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = await httpJson('/json/list');
  const t = list.find((x) => x.type === 'page');
  const s = new S(t.webSocketDebuggerUrl);
  await s.ready;
  await s.send('Page.enable');
  await s.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1200, deviceScaleFactor: 1, mobile: false });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__TBHELPER_TEST__=1;' });
  if (WITH_SCRIPT) await s.send('Page.addScriptToEvaluateOnNewDocument', { source: usCode });
  await s.send('Page.navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/p/123456` });
  await sleep(2500);
  if (process.argv[6] === 'page2') {
    await s.send('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('.tbhelper-lzl-pager .tbhelper-lzl-pg')].filter(n => n.textContent === '2').forEach(n => n.click())`,
    });
    await sleep(600);
  }
  const shot = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('saved ' + OUT);
  process.exit(0);
})().catch((e) => { console.error('SHOT FAIL', e.message); process.exit(2); });
