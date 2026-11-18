// Test runner: loads the userscript into a mock Tieba page (spoofed Host) via CDP, checks features.
const fs = require('fs');
const path = require('path');
const http = require('http');

const CDP_PORT = parseInt(process.argv[2] || '9340', 10);
const LOCAL_PORT = parseInt(process.argv[3] || '8088', 10);
const SCRIPT = path.join(__dirname, '..', 'tieba-helper.user.js');
const usCode = fs.readFileSync(SCRIPT, 'utf8');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 300) : ''));
}

function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(b.slice(0, 200))); } });
    }).on('error', reject);
  });
}

class Session {
  constructor(wsUrl) {
    this.seq = 0; this.pending = new Map(); this.listeners = [];
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws error')));
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method) this.listeners.forEach((f) => f(m));
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function navigate(s, url) {
  await s.send('Page.navigate', { url });
  await sleep(1200);
}

async function evalJs(s, expression) {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
}

(async () => {
  const targets = await httpJson('/json/list');
  const page = targets.find((t) => t.type === 'page');
  const s = new Session(page.webSocketDebuggerUrl);
  await s.ready;

  const consoleErrors = [];
  s.listeners.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 300));
    }
  });

  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__TBHELPER_TEST__=1;' });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: usCode });

  const base = 'http://127.0.0.1:' + LOCAL_PORT;

  /* ------------------------- 吧页测试 ------------------------- */
  consoleErrors.length = 0;
  await navigate(s, base + '/f?kw=test');
  await sleep(1500);

  const forumState = await evalJs(s, `(() => {
    const sortbar = document.getElementById('sortbar');
    const active = sortbar.querySelector('.tab-item.active');
    return {
      href: location.href,
      activeSort: active ? active.dataset.sort : null,
      clicks: window.__clicks || [],
      injectedFlag: !!document.documentElement.dataset.tbhelperBoot,
      tabs: document.querySelectorAll('#tbhelper-tabs .tbhelper-tab').length,
      tabTexts: [...document.querySelectorAll('#tbhelper-tabs .tbhelper-tab')].map(a => a.textContent),
      dock: !!document.getElementById('tbhelper-dock'),
      lzlStyle: !!document.getElementById('tbhelper-lzl-style'),
    };
  })()`);
  check('forum: 默认从热门切到最新', forumState.activeSort === 'new' && forumState.clicks.includes('new'), forumState);
  check('forum: 标签栏已注入且包含多个入口', forumState.tabs >= 3, forumState.tabTexts);
  check('forum: 设置浮标存在', forumState.dock);
  check('forum: 楼中楼样式已注入', forumState.lzlStyle);

  /* ------------------------- 帖子页测试 ------------------------- */
  await navigate(s, base + '/p/123456');
  await sleep(1500);

  const threadState = await evalJs(s, `(() => {
    return {
      href: location.href,
      jumpBox: !!document.getElementById('tbhelper-jump'),
      floorsOnPage: [...document.querySelectorAll('[data-floor]')].map(n => n.dataset.floor),
      lzlStyle: !!document.getElementById('tbhelper-lzl-style'),
    };
  })()`);
  check('thread: 已移除楼层跳转框', threadState.jumpBox === false, threadState);

  /* ---------------- 帖子页默认排序：热门 → 正序 ---------------- */
  const sortState = await evalJs(s, `(() => {
    const active = document.querySelector('.sub-tab-container .sub-tab-item-active');
    return { active: active ? active.textContent.trim() : null, clicks: window.__sortClicks || [] };
  })()`);
  check('thread: 默认排序从热门切到正序', sortState.active === '正序' && sortState.clicks.includes('正序'), sortState);

  /* ---------------- 楼中楼分页（旧版贴吧那种页码） ---------------- */
  const SNAP = `(() => {
    const wrap = document.querySelector('.lzl-wrapper');
    const items = [...wrap.children].filter(n => n.classList.contains('pb-lzl-item'));
    const pager = wrap.querySelector('.tbhelper-lzl-pager');
    const pgs = pager ? [...pager.querySelectorAll('.tbhelper-lzl-pg')] : [];
    const active = pgs.find(n => n.classList.contains('active'));
    const prev = pgs.find(n => n.textContent.indexOf('上一页') >= 0);
    const next = pgs.find(n => n.textContent.indexOf('下一页') >= 0);
    const more = wrap.querySelector('.show-more-lzl');
    const sib = document.querySelector('.show-more-lzl[data-sib]');
    return {
      total: items.length,
      visible: items.filter(n => getComputedStyle(n).display !== 'none').length,
      pages: pgs.map(n => n.textContent),
      active: active ? active.textContent : null,
      prevDisabled: prev ? prev.classList.contains('disabled') : null,
      nextDisabled: next ? next.classList.contains('disabled') : null,
      info: pager ? (pager.querySelector('.tbhelper-lzl-pg-info') || {}).textContent : null,
      moreVisible: more ? getComputedStyle(more).display !== 'none' : null,
      sibVisible: sib ? getComputedStyle(sib).display !== 'none' : null,
    };
  })()`;

  const clickPager = (label) => evalJs(s, `(async () => {
    const pager = document.querySelector('.tbhelper-lzl-pager');
    const btn = [...pager.querySelectorAll('.tbhelper-lzl-pg')].find(n => n.textContent === ${JSON.stringify(label)});
    if (!btn) return { error: 'no button ' + ${JSON.stringify(label)} };
    btn.click();
    await new Promise(r => setTimeout(r, 250));
    return true;
  })()`);

  const p1 = await evalJs(s, SNAP);
  check('分页: 12 条默认只显示第 1 页（10 条）', p1.total === 12 && p1.visible === 10, p1);
  check('分页: 页码是 1 / 2 且第 1 页高亮', p1.pages.join('|') === '‹ 上一页|1|2|下一页 ›' && p1.active === '1', p1.pages);
  check('分页: 显示已加载条数', /已加载 12 条/.test(p1.info || ''), p1.info);
  check('分页: 第 1 页「上一页」不可点', p1.prevDisabled === true && p1.nextDisabled === false, p1);
  check('分页: 分页接管后隐藏站点「展开更多回复」', p1.moreVisible === false && p1.sibVisible === false, p1);

  await clickPager('2');
  const p2 = await evalJs(s, SNAP);
  check('分页: 点页码 2 后只显示第 2 页的 2 条', p2.visible === 2 && p2.active === '2', p2);
  check('分页: 后面还有没加载的，「下一页」仍可点', p2.nextDisabled === false, p2);

  await clickPager('‹ 上一页');
  const p1b = await evalJs(s, SNAP);
  check('分页: 「上一页」能回到第 1 页', p1b.visible === 10 && p1b.active === '1', p1b);

  await clickPager('下一页 ›');
  const p2b = await evalJs(s, SNAP);
  check('分页: 「下一页」能到第 2 页', p2b.visible === 2 && p2b.active === '2', p2b);

  // 关键：当前页没装满时点「下一页」，应该自动加载后「留在本页把它填满」，
  // 而不是直接跳到第 3 页、把从没显示过的那几条跳过去
  await evalJs(s, `(async () => {
    const pager = document.querySelector('.tbhelper-lzl-pager');
    const btn = [...pager.querySelectorAll('.tbhelper-lzl-pg')].find(n => n.textContent === '下一页 ›');
    btn.click();
    await new Promise(r => setTimeout(r, 1800));
    return true;
  })()`);
  const pAuto = await evalJs(s, SNAP);
  check('分页: 末页点「下一页」会自动加载下一批', pAuto.total === 22, pAuto);
  check('分页: 加载后留在原页把这一页填满（不跳过中间内容）', pAuto.active === '2' && pAuto.visible === 10, pAuto);
  check('分页: 加载完后条数更新为共 22 条', /共 22 条/.test(pAuto.info || ''), pAuto.info);

  // 再点一次「下一页」，这时第 2 页已经装满，才会真的翻到第 3 页
  await evalJs(s, `(async () => {
    const pager = document.querySelector('.tbhelper-lzl-pager');
    const btn = [...pager.querySelectorAll('.tbhelper-lzl-pg')].find(n => n.textContent === '下一页 ›');
    btn.click();
    await new Promise(r => setTimeout(r, 600));
    return true;
  })()`);
  const p3 = await evalJs(s, SNAP);
  check('分页: 第 2 页装满后「下一页」才翻到第 3 页', p3.active === '3' && p3.visible === 2, p3);
  check('分页: 没有更多时「下一页」禁用', p3.nextDisabled === true, p3);

  /* ------------- 虚拟列表重建 wrapper 后，页码要保住 ------------- */
  const remount = await evalJs(s, `(async () => {
    const wrap = document.querySelector('.lzl-wrapper');
    // 模拟站点重渲染：造一个「干净」的新 wrapper（去掉插件加的类/页码条），再替换旧的
    const copy = wrap.cloneNode(true);
    copy.querySelectorAll('.tbhelper-lzl-pager').forEach(n => n.remove());
    copy.querySelectorAll('.tbhelper-lzl-hidden, .tbhelper-lzl-site-more-hidden')
      .forEach(n => n.classList.remove('tbhelper-lzl-hidden', 'tbhelper-lzl-site-more-hidden'));
    wrap.replaceWith(copy);
    await new Promise(r => setTimeout(r, 500));
    const items = [...copy.children].filter(n => n.classList.contains('pb-lzl-item'));
    const pager = copy.querySelector('.tbhelper-lzl-pager');
    const active = pager ? pager.querySelector('.tbhelper-lzl-pg.active') : null;
    return {
      visible: items.filter(n => getComputedStyle(n).display !== 'none').length,
      active: active ? active.textContent : null,
      hidden: items.filter(n => n.classList.contains('tbhelper-lzl-hidden')).length,
    };
  })()`);
  check('楼中楼: 站点重建 wrapper 后仍停在第 3 页', remount.active === '3' && remount.visible === 2 && remount.hidden === 20, remount);

  /* ------------- 滚动时不抖动：DOM 稳定后不应再被反复改写 ------------- */
  const flicker = await evalJs(s, `(async () => {
    const wrap = document.querySelector('.lzl-wrapper');
    let count = 0;
    const obs = new MutationObserver((recs) => { count += recs.length; });
    obs.observe(wrap, { childList: true, subtree: true, attributes: true, characterData: true });
    await new Promise(r => setTimeout(r, 1600));
    const idle = count;
    // 故意点一下页码，确认观察器真的能数到变化（否则「0 变化」没有说服力）
    const btn = [...wrap.querySelectorAll('.tbhelper-lzl-pg')].find(n => n.textContent === '1');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 400));
    obs.disconnect();
    return { idle, afterClick: count - idle };
  })()`);
  check('楼中楼: 稳定后不再反复改写 DOM（防闪烁）', flicker.idle === 0, flicker);
  check('楼中楼: 观察器确实能检测到改动（用例有效）', flicker.afterClick > 0, flicker);

  /* ------------- 翻页后视角跟随到新一页的第一条回复 ------------- */
  const focus = await evalJs(s, `(async () => {
    // 先把页码条滚进视口（模拟「看完这一页、站在页码条上」）
    const pager = document.querySelector('.tbhelper-lzl-pager');
    pager.scrollIntoView({ block: 'center' });
    await new Promise(r => setTimeout(r, 300));
    // 翻到只有 2 条的第 3 页：块会突然变矮，不跟随视角就会看到下面的楼层
    const btn = [...pager.querySelectorAll('.tbhelper-lzl-pg')].find(n => n.textContent === '3');
    if (!btn) return { error: 'no page 3' };
    btn.click();
    await new Promise(r => setTimeout(r, 700));
    const wrap = document.querySelector('.lzl-wrapper');
    const items = [...wrap.children].filter(n => n.classList.contains('pb-lzl-item'));
    const visible = items.filter(n => getComputedStyle(n).display !== 'none');
    const first = visible[0];
    if (!first) return { error: 'no visible item' };
    const r = first.getBoundingClientRect();
    return {
      visible: visible.length,
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      vh: window.innerHeight,
      text: first.textContent.trim().slice(0, 30),
    };
  })()`);
  check('分页: 翻到更短的一页后，新一页第一条在视口内', focus.visible === 2 && focus.top >= 0 && focus.bottom <= focus.vh, focus);

  // 设置下拉：不分页 / 改回 10 条
  const setLimit = (v) => evalJs(s, `(async () => {
    const sel = document.querySelector('#tbhelper-menu select.tbhelper-limit');
    if (!sel) return { error: 'no select' };
    sel.value = ${JSON.stringify(v)};
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 300));
    return true;
  })()`);

  await setLimit('0');
  const pAll = await evalJs(s, SNAP);
  check('分页: 选「不分页」时 22 条全展开且没有页码', pAll.visible === 22 && pAll.pages.length === 0, pAll);

  await setLimit('10');
  const pBack = await evalJs(s, SNAP);
  check('分页: 改回 10 条/页后重新分页', pBack.visible === 10 && pBack.active === '1', pBack);

  /* ------------- 楼中楼样式测试（核心：只动楼中楼，不动主楼/楼层） ------------- */
  const lzlComputed = await evalJs(s, `(() => {
    const px = (n) => n ? getComputedStyle(n).width : null;
    const lzlAv = document.querySelector('.pb-lzl-item a.avatar img.avatar-img');
    const lzlBox = document.querySelector('.pb-lzl-item .left-box');
    const floorAv = document.querySelector('.pb-comment-item > .head-line a.avatar img.avatar-img');
    const mainAv = document.querySelector('.image-text .head-line a.avatar img.avatar-img');
    const boxAv = document.querySelector('.avatar-box img.avatar-img');
    const wrap = document.querySelector('.lzl-wrapper');
    const content = document.querySelector('.pb-lzl-item .comment-content');
    const textEl = document.querySelector('.pb-lzl-item .pb-text-wrapper.text');
    const desc = document.querySelector('.pb-lzl-item .pc-pb-comments-desc');
    return {
      lzlW: px(lzlAv), lzlBoxW: px(lzlBox),
      floorW: px(floorAv), mainW: px(mainAv), boxW: px(boxAv),
      lzlBorder: wrap ? getComputedStyle(wrap).borderLeftWidth : null,
      lzlContentMarginLeft: content ? getComputedStyle(content).marginLeft : null,
      textLineHeight: textEl ? getComputedStyle(textEl).lineHeight : null,
      descMarginTop: desc ? getComputedStyle(desc).marginTop : null,
      itemHeight: (() => { const n = document.querySelector('.pb-lzl-item'); return n ? Math.round(n.getBoundingClientRect().height) : null; })(),
    };
  })()`);
  check('lzl: 楼中楼头像缩到 16px', lzlComputed && lzlComputed.lzlW === '16px' && lzlComputed.lzlBoxW === '16px', lzlComputed);
  check('lzl: 楼层回复头像保持 40px', lzlComputed && lzlComputed.floorW === '40px', lzlComputed);
  check('lzl: 主楼头像保持 40px', lzlComputed && lzlComputed.mainW === '40px', lzlComputed);
  check('lzl: 回复框头像保持 40px', lzlComputed && lzlComputed.boxW === '40px', lzlComputed);
  check('lzl: 楼中楼有左侧竖线做区分', lzlComputed && parseFloat(lzlComputed.lzlBorder) >= 2, lzlComputed);
  check('lzl: 楼中楼正文缩进收紧', lzlComputed && lzlComputed.lzlContentMarginLeft === '21px', lzlComputed);
  check('lzl: 正文行高压到 17px', lzlComputed && lzlComputed.textLineHeight === '17px', lzlComputed);
  check('lzl: 日期行紧贴正文', lzlComputed && lzlComputed.descMarginTop === '1px', lzlComputed);
  check('lzl: 单条楼中楼高度 ≤ 60px', lzlComputed && lzlComputed.itemHeight !== null && lzlComputed.itemHeight <= 60, lzlComputed && lzlComputed.itemHeight);

  /* ------------------------- 诊断捕获测试 ------------------------- */
  const diagResult = await evalJs(s, `(async () => {
    const btn = [...document.querySelectorAll('#tbhelper-panel button')].find(b => b.textContent === '捕获本页');
    if (!btn) { document.getElementById('tbhelper-dock').querySelector('button').click(); }
    const mi = [...document.querySelectorAll('#tbhelper-menu .tbhelper-mi')].find(n => /诊断/.test(n.textContent));
    if (mi) mi.click();
    const capBtn = [...document.querySelectorAll('#tbhelper-panel button')].find(b => b.textContent === '捕获本页');
    if (!capBtn) return { error: 'panel not found' };
    capBtn.click();
    await new Promise(r => setTimeout(r, 3000));
    const status = document.querySelector('.tbhelper-panel-status').textContent;
    return { status };
  })()`);
  check('diag: 捕获流程可执行', diagResult && !diagResult.error && /KB|失败/.test(diagResult.status || ''), diagResult);

  /* ------------------------- 控制台错误检查 ------------------------- */
  check('无脚本运行时异常', consoleErrors.length === 0, consoleErrors);

  console.log('\n==== SUMMARY ====');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('RUNNER FAIL', e.message);
  process.exit(2);
});
