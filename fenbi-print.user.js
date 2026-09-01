// ==UserScript==
// @name         粉笔试卷排版打印
// @namespace    http://tampermonkey.net/
// @version      1.8.1
// @description  把粉笔在线试卷（行测 / 申论）一键排版成 A4 真卷：题号悬挂缩进、屏幕直接显示 A4 分页、题目可跨页，支持直接打印或导出 PDF。本地运行，无付费、无次数限制。
// @match        *://spa.fenbi.com/*
// @match        *://www.fenbi.com/spa/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* jshint esversion: 8 */

/*
 * 粉笔试卷排版打印 · 本地自用版
 *
 * 流程：提取（读页面 DOM，产出结构化题目数据）
 *       → 渲染（数据拼成一份自包含的打印用 HTML）
 *       → 输出（新窗口打印，或下载成 .html 文件）
 *
 * 全程在浏览器本地完成，不请求任何自己的服务端；页面上不植入计数、授权、
 * 账号体系相关的任何逻辑，也没有使用次数限制。
 */

(function () {
    'use strict';

    /* ==================================================================
     * 一、配置
     * ================================================================ */

    const VERSION = '1.8.1';
    const STORE_KEY = 'fenbi_print_settings';
    const STORE_POS = 'fenbi_print_panel_pos';
    const STORE_UPD = 'fenbi_print_update_dismiss';
    const TITLE_PLACEHOLDER = '正在读取当前试卷…';

    // 检查更新 / 立即更新 的权威源：GitHub 官方 API（浏览器内可跨域访问，永远返回 main 分支的真实最新文件，无 CDN 缓存滞后）。
    // 之前用 jsDelivr 的 @main 分支地址做更新源，而该地址在 jsDelivr 上有缓存滞后/卡死，导致「检查更新」永远读到旧快照、报「已是最新」。
    // 现改为直接拉 GitHub API 取真实最新版（含完整脚本内容），下载也直接用 API 返回的内容就地重注入，彻底摆脱 CDN 滞后。
    // 仅当 GitHub API 不可达时，才回退到 jsDelivr @main 兜底（可能滞后，但总比没有强）。
    // 更新逻辑完全内建、硬编码，不依赖小书签代码——书签链接永远锁 @main，今后无需任何改动即可更新。
    const GH_API = 'https://api.github.com/repos/zoij1033/fenbi-print/contents/fenbi-print.user.js?ref=main';
    const UPDATE_FB_URL = 'https://cdn.jsdelivr.net/gh/zoij1033/fenbi-print@main/fenbi-print.user.js';
    // 旧版 version.json 托管方案已废弃
    const REMOTE = '';

    // 题号悬挂缩进是固定排版，不提供开关
    const HANG = 2.0;      // 题干悬挂宽度（em）：没有按题计算时的兜底值，容纳三位数题号
    const OPT_HANG = 1.25; // 选项悬挂宽度（em），够容纳 "A." / "A"

    const DEFAULTS = {
        cover: true,           // 默认勾选：打印封面页（含缓冲页）
        // 署名是写死在卷子里的，面板不提供入口
        signature: '工具支持 小红书@火焰百合',
        margin: '15mm 15mm',
        fontSize: 15,
        lineHeight: 1.6,
        qSpacing: 18,
        pagination: 'smart',
        figScale: 65,
        shenlunMode: 'none',   // none = 不留作答区；auto = 按题目字数算；fixed = 固定高度
        shenlunSpace: 8,       // 仅在 fixed 模式下生效（cm）
        qrcode: true,
        countdown: 10,
        autoPrint: true
    };

    // 排版相关的数值边界，防止乱填导致样式崩坏
    const LIMITS = {
        fontSize: [10, 24],
        lineHeight: [1.2, 2.4],
        qSpacing: [0, 120],
        figScale: [20, 100],
        shenlunSpace: [0, 30],
        countdown: [0, 30]
    };

    /* ==================================================================
     * 二、小工具
     * ================================================================ */

    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 用户输入写进 HTML 前一律转义，避免破坏生成页结构
    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /* ---------- 更新相关小工具（检查更新 / 立即更新 共用） ---------- */

    // 在面板底部 #fp-update 框里显示一行状态。
    // cls 为 '' / 'busy' / 'ok' / 'err'，分别对应 CSS 中 .fp-update 及其子类的样式；
    // 空 cls 表示「发现新版本」提示态（带「立即更新」链接与忽略 ×）。
    function renderUpdate(text, cls) {
        const box = $('fp-update');
        if (!box) return;
        box.className = 'fp-update' + (cls ? ' ' + cls : '');
        box.innerHTML = text;
        box.style.display = 'flex';
    }

    // 从脚本源码里抠出版本号（const VERSION = 'x.y.z'），拿不到返回 null。
    function extractVersion(txt) {
        if (!txt) return null;
        const m = txt.match(/const\s+VERSION\s*=\s*['"]([^'"]+)['"]/);
        return m ? m[1] : null;
    }

    // 语义化版本比较：a 新于 b 返回 >0，a 旧于 b 返回 <0，相等返回 0。
    function cmpVer(a, b) {
        const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
        const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
            if ((pa[i] || 0) > (pb[i] || 0)) return 1;
            if ((pa[i] || 0) < (pb[i] || 0)) return -1;
        }
        return 0;
    }

    // 量出一段文本在当前题号字体下的宽度（em，相对字号），用于在渲染前
    // 按题号实际占宽算出每题各自的悬挂列宽，让「题号.题干」间隙恒定可控。
    let _fpMeasureCtx = null;
    function textWidthEm(s, fs) {
        if (!s) return 0;
        if (!_fpMeasureCtx) _fpMeasureCtx = document.createElement('canvas').getContext('2d');
        _fpMeasureCtx.font = `${fs}px "Times New Roman","SimSun",serif`;
        return _fpMeasureCtx.measureText(s).width / fs;
    }

    // 填空线：用一条 border-bottom 画出来，不再拼接全角下划线字符
    // 拼接字符会随字体不同出现重叠、断口、粗细不一，画线则永远是一整条
    const BLANK_HTML = '<span class="fp-ul"></span>';
    const BLANK_RE1 = /(?:_{4,}|＿{2,})/g;                    // ____ 或 ＿＿
    const BLANK_RE2 = /(?:&nbsp;|[\u00a0\u3000]){4,}/g;       // 连续不断行空格 / 全角空格

    // 只在标签外的文本里替换，避免把属性值里的下划线也改成标签
    function blankify(html) {
        if (!html) return html;
        return String(html).split(/(<[^>]*>)/).map((seg, i) => {
            if (i % 2 === 1) return seg;
            return seg.replace(BLANK_RE1, BLANK_HTML).replace(BLANK_RE2, BLANK_HTML);
        }).join('');
    }

    // 选项内容常常整段包在 <p> 里。把 p 解开成行内流，
    // 悬挂缩进（padding-left + 负 text-indent）才能作用在行内，
    // 换行后的文字才对得齐字母右侧；否则字母会在 p 的上一行孤零零地悬着。
    // 选项内容只要外面套了一层块级盒子（p/div/app-format-html 都算），
    // 浏览器就会在字母后面断行 —— 看上去就是「A. 一行、内容一行」。
    // 这里把纯文字的块级外壳统统拆掉，让内容跟字母待在同一个行内流里。
    const OPT_BLOCK = /^(P|DIV|SECTION|ARTICLE|APP-FORMAT-HTML|H[1-6]|LI|DD|DT)$/;
    function flattenOpt(html) {
        if (!html || html.indexOf('<') < 0) return html;
        const d = document.createElement('div');
        d.innerHTML = html;
        // 有图片/表格这类必须保持块状的，整个不动，交给 CSS 单独排
        if (d.querySelector('img, table, svg, canvas, ul, ol, dl, pre')) return html;
        const out = [];
        (function walk(node) {
            const kids = node.childNodes;
            for (let i = 0; i < kids.length; i++) {
                const c = kids[i];
                if (c.nodeType === 3) { out.push(c.nodeValue); continue; }
                if (c.nodeType !== 1) continue;
                if (c.tagName === 'BR') { out.push(' '); continue; }
                if (OPT_BLOCK.test(c.tagName)) walk(c);
                else out.push(c.outerHTML);
            }
        })(d);
        const s = out.join('').replace(/\s+/g, ' ').trim();
        return s || html;
    }

    // 数值设置：非法输入一律回退到默认值
    function num(v, def, key) {
        const n = parseFloat(v);
        if (!isFinite(n)) return def;
        const range = LIMITS[key];
        if (!range) return n;
        return Math.min(range[1], Math.max(range[0], n));
    }

    const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
    // 题号规范化：粉笔某些题型（材料分析、申论小题等）没有数字题号时，DOM 里偶尔出现
    // 字面量「null」占位。这里统一归零为空，避免试卷里印出「null.」这种字样。
    const normNum = (s) => { const t = (s == null ? '' : String(s)).trim(); return (/^null$/i.test(t) ? '' : t); };

    // 估算一段文本占多宽：全角字符记 1，半角（ASCII）记 0.55，单位是「字号的倍数」
    function cjkUnits(s) {
        let u = 0;
        for (let i = 0; i < s.length; i++) u += s.charCodeAt(i) < 128 ? 0.55 : 1;
        return u;
    }

    // 找到页面里真正在滚动的容器（懒加载触发点），否则退回 window
    function findScroller() {
        const sels = ['.tis-container', '.question-container', '.paper-container', '[class*="scroll"]'];
        for (const sel of sels) {
            let el = null;
            try { el = document.querySelector(sel); } catch (e) { /* 选择器异常则跳过 */ }
            if (el && el.scrollHeight > el.clientHeight + 80) return el;
        }
        let node = document.querySelector('app-ti') || document.querySelector('.chapter-container');
        while (node && node !== document.body && node !== document.documentElement) {
            try {
                const st = getComputedStyle(node);
                if (/(auto|scroll|overlay)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 80) return node;
            } catch (e) { /* 忽略 */ }
            node = node.parentElement;
        }
        if (document.documentElement.scrollHeight > window.innerHeight + 80) return window;
        return document.querySelector('.tis-container') || window;
    }

    /* ==================================================================
     * 三、设置持久化
     * ================================================================ */

    function readSettings() {
        const s = {};
        try { Object.assign(s, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch (e) { /* 忽略 */ }
        Object.keys(DEFAULTS).forEach((k) => {
            if (!(k in s)) s[k] = DEFAULTS[k];
        });
        return s;
    }

    function saveSettings() {
        const s = {};
        const ids = {
            cover: 'fp-cover', margin: 'fp-margin', fontSize: 'fp-fontSize',
            lineHeight: 'fp-lineHeight', qSpacing: 'fp-qSpacing',
            pagination: 'fp-pagination', figScale: 'fp-figScale',
            shenlunMode: 'fp-shenlunMode', shenlunSpace: 'fp-shenlunSpace',
            qrcode: 'fp-qrcode', countdown: 'fp-countdown',
            autoPrint: 'fp-autoPrint'
        };
        Object.keys(ids).forEach((k) => {
            const el = $(ids[k]);
            if (!el) return;
            s[k] = el.type === 'checkbox' ? el.checked : el.value;
        });
        try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* 忽略 */ }
    }

    function applySettings(s) {
        const ids = {
            cover: 'fp-cover', margin: 'fp-margin', fontSize: 'fp-fontSize',
            lineHeight: 'fp-lineHeight', qSpacing: 'fp-qSpacing',
            pagination: 'fp-pagination', figScale: 'fp-figScale',
            shenlunMode: 'fp-shenlunMode', shenlunSpace: 'fp-shenlunSpace',
            qrcode: 'fp-qrcode', countdown: 'fp-countdown',
            autoPrint: 'fp-autoPrint'
        };
        Object.keys(ids).forEach((k) => {
            const el = $(ids[k]);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = !!s[k];
            else el.value = s[k];
        });
    }

    // 把当前面板状态读成排版参数（带边界钳制）
    function collectOptions() {
        const s = readSettings();
        return {
            cover: !!$('fp-cover').checked,
            // 署名固定，没有面板入口，也不提供关闭开关
            signature: DEFAULTS.signature,
            margin: $('fp-margin').value,
            fontSize: num($('fp-fontSize').value, s.fontSize, 'fontSize'),
            lineHeight: num($('fp-lineHeight').value, s.lineHeight, 'lineHeight'),
            qSpacing: num($('fp-qSpacing').value, s.qSpacing, 'qSpacing'),
            pagination: $('fp-pagination').value,
            figScale: num($('fp-figScale').value, s.figScale, 'figScale'),
            shenlunMode: $('fp-shenlunMode').value,
            shenlunSpace: num($('fp-shenlunSpace').value, s.shenlunSpace, 'shenlunSpace'),
            qrcode: !!$('fp-qrcode').checked,
            countdown: num($('fp-countdown').value, s.countdown, 'countdown'),
            autoPrint: !!$('fp-autoPrint').checked,
            title: ($('fp-title').value || '').trim() || readPaperTitle()
        };
    }

    // 从页面读取当前试卷标题
    function readPaperTitle() {
        for (const sel of ['.header-title', '.paper-name', '.header-center .title']) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const t = el.getAttribute('title') || text(el);
            if (t) return t.trim();
        }
        if (document.title) return document.title.trim();
        return '公务员录用考试试卷';
    }

    function getPaperId() {
        const m = window.location.href.match(/\/exercise\/([^?&/]+)/);
        return m ? m[1] : null;
    }

    /* ==================================================================
     * 四、界面
     * ================================================================ */

    function injectStyle() {
        const css = `
#fp-mask{position:fixed;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(3px);z-index:9999990;display:none;align-items:center;justify-content:center;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
#fp-mask-box{background:#181b21;border:1px solid #2e333d;border-radius:10px;padding:28px 34px;min-width:280px;max-width:380px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.7)}
.fp-spin{width:38px;height:38px;border:3px solid #2e333d;border-top-color:#4dd0e1;border-radius:50%;animation:fp-rot .8s linear infinite;margin:0 auto 14px}
@keyframes fp-rot{to{transform:rotate(360deg)}}
#fp-mask-title{font-size:15px;font-weight:700;color:#e6eaf0;margin-bottom:6px}
#fp-mask-sub{font-size:12px;color:#8b95a3;line-height:1.6;white-space:pre-line}

.fp-panel{position:fixed;top:110px;right:20px;width:302px;background:#181b21;border:1px solid #2e333d;border-radius:10px;box-shadow:0 20px 50px rgba(0,0,0,.55);padding:0;z-index:9999989;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#d7dce3;box-sizing:border-box;max-height:calc(100vh - 140px);overflow:hidden;display:flex;flex-direction:column}
.fp-scroll{flex:1 1 auto;min-height:0;margin:20px 0;padding:0 16px;overflow-y:auto;scrollbar-gutter:stable both-edges;scrollbar-width:thin;scrollbar-color:#333a45 transparent}
.fp-scroll::-webkit-scrollbar{width:8px}
.fp-scroll::-webkit-scrollbar-track{background:transparent}
.fp-scroll::-webkit-scrollbar-thumb{background:#333a45;border-radius:4px}
.fp-scroll::-webkit-scrollbar-thumb:hover{background:#414a58}
.fp-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px;cursor:move;user-select:none;border-bottom:1px solid #2e333d;padding-bottom:11px}
.fp-brand{display:flex;align-items:center;gap:8px}
.fp-emoji{font-size:18px;line-height:1}
.fp-name{font-size:15px;font-weight:700;color:#e6eaf0;letter-spacing:.3px}
.fp-mini{font-size:12px;color:#648CFC;cursor:pointer;padding:4px 9px;border-radius:6px;user-select:none;background:#22262e}
.fp-mini:hover{background:#2b323d;color:#8aa6fd}
.fp-x{font-size:18px;color:#6b7583;cursor:pointer;padding:2px 7px;border-radius:6px;line-height:1}
.fp-x:hover{color:#e6eaf0;background:#2b323d}
.fp-field{margin-bottom:12px}
.fp-label{display:block;font-size:11.5px;font-weight:600;color:#8b95a3;margin-bottom:5px;letter-spacing:.4px}
.fp-input,.fp-select{width:100%;padding:8px 10px;box-sizing:border-box;border:1px solid #3a4049;border-radius:6px;font-size:13px;color:#e6eaf0;background:#22262e;outline:none;font-family:inherit}
.fp-input::placeholder{color:#5c6674}
.fp-input:focus,.fp-select:focus{border-color:#4dd0e1;box-shadow:0 0 0 3px rgba(77,208,225,.15)}
.fp-select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,#8b95a3 50%),linear-gradient(135deg,#8b95a3 50%,transparent 50%);background-position:calc(100% - 15px) 50%,calc(100% - 10px) 50%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:28px}
.fp-check{display:flex;align-items:center;font-size:13px;color:#d7dce3;cursor:pointer;gap:8px;user-select:none}
.fp-check input{width:15px;height:15px;accent-color:#648CFC;margin:0;background:#22262e}
.fp-input[type=number]::-webkit-inner-spin-button,.fp-input[type=number]::-webkit-outer-spin-button{color:#648CFC;opacity:1}
.fp-hint{font-size:11px;color:#6b7583;margin-top:4px;line-height:1.5}
.fp-stat{font-size:12px;color:#8b95a3;margin-bottom:0;line-height:1.6;min-height:0}
/* 状态文字（共 X 题 / Y 份材料 等）出现时才在下方撑出间距，
   把按钮推下去；空着时不占空间，不会提前预留一块空白给提示词 */
.fp-stat:not(:empty){margin-bottom:12px}
.fp-stat b{color:#4dd0e1}
.fp-preview-btn{width:100%;padding:13px;background:#252a33;color:#a8b2bf;border:1px solid #3a4049;border-radius:8px;cursor:pointer;font-size:15px;font-weight:700;font-family:inherit;transition:background .15s;margin-bottom:14px}
.fp-preview-btn:hover{background:#2f353f;color:#d7dce3}
.fp-preview-btn:active{transform:translateY(1px)}
.fp-btns{display:flex;gap:8px;margin-bottom:12px}
.fp-btn{flex:2;background:#2F7FE0;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:14px;font-weight:700;font-family:inherit;transition:background .15s}
.fp-btn:hover{background:#4f9af0}
.fp-btn:active{transform:translateY(1px)}
.fp-btn:disabled{background:#3a4049;color:#6b7583;cursor:wait}
.fp-btn2{flex:1;padding:11px;background:#252a33;color:#a8b2bf;border:1px solid #3a4049;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;transition:background .15s}
.fp-btn2:hover{background:#2f353f;color:#d7dce3}
.fp-adv{display:none;margin-top:14px;padding-top:13px;border-top:1px dashed #333a45}
.fp-row{display:flex;gap:10px}
.fp-row>.fp-field{flex:1}
.fp-foot{margin-top:12px;padding-top:9px;font-size:11px;color:#5c6674;text-align:center;letter-spacing:1px;border-top:1px solid #2e333d}
.fp-contact{display:none;margin-top:12px;margin-bottom:8px;font-size:11px;color:#4dd0e1;text-align:center;text-decoration:none;cursor:pointer}
.fp-contact:hover{text-decoration:underline}
.fp-update{display:none;align-items:center;gap:8px;margin-top:10px;padding:9px 11px;border-radius:6px;background:#1f2731;border:1px solid #3a4049;color:#a8b2bf;font-size:12px;line-height:1.5}
.fp-update a{color:#4dd0e1;font-weight:700;text-decoration:none;white-space:nowrap;flex-shrink:0}
.fp-update i{margin-left:auto;font-style:normal;cursor:pointer;color:#8b95a3;padding:0 4px;flex-shrink:0}
.fp-update.ok{background:#16261c;border-color:#2f5d3c;color:#7ee2a8}
.fp-update.ok a{display:none}
.fp-update.busy{background:#1f2731;border-color:#3a4049;color:#8b95a3}
.fp-update.busy a,.fp-update.busy i{display:none}
.fp-update.err{background:#2b1a1a;border-color:#6b3030;color:#f0a0a0}
.fp-update.err a{display:none}

/* ===== 调整预览浮层 ===== */
.fp-prev{position:fixed;inset:0;z-index:9999996;background:rgba(12,14,17,.94);display:none;flex-direction:column;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.fp-prev.show{display:flex}
.fp-prev-bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 16px;background:#181b21;border-bottom:1px solid #2e333d}
.fp-prev-brand{display:flex;align-items:center;gap:7px;font-size:14px;font-weight:700;color:#e6eaf0;white-space:nowrap}
.fp-prev-brand .fp-emoji{font-size:16px}
.fp-prev-ctl{display:flex;align-items:center;gap:5px}
.fp-prev-ctl label{font-size:11px;color:#8b95a3;white-space:nowrap}
.fp-prev-ctl input[type=number]{width:56px;padding:5px 7px;box-sizing:border-box;border:1px solid #3a4049;border-radius:6px;font-size:12px;color:#e6eaf0;background:#22262e;outline:none;font-family:inherit}
.fp-prev-ctl input[type=number]:focus,.fp-prev-ctl select:focus{border-color:#4dd0e1;box-shadow:0 0 0 3px rgba(77,208,225,.15)}
.fp-prev-ctl select{width:auto;padding:5px 24px 5px 8px;box-sizing:border-box;border:1px solid #3a4049;border-radius:6px;font-size:12px;color:#e6eaf0;background:#22262e;outline:none;font-family:inherit;appearance:none;background-image:linear-gradient(45deg,transparent 50%,#8b95a3 50%),linear-gradient(135deg,#8b95a3 50%,transparent 50%);background-position:calc(100% - 13px) 50%,calc(100% - 8px) 50%;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.fp-prev-ctl input[type=checkbox]{width:14px;height:14px;accent-color:#648CFC;margin:0}
.fp-prev-sp{flex:1 1 auto}
.fp-prev-bar .fp-btn{background:#2F7FE0;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:700;font-family:inherit;padding:9px 16px;white-space:nowrap}
.fp-prev-bar .fp-btn:hover{background:#4f9af0}
.fp-prev-bar .fp-btn2{background:#252a33;color:#a8b2bf;border:1px solid #3a4049;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;padding:9px 14px;white-space:nowrap}
.fp-prev-bar .fp-btn2:hover{background:#2f353f;color:#d7dce3}
.fp-prev-x{flex:0 0 auto;font-size:18px;color:#6b7583;cursor:pointer;padding:4px 9px;border-radius:6px;line-height:1}
.fp-prev-x:hover{color:#e6eaf0;background:#2b323d}
.fp-prev-frame{flex:1 1 auto;width:100%;border:0;background:#e5e7eb}
`;
        const el = document.createElement('style');
        el.id = 'fp-style';
        el.textContent = css;
        document.head.appendChild(el);
    }

    function buildPanel() {
        const mask = document.createElement('div');
        mask.id = 'fp-mask';
        mask.innerHTML = `<div id="fp-mask-box"><div class="fp-spin"></div><div id="fp-mask-title">正在排版…</div><div id="fp-mask-sub">题目较多时需要十几秒，请稍候</div></div>`;
        document.body.appendChild(mask);

        const panel = document.createElement('div');
        panel.className = 'fp-panel';
        panel.id = 'fp-panel';
        panel.innerHTML = `
<div class="fp-scroll">
<div class="fp-head" id="fp-drag">
    <div class="fp-brand"><span class="fp-emoji">✨</span><span class="fp-name">试卷排版打印</span></div>
    <div><span class="fp-mini" id="fp-toggle">设置 ▾</span><span class="fp-x" id="fp-close" title="关闭（刷新页面重现）">×</span></div>
</div>

<div class="fp-field">
    <label class="fp-label">试卷标题</label>
    <!-- 占位提示走 placeholder 而不是 value：value 一留空，生成时就会实时去页面读真实
         试卷名（见 opt.title 的取值）。早先把占位文字放在 value 里，用户手快在标题回填
         之前就点生成，卷子封面上会直接印出「正在读取当前试卷…」。 -->
    <input type="text" id="fp-title" placeholder="${TITLE_PLACEHOLDER}" class="fp-input">
</div>
<div class="fp-stat" id="fp-stat"></div>

<div class="fp-btns">
    <button id="fp-print" class="fp-btn">排版并打印</button>
    <button id="fp-save" class="fp-btn2" title="导出为 PDF：浏览器会弹出打印对话框，目标选「另存为 PDF」即可保存">导出为 PDF</button>
</div>

<div class="fp-field"><label class="fp-check"><input type="checkbox" id="fp-cover" checked> 打印封面页</label>
    <div class="fp-hint">默认勾选</div>
</div>
<div class="fp-field"><label class="fp-check"><input type="checkbox" id="fp-autoPrint"> 生成后自动唤起打印</label></div>

<div class="fp-adv" id="fp-adv">
    <button id="fp-preview" class="fp-preview-btn" title="先生成可滚动预览，在预览里实时调字号 / 行距 / 间距 / 页边距，满意后再打印或导出">文本调整预览</button>
    <div class="fp-field">
        <label class="fp-label">页边距</label>
        <select id="fp-margin" class="fp-select">
            <option value="25mm 20mm">宽松</option>
            <option value="15mm 15mm">标准</option>
            <option value="10mm 10mm">紧凑</option>
        </select>
    </div>
    <div class="fp-row">
        <div class="fp-field"><label class="fp-label">字号</label><input type="number" id="fp-fontSize" class="fp-input"></div>
        <div class="fp-field"><label class="fp-label">行距</label><input type="number" id="fp-lineHeight" step="0.05" class="fp-input"></div>
    </div>
    <div class="fp-field"><label class="fp-label">题目间距 (px)</label><input type="number" id="fp-qSpacing" class="fp-input"></div>
    <div class="fp-field">
        <label class="fp-label">换页方式</label>
        <select id="fp-pagination" class="fp-select">
            <option value="smart">智能平衡 · 题干按段、选项整行（推荐）</option>
            <option value="ultra">极致省纸 · 单个选项也能拆</option>
            <option value="whole">整题不拆 · 页尾留白最多</option>
        </select>
        <div class="fp-hint">三档决定「页尾放不下时最小能拆到多细」：智能平衡留白最少又不会把一行四个选项劈成 3+1；极致省纸填得最满；整题不拆最整洁但会空掉一截</div>
    </div>
    <div class="fp-field">
        <label class="fp-label">大图缩放 (%)</label>
        <input type="number" id="fp-figScale" class="fp-input">
        <div class="fp-hint">只对实际宽度超过 150px 的图生效，分数公式之类的小图不动</div>
    </div>
    <div class="fp-field">
        <label class="fp-label">申论作答区</label>
        <select id="fp-shenlunMode" class="fp-select">
            <option value="none">不留作答区（默认）</option>
            <option value="auto">按题目字数自动算</option>
            <option value="fixed">固定高度</option>
        </select>
        <div class="fp-hint">仅申论生效。</div>
    </div>
    <div class="fp-field" id="fp-shenlunFixed" style="display:none">
        <label class="fp-label">作答区高度 (cm)</label>
        <input type="number" id="fp-shenlunSpace" class="fp-input">
        <div class="fp-hint">一般小题填 6～10，大作文填 20～26</div>
    </div>
    <div class="fp-field"><label class="fp-check"><input type="checkbox" id="fp-qrcode"> 末页附对答案二维码</label>
        <div class="fp-hint">需联网生成；取不到会自动隐藏，不影响正文</div>
    </div>
    <div class="fp-field">
        <label class="fp-label">关闭页面倒计时 (秒)</label>
        <input type="number" id="fp-countdown" class="fp-input">
        <div class="fp-hint">打印对话框一关闭就开始倒数，到时自动关闭页面；期间点「留在页面」可取消，填 0 则不自动关闭</div>
    </div>
    <button id="fp-reset" class="fp-btn2" style="width:100%">恢复默认设置</button>
    <button id="fp-check" class="fp-btn2" style="width:100%;margin-top:8px">检查更新</button>
</div>

<div class="fp-update" id="fp-update"></div>
    <a class="fp-contact" id="fp-contact" href="https://www.xiaohongshu.com/user/profile/6864dfd9000000001d01781a" target="_blank" rel="noopener">联系作者</a>
<div class="fp-foot">v${VERSION}</div>
</div>`;
        document.body.appendChild(panel);
        return { panel, mask };
    }

    // 申论作答区选「固定高度」时才把高度输入框显示出来
    function syncShenlunUI() {
        const sel = $('fp-shenlunMode'), box = $('fp-shenlunFixed');
        if (sel && box) box.style.display = sel.value === 'fixed' ? 'block' : 'none';
    }

    function bindPanel(panel, mask, onPrint, onSave, onPreview) {
        // 折叠
        const adv = $('fp-adv'), toggle = $('fp-toggle');
        toggle.addEventListener('click', () => {
            const willOpen = adv.style.display !== 'block';
            adv.style.display = willOpen ? 'block' : 'none';
            toggle.textContent = willOpen ? '收起 ▴' : '设置 ▾';
            // 联系作者随「设置」展开/收起：展开时显示，收起时隐藏
            const c = $('fp-contact');
            if (c) c.style.display = willOpen ? 'block' : 'none';
        });
        $('fp-close').addEventListener('click', () => { panel.style.display = 'none'; });

        // 拖动 + 位置记忆
        try {
            const pos = JSON.parse(localStorage.getItem(STORE_POS) || 'null');
            if (pos && typeof pos.top === 'number') {
                panel.style.top = pos.top + 'px';
                panel.style.left = pos.left + 'px';
                panel.style.right = 'auto';
            }
        } catch (e) { /* 忽略 */ }

        let dragging = false, sx = 0, sy = 0, ot = 0, ol = 0;
        $('fp-drag').addEventListener('mousedown', (e) => {
            if (e.target.closest('.fp-mini') || e.target.closest('.fp-x')) return;
            const r = panel.getBoundingClientRect();
            ot = r.top; ol = r.left; sx = e.clientX; sy = e.clientY;
            panel.style.right = 'auto';
            panel.style.top = ot + 'px';
            panel.style.left = ol + 'px';
            dragging = true;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const h = panel.offsetHeight;
            panel.style.top = Math.max(0, Math.min(window.innerHeight - 50, ot + e.clientY - sy)) + 'px';
            panel.style.left = Math.max(0, Math.min(window.innerWidth - 60, ol + e.clientX - sx)) + 'px';
            void h;
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            const r = panel.getBoundingClientRect();
            try { localStorage.setItem(STORE_POS, JSON.stringify({ top: Math.round(r.top), left: Math.round(r.left) })); } catch (e) { /* 忽略 */ }
        });

        // 窗口被拉窄 / 拉矮时，把面板重新夹回可视区，避免被推出屏幕（拖拽能力保留）
        const clampPanel = () => {
            if (panel.style.display === 'none') return;
            const w = panel.offsetWidth, h = panel.offsetHeight;
            const r = panel.getBoundingClientRect();
            let left = r.left, top = r.top, changed = false;
            if (left + w > window.innerWidth - 4) { left = Math.max(4, window.innerWidth - w - 4); changed = true; }
            if (left < 4) { left = 4; changed = true; }
            if (top + h > window.innerHeight - 4) { top = Math.max(4, window.innerHeight - h - 4); changed = true; }
            if (top < 4) { top = 4; changed = true; }
            if (changed) {
                panel.style.right = 'auto';
                panel.style.left = left + 'px';
                panel.style.top = top + 'px';
            }
        };
        window.addEventListener('resize', clampPanel);

        // 设置变更即存
        panel.querySelectorAll('input, select').forEach((el) => {
            el.addEventListener('input', saveSettings);
            el.addEventListener('change', saveSettings);
        });
        const sm = $('fp-shenlunMode');
        if (sm) sm.addEventListener('change', syncShenlunUI);

        $('fp-reset').addEventListener('click', () => {
            applySettings(DEFAULTS);
            syncShenlunUI();
            saveSettings();
        });
        $('fp-check').addEventListener('click', () => checkUpdate(true));

        $('fp-print').addEventListener('click', onPrint);
        $('fp-save').addEventListener('click', onSave);
        const pv = $('fp-preview');
        if (pv) pv.addEventListener('click', onPreview);
    }

    // 任何 null/undefined 都归零为空串——否则 element.innerHTML = null 会被浏览器
    // 渲染成字面量「null」，这正是面板偶发显示「null」的根因之一。
    function setStatus(html) { const el = $('fp-stat'); if (el) el.innerHTML = (html == null ? '' : html); }
    function showMask(title, sub) {
        if (title) $('fp-mask-title').textContent = title;
        if (sub) $('fp-mask-sub').textContent = sub;
        $('fp-mask').style.display = 'flex';
    }
    function hideMask() { $('fp-mask').style.display = 'none'; }

    /* ---------- 检查更新（GitHub API 真源，无 CDN 滞后） ---------- */

    // base64 解码（兼容中文/Unicode）：GitHub API 返回的是 base64 编码的 UTF-8 文本
    function decodeBase64(b64) {
        try { return decodeURIComponent(escape(atob(b64))); }
        catch (e) { return atob(b64); }
    }

    // 解析最新脚本：主源 GitHub API（真实最新、无滞后），失败回退 jsDelivr @main 兜底。
    // 返回 { txt }：txt 为完整脚本源码，可直接就地重注入。
    function resolveLatest() {
        const t = Date.now();
        return fetch(GH_API, { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
            .then(function (d) {
                if (!d || !d.content) return Promise.reject(new Error('empty'));
                const txt = decodeBase64(d.content.replace(/[\s\r\n]/g, ''));
                if (!extractVersion(txt)) return Promise.reject(new Error('no-version'));
                return { txt: txt };
            })
            .catch(function (e) {
                return fetch(UPDATE_FB_URL + '?t=' + t, { cache: 'no-store' })
                    .then(function (r) { return r.ok ? r.text() : Promise.reject(e); })
                    .then(function (txt) {
                        if (!extractVersion(txt)) return Promise.reject(e);
                        return { txt: txt };
                    });
            });
    }

    // 检查更新：直接拉 GitHub API 取真实最新版（无 CDN 滞后）与本地比对。
    // manual=true：手动点「检查更新」，无论结果都给反馈；false：仅发现新版本才提示。
    function checkUpdate(manual) {
        const box = $('fp-update');
        if (manual && box) renderUpdate('正在检查更新…', 'busy');
        resolveLatest()
            .then(function (res) {
                const rv = extractVersion(res.txt);
                if (!rv) {
                    if (manual) renderUpdate('未能读取远程版本号，请稍后重试 <i id="fp-update-x">×</i>', 'err');
                    else if (box) box.style.display = 'none';
                } else if (cmpVer(rv, VERSION) > 0) {
                    renderUpdate('<span>发现新版本 <b>v' + esc(rv) + '</b>（当前 v' + esc(VERSION) + '）</span>' +
                        '<a id="fp-update-now" href="javascript:void(0)">立即更新</a>' +
                        '<i id="fp-update-x" title="忽略">×</i>', '');
                    const now = $('fp-update-now');
                    if (now) now.addEventListener('click', function () { forceUpdate(); });
                } else if (manual) {
                    renderUpdate('已是最新 <b>v' + esc(VERSION) + '</b> ✓ <i id="fp-update-x">×</i>', 'ok');
                } else if (box) {
                    box.style.display = 'none';
                }
                const x = $('fp-update-x');
                if (x) x.addEventListener('click', function () { box.style.display = 'none'; });
            })
            .catch(function () {
                if (manual) renderUpdate('检查失败：网络或跨域受限，请稍后重试 <i id="fp-update-x">×</i>', 'err');
                else if (box) box.style.display = 'none';
                const x = $('fp-update-x');
                if (x) x.addEventListener('click', function () { box.style.display = 'none'; });
            });
    }

    // 立即更新：拉取最新脚本并就地重注入。设置仍从 localStorage 读取。
    function forceUpdate() {
        const box = $('fp-update');
        if (box) renderUpdate('正在从 GitHub 拉取最新版…', 'busy');
        resolveLatest()
            .then(function (res) {
                ['fp-panel', 'fp-mask', 'fp-done', 'fp-loading', 'fp-style'].forEach(function (id) {
                    const el = document.getElementById(id);
                    if (el && el.parentNode) el.parentNode.removeChild(el);
                });
                const sc = document.createElement('script');
                sc.textContent = res.txt;
                document.head.appendChild(sc);
            })
            .catch(function () {
                if (box) renderUpdate('更新失败：网络或跨域受限 <i id="fp-update-x">×</i>', 'err');
                const x = $('fp-update-x');
                if (x) x.addEventListener('click', function () { box.style.display = 'none'; });
            });
    }

    /* ==================================================================
     * 五、提取层：页面 DOM → 结构化数据
     *
     *   统一产出 items 数组，元素形如：
     *     { kind:'chapter',  name, desc }
     *     { kind:'material', html, index }
     *     { kind:'question', num, stemHtml, options:[{letter, html}], figure, key }
     * ================================================================ */

    // 清掉页面上纯交互用的控件，避免被一起印出来
    const JUNK_SELECTOR = [
        '.tooltip-container', '.label-tab', '.material-tabs', '.material-tab',
        '.tabs', '.tabs-content', '.tab-list', '.material-nav',
        '.material-select', '.select-material', '.analysis', '.answer-wrap'
    ].join(',');

    function cleanClone(node) {
        const c = node.cloneNode(true);
        c.querySelectorAll(JUNK_SELECTOR).forEach((e) => e.remove());
        // 去掉「请选择材料」这类导航串（形如：材料一 材料二 材料三…）
        c.querySelectorAll('*').forEach((n) => {
            const t = text(n);
            if (t && /材料\s*[一二三四五六七八九十\d]+[\s\S]*材料\s*[一二三四五六七八九十\d]+/.test(t)) n.remove();
            if (n.children.length === 0 && /^请选择材料$|^选择材料$/.test(t)) n.remove();
        });
        return c;
    }

    // 题干：抓 app-format-html，取不到再退到 article.content
    function pickStem(ti) {
        const box = ti.querySelector('app-format-html') || ti.querySelector('article.content');
        if (!box) return '';
        // 过长的下划线/空格统一成等长填空线，避免撑破版面
        return blankify(box.innerHTML);
    }

    // 选项：返回 [{letter, html, units, imgW}]
    // 列数布局不在这里定 —— 那依赖字号与页边距，交给渲染层算
    function pickOptions(ti) {
        const nodes = ti.querySelectorAll('li[class*="choice"], .option-item');
        const empty = { options: [], allImage: false, hasBigImg: false, maxUnits: 0, maxImgW: 0 };
        if (!nodes.length) return empty;

        let allImage = true, hasBigImg = false;
        const raw = [];

        nodes.forEach((opt, i) => {
            const labelNode = opt.querySelector('.choice-radio-label') || opt;
            const clone = labelNode.cloneNode(true);

            // 选项字母：粉笔把它放在 .input-radio 里（有时在 label 内，有时与 label 平级）。
            // 早先的做法是删掉这个节点、渲染时另起一列补一个字母 —— 两个盒子基线
            // 对不齐，看着有高度落差；而且为了去掉「重复的前导字母」去削正文，
            // 会把 "AB" 这类本身以 A 开头的选项内容削成 "B"。
            // 现在不再动正文一个字符：字母在 label 里就原样留着（只清圆圈装饰），
            // 不在 label 里、且正文开头已经是 "A." 这类写法，也一样原样留着。
            const srcLetter = opt.querySelector('.input-radio');
            let letter = srcLetter ? (srcLetter.innerText || srcLetter.textContent || '').trim() : '';
            if (!letter || letter.length > 3) letter = String.fromCharCode(65 + i);

            const ln = clone.querySelector('.input-radio');
            // 粉笔的字母节点里往往只放了一个 "A"，点号是画在别处的装饰 ——
            // 不补的话排出来就是 "A 选项内容"。凡是光秃秃的字母，统一补个点。
            let hasOwnLetter = false;
            if (ln) {
                const lt = (ln.textContent || '').trim();
                if (/^[A-Za-z]{1,2}$/.test(lt)) {
                    ln.textContent = lt + '.';
                    hasOwnLetter = true;
                } else if (lt) {
                    hasOwnLetter = true;
                }
                ln.classList.add('fp-ol');
            }

            // 只清真正的交互控件 / 装饰空标签，字母载体里面的一律不动
            clone.querySelectorAll('input, button, canvas').forEach((e) => {
                if (ln && ln.contains(e)) return;
                e.remove();
            });
            clone.querySelectorAll('i').forEach((e) => {
                if (ln && ln.contains(e)) return;
                if ((e.textContent || '').trim() === '') e.remove();
            });

            // 量正文宽度时排除字母，免得列宽被多算出一个字母
            const forText = clone.cloneNode(true);
            forText.querySelectorAll('.fp-ol').forEach((e) => e.remove());
            const plain = (forText.innerText || '').replace(/\s+/g, '');
            const hasMedia = !!clone.querySelector('img, svg, canvas');
            if (plain.length > 0 && !/^[A-D.、]$/.test(plain) && !hasMedia) allImage = false;

            // 记录选项里最宽的一张图，供渲染层估算列宽
            let imgW = 0;
            clone.querySelectorAll('img').forEach((img) => {
                const w = parseInt(img.getAttribute('width') || img.style.width || '', 10);
                if (isFinite(w) && w > 0) {
                    if (w > imgW) imgW = w;
                    if (w > 120) hasBigImg = true;
                }
            });

            raw.push({ clone, letter, hasOwnLetter, hasMedia, units: cjkUnits(plain), imgW });
        });

        // 兜底补字母：只有页面上确实没有字母节点、正文开头也不是 "A." 这类
        // 写法时才补。判断必须要求字母后面紧跟分隔符 —— 否则 "AB" 这种
        // 本身以 A 开头的选项内容会被误判成「已经有字母」，反过来又会
        // 被上一版的剥离逻辑削掉一个字符。
        const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        function hasOwnLetterText(holder, letter) {
            const t = (holder.textContent || '').replace(/^[\s\u00a0\u3000]+/, '');
            return new RegExp('^' + escRe(letter) + '\\s*[\\.．。、:：]').test(t);
        }

        const options = raw.map(({ clone, letter, hasOwnLetter, hasMedia, units, imgW }) => {
            const holder = document.createElement('div');
            holder.innerHTML = clone.innerHTML.trim();
            if (!hasOwnLetter && !hasOwnLetterText(holder, letter)) {
                holder.insertAdjacentHTML('afterbegin', `<span class="fp-ol">${esc(letter)}.</span>`);
            }
            return { letter: esc(letter), html: holder.innerHTML.trim(), units, imgW };
        });

        let maxUnits = 0, maxImgW = 0;
        options.forEach((o) => {
            if (o.units > maxUnits) maxUnits = o.units;
            if (o.imgW > maxImgW) maxImgW = o.imgW;
        });

        return { options, allImage, hasBigImg, maxUnits, maxImgW };
    }

    // ---- 行测：滚动加载后直接读取 ----
    async function extractXingce(onProgress, quick) {
        onProgress && onProgress('正在加载全部题目…');

        const scroller = findScroller();
        const isWin = scroller === window;
        const countTis = () => (document.querySelector('.tis-container') || document.body).querySelectorAll('app-ti').length;

        let lastH = -1, lastC = -1, stall = 0;
        const maxIter = quick ? 6 : 25;
        for (let i = 0; i < maxIter; i++) {
            try {
                if (isWin) window.scrollTo(0, document.documentElement.scrollHeight);
                else scroller.scrollTop = scroller.scrollHeight;
                window.scrollTo(0, document.documentElement.scrollHeight);
            } catch (e) { /* 忽略 */ }
            await sleep(quick ? 120 : 200);

            const h = isWin ? document.documentElement.scrollHeight : scroller.scrollHeight;
            const c = countTis();
            if (h === lastH && c === lastC) { if (++stall >= 3) break; } else { stall = 0; }
            lastH = h; lastC = c;
            if (c > 0) onProgress && onProgress(`已加载 ${c} 题…`);
        }
        try {
            if (isWin) window.scrollTo(0, 0); else scroller.scrollTop = 0;
            window.scrollTo(0, 0);
        } catch (e) { /* 忽略 */ }

        const root = document.querySelector('.tis-container') || document.body;
        const nodes = root.querySelectorAll('.chapter-container, app-materials, .material, .material-content, app-ti');

        const items = [];
        let matIndex = 0;

        nodes.forEach((el) => {
            const tag = el.tagName.toLowerCase();

            if (el.classList.contains('chapter-container')) {
                matIndex = 0;
                const name = text(el.querySelector('.chapter-name'));
                const desc = text(el.querySelector('.chapter-desc'));
                if (name) items.push({ kind: 'chapter', name: esc(name), desc: esc(desc) });
                return;
            }

            if (tag === 'app-materials' || el.classList.contains('material') || el.classList.contains('material-content')) {
                // 去重：内层节点已由外层统一处理
                if (el.classList.contains('material-content') && el.closest('app-materials')) return;
                if (el.classList.contains('material-content') && el.closest('.material')) return;
                if (el.classList.contains('material') && el.closest('app-materials')) return;

                if (tag === 'app-materials') {
                    const inners = el.querySelectorAll('.material');
                    if (inners.length > 1) {
                        inners.forEach((m) => {
                            matIndex++;
                            const html = cleanClone(m).innerHTML;
                            items.push({ kind: 'material', html, index: matIndex });
                        });
                        return;
                    }
                }
                matIndex++;
                items.push({ kind: 'material', html: cleanClone(el).innerHTML, index: matIndex });
                return;
            }

            if (tag === 'app-ti') {
                const num = normNum(text(el.querySelector('.title-index')));
                const stemHtml = pickStem(el);
                const picked = pickOptions(el);
                const stemImgs = (() => {
                    const d = document.createElement('div');
                    d.innerHTML = stemHtml;
                    return d.querySelectorAll('img').length;
                })();

                items.push({
                    kind: 'question',
                    num: esc(num),
                    stemHtml,
                    options: picked.options,
                    allImage: picked.allImage,
                    maxUnits: picked.maxUnits,
                    maxImgW: picked.maxImgW,
                    figure: picked.allImage || stemImgs >= 1,
                    key: el.getAttribute('data-question-key') || num || String(items.length)
                });
            }
        });

        return items;
    }

    // ---- 申论：两阶段（先逐个材料 tab，再逐个题目 tab）----
    async function extractShenlun(onProgress) {
        const click = (el) => {
            try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (e) { /* 忽略 */ }
            try { el.click(); } catch (e) { /* 忽略 */ }
        };
        const qTabs = () => {
            let t = document.querySelectorAll('.questions-anchors .tabs-content .tab');
            if (!t.length) t = document.querySelectorAll('.questions-anchors .tab');
            return Array.from(t);
        };
        const matTabs = () => Array.from(document.querySelectorAll('app-materials .tabs-content .tab'))
            .filter((t) => /材料\s*\d+/.test(t.innerText || ''));
        const matNow = () => document.querySelector('app-materials .material-body .material-content')
            || document.querySelector('app-materials .material-content');
        const tiNow = () => document.querySelector('.questions-objective-container app-ti') || document.querySelector('app-ti');
        const keyOf = (ti) => {
            if (!ti) return null;
            const k = ti.getAttribute('data-question-key');
            if (k) return 'k:' + k;
            const idx = ti.querySelector('.title-index');
            return idx ? 'i:' + text(idx) : null;
        };
        const waitSwitch = async (oldKey) => {
            for (let i = 0; i < 30; i++) {
                await sleep(100);
                const k = keyOf(tiNow());
                if (k && k !== oldKey) return true;
            }
            return false;
        };
        const waitMatChange = async (prev) => {
            for (let i = 0; i < 30; i++) {
                await sleep(100);
                const m = matNow();
                if (m) {
                    const t = text(m).slice(0, 200);
                    if (t && t !== prev) { await sleep(200); return matNow(); }
                }
            }
            return matNow();
        };
        const waitTabsStable = async () => {
            let last = -1, same = 0;
            for (let i = 0; i < 30; i++) {
                await sleep(100);
                const n = matTabs().length;
                if (n === last) { if (++same >= 3) return; } else { same = 0; last = n; }
            }
        };

        const items = [];
        const matMap = new Map();
        const questions = [];
        const seen = new Set();

        if (qTabs().length === 0) {
            // 没有题目 tab 的兜底：抓当前可见内容
            const m = matNow();
            if (m) items.push({ kind: 'material', html: cleanClone(m).innerHTML, index: 1 });
            const ti = tiNow();
            if (ti) {
                items.push({ kind: 'chapter', name: '作答要求', desc: '' });
                items.push({
                    kind: 'question', num: esc(normNum(text(ti.querySelector('.title-index')))),
                    stemHtml: pickStem(ti), options: [], maxUnits: 0, maxImgW: 0,
                    allImage: false, figure: false, key: keyOf(ti) || 'q0'
                });
            }
            return items;
        }

        // 阶段一：切到最后一题（此时左侧材料最全），逐个点材料 tab
        onProgress && onProgress('正在展开全部材料…');
        const lastTab = qTabs()[qTabs().length - 1];
        if (lastTab && !lastTab.classList.contains('active')) {
            click(lastTab);
            await waitSwitch(keyOf(tiNow()));
        } else {
            await sleep(400);
        }
        await waitTabsStable();

        const mts = matTabs();
        let prevMat = '';
        for (let j = 0; j < mts.length; j++) {
            const tab = matTabs()[j];
            if (!tab) continue;
            const mm = (tab.innerText || '').match(/材料\s*(\d+)/);
            const n = mm ? parseInt(mm[1], 10) : j + 1;
            if (matMap.has(n)) continue;
            onProgress && onProgress(`正在抓取材料 ${j + 1}/${mts.length}…`);
            click(tab);
            const m = await waitMatChange(prevMat);
            if (m) {
                prevMat = text(m).slice(0, 200);
                matMap.set(n, cleanClone(m).innerHTML);
            }
        }

        // 阶段二：逐个点题目 tab，按 data-question-key 去重
        const total = qTabs().length;
        for (let i = 0; i < total; i++) {
            const tab = qTabs()[i];
            if (!tab) continue;
            onProgress && onProgress(`正在抓取题目 ${i + 1}/${total}…`);
            const wasActive = tab.classList.contains('active');
            const oldKey = keyOf(tiNow());
            click(tab);
            if (wasActive) await sleep(400);
            else if (!(await waitSwitch(oldKey))) {
                const retry = qTabs()[i];
                if (retry) { click(retry); await waitSwitch(oldKey); }
            }
            const ti = tiNow();
            const k = keyOf(ti);
            if (ti && k && !seen.has(k)) {
                seen.add(k);
                questions.push({
                    kind: 'question',
                    num: esc(normNum(text(ti.querySelector('.title-index')))),
                    stemHtml: pickStem(ti),
                    options: [],
                    maxUnits: 0,
                    maxImgW: 0,
                    allImage: false,
                    figure: false,
                    key: k
                });
            }
        }

        // 回到第一题，避免影响用户继续做题
        const first = qTabs()[0];
        if (first) { click(first); await sleep(300); }

        Array.from(matMap.keys()).sort((a, b) => a - b).forEach((n) => {
            items.push({ kind: 'material', html: matMap.get(n), index: n });
        });
        if (questions.length) items.push({ kind: 'chapter', name: '作答要求', desc: '' });
        questions.forEach((q) => items.push(q));

        return items;
    }

    /* ==================================================================
     * 六、渲染层：结构化数据 → 打印用 HTML
     * ================================================================ */

    const MM = 96 / 25.4;   // 96dpi 下 1mm ≈ 3.7795px

    // 页边距按 CSS 的「上 右 下 左」简写规则展开，单位 mm
    function parseMargin(m) {
        const v = String(m || '').match(/(\d+(?:\.\d+)?)/g);
        if (!v) return [15, 15, 15, 15];
        const n = v.map(parseFloat);
        if (n.length === 1) return [n[0], n[0], n[0], n[0]];
        if (n.length === 2) return [n[0], n[1], n[0], n[1]];
        if (n.length === 3) return [n[0], n[1], n[2], n[1]];
        return [n[0], n[1], n[2], n[3]];
    }

    // 先算出 A4 内容区实际有多宽（px，96dpi 下 1mm ≈ 3.7795px）
    function contentWidth(opt) {
        const m = String(opt.margin).match(/(\d+(?:\.\d+)?)mm\s+(\d+(?:\.\d+)?)mm/);
        const sideMm = m ? parseFloat(m[2]) : 15;
        return (210 - sideMm * 2) * 3.7795;
    }

    // 选项排几列：按「渲染后需要多宽」逐级降级，装不下就一行一个
    function layoutFor(q, opt) {
        const usable = contentWidth(opt) - opt.fontSize * 2;   // 减去选项区左缩进 2em
        const gap = 18;                                        // 与 CSS .fp-opts 的 column-gap 一致
        const colW = (n) => (usable - gap * (n - 1)) / n;

        // 文字需求宽（另留 "A." 与右边距）+ 图片需求宽（按缩放后计）
        const textNeed = q.maxUnits * opt.fontSize + (q.allImage ? 0 : opt.fontSize * 2.5);
        const imgNeed = q.maxImgW * opt.figScale / 100;
        const need = Math.max(textNeed, imgNeed);

        if (need <= 0) return 'grid-1';
        if (need <= colW(4)) return 'grid-4';
        if (need <= colW(2)) return 'grid-2';
        return 'grid-1';
    }

    // 题干里要求的作答字数：取「不超过 200 字」「1000～1200 字」里的上限
    function requiredCount(stemHtml) {
        const t = String(stemHtml || '')
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;|&amp;/g, ' ')
            .replace(/[\s,，]/g, '');
        let max = 0;
        const range = t.match(/(\d{2,5})\s*[-~—～－至到]\s*(\d{2,5})\s*字/);
        if (range) max = Math.max(parseInt(range[1], 10), parseInt(range[2], 10));
        (t.match(/(\d{2,5})\s*字/g) || []).forEach((s) => {
            const n = parseInt(s, 10);
            if (n > max) max = n;
        });
        return max;
    }

    // 按字数算作答区：一行能写多少字 → 需要几行 → 行距多少。
    // 手写格子约 8mm 见方，与正文字号无关，所以按物理宽度估算每行字数，
    // 而不是按正文字号去算——字号调大不该让手写空间变少。
    function spaceSize(stemHtml, opt) {
        const grid = Math.max(30, Math.round(opt.fontSize * 2.2));    // 单行高（≈8.7mm）
        const perLine = Math.max(15, Math.floor(contentWidth(opt) / (8 * 3.7795)));
        const count = requiredCount(stemHtml) || 200;                  // 读不到字数时的兜底
        const rows = Math.max(1, Math.ceil(count / perLine) + 1);      // 多给一行余量
        return { height: rows * grid, grid, rows, count };
    }

    function buildHtml(items, opt, meta) {
        const isShenlun = meta.mode === 'shenlun';
        const qCount = meta.questionCount;

        // A4 版面尺寸：内容区 = 纸张 − 页边距；再让出页眉 + 页脚
        const mg = parseMargin(opt.margin);
        const CONTENT_W = (210 - mg[1] - mg[3]) * MM;
        const CONTENT_H = (297 - mg[0] - mg[2]) * MM;
        const PFOOTER_H = 22;
        const BODY_H = CONTENT_H - PFOOTER_H;

        let html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opt.title)}</title>
<style>
*{box-sizing:border-box;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}

/* 页边距放到每个 .fp-page 内部（padding），@page 外边距归零。
   否则打印对话框若选了比脚本假设更大的边距（Chrome 默认约 20mm，
   而脚本按 15mm 算高度），每页就会比可打印区高出一截，
   page-break-after:always 又强制分页 → 每页后跟着一张空白页。 */
@page{size:A4;margin:0}

html{background:#e5e7eb}
body{margin:0;padding:0;background:#fff;font-family:"SimSun","STSong","Songti SC","Noto Serif CJK SC",serif;
  font-size:${opt.fontSize}px;color:#151515;line-height:${opt.lineHeight};
  orphans:2;widows:2;text-rendering:optimizeLegibility}
ul,li,ol{list-style:none;margin:0;padding:0}
p{margin:0 0 .5em}

/* ---------- 真分页 ----------
   页码不靠 @page 的 margin box —— 那东西只有打印时才画得出来，
   屏幕上完全看不到，也就没法在预览时确认版面。
   这里由脚本按 A4 内容区高度把正文切成一张张 .fp-page，
   页码是实打实写在页面上的文字：屏幕上所见即打印所得。 */
#fp-flow{width:${CONTENT_W}px;margin:0 auto;visibility:hidden}
#fp-loading{position:fixed;left:0;right:0;top:42%;text-align:center;color:#64748b;font-size:15px;
  font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
@media print{#fp-loading{display:none!important}}
.fp-page{position:relative;display:flex;flex-direction:column;background:#fff;overflow:hidden}
/* flow-root：挡住子元素外边距往外折叠，免得每页顶部莫名空一截 */
.fp-pbody{flex:1 1 auto;overflow:visible;display:flow-root}
/* 页首页尾的 margin 归零：脚本按「相对顶边的偏移」预估页高，
   浏览器要是再在两头补上外边距，预估就会偏，内容顶出页面下沿 */
.fp-pbody>:first-child{margin-top:0!important}
.fp-pbody>:last-child{margin-bottom:0!important}
/* 页脚：页码居中，署名靠左不动。署名写死，没有面板入口。 */
.fp-pfooter{position:relative;flex:0 0 ${PFOOTER_H}px;height:${PFOOTER_H}px;
  line-height:${PFOOTER_H}px;text-align:center;
  font-size:10pt;color:#555;font-family:"SimSun","STSong",serif}
/* 署名：8.5pt → 7.5pt（小两号），#9aa3b2 → #adb5c0（白底对比度 2.55:1 → 2.07:1）。
   再小或再淡打印出来就糊了，7.5pt 是激光打印机还能稳住的下限。 */
.fp-pfooter .fp-sig{position:absolute;left:0;top:0;height:100%;
  font-size:7.5pt;color:#adb5c0;letter-spacing:.5px;
  font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  max-width:52%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.fp-pfooter .fp-pg{display:block;white-space:nowrap}
/* 页面右下角小字：粉笔题库。与署名同步缩小减淡，否则左边轻右边重，看着不协调。 */
.fp-pfooter .fp-tag{position:absolute;right:0;top:0;height:100%;
  font-size:7.5pt;color:#adb5c0;letter-spacing:.5px;
  font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  white-space:nowrap}

@media screen{
  body{background:#e5e7eb;padding:16px 0}
  .fp-page{width:210mm;height:297mm;margin:0 auto 14px;padding:${opt.margin};
    box-shadow:0 1px 8px rgba(15,23,42,.16)}
  .fp-sheet{background:#fff;box-shadow:0 1px 8px rgba(15,23,42,.16);margin:0 auto 14px;
    max-width:210mm;min-height:277mm;padding:14mm 12mm}
}
@media print{
  html,body{background:#fff}
  body{padding:0}
  /* 每页钉死成“整张 A4（297mm）”，可视边距由内部 padding 提供。
     这样无论用户在打印对话框里选“默认/最小/无”边距，
     每页都正好占满一张纸，page-break-after:always 只会切出刚好的分页，
     不会再因为「内容区高度 > 可打印高度」而多挤出空白页。 */
  .fp-page{width:auto;height:297mm;min-height:297mm;max-height:297mm;
    padding:${opt.margin};box-sizing:border-box;overflow:hidden;margin:0;
    box-shadow:none;page-break-after:always;break-after:page}
  .fp-page:last-child{page-break-after:auto;break-after:auto}
  .fp-pbody{min-height:${BODY_H}px;max-height:${BODY_H}px;overflow:hidden}
  .fp-sheet{box-sizing:border-box;height:297mm!important;padding:${opt.margin}!important;
    box-shadow:none;margin:0;max-width:none;min-height:0}
  #fp-flow{display:none!important}
}
/* 旧类名兼容，防止外部还引用 .fp-pnum */
.fp-pnum{display:none!important}

/* ---------- 封面 ---------- */
.fp-cover{position:relative;height:262mm;page-break-after:always;break-after:page;display:flex}
.fp-cover-side{width:34px;border-right:1px dashed #555;position:relative}
.fp-cover-side div{position:absolute;left:30%;transform:translateX(-50%) rotate(-90deg);
  display:flex;align-items:center;width:270px;white-space:nowrap;font-size:14px;letter-spacing:5px}
.fp-cover-side .t1{top:26%}
.fp-cover-side .t2{top:70%}
.fp-cover-side i{flex:1;border-bottom:1px solid #000;margin-left:8px;height:0}
.fp-cover-main{flex:1;position:relative;padding:52px 36px;text-align:center}
.fp-cover-notice{position:absolute;top:34px;right:34px;border:1px solid #333;padding:8px 10px;font-size:13px;line-height:1.6;letter-spacing:1px}
.fp-cover-tt{margin-top:92px;margin-bottom:54px}
.fp-cover-tt .l1{font-size:28px;font-weight:700;letter-spacing:2px;margin-bottom:14px;line-height:1.5}
.fp-cover-tt .l2{font-size:24px;font-weight:700;letter-spacing:2px;line-height:1.5}
.fp-cover-hr{display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;margin:0 auto 34px;width:76%}
.fp-cover-hr::before,.fp-cover-hr::after{content:'';flex:1;border-bottom:1px dashed #333;margin:0 14px}
.fp-cover-tips{text-align:left;font-size:15px;line-height:2.1;margin:0 auto;width:82%;
  font-family:"KaiTi","STKaiti","SimSun",serif}
.fp-cover-tips p{text-indent:2em;margin:10px 0}
.fp-cover-barcode{position:absolute;bottom:210px;left:0;right:0;display:flex;align-items:center;justify-content:center;gap:22px;font-size:14px;color:#000}
.fp-cover-barcode .box{width:64px;height:108px;border:1px dashed #333;display:flex;align-items:center;justify-content:center}
.fp-cover-barcode .box span{writing-mode:vertical-rl;letter-spacing:3px;font-size:13px}
.fp-cover-barcode .tip{text-align:left;line-height:1.8;font-size:13px}
.fp-cover-sign{position:absolute;bottom:18px;left:0;right:0;text-align:center;font-size:12px;color:#64748b;letter-spacing:1px}
.fp-blank{height:262mm;page-break-after:always;break-after:page;page:fpblank}

/* ---------- 章节 ---------- */
.fp-chapter{text-align:left;margin-bottom:16px;page-break-after:avoid;break-after:avoid}
.fp-chapter h2{font-size:18px;font-weight:700;letter-spacing:2px;margin:0;text-align:center}
.fp-chapter p{font-size:${opt.fontSize}px;margin:10px 0 0;color:#333;text-align:justify;
  text-align-last:left;text-indent:2em;line-height:1.7}
.fp-chapter.break{page-break-before:always;break-before:page;padding-top:26px}

/* ---------- 材料 ---------- */
.fp-mat{margin:14px 0}
.fp-mat h3{font-weight:700;font-size:${opt.fontSize + 2}px;text-align:left;margin:0 0 10px;
  page-break-after:avoid;break-after:avoid}
.fp-mat p{text-indent:2em;text-align:justify;text-align-last:left;margin:5px 0;line-height:${opt.lineHeight}}
.fp-mat p[style*="center"],.fp-mat p[style*="right"]{text-indent:0!important}
.fp-mat table{width:100%!important;border-collapse:collapse!important;margin:14px 0}
.fp-mat th,.fp-mat td{border:1px solid #333!important;padding:7px 9px!important;text-align:center!important;
  font-size:${Math.max(9, opt.fontSize - 1)}px!important;line-height:1.5!important}
.fp-mat th{background:#f4f4f4!important;font-weight:700}
.fp-mat img{max-width:100%!important;height:auto!important;display:block;margin:10px auto}
img{border:0!important;box-shadow:none!important;background:transparent!important;
  break-inside:avoid;page-break-inside:avoid}
tr{break-inside:avoid;page-break-inside:avoid}

/* ---------- 填空线 ----------
   用一条 border-bottom 画出来。早先用连续的全角下划线字符拼接，
   字体会把它渲染成一段忽粗忽细、彼此重叠的黑杠，这里彻底换成画线。 */
.fp-ul{display:inline-block;width:5em;height:1em;border-bottom:1px solid #151515;
  vertical-align:-.16em;margin:0 .12em;text-indent:0;overflow:hidden}

/* ---------- 题目 ---------- */
.fp-q{margin-bottom:${opt.qSpacing}px;break-inside:auto;page-break-inside:auto}

/* 题号悬挂缩进（固定排版，不提供开关）：
   题干整体右移 HANG，第一个段落再负缩进 HANG 把题号顶回左边界，
   于是题号突出在外、正文各行左边界对齐，换行也不会钻到题号底下。
   非第一段的普通段落不要首行缩进，直接和第一行文字左边界对齐。 */
.fp-stem{margin-bottom:.4em;padding-left:var(--hang,${HANG}em);orphans:2;widows:2}
.fp-stem p,.fp-stem div{margin:0 0 .5em!important;padding:0!important;text-indent:0!important;
  text-align:justify;text-align-last:left;line-height:${opt.lineHeight}}
.fp-stem p.fp-first,.fp-stem div.fp-first{text-indent:0!important}
.fp-stem p[style*="center"],.fp-stem p[style*="right"]{text-indent:0!important}
.fp-stem p.fp-first[style*="center"],.fp-stem p.fp-first[style*="right"]{text-indent:0!important}
.fp-stem img,.fp-opt img{vertical-align:middle;max-width:100%;height:auto}
.fp-num{float:left;margin-left:calc(-1 * var(--hang,${HANG}em));margin-right:.5em;font-family:"Times New Roman","SimSun",serif}

/* 选项与题干的悬挂位置对齐，换行后仍从字母右侧起排。
   用 flex-wrap 而不是 grid：每个 .fp-opt 是独立可搬的盒子，
   排版时才能把选项组拆到两页上，到了新页仍按同样的列宽排。 */
.fp-opts{display:flex;flex-wrap:wrap;column-gap:18px;row-gap:.5em;margin-top:.3em;padding-left:var(--ohang,${HANG}em)}
.fp-opts.grid-1>.fp-opt{flex:0 0 100%}
.fp-opts.grid-2>.fp-opt{flex:0 0 calc((100% - 18px)/2)}
.fp-opts.grid-4>.fp-opt{flex:0 0 calc((100% - 54px)/4)}

/* 选项字母直接用粉笔自己的节点（.fp-ol），和正文同一个行内流，
   不再另起一列 —— 基线天然对齐，没有高度落差。
   悬挂靠 padding-left + 负 text-indent：字母顶到左边界，
   换行后的文字从 padding 边界起排，对齐到字母右侧。 */
.fp-opt{page-break-inside:avoid;break-inside:avoid;line-height:${opt.lineHeight};
  word-break:break-word;padding-left:0;text-indent:0}
.fp-opt .fp-ol{display:inline-block!important;float:left!important;margin-left:calc(-1 * var(--ohang,${HANG}em))!important;width:var(--ohang,${HANG}em)!important;
  height:auto!important;min-width:0!important;max-width:none!important;
  border:0!important;border-radius:0!important;background:none!important;
  box-shadow:none!important;padding:0!important;margin:0!important;
  font:inherit!important;font-family:"Times New Roman","SimSun",serif!important;
  font-weight:400!important;color:inherit!important;line-height:inherit!important;
  vertical-align:baseline!important;text-indent:0!important;overflow:visible!important;
  position:static!important;transform:none!important}
.fp-opt .fp-ol::before,.fp-opt .fp-ol::after{content:none!important;display:none!important}
.fp-opt p{margin:0!important;padding:0!important}
/* 兜底两层：万一还有没拆干净的块级外壳，也强制成行内，
   别再让字母和内容各占一行。text-indent 是会继承的，
   不归零的话子盒子第一行会跟着一起左移出悬挂位。 */
.fp-opt:not(.fp-opt-img)>*,
.fp-opt:not(.fp-opt-img)>*>*,
.fp-opt:not(.fp-opt-img)>*>*>*{display:inline!important;margin:0!important;padding:0!important;
  text-indent:0!important;white-space:normal}
.fp-opt:not(.fp-opt-img) img{display:inline-block!important;vertical-align:middle!important}

/* 图形选项：选项之间仍按 .fp-opts 横向排列（flex-wrap 决定 grid-1/2/4），
   只在选项内部把「字母圈 + 图」上下排列并保证顶端对齐。

   早先用 flex-wrap 排选项、flex 列排字母+图时：整组横排后按整组高度
   交叉轴对齐，图片高度不一 → 字母圈被推到图片底部、参差不齐。
   这次只动选项内部 —— display:block 让字母圈 + 图各自成行，
   align-self:start 防止外层 flex 再次把字母往下推。
   外层 .fp-opts 的横向排列保持不变 —— 不该把一行四个选项劈成纵向一列 */
.fp-opt-img{display:block;text-align:left;min-width:120px;align-self:start;
  page-break-inside:avoid;break-inside:avoid}
.fp-opt-img .fp-ol{display:block!important;margin:0 0 6px 0!important;float:none!important;width:auto!important}
.fp-opt-img>div,.fp-opt-img>span{display:block}
.fp-opt-img img{display:block;width:140px;max-width:100%;height:auto;margin:0;vertical-align:top}

/* ---------- 申论作答区（格线间距由渲染层按字号内联指定） ---------- */
.fp-space{margin:10px 0 4px;border:1px solid #c8d0da;border-radius:2px;
  page-break-inside:auto;break-inside:auto}
/* 作答区跨页时，续页那几片不再重复画上边框 */
.fp-space-mid{border-top:0;border-top-left-radius:0;border-top-right-radius:0;margin:0}

/* ---------- 二维码 ---------- */
.fp-qr{page-break-before:always;break-before:page;text-align:center;padding-top:70px}
.fp-qr img{width:190px;height:190px;border:1px solid #ddd;padding:8px;background:#fff}

/* ---------- 分页策略 ----------
   三档都保证：单个选项不拆、图片不拆、表格行不拆、标题不落单。
   差别只在于「允许断到多细」。 */

/* 智能平衡（默认）：题目可跨页 —— 题干按段落断开，段落内部不断行；
   选项组同样可以断开，只是短选项组会尽量整组留在同一页。 */
body.pag-smart .fp-q{break-inside:auto;page-break-inside:auto}
body.pag-smart .fp-stem{break-inside:auto;page-break-inside:auto}
body.pag-smart .fp-stem p,body.pag-smart .fp-mat p{break-inside:avoid;page-break-inside:avoid}
body.pag-smart .fp-opts{break-inside:auto;page-break-inside:auto}
body.pag-smart .fp-opts.grid-2,body.pag-smart .fp-opts.grid-4{break-inside:avoid;page-break-inside:avoid}

/* 极致省纸：连段落中间都能断，页面填得最满，但可能出现半截段落 */
body.pag-ultra .fp-q,body.pag-ultra .fp-stem{break-inside:auto;page-break-inside:auto}
body.pag-ultra .fp-stem p,body.pag-ultra .fp-mat p{break-inside:auto;page-break-inside:auto;orphans:1;widows:1}
body.pag-ultra .fp-opts{break-inside:auto;page-break-inside:auto}

/* 整题不拆：每道题完整留在同一页，最整洁但留白最多 */
body.pag-whole .fp-q{break-inside:avoid;page-break-inside:avoid}
body.pag-whole .fp-mat{break-inside:avoid;page-break-inside:avoid}

/* ---------- 提示层 ---------- */
#fp-done{position:fixed;inset:0;background:rgba(15,23,42,.62);backdrop-filter:blur(4px);z-index:120;
  display:none;align-items:center;justify-content:center;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
#fp-done>div{background:#fff;border-radius:14px;padding:32px 40px;text-align:center;max-width:380px;box-shadow:0 20px 50px rgba(0,0,0,.3)}
#fp-done .ok{width:48px;height:48px;background:#16a34a;color:#fff;border-radius:50%;
  display:flex;align-items:center;justify-content:center;font-size:26px;margin:0 auto 14px}
#fp-done h3{margin:0 0 8px;font-size:18px;color:#0f172a}
#fp-done p{margin:0 0 18px;font-size:13px;color:#64748b;line-height:1.6}
#fp-done button{background:#94a3b8;color:#fff;border:0;padding:10px 24px;border-radius:8px;
  font-size:14px;font-weight:700;cursor:pointer;min-width:141px}
#fp-done button[disabled]{cursor:not-allowed}
#fp-done button.on{background:#2563eb;cursor:pointer}
.fp-done-btns{display:flex;gap:12px;justify-content:center;margin-top:4px}
@media print{#fp-done{display:none!important}}
</style></head>
<body class="pag-${opt.pagination}">
<div id="fp-loading">正在按 A4 分页，题目较多时需要几秒…<br><span style="font-size:12px;color:#94a3b8">打印时请在设置里取消勾选「页眉和页脚」、选 A4 纸张；要存成文件就把目标选成「另存为 PDF」。</span></div>
<div id="fp-done"><div><div class="ok">&#10003;</div>
<h3 id="fp-done-t">正在生成文件</h3><p id="fp-done-p">另存为 PDF 需要几秒到十几秒，请稍候再关闭页面。<br>打印设置里请取消「页眉和页脚」，避免顶部出现标题/网址、底部出现日期。</p>
<div class="fp-done-btns"><button id="fp-done-stay" disabled>留在页面</button><button id="fp-done-close" class="on" disabled>关闭页面</button></div></div></div>
`;

        // ---------- 封面 ----------
        if (opt.cover) {
            html += `<div class="fp-sheet fp-cover">
<div class="fp-cover-side"><div class="t1">准考证号<i></i></div><div class="t2">姓名<i></i></div></div>
<div class="fp-cover-main">
  <div class="fp-cover-notice">粉笔内部<br>题库试卷</div>
  <div class="fp-cover-tt"><div class="l1">${esc(opt.title)}</div></div>
  <div class="fp-cover-hr">重要提示</div>
  <div class="fp-cover-tips">
    <p>为维护您的个人权益，确保考试的公平公正，请您协助我们监督考试实施工作。</p>
    <p>本场考试规定：监考老师要向本考场全体考生展示题本密封情况，并邀请两名考生代表验封签字后，方能开启试卷袋。</p>
  </div>
  <div class="fp-cover-barcode">
    <div class="box"><span>条形码粘贴处</span></div>
    <div class="tip">请将此条形码揭下，<br>贴在答题卡指定位置</div>
  </div>
  ${opt.signature ? `<div class="fp-cover-sign">${esc(opt.signature)}</div>` : ''}
</div></div>
<div class="fp-blank">&nbsp;</div>
`;
        }

        // ---------- 正文 ----------
        // 先渲染成一条连续流，等图片就位后由底部脚本切成一张张 A4（见 paginate）
        html += `<div id="fp-pages"></div><div id="fp-flow">`;

        let firstChapter = true;
        let matIndex = 0;
        let qIndex = 0;

        items.forEach((it) => {
            if (it.kind === 'chapter') {
                const cls = firstChapter ? 'fp-chapter' : 'fp-chapter break';
                firstChapter = false;
                html += `<div class="${cls}"><h2>${it.name}</h2>${it.desc ? `<p>${it.desc}</p>` : ''}</div>`;
                return;
            }

            if (it.kind === 'material') {
                matIndex++;
                const n = it.index || matIndex;
                const hasHead = /材料\s*[一二三四五六七八九十\d]+/.test(it.html);
                html += `<div class="fp-mat">${hasHead ? '' : `<h3>材料${n}</h3>`}${blankify(it.html)}</div>`;
                return;
            }

            if (it.kind === 'question') {
                qIndex++;

                // 按题号实际占宽算每题各自的悬挂列宽：间隙固定 0.5em（约半个汉字），
                // 续行与选项仍对齐到同一左边界。没有题号时不设，沿用兜底值。
                const numW = it.num ? textWidthEm(it.num, opt.fontSize) : 0;
                const hang = it.num ? Math.max(numW + 0.5, 0.8) : 0;
                const hangStyle = hang ? ` style="--hang:${hang.toFixed(3)}em;--ohang:${hang.toFixed(3)}em"` : '';

                let stem = it.stemHtml || '';
                if (it.num) {
                    // 题号塞进第一个段落，没有段落就包一个
                    const d = document.createElement('div');
                    d.innerHTML = stem;
                    const p = d.querySelector('p');
                    const mark = `<span class="fp-num">${it.num}</span>`;
                    if (p) {
                        p.innerHTML = mark + p.innerHTML;
                        p.classList.add('fp-first');
                    } else {
                        d.innerHTML = `<p class="fp-first">${mark}${d.innerHTML}</p>`;
                    }
                    stem = d.innerHTML;
                }

                const figureCls = it.figure ? ' fp-fig' : '';
                html += `<div class="fp-q${figureCls}"${hangStyle}><div class="fp-stem">${stem}</div>`;

                if (it.options && it.options.length) {
                    html += `<div class="fp-opts ${layoutFor(it, opt)}">`;
                    it.options.forEach((o) => {
                        // 字母是粉笔自己的节点，已经随 o.html 一起进来了，这里不再另加
                        const oh = flattenOpt(blankify(o.html));
                        html += `<div class="fp-opt${it.allImage ? ' fp-opt-img' : ''}">${oh}</div>`;
                    });
                    html += `</div>`;
                }

                // 申论作答区（默认不留；auto 按题目字数算，fixed 用固定高度）
                if (isShenlun && opt.shenlunMode && opt.shenlunMode !== 'none') {
                    let h, grid;
                    if (opt.shenlunMode === 'auto') {
                        const s = spaceSize(it.stemHtml, opt);
                        h = s.height; grid = s.grid;
                    } else {
                        grid = Math.max(30, Math.round(opt.fontSize * 2.2));
                        h = Math.round(opt.shenlunSpace * 37.8 / grid) * grid;
                    }
                    if (h > 0) {
                        html += `<div class="fp-space" data-grid="${grid}" style="height:${h}px;`
                            + `background-image:repeating-linear-gradient(to bottom,`
                            + `transparent 0,transparent ${grid - 1}px,#c8d0da ${grid - 1}px,#c8d0da ${grid}px)"></div>`;
                    }
                }

                html += `</div>`;
            }
        });

        html += `</div>`;

        // ---------- 二维码 ----------
        if (opt.qrcode) {
            const pid = getPaperId();
            if (pid) {
                const url = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=0&data='
                    + encodeURIComponent('https://www.fenbi.com/exercise/answercard/' + pid);
                html += `<div class="fp-sheet fp-qr">
<div style="font-size:16px;font-weight:700;color:#2563eb;margin-bottom:8px">扫一扫，对答案</div>
<div style="font-size:12px;color:#666;margin-bottom:20px">用粉笔 App 扫码，提交答案后可评分并查看解析</div>
<img src="${url}" alt="答案二维码" onerror="this.parentNode.style.display='none'"></div>`;
            }
        }


        // ---------- 交互脚本 ----------
        const cd = Math.max(0, Math.round(opt.countdown));
        html += `
<script>
(function(){
  var PREVIEW = ${meta.preview ? 'true' : 'false'};
  var RATIO = ${opt.figScale} / 100;
  if (!(RATIO > 0 && RATIO <= 1)) RATIO = 0.65;
  // 预览模式下不自动关页面（iframe 里 window.close 本就无效，统一置 0 更稳）
  var CD = ${meta.preview ? 0 : cd};
  // 输出方式：'print' = 点「排版并打印」，'save' = 点「导出PDF」，'preview' = 调整预览（不打印）。
  // 传入而不是事后猜 —— afterprint 只告诉你对话框关了，猜不出用户在里面选的是
  // 打印机还是「另存为 PDF」。按钮是自己点的，这个意图只有面板那一侧才知道。
  var OUT = ${JSON.stringify(meta.preview ? 'preview' : (meta.output === 'save' ? 'save' : 'print'))};

  // 大图按比例缩小，小图不动；必须幂等，否则轮询会把图越缩越小
  function scaleFigures(){
    try{
      var list = document.querySelectorAll('.fp-fig img, .fp-mat img, .fp-stem img, .fp-opt img');
      for (var i = 0; i < list.length; i++){
        var img = list[i];
        // 先把宽高比钉死：CSS 里 height 是 auto，图片还没解码完时高度会算成 0，
        // 分页量出来的高度就偏小，等图片一到位又把内容顶出页面下沿。
        // 钉成内联样式的同时也记到属性上 —— 分页重切时克隆出来的是全新 img，
        // 还没解码、拿不到比例，得靠这个属性把比例补回去。
        if (img.naturalWidth > 0 && img.naturalHeight > 0 && !img.getAttribute('data-fp-ar')){
          img.style.setProperty('aspect-ratio', img.naturalWidth + ' / ' + img.naturalHeight, 'important');
          img.style.setProperty('height', 'auto', 'important');
          img.setAttribute('data-fp-ar', img.naturalWidth + '/' + img.naturalHeight);
        }
        if (img.getAttribute('data-fp-scaled')) continue;
        var w = img.getBoundingClientRect().width;
        if (w && w > 150){
          img.style.setProperty('width', Math.round(w * RATIO) + 'px', 'important');
          img.setAttribute('data-fp-scaled', '1');
        }
      }
    }catch(e){}
  }
  // 图片加载失败要能立刻知道：坏图的 naturalWidth 一直是 0，
  // 没有 onerror 兜底的话，一张图就能把整个排版拖到超时
  function watchImages(){
    var imgs = document.images;
    for (var i = 0; i < imgs.length; i++){
      if (imgs[i].getAttribute('data-fp-w')) continue;
      imgs[i].setAttribute('data-fp-w', '1');
      imgs[i].addEventListener('error', function(){ this.setAttribute('data-fp-giveup', '1'); });
    }
  }
  function pending(){
    watchImages();
    var n = 0, imgs = document.images;
    for (var i = 0; i < imgs.length; i++){
      var im = imgs[i];
      if (im.getAttribute('data-fp-giveup')) continue;
      if (!im.complete){ n++; continue; }
      // complete 只说明字节到齐了，SVG 之类还得解码。没解码出来时
      // naturalWidth 是 0、高度也算成 0，这时候切页必然偏乐观。
      if (im.naturalWidth === 0){
        var w = parseInt(im.getAttribute('data-fp-wait') || '0', 10) + 1;
        im.setAttribute('data-fp-wait', w);
        // 等 8 轮（约 2 秒）还解不出来，按坏图处理，不再干等
        if (w > 8) im.setAttribute('data-fp-giveup', '1');
        else n++;
      }
    }
    return n;
  }

  /* ---------------- 真分页 ----------------
     页码不靠 @page 的 margin box —— 那东西只有打印时才画得出来，
     屏幕上完全看不到，也就没法在预览时确认版面。
     这里由脚本按 A4 内容区高度把正文切成一张张 .fp-page，
     页码是实打实写在页面上的文字：屏幕上所见即打印所得。 */
  var BODY_H = ${BODY_H};
  // 切页粒度由面板的「换页方式」决定（whole / smart / ultra）
  var MODE = ${JSON.stringify(opt.pagination || 'smart')};
  var SIG = ${JSON.stringify(opt.signature || '')};

  function mkPage(){
    var p = document.createElement('div');
    p.className = 'fp-page';
    var b = document.createElement('div'); b.className = 'fp-pbody';
    var f = document.createElement('div'); f.className = 'fp-pfooter';
    var sg = document.createElement('span'); sg.className = 'fp-sig';
    var pg = document.createElement('span'); pg.className = 'fp-pg';
    var tg = document.createElement('span'); tg.className = 'fp-tag';
    sg.textContent = SIG;
    tg.textContent = '粉笔题库';
    f.appendChild(sg); f.appendChild(tg); f.appendChild(pg);
    p.appendChild(b); p.appendChild(f);
    return p;
  }

  // 这些标签本身不撑高度，只是把内容裹了一层。
  // 必须钻进去再拆 —— 不钻的话整个题干会变成一个巨大的原子：
  // 放不下就整块翻页（页尾空一大片），题干比一页还高时更直接顶出页面。
  var WRAP = /^(DIV|SECTION|ARTICLE|APP-FORMAT-HTML|BLOCKQUOTE|CENTER)$/;

  // 把连续流拆成「原子」——能整段搬走的最小单位
  function collect(flow){
    var out = [], qid = 0, mid = 0, i, j, k;

    function push(node, meta){
      if (!node) return;
      out.push({ node: node, qid: meta.qid || 0, slot: meta.slot,
                 fig: meta.fig, grid: meta.grid, mid: meta.mid, own: meta.own,
                 hang: meta.hang, ohang: meta.ohang });
    }
    // 容器上是否直接挂着文字（不是包在子元素里的那种）。
    // 粉笔的题干/材料大量是「<div>……最恰当的一项是：<span>____</span>。</div>」
    // 这种混排结构：文字直接挂在容器上，行内元素夹在中间。
    function hasDirectText(node){
      var ns = node.childNodes;
      for (var i = 0; i < ns.length; i++){
        var n = ns[i];
        // 纯缩进换行的空白不算内容
        if (n.nodeType === 3 && n.textContent.replace(/[\s\u3000]/g, '').length) return true;
      }
      return false;
    }

    function drill(node, meta, depth){
      if (depth > 6){ push(node, meta); return; }
      var kids = node.children;
      // 只有「纯容器」才往下钻：里面掺了表格/图片这类不能拆的东西就整块收下
      if (kids.length && WRAP.test(node.tagName) && !node.querySelector('table,img,svg,canvas')){
        // 混排容器（文字与行内元素夹在一起）不能再往下钻 ——
        // 只递归元素子节点的话，挂在容器上的那截文字会被整个丢掉；
        // 拆成「文本块 + 元素块」也不行，会打断行内流，把一句话劈成两行。
        // 整块收下最保真，代价只是这一块不能跨页续排。
        if (hasDirectText(node)){ push(node, meta); return; }
        for (var t = 0; t < kids.length; t++) drill(kids[t], meta, depth + 1);
        return;
      }
      push(node, meta);
    }

    // 材料内容按「段落 / 表格」拆成独立原子：纯文本段落各自成块可续页，
    // 含图/表的节点整体保留，避免整段材料被当成一个巨块顶到下一页、留下大段留白。
    function collectMat(node, meta){
      if (!node || !node.children) return;
      if (node.tagName === 'P' || node.tagName === 'TABLE' || node.tagName === 'IMG'){
        push(node, meta); return;
      }
      // 表格本身不能拆，但表格前后的段落必须独立成原子。
      // 旧逻辑「整块含表格就整体保留」会把「长段落 + 表格」粘成一个上千像素的巨块：
      // 页尾放不下时整块翻页留一大片空白，巨块被硬塞进空白页又顶出页面，
      // 分页器为了救它收紧页高，结果全篇每一页都被压矮、留下十几行空白。
      var kids = node.children;
      // 兜底一：材料正文常常不是 <p>，而是直接包在 div.content / .material-content 里。
      // 这种「只有文本、没有元素子节点」的叶子容器必须整块收下 ——
      // 少了这一步，递归到最内层时一个原子都不产生，整段材料会在分页环节凭空消失。
      // 兜底二：文字与子元素混排的容器（<div>说明文字<p>段落</p></div>）同样整块收下，
      // 否则只递归元素子节点，容器上那截说明文字就没了。
      if (!kids.length || hasDirectText(node)){ push(node, meta); return; }
      for (var c = 0; c < kids.length; c++) collectMat(kids[c], meta);
    }

    for (i = 0; i < flow.children.length; i++){
      var top = flow.children[i];
      if (top.classList.contains('fp-mat')){
        mid++;
        for (j = 0; j < top.children.length; j++){
          var mel = top.children[j];
          if (mel.tagName === 'H3' || (mel.classList && mel.classList.contains('fp-mat-h'))){
            // 材料标题单独成块，但和紧跟的正文同块，避免标题孤悬在页尾留白
            push(mel, { qid: 0, slot: 'mat-head', mid: mid, own: top });
          } else {
            // 材料内容按段落/表格拆成原子，让段落能续页填满页尾，消除大段留白
            collectMat(mel, { qid: 0, slot: 'mat', mid: mid, own: top });
          }
        }
      } else if (top.classList.contains('fp-q')){
        qid++;
        var fig = top.classList.contains('fp-fig');
        // 每题各自的悬挂列宽（--hang/--ohang）是 buildHtml 按题号算好写在内联 style 上的，
        // 但 place() 重建 .fp-q 外壳时不会复制 style，必须把值记到每个原子上，
        // 重建时再写回，否则逐题缩进会在分页环节丢掉、退回兜底值。
        var qh = (top.style.getPropertyValue('--hang') || '').trim();
        var qo = (top.style.getPropertyValue('--ohang') || qh).trim();
        var qMeta = { qid: qid, fig: fig, own: top, hang: qh, ohang: qo };
        for (j = 0; j < top.children.length; j++){
          var e = top.children[j];
          if (e.classList.contains('fp-stem')){
            for (k = 0; k < e.children.length; k++)
              drill(e.children[k], Object.assign({}, qMeta, { slot: 'stem' }), 0);
          } else if (e.classList.contains('fp-opts')){
            var g = (e.className.match(/grid-\\d/) || ['grid-4'])[0];
            for (var m = 0; m < e.children.length; m++)
              push(e.children[m], Object.assign({}, qMeta, { slot: 'opt', grid: g }));
          } else if (e.classList.contains('fp-space')){
            push(e, Object.assign({}, qMeta, { slot: 'space' }));
          } else {
            drill(e, Object.assign({}, qMeta, { slot: 'stem' }), 0);
          }
        }
      } else {
        push(top, { qid: 0, slot: 'top', own: null });
      }
    }
    return out;
  }

  // 原子搬进页面，顺手在需要时重建 .fp-q / .fp-stem / .fp-opts / .fp-mat 外壳：
  // 一道题被拆到两页上时，两边各自仍是完整结构，悬挂缩进、列宽、材料框都不会散。
  function place(body, a, st){
    var host = body;
    if (a.slot === 'mat' || a.slot === 'mat-head'){
      if (!st.mat || st.mat.parentNode !== body || st.mid !== a.mid){
        st.mat = document.createElement('div');
        st.mat.className = 'fp-mat';
        body.appendChild(st.mat);
        st.mid = a.mid;
      }
      host = st.mat;
    } else if (a.qid){
      if (st.qid !== a.qid || !st.q || st.q.parentNode !== body){
        st.q = document.createElement('div');
        st.q.className = 'fp-q' + (a.fig ? ' fp-fig' : '');
        // 把该题算好的悬挂列宽写回重建后的外壳，否则 .fp-stem/.fp-num/.fp-opts
        // 收不到自定义变量，逐题缩进会退回 CSS 兜底值
        if (a.hang) st.q.style.setProperty('--hang', a.hang);
        if (a.ohang) st.q.style.setProperty('--ohang', a.ohang);
        body.appendChild(st.q);
        st.qid = a.qid; st.stem = null; st.opts = null;
      }
      host = st.q;
      if (a.slot === 'stem'){
        if (!st.stem || st.stem.parentNode !== st.q){
          st.stem = document.createElement('div');
          st.stem.className = 'fp-stem';
          st.q.appendChild(st.stem);
        }
        host = st.stem;
      } else if (a.slot === 'opt'){
        if (!st.opts || st.opts.className.indexOf(a.grid) < 0 || st.opts.parentNode !== st.q){
          st.opts = document.createElement('div');
          st.opts.className = 'fp-opts ' + a.grid;
          st.q.appendChild(st.opts);
        }
        host = st.opts;
      }
    }
    host.appendChild(a.node);
  }

  // 可沿行边界撕开的纯文本节点（不含表格/图片/公式等不能腰斩的元素）
  function canSplitNode(node){
    return node && /^(P|DIV|SPAN|SECTION|ARTICLE|BLOCKQUOTE|CENTER|APP-FORMAT-HTML)$/i.test(node.tagName)
      && !node.querySelector('img,table,svg,canvas,iframe,object,embed,math');
  }

  // 把一段长文字从「剩余高度」处按行边界真实切成两段：
  // first 含顶部前 N 行（带题号、保留内联结构），rest 含第 N+1 行起的剩余文本。
  //
  // 这一版之前踩过两次坑，都值得记下来：
  //  1) 最早用「克隆整段 + 负 margin 续接」：rest 是完整克隆，靠负 margin 把上半截
  //     藏起来，一旦没被父容器精确裁掉，前 N 行就原样露出 —— 题目文本重复
  //     （Q4、Q64 复现过）。
  //  2) 为修 1) 改成 textContent 按字符重建：不重复了，但会把题干里的下划线填空
  //     <u><span class="fp-ul"></span></u> 整个抹掉。为了不丢结构，又加了
  //     extraEls>0 守卫「含内联元素就不拆」，结果言语理解这类含下划线的长题干
  //     在页尾一律整段翻页，页尾留下大段空白（用户反馈「还剩五行的留白」）。
  //
  // 现在改用 Range 按行边界定位切点 + cloneContents()：内联结构原样保留，
  // 既不会丢下划线，也不再需要那道一刀切的守卫，含 <u> 的段落照样能续排。
  function splitTextAtom(atom, remain){
    var node = atom.node;
    if (!canSplitNode(node)) return null;
    var cs = window.getComputedStyle(node);
    var lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 16) * 1.6;
    if (!(lh > 0)) return null;
    var lines = Math.max(1, Math.floor(remain / lh));
    var h = Math.floor(lines * lh);
    // 拆得太少或几乎整段都能放下，就不拆了
    if (h < 24 || h >= atom.h - 16) return null;

    var cut = findLineCut(node, h);
    if (!cut) return null;

    var first = node.cloneNode(false);   // 浅克隆：保留标签 / class / 内联样式
    var rest = node.cloneNode(false);
    var r1 = document.createRange();
    r1.setStart(node, 0);
    r1.setEnd(cut.node, cut.offset);
    first.appendChild(r1.cloneContents());
    var r2 = document.createRange();
    r2.setStart(cut.node, cut.offset);
    r2.setEnd(node, node.childNodes.length);
    rest.appendChild(r2.cloneContents());
    // 两边都得有实际文字，否则等于没拆
    if (!first.textContent.replace(/[\s　]/g, '').length) return null;
    if (!rest.textContent.replace(/[\s　]/g, '').length) return null;

    first.style.maxHeight = h + 'px';
    first.style.overflow = 'hidden';
    first.style.marginBottom = '0';
    first.style.breakInside = 'auto';
    first.style.pageBreakInside = 'auto';
    rest.style.marginTop = '0';
    rest.style.breakInside = 'auto';
    rest.style.pageBreakInside = 'auto';
    return { first: first, rest: rest, h: h };
  }

  // 在 node 内按「行边界」找切点：返回 {node: 文本节点, offset}，使前段渲染高度 ≤ h。
  // 用 Range.getClientRects() 取最后一行的底边量高度，二分定位 ——
  // 切点必然落在行边界上，不会把一行字劈成上下两半，也不依赖任何 DOM 结构假设。
  function findLineCut(node, h){
    var NF = window.NodeFilter || { SHOW_TEXT: 4 };
    var walker = document.createTreeWalker(node, NF.SHOW_TEXT, null, false);
    var tns = [], n, i;
    while ((n = walker.nextNode())) if (n.textContent.length) tns.push(n);
    if (!tns.length) return null;
    var total = 0;
    for (i = 0; i < tns.length; i++) total += tns[i].textContent.length;
    if (total < 2) return null;

    var cs = window.getComputedStyle(node);
    var padT = parseFloat(cs.paddingTop) || 0;
    var bdT = parseFloat(cs.borderTopWidth) || 0;
    var base = node.getBoundingClientRect().top + padT + bdT;

    // 全局字符偏移 -> {node, offset}
    function at(g){
      var rem = g;
      for (var i = 0; i < tns.length; i++){
        if (rem <= tns[i].textContent.length) return { node: tns[i], offset: rem };
        rem -= tns[i].textContent.length;
      }
      var last = tns[tns.length - 1];
      return { node: last, offset: last.textContent.length };
    }
    function heightAt(g){
      if (g <= 0) return 0;
      var p = at(g);
      var r = document.createRange();
      try { r.setStart(node, 0); r.setEnd(p.node, p.offset); }
      catch (e){ return 0; }
      var rects = r.getClientRects();
      if (!rects || !rects.length) return 0;
      return rects[rects.length - 1].bottom - base;
    }

    var lo = 1, hi = total - 1, best = 0;
    while (lo <= hi){
      var mid = (lo + hi) >> 1;
      if (heightAt(mid) <= h){ best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (best <= 0 || best >= total) return null;
    return at(best);
  }

  // 按给定的页高把连续流切成一页页。gran 用来临时覆盖换页粒度
  function cut(flow, lim, gran, host){
    var atoms = collect(flow), i;
    if (!atoms.length) return [];

    // 先在 flow 里量一遍。flow 的宽度和页面内容区一模一样，
    // 所以这里量到的位置就是搬进页面后的真实位置。
    // 用「相对顶边的偏移」而不是逐个累加高度：margin 折叠、
    // 题与题之间的间距，浏览器都已经算好了，照抄最省心。
    var base0 = flow.getBoundingClientRect().top;
    for (i = 0; i < atoms.length; i++){
      var r = atoms[i].node.getBoundingClientRect();
      atoms[i].h = r.height;
      atoms[i].top = r.top - base0;
    }
    // 顶层盒子（.fp-q / .fp-mat）的外边距挂在自己首尾的原子上，
    // 不然题目之间的间距会凭空消失，全挤成一团
    for (i = 0; i < atoms.length; i++){
      var o = atoms[i].own;
      if (!o) continue;
      var cs = window.getComputedStyle(o);
      var isFirst = (i === 0) || (atoms[i - 1].own !== o);
      var isLast = (i === atoms.length - 1) || (atoms[i + 1].own !== o);
      if (isFirst) atoms[i].mt = Math.max(atoms[i].mt || 0, parseFloat(cs.marginTop) || 0);
      if (isLast) atoms[i].mb = Math.max(atoms[i].mb || 0, parseFloat(cs.marginBottom) || 0);
    }

    // 同一水平线上的选项是「一行」：跨页时整行走，
    // 免得一行四个被劈成 3+1，看着像排错了版
    var row = 0, lastSlot = '', lastTop = -1;
    for (i = 0; i < atoms.length; i++){
      var a = atoms[i];
      if (a.slot === 'opt'){
        if (lastSlot !== 'opt' || lastTop < 0 || Math.abs(a.top - lastTop) > 2) row++;
        a.row = row; lastTop = a.top;
      } else lastTop = -1;
      lastSlot = a.slot;
    }

    // 比一整页还高的作答区先按格线切片，免得整体挤到下一页、前面空一大块
    var list = [];
    for (i = 0; i < atoms.length; i++){
      var at = atoms[i];
      if (at.slot === 'space' && at.h > lim){
        var grid = parseFloat(at.node.getAttribute('data-grid')) || 30;
        var seg = Math.floor(lim / grid) * grid;
        var rest = at.h, parts = [];
        while (rest > seg){ parts.push(seg); rest -= seg; }
        if (rest > 0) parts.push(rest);
        for (var s = 0; s < parts.length; s++){
          var d = document.createElement('div');
          d.className = 'fp-space' + (s ? ' fp-space-mid' : '');
          d.style.height = parts[s] + 'px';
          d.style.backgroundImage = at.node.style.backgroundImage;
          d.setAttribute('data-grid', grid);
          list.push({ node: d, h: parts[s], qid: at.qid, slot: 'space', fig: at.fig,
                      top: at.top + s * seg });
        }
        if (at.node.parentNode) at.node.parentNode.removeChild(at.node);
      } else list.push(at);
    }

    // 打包成「块」：同一块的原子要么一起进当前页，要么一起翻到下一页。
    // 块划多细由换页方式决定 —— 这也是「换页选项」真正起作用的地方。
    //   whole  整道题一块：题目绝不跨页，页尾可能留白
    //   smart  题干按段落、选项按行成块：既不散架也不大片留白（默认）
    //   ultra  在 smart 基础上填得更满：段落可以从行缝里多撕几行，
    //          「后面还有一大块、本页尾巴这点空间塞不下」时还会回头把上一段让出几行
    var blocks = [], curBlk = null, curKey = null, md = gran || MODE;
    for (i = 0; i < list.length; i++){
      var x = list[i], key;
      // 同一行的选项永远整行走 —— 极致省纸也不例外。
      // 早先 ultra 是每个原子一块，一行四个选项会被劈成 3+1 分到两页上，
      // 看着就像排错了版。省纸不能省到把选项行拆散。
      if (x.slot === 'opt' && md !== 'whole') key = 'r' + x.qid + '_' + x.row;
      else if (md === 'whole') key = x.qid ? ('q' + x.qid) : ('t' + i);
      else if (md === 'ultra') key = 'u' + i;
      else if (x.slot === 'stem') key = 's' + x.qid + '_' + i;
      else if (x.slot === 'mat-head')
        key = (i + 1 < list.length && list[i + 1].slot === 'mat') ? ('x' + (i + 1)) : ('x' + i);
      else key = 'x' + i;
      if (key !== curKey){
        curBlk = { top: x.top, h: x.h, items: [x] };
        blocks.push(curBlk); curKey = key;
      } else {
        curBlk.items.push(x);
        curBlk.h = x.top + x.h - curBlk.top;
      }
    }

    // ---------------- 装页：真放进去、真量一次 ----------------
    // 旧逻辑拿 flow 里量好的 top/h 去估算「这块放进去会到哪儿」，可 place() 搬动
    // 原子时会重建 .fp-q / .fp-stem / .fp-opts / .fp-mat 外壳 —— 外壳自己的
    // padding / gap，以及被外壳打断的外边距折叠，全都不在那个估算里。
    // 估少了内容顶出页面，估多了页尾空一大截。用户反馈的两件事都出在这儿：
    //   · 「还剩五六行留白，选项却整个甩到了下一页」—— 估算把块算高了；
    //   · 「预览里改成极致省纸后出现大段空白」—— 顶出的页逼着 paginate 收紧
    //     页高，一收紧接着全篇每一页都跟着矮下去。
    // 现在改成：放进当前页 → 量一次真实高度 → 放不下就撤回来翻页。
    var pages = [], cur = mkPage(), st = {}, used = 0;
    // 本页已经装进去的块（按序），极致省纸回头让位时用得上；翻页即清空
    var pageBlocks = [];
    host.appendChild(cur);      // 页必须挂在文档里，否则量到的高度恒为 0

    // 本页内容真实高度：取首末子元素的跨度，再补回首元素的外上边距。
    // 不能直接量 .fp-pbody —— 它是 flex:1，内容不满时被拉伸成整页高，
    // 量出来永远等于 BODY_H，真实留白会被完全抹平。
    function pageH(){
      var b = cur.firstChild, kids = b.children;
      if (!kids.length) return 0;
      var f = kids[0], l = kids[kids.length - 1];
      var mt = parseFloat(window.getComputedStyle(f).marginTop) || 0;
      return l.getBoundingClientRect().bottom - f.getBoundingClientRect().top + (mt > 0 ? mt : 0);
    }

    function flushPage(){
      pages.push(cur);
      cur = mkPage(); host.appendChild(cur);
      st = {}; used = 0; pageBlocks = [];
    }

    // 把刚放进去的原子撤回来：摘掉节点、清掉空壳、重置外壳缓存。
    // 清空 st 是关键 —— 下一次 place() 会重新建壳，不会留下空 .fp-q 占着位置。
    function unplace(items){
      // 注意 items 里装的是原子对象，真正的节点在 .node 上
      for (var k = items.length - 1; k >= 0; k--){
        var n = items[k] && items[k].node;
        if (n && n.parentNode) n.parentNode.removeChild(n);
      }
      var sh = cur.firstChild.querySelectorAll('.fp-q,.fp-stem,.fp-opts,.fp-mat');
      for (k = 0; k < sh.length; k++)
        if (!sh[k].children.length && sh[k].parentNode) sh[k].parentNode.removeChild(sh[k]);
      for (var key in st) delete st[key];
      used = pageH();
    }

    // 换个节点、其余元信息照抄：撕开段落时把 first / rest 续回队列用得上
    function reatom(a, node){
      return { node: node, qid: a.qid, slot: a.slot, fig: a.fig, grid: a.grid,
               mid: a.mid, own: a.own, hang: a.hang, ohang: a.ohang };
    }

    function put(items){
      for (var y = 0; y < items.length; y++) place(cur.firstChild, items[y], st);
      return pageH();
    }

    // 撕开填缝的门槛：剩余空间太窄就不撕了，免得把段落切得七零八落。
    // 极致省纸门槛压到 8%，智能平衡留 20% —— 这就是两档省纸程度的分界。
    var SPLIT_MIN = (md === 'ultra') ? 0.08 : 0.2;

    for (i = 0; i < blocks.length; i++){
      var b = blocks[i];
      var h0 = used;                       // 放这一块之前，本页已经占掉的高度
      var h1 = put(b.items);

      // 章节标题孤悬在页尾（下面还有内容）才整段挪到下一页，避免标题独占一页、正文被挤走。
      // 阈值取页高 82%：只有真的快到底了才挪，平时就跟普通内容一样顺流排，不留大空白。
      if (b.items[0].slot === 'top' && h0 > lim * 0.82 && h1 > lim * 0.9 && i + 1 < blocks.length){
        unplace(b.items); flushPage();
        used = put(b.items);
        if (used > lim) cur.__hard = true;
        continue;
      }

      if (h1 <= lim){ pageBlocks.push({ items: b.items, h0: h0, h1: h1 }); used = h1; continue; }

      // ---- 本页放不下 ----
      if (h0 > 0){
        unplace(b.items);
        // 单个大段文字：剩余空间还不少时就从行边界撕开填缝，
        // 免得整段翻页在页尾留下大片空白
        if (b.items.length === 1 && md !== 'whole'
            && (lim - h0) > lim * SPLIT_MIN && canSplitNode(b.items[0].node)){
          var parts = splitTextAtom(b.items[0], lim - h0);
          if (parts){
            place(cur.firstChild, reatom(b.items[0], parts.first), st);
            used = pageH();
            flushPage();
            // 续段塞回队列：下一轮站在空白页上重新量，还放不下就再撕一次
            blocks.splice(i + 1, 0, { items: [ reatom(b.items[0], parts.rest) ] });
            continue;
          }
        }
        // 这一块自己撕不开（图片选项整行 / 表格），而本页尾巴这点缝确实塞不下：
        // 极致省纸再试一招 —— 回头把本页最后那段文字让出几行，给这块腾地方。
        // 「明明还剩五六行，选项却整个跑到下一页去了」多半就是卡在这儿。
        if (md === 'ultra' && pageBlocks.length && !canSplitNode(b.items[0].node)){
          var bH = h1 - h0;                                  // 这块实际要占的高度
          var prev = pageBlocks[pageBlocks.length - 1];
          var prevH = prev.h1 - prev.h0;
          // 上一段让出之后，本页剩下的高度要能整块吃下 b，且上一段还得留得住两行
          var room = lim - bH - prev.h0;
          if (prev.items.length === 1 && canSplitNode(prev.items[0].node)
              && room >= 60 && room < prevH - 20){
            unplace(prev.items);
            var p3 = splitTextAtom(prev.items[0], room);
            if (p3){
              place(cur.firstChild, reatom(prev.items[0], p3.first), st);
              used = pageH();
              flushPage();
              // 让出来的那几行要排在 b 前面，否则题干和选项的顺序就颠倒了
              blocks.splice(i, 0, { items: [ reatom(prev.items[0], p3.rest) ] });
              continue;
            }
            // 撕不动就原样放回去，当什么都没发生
            place(cur.firstChild, prev.items[0], st);
            used = pageH();
          }
        }
        flushPage();
        used = put(b.items);
        if (used <= lim){ pageBlocks.push({ items: b.items, h0: 0, h1: used }); continue; }
      } else used = h1;

      // ---- 连空白页都放不下：这一块比整页还高 ----
      // 能撕就撕，能拆就拆；实在拆不动才算「物理必然超出」。
      if (b.items.length === 1 && md !== 'whole' && canSplitNode(b.items[0].node)){
        var p2 = splitTextAtom(b.items[0], lim);
        if (p2){
          unplace(b.items);
          place(cur.firstChild, reatom(b.items[0], p2.first), st);
          used = pageH();
          flushPage();
          blocks.splice(i + 1, 0, { items: [ reatom(b.items[0], p2.rest) ] });
          continue;
        }
      }
      if (b.items.length > 1){
        // 拆成单原子重来：能各自塞进页的就不再顶出去了
        unplace(b.items);
        blocks.splice(i + 1, 0, { items: b.items.slice(1) });
        blocks[i] = { items: [ b.items[0] ] };
        i--;                               // 退回一格，先单独处理第一个原子
        continue;
      }
      // 单个原子本身就比一页还高且切不开（超长表格 / 大图）：打个标记。
      // 它超出是必然的，收紧页高救不了它，却会把其余每一页一起压矮。
      cur.__hard = true;
      pageBlocks.push({ items: b.items, h0: h0, h1: used });
      used = pageH();
    }
    pages.push(cur);
    return pages;
  }

  function paginate(){
    var flow = document.getElementById('fp-flow');
    var host = document.getElementById('fp-pages');
    if (!flow || !host) return;
    if (!flow.children.length){ flow.style.display = 'none'; return; }

    // 连续流先留个底稿：脚本预估的高度和浏览器实际排出来总有那么几像素出入
    // （margin 折叠、亚像素舍入都算），收紧重切时必须从原始流重来。
    var backup = flow.cloneNode(true);
    var pages = [], lim = BODY_H, i, t, gran = null;

    for (var round = 0; round < 5; round++){
      flow.innerHTML = '';
      for (t = 0; t < backup.childNodes.length; t++)
        flow.appendChild(backup.childNodes[t].cloneNode(true));
      // 克隆出来的 img 是全新节点，还没解码，宽高比拿不到 ——
      // 把原节点上记好的比例补回去，不然这一轮量出来的高度又偏小了
      var ci = flow.querySelectorAll('img');
      for (t = 0; t < ci.length; t++){
        var ar = ci[t].getAttribute('data-fp-ar');
        if (ar && !ci[t].style.aspectRatio)
          ci[t].style.setProperty('aspect-ratio', ar.replace('/', ' / '), 'important');
      }
      host.innerHTML = '';
      pages = cut(flow, lim, gran, host);
      if (!pages.length) break;
      for (i = 0; i < pages.length; i++) host.appendChild(pages[i]);
      // 切完真刀真枪量一遍：有页被顶高了就收紧页高重切
      var over = 0;
      for (i = 0; i < pages.length; i++){
        // 打了 __hard 的页：里面的原子本身比一页还高，收紧 lim 救不了它，
        // 却会把其余每一页一起压矮（旧逻辑因此让全篇每页都留十几行空白），跳过
        if (pages[i].__hard) continue;
        var hh = pages[i].firstChild.getBoundingClientRect().height;
        if (hh - BODY_H > over) over = hh - BODY_H;
      }
      if (over <= 1) break;
      // 下限 0.8 只是防失控的兜底。切页改成实测之后 over 通常只剩几像素舍入误差，
      // 一压就到下限反而是信号：说明真有拆不动的东西，再压纯属浪费版面。
      var next = Math.max(BODY_H * 0.8, lim - Math.max(4, Math.ceil(over)));
      if (next >= lim) break;            // 已经压到下限，再跑几轮也是白跑
      lim = next;
      // 连着两轮都收不住，说明当前粒度下没有能塞进去的切法：
      // 「整题不拆」在这儿行不通，换最细粒度再试，宁可拆题也别把字顶出页面
      if (round >= 1) gran = 'ultra';
    }

    for (i = 0; i < pages.length; i++){
      // 封面/封底/二维码是独立的 .fp-sheet，不进入 pages 数组。
      // 正文页从第 1 页开始连续编号，每页都显示署名和页码。
      pages[i].lastChild.lastChild.textContent = '第 ' + (i + 1) + ' 页 / 共 ' + pages.length + ' 页';
    }
    flow.innerHTML = '';
    flow.style.display = 'none';
    var tip = document.getElementById('fp-loading');
    if (tip) tip.style.display = 'none';
  }

  // 等字体就位再量高度，否则中文字体一换，量出来的高度全是错的
  function layout(){
    var run = function(){
      try { paginate(); } catch (e) {
        // 分页失败就退回连续流，至少内容还在、还能打印
        var f = document.getElementById('fp-flow');
        if (f) { f.style.visibility = 'visible'; f.style.display = ''; }
        var tp = document.getElementById('fp-loading');
        if (tp) tp.style.display = 'none';
      }
      window.__fpReady = true;
    };
    if (document.fonts && document.fonts.ready){
      var t = setTimeout(run, 1200);
      try { document.fonts.ready.then(function(){ clearTimeout(t); run(); }); }
      catch (e) { run(); }
    } else run();
  }

  // 图片没解码完时宽度为 0，直接缩放会全部失效；过早打印则 PDF 里图形题空白
  function waitReady(){
    var deadline = Date.now() + 15000;
    (function poll(){
      scaleFigures();
      var p = pending();
      if (p === 0 || Date.now() > deadline){
        layout();
        return;
      }
      setTimeout(poll, 250);
    })();
  }
  if (document.readyState === 'complete') waitReady();
  else window.addEventListener('load', waitReady);
  setTimeout(function(){ window.__fpReady = true; }, 18000);

  var printed = false, shown = false, fpCloseTimer = null;
  function stopCloseTimer(){ if (fpCloseTimer){ clearInterval(fpCloseTimer); fpCloseTimer = null; } }

  // 打印对话框一关就弹「打印完成」并立刻起倒计时；倒计时期间点任一按钮都能立即生效
  window.addEventListener('afterprint', function(){ printed = true; showDone(); });
  // 兜底：个别浏览器 afterprint 不触发，靠窗口重新拿到焦点补一次（只在从未弹出过时生效）
  window.addEventListener('focus', function(){ if (printed && !shown) showDone(); });

  function showDone(){
    var box = document.getElementById('fp-done');
    var btnStay = document.getElementById('fp-done-stay');
    var btnClose = document.getElementById('fp-done-close');
    // 点「导出PDF」进来的人是要存文件的，说「打印完成」会让人怀疑是不是存错了；
    // 点「排版并打印」的人才是要打印。两套文案。
    if (OUT === 'save') {
      document.getElementById('fp-done-t').textContent = '保存成功！';
      document.getElementById('fp-done-p').textContent = 'PDF 已保存到你在打印对话框里选的位置。没存上就按 P 键再试一次；或选择下方操作。';
    } else {
      document.getElementById('fp-done-t').textContent = '打印完成！';
      document.getElementById('fp-done-p').textContent = '如需重打，按 P 键再次唤起打印对话框；或选择下方操作。';
    }
    box.style.display = 'flex';
    btnStay.removeAttribute('disabled');
    btnClose.removeAttribute('disabled');
    shown = true;
    startCloseTimer(btnClose);
  }

  // CD 为 0 = 不自动关闭，只留按钮给手动点；否则从 CD 秒起倒数，归零则关页面
  function startCloseTimer(btn){
    stopCloseTimer();
    var left = CD > 0 ? Math.round(CD) : 0;
    if (!left){ btn.textContent = '关闭页面'; return; }
    btn.textContent = '关闭页面 (' + left + 's)';
    fpCloseTimer = setInterval(function(){
      left--;
      if (left > 0) btn.textContent = '关闭页面 (' + left + 's)';
      else { stopCloseTimer(); window.close(); }
    }, 1000);
  }

  // 隐藏弹窗前必须先掐掉倒计时，否则页面会在用户以为已经取消之后被悄悄关掉
  function hideDone(){
    stopCloseTimer();
    var b = document.getElementById('fp-done-close');
    if (b) b.textContent = '关闭页面';
    document.getElementById('fp-done').style.display = 'none';
  }

  document.getElementById('fp-done-stay').addEventListener('click', function(){
    if (this.hasAttribute('disabled')) return;
    hideDone();
  });

  document.getElementById('fp-done-close').addEventListener('click', function(){
    if (this.hasAttribute('disabled')) return;
    stopCloseTimer();
    window.close();
  });

  document.addEventListener('keydown', function(e){
    if (PREVIEW) return;   // 预览态：不响应打印 / 关闭快捷键，避免误打 iframe
    if (e.key === 'Escape'){ hideDone(); }
    else if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey){
      var t = e.target;
      if (t && (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable)) return;
      window.print();
    }
  });
})();
<\/script>
</body></html>`;

        return html;
    }

    /* ==================================================================
     * 七、输出层
     * ================================================================ */

    // 轮询生成页的就绪标志，避免图片没下载完就打印
    function printWhenReady(win, timeout) {
        timeout = timeout || 20000;
        const t0 = Date.now();
        let fired = false;
        const fire = () => {
            if (fired) return;
            fired = true;
            try { win.focus(); win.print(); } catch (e) { /* 忽略 */ }
        };
        (function poll() {
            let ready = false;
            try { ready = win.__fpReady === true; } catch (e) { ready = true; }
            if (ready || Date.now() - t0 > timeout) fire();
            else setTimeout(poll, 200);
        })();
    }

    /* ==================================================================
     * 八、主流程
     * ================================================================ */

    let busy = false;

    // mode 由调用方传入：'print' = 排版并打印，'save' = 导出 PDF。
    // 只用来决定结果页完成弹窗的文案，不影响排版本身。
    async function generate(mode) {
        const opt = collectOptions();
        $('fp-title').value = opt.title;

        const isShenlun = window.location.href.includes('shenlun');
        const progress = (msg) => setStatus(esc(msg));

        showMask(isShenlun ? '正在抓取材料与题目…' : '正在排版…',
            isShenlun ? '需要逐个切换材料与题目标签，请稍候' : '题目较多时需要十几秒');

        let items;
        try {
            items = isShenlun ? await extractShenlun(progress) : await extractXingce(progress);
        } catch (e) {
            console.error('[试卷排版] 提取失败', e);
            hideMask();
            setStatus('<span style="color:#dc2626">提取失败，请刷新页面重试</span>');
            throw e;
        }

        const questionCount = items.filter((i) => i.kind === 'question').length;
        if (!items.length || questionCount === 0) {
            hideMask();
            setStatus('<span style="color:#dc2626">未找到题目，请确认页面已完全加载</span>');
            alert('没有在当前页面找到题目。\n请确认：\n1. 已进入试卷的做题页面；\n2. 题目区域已完全加载出来。');
            throw new Error('no question');
        }

        // meta.mode 是题型（行测 / 申论），meta.output 是输出方式（打印 / 存 PDF）——
        // 两个维度各用各的字段名，别再塞进同一个 mode 里。
        const html = buildHtml(items, opt, {
            mode: isShenlun ? 'shenlun' : 'xingce',
            output: mode,
            questionCount,
        });
        const matCount = items.filter((i) => i.kind === 'material').length;
        setStatus(`共 <b>${questionCount}</b> 题${matCount ? `，<b>${matCount}</b> 份材料` : ''}`);

        return { html, opt, title: opt.title };
    }

    // 进入做题页后自动统计并显示「共 X 题 / Y 份材料」，无需先点生成。
    // 没有题目（不在做题页）时静默清空、不显示。轻量触发懒加载，不弹遮罩、不开新窗。
    async function autoCount() {
        if (busy) return;
        const isShenlun = location.href.includes('shenlun');
        let q = 0, m = 0;
        if (isShenlun) {
            // 申论：直接数题目 / 材料 tab，不切 tab、不克隆内容，零打扰
            q = Number(document.querySelectorAll('.questions-anchors .tabs-content .tab, .questions-anchors .tab').length
                || document.querySelectorAll('.questions-objective-container app-ti, app-ti').length) || 0;
            m = Number(document.querySelectorAll('app-materials .tabs-content .tab').length) || 0;
        } else {
            try {
                const items = await extractXingce(() => {}, true);
                const arr = Array.isArray(items) ? items : [];
                q = Number(arr.filter((i) => i && i.kind === 'question').length) || 0;
                m = Number(arr.filter((i) => i && i.kind === 'material').length) || 0;
            } catch (e) { setStatus(''); return; }
        }
        if (!q) { setStatus(''); return; }   // 没有题目不显示
        setStatus(`共 <b>${q}</b> 题${m ? `，<b>${m}</b> 份材料` : ''}`);
    }

    async function run(mode) {
        if (busy) return;
        busy = true;
        const pb = $('fp-print'), sb = $('fp-save');
        const pt = pb.textContent, stx = sb.textContent;
        pb.disabled = sb.disabled = true;
        pb.textContent = '处理中…';

        try {
            const { html, opt, title } = await generate(mode);
            const win = window.open('', '_blank');
            if (!win) {
                hideMask();
                alert('浏览器拦截了弹窗。\n请允许本站弹出窗口后重试。');
                return;
            }
            win.document.write(html);
            win.document.close();
            hideMask();
            // 「导出 PDF」与「排版并打印」走同一条路：浏览器「打印」是唯一能保真出 PDF 的路径，
            // 对话框里目标选「另存为 PDF」即存成文件，选真实打印机则直接打印到纸。
            // 「排版并打印」尊重面板的「生成后自动唤起打印」开关；「导出 PDF」强制唤起。
            if (mode === 'save' || opt.autoPrint) printWhenReady(win);
        } catch (e) {
            hideMask();
            if (e && e.message !== 'no question') {
                alert('生成试卷失败：' + (e.message || e));
            }
        } finally {
            busy = false;
            pb.disabled = sb.disabled = false;
            pb.textContent = pt;
            sb.textContent = stx;
        }
    }

    /* ==================================================================
     * 八·二、调整预览（解析一次 → 渲染进 iframe → 实时调参）
     * ================================================================ */

    let previewState = null;
    let previewDebounce = 0;

    // 复用 buildHtml：预览时 output 传 'preview' 且 preview:true（不自动打印/关页）
    function buildPreviewHtml(state, output, preview) {
        return buildHtml(state.items, state.opt, {
            mode: state.isShenlun ? 'shenlun' : 'xingce',
            output: output,
            questionCount: state.questionCount,
            preview: !!preview,
        });
    }

    function renderPreview(state) {
        const ov = $('fp-prev');
        if (!ov) return;
        const frame = ov.querySelector('iframe');
        if (!frame) return;
        const doc = frame.contentDocument;
        if (!doc) return;
        // 重渲染前记住当前滚动位置（doc.open 会清空文档并让滚动归零）
        let y = 0;
        try { const w = frame.contentWindow; y = w ? (w.scrollY || w.pageYOffset || 0) : 0; } catch (e) {}
        doc.open();
        doc.write(buildPreviewHtml(state, 'preview', true));
        doc.close();
        // 分页是异步的（fonts.ready / ~1200ms 后才切页），必须等新文档切页完成
        // （__fpReady 置位）再还原滚动，否则会还原到一个还没切页的旧高度上而跳页。
        const restore = (tries) => {
            const w = frame.contentWindow;
            if (!w) return;
            if (w.__fpReady || tries > 50) {
                try {
                    const max = w.document.documentElement.scrollHeight - w.innerHeight;
                    w.scrollTo(0, Math.max(0, Math.min(y, max)));
                } catch (e) {}
                return;
            }
            setTimeout(() => restore(tries + 1), 60);
        };
        setTimeout(() => restore(0), 80);
    }

    function scheduleRender(state) {
        clearTimeout(previewDebounce);
        previewDebounce = setTimeout(() => renderPreview(state), 180);
    }

    function openPreview() {
        if (busy) return;
        busy = true;
        const isShenlun = window.location.href.includes('shenlun');
        const opt = collectOptions();
        showMask(isShenlun ? '正在抓取材料与题目…' : '正在排版…',
            isShenlun ? '需要逐个切换材料与题目标签，请稍候' : '题目较多时需要十几秒');
        (async () => {
            let items;
            try {
                items = isShenlun ? await extractShenlun(() => {}) : await extractXingce(() => {});
            } catch (e) {
                console.error('[试卷排版] 预览提取失败', e);
                hideMask();
                setStatus('<span style="color:#dc2626">提取失败，请刷新页面重试</span>');
                busy = false;
                return;
            }
            const questionCount = items.filter((i) => i.kind === 'question').length;
            if (!items.length || questionCount === 0) {
                hideMask();
                setStatus('<span style="color:#dc2626">未找到题目，请确认页面已完全加载</span>');
                alert('没有在当前页面找到题目。\n请确认：\n1. 已进入试卷的做题页面；\n2. 题目区域已完全加载出来。');
                busy = false;
                return;
            }
            hideMask();
            buildPreviewUI({
                items, isShenlun, questionCount,
                matCount: items.filter((i) => i.kind === 'material').length,
                opt, title: opt.title,
            });
            busy = false;
        })();
    }

    function buildPreviewUI(state) {
        const old = $('fp-prev');
        if (old) old.remove();   // 每次重建，避免重复绑定事件 / 旧 state 串味
        const ov = document.createElement('div');
        ov.id = 'fp-prev';
        ov.className = 'fp-prev show';
        ov.innerHTML = `
<div class="fp-prev-bar">
  <div class="fp-prev-brand"><span class="fp-emoji">✨</span><span>调整预览</span></div>
  <div class="fp-prev-ctl"><label>字号</label><input type="number" id="fpv-font" step="0.5" min="9" max="22"></div>
  <div class="fp-prev-ctl"><label>行距</label><input type="number" id="fpv-lh" step="0.05" min="1" max="2.2"></div>
  <div class="fp-prev-ctl"><label>题目间距</label><input type="number" id="fpv-qs" min="0" max="40"></div>
  <div class="fp-prev-ctl"><label>大图缩放</label><input type="number" id="fpv-fig" min="20" max="100"></div>
  <div class="fp-prev-ctl"><label>换页方式</label><select id="fpv-pag">
    <option value="smart">智能平衡</option><option value="ultra">极致省纸</option><option value="whole">整题不拆</option>
  </select></div>
  <div class="fp-prev-ctl"><label>页边距</label><select id="fpv-mg">
    <option value="25mm 20mm">宽松</option><option value="15mm 15mm">标准</option><option value="10mm 10mm">紧凑</option>
  </select></div>
  <div class="fp-prev-ctl"><label><input type="checkbox" id="fpv-cover"> 封面页</label></div>
  <div class="fp-prev-sp"></div>
  <button class="fp-btn" id="fpv-print">打印</button>
  <button class="fp-btn2" id="fpv-save">导出PDF</button>
  <button class="fp-btn2" id="fpv-ok">保存并返回</button>
  <span class="fp-prev-x" id="fpv-close" title="关闭">×</span>
</div>
<iframe class="fp-prev-frame"></iframe>`;
        document.body.appendChild(ov);

        // 用面板当前参数初始化
        $('fpv-font').value = state.opt.fontSize;
        $('fpv-lh').value = state.opt.lineHeight;
        $('fpv-qs').value = state.opt.qSpacing;
        $('fpv-fig').value = state.opt.figScale;
        $('fpv-pag').value = state.opt.pagination;
        $('fpv-mg').value = state.opt.margin;
        $('fpv-cover').checked = !!state.opt.cover;

        // 任一参数变动 → 更新 state.opt → 防抖重渲染
        const sync = () => {
            state.opt.fontSize = Number($('fpv-font').value) || state.opt.fontSize;
            state.opt.lineHeight = Number($('fpv-lh').value) || state.opt.lineHeight;
            state.opt.qSpacing = Number($('fpv-qs').value) || state.opt.qSpacing;
            state.opt.figScale = Number($('fpv-fig').value) || state.opt.figScale;
            state.opt.pagination = $('fpv-pag').value;
            state.opt.margin = $('fpv-mg').value;
            state.opt.cover = !!$('fpv-cover').checked;
            scheduleRender(state);
        };
        ['fpv-font', 'fpv-lh', 'fpv-qs', 'fpv-fig'].forEach((id) => $(id).addEventListener('input', sync));
        ['fpv-pag', 'fpv-mg', 'fpv-cover'].forEach((id) => $(id).addEventListener('change', sync));

        $('fpv-print').onclick = () => printFromPreview(state, 'print');
        $('fpv-save').onclick = () => printFromPreview(state, 'save');
        $('fpv-ok').onclick = () => saveFromPreview(state);
        $('fpv-close').onclick = () => closePreview();

        previewState = state;
        renderPreview(state);
    }

    // 预览里点「打印 / 导出PDF」：复用已解析的 items，直接出新版窗口打印，无需重新爬页
    function printFromPreview(state, mode) {
        const win = window.open('', '_blank');
        if (!win) { alert('浏览器拦截了弹窗。\n请允许本站弹出窗口后重试。'); return; }
        win.document.write(buildPreviewHtml(state, mode, false));
        win.document.close();
        printWhenReady(win);   // 用户主动点打印/导出，必定唤起打印对话框
    }

    // 把预览里调好的参数写回面板并持久化，再关掉预览
    function saveFromPreview(state) {
        applySettings({
            fontSize: state.opt.fontSize,
            lineHeight: state.opt.lineHeight,
            qSpacing: state.opt.qSpacing,
            figScale: state.opt.figScale,
            pagination: state.opt.pagination,
            margin: state.opt.margin,
            cover: state.opt.cover,
        });
        saveSettings();
        closePreview();
    }

    function closePreview() {
        const ov = $('fp-prev');
        if (ov) ov.remove();
        previewState = null;
    }

    /* ==================================================================
     * 九、启动
     * ================================================================ */

    injectStyle();
    const { panel } = buildPanel();
    bindPanel(panel, $('fp-mask'), () => run('print'), () => run('save'), () => openPreview());
    // 进入做题页即自动统计题数 / 材料数并显示（轻量，不打扰）；延时等 Angular 渲染完
    setTimeout(autoCount, 1200);
    applySettings(readSettings());
    syncShenlunUI();
    checkUpdate();

    // 把真实试卷名回填到面板：不能用固定延迟。
    // 试卷名是 Angular 异步渲染的，写死 900ms 在慢机器／弱网上会跑空，
    // 于是 readPaperTitle() 退到 document.title（粉笔的静态标题就是「粉笔题库」），
    // 卷子封面上会印出一个毫无意义的「粉笔题库」。改成轮询，读到为止。
    (function pollTitle(deadline) {
        const el = $('fp-title');
        if (!el) return;
        // 用户已经改过或已回填过，不再动它
        if (el.value.trim() && el.value !== TITLE_PLACEHOLDER) return;
        if (document.querySelector('.header-title, .paper-name, .header-center .title')) {
            el.value = readPaperTitle();
            return;
        }
        if (Date.now() >= deadline) { el.value = readPaperTitle(); return; }
        setTimeout(() => pollTitle(deadline), 400);
    })(Date.now() + 10000);

    console.log('%c[试卷排版打印] v' + VERSION + ' 已就绪', 'color:#16a34a;font-weight:bold');
})();
