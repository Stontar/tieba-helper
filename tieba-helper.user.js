// ==UserScript==
// @name         贴吧网页端助手（新版 UI 增强）
// @name:zh-CN   贴吧网页端助手（新版 UI 增强）
// @namespace    https://github.com/Stontar/tieba-helper
// @version      0.7.3
// @description  新版贴吧网页端增强：吧页默认「最新」、帖子页默认「正序」、页面标签栏、楼中楼头像压缩与分页。可逐项开关，附带结构诊断捕获。
// @description:zh-CN  新版贴吧网页端增强：吧页默认「最新」、帖子页默认「正序」、页面标签栏、楼中楼头像压缩与分页。可逐项开关，附带结构诊断捕获。
// @author       Stontar
// @license      MIT
// @homepageURL  https://github.com/Stontar/tieba-helper
// @supportURL   https://github.com/Stontar/tieba-helper/issues
// @updateURL    https://raw.githubusercontent.com/Stontar/tieba-helper/main/tieba-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/Stontar/tieba-helper/main/tieba-helper.user.js
// @match        https://tieba.baidu.com/*
// @match        https://tiebac.baidu.com/*
// @match        https://www.tieba.com/*
// @match        https://jump2.bdimg.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @run-at       document-start
// @noframes
// ==/UserScript==

/* =========================================================================
 * 发布信息
 *
 * 仓库： https://github.com/Stontar/tieba-helper
 * 直装： https://raw.githubusercontent.com/Stontar/tieba-helper/main/tieba-helper.user.js
 *
 * 更新流程：改完代码把 @version 加一，push 到 main 分支即可，
 * 用户端 Tampermonkey 会按 @updateURL 自动检查并升级。
 * ========================================================================= */

/* =========================================================================
 * 贴吧网页端助手 —— 设计说明
 *
 * 1. 不依赖具体的 class 名做核心功能，而是「按文案找控件 + 实测验证」，
 *    因此对新版贴吧这种前端框架渲染的页面更耐改版。
 * 2. 每一项功能都可单独关闭；右下角 ⚙ 里逐项开关。
 * 3. 「诊断」面板只在需要时用：点「捕获本页」会把当前页面的
 *    主体结构 + 行内计算样式整理成 JSON，并自动复制，便于精确适配。
 * ========================================================================= */

