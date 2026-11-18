// v0.2 verification: run the whole suite + exercise the new compact capture.
const fs = require('fs');
const path = require('path');
const http = require('http');

const CDP_PORT = parseInt(process.argv[2] || '9370', 10);
const LOCAL_PORT = parseInt(process.argv[3] || '80', 10);
const usCode = fs.readFileSync(path.join(__dirname, '..', 'tieba-helper.user.js'), 'utf8');
let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + String(JSON.stringify(detail)).slice(0, 400) : ''));
  ok ? pass++ : fail++;
}
const httpJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (r) => {
    let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
class S {
  constructor(u) {
    this.seq = 0; this.p = new Map(); this.h = [];
    this.ws = new WebSocket(u);
    this.ready = new Promise((r, j) => { this.ws.addEventListener('open', r); this.ws.addEventListener('error', j); });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.p.has(m.id)) { const q = this.p.get(m.id); this.p.delete(m.id); m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result); }
      else if (m.method) this.h.forEach((f) => f(m));
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
  const errs = [];
  s.h.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  });
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__TBHELPER_TEST__=1;' });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: usCode });

  const ev = async (expr) => {
    const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };

  // 帖页
  await s.send('Page.navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/p/123456` });
  await sleep(2500);

  // 打开面板并点「捕获本页」（精简模式）
  const capture = await ev(`(async () => {
    const dockBtn = document.querySelector('#tbhelper-dock .tbhelper-dock-btn');
    dockBtn.click();
    const mi = [...document.querySelectorAll('#tbhelper-menu .tbhelper-mi')].find(n => /诊断/.test(n.textContent));
    mi.click();
    await new Promise(r => setTimeout(r, 200));
    const btn = [...document.querySelectorAll('#tbhelper-panel button')].find(b => b.textContent === '捕获本页');
    btn.click();
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 200));
      const st = document.querySelector('.tbhelper-panel-status').textContent;
      if (/KB|失败/.test(st)) return { status: st };
    }
    return { status: 'timeout' };
  })()`);
  check('v0.2 精简捕获完成', /KB/.test(capture.status), capture.status);

  const bundle = await ev(`(async () => {
    // 直接调用面板里保存的文本（capturePage 的产物）
    return document.querySelector('#tbhelper-panel').__last || null;
  })()`);
  check('捕获结果已存入面板', !!bundle, bundle ? bundle.length + ' chars' : null);
  if (bundle) {
    let json = null;
    try { json = JSON.parse(bundle); } catch (e) { /* ignore */ }
    check('输出是合法 JSON', !!json);
    if (json) {
      check('模式为 compact', json.mode === 'compact', json.mode);
      check('包含帖子主体 HTML', typeof json.html === 'string' && json.html.includes('data-cs='), (json.html || '').length);
      check('HTML 里有楼中楼文本', /回复/.test(json.html || ''));
      check('体积在可粘贴范围', typeof json.htmlSize === 'number' && json.htmlSize > 100 && json.htmlSize < 400000, json.htmlSize);
    }
  }

  check('无运行时异常', errs.length === 0, errs);
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('RUNNER FAIL', e.message); process.exit(2); });
