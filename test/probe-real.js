// Probe: apply the real LZL_CSS to the REAL captured Tieba HTML (refs/diag-real.html)
// and verify it only touches .pb-lzl-item avatars, never the main post / floor replies / reply box.
// usage: node probe-real.js <cdpPort> <diagHtmlPath>
const fs = require('fs');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

const CDP_PORT = parseInt(process.argv[2] || '9350', 10);
const DIAG = process.argv[3] || path.join(__dirname, '..', 'refs', 'diag-real.html');

const us = fs.readFileSync(path.join(__dirname, '..', 'tieba-helper.user.js'), 'utf8');
const m = us.match(/const LZL_CSS = `([\s\S]*?)`;/);
if (!m) { console.error('无法从脚本中提取 LZL_CSS'); process.exit(2); }
const LZL_CSS = m[1];

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
      const msg = JSON.parse(ev.data);
      if (msg.id && this.p.has(msg.id)) { const q = this.p.get(msg.id); this.p.delete(msg.id); msg.error ? q.reject(new Error(JSON.stringify(msg.error))) : q.resolve(msg.result); }
    });
  }
  send(mm, p = {}) { const id = ++this.seq; return new Promise((r, j) => { this.p.set(id, { resolve: r, reject: j }); this.ws.send(JSON.stringify({ id, method: mm, params: p })); }); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + String(JSON.stringify(detail)).slice(0, 500) : ''));
  ok ? pass++ : fail++;
}

(async () => {
  const list = await httpJson('/json/list');
  const t = list.find((x) => x.type === 'page');
  const s = new S(t.webSocketDebuggerUrl);
  await s.ready;
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  const ev = async (expr) => {
    const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };

  await s.send('Page.navigate', { url: pathToFileURL(DIAG).href });
  await sleep(1200);

  const before = await ev(`(() => ({
    items: document.querySelectorAll('.pb-lzl-item').length,
    wrappers: document.querySelectorAll('.lzl-wrapper').length,
  }))()`);

  await ev(`(() => {
    const st = document.createElement('style');
    st.id = 'tbhelper-lzl-style';
    st.textContent = ${JSON.stringify(LZL_CSS)};
    document.head.appendChild(st);
    return true;
  })()`);
  await sleep(400);

  const real = await ev(`(() => {
    const w = (sel) => { const n = document.querySelector(sel); if (!n) return null; return getComputedStyle(n).width; };
    const hAll = (sel) => [...document.querySelectorAll(sel)].map(n => Math.round(n.getBoundingClientRect().height));
    // 统计「被压到 16px 的头像」都属于谁
    const shrunk = [...document.querySelectorAll('img.avatar-img')]
      .filter(n => getComputedStyle(n).width === '16px')
      .map(n => n.closest('.pb-lzl-item') ? 'lzl' : (n.closest('.image-text') ? '主楼' : (n.closest('.avatar-box') ? '回复框' : '楼层')));
    return {
      lzlImg: w('.pb-lzl-item a.avatar img.avatar-img'),
      lzlBox: w('.pb-lzl-item .left-box'),
      mainImg: w('.image-text .head-line a.avatar img.avatar-img'),
      mainBox: w('.image-text .head-line .left-box'),
      floorImg: w('.pb-comment-item > .head-line a.avatar img.avatar-img'),
      floorBox: w('.pb-comment-item > .head-line .left-box'),
      boxImg: w('.avatar-box img.avatar-img'),
      lzlItemHeights: hAll('.pb-lzl-item'),
      wrapperBorder: (() => { const n = document.querySelector('.lzl-wrapper'); return n ? getComputedStyle(n).borderLeftWidth : null; })(),
      showMoreInWrapper: document.querySelectorAll('.lzl-wrapper .show-more-lzl').length,
      wrappers: document.querySelectorAll('.lzl-wrapper').length,
      pbLzlDirectChild: (() => {
        const w = document.querySelector('.lzl-wrapper');
        return !!w && Array.from(w.children).some((n) => n.classList.contains('pb-lzl-item'));
      })(),
      perWrapper: [...document.querySelectorAll('.lzl-wrapper')].map((w) => w.querySelectorAll(':scope > .pb-lzl-item').length),
      shrunk,
    };
  })()`);

  check('真实 DOM：楼中楼头像被压到 16px', real.lzlImg === '16px' && real.lzlBox === '16px', { lzlImg: real.lzlImg, lzlBox: real.lzlBox });
  check('真实 DOM：主楼头像未被压扁', real.mainImg !== '16px', { mainImg: real.mainImg, mainBox: real.mainBox });
  check('真实 DOM：楼层回复头像未被压扁', real.floorImg !== '16px', { floorImg: real.floorImg, floorBox: real.floorBox });
  check('真实 DOM：回复框头像未被压扁', real.boxImg !== '16px', { boxImg: real.boxImg });
  check('真实 DOM：被压成 16px 的头像全部属于楼中楼', real.shrunk.length > 0 && real.shrunk.every((x) => x === 'lzl'), real.shrunk);
  check('真实 DOM：楼中楼有左侧竖线', parseFloat(real.wrapperBorder) >= 2, real.wrapperBorder);
  check('真实 DOM：页面上确实存在楼中楼容器', before.wrappers > 0 && before.items > 0, before);
  // 分页功能依赖这些结构：.pb-lzl-item 与站点自带的「展开更多回复」都在 .lzl-wrapper 里
  check('真实 DOM：.pb-lzl-item 是 .lzl-wrapper 的直接子元素', real.pbLzlDirectChild === true);
  check('真实 DOM：每块楼中楼都能取到条目（可分页）', real.perWrapper.every((n) => n > 0), real.perWrapper);

  // 说明：捕获到的 HTML 不含贴吧自身的样式表，所以这里只能校验「选择器命中了谁」，
  // 具体高度/字号的变化在 test/thread.html（带同款样式）里用 run-tests.js 校验。

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('PROBE FAIL', e.message); process.exit(2); });