(function () {
    "use strict";

    const HOST = location.hostname;
    const isTiebaHost = /(^|\.)tieba\.baidu\.com$|(^|\.)tiebac\.baidu\.com$|(^|\.)tieba\.com$/.test(HOST);
    // 测试模式：由 test harness 在 document-start 注入 window.__TBHELPER_TEST__
    const isTest = !!window.__TBHELPER_TEST__;
    if (!isTiebaHost && !isTest) return;

    const VERSION = "0.7.2";
    const PREFIX = "tbhelper:";
    const TOAST_MS = 2600;

    /* ------------------------------ 基础工具 ------------------------------ */

    const store = {
        get(key, fallback) {
            try {
                if (typeof GM_getValue === "function") {
                    const v = GM_getValue(PREFIX + key);
                    return v === undefined ? fallback : v;
                }
                const raw = localStorage.getItem(PREFIX + key);
                return raw === null ? fallback : JSON.parse(raw);
            } catch (_) {
                return fallback;
            }
        },
        set(key, value) {
            try {
                if (typeof GM_setValue === "function") return GM_setValue(PREFIX + key, value);
                localStorage.setItem(PREFIX + key, JSON.stringify(value));
            } catch (_) { /* 隐私模式下静默失败 */ }
        },
    };

    const cfg = {
        sort: store.get("sort", true),
        tabs: store.get("tabs", true),
        lzl: store.get("lzl", true),
        lzlFold: store.get("lzlFold", true),
        lzlLimit: store.get("lzlLimit", 10),
    };
    function saveCfg() {
        store.set("sort", cfg.sort);
        store.set("tabs", cfg.tabs);
        store.set("lzl", cfg.lzl);
        store.set("lzlFold", cfg.lzlFold);
        store.set("lzlLimit", cfg.lzlLimit);
    }

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    function el(tag, props, children) {
        const node = document.createElement(tag);
        if (props) {
            for (const [k, v] of Object.entries(props)) {
                if (k === "class") node.className = v;
                else if (k === "text") node.textContent = v;
                else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
                else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
                else if (v !== undefined && v !== null) node.setAttribute(k, String(v));
            }
        }
        (children || []).forEach((c) => {
            if (c == null) return;
            node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
        });
        return node;
    }

    /* 样式注入：@run-at document-start 时 documentElement 可能还不存在，
       先排队，等 DOM 可用再注入，避免「样式丢失」。 */
    const pendingStyles = [];
    function mount(node) {
        const root = document.documentElement;
        if (!root) { pendingStyles.push(node); return false; }
        root.appendChild(node);
        return true;
    }
    function flushPending() {
        if (!document.documentElement) return;
        while (pendingStyles.length) document.documentElement.appendChild(pendingStyles.shift());
    }

    function injectStyle(cssText, id) {
        const style = document.createElement("style");
        style.dataset.tbhelper = "1";
        if (id) style.id = id;
        style.textContent = cssText;
        mount(style);
    }

    let toastTimer = null;
    function toast(text, ms) {
        let box = $("#tbhelper-toast");
        if (!box) {
            box = el("div", { id: "tbhelper-toast" });
            mount(box);
        }
        box.textContent = text;
        box.dataset.show = "1";
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { box.dataset.show = "0"; }, ms || TOAST_MS);
    }

    function isVisible(node) {
        if (!node || !node.isConnected) return false;
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== "hidden";
    }

    /** 轮询等待某个条件成立 */
    function waitFor(fn, timeout = 6000, interval = 200) {
        return new Promise((resolve) => {
            const start = Date.now();
            (function tick() {
                let v = null;
                try { v = fn(); } catch (_) { /* ignore */ }
                if (v) return resolve(v);
                if (Date.now() - start > timeout) return resolve(null);
                setTimeout(tick, interval);
            })();
        });
    }

    function onReady(fn) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", fn, { once: true });
        } else {
            fn();
        }
    }

    /** 监听整页结构变化（新版贴吧是 SPA，路由切换不会刷新页面） */
    function observePage(callback) {
        const obs = new MutationObserver(() => callback());
        obs.observe(document.documentElement, { childList: true, subtree: true });
        let lastHref = location.href;
        const routeObs = new MutationObserver(() => {
            if (location.href !== lastHref) {
                lastHref = location.href;
                callback();
            }
        });
        routeObs.observe(document.documentElement, { subtree: true, childList: true });
        callback();
        return { obs, routeObs };
    }

    /* ---------------------------- 页面类型判断 ---------------------------- */

    const page = {
        isThread() {
            if (/^\/p\/\d+/.test(location.pathname)) return true;
            return !!$("[data-field*='\"post_no\"'], .l_post, .j_p_postlist, [class*='post-list']");
        },
        isForum() {
            if (location.pathname === "/f" || location.pathname.startsWith("/f")) return true;
            return new URLSearchParams(location.search).has("kw");
        },
    };

    /* ------------------------ 通用：按文案找可点击项 ------------------------ */

    const CLICKABLE = "a,button,[role='button'],[role='tab'],li,span,div";

    function clickableAncestor(node, maxDepth = 4) {
        let cur = node;
        for (let i = 0; i < maxDepth && cur && cur !== document.body; i++) {
            if (cur.matches && cur.matches(CLICKABLE) && isVisible(cur)) return cur;
            cur = cur.parentElement;
        }
        return node;
    }

    /**
     * 在页面上找到「文案包含 words 之一」的最小元素，并返回它的可点击祖先。
     * 用于新版贴吧这种没有稳定 class 的界面。
     */
    function findByText(words, options = {}) {
        const { exclude = [], requireVisible = true, maxLen = 40, root = document } = options;
        const all = $$("span,div,a,button,li,label,p", root);
        const candidates = [];
        for (const node of all) {
            if (node.children.length > 0 && node.childElementCount > 2) continue; // 只取叶子附近
            const text = (node.textContent || "").trim();
            if (!text || text.length > maxLen) continue;
            if (!words.some((w) => text.includes(w))) continue;
            if (exclude.some((w) => text.includes(w))) continue;
            if (requireVisible && !isVisible(node)) continue;
            candidates.push({ node, len: text.length });
        }
        candidates.sort((a, b) => a.len - b.len);
        return candidates.length ? clickableAncestor(candidates[0].node) : null;
    }

    function isActiveTab(node) {
        if (!node) return false;
        const classes = ["active", "selected", "is-active", "cur", "current", "on", "checked", "tab-active"];
        let cur = node;
        for (let i = 0; i < 4 && cur; i++) {
            const cls = typeof cur.className === "string" ? cur.className.toLowerCase() : "";
            if (classes.some((c) => cls.split(/[\s_-]+/).includes(c))) return true;
            if (cur.getAttribute && cur.getAttribute("aria-selected") === "true") return true;
            if (cur.getAttribute && cur.getAttribute("aria-current") === "page") return true;
            cur = cur.parentElement;
        }
        return false;
    }

    /* ------------------------- 功能 1：默认最新排序 ------------------------- */

    /** 已经处理过的排序栏（元素被重新渲染后会自然失效，允许再次处理） */
    const handledBars = new WeakSet();
    let lastSortNotice = 0;

    function sortNotice(text) {
        const now = Date.now();
        if (now - lastSortNotice < 1500) return;
        lastSortNotice = now;
        toast(text);
    }

    /**
     * 找到排序/子排序标签栏。做法：文档里所有同时出现「最新」「热门」的容器，
     * 取最内层那个，避免误命中整个页面。
     */
    function findSortBars() {
        const bars = [];
        for (const c of $$("div,ul,section,nav")) {
            if (c.children.length < 2 || c.children.length > 24) continue;
            const text = (c.textContent || "").trim();
            if (text.length > 160) continue;
            if (!text.includes("最新") || !text.includes("热门")) continue;
            // 容器里至少要有多个可点击的标签，排除只是正文里提到这两个词的容器
            const clickables = Array.from(c.children).filter((ch) => ch.matches("a,button,li,span,div")).length;
            if (clickables < 2) continue;
            bars.push(c);
        }
        // 只保留最内层容器
        return bars.filter((b) => !bars.some((o) => o !== b && b.contains(o)));
    }

    function enforceSort() {
        if (!cfg.sort || !page.isForum()) return;
        for (const bar of findSortBars()) {
            if (handledBars.has(bar)) continue;
            const latest = findByText(["最新"], { root: bar, maxLen: 12 });
            if (!latest) continue;
            handledBars.add(bar);
            if (isActiveTab(latest)) {
                sortNotice("已是最新排序");
                continue;
            }
            latest.click();
            sortNotice("已切换到「最新」排序");
        }
    }

    /* ------------------- 功能 1b：帖子页默认「正序」排序 ------------------- */

    /** 新版帖子页的回复排序：.sub-tab-container > .sub-tab-item（热门 / 正序 / 倒序） */
    let handledThreadSorts = new WeakSet();
    /** 用户手动点过排序标签后就不再抢，避免「你点热门、我点回正序」的拉锯 */
    let userPickedSort = false;
    let lastThreadSortClick = 0;

    function findThreadSortBar() {
        for (const bar of $$(".sub-tab-container")) {
            if (bar.querySelectorAll(".sub-tab-item").length >= 2 && isVisible(bar)) return bar;
        }
        return null;
    }

    function enforceThreadSort() {
        if (!cfg.sort || !page.isThread() || userPickedSort) return;
        const bar = findThreadSortBar();
        if (!bar || handledThreadSorts.has(bar)) return;
        const items = Array.from(bar.querySelectorAll(".sub-tab-item"));
        const target = items.find((n) => (n.textContent || "").trim() === "正序");
        if (!target) return;
        if (isActiveTab(target)) { handledThreadSorts.add(bar); return; }
        // 站点重新渲染排序栏时可能把「正序」改回「热门」，允许再点一次，但限速
        if (Date.now() - lastThreadSortClick < 1500) return;
        handledThreadSorts.add(bar);
        lastThreadSortClick = Date.now();
        target.click();
        sortNotice("已切换到「正序」排序");
    }

    /** 记录用户是否亲手点过排序标签（pointerdown 只会由真实输入触发） */
    function watchUserSortPick() {
        document.addEventListener("pointerdown", (e) => {
            const t = e.target && e.target.closest && e.target.closest(".sub-tab-item, .sort-tab, [class*='sort'] [class*='tab']");
            if (t) userPickedSort = true;
        }, true);
    }

    /* --------------------------- 功能 2：标签栏 --------------------------- */

    const TAB_LABELS = ["看贴", "图片", "吧主推荐", "视频", "精品", "公告", "精华", "全部"];

    function collectTabs() {
        const seen = new Set();
        const items = [];
        for (const a of $$("a[href]")) {
            const href = a.getAttribute("href") || "";
            if (!href || href.startsWith("javascript:")) continue;
            const text = (a.textContent || "").trim();
            if (!text || text.length > 8) continue;
            let url;
            try { url = new URL(href, location.href); } catch (_) { continue; }
            if (url.hostname !== location.hostname && !/tieba\.baidu\.com$/.test(url.hostname)) continue;
            const isForumTab = /\/f(\/|$)/.test(url.pathname) && (url.searchParams.has("tab") || url.searchParams.has("kw"));
            const isKnown = TAB_LABELS.includes(text);
            const isHome = /^\/$/.test(url.pathname) && /首页|主页/.test(text);
            if (!isForumTab && !isKnown && !isHome) continue;
            const key = url.pathname + url.search;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({ text, url: url.href });
        }
        return items;
    }

    function buildTabBar() {
        if (!cfg.tabs) return;
        if ($("#tbhelper-tabs")) return;
        const items = collectTabs();
        if (items.length < 2) return;
        const bar = el("div", { id: "tbhelper-tabs" });
        bar.appendChild(el("span", { class: "tbhelper-tabs-label", text: "页面" }));
        for (const it of items) {
            const current = it.url.split("#")[0] === location.href.split("#")[0];
            bar.appendChild(el("a", {
                class: "tbhelper-tab" + (current ? " is-current" : ""),
                href: it.url,
                target: "_blank",
                rel: "noopener",
                title: "在新标签页打开：" + it.text,
                text: it.text,
            }));
        }
        bar.appendChild(el("span", {
            class: "tbhelper-tabs-close",
            text: "×",
            title: "隐藏标签栏（可在菜单里恢复）",
            onclick: () => { bar.remove(); cfg.tabs = false; saveCfg(); toast("标签栏已隐藏，可在脚本菜单恢复"); },
        }));
        mount(bar);
    }

    /* -------------------------- 功能 4：楼中楼压缩 -------------------------- */

    /* 只作用于「楼中楼」容器 .lzl-wrapper 里的 .pb-lzl-item，
       绝不碰 .pb-comment-item（楼层回复）、.image-text（主楼）、.avatar-box（回复框）。
       新版贴吧的真实结构（来自实测诊断数据）：
         .pb-comment-item > .lzl-wrapper > .pb-lzl-item
           > .head-line.user-info > .left-box > .popover__reference > a.avatar > img.avatar-img
           > .head-info > a.name-info-link > .name-info > a.head-name
           > .comment-content.no-extra-margin > .pb-rich-text > .pc-pb-comments-desc
    */
    const LZL_CSS = `
/* 楼中楼整块：淡底 + 左侧竖线 + 缩进，与楼层一眼区分开 */
.lzl-wrapper {
    width: auto !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
    margin: 4px 0 2px 0 !important;
    padding: 4px 8px 4px 10px !important;
    border-left: 2px solid rgba(120, 150, 255, .45) !important;
    border-radius: 0 6px 6px 0 !important;
    background: rgba(127, 150, 255, .07) !important;
}
.pb-lzl-item {
    padding: 1px 0 !important;
}

/* 头像 40px → 16px：容器、链接、图片一起缩，否则会错位 */
.pb-lzl-item .left-box,
.pb-lzl-item .left-box > span,
.pb-lzl-item .popover__reference,
.pb-lzl-item a.avatar {
    width: 16px !important;
    height: 16px !important;
    min-width: 16px !important;
    min-height: 16px !important;
}
.pb-lzl-item a.avatar img.avatar-img,
.pb-lzl-item .left-box img {
    width: 16px !important;
    height: 16px !important;
    min-width: 16px !important;
    min-height: 16px !important;
    border-radius: 50% !important;
    object-fit: cover !important;
    vertical-align: middle !important;
}
/* 覆盖头像的透明点击遮罩会撑出原尺寸，隐藏掉（头像本身仍是可点链接） */
.pb-lzl-item .user-popover-mask {
    display: none !important;
}

/* 整行高度跟随小头像，头像与昵称同一行居中 */
.pb-lzl-item > .head-line.user-info {
    height: auto !important;
    min-height: 0 !important;
    align-items: center !important;
}
.pb-lzl-item .head-info {
    margin: 0 !important;
    padding-left: 5px !important;
}
.pb-lzl-item .head-name {
    font-size: 12px !important;
    line-height: 16px !important;
}
.pb-lzl-item .head-spacer {
    height: 16px !important;
    flex: 1 1 0% !important;
}
.pb-lzl-item .btn-wrapper {
    height: 16px !important;
}

/* 正文缩进对齐小头像；改成块级，避免行内盒里嵌块级元素产生的多余行高 */
.pb-lzl-item .comment-content.no-extra-margin {
    display: block !important;
    margin: 0 0 0 21px !important;
}
.pb-lzl-item .pb-rich-text,
.pb-lzl-item .pc-pb-comments-desc {
    width: auto !important;
}
/* 正文行高 26px → 17px，楼中楼里这一项最占竖向空间 */
.pb-lzl-item .pb-rich-text {
    line-height: 17px !important;
}
.pb-lzl-item .pb-text-wrapper.text,
.pb-lzl-item .pb-text-wrapper.text span,
.pb-lzl-item .pb-text-wrapper.text a {
    line-height: 17px !important;
}
/* 日期/地区/赞/回复整行压到 16px 高 */
.pb-lzl-item .pc-pb-comments-desc {
    margin: 1px 0 0 !important;
    height: 16px !important;
    line-height: 16px !important;
}
.pb-lzl-item .comment-desc-left,
.pb-lzl-item .comment-desc-right {
    height: 16px !important;
}
.pb-lzl-item .comment-desc-left span {
    line-height: 16px !important;
    font-size: 12px !important;
}
.pb-lzl-item .zan-container-dark,
.pb-lzl-item .reply-container {
    height: 16px !important;
    padding: 0 4px !important;
    margin-left: 4px !important;
}
.pb-lzl-item .zan-container-dark span,
.pb-lzl-item .reply-container span {
    line-height: 16px !important;
    font-size: 12px !important;
}

/* 「展开更多回复」跟着内缩 */
.show-more-lzl {
    margin: 4px 0 2px 21px !important;
    font-size: 12px !important;
    line-height: 16px !important;
}

/* ===== 楼中楼分页：默认只显示前 N 条，其余收起 ===== */
.lzl-wrapper .pb-lzl-item.tbhelper-lzl-hidden {
    display: none !important;
}
/* 站点自带的「展开更多回复」：只有翻到最后一页才显示，避免和分页打架
   （真实页面上它可能在 wrapper 里，也可能是 wrapper 的下一个兄弟节点） */
.show-more-lzl.tbhelper-lzl-site-more-hidden {
    display: none !important;
}

/* ===== 楼中楼分页：旧版贴吧那样的页码 ===== */
.tbhelper-lzl-pager {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin: 3px 0 2px 21px;
    font-size: 12px;
    line-height: 17px;
    user-select: none;
}
.tbhelper-lzl-pg {
    min-width: 20px;
    padding: 1px 6px;
    text-align: center;
    color: #4a6cf7;
    background: rgba(120, 150, 255, .12);
    border-radius: 999px;
    cursor: pointer;
}
.tbhelper-lzl-pg:hover {
    background: rgba(120, 150, 255, .24);
}
.tbhelper-lzl-pg.active {
    color: #fff;
    background: #4a6cf7;
    cursor: default;
}
.tbhelper-lzl-pg.disabled {
    color: #b6bcc9;
    background: rgba(127, 127, 127, .10);
    cursor: not-allowed;
}
.tbhelper-lzl-pg.disabled:hover {
    background: rgba(127, 127, 127, .10);
}
.tbhelper-lzl-pg.ellipsis {
    background: none;
    cursor: default;
    color: #9aa3b2;
}
.tbhelper-lzl-pg-info {
    margin-left: 6px;
    color: #9aa3b2;
}
.tbhelper-lzl-pg-loading {
    padding: 1px 8px;
    color: #9aa3b2;
}
.tbhelper-lzl-pg-loading::before {
    content: "";
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 5px;
    border: 2px solid rgba(120, 150, 255, .35);
    border-top-color: #4a6cf7;
    border-radius: 50%;
    animation: tbhelper-spin .7s linear infinite;
    vertical-align: -1px;
}
@keyframes tbhelper-spin {
    to { transform: rotate(360deg); }
}
body.dark .tbhelper-lzl-pg {
    color: #8fa8ff;
    background: rgba(120, 150, 255, .14);
}
body.dark .tbhelper-lzl-pg:hover {
    background: rgba(120, 150, 255, .26);
}
body.dark .tbhelper-lzl-pg.active {
    color: #fff;
    background: #4a6cf7;
}
body.dark .tbhelper-lzl-pg.disabled {
    color: #5b6070;
    background: rgba(127, 127, 127, .12);
}
body.dark .tbhelper-lzl-pg-info {
    color: #6f768a;
}
`;

    function applyLzlStyle() {
        if (!cfg.lzl || $("#tbhelper-lzl-style")) return;
        const style = document.createElement("style");
        style.id = "tbhelper-lzl-style";
        style.dataset.tbhelper = "1";
        style.textContent = LZL_CSS;
        mount(style);
    }

    /* ------------- 功能 4b：楼中楼分页（旧版贴吧那种翻页） ------------- */

    /** 一页最多多少字：单条很长的楼中楼会提前翻页，避免某一页特别高 */
    const LZL_PAGE_CHARS = 1200;

    /** 每页几条（0 = 不分页，全部展开） */
    function lzlPageSize() {
        const n = parseInt(cfg.lzlLimit, 10);
        return Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 0;
    }

    /** wrapper -> { page, pager, busy } */
    const lzlPageState = new WeakMap();

    /**
     * wrapper 是虚拟列表渲染出来的，滚动时会不断被销毁重建。
     * 所以「用户在看第几页」要按这条回复的 data-id 记住，否则一滚动就跳回第 1 页，
     * 高度反复变化 → 页面上下瞬移（闪烁）。
     */
    const lzlSavedPage = new Map();
    const LZL_SAVED_MAX = 400;

    function lzlCommentKey(wrap) {
        const host = wrap.closest ? wrap.closest(".pb-comment-item") : null;
        if (!host) return "";
        return host.getAttribute("data-id") || host.getAttribute("data-floor") || "";
    }

    function lzlSavePage(wrap, page) {
        const key = lzlCommentKey(wrap);
        if (!key) return;
        if (!lzlSavedPage.has(key) && lzlSavedPage.size >= LZL_SAVED_MAX) {
            lzlSavedPage.delete(lzlSavedPage.keys().next().value);
        }
        lzlSavedPage.set(key, page);
    }

    function lzlRestorePage(wrap) {
        const key = lzlCommentKey(wrap);
        const v = key ? lzlSavedPage.get(key) : 0;
        return v && v > 0 ? v : 1;
    }

    function lzlItemsOf(wrap) {
        return Array.from(wrap.children).filter(
            (n) => n.nodeType === 1 && n.classList.contains("pb-lzl-item")
        );
    }

    /** 站点自带的「展开更多回复」：可能在 wrapper 里，也可能是 wrapper 的下一个兄弟节点 */
    function siteLzlMoreOf(wrap) {
        const found = [];
        const inside = wrap.querySelector(".show-more-lzl");
        if (inside) found.push(inside);
        const next = wrap.nextElementSibling;
        if (next && next.classList && next.classList.contains("show-more-lzl")) found.push(next);
        return found;
    }

    function setSiteLzlMoreHidden(wrap, hidden) {
        for (const n of siteLzlMoreOf(wrap)) {
            n.classList.toggle("tbhelper-lzl-site-more-hidden", !!hidden);
        }
    }

    /** 先按条数切页，再按累计字数切页（任何一页都不会又长又高） */
    function buildLzlPages(items, size) {
        const pages = [];
        let cur = [];
        let chars = 0;
        for (const it of items) {
            const len = (it.textContent || "").length;
            if (cur.length >= size || (cur.length > 0 && chars + len > LZL_PAGE_CHARS)) {
                pages.push(cur);
                cur = [];
                chars = 0;
            }
            cur.push(it);
            chars += len;
        }
        if (cur.length) pages.push(cur);
        return pages.length ? pages : [[]];
    }

    /** 页码序列：1 … 当前±2 … 末尾 */
    function lzlPageNumbers(cur, total) {
        const out = [];
        for (let i = 1; i <= total; i++) {
            if (i === 1 || i === total || Math.abs(i - cur) <= 2) out.push(i);
            else if (out[out.length - 1] !== "…") out.push("…");
        }
        return out;
    }

    function renderLzlPager(pager, wrap, st, totalPages, totalItems, hasMore) {
        // 内容没变就别碰 DOM：反复重建页码条会不停触发回流，滚动时就会「闪」
        const sig = [st.busy ? "b" : "n", st.page, totalPages, totalItems, hasMore ? 1 : 0].join("|");
        if (pager.dataset.sig === sig) return;
        pager.dataset.sig = sig;

        pager.textContent = "";

        if (st.busy) {
            pager.appendChild(el("span", { class: "tbhelper-lzl-pg-loading", text: "正在加载下一页…" }));
            return;
        }

        const add = (label, page, cls, disabled) => {
            const b = el("span", {
                class: "tbhelper-lzl-pg" + (cls ? " " + cls : "") + (disabled ? " disabled" : ""),
                text: label,
            });
            if (!disabled && page !== st.page) {
                b.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    gotoLzlPage(wrap, page);
                });
            }
            pager.appendChild(b);
        };

        add("‹ 上一页", st.page - 1, "nav", st.page <= 1);
        for (const p of lzlPageNumbers(st.page, totalPages)) {
            if (p === "…") {
                pager.appendChild(el("span", { class: "tbhelper-lzl-pg ellipsis", text: "…" }));
            } else {
                add(String(p), p, p === st.page ? "active" : "", false);
            }
        }
        // 后面还有没加载的楼中楼时，「下一页」永远可点，点了会自动去点站点的展开
        add("下一页 ›", st.page + 1, "nav", st.page >= totalPages && !hasMore);

        const info = hasMore ? `已加载 ${totalItems} 条` : `共 ${totalItems} 条`;
        pager.appendChild(el("span", { class: "tbhelper-lzl-pg-info", text: info }));
    }

    /** 当前 wrapper 能切出几页（不分页就是 1 页） */
    function lzlPagesNow(wrap) {
        const size = lzlPageSize();
        const items = lzlItemsOf(wrap);
        return size ? buildLzlPages(items, size) : [items];
    }

    function paginateOneLzl(wrap) {
        const items = lzlItemsOf(wrap);
        const size = lzlPageSize();
        let st = lzlPageState.get(wrap);
        if (!st) {
            st = { page: lzlRestorePage(wrap), pager: null, busy: false };
            lzlPageState.set(wrap, st);
        }

        const pages = size ? buildLzlPages(items, size) : [items];
        // 后面还能从服务器加载 → 即使现在只有一页也给出页码条
        const hasMore = size > 0 && siteLzlMoreOf(wrap).length > 0;
        const needPager = pages.length > 1 || hasMore;

        if (!needPager) {
            const dirty = !!st.pager || items.some((n) => n.classList.contains("tbhelper-lzl-hidden"));
            if (dirty) {
                for (const n of items) n.classList.remove("tbhelper-lzl-hidden");
                setSiteLzlMoreHidden(wrap, false);
                if (st.pager) { st.pager.remove(); st.pager = null; }
            }
            if (st.page !== 1) { st.page = 1; lzlSavePage(wrap, 1); }
            return { pages, hasMore };
        }

        if (st.page > pages.length) st.page = pages.length;
        if (st.page < 1) st.page = 1;

        const shown = pages[st.page - 1];
        const shownSet = new Set(shown);

        // 已经是目标状态就什么都不动（关键：避免每轮 apply 都改一次 DOM 造成高度抖动）
        let domOk = true;
        for (const n of items) {
            if (n.classList.contains("tbhelper-lzl-hidden") === shownSet.has(n)) { domOk = false; break; }
        }
        const pagerSig = [st.busy ? "b" : "n", st.page, pages.length, items.length, hasMore ? 1 : 0].join("|");
        const pagerOk = !!st.pager && st.pager.isConnected && st.pager.dataset.sig === pagerSig;
        const placeOk = items.length > 0 && items[items.length - 1].nextElementSibling === st.pager;
        if (domOk && pagerOk && placeOk) return { pages, hasMore };

        // 先全部藏起来（toggle 带 force，值没变就不会产生 DOM 变更），再把当前页放出来
        for (const n of items) n.classList.toggle("tbhelper-lzl-hidden", !shownSet.has(n));

        // 分页接管后，站点的「展开更多回复」交给页码条的「下一页」去点
        setSiteLzlMoreHidden(wrap, true);
        lzlSavePage(wrap, st.page);

        if (!st.pager || !st.pager.isConnected) {
            st.pager = el("div", { class: "tbhelper-lzl-pager" });
        }
        renderLzlPager(st.pager, wrap, st, pages.length, items.length, hasMore);

        // 页码放在最后一条后面（被隐藏的条目不占空间，所以视觉上就在当前页末尾）
        const anchor = items[items.length - 1];
        if (anchor && anchor.nextElementSibling !== st.pager) anchor.after(st.pager);
        return { pages, hasMore };
    }

    /** 等楼中楼条数变多（站点自己异步渲染，只能轮询） */
    function waitLzlItemsGrow(wrap, before, timeout) {
        return new Promise((resolve) => {
            const start = Date.now();
            (function tick() {
                if (!wrap.isConnected) return resolve(false);
                if (lzlItemsOf(wrap).length > before) return resolve(true);
                if (Date.now() - start > timeout) return resolve(false);
                setTimeout(tick, 120);
            })();
        });
    }

    /** 去点站点自己的「展开更多回复」，一次加载一批 */
    async function loadMoreLzlBatch(wrap) {
        const more = siteLzlMoreOf(wrap)[0];
        if (!more) return false;
        const before = lzlItemsOf(wrap).length;
        more.classList.remove("tbhelper-lzl-site-more-hidden"); // 有些框架只受理可见元素的点击
        try { more.click(); } catch (_) { return false; }
        const grew = await waitLzlItemsGrow(wrap, before, 3000);
        setSiteLzlMoreHidden(wrap, true);
        return grew;
    }

    /**
     * 翻页后把视角带到新一页的第一条回复上。
     * 否则内容一变矮/变高，视口却不动，很容易把下面的楼层当成上一页的内容。
     */
    function scrollLzlIntoView(node) {
        if (!node || !node.isConnected) return;
        const rect = node.getBoundingClientRect();
        const vh = window.innerHeight || document.documentElement.clientHeight || 600;
        const margin = Math.min(120, Math.round(vh * 0.15)); // 顶部留一点余量
        // 已经完整看得到就不动，避免无谓的跳动
        if (rect.top >= margin - 4 && rect.bottom <= vh - 4) return;

        // 找最近的可滚动祖先（新版贴吧滚的是 .pc-pb-box 这类内部容器）
        let sc = null;
        let cur = node.parentElement;
        while (cur && cur !== document.body && cur !== document.documentElement) {
            const cs = getComputedStyle(cur);
            if (/(auto|scroll)/.test(cs.overflowY) && cur.scrollHeight > cur.clientHeight + 20) { sc = cur; break; }
            cur = cur.parentElement;
        }
        if (sc) {
            sc.scrollTop += rect.top - sc.getBoundingClientRect().top - margin;
        } else {
            window.scrollBy(0, rect.top - margin);
        }
    }

    /** 让视角停在当前页的第 skip 条（skip=0 表示这一页的第一条） */
    function focusLzlPage(wrap, skip) {
        const st = lzlPageState.get(wrap);
        if (!st) return;
        const size = lzlPageSize();
        const items = lzlItemsOf(wrap);
        const pages = size ? buildLzlPages(items, size) : [items];
        const pageItems = pages[st.page - 1] || [];
        const anchor = pageItems[Math.max(0, skip || 0)] || pageItems[0];
        if (!anchor) return;
        // 等这一轮样式/排版落定再量位置
        requestAnimationFrame(() => scrollLzlIntoView(anchor));
    }

    /** 跳到第 target 页；没加载到就先自动把后面的楼中楼拉下来 */
    async function gotoLzlPage(wrap, target) {
        const st = lzlPageState.get(wrap);
        if (!st) return;
        const pages = lzlPagesNow(wrap);
        if (target <= pages.length) {
            st.page = Math.max(1, target);
            paginateOneLzl(wrap);
            focusLzlPage(wrap, 0);
            return;
        }
        if (st.busy) return;

        // 当前这页还没装满（说明它本来只是「已加载的那几条」），
        // 那么点「下一页」的真实意图是「多加载一些」，加载完应该留在本页把它填满，
        // 而不是直接跳到第 N 页、把中间从没显示过的楼中楼跳过去。
        const size = lzlPageSize();
        const oldLen = (pages[st.page - 1] || []).length;
        const stayPut = size > 0 && oldLen < size;
        const wantPage = stayPut ? st.page : target;
        const focusSkip = stayPut ? oldLen : 0; // 停留在本页时，视角跟着「新出现的第一条」

        st.busy = true;
        paginateOneLzl(wrap);  // 立刻显示「正在加载下一页…」
        try {
            for (let i = 0; i < 8; i++) {
                if (!wrap.isConnected) break;
                if (lzlPagesNow(wrap).length >= target) break;
                const grew = await loadMoreLzlBatch(wrap);
                if (!grew) break;
                paginateOneLzl(wrap);
            }
        } finally {
            st.busy = false;
            if (wrap.isConnected) {
                const now = lzlPagesNow(wrap);
                st.page = Math.min(Math.max(1, wantPage), now.length);
                paginateOneLzl(wrap);
                focusLzlPage(wrap, focusSkip);
            }
        }
    }

    function paginateAllLzl() {
        if (!cfg.lzl || !cfg.lzlFold) return;
        for (const wrap of $$(".lzl-wrapper")) paginateOneLzl(wrap);
    }

    function clearLzlPaging() {
        for (const wrap of $$(".lzl-wrapper")) {
            for (const n of lzlItemsOf(wrap)) n.classList.remove("tbhelper-lzl-hidden");
            setSiteLzlMoreHidden(wrap, false);
            const p = wrap.querySelector(".tbhelper-lzl-pager");
            if (p) p.remove();
            lzlPageState.delete(wrap);
        }
    }

    /* ----------------------------- 工具条 UI ----------------------------- */

    const BASE_CSS = `
#tbhelper-toast {
    position: fixed; left: 50%; bottom: 40px; transform: translate(-50%, 20px);
    background: rgba(24, 28, 36, .94); color: #fff; font: 13px/1.6 system-ui, "Microsoft YaHei";
    padding: 8px 16px; border-radius: 8px; z-index: 2147483001; pointer-events: none;
    opacity: 0; transition: opacity .2s, transform .2s; box-shadow: 0 6px 24px rgba(0,0,0,.25);
}
#tbhelper-toast[data-show="1"] { opacity: 1; transform: translate(-50%, 0); }
#tbhelper-tabs {
    position: sticky; top: 0; z-index: 2147482000; display: flex; align-items: center; gap: 6px;
    padding: 6px 12px; background: rgba(255,255,255,.97); backdrop-filter: blur(8px);
    border-bottom: 1px solid #e5e7eb; font: 13px/1.5 system-ui, "Microsoft YaHei";
    flex-wrap: wrap;
}
body.dark #tbhelper-tabs { background: rgba(32,34,38,.97); border-color: #3a3d42; }
.tbhelper-tabs-label { color: #9ca3af; margin-right: 2px; }
.tbhelper-tab {
    color: #2563eb; text-decoration: none; padding: 2px 10px; border-radius: 999px;
    border: 1px solid #dbe4f5; background: #f5f8ff;
}
.tbhelper-tab:hover { background: #e8f0ff; }
.tbhelper-tab.is-current { background: #2563eb; color: #fff; border-color: #2563eb; }
body.dark .tbhelper-tab { color: #93c5fd; background: #1e293b; border-color: #334155; }
body.dark .tbhelper-tab.is-current { background: #2563eb; color: #fff; }
.tbhelper-tabs-close { margin-left: auto; color: #9ca3af; cursor: pointer; font-size: 16px; padding: 0 4px; }
#tbhelper-dock {
    position: fixed; right: 18px; bottom: 18px; z-index: 2147482500;
    display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
    font: 13px/1.5 system-ui, "Microsoft YaHei";
}
.tbhelper-dock-btn {
    width: 40px; height: 40px; border-radius: 50%; border: 1px solid #e5e7eb;
    background: rgba(255,255,255,.97); cursor: pointer; font-size: 18px;
    box-shadow: 0 6px 18px rgba(0,0,0,.16);
}
.tbhelper-dock-btn:hover { background: #f3f4f6; }
#tbhelper-menu {
    position: fixed; right: 18px; bottom: 72px; z-index: 2147482500;
    display: none; flex-direction: column; gap: 2px; min-width: 190px;
    padding: 8px; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0,0,0,.18); color: #111;
}
body.dark #tbhelper-menu { background: #232529; color: #e5e7eb; border-color: #3a3d42; }
#tbhelper-menu[data-open="1"] { display: flex; }
#tbhelper-menu .tbhelper-mi {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 6px 8px; border-radius: 8px; cursor: pointer; user-select: none;
}
#tbhelper-menu .tbhelper-mi:hover { background: rgba(37,99,235,.08); }
.tbhelper-mi .state { font-size: 12px; color: #9ca3af; }
.tbhelper-mi .state.on { color: #16a34a; }
#tbhelper-menu .tbhelper-mi select {
    font: inherit; padding: 2px 4px; border-radius: 6px;
    border: 1px solid #d1d5db; background: #fff; color: #111; cursor: pointer;
}
body.dark #tbhelper-menu .tbhelper-mi select { background: #2d3035; color: #e5e7eb; border-color: #3f434a; }
#tbhelper-menu .sep { height: 1px; background: #eef0f3; margin: 4px 2px; }
body.dark #tbhelper-menu .sep { background: #33363c; }
`;

    function buildDock() {
        if ($("#tbhelper-dock")) return;
        const rows = [
            ["sort", "默认排序（吧页最新 / 帖页正序）"],
            ["tabs", "页面标签栏"],
            ["lzl", "楼中楼压缩"],
            ["lzlFold", "楼中楼分页"],
        ];
        const menu = el("div", { id: "tbhelper-menu" });
        for (const [key, label] of rows) {
            const mi = el("div", { class: "tbhelper-mi" }, [
                el("span", { text: label }),
                el("span", { class: "state" + (cfg[key] ? " on" : ""), text: cfg[key] ? "开" : "关" }),
            ]);
            mi.addEventListener("click", () => {
                cfg[key] = !cfg[key];
                saveCfg();
                mi.querySelector(".state").textContent = cfg[key] ? "开" : "关";
                mi.querySelector(".state").classList.toggle("on", cfg[key]);
                if (key === "lzl") {
                    if (cfg.lzl) { applyLzlStyle(); paginateAllLzl(); }
                    else {
                        const s = $("#tbhelper-lzl-style");
                        if (s) s.remove();
                        clearLzlPaging();
                    }
                }
                if (key === "lzlFold") {
                    if (cfg.lzl && cfg.lzlFold) paginateAllLzl();
                    else clearLzlPaging();
                }
                toast(`${label}：${cfg[key] ? "已开启" : "已关闭"}`);
            });
            menu.appendChild(mi);
        }

        // 楼中楼每页几条
        const limitSel = el("select", { class: "tbhelper-limit" });
        for (const n of [5, 10, 15, 20, 0]) {
            limitSel.appendChild(el("option", { value: String(n), text: n ? String(n) + " 条/页" : "不分页" }));
        }
        limitSel.value = String(parseInt(cfg.lzlLimit, 10) || 0);
        limitSel.addEventListener("change", () => {
            cfg.lzlLimit = parseInt(limitSel.value, 10) || 0;
            saveCfg();
            if (cfg.lzl && cfg.lzlFold) paginateAllLzl();
            else clearLzlPaging();
            toast("楼中楼每页：" + (cfg.lzlLimit ? cfg.lzlLimit + " 条" : "不分页"));
        });
        menu.appendChild(el("div", { class: "tbhelper-mi tbhelper-mi-select" }, [
            el("span", { text: "每页楼中楼条数" }),
            limitSel,
        ]));

        menu.appendChild(el("div", { class: "sep" }));
        menu.appendChild(el("div", {
            class: "tbhelper-mi",
            text: "诊断捕获（配合开发适配）",
            onclick: () => { togglePanel(true); },
        }));

        const btn = el("button", { class: "tbhelper-dock-btn", title: "贴吧助手设置", text: "⚙" });
        btn.addEventListener("click", () => {
            menu.dataset.open = menu.dataset.open === "1" ? "0" : "1";
        });
        const dock = el("div", { id: "tbhelper-dock" }, [menu, btn]);
        mount(dock);
    }

    /* ------------------------------ 诊断捕获 ------------------------------ */

    const diag = {
        api: [],
        MAX: 150,
    };

    function recordApi(entry) {
        diag.api.push({ t: Date.now(), ...entry });
        if (diag.api.length > diag.MAX) diag.api.splice(0, diag.api.length - diag.MAX);
    }

    function hookNetwork() {
        // 记录 XHR
        const OrigXHR = window.XMLHttpRequest;
        if (OrigXHR && !OrigXHR.__tbhelper) {
            const open = OrigXHR.prototype.open;
            const send = OrigXHR.prototype.send;
            OrigXHR.prototype.open = function (method, url, ...rest) {
                this.__tbhelper = { method, url: String(url) };
                return open.call(this, method, url, ...rest);
            };
            OrigXHR.prototype.send = function (body) {
                if (this.__tbhelper) {
                    const info = this.__tbhelper;
                    this.addEventListener("loadend", () => {
                        try {
                            if (!/tieba\.baidu\.com|tiebac\.baidu\.com/.test(info.url)) return;
                            recordApi({
                                kind: "xhr",
                                method: info.method,
                                url: info.url,
                                body: typeof body === "string" ? body.slice(0, 2000) : null,
                                status: this.status,
                                respHead: String(this.responseText || "").slice(0, 300),
                            });
                        } catch (_) { /* ignore */ }
                    });
                }
                return send.call(this, body);
            };
            OrigXHR.__tbhelper = true;
        }
        // 记录 fetch
        if (typeof window.fetch === "function" && !window.fetch.__tbhelper) {
            const origFetch = window.fetch;
            const wrapped = function (input, init) {
                const url = typeof input === "string" ? input : (input && input.url) || "";
                const method = (init && init.method) || "GET";
                return origFetch.apply(this, arguments).then((resp) => {
                    try {
                        if (/tieba\.baidu\.com|tiebac\.baidu\.com/.test(url)) {
                            recordApi({ kind: "fetch", method, url, body: init && init.body ? String(init.body).slice(0, 2000) : null, status: resp.status });
                        }
                    } catch (_) { /* ignore */ }
                    return resp;
                });
            };
            wrapped.__tbhelper = true;
            window.fetch = wrapped;
        }
    }

    function safeClass(node) {
        try {
            const c = node.className;
            if (typeof c === "string") return c;
            if (c && typeof c.baseVal === "string") return c.baseVal;
            return "";
        } catch (_) {
            return "";
        }
    }

    /* ---------- 精简捕获：输出「带行内计算样式的 HTML」，体积小且信息全 ---------- */

    const KEEP_ATTRS = /^(class|id|href|title|alt|role|aria-[a-z-]+|data-[a-z-]+)$/i;
    const STYLE_KEYS = [
        "display", "position", "width", "height", "min-height", "max-height",
        "margin", "padding", "font-size", "line-height", "font-weight", "color",
        "background-color", "border-radius", "flex", "flex-direction", "align-items",
        "gap", "grid-template-columns",
    ];

    function attrOf(node, name) {
        try {
            const v = node.getAttribute(name);
            return v == null ? null : v;
        } catch (_) {
            return null;
        }
    }

    function escHtml(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function compactStyle(node) {
        let cs;
        try { cs = getComputedStyle(node); } catch (_) { return ""; }
        const parts = [];
        for (const k of STYLE_KEYS) {
            const v = cs.getPropertyValue(k);
            if (v) parts.push(k + ":" + v.trim());
        }
        // 只保留关键几何信息（避免整页尺寸噪音）
        try {
            const r = node.getBoundingClientRect();
            if (r.width || r.height) parts.push(`@box:${Math.round(r.width)}x${Math.round(r.height)}`);
        } catch (_) { /* ignore */ }
        return parts.join(";");
    }

    /** 找到帖子主体容器（含楼主内容 + 回复列表的那个盒子） */
    function findContentRoot() {
        const candidates = [];
        for (const node of $$("div,main,section,article")) {
            const text = (node.textContent || "").trim();
            if (text.length < 80) continue;
            if (!/回复|楼|赞/.test(text)) continue;
            let markerCount = 0;
            try {
                markerCount = node.querySelectorAll("[class*='avatar'],[class*='reply'],[class*='comment'],[data-post-id],[data-floor]").length;
            } catch (_) { /* ignore */ }
            if (markerCount < 3) continue;
            const r = node.getBoundingClientRect();
            if (r.width < 300) continue;
            candidates.push({ node, area: r.width * Math.max(r.height, 1), markerCount });
        }
        if (!candidates.length) return document.body;
        // 取「包含最多回复标记的较大容器」，但不要取到整个 body
        candidates.sort((a, b) => (b.markerCount - a.markerCount) || (b.area - a.area));
        return candidates[0].node;
    }

    function inlineTree(node, out, budget) {
        if (budget.n <= 0) return;
        const tag = (node.tagName || "").toLowerCase();
        if (tag === "script" || tag === "style" || tag === "svg" || tag === "noscript" || tag === "iframe") return;
        budget.n--;

        const attrs = [];
        const src = attrOf(node, "data-src") || attrOf(node, "src") || "";
        for (const at of Array.from(node.attributes || [])) {
            if (!KEEP_ATTRS.test(at.name)) continue;
            if (at.name === "id" && !at.value) continue;
            let v = at.value;
            if (at.name === "href" || at.name === "src") v = v.slice(0, 120);
            if (at.name.startsWith("data-") && v.length > 80) v = v.slice(0, 80);
            attrs.push(`${at.name}="${escHtml(v)}"`);
        }
        if (src) attrs.push(`data-src="${escHtml(src.slice(0, 120))}"`);
        const st = compactStyle(node);
        if (st) attrs.push(`data-cs="${escHtml(st)}"`);

        out.push("<" + (tag || "span") + (attrs.length ? " " + attrs.join(" ") : "") + ">");

        let hasReplied = false;
        for (const child of Array.from(node.childNodes || [])) {
            if (child.nodeType === 3) {
                const t = (child.textContent || "").replace(/\s+/g, " ").trim();
                if (!t) continue;
                hasReplied = true;
                out.push(escHtml(t));
            } else if (child.nodeType === 1) {
                hasReplied = true;
                inlineTree(child, out, budget);
            }
        }
        if (!hasReplied) {
            const selfText = (node.textContent || "").replace(/\s+/g, " ").trim();
            if (selfText && !node.childElementCount) out.push(escHtml(selfText.slice(0, 200)));
        }
        out.push(`</${tag || "span"}>`);
    }

    function captureCompact() {
        const root = findContentRoot();
        const render = () => {
            const out = [];
            inlineTree(root, out, { n: 40000 });
            return out.join("").replace(/>\s+</g, "><");
        };
        let html = render();
        let trimmed = false;

        // 体积保护：真实帖子可能很长，超限时只保留前几个「回复块」
        if (html.length > 60000) {
            const blocks = [];
            for (const child of Array.from(root.children || [])) {
                const text = (child.textContent || "").trim();
                if (text.length < 40) continue; // 跳过工具栏等噪音
                blocks.push(child);
            }
            const keep = new Set(blocks.slice(0, 6));
            for (const child of Array.from(root.children || [])) {
                if (keep.has(child)) continue;
                if ((child.textContent || "").trim().length < 40) continue;
                child.remove();
            }
            html = render();
            trimmed = true;
            if (html.length > 90000) {
                for (const child of Array.from(root.children || [])) {
                    if ((child.textContent || "").trim().length < 40) child.remove();
                }
                html = render();
            }
        }

        return {
            root: (root.tagName || "").toLowerCase() + "." + (safeClass(root).split(/\s+/)[0] || "(no-class)"),
            html,
            size: html.length,
            trimmed,
        };
    }

    /* ---------- 完整捕获：DOM 结构树 + class 清单 ---------- */

    /** 把 DOM 转成精简结构树：tag / id / class / data-* / 尺寸 / 文本片段 */
    function serializeNode(node, depth, budget) {
        if (budget.n <= 0) return null;
        const tag = node.tagName ? node.tagName.toLowerCase() : "#text";
        if (tag === "script" || tag === "style" || tag === "svg" || tag === "path" || tag === "noscript") return null;
        budget.n--;
        const r = (() => { try { return node.getBoundingClientRect(); } catch (_) { return { width: 0, height: 0 }; } })();
        const rec = {
            tag,
            id: node.id || undefined,
            cls: safeClass(node) || undefined,
            w: Math.round(r.width),
            h: Math.round(r.height),
        };
        const data = {};
        if (node.attributes) {
            for (const at of node.attributes) {
                if (at.name.startsWith("data-")) data[at.name] = at.value.slice(0, 80);
            }
        }
        if (Object.keys(data).length) rec.data = data;
        if (node.children && node.children.length) {
            rec.children = [];
            for (const ch of node.children) {
                const s = serializeNode(ch, depth + 1, budget);
                if (s) rec.children.push(s);
            }
        } else {
            const text = (node.textContent || "").trim().replace(/\s+/g, " ");
            if (text) rec.text = text.slice(0, 120);
        }
        return rec;
    }

    function collectClassInventory() {
        const map = new Map();
        for (const node of $$("*")) {
            const cls = safeClass(node);
            if (!cls) continue;
            for (const c of cls.split(/\s+/)) {
                if (!c) continue;
                const rec = map.get(c) || { count: 0, tags: new Set(), sample: "" };
                rec.count++;
                rec.tags.add(node.tagName.toLowerCase());
                if (!rec.sample) rec.sample = (node.textContent || "").trim().slice(0, 60);
                map.set(c, rec);
            }
        }
        return [...map.entries()]
            .filter(([, v]) => v.count >= 2)
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 400)
            .map(([cls, v]) => ({ cls, count: v.count, tags: [...v.tags].slice(0, 4), sample: v.sample }));
    }

    async function autoExpand() {
        const words = ["展开", "更多回复", "查看全部", "点击展开", "展开更多"];
        let clicks = 0;
        for (const node of $$("a,button,span,div")) {
            if (clicks >= 30) break;
            if (!isVisible(node) || node.childElementCount > 1) continue;
            const text = (node.textContent || "").trim();
            if (!words.some((w) => text.includes(w))) continue;
            if (text.length > 14) continue;
            node.click();
            clicks++;
            await new Promise((r) => setTimeout(r, 120));
        }
        await new Promise((r) => setTimeout(r, 800));
        return clicks;
    }

    async function capturePage(mode) {
        const expandClicks = await autoExpand();
        const bundle = {
            tool: "tbhelper-diagnose",
            version: VERSION,
            mode: mode || "compact",
            capturedAt: new Date().toISOString(),
            url: location.href,
            title: document.title,
            userAgent: navigator.userAgent,
            viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
            expandClicks,
            api: diag.api.slice(-120),
        };
        if (bundle.mode === "compact") {
            const c = captureCompact();
            bundle.root = c.root;
            bundle.htmlSize = c.size;
            bundle.trimmed = c.trimmed;
            bundle.html = c.html;
        } else {
            bundle.classes = collectClassInventory();
            bundle.body = serializeNode(document.body, 0, { n: 12000 });
        }
        return JSON.stringify(bundle);
    }

    function copyText(text) {
        try {
            if (typeof GM_setClipboard === "function") {
                GM_setClipboard(text, "text");
                return true;
            }
        } catch (_) { /* fall through */ }
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
                return true;
            }
        } catch (_) { /* fall through */ }
        return fallbackCopy(text);
    }

    function fallbackCopy(text) {
        try {
            const ta = el("textarea", { style: { position: "fixed", left: "-9999px" } });
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand("copy");
            ta.remove();
            return ok;
        } catch (_) {
            return false;
        }
    }

    let panelEl = null;
    function buildPanel() {
        if (panelEl) return panelEl;
        const status = el("div", {
            class: "tbhelper-panel-status",
            text: "「精简」抓帖子主体 + 每个元素的计算样式，体积小、够修复楼中楼；「完整」抓整页结构树。捕获后会自动复制。",
        });
        const modeSel = el("select", { class: "tbhelper-panel-mode", title: "捕获模式" }, [
            el("option", { value: "compact", text: "精简（推荐）" }),
            el("option", { value: "full", text: "完整" }),
        ]);
        panelEl = el("div", { id: "tbhelper-panel" }, [
            el("div", { class: "tbhelper-panel-head" }, [
                el("b", { text: "贴吧助手 · 诊断" }),
                el("span", { class: "tbhelper-panel-close", text: "×", onclick: () => togglePanel(false) }),
            ]),
            status,
            el("div", { class: "tbhelper-panel-row" }, [el("span", { text: "模式" }), modeSel]),
            el("div", { class: "tbhelper-panel-actions" }, [
                el("button", {
                    text: "捕获本页",
                    onclick: async () => {
                        status.textContent = "正在捕获…（会自动点击若干「展开」按钮）";
                        try {
                            const text = await capturePage(modeSel.value);
                            panelEl.__last = text;
                            const copied = copyText(text);
                            status.textContent = `已捕获 ${(text.length / 1024).toFixed(1)} KB` +
                                (copied ? "，已复制到剪贴板，直接粘贴即可。" : "，点「复制」或「下载」。");
                        } catch (e) {
                            status.textContent = "捕获失败：" + e.message;
                        }
                    },
                }),
                el("button", {
                    text: "复制",
                    onclick: () => {
                        if (!panelEl.__last) return (status.textContent = "先点「捕获本页」");
                        copyText(panelEl.__last);
                        status.textContent = "已复制到剪贴板。";
                    },
                }),
                el("button", {
                    text: "下载",
                    onclick: () => {
                        if (!panelEl.__last) return (status.textContent = "先点「捕获本页」");
                        const blob = new Blob([panelEl.__last], { type: "application/json" });
                        const a = el("a", { href: URL.createObjectURL(blob), download: `tieba-diag-${Date.now()}.json` });
                        document.body.appendChild(a);
                        a.click();
                        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
                        status.textContent = "已开始下载。";
                    },
                }),
            ]),
        ]);
        mount(panelEl);
        return panelEl;
    }

    function togglePanel(show) {
        const p = buildPanel();
        p.dataset.open = show ? "1" : "0";
    }

    const PANEL_CSS = `
#tbhelper-panel {
    position: fixed; right: 18px; bottom: 130px; z-index: 2147482600; width: 340px;
    display: none; flex-direction: column; gap: 8px; padding: 12px;
    background: #fff; color: #111; border: 1px solid #e5e7eb; border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0,0,0,.2); font: 13px/1.6 system-ui, "Microsoft YaHei";
}
#tbhelper-panel[data-open="1"] { display: flex; }
body.dark #tbhelper-panel { background: #232529; color: #e5e7eb; border-color: #3a3d42; }
.tbhelper-panel-head { display: flex; align-items: center; justify-content: space-between; }
.tbhelper-panel-close { cursor: pointer; color: #9ca3af; font-size: 18px; }
.tbhelper-panel-status { color: #6b7280; font-size: 12px; }
body.dark .tbhelper-panel-status { color: #9ca3af; }
.tbhelper-panel-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #6b7280; }
.tbhelper-panel-row select {
    flex: 1; padding: 3px 6px; border: 1px solid #d1d5db; border-radius: 6px;
    background: #fff; color: #111; font: inherit;
}
body.dark .tbhelper-panel-row select { background: #2d3035; color: #e5e7eb; border-color: #3f434a; }
.tbhelper-panel-actions { display: flex; gap: 8px; }
.tbhelper-panel-actions button {
    flex: 1; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 8px;
    background: #f9fafb; color: #111; font: inherit; cursor: pointer;
}
.tbhelper-panel-actions button:hover { background: #eef2ff; border-color: #a5b4fc; }
body.dark .tbhelper-panel-actions button { background: #2d3035; color: #e5e7eb; border-color: #3f434a; }
`;

    /* ------------------------------- 启动 ------------------------------- */

    let booted = false;
    let lastSortPath = location.pathname;

    function boot() {
        // document-start：先挂网络钩子，样式与 UI 等 DOM 就绪
        hookNetwork();
        try { if (document.documentElement) document.documentElement.dataset.tbhelperBoot = VERSION; } catch (_) { /* ignore */ }

        const run = () => {
            if (booted) return;
            booted = true;
            try { document.documentElement.dataset.tbhelperBoot = VERSION; } catch (_) { /* ignore */ }
            flushPending();
            injectStyle(BASE_CSS + PANEL_CSS);
            if (cfg.lzl) applyLzlStyle();
            watchUserSortPick();

            const apply = () => {
                // SPA 换帖/换吧后，用户的手动排序选择要重置
                if (location.pathname !== lastSortPath) {
                    lastSortPath = location.pathname;
                    userPickedSort = false;
                    handledThreadSorts = new WeakSet();
                }
                if (page.isForum()) {
                    enforceSort();
                    buildTabBar();
                }
                if (page.isThread()) {
                    enforceThreadSort();
                }
                paginateAllLzl();
                buildDock();
            };
            apply();

            // SPA 路由变化后重新执行；MutationObserver 有防抖
            let pending = null;
            observePage(() => {
                clearTimeout(pending);
                pending = setTimeout(apply, 600);
            });

            // 楼中楼：虚拟列表滚动时 wrapper 会被销毁重建，必须在浏览器绘制前就折叠好，
            // 否则会先以完整高度出现、再被压扁 → 页面上下瞬移（闪一下）。
            // 这个观察器只做「折叠/分页」这一件事，而且已经是目标状态就直接返回，不会抖动。
            if (typeof MutationObserver === "function") {
                let lzlQueued = false;
                const lzlObs = new MutationObserver(() => {
                    if (lzlQueued) return;
                    lzlQueued = true;
                    Promise.resolve().then(() => {
                        lzlQueued = false;
                        if (cfg.lzl && cfg.lzlFold) paginateAllLzl();
                    });
                });
                lzlObs.observe(document.documentElement, { childList: true, subtree: true });
            }

            // 菜单命令
            try {
                if (typeof GM_registerMenuCommand === "function") {
                    GM_registerMenuCommand("切换：楼中楼压缩", () => {
                        cfg.lzl = !cfg.lzl;
                        saveCfg();
                        if (cfg.lzl) { applyLzlStyle(); paginateAllLzl(); }
                        else {
                            const s = $("#tbhelper-lzl-style");
                            if (s) s.remove();
                            clearLzlPaging();
                        }
                        toast("楼中楼压缩：" + (cfg.lzl ? "开" : "关"));
                    });
                    GM_registerMenuCommand("切换：楼中楼分页", () => {
                        cfg.lzlFold = !cfg.lzlFold;
                        saveCfg();
                        if (cfg.lzl && cfg.lzlFold) paginateAllLzl();
                        else clearLzlPaging();
                        toast("楼中楼分页：" + (cfg.lzlFold ? "开" : "关"));
                    });
                    GM_registerMenuCommand("诊断捕获面板", () => togglePanel(true));
                }
            } catch (_) { /* ignore */ }

            // 快捷键：Alt+Shift+B 打开设置
            document.addEventListener("keydown", (e) => {
                if (!e.altKey || !e.shiftKey) return;
                if (e.key.toLowerCase() === "b") {
                    const menu = $("#tbhelper-menu");
                    if (menu) menu.dataset.open = menu.dataset.open === "1" ? "0" : "1";
                }
            });
        };

        onReady(run);
        // document-start 时若 html 已存在，尽早把挂起的样式放进去
        if (document.documentElement) flushPending();
    }

    boot();
})();
