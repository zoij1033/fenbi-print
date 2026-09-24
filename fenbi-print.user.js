// ==UserScript==
// @name         粉笔试卷排版打印
// @namespace    http://tampermonkey.net/
// @version      1.8.33
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

    const VERSION = '1.8.33';
    const STORE_KEY = 'fenbi_print_settings';
    const STORE_POS = 'fenbi_print_panel_pos';
    const TITLE_PLACEHOLDER = '正在读取当前试卷…';

    // 检查更新 / 立即更新 的权威源：GitHub 官方 API（浏览器内可跨域访问，永远返回 main 分支的真实最新文件，无 CDN 缓存滞后）。
    // 之前用 jsDelivr 的 @main 分支地址做更新源，而该地址在 jsDelivr 上有缓存滞后/卡死，导致「检查更新」永远读到旧快照、报「已是最新」。
    // 现改为直接拉 GitHub API 取真实最新版（含完整脚本内容），下载也直接用 API 返回的内容就地重注入，彻底摆脱 CDN 滞后。
    // 仅当 GitHub API 不可达时，才回退到 jsDelivr @main 兜底（可能滞后，但总比没有强）。
    // 更新逻辑完全内建、硬编码，不依赖小书签代码——书签链接永远锁 @main，今后无需任何改动即可更新。
    const GH_API = 'https://api.github.com/repos/zoij1033/fenbi-print/contents/fenbi-print.user.js?ref=main';
    const UPDATE_FB_URL = 'https://cdn.jsdelivr.net/gh/zoij1033/fenbi-print@main/fenbi-print.user.js';

    // 题号悬挂缩进是固定排版，不提供开关
    const HANG = 2.0;      // 题干悬挂宽度（em）：没有按题计算时的兜底值，容纳三位数题号

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

    // 这些都不是有效试卷名，必须过滤掉（实测三种页面状态各自的返回值）：
    //  · ''                  —— 空
    //  · 'null'/'undefined'  —— Angular 未渲染完时标题元素带 title="null" 占位属性，
    //                            getAttribute 一读到就被 || 短路当成有效值，封面印出「null」
    //  · '粉笔题库'           —— 粉笔做题页的静态 document.title（元素还没渲染时就会退到它），毫无意义
    //  · '粉笔'/'粉笔网'      —— 同类噪音
    const BAD_TITLE = new Set(['', 'null', 'undefined', '粉笔', '粉笔网', '粉笔题库']);

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
            // 兜底顺序：① 面板里用户填的（或已回填的）→ ② 页面真实标题 → ③ 兜底名。
            // 拦截 'null'/'undefined'：把 null 赋给 input.value 会被 JS 强转成字符串 'null'。
            // readPaperTitle() 读不到时可返回空串，这里必须再兜一层，否则封面会印出空白。
            title: (function () {
                const v = ($('fp-title').value || '').trim();
                if (v && !BAD_TITLE.has(v)) return v;
                return readPaperTitle() || '公务员录用考试试卷';
            })()
        };
    }

    // 从页面读取当前试卷标题。读不到「有意义的名字」时返回 ''（不编造），
    // 由调用方决定是提示用户还是用兜底标题 —— 「拿不到就明说」比印个假名字好。
    function readPaperTitle() {
        const cand = [];
        for (const sel of ['.header-title', '.paper-name', '.header-center .title']) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const raw = el.getAttribute('title');
            const t = (raw == null ? '' : String(raw).trim()) || (text(el) || '').trim();
            if (t && !BAD_TITLE.has(t)) cand.push(t);
        }
        const dt = (document.title || '').trim();
        if (dt && !BAD_TITLE.has(dt)) cand.push(dt);
        return cand.length ? cand[0] : '';
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
    // 重注入逻辑同 1.8.1（删除固定 5 个 UI 节点后注入新版），经长期验证稳定。
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

    // 给「行内公式图」（flag="tex"）锁定尺寸与对齐。
    //
    // 关键认知：公式图形态差异极大，**不能用同一条规则定尺寸**。按宽高比（粉笔内联 aspect-ratio，
    // 永远存在；data-fp-ar 兜底）分三档，实测数据（字号 18px，单位「字」）：
    //   ① 瘦高（高 ≥ 宽×1.4，如分数 20/43）：分子分母上下排布，视觉尺寸取决于**宽度**。
    //      按高度锁 1.15em 时宽度只剩 0.6 字 → 明显偏小；改按**宽度 1em**，高约 2.15 字，上下撑开，
    //      与文字观感一致。（旧版从 1.8.10 起一直按高度锁，故分数始终显得小。）
    //   ② 常规符号（宽高接近，如摄氏度 / 单字母 / 上下标，约 40/30）：视觉尺寸取决于**高度**。
    //      按高度 1.15em 最稳；若按宽度会变成 0.75 字高，偏小。
    //   ③ 长公式（宽 ≫ 高，如 200/30）：必须按**高度**锁，宽度自然撑开（实测 7.66 字）。
    //      若按宽度锁 1em，高度会塌成 0.15 字 —— 扁成一条线，完全看不清。
    // 因此：只有「瘦高」才按宽度，其余一律按高度。这样三类图各自都合适，互不影响。
    //
    // 另：尺寸一律用「内联 !important」写死 —— 脚本后写的内联 !important 天然压过粉笔的内联
    // !important 与任何样式表，不再依赖「清掉内联 + 类选择器优先级」这条脆弱链路。
    // ⚠️ 作用域警告：`applyTexSize` 定义在【生成页自己】的 <script> 里（那是另一个文档、
    //    另一个作用域），**外层这份脚本调不到它** —— v1.8.17 初版就是栽在这里，
    //    真机上直接抛 `applyTexSize is not defined`，整个生成流程中断、试卷出不来。
    //    所以下面这份逻辑必须在外层【另存一份】。改判定时**两处都要改**，
    //    行尾都标了「同步点」，可用编辑器搜索该词逐个核对。
    //
    // ============================ 尺寸模型（1.8.19 重写） ============================
    // 前面几版一直用一个「宽高比阈值」把公式图分成「分数档 / 符号档」，再各给一套尺寸。
    // 那个模型是错的 —— 它解释不了真机的现象，而且越调越乱：
    //   20/43(3/2) 判成分数、29/43(15/2) 判成符号、37/43(-2/3) 又判成符号，
    //   于是一道题里三个分数三个大小。用户的原话是「分子分母只有一位数且没有负号的就正常」，
    //   完全对上 —— 因为能落到 20/43 的恰好只有这种情况。
    //
    // 粉笔原生是怎么做的？把它的公式图逐张下载下来量，答案很干净：
    //   图片 URL 里写死 fontSize=18，所以**图片内部就是用 18px 字号渲染出来的**。
    //   粉笔的 CSS 只做一件事：**按原始像素 1:1 显示，不做任何缩放**。
    //   因为“图片内部字号”与“正文字号”本来就是同一个数，天然一样大 —— 不需要任何缩放逻辑。
    // 实测佐证（22 张真机图，字号 18）：
    //   外框高 43 的 18 张（3/2、15/2、-2/3…）内部墨迹高 36~37 —— 两行构成，是分数；
    //   外框高 20~23 的 4 张（30°、△AOD…）内部墨迹高 14 —— 单行构成，是整式/符号。
    //   而正文 18px 汉字的墨迹高也正好约 14：**整式的墨迹与正文同高**，这就是“一样大”的由来。
    //   注意分数外框 43 与整式外框 20 差了两倍多，但它们视觉上一样大 ——
    //   因为分数那 43px 里装的是**两行**，每行还是 18px 字号。**外框高根本不是判断依据**。
    //
    // 所以正确的做法只有一条：**等比缩放，让“图片内部字号”等于“当前正文字号”**。
    //   图片是按 fontSize=18 渲染的 → 缩放比 = 正文字号px / 18 → 显示尺寸 = 原始像素 × 该比值。
    //   这样无论正文用 15px 还是 25px，公式内部的字始终和旁边的正文一样大，
    //   分数、整式、长公式、多位数分数全部自动正确 —— 不再需要任何“分档”“阈值”“特判”。
    //   粉笔的原生 CSS 之所以不用缩放，只是因为它正文字号恰好也是 18。
    // 基线对齐同理：图片底边那个像素行就是基线所在（粉笔导出的图统一留了 3px 下边距），
    //   所以 `vertical-align: baseline` 就够了，同样不需要按比例算下沉量。
    // ================================================================================
    var TEX_BASE_PX = 18;    // 公式图 URL 里 fontSize 的固定值，是等比缩放的基准 —— 同步点
    // ============================ 对齐规则（1.8.23 修正）============================
    // 需求：**图片的中线与文字的中线落在同一条水平线上**（分数上下各露出一半）。
    //
    // 1.8.22 的公式本身是对的，但它**一次都没跑起来**。真机 DOM 佐证：脚本写下的
    //   vertical-align 全是 -0.17em，正是当时的兜底常量 —— 说明正常路径全部落空。
    //
    // 根因（已用无头 Chromium 复现）：tagTexFracImg 由 markTexFrac() 在**游离的 div** 上调用
    //   （d = document.createElement('div'); d.innerHTML = html;），
    //   此时 <img> 还没进文档、没有开始加载：
    //       游离节点 nw=0 complete=false ／ 插入文档同步读 nw=0 ／ 500ms 后 nw=20
    //   而 1.8.22 第一行就是 `if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) return;`
    //   → 直接返回，尺寸与对齐一个都没写。
    //
    // 1.8.23 修法：**把「量不到」变成「量得到」**，公式不动。
    //   关键认知：算 va **根本不需要图片像素** ——
    //     va = 文字视觉中线/字号 − 图高(em)/2
    //   推导：设 va = V（em），图高 = H（em），则图中线在基线上方 (V + H/2)·fs。
    //         令其等于文字视觉中线 charMid，解出 V = charMid/fs − H/2。
    //   其中 charMid 由 canvas 画「国」字量得、H 由**属性**（data-fp-tex-ar 等）解析，
    //   两者都不依赖图片解码 → 游离节点里同样算得准。
    //   （1.8.22 的旧式 va = charMid/fs − H + inkMidEm 要求读图墨迹中线，
    //     才被迫等到解码；而那个等，就是它彻底失效的原因。两者数学等价，
    //     都是「让图中线落在文字中线上」，新式只是把依赖砍掉了。）
    //
    //   逐图算 va，不写死：3/2（20×43）与 15/2（29×43）比例不同、图高不同
    //   → va 必须不同（18px 下分别约 -0.685em 与 -0.351em），写死一个值必然有一类错位。
    //
    //   文字视觉中线怎么来：**运行时用 canvas 实画一个「国」字量出来**，不写常数。
    //     实测「文字墨迹中线 / 字号」比值在 0.375~0.425 之间浮动（±6%），
    //     因为汉字墨迹底边距基线的距离随字号在 1~3px 间非整数变化，写死一个 em 常数
    //     必然在某个字号区间失准（实测写死 -0.80em 时 22px 起偏差涨到 +0.8~+1.5px）。
    //     用 canvas 实测则任何字号、任何字体都准 —— 实测 16~40px 九个字号，偏差 ≤ 0.02px。
    //
    //   ⚠️ 别再退回「按底留白贴基线」（1.8.20 的做法）：那会把分数压到基线上，
    //      正是用户报的「分数比文字低一大截」。尺寸与对齐这两件事必须分开看。
    //
    //   顺序提示：设置图片尺寸会触发回流。批量处理时先把尺寸都钉死、再统一量基线，
    //     中途混着来会让先量的基线失效（实测偏差涨到 ±18px）。
    var TEX_REF_CHAR = '国';   // 度量参考字：全包围结构，墨迹范围最贴近汉字的视觉中心 —— 同步点
    var TEX_CHAR_MID_REF = 0.39;  // canvas 量不到时的兜底「文字视觉中线÷字号」—— 同步点
    // ↑ 兜底用的「文字视觉中线 ÷ 字号」。只在 canvas 量不到时用（如画布不可用）。
    //   实测该比值在 0.375~0.425 之间浮动，0.39 是中间值；正常运行走 canvas 实测，不读它。
    var texInkCache = Object.create(null);   // 图片墨迹缓存：同一张图不重复画 canvas
    var texCharMidCache = Object.create(null);  // 文字视觉中线缓存：按 字号+字体 缓存

    // 量出图片的「墨迹包围盒」——给出上下留白、墨迹高、以及**墨迹中线距图顶**。
    // 必须真读像素：粉笔导出的图没有统一的留白约定（实测 3~6px 不等），
    // 靠高度、宽高比、或者经验常数都推不出来。
    function measureTex(img) {
        var key = img.src;
        if (key in texInkCache) return texInkCache[key];
        var res = null;
        try {
            var w = img.naturalWidth, h = img.naturalHeight;
            var cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            var ctx = cv.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);   // 显式给目标宽高，按自然尺寸 1:1 采样
            var data = ctx.getImageData(0, 0, w, h).data;
            var top = -1, bottom = -1;
            for (var y = 0; y < h; y++) {
                var has = false;
                for (var x = 0; x < w; x++) {
                    if (data[(y * w + x) * 4 + 3] > 24) { has = true; break; }
                }
                if (has) { if (top < 0) top = y; bottom = y; }
            }
            // 全透明图（坏图）不动它，免得算出荒唐的下沉量
            if (bottom >= 0) {
                res = {
                    padBottom: h - 1 - bottom,
                    inkH: bottom - top + 1,
                    inkMid: (top + bottom + 1) / 2   // 墨迹中线距**图顶**的距离（原始像素）
                };
            }
        } catch (e) {
            // canvas 被跨域污染等情况：读不到就退回兜底值，不影响尺寸缩放
            res = null;
        }
        texInkCache[key] = res;
        return res;
    }

    // 量「文字视觉中线」在基线上方多少 px（当前字号、当前字体下）。
    // 做法：造一张 canvas，把一个「国」字按当前字号画上去，逐像素找出墨迹的上下边界，
    //       再减去基线位置 —— 汉字墨迹是上下不对称的（实测「某」上 16px、下 1px），
    //       所以视觉中线在基线上方约 0.4 个字号高，而不是行盒中心。
    function measureCharMid(fontSize, fontFamily) {
        var key = fontSize + '|' + fontFamily;
        if (key in texCharMidCache) return texCharMidCache[key];
        var res = null;
        try {
            var S = Math.ceil(fontSize * 4);          // 画布留足余量：4 倍字号
            var baseY = Math.ceil(fontSize * 2);      // 基线放在画布纵向中间偏下
            var cv = document.createElement('canvas');
            cv.width = S; cv.height = S;
            var ctx = cv.getContext('2d');
            ctx.font = fontSize + 'px ' + fontFamily;
            ctx.fillStyle = '#000';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(TEX_REF_CHAR, fontSize, baseY);
            var data = ctx.getImageData(0, 0, S, S).data;
            var top = -1, bottom = -1;
            for (var y = 0; y < S; y++) {
                var has = false;
                for (var x = 0; x < S; x++) {
                    if (data[(y * S + x) * 4 + 3] > 24) { has = true; break; }
                }
                if (has) { if (top < 0) top = y; bottom = y; }
            }
            if (bottom >= 0) {
                // 基线上方为正：墨迹顶距基线 baseY-top，墨迹底在基线下 bottom-baseY
                res = ((baseY - top) - (bottom - baseY)) / 2;
            }
        } catch (e) { res = null; }
        texCharMidCache[key] = res;
        return res;
    }

    // 按当前字号与字体，算出应写入的 vertical-align（em 字符串）。
    //
    // 两档精度（这点是 1.8.23 的关键，实测数据支撑见下）：
    //
    //   ① 图已解码（能读到墨迹）→ 用**墨迹中线**，精确：
    //        va = charMid/fs − 图高(em) + (墨迹中线距图顶 / 18)
    //   ② 图未解码（游离节点，读不到像素）→ 用**图高的一半**近似：
    //        va = charMid/fs − 图高(em)/2
    //
    //   为什么不能只用 ②：**墨迹中线并不在图的正中**。实测五张真机图，墨迹中线距图顶
    //   与「图高/2」的差：3/2 与 15/2 是 −0.5px、−2/3 与 30° 是 0、**△AOD 是 −1.5px**。
    //   直接用图高的中点，△AOD 就会低 1.5px（实测偏差 +1.53px，肉眼可见）。
    //
    //   为什么不能只用 ①：它在图片解码前算不出来，而 tagTexFracImg 恰恰跑在
    //   **游离的 div** 上（图还没开始加载）—— 1.8.22 就死在这里，一次都没生效。
    //
    //   两档配合：游离阶段先用 ② 保证「有值可用」（误差 ≤1.5px），
    //   生成页 scaleFigures 在图片解码后调 applyTexSize 用 ① 精修（偏差 ≤0.02px）。
    function texAlignEm(img, imgHEm, ink) {
        var fs = parseFloat(getComputedStyle(img).fontSize);
        if (!(fs > 0)) return null;
        var fam = getComputedStyle(img).fontFamily || 'serif';
        var charMid = measureCharMid(fs, fam);
        if (charMid === null) return null;
        var k = 1 / TEX_BASE_PX;
        // 墨迹中线距图顶（em）。读不到就用图高的中点近似。
        var inkMidEm = ink ? (ink.inkMid * k) : (imgHEm / 2);
        var v = (charMid / fs) - imgHEm + inkMidEm;
        if (!isFinite(v)) return null;
        return v.toFixed(4) + 'em';
    }

    // 解析公式图的原始宽高（px）。三个来源按可信度依次尝试 ——
    // 真机上它们会互相缺失、还会被写成 auto，必须逐项校验（1.8.16 的教训）：
    //   ① data-fp-tex-ar 属性  —— 脚本自己回写的，最可信
    //   ② data-fp-ar 属性      —— 粉笔原始标记（图片加载完成后才异步补上，常常没有）
    //   ③ 内联 aspect-ratio    —— 只有不是 "auto" 时才有效
    //   ④ naturalWidth/Height  —— 图已解码时的实际像素，最后的兜底（游离节点里为 0）
    function texNatSize(img) {
        var cands = [
            img.getAttribute('data-fp-tex-ar'),
            img.getAttribute('data-fp-ar'),
            img.style.aspectRatio,
            (img.naturalWidth > 0 && img.naturalHeight > 0)
                ? (img.naturalWidth + '/' + img.naturalHeight) : ''
        ];
        for (var i = 0; i < cands.length; i++) {
            var mm = String(cands[i] || '').match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
            if (mm) {
                var w = parseFloat(mm[1]), h = parseFloat(mm[2]);
                if (w > 0 && h > 0) return { w: w, h: h };
            }
        }
        return null;
    }

    function tagTexFracImg(img) {
        // ⚠️ 这个函数**不能在读不到 naturalWidth 时提前返回**。
        //    它由 markTexFrac() 在**游离的 div** 上调用（d.innerHTML = html），
        //    此时 <img> 还没插入文档、尚未开始加载，naturalWidth 必然是 0。
        //    1.8.22 第一行就是 `if (!(naturalWidth > 0)) return;`，
        //    于是在真机上**一次都没生效**，尺寸与对齐全部落空 —— 实测复现：
        //      游离节点 nw=0 complete=false ／ 插入文档同步读 nw=0 ／ 500ms 后 nw=20
        //    正确做法：宽高比优先从属性解析（不依赖解码），尺寸照写；
        //    只有「量墨迹」这一步才需要解码，量不到就退回按图高算 va。
        const size = texNatSize(img);
        if (!size) return;   // 四个来源全落空：不猜，留给生成页 scaleFigures 解码后补
        // —— 同步点：与生成页 applyTexSize 等价的等比缩放 ——
        const U = 'important';
        const k = 1 / TEX_BASE_PX;          // 每 1px 原始像素对应 k 个「字号单位」
        const wEm = size.w * k, hEm = size.h * k;
        img.style.setProperty('aspect-ratio', 'auto', U);
        img.style.setProperty('max-width', 'none', U);
        img.style.setProperty('max-height', 'none', U);
        img.style.setProperty('object-fit', 'contain', U);
        // 用 em 表达：em 就是当前字号，正文一变大图片自动跟着等比放大
        img.style.setProperty('width', wEm.toFixed(4) + 'em', U);
        img.style.setProperty('height', hEm.toFixed(4) + 'em', U);
        // ---- 摆正：让图的中线落在文字视觉中线上 ----
        // 图片通常还没解码（游离节点），此时 measureTex 返回 null，
        // texAlignEm 会自动退回「按图高中点」的近似值 —— 有值总比没值强，
        // 且生成页 scaleFigures 会在解码后用墨迹中线精修一次。
        const ink = measureTex(img);
        const v = texAlignEm(img, hEm, ink);
        if (v !== null) {
            img.style.setProperty('vertical-align', v, U);
        } else {
            // 连文字中线都量不到（canvas 不可用）：用实测参考值 0.39em 兜底。
            // 注意**绝不能**再用「按底留白贴基线」那套 —— 那是 1.8.20 的做法，
            // 会把分数压到基线上，正是用户报的「分数比文字低一大截」。
            img.style.setProperty('vertical-align', (TEX_CHAR_MID_REF - hEm / 2).toFixed(4) + 'em', U);
        }
        // 保留这个类只为兼容旧样式表，尺寸不再依赖它
        img.classList.remove('fp-tex-frac');
        // —— 同步点结束 ——
    }
    function markTexFrac(html) {
        const d = document.createElement('div');
        d.innerHTML = html;
        d.querySelectorAll('img[flag="tex"]').forEach(tagTexFracImg);
        return d.innerHTML;
    }

    // 题干：抓 app-format-html，取不到再退到 article.content
    function pickStem(ti) {
        const box = ti.querySelector('app-format-html') || ti.querySelector('article.content');
        if (!box) return '';
        // 过长的下划线/空格统一成等长填空线，避免撑破版面；
        // 行内公式图按 latex 内容补分数标记（fp-tex-frac），供渲染层单独放大、下沉对齐
        return markTexFrac(blankify(box.innerHTML));
    }

    // 选项：返回 [{letter, html, units, imgW}]
    // 列数布局不在这里定 —— 那依赖字号与页边距，交给渲染层算
    function pickOptions(ti) {
        const nodes = ti.querySelectorAll('li[class*="choice"], .option-item');
        const empty = { options: [], allImage: false, hasBigImg: false, maxUnits: 0, maxImgW: 0 };
        if (!nodes.length) return empty;

        let allImage = true, hasBigImg = false, anyImg = false;
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
            if (hasMedia) anyImg = true;
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
            holder.querySelectorAll('img[flag="tex"]').forEach(tagTexFracImg);
            return { letter: esc(letter), html: holder.innerHTML.trim(), units, imgW };
        });

        let maxUnits = 0, maxImgW = 0;
        options.forEach((o) => {
            if (o.units > maxUnits) maxUnits = o.units;
            if (o.imgW > maxImgW) maxImgW = o.imgW;
        });

        return { options, allImage, hasBigImg, anyImg, maxUnits, maxImgW };
    }

    // 题目最外层容器（只用来做「往下找 app-ti」的根，不参与任何排版计算）。
    //
    // ⚠️ 先把丑话说在前面：这个函数**不是**「课程题组抓不到」解药，别误会它。
    //   本版（1.8.33）曾一度断言「课程题组没有 .tis-container」，那是**错的** ——
    //   拿用户两次回传的真机 DOM 逐层比对，课程题组的结构是
    //     app-exercise > app-nav-header + div.exercise-main > app-tis > div.tis-container
    //   —— .tis-container 明明白白在那儿，其下 9 道题一个不少。
    //   用真机 DOM 1:1 构造页面 + 无头 Chromium 实跑复验（t30/probe_tiroot.js）：
    //     ① 课程题组（真 DOM，题目已渲染）→ 根 = .tis-container，抓到 9 题 ✅
    //     ② 课程题组（外壳都在、app-ti 尚未渲染）→ 抓到 0 题  ← 用户遇到的现场
    //     ④ 题库专项练习                    → 根 = .tis-container，抓到 5 题 ✅
    //     ⑤ 真题卷（回归对照）              → 根 = .tis-container，抓到 3 题 ✅
    //   旧代码的 document.querySelector('.tis-container') 本来就能命中，
    //   所以**选择器从来不是病根** —— 真正的原因是**时序**：
    //   课程页从 www.fenbi.com/ai-lecture/… 套 iframe 进来，题目由 Angular 异步塞进 DOM，
    //   脚本跑的时候容器（乃至 .tis-container 本身）还没生成，于是抓到 0 题。
    //
    //   那这个兜底还有没有用？有，但只对「外壳名不同」的页面有用（前几级命中即生效），
    //   对上面 ② 那种「页面里本来就没题」的时序场景**救不了** ——
    //   ② 里 app-tis 自己也没有 app-ti，循环照样跳过，一路退到 body。
    //   真正解决课程题组的是启动层的「轮询到有题为止 + 路由变化重跑」，
    //   见 runInit / startPollCount。这里保留兜底只是为将来别种外壳留一手。
    //
    //   ⚠️ 返回值的**语义**是「装着题目的那个盒子」，只用于 querySelectorAll 往下找题；
    //     不要拿它当滚动容器或量高度。真题卷下它仍返回 .tis-container，
    //     与旧行为完全一致 —— 分页表现不受影响
    //     （已跑 regress_num_clip 六档悬挂验证：页数 9、撕开次数与基线一致、
    //       题号不可见 = 0、字符守恒 = true，见 t30 实测记录）。
    function tiRoot() {
        for (const sel of ['.tis-container', 'app-tis', 'app-exercise', '.exercise-container', '.paper-container']) {
            let el = null;
            try { el = document.querySelector(sel); } catch (e) { /* 选择器异常则跳过 */ }
            if (el && el.querySelector('app-ti')) return el;
        }
        // 兜底：.ti 是课程题组的题目外框，取它的公共祖先，
        // 别把范围缩到单道题上（否则 countTis 永远只数到 1）。
        const one = document.querySelector('.ti app-ti');
        if (one) {
            const box = one.closest('.ti');
            if (box && box.parentElement) return box.parentElement;
        }
        // 返回 body 是**刻意保留**的旧行为：页面没渲染完时先按 body 找，
        // 后面的「重试一次」会再抓；返回 null 会让调用处炸在 .querySelectorAll。
        return document.body;
    }

    // ---- 行测：滚动加载后直接读取 ----
    async function extractXingce(onProgress, quick) {
        onProgress && onProgress('正在加载全部题目…');

        const scroller = findScroller();
        const isWin = scroller === window;
        // 题目容器：真题卷、课程题组、题库专项练习**都有 .tis-container**
        // （拿用户真机 DOM 实测确认过，别信「课程题组没有这个外壳」那种说法），
        // 统一走 tiRoot() 只为兜住将来别种外壳；抓不到题的真正原因是时序，
        // 靠 runInit / startPollCount 的轮询解决，不靠这里。
        const countTis = () => tiRoot().querySelectorAll('app-ti').length;

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

        const root = tiRoot();
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
                    anyImg: picked.anyImg,
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
        // 图片需求宽用「渲染框上限 140px」封顶：选项里的小图在 CSS 里被限制在 140×100 的框内
        // （object-fit:contain），若按原图自然宽度（粉笔常给 200~300px 的 width 属性）估算，
        // 会把本可横排四个的小图误判成 grid-1，导致一行一个、且图片被拉满整行宽。
        const textNeed = q.maxUnits * opt.fontSize + (q.allImage ? 0 : opt.fontSize * 2.5);
        // 1.8.6：纯图题（粉笔公式图无 width 属性 → maxImgW=0）若直接按 maxImgW 算，
        // 会让 imgNeed=0、need=0，命中下方 need<=0 兜底 → 强制 grid-1 一行一个、页面空旷。
        // 既然 CSS 已把图锁在 140×100 渲染框内，这里对「无可读宽度的小图」按固定值反推，
        // 让 layoutFor 仍能按真实占位选 grid-2/4。有 width 属性的大图仍走原 maxImgW 路径（封顶 140）。
        // 1.8.8 修正：140 特判必须同时满足 anyImg（选项里真有 <img>）。
        // 1.8.9 修正：特判值从 140 降到 70。
        // 原值 140 对行内公式图（分数 √ 等，实际 ~35px 宽）高估了约 4 倍，
        // 页边距 ≥20mm 时就把本该一行 4 个的短选项顶成 grid-2。
        // 70px 足以容纳常见行内公式图，同时在各常用页边距下都能归到 grid-4；
        // 有 width 属性的大图仍走 Math.min(maxImgW*figScale/100, 140)，不受影响。
        const imgNeed = q.allImage && !q.hasBigImg && q.anyImg
            ? 70
            : Math.min(q.maxImgW * opt.figScale / 100, 140);
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
/* 禁用浏览器「字号调整」（也称「文字缩放」）对本页的二次放大。
   公式图尺寸写的是 em（1em / 1.15em），字号一被调整，**图片跟着一起放大**，
   而粉笔公式图本身是位图，放大就发虚、和文字不再是同一套比例。
   关掉它之后，打印页永远按脚本自己算好的 px 字号渲染，所见即所得。 */
html{-webkit-text-size-adjust:none!important;text-size-adjust:none!important}

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

/* 被撕开的题/材料壳（fp-cont）：这道题（或这段材料）在本壳之后还有续排内容，
   也就是说这个壳不是「这道题的结尾」，后面跟的是同一道题的下一截，不是新题。
   此时不能吃「题目与题目之间」的间距（${opt.qSpacing}px），否则撕开接缝处（C|D 之间）
   的间距会明显大于同壳内选项间距（A/B/C），看起来像凭空多空了一行。

   ⚠️ 1.8.25 修正：一开始这里直接写成 margin-bottom:0，结果接缝反而**偏小** ——
   用户真机反馈「C/D 的间距比 A/B/C 略小几个像素」。原因在于接缝处的间距不是
   单一来源，而是两侧各自的空隙相加：

     同壳内 A→B→C：靠 .fp-opts 的 row-gap（.5em ≈ 8px）

     C→D 跨壳时：  壳1 的 margin-bottom（当时被清零 = 0）
                 + 壳2 里 .fp-opts 自己的 margin-top（.3em ≈ 4.8px）
                 = 4.8px  ← 比 8px 小了一截

   所以正确的做法不是「清零」，而是「补齐到和 row-gap 一样」：
   把 .fp-cont 的下间距补成 (row-gap − 下一壳顶部的 margin-top)。
   .fp-opts 的 margin-top 是 .3em、row-gap 是 .5em，差值 .2em —— 用 calc 直接算，
   不手写像素数字：改行距/间距配置时这里跟着变，不会留下对不上的硬编码。

   注意只动 margin-bottom，不碰 padding —— padding 参与高度计算，
   改了会让分页器量到的页高和实际对不上。 */
.fp-q.fp-cont{margin-bottom:calc(.5em - .3em)}
.fp-mat.fp-cont{margin-bottom:calc(.5em - .3em)}

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
/* 选项中的图片一律限制在 140×100 框内（object-fit:contain），
   避免某选项被误判成「文字选项」时，图片走 max-width:100% 在整行下被等比放大占半页 */
.fp-stem img,.fp-opt img{vertical-align:middle;max-width:100%;height:auto}
.fp-opt img{max-width:140px!important;max-height:100px!important;object-fit:contain}
.fp-num{float:left;margin-left:calc(-1 * var(--hang,${HANG}em));margin-right:.5em;font-family:"Times New Roman","SimSun",serif}

/* 选项与题干的悬挂位置对齐，换行后仍从字母右侧起排。
   用 flex-wrap 而不是 grid：每个 .fp-opt 是独立可搬的盒子，
   排版时才能把选项组拆到两页上，到了新页仍按同样的列宽排。 */
.fp-opts{display:flex;flex-wrap:wrap;column-gap:18px;row-gap:.5em;margin-top:.3em;padding-left:var(--ohang,${HANG}em)}
/* 选项列数由 layoutFor 按「整组最长项」统一决定（grid-1 / grid-2 / grid-4），
   整组共用同一个 class —— 因此同一道题的选项永远列数一致：
   要么都横排（4 个或 2 个一行），要么都逐行独占，绝不会出现
   「有的横排、有的折行」的参差排版。
   短组（最长项够窄）→ grid-4 一行 4 个；中组 → grid-2 一行 2 个；
   长组（任一选项长到要独占一行）→ grid-1 整组逐行。 */
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
/* 行内公式图（flag="tex"）的**兜底**规则 —— 只在 JS 还没量出图片真实像素时生效。
   真正的尺寸与对齐由 tagTexFracImg / applyTexSize 写成内联 !important：
     尺寸 = 原始像素 ÷ 18（等比缩放，让图片内部字号等于正文字号）；
     对齐分两类 —— 单行公式贴基线、分数类用 vertical-align:middle 行内居中。
   这里刻意**不写 width/height/vertical-align**，免得与内联值打架。
   为什么兜底不预设 vertical-align？因为「分数 vs 单行」必须靠**墨迹高度**判断
   （分数 36~37px、单行 14px），CSS 读不到图片像素，任何写死的值都会有一类对不上。 */
.fp-stem img[flag="tex"],
.fp-opt:not(.fp-opt-img) img[flag="tex"]{
  max-width:none!important;max-height:none!important;
  object-fit:contain}
/* ⚠️ 这里**刻意不声明 vertical-align** —— 对齐分两类（单行贴基线 / 分数行内居中），
   而分类只能靠**墨迹高度**判定（要读图片像素，CSS 做不到）。
   任何写死的值都必然让其中一类错位；JS 每次都会把算好的值写成内联 !important，
   这里再声明一遍只会平添「谁压过谁」的麻烦（1.8.21 调试时就栽在这上面：
   本节的 vertical-align 与上面给普通配图的 middle 规则互相打架，
   结果公式图的 vertical-align 被改成了 baseline，分数居中直接失效）。 */
.fp-opt:not(.fp-opt-img) img[flag="tex"]{
  /* 重置通用规则给普通配图的 vertical-align:middle —— 公式图由 JS 内联值决定 */
  vertical-align:baseline}
.fp-stem img[flag="tex"]{/* 同上，不声明 —— 由 JS 内联值决定 */}

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
.fp-opt-img img{display:block;width:auto;max-width:140px!important;max-height:100px!important;height:auto;margin:0;vertical-align:top;object-fit:contain}

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
                        // 仅「整题纯图 + 存在大图」才按图片选项布局（fp-opt-img block 模式）：
                        //   - 混合选项（A/B 文字 + C/D 图）：allImage=false → inline，图片与字母同行
                        //   - 纯小图题（四个都是分数公式等小尺寸 LaTeX 图）：allImage=true 但 hasBigImg=false → inline
                        //   - 纯大图题（几何图形/图表等 width>120）：allImage=true + hasBigImg=true → block
                        // 靠 CSS .fp-opt:not(.fp-opt-img) img{display:inline-block} 让 inline 选项的图片与字母同行
                        const isImgOpt = it.allImage && it.hasBigImg;
                        html += `<div class="fp-opt${isImgOpt ? ' fp-opt-img' : ''}">${oh}</div>`;
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

  // ---- 行内公式图的尺寸出口（1.8.19 重写：等比缩放）--------------------------
  // ⚠️ 这份代码与外层 tagTexFracImg 是**同一套逻辑的两份拷贝**，必须同步改。
  //    看似重复，但两段分属不同文档、不同作用域（外层注入粉笔页面，这里跑在生成的试卷页里），
  //    函数不通用 —— 1.8.17 曾试图「只留一份」，结果外层调不到这里的函数，真机直接抛
  //    报错「applyTexSize is not defined」，试卷整个生成不出来。所以只能各存一份。
  //    改判定时**两处都要改**，行尾都标了「同步点」，可用编辑器搜索该词逐个核对。
  //
  // 前面几版（1.8.11~1.8.18）一直用「宽高比阈值」把公式图分成「分数档 / 符号档」，各给一套尺寸。
  // 那个模型是错的，它解释不了真机现象，而且越调越乱：
  //   20/43(3/2) 判成分数、29/43(15/2) 判成符号、37/43(-2/3) 又判成符号，
  //   于是一道题里三个分数三个大小。用户的描述是「分子分母只有一位数且没有负号的就正常」，
  //   完全对上 —— 因为能落进 20/43 这个比例的，恰好只有这一种情况。
  //
  // 粉笔原生是怎么做的？把它的公式图逐张下载来量，答案很干净：
  //   图片 URL 里写死 fontSize=18，所以**图片内部就是用 18px 字号渲染出来的**。
  //   粉笔的 CSS 只做一件事：**按原始像素 1:1 显示，不做任何缩放**。
  //   因为「图片内部字号」与「正文字号」本来就是同一个数，天然一样大 —— 根本不需要缩放逻辑。
  // 实测佐证（真机 22 张图去重后）：
  //   外框高 43 的 18 张（3/2、15/2、-2/3…）内部墨迹高 36~37 —— 两行构成，是分数；
  //   外框高 20~23 的 4 张（30°、△AOD…）内部墨迹高 14 —— 单行构成，是整式/符号。
  //   而正文 18px 汉字的墨迹高也正好约 14：**整式的墨迹与正文同高**，这就是「一样大」的由来。
  //   注意分数外框 43 与整式外框 20 差了两倍多，视觉上却一样大 ——
  //   因为分数那 43px 里装的是**两行**，每行还是 18px 字号。**外框高根本不是判断依据。**
  //
  // 所以正确的做法只有一条：**等比缩放，让「图片内部字号」等于「当前正文字号」**。
  //   缩放比 = 正文字号px / 18 → 显示尺寸 = 原始像素 × 该比值。
  //   用 em 表达后，正文一变大图片自动跟着变，无需监听字号变化。
  //   分数、整式、长公式、多位数分数全部自动正确 —— 不再需要任何「分档」「阈值」「特判」。
  //   粉笔原生 CSS 之所以不用缩放，只是因为它正文字号恰好也是 18。
  // ============================ 对齐规则（1.8.23 修正）============================
  // 需求：**图片的中线与文字的中线落在同一条水平线上**（分数上下各露出一半）。
  //
  // 1.8.22 的公式本身是对的，但它**一次都没跑起来**。真机 DOM 佐证：脚本写下的
  //   vertical-align 全是 -0.17em，正是当时的兜底常量 —— 说明正常路径全部落空。
  //
  // 根因：外层 tagTexFracImg 由 markTexFrac() 在**游离的 div** 上调用，
  //   此时 <img> 还没进文档、没有开始加载（实测游离节点 nw=0，500ms 后才 nw=20），
  //   而 1.8.22 开头那句「读不到 naturalWidth 就 return」直接跳过了整个函数，
  //   尺寸与对齐一个都没写。（真正的判断见外层 tagTexFracImg 的实现。）
  //   ⚠️ 本段代码位于外层模板串内，注释里**不能出现反引号**，否则会提前闭合模板串。
  //
  // 1.8.23 修法：**把「量不到」变成「量得到」**，公式不动。
  //   关键认知：算 va **根本不需要图片像素** ——
  //     va = 文字视觉中线/字号 − 图高(em)/2
  //   推导：设 va = V（em），图高 = H（em），则图中线在基线上方 (V + H/2)·fs。
  //         令其等于文字视觉中线 charMid，解出 V = charMid/fs − H/2。
  //   charMid 由 canvas 画「国」字量得、H 来自真实像素（本函数的入参 w/h），
  //   两者都不依赖「图里墨迹在哪」→ 调早了也算得准。
  //   （旧式 va = charMid/fs − H + inkMidEm 要求读图墨迹中线，两者数学等价，
  //     都是「让图中线落在文字中线上」，新式只是把对图片像素的依赖砍掉了。）
  //
  //   逐图算 va，不写死：3/2（20×43）与 15/2（29×43）比例不同、图高不同
  //   → va 必须不同（18px 下分别约 -0.685em 与 -0.351em），写死一个值必然有一类错位。
  //
  //   文字视觉中线**运行时用 canvas 实画一个「国」字量出来**，不写常数：
  //     实测「文字墨迹中线 / 字号」比值在 0.375~0.425 间浮动（±6%），
  //     写死常数必然在某段字号失准（实测 -0.80em 时 22px 起偏差涨到 +0.8~+1.5px）。
  //     用 canvas 实测则任何字号任何字体都准 —— 实测 16~40px 九个字号，偏差 ≤ 0.02px。
  //
  //   ⚠️ 别再退回「按底留白贴基线」（1.8.20 的做法）：那会把分数压到基线上，
  //      正是用户报的「分数比文字低一大截」。尺寸与对齐这两件事必须分开看。
  var TEX_BASE_PX = 18;      // 公式图 URL 里 fontSize 的固定值，等比缩放的基准 —— 同步点
  var TEX_REF_CHAR = '国';   // 度量参考字：全包围结构，墨迹范围最贴近汉字视觉中心 —— 同步点
  var TEX_CHAR_MID_REF = 0.39;  // canvas 量不到时的兜底「文字视觉中线÷字号」—— 同步点
  var texInkCache = Object.create(null);       // 图片墨迹缓存：同一张图不重复画 canvas
  var texCharMidCache = Object.create(null);   // 文字视觉中线缓存：按 字号+字体 缓存

  // 量出图片的「墨迹包围盒」——给出上下留白、墨迹高、以及**墨迹中线距图顶**。
  // 必须真读像素：粉笔导出的图没有统一的留白约定（实测 3~6px 不等），
  // 靠高度、宽高比、或者经验常数都推不出来。
  function measureTex(img){
    var key = img.src;
    if (key in texInkCache) return texInkCache[key];
    var res = null;
    try{
      var w = img.naturalWidth, h = img.naturalHeight;
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);   // 显式给目标宽高，按自然尺寸 1:1 采样
      var data = ctx.getImageData(0, 0, w, h).data;
      var top = -1, bottom = -1;
      for (var y = 0; y < h; y++){
        var has = false;
        for (var x = 0; x < w; x++){
          if (data[(y * w + x) * 4 + 3] > 24){ has = true; break; }
        }
        if (has){ if (top < 0) top = y; bottom = y; }
      }
      // 全透明图（坏图）不动它，免得算出荒唐的下沉量
      if (bottom >= 0){
        res = {
          padBottom: h - 1 - bottom,
          inkH: bottom - top + 1,
          inkMid: (top + bottom + 1) / 2   // 墨迹中线距**图顶**的距离（原始像素）
        };
      }
    }catch(e){
      // canvas 被跨域污染等情况：读不到就退回兜底值，不影响尺寸缩放
      res = null;
    }
    texInkCache[key] = res;
    return res;
  }

  // 量「文字视觉中线」在基线上方多少 px（当前字号、当前字体下）。
  // 做法：造一张 canvas，把一个「国」字按当前字号画上去，逐像素找出墨迹上下边界，
  //       再减去基线位置 —— 汉字墨迹上下不对称（实测「某」上 16px、下 1px），
  //       所以视觉中线在基线上方约 0.4 个字号高，而不是行盒中心。
  function measureCharMid(fontSize, fontFamily){
    var key = fontSize + '|' + fontFamily;
    if (key in texCharMidCache) return texCharMidCache[key];
    var res = null;
    try{
      var S = Math.ceil(fontSize * 4);          // 画布留足余量：4 倍字号
      var baseY = Math.ceil(fontSize * 2);      // 基线放在画布纵向中间偏下
      var cv = document.createElement('canvas');
      cv.width = S; cv.height = S;
      var ctx = cv.getContext('2d');
      ctx.font = fontSize + 'px ' + fontFamily;
      ctx.fillStyle = '#000';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(TEX_REF_CHAR, fontSize, baseY);
      var data = ctx.getImageData(0, 0, S, S).data;
      var top = -1, bottom = -1;
      for (var y = 0; y < S; y++){
        var has = false;
        for (var x = 0; x < S; x++){
          if (data[(y * S + x) * 4 + 3] > 24){ has = true; break; }
        }
        if (has){ if (top < 0) top = y; bottom = y; }
      }
      if (bottom >= 0){
        // 基线上方为正：墨迹顶距基线 (baseY-top)，墨迹底在基线下 (bottom-baseY)
        res = ((baseY - top) - (bottom - baseY)) / 2;
      }
    }catch(e){ res = null; }
    texCharMidCache[key] = res;
    return res;
  }

  // 按当前字号与字体，算出应写入的 vertical-align（em 字符串）。
  // 两档精度：
  //   ① 能读到墨迹 → va = charMid/fs − 图高(em) + 墨迹中线距图顶(em)     精确
  //   ② 读不到墨迹 → va = charMid/fs − 图高(em)/2                        近似
  // 之所以要有 ②：**墨迹中线并不在图的正中**。实测五张真机图，墨迹中线距图顶与
  // 「图高/2」的差：3/2、15/2 是 −0.5px，−2/3、30° 是 0，**△AOD 是 −1.5px**
  // —— 直接用图高中点会让 △AOD 低 1.5px。所以能读像素时一定走 ①。
  // 本函数由 scaleFigures 在图片解码后调用，正常都能走 ①。
  function texAlignEm(img, imgHEm, ink){
    var fs = parseFloat(getComputedStyle(img).fontSize);
    if (!(fs > 0)) return null;
    var fam = getComputedStyle(img).fontFamily || 'serif';
    var charMid = measureCharMid(fs, fam);
    if (charMid === null) return null;
    var k = 1 / TEX_BASE_PX;
    var inkMidEm = ink ? (ink.inkMid * k) : (imgHEm / 2);
    var v = (charMid / fs) - imgHEm + inkMidEm;
    if (!isFinite(v)) return null;
    return v.toFixed(4) + 'em';
  }

  // 把一张公式图按「内部字号 = 正文字号」等比摆正。幂等：同一张图反复调用结果完全一样。
  // w / h 传入图片的真实像素；拿不到真实像素时**不要调用**，交给样式表兜底 —— 宁可暂时偏一点，也不能猜错。
  function applyTexSize(img, w, h){
    if (!(w > 0 && h > 0)) return;
    var U = 'important';
    var k = 1 / TEX_BASE_PX;   // 每 1px 原始像素对应 k 个「字号单位」—— 同步点
    var hEm = h * k;           // 图高（em），算 va 要用
    img.style.setProperty('aspect-ratio', 'auto', U);
    img.style.setProperty('max-width', 'none', U);
    img.style.setProperty('max-height', 'none', U);
    img.style.setProperty('object-fit', 'contain', U);
    // 用 em 表达：em 就是当前字号，正文一变大图片自动跟着等比放大
    img.style.setProperty('width', (w * k).toFixed(4) + 'em', U);
    img.style.setProperty('height', hEm.toFixed(4) + 'em', U);
    // ---- 摆正：让图的中线落在文字视觉中线上（读得到墨迹就用墨迹，否则按图高中点）----
    var ink = measureTex(img);
    var v = texAlignEm(img, hEm, ink);
    if (v !== null){
      img.style.setProperty('vertical-align', v, U);
    } else {
      // canvas 不可用等极端情况：用实测参考值兜底。
      // 绝不用「按底留白贴基线」—— 那会把分数压到基线上（1.8.20 的老毛病）。
      img.style.setProperty('vertical-align', (TEX_CHAR_MID_REF - hEm / 2).toFixed(4) + 'em', U);
    }
    // 这个类只为兼容旧样式表而保留，尺寸不再依赖它
    img.classList.remove('fp-tex-frac');
  }

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
        // 行内公式图（flag="tex"）由 tagTexFracImg 用 em 锁死高度，这里绝不能再写 height:auto ——
        // scaleFigures 在 waitReady 里轮询执行（图片解码前会反复进来），一旦它把 auto 盖回去，
        // 公式图就退回粉笔原图像素（~43px 固定高、不随字号缩放），分数也随之错位。
        // 这正是 v1.8.13 真机仍「偏大 + 不跟字号 + 不对齐」的根因：识别对了，但尺寸被这里覆盖。
        // 另：图片「解码没完」时 naturalWidth 可能是中间值（见下面 flag="tex" 分支的详细说明），
        // 普通图同样不能拿它算比例 —— 统一用 complete 做闸门。
        var decoded = !!(img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
        var isTexInline = img.getAttribute('flag') === 'tex';
        if (!isTexInline && decoded && !img.getAttribute('data-fp-ar')){
          img.style.setProperty('aspect-ratio', img.naturalWidth + ' / ' + img.naturalHeight, 'important');
          img.style.setProperty('height', 'auto', 'important');
          img.setAttribute('data-fp-ar', img.naturalWidth + '/' + img.naturalHeight);
        }
        // 行内公式图尺寸已由 tagTexFracImg 全权接管，缩放逻辑一律不碰（否则宽度被改成 px 后不再随字号走）
        if (isTexInline){
          // 关键补救：公式图在「提取阶段」往往还没解码完 —— 粉笔的图是懒加载的，抓 DOM 时
          // naturalWidth/naturalHeight 常还是 0，拿不到真实像素就没法按等比缩放摆正。
          // 这里在图片真正解码后（本函数由 waitReady 轮询调用）用真实像素补算。
          //
          // ⚠️ v1.8.17 修正过的病灶，这里继续守住：**不能相信 naturalWidth/naturalHeight 的第一次读数**。
          //   据真机证据（54 题第 2 个分数）脚本曾把 -2/3 读成 37/43 —— 高度 43 是对的，宽度多出
          //   17px。原因是浏览器把「渐进解码」和「延迟解码（loading=lazy）」的图当成 complete=true，
          //   此时 naturalWidth 先返回一个**中间值**，解码完成后才回落到真实宽度。
          //   旧代码会把中间值**永久固化**：① 写进 data-fp-ar 属性，下次进来发现「属性 == 当前读数」
          //   就判定已处理、直接跳过；② 更隐蔽的是 style.aspectRatio —— aspect-ratio 一旦有值就
          //   **参与固有尺寸计算**，naturalWidth 会被反过来钳到由它推算出的宽度上，自己把自己锁死。
          //   修法：每轮都按**当前**读数重算重设（applyTexSize 幂等，重复调用无副作用），
          //   data-fp-tex-ar 只作信息记录，**不作为「已处理」的依据** —— 读数一旦被纠正，
          //   下一轮样式自动跟上，不会被历史的错误读数绑架。
          if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0){
            applyTexSize(img, img.naturalWidth, img.naturalHeight);
            img.setAttribute('data-fp-tex-ar', img.naturalWidth + '/' + img.naturalHeight);
          }
          continue;
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
      // 1.8.9：含 img 的纯容器（粉笔题干外的 <div _ngcontent> 常把「文字 p + 图片 p」裹在一起）
      // 也要往下钻，让文字段与图片段各自成独立原子 —— 否则图文焊成同一块，
      // 页尾放不下就整题（含能留下的文字）一起翻页（见现象：图文题跟图走）。
      // 仍排除 table/svg/canvas（这些硬块不能拆）；行内 img 的 <p> 自己不是 WRAP，会整段保留，不影响。
      if (kids.length && WRAP.test(node.tagName) && !node.querySelector('table,svg,canvas')){
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
        st.mat.setAttribute('data-fp-mid', 'm' + a.mid);
        body.appendChild(st.mat);
        st.mid = a.mid;
      }
      host = st.mat;
    } else if (a.qid){
      if (st.qid !== a.qid || !st.q || st.q.parentNode !== body){
        st.q = document.createElement('div');
        st.q.className = 'fp-q' + (a.fig ? ' fp-fig' : '');
        // 记下这壳属于哪道题：装完页后要靠它判断「这壳后面还有没有同一道题的续排」
        // （见 markSplitShells）。用 data 属性而不是另立账本，好处是 unplace
        // 摘掉节点后账本天然跟着变，不会留下幽灵记录。
        st.q.setAttribute('data-fp-qid', 'q' + a.qid);
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
  // 可沿行边界撕开的纯文本节点（不含表格/图片/公式等不能腰斩的元素）
  function canSplitNode(node){
    if (!node || !/^(P|DIV|SPAN|SECTION|ARTICLE|BLOCKQUOTE|CENTER|APP-FORMAT-HTML)$/i.test(node.tagName)) return false;
    // 极致省纸允许「纯文本长选项」从行边界撕开：只影响单独成行的选项（grid-1 那种），
    // 一行多选项（grid-2/4）因 cut 里按「行」成块、且撕开仅在单原子块触发，仍整行走，不会变 3+1。
    if (node.classList.contains('fp-opt') && MODE !== 'ultra') return false;
    return !node.querySelector('img,table,svg,canvas,iframe,object,embed,math');
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
    // ⚠️⚠️ 1.8.25 关键修正（问题4「丢字」的最后一环）⚠️⚠️
    //
    // 旧写法：var h = Math.floor(lines * lh);
    //   行高在真机上实测是 **25.6px**（字号 16 × 行距 1.6），不是整数。
    //   取 floor 之后：
    //     lines=1 → Math.floor(25.6) = 25px，而一行真实要 25.59px —— **少 0.59px**
    //     lines=2 → Math.floor(51.2) = 51px，而两行真实要 51.19px —— **少 0.19px**
    //   first 段随后被设成 max-height:h + overflow:hidden，
    //   于是「25px 的盒子硬塞 25.59px 的内容」——溢出的 0.59px 正是**最后一行字**，
    //   被 overflow:hidden 裁掉。用户看到的就是丢字：
    //     「就没有后面的显山露水」→「就没有后面的显山」（丢「露」）
    //   真机实测证据：28 题壳1 max-height:25px、自然高度 25.59px、scrollHeight 26px、溢出 1px。
    //
    //   ⚠️ 为什么前面几版都在别处白改：
    //     这个 0.59px 太小了，肉眼看「25 和 25.6 差不多」，容易当成舍入噪声。
    //     但它刚好等于「一行文字」的裁切边界 —— 少一点点就切掉一整行字的底部。
    //     真机 6 处撕开里只有 28 题丢字，正是因为只有它落在「1 行」这一档：
    //     2 行档少 0.19px、3 行档少 0.4px 都在安全区（行距空隙能吸收），
    //     唯独 1 行档的 0.59px 越过了字形下沿。
    //
    // 修法：不取整。CSS 的 max-height 完全支持小数，直接给精确的 lines*lh，
    //       让盒子高度和内容高度严格相等，溢出一律归零。
    //       同时留 0.1px 的向上余量：浏览器对行高做亚像素折算时可能多出
    //       零点零几像素，这点余量能吃掉它，而 0.1px 肉眼绝无影响。
    var lines = Math.max(1, Math.floor(remain / lh));
    var h = Math.round((lines * lh + 0.1) * 100) / 100;

    // ⚠️⚠️ 1.8.26 关键约束（问题4「题号消失」的直接原因）⚠️⚠️
    //
    // 首段（.fp-first）里有一个 **float:left 的题号** <span class="fp-num">28.</span>，
    // 它不属于正常流 —— 它自己就占掉一段垂直空间。真机实测（16px 字号的题号）：
    //     num.rect.top    = p.top           （题号从段落顶边开始）
    //     num.rect.bottom = p.top + 25.59   （题号高 = 一个完整行高）
    //     正文第一个字的 rect.top 与题号相同（首行并排）
    //     但一旦本行放不下，正文会**绕到题号下方**，整个下移一行。
    //
    // 于是 h 只有「1 行」（25.7px）时会出现两种坏结果：
    //   · 若正文能被挤到第 2 行 → 第 2 行被 overflow:hidden 裁掉（丢字）
    //   · 若切点退回 0 → 首段只剩题号，正文全归续段
    //     → 用户看到**题号孤零零没有正文**，视觉上就是「题号消失了」
    //
    // 真机证据（用户上传的 1.8.25 DOM + 截图）：
    //     q28 壳1 max-height:25.7px / 文本 39 字
    //     findLineCut 在同一环境给出的正确切点是 38 字（38 字 = 1.00 行，正好装下）
    //     39 字 = 2.00 行（最后一个 rect 底边 46.59px）→ 被裁
    //     截图上第 8 页只剩「任何事业的成功…就没有后面的显」，题号 28. 不见踪影
    //
    // 修法：首段至少要留「题号占的一行」+「至少一行正文」。
    // 题号是否独占首行，取决于本行剩余宽度 —— 这里用一个保守但安全的判据：
    //   首段文本里含 .fp-num 时，把可用高度下限提到 2 行。
    // 代价是页尾可能少撕一行（多留白一行），收益是**绝不丢字、绝不出现无题号孤岛**。
    // 这个交换对用户有利：留白能接受，丢字不能。
    var needLines = lines;
    try {
      if (lines < 2){
        // 看原子是不是「首段且带题号」：带 .fp-num 且是段落第一个元素
        var hasNum = false;
        if (node.nodeType === 1){
          var fn = node.firstElementChild;
          hasNum = !!(fn && fn.classList && fn.classList.contains('fp-num'));
          if (!hasNum) hasNum = !!node.querySelector('.fp-num');
        }
        if (hasNum) needLines = 2;
      }
    } catch (e){}
    if (needLines > lines){
      // 可用高度不够两行 → 这一段不值得撕（撕了首段也放不下题号+正文），
      // 直接让上层走「整段翻页」，别在这里制造一个残缺的首段。
      if (remain < needLines * lh) return null;
      lines = needLines;
      h = Math.round((lines * lh + 0.1) * 100) / 100;
    }

    // 拆得太少或几乎整段都能放下，就不拆了
    // 极致省纸把下限压到约 1 行（14px），让页尾剩 1~2 行空位时也能把长段撕开填缝；
    // 智能平衡保持 24px（约 1.4 行）下限，避免过度碎裂。
    var MINH = (MODE === 'ultra') ? 14 : 24;
    if (h < MINH || h >= atom.h - 16) return null;

    // ============================================================================
    // ⚠️⚠️⚠️ 1.8.26 终极修正（问题4「丢字 / 题号消失」，第 5 次也是最后一次）⚠️⚠️⚠️
    // ============================================================================
    //
    // ★ 血泪史：这个 bug 修了四次都没修对，全因为**在猜宽度**。这次一个字都不猜。
    //
    // ---- 前四次的错误路径（写在这里，防止再走一遍）----
    //   v1 用 #fp-flow.clientWidth（703）＝ 忘了减 .fp-stem 的 padding        → 宽度偏大
    //   v2 补上 padding-left，但从「任意一个 .fp-stem」上读                → 逐题不同，可能偏
    //   v3 改从「本节点的祖先 .fp-stem」上读                              → 看着对，实测仍错
    //   v4 加「装得下」断言兜底                                          → 断言条件写错，没跑
    //
    // ---- 真机实测数据（用用户上传的 1.8.25 完整 DOM + 脚本自己的 CSS）----
    //   真实 .fp-stem 的内容宽有**三种**（按题号宽度分档）：
    //     {637px: 22 处, 645px: 98 处, 653px: 9 处}
    //   而 #fp-flow.clientWidth = 680、.fp-page.clientWidth = 794、.fp-pbody = 673。
    //   → **三个候选宽度都不是真值**，任何「挑一个」的做法都必然有偏差。
    //
    //   同一个「39 字」的文本在不同宽度下的行数（真机实测）：
    //     width=794 不补 padL → 1 行  ← 1.8.25 真机就是这个结果
    //     width=794 + padL=28 → 2 行
    //     width=673 + padL=28 → 2 行
    //
    //   真机 q28 的实测几何（16px / 行高 25.6px）：
    //     first 段（39 字）最后一个字形底边 = 46.59px，而 max-height 只有 25.7px
    //     → overflow:hidden 把第二行整行裁掉 → 「显山露水」变成「显」之后断掉
    //     而 findLineCut 在同一环境给出的正确切点是 38 字（38 字 = 25.59px，正好 1 行）
    //
    // ---- 正确做法：**把节点放进真实页面结构里量**，让浏览器自己算宽度 ----
    //
    //   关键洞察：cut() 里 unplace() 用的是 removeChild，**节点的 parentNode
    //   仍指向原来那个 .fp-stem** —— 而那个壳虽然在文档外，却带着完整的
    //   inline --hang、以及从祖先继承下来的所有样式。把它整条祖先链克隆一份挂进
    //   真实的 .fp-page 结构里，宽度就**自动**等于真实值，不需要任何人为计算。
    //
    //   所以这里做的不是「猜宽度」，而是「**把节点的真实排版环境整体搬过来**」。
    // ============================================================================
    var detached = !node.ownerDocument || !node.ownerDocument.body.contains(node);
    var measHost = null, measStem = null, measBody = null;

    // ① 找节点原来的 .fp-stem 祖先（unplace 后 parentNode 仍指着它）
    var protoStem = null;
    try {
      var own = node.parentNode;
      while (own && own.nodeType === 1 && !(own.classList && own.classList.contains('fp-stem'))){
        own = own.parentNode;
      }
      if (own && own.classList && own.classList.contains('fp-stem')) protoStem = own;
    } catch (e){}
    // 退化：从页面上任意一个真实壳取模板。
    // ⚠️ 这里**只用来取「结构模板」**（.fp-stem 的 padding 等样式口径），
    //    缩进本身由 atom.hang 单独写回，所以即使命中别的题也不会影响宽度 ——
    //    1.8.26 起不再为此告警（1.8.25 那条「缩进可能不符」的警告是误报，已删）。
    if (!protoStem){
      try {
        protoStem = document.querySelector('#fp-pages .fp-stem') || document.querySelector('.fp-stem');
      } catch (e){}
    }

    if (detached || !measHost){
      try {
        // ② 把「真实页面容器」克隆一份当测量位：.fp-page > .fp-pbody
        //    宽度天然等于真实内容区宽，不需要任何数字
        var realPage = document.querySelector('#fp-pages .fp-page') || document.querySelector('.fp-page');
        if (realPage){
          var pageShell = realPage.cloneNode(false);   // .fp-page（带它的 width/padding）
          var pbodyShell = document.createElement('div');
          pbodyShell.className = 'fp-pbody';
          pageShell.appendChild(pbodyShell);
          measHost = pageShell;
          measBody = pbodyShell;
        } else {
          // 连页面壳都没有（极端兜底）：用 flow 宽度
          var flowEl = document.getElementById('fp-flow');
          var flowW = flowEl && flowEl.clientWidth ? flowEl.clientWidth : 703;
          measHost = document.createElement('div');
          measHost.style.cssText = 'width:' + flowW + 'px';
          measBody = measHost;
        }
        // ③ 在测量位里重建「.fp-q > .fp-stem」两层壳：
        //    --hang 从原壳/原子取，其余样式由 CSS 继承 → 宽度与真实一致
        var qShell = document.createElement('div');
        qShell.className = 'fp-q';
        var hangVal = atom.hang || '';
        if (!hangVal && protoStem){
          try { hangVal = protoStem.parentNode.style.getPropertyValue('--hang') || ''; } catch (e){}
        }
        if (hangVal) qShell.style.setProperty('--hang', hangVal);
        if (atom.ohang) qShell.style.setProperty('--ohang', atom.ohang);
        else if (hangVal) qShell.style.setProperty('--ohang', hangVal);
        var stemShell = document.createElement('div');
        stemShell.className = 'fp-stem';
        qShell.appendChild(stemShell);
        measBody.appendChild(qShell);
        measStem = stemShell;
        // 测量位整体移出视口、隐藏，但不改宽度（改了宽度就白测了）
        measHost.style.position = 'absolute';
        measHost.style.left = '-99999px';
        measHost.style.top = '0';
        measHost.style.visibility = 'hidden';
        document.body.appendChild(measHost);
      } catch (e){
        measHost = null; measStem = null;
      }
    }

    // ④ 万一测量位没建成，且节点游离 —— 至少挂回文档，否则 rect 恒为 0
    if (!measHost && detached){
      measHost = document.createElement('div');
      measHost.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden';
      measHost.appendChild(node);
      document.body.appendChild(measHost);
      measStem = measHost;
    }
    // ⑤ 把节点放进测量壳（不是直接放进 measHost —— 那样会丢掉 .fp-stem 的缩进）
    if (measStem && node.parentNode !== measStem) measStem.appendChild(node);

    var cutRes = findLineCut(node, h);
    var parts = null;
    if (cutRes){
      var first = node.cloneNode(false);
      var rest = node.cloneNode(false);
      var r1 = document.createRange();
      r1.setStart(node, 0); r1.setEnd(cutRes.node, cutRes.offset);
      first.appendChild(r1.cloneContents());
      var r2 = document.createRange();
      r2.setStart(cutRes.node, cutRes.offset); r2.setEnd(node, node.childNodes.length);
      rest.appendChild(r2.cloneContents());
      // ⚠️ 1.8.25 产品决定：**续排段不再重复题号**。
      //
      // 1.8.9 起，题干被撕开时会把题号 <span class="fp-num"> 克隆一份插到续排段开头，
      // 目的是让下一页的题干也带「28.」。但真机用下来代价比收益大：
      //   · 同一道题在两页各印一次题号，翻页时看着像「两道题」；
      //   · 1.8.24 为了让克隆题号跟住段首，还专门加了 insertBefore 逻辑，
      //     反而引出「题号跑到第二页、没跟在段首前面」这一组新问题。
      // 用户拍板：续排段就当成正文的自然延续，不印题号 ——
      // 页面右上/页首本来就有页码和题目区间提示，定位不会丢。
      // 所以这里**整段删掉**题号克隆，rest 保持 cloneContents 的原始内容。
      //
      // 注意：first 段里的题号仍然保留（原样 cloneContents 带过来的），
      // 也就是「题号只在本道题首次出现的那一页出现一次」，这正是想要的效果。
      //
      // ---- 字符守恒断言（1.8.24 新增）----
      // 切点若落在内联元素边界处，Range.cloneContents 理论上是守恒的
      // （已用 79 组边界场景实测验证），但**不能只靠理论** ——
      // 旧代码只校验「两段都非空」（fl && rl），一旦真丢了内容是**静默**的，
      // 用户只会看到「显山露 ↓ 水」这种断字，无从排查。
      // 这里改成逐字符守恒校验：首段正文 + 续段正文，必须与原文正文逐字相同；
      // 不成立就 return null —— 宁可不撕（整段翻页留点白），也绝不丢字。
      var flat = function(el){ return el.textContent.replace(/[\s　]/g, ''); };
      // ⚠️ 空壳清理：切点有可能落在题号 <span class="fp-num"> 内部（h 很小的时候），
      // 此时 cloneContents 会在 rest 里留下一个**空**的 .fp-num 外壳 ——
      // 它没有文字，肉眼看不见，但会在续段行首占住一个右外边距（margin-right:.5em），
      // 表现成「续排段第一行莫名缩进一点」。既然决定续段不印题号，这种空壳一并摘掉。
      // 同理清掉任何空的 .fp-num（首段里也可能残留）。
      (function(){
        var shells = rest.querySelectorAll('.fp-num');
        for (var si = 0; si < shells.length; si++){
          if (!shells[si].textContent.replace(/[\s　]/g, '')) shells[si].parentNode.removeChild(shells[si]);
        }
      })();
      // 不再有题号克隆，first 与 rest 首尾相接就等于整段原文，
      // 所以直接三段互等即可（1.8.25 简化：删掉了 numTxt / cutHead 那套去头逻辑）。
      // ⚠️ 注意：上面清掉的空 .fp-num 不含任何字符，不影响 textContent 守恒。
      var origTxt = flat(node);                  // 原文
      var firstTxt = flat(first);                // 首段（含题号）
      var restTxt = flat(rest);                  // 续段（纯正文）
      var ok = (firstTxt + restTxt) === origTxt;
      parts = (ok && firstTxt && restTxt) ? { first: first, rest: rest, h: h } : null;
      if (!ok){
        // 守恒失败：退回整段（不撕），并在控制台留痕便于真机排查
        try {
          console.warn('[试卷排版] 撕开校验未通过，已退回整段。'
            + '首段=' + firstTxt.length + '字 续段=' + restTxt.length
            + '字 原文=' + origTxt.length + '字');
        } catch (e){}
      }

      // ---- 「装得下」断言（1.8.25 新增；1.8.26 改成**无条件执行 + 几何判定 + 自愈**）----
      //
      // 逐字符守恒只保证「字都在 DOM 里」，**保证不了字看得见**。
      // first 段会被设成 max-height:h + overflow:hidden，只要内容比 h 高出**一整行**，
      // 最后一行就会被裁掉 —— 字还在 DOM、守恒校验也通过，但用户看不见，
      // 外观上就是丢字。
      //
      // ⚠️ 真机实测（1.8.25 输出，用户上传的完整 DOM）：
      //     q28 壳1: max-height:25.7px, 文本 39 字
      //              「28.任何事业的成功…就没有后面的显山」
      //     而 findLineCut 在同一环境给出的正确切点是 **38 字**
      //              「28.任何事业的成功…就没有后面的显」
      //     38 字 → rectH=25.59px（1 行，装得下 ✅）
      //     39 字 → 最后一行 rect 的底边 = 46.59px（2 行，装不下 ❌）
      //     差的就是最后的「山」—— 用户在截图上看到「显」之后断掉、题号看着像丢了。
      //
      // ⚠️ 两个必须做对的地方：
      //
      //   ① **不能用 scrollHeight 判**。
      //      first 段里有 float:left 的题号，.fp-stem 又是 display:flow-root
      //      （建立 BFC 包住浮动），scrollHeight 会把浮动盒子算进溢出区，
      //      给出偏大的值，把「其实装得下」的情况误判成装不下。
      //      这里改用 **Range.getClientRects() 的最后一个矩形底边** —— 和
      //      findLineCut 量高度用的是同一套几何，口径天然一致，
      //      也正好是 max-height/overflow 实际裁切的那条线。
      //
      //   ② **断言不能有条件**。
      //      1.8.25 写成 if (parts && measHost)，而 measHost 只在节点游离时才建，
      //      于是只要节点还在文档里，整块断言被静默跳过 —— 这正是它没拦住 bug 的原因。
      //      现在无条件执行，自己保证测量位存在。
      //
      // ⚠️ 容差 1px：h 已是精确的 lines*lh + 0.1，残差只来自亚像素折算（<0.5px）。
      //    1px 放得下这点噪声，又不给「少一整行字」留口子。
      var OVER_TOL = 1;
      var firstRowInfo = null;   // 首段「行数 / 末行字符数」，摘探针前量好，供下面判断是否 justify
      if (parts){
        var probe = parts.first;
        // ⚠️ 关键：断言必须用**和最终放置环境完全一致**的容器（measStem = .fp-stem 壳），
        //    不能用 measHost（它是 .fp-page，宽度比 .fp-stem 内容区大出 --hang 那一截）。
        //    这一条是 1.8.26 实测踩出来的：用 .fp-page 量会把「装不下」误判成「装得下」。
        var probeHome = measStem || measBody || measHost;
        try {
          if (!probeHome){
            // 没有测量壳：现场造一个「.fp-q > .fp-stem」两级结构，缩进与真实一致
            var pg2 = document.querySelector('#fp-pages .fp-page') || document.querySelector('.fp-page');
            var q3 = document.createElement('div');
            q3.className = 'fp-q';
            if (atom.hang){ q3.style.setProperty('--hang', atom.hang); }
            if (atom.ohang){ q3.style.setProperty('--ohang', atom.ohang); }
            var s3 = document.createElement('div');
            s3.className = 'fp-stem';
            q3.appendChild(s3);
            probeHome = document.createElement('div');
            probeHome.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden';
            if (pg2){
              probeHome.style.width = pg2.clientWidth + 'px';
              probeHome.style.boxSizing = 'border-box';
              probeHome.style.paddingLeft = window.getComputedStyle(pg2).paddingLeft;
              probeHome.style.paddingRight = window.getComputedStyle(pg2).paddingRight;
            }
            probeHome.appendChild(q3);
            measStem = s3;
            measHost = probeHome;
            document.body.appendChild(probeHome);
          }
          // 量「第一个段落在真实环境里排出来，最后一个字形的底边」离自身顶边多远。
          // 用 range.getClientRects() —— 与 findLineCut 同源，不受 BFC/浮动影响。
          var measureFirst = function(el){
            if (!el.firstChild) return 0;
            var rng = document.createRange();
            try { rng.setStart(el, 0); rng.setEnd(el, el.childNodes.length); }
            catch (e){ return 0; }
            var rcs = rng.getClientRects();
            if (!rcs || !rcs.length) return 0;
            var top = el.getBoundingClientRect().top, mx = -Infinity;
            for (var qi = 0; qi < rcs.length; qi++){
              // 忽略零宽矩形（float 塌陷、空行盒会给出 0 宽）
              if (rcs[qi].width <= 0) continue;
              var b = rcs[qi].bottom - top;
              if (b > mx) mx = b;
            }
            return mx === -Infinity ? 0 : mx;
          };
          probe.style.maxHeight = 'none';
          probe.style.overflow = 'visible';
          probeHome.appendChild(probe);
          var realH = measureFirst(probe);
          // ---- 自愈：装不下就把切点往前挪，直到装得下 ----
          //
          // 与其「装不下就整段翻页（页尾留白）」，不如把切点往前挪几个字 ——
          // 宁可这一页少放几个字，也绝不让字被裁掉（用户看到的就是丢字）。
          //
          // ⚠️ 不能简单地把 textContent 截断：first 段里有 <u><span class="fp-ul"></span></u>
          //    这样的填空线内联结构，textContent 一赋值就全拍平了，填空题的下划线会消失。
          //    这里改成**在 probe 上从尾部逐字符删**（Range.deleteContents 保留前面的结构），
          //    并且把删掉的字符按原样 append 到 rest 的末尾 —— 结构与守恒都保住。
          //
          //    实现要点：每删一个字前，先记录「被删区间之前」的字符数，
          //    删完后用同一个区间数把 rest 补上（rest 是 cloneContents 来的，结构与 first 同源）。
          if (realH - h > OVER_TOL){
            var trimmed = 0, maxTrim = Math.ceil(lh * 1.2);   // 最多回退约一行
            var delRange = null;
            while (trimmed < maxTrim && realH - h > OVER_TOL && flat(probe).length > 2){
              // 找 probe 里最后一个文本节点，删掉它的最后一个字符
              var lastNode = null, wk = document.createTreeWalker(probe, 4, null, false), wn;
              while ((wn = wk.nextNode())) if (wn.textContent.length) lastNode = wn;
              if (!lastNode) break;
              var L = lastNode.textContent.length;
              if (L <= 0) break;
              // 记录被删的那个字符（用于补回 rest）
              var ch = lastNode.textContent.charAt(L - 1);
              var dr = document.createRange();
              dr.setStart(lastNode, L - 1); dr.setEnd(lastNode, L);
              var piece = dr.cloneContents();     // 被删字符（含可能的包裹元素）
              dr.deleteContents();
              trimmed++;
              // 记下这一片，最后统一拼到 rest 前面（保持原顺序：先删的在最前）
              if (!delRange) delRange = document.createDocumentFragment();
              delRange.insertBefore(piece, delRange.firstChild);
              realH = measureFirst(probe);
            }
            if (realH - h <= OVER_TOL + 0.5 && flat(probe).length > 1){
              // 缩字成功：把删掉的那些字接到 rest 最前面，保证一个字都不丢
              var restNew = rest.cloneNode(false);
              if (delRange) restNew.appendChild(delRange);
              while (rest.firstChild) restNew.appendChild(rest.firstChild);
              // 守恒复核：first(缩字后) + rest(补回头部) 必须逐字等于原文
              if ((flat(probe) + flat(restNew)) === origTxt){
                parts = { first: probe, rest: restNew, h: h };
                try {
                  console.warn('[试卷排版] 撕开段装不下，已自动回退 ' + trimmed
                    + ' 字（可用=' + h + 'px 原需=' + realH.toFixed(1) + 'px）');
                } catch (e){}
              } else {
                parts = null;
              }
            } else {
              // 缩字也救不了（比如第一行就超）：整段翻页，宁留白不丢字
              try {
                console.warn('[试卷排版] 撕开段装不下且缩字无效，已退回整段。'
                  + '可用=' + h + 'px 实际=' + realH.toFixed(1) + 'px（容差 ' + OVER_TOL + 'px）');
              } catch (e){}
              parts = null;
            }
          }
        } catch (e){}
        // ⚠️⚠️ 1.8.26：测量「首段末行有几个字」，必须在**摘探针之前**做 ⚠️⚠️
        //
        // 为什么不能放到后面（下面设 maxHeight/overflow 的地方）去测：
        //   本行之后紧跟着 probe.parentNode.removeChild(probe) 会把首段**摘出文档**，
        //   而游离节点（或被 visibility:hidden 藏起来的节点）用 Range 量出的
        //   getClientRects() 全是空 —— 于是「末行字数」恒为 0、保险条件永不满足、
        //   整个修复**静默失效**。1.8.26 初版就是把测量写在后面，实测
        //   「主脚本写上了 justify = 0 / 84 个场景」，全靠打桩才发现。
        //
        // 此时 probe 还在 measStem（.fp-stem 壳）里、参与真实排版，量的就是真值。
        // maxHeight 还没设——但「切出来的这段内容排成几行」与限不限高无关，提前量不影响结果。
        //
        // 用法见下方：只有「首段 ≥ 2 行」且「末行字符数 ≥ 8」才给首段加
        // text-align-last:justify，把末行也撑满，消掉换页处那个视觉空隙。
        try {
          var wkC = document.createTreeWalker(probe, 4, null, false), tnC;
          var rowTop = -Infinity, cells = [];
          while ((tnC = wkC.nextNode())){
            var TC = tnC.textContent;
            for (var ci = 0; ci < TC.length; ci++){
              var rgC = document.createRange();
              try { rgC.setStart(tnC, ci); rgC.setEnd(tnC, ci + 1); } catch (e){ continue; }
              var rcC = rgC.getClientRects();
              if (!rcC || !rcC.length || rcC[0].width <= 0) continue;
              if (rcC[0].top > rowTop) rowTop = rcC[0].top;
              cells.push(rcC[0].top);
            }
          }
          if (rowTop !== -Infinity && cells.length){
            var probeH = probe.getBoundingClientRect().height;
            var nRowsP = Math.max(1, Math.round(probeH / lh));
            var lastChars = 0;
            for (var cj = 0; cj < cells.length; cj++){
              if (cells[cj] >= rowTop - lh * 0.5) lastChars++;
            }
            firstRowInfo = { nRows: nRowsP, lastChars: lastChars };
          }
        } catch (e){ firstRowInfo = null; }
        // 量完把探针摘掉（parts.first 可能是 probe 本体，也可能已被换掉，两者都清）
        if (probe && probe.parentNode) probe.parentNode.removeChild(probe);
      }
    }
    if (parts){
      parts.first.style.maxHeight = h + 'px';
      // ⚠️⚠️ 1.8.26 修复：题号消失（43 题）⚠️⚠️
      //
      // 症状：某道题被撕开、首段落在页尾时，首段里的题号 <span class="fp-num">43.</span>
      //       在 DOM 里明明存在（textContent 守恒校验也通过），但屏幕/打印上都看不见。
      //
      // 根因（chromium 实测定位）：
      //   .fp-stem  有 padding-left:var(--hang)  → 正文从内容盒 +28px 处开始
      //   .fp-num   有 float:left; margin-left:-1.75em  → 题号被**拉回 padding 区**，
      //             它的 left 落在段落**内容盒左边界之外** 28px 处
      //   这是悬挂缩进的设计意图（题号突出在外，正文各行对齐）。
      //   但首段为了裁掉多余的行被设了 overflow:hidden —— 而 overflow:hidden 是
      //   **无差别**裁切：它把超出内容盒的一切都切掉，包括**故意放在 padding 区的题号**。
      //   实测：P.fp-first 内容盒 left=187.84，题号 left=159.84，相差正好 28px(=hang)，
      //         elementFromPoint 命中父级 .fp-stem 而非题号 → 题号被裁。
      //
      // 为什么 1 行时不发作：lines<2 时有 needLines=2 的保护会直接 return null
      //   （整段翻页，不撕），压根不产生这种裁切首段。
      //   2 行是「保护盲区」——躲过了 lines<2，又足以让 overflow:hidden 生效。
      //
      // 修法：改用 clip-path 显式指定裁切矩形，**左右各外扩一个 hang 宽度**，
      //   让题号露出来，上下边界维持 max-height 的裁切能力。
      //   实测对比（chromium）：
      //     overflow:hidden              题号不可见 ✗  多余行裁掉 ✓
      //     overflow:visible             题号可见   ✓  多余行裁不掉 ✗（丢字，绝对不行）
      //     clip-path:inset(0 -28px ...) 题号可见   ✓  多余行裁掉 ✓  ← 采用
      //   1.25em~2.5em 各档 hang 实测均成立。
      //
      // 为什么不动 padding：.fp-stem 的 padding 参与高度计算，改了会让分页器量到的
      //   页高和实际布局对不上（见 .fp-stem 处的注释），只能从裁切方式上解。
      // ⚠️ --hang 定义在 .fp-q 上，**不是** .fp-stem 上：
      //      <div class="fp-q" style="--hang:1.750em"> > <div class="fp-stem"> > <p class="fp-first">
      //    实测（chromium）：node.parentNode(.fp-stem).style.getPropertyValue('--hang') === ''
      //                     node.parentNode.parentNode(.fp-q) === '1.750em'
      //    走 .fp-stem 会永远取到空串、静默退到兜底值 28px。
      //    28px 恰好等于默认档 1.75em×16，所以默认档看不出问题 —— 但换档就错。
      //    这里改成**逐级向上找**，并且优先用计算值（继承值也能拿到，最稳）。
      var hangPx = 0;
      try {
        var readHang = function(el){
          // computed 值能把「继承自上层的自定义属性」也解析出来，比 inline style 可靠
          try {
            var cv = window.getComputedStyle(el).getPropertyValue('--hang');
            if (cv && cv.trim()) return cv.trim();
          } catch (e){}
          try {
            var iv = el.style && el.style.getPropertyValue('--hang');
            if (iv && iv.trim()) return iv.trim();
          } catch (e){}
          return '';
        };
        var hv = '';
        for (var up = node, hop = 0; up && up.nodeType === 1 && hop < 6 && !hv; up = up.parentNode, hop++){
          hv = readHang(up);
        }
        if (!hv && atom && atom.hang) hv = String(atom.hang);
        if (/^[\d.]+em$/.test(hv)) hangPx = parseFloat(hv) * 16;
        else if (/^[\d.]+px$/.test(hv)) hangPx = parseFloat(hv);
        else if (/^[\d.]+$/.test(hv)) hangPx = parseFloat(hv);
      } catch (e){}
      if (!(hangPx > 0)) hangPx = 28;           // 兜底：默认 HANG=1.75em × 16px
      var pad = Math.ceil(hangPx) + 4;          // 多给 4px 余量，防亚像素误差
      parts.first.style.overflow = 'visible';
      parts.first.style.clipPath = 'inset(0 -' + pad + 'px 0 -' + pad + 'px)';
      try { parts.first.style.webkitClipPath = 'inset(0 -' + pad + 'px 0 -' + pad + 'px)'; } catch (e){}
      parts.first.style.marginBottom = '0';
      parts.first.style.breakInside = 'auto';
      parts.first.style.pageBreakInside = 'auto';
      parts.rest.style.marginTop = '0';
      parts.rest.style.breakInside = 'auto';
      parts.rest.style.pageBreakInside = 'auto';

      // ⚠️⚠️ 1.8.26 修复：换页处多出一个空格（用户报「志愿填报服务」后面多一个空格）⚠️⚠️
      //
      // 症状：43 题被撕开，第 12 页末是「…不啻为一场志愿填报服务」，
      //       第 13 页首是「的“供给侧改革”」，两页拼起来看着像「服务 的」——
      //       中间凭空多出一个空格。而 DOM 里逐字符守恒（两段拼回去严格等于原文），
      //       根本没有空格字符 —— 这个空格是**渲染出来的**。
      //
      // 根因（chromium 实测，切点精确复刻到用户真机的「服务|的」）：
      //   .fp-stem p 上有 text-align:justify + text-align-last:left（见 CSS）。
      //   · 不撕开时：「…不啻为一场志愿填报服务」是段落的**中间行**，
      //     justify 把这一行 40 个字拉伸填满整行 652.31px（每字约 +0.31px 字距），
      //     实测行尾余量 = 0px。
      //   · 撕开后：同一行成了首段的**最后一行**，text-align-last:left 生效，
      //     这一行**不再拉伸**，40 个字回到自然宽 16.02px/字 = 640.8px，
      //     行尾余量 = 737 − 724.70 = **12.30px**（而字宽 16.02px，排不下第 41 字）。
      //   这 12.3px 的空档，视觉上就是「服务」后面那个空格。
      //
      // 实测数据（真机 q43 原文，remains = 2 行余量，切点落在「服务|的」）：
      //             段落高      末行余量   末行字数   末行平均字宽
      //   现状      51.19px     12.30px       40        16.02px
      //   加 justify 51.19px      0px         40        16.32px   ← 采用
      //   → 段落高不变（行数不变，分页边界不受影响）、字宽只被拉伸 0.3px（肉眼不可辨）。
      //
      // ⚠️ 必然性（不是偶然）：这是「撕开段落」这个动作**固有**的后果，
      //   凡被撕开的段落，其页尾那一段的末行都会从「撑满」变成「左对齐留空」。
      //   1.8.26 之前没被发现，是因为它只在「撕开处恰好紧跟下一段首字」时才显眼。
      //
      // 修法：给首段设 text-align-last:justify，让它的末行也撑满，
      //   视觉上与「不撕开」时的那一行完全一致，12.3px 空档归零。
      //
      // ⚠️ 为什么**只给 first、不给 rest**：
      //   rest 的末行是这道题**真正的段落末行**，本来就该按 text-align-last:left
      //   保持自然宽度（和全卷所有段落的末行一致）。给 rest 也加 justify 会
      //   把所有续段的末行都拉满，反而制造出新的不一致。
      //
      // ⚠️ 短末行的保险（防止极端情况下字被拉变形）：
      //   text-align-last:justify 会把末行拉到满宽。末行字数越少，每个字摊到的
      //   额外字距越大。实测 310 个构造场景（逐 1px 推 remain 扫过每一行边界），
      //   末行字数最少也有 39 字、最大拉伸仅 0.72px —— 因为 findLineCut 的二分会
      //   取「装得下的最大 g」，加上标点后移校正（PUNCT 循环），切点天然落在行尾
      //   靠后处，短末行根本不出现。
      //   但这是**经验规律**不是**保证**，所以这里再加一道硬保险：
      //   量出首段末行**实际有几个字**，只有足够多（≥8）才启用。
      //   拿不到行信息就保守**不启用** —— 宁可留那 12.3px，也绝不把字拉变形。
      //
      //   ⚠️ 统计口径必须**逐字符**，不能用 getClientRects() 的矩形个数：
      //   ⚠️ 别用 getClientRects() 的矩形个数当「字数」：
      //     Range 返回的是**文本节点级别**的矩形，首段里的文本往往是「题号一个节点
      //     + 正文一个节点」两三个片段，一条 40 字的行只会给出 1~2 个矩形。
      //     1.8.26 初版就是踩了这个坑（写成 lastRun>=8），永远不满足、修复静默失效。
      //
      //   ⚠️ 更关键：这个测量必须在**摘探针之前**做（见上面 firstRowInfo 的赋值处）。
      //     放到这里（片段已游离出文档）再量，getClientRects() 全是空，
      //     同样恒为 0、同样静默失效。所以这里只**读** firstRowInfo，不重复测量。
      if (firstRowInfo && firstRowInfo.nRows >= 2 && firstRowInfo.lastChars >= 8){
        parts.first.style.textAlignLast = 'justify';
        try { parts.first.style.webkitTextAlignLast = 'justify'; } catch (e){}
      }
    }
    if (measHost) measHost.parentNode.removeChild(measHost);
    return parts;
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
    var lh = parseFloat(cs.lineHeight) || ((parseFloat(cs.fontSize) || 16) * 1.6);

    // 高度基准：**第一个字形框的 top**，不是 <p> 的 border-box top。
    //
    // 为什么不能用 <p> 的 top（1.8.25 修正）：
    //   题干第一个元素是题号 <span class="fp-num">28.</span>，字号/行高与正文不同，
    //   实测它的字形框 top 比正文首行低 3px（25.6px 行高时）。
    //   拿 <p> 的 top 当基准，等于给每一行都白加 3px，
    //   二分出来的切点会提前整整一行 —— 页尾又留下该填没填的空白。
    //   改用第一个字形框的 top 作基准：同源于 getClientRects，天然自洽，
    //   题号、行内公式图、行内 <u> 的基线差异都不会污染这个基准。
    //   （保留 <p> top 作为兜底：极端情况下 Range 一个矩形都拿不到时用得上。）
    var base = node.getBoundingClientRect().top + (parseFloat(cs.paddingTop) || 0)
      + (parseFloat(cs.borderTopWidth) || 0);
    try {
      var _r0 = document.createRange();
      _r0.setStart(node, 0);
      _r0.setEnd(tns[0], Math.min(1, tns[0].textContent.length));
      var _c0 = _r0.getClientRects();
      if (_c0 && _c0.length) base = _c0[0].top;
    } catch (e){}

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
    // 量「前 g 个字符」占的真实高度。
    //
    // ⚠️⚠️ 1.8.25 关键修正（问题4「丢字」的真正根因，读者务必看完）⚠️⚠️
    //
    // 旧写法：return rects[last].bottom - base;
    //   用 Range.getClientRects() 返回的**字形墨迹框**的下沿当高度。
    //   但墨迹框不等于行框 —— 汉字字形只占行高的一部分，上下还留有空隙。
    //   实测（正文 16px / 行高 25.6px，真机 28 题）：
    //     行框底边 = 26.6px，而字形墨迹底边只有 24.0px —— 系统性少算 2.6px。
    //
    //   这 2.6px 的误差直接吃掉了整个字：
    //     · findLineCut 用「少算 2.6px」的口径二分找切点 → 切点偏后；
    //     · 偏后的切点内容真实需要 26.6px，却被判定「24px ≤ h」放行；
    //     · splitTextAtom 给 first 段设 max-height:h + overflow:hidden；
    //     · 于是 26.6px 的内容被塞进 25px 的盒子 —— **溢出的那一行被裁掉**。
    //   用户看到的就是「就没有后面的显山露水」变成「就没有后面的显山」，
    //   丢的正是最后那一个字（真机 max-height:25px / 行高 25.6px，实测溢出 1px）。
    //
    //   为什么上一版「测量层补 padding」没能解决：那是**宽度**口径不一致，
    //   影响的是「一行能排几个字」；而这里是**高度**口径不一致，影响的是
    //   「这几行到底多高」。两个 bug 独立，都得修。宽度那个已修（见 splitTextAtom）。
    //
    // 新写法：用「最后一个字形框的 top」加上**一个完整行高**。
    //   字形框的 top 已经把行框的上半空隙算进去了，再加 lh 就回到行框底边，
    //   这才是 max-height / overflow 实际裁切的边界。
    //
    // ⚠️ 基准 base 不能用 <p> 的 border-box top：
    //   题干第一个元素是题号 <span class="fp-num">28.</span>，它有自己的字号/行高，
    //   实测它的字形框 top 比正文首行**低 3px**（真机 25.6px 行高时的实测值）。
    //   若拿 <p> 的 top 当基准，每行都会白多算约 3px，切点被迫提前一整行 ——
    //   表现就是「撕得太保守、页尾又留下大片空白」（1.8.25 中间版本实测到过）。
    //   这里改成用**第一个字形框的 top** 当基准：同源于 rects，天然自洽，
    //   不受题号/行内元素基线的干扰。
    function heightAt(g){
      if (g <= 0) return 0;
      var p = at(g);
      var r = document.createRange();
      try { r.setStart(node, 0); r.setEnd(p.node, p.offset); }
      catch (e){ return 0; }
      var rects = r.getClientRects();
      if (!rects || !rects.length) return 0;
      return rects[rects.length - 1].top - base + lh;
    }

    var lo = 1, hi = total - 1, best = 0;
    while (lo <= hi){
      var mid = (lo + hi) >> 1;
      if (heightAt(mid) <= h){ best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (best <= 0 || best >= total) return null;

    // 切点校正：避免把标点符号单独留在下一行开头（如句号自己成行）。
    // 如果切点正好落在一个前置性标点（逗号、句号、分号等）前面，就往后挪，
    // 让标点留在上一行；只要挪完仍在本行高度内就继续挪。
    var PUNCT = /[，。！？、；：）》」』】〕］｝〉》」』】]/;
    while (best < total){
      var tmp = at(best);
      var ch = tmp.node.textContent.charAt(tmp.offset);
      if (!ch || !PUNCT.test(ch)) break;
      if (heightAt(best + 1) > h) break;
      best++;
    }
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

    // ★ 1.8.24 修正（问题1：撕开后 C/D 之间的间距明显大于 A/B/C）
    //
    // 现象：一道题的选项 A/B/C 在上一页、D 被拆到下一页时，C 和 D 之间的
    //       空隙比 A/B/C 之间大一截，看起来像凭空多空了一行。
    //
    // 根因：.fp-q 的 margin-bottom 语义是「题目与题目之间」的间距。
    //       同一壳内 A/B/C 之间只有 .fp-opt 自己的 margin（0.4em ≈ 6.4px）；
    //       而 C 与 D 之间跨了壳边界，那里站着的是 .fp-q 的 margin（默认 18px）——
    //       它和壳内最后一个 .fp-opt 的 6.4px 折叠，取大者 18px。
    //       于是接缝处的间距被「题目间距」顶替了，凭空大出一截。
    //
    // 修法：被拆开的那个壳（后面还跟着同一道题的续排）不该吃题目间距 ——
    //       它后面跟的是自己的下半截，不是新题。给它打上 fp-cont，CSS 里清零。
    //
    // 为什么放在装页全部结束之后统一打标：这是**向后看**的判断
    // （得知道后面还有没有同题的续排），装到一半时还没法确定。
    // 为什么用 qid 而不是「同页/跨页」来判断：同一页内也可能被拆成两个壳
    // （块拆成单原子重来时就会），只按页判断会漏。
    function markSplitShells(pages){
      // 先收集每个 qid / mid 最后一次出现的壳
      var lastQ = {}, lastM = {};
      for (var p = 0; p < pages.length; p++){
        var bd = pages[p].firstChild;
        if (!bd) continue;
        var qs = bd.querySelectorAll('.fp-q[data-fp-qid]');
        for (var z = 0; z < qs.length; z++)
          lastQ[qs[z].getAttribute('data-fp-qid')] = qs[z];
        var ms = bd.querySelectorAll('.fp-mat[data-fp-mid]');
        for (z = 0; z < ms.length; z++)
          lastM[ms[z].getAttribute('data-fp-mid')] = ms[z];
      }
      // 再扫一遍：凡是「不是该 qid 最后一次出现」的壳，后面都还跟着续排 → 清零下间距
      for (p = 0; p < pages.length; p++){
        var bd2 = pages[p].firstChild;
        if (!bd2) continue;
        var qs2 = bd2.querySelectorAll('.fp-q[data-fp-qid]');
        for (var y = 0; y < qs2.length; y++){
          var k = qs2[y].getAttribute('data-fp-qid');
          if (lastQ[k] !== qs2[y]) qs2[y].classList.add('fp-cont');
        }
        var ms2 = bd2.querySelectorAll('.fp-mat[data-fp-mid]');
        for (y = 0; y < ms2.length; y++){
          var km = ms2[y].getAttribute('data-fp-mid');
          if (lastM[km] !== ms2[y]) ms2[y].classList.add('fp-cont');
        }
      }
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
    //
    // ⚠️ 1.8.24 实测澄清（重要，别再白改一遍）：
    // 一度以为 smart 档 0.2 门槛太高（≈197px）导致全篇不撕，因为实测每页尾留白
    // 稳定在 123~157px、27/27 页都低于门槛。但给 splitTextAtom 插桩后发现：
    // 它 **被调用 0 次** —— 压根没走到这条分支。
    //
    // 真正的原因在更上面：分页按「块」整块塞（if (h1 <= lim) 就直接收），
    // 页尾留白 130px 是因为**下一个块整体高于 130px**，于是整块翻页；
    // 而这个块自己不高于 lim，放得进下一页，所以永远轮不到「撕开填缝」。
    // 这是**块粒度**问题，不是门槛问题 —— 调门槛一点用都没有（已实测：改完留白分毫未动）。
    //
    // 因此门槛保持原值不动，等块粒度问题解决后再看是否需要调。
    var SPLIT_MIN = (md === 'ultra') ? 0.015 : 0.2;

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
    // 装页全部结束，此刻才谈得上「往后看」判断哪些壳后面还跟着自己的续排：
    // 给它们打 fp-cont 清零题目间距，消除撕开接缝处凭空多出来的空隙。
    markSplitShells(pages);
    return pages;
  }

  // 1.8.9：兜底清扫 —— 撕开/重排过程中可能漏掉清空的空题壳（.fp-q/.fp-stem/.fp-opts/.fp-mat
  // 没有任何元素子节点）。这类空壳会让续排页看上去像「空题框 / 掉题号」，统一删掉最稳。
  function sweepEmptyShells(pages){
    for (var p = 0; p < pages.length; p++){
      var body = pages[p].firstChild;
      if (!body) continue;
      var sh = body.querySelectorAll('.fp-q,.fp-stem,.fp-opts,.fp-mat');
      for (var s = 0; s < sh.length; s++){
        if (!sh[s].children.length && sh[s].parentNode) sh[s].parentNode.removeChild(sh[s]);
      }
    }
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
        // .fp-pbody 在屏幕模式下是 flex:1，内容不满时会被拉伸成整页高，
        // 量它的高度永远等于 BODY_H，真实溢出/留白会被掩盖。
        // 改量首末子元素的实际跨度。
        var b = pages[i].firstChild, kids = b.children;
        if (!kids.length) continue;
        var hh = kids[kids.length - 1].getBoundingClientRect().bottom - kids[0].getBoundingClientRect().top;
        if (hh - BODY_H > over) over = hh - BODY_H;
      }
      if (over <= 1) break;
      // 下限 0.95 只是防失控的兜底。切页改成实测之后 over 通常只剩几像素舍入误差，
      // 一压就到下限反而是信号：说明真有拆不动的东西，再压纯属浪费版面。
      var next = Math.max(BODY_H * 0.95, lim - Math.max(4, Math.ceil(over)));
      if (next >= lim) break;            // 已经压到下限，再跑几轮也是白跑
      lim = next;
      // 连着两轮都收不住，说明当前粒度下没有能塞进去的切法：
      // 「整题不拆」在这儿行不通，换最细粒度再试，宁可拆题也别把字顶出页面
      if (round >= 1) gran = 'ultra';
    }

    sweepEmptyShells(pages);

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

  // 暴露「重切」钩子：预览里渲染稳定后由主页面自动调一次，等价于手动切换一次换页模式，
  // 用干净的页码状态消除竞态空白，且不动 renderPreview 结构（不跳页、不重建 iframe）
  window.__fpRetighten = paginate;

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

        // 页面没加载完的处理：先重试一次（等 Angular 渲染 / 懒加载补上），
        // 还不行就明确让用户刷新，而不是印一份残缺的卷子出来。
        if (isShenlun) {
            await sleep(1200);
            items = (await extractShenlun(progress)) || items;
        } else {
            const cnt = (a) => (a || []).filter((i) => i && i.kind === 'question').length;
            if (cnt(items) === 0) {
                progress('题目尚未加载完成，正在重试…');
                await sleep(1500);
                const again = await extractXingce(progress);
                if (cnt(again) > cnt(items)) items = again;   // 重试拿到更多才替换
            }
        }

        const questionCount = items.filter((i) => i.kind === 'question').length;
        if (!items.length || questionCount === 0) {
            hideMask();
            setStatus('<span style="color:#dc2626">没抓到题目，请刷新页面重试</span>');
            // 面板标题仍是占位符 → 顺便说明标题也没抓到，省得用户以为是两个问题
            const tip = $('fp-title') && $('fp-title').value.trim() === TITLE_PLACEHOLDER
                ? '\n（试卷名也没读到，页面应该还没加载完）' : '';
            alert('没有在当前页面找到题目。\n请刷新页面、等题目完全显示出来后再试。' + tip);
            throw new Error('no question');
        }

        // 题目拿到了、但试卷名读不到（少见）：明确告知会印兜底名，让用户自己选是否先刷新。
        // 不用静默兜底 —— 用户有权知道封面印的不是真实卷名。
        if (!readPaperTitle()) {
            const ok = confirm('题目已读到，但没有读取到试卷名（页面可能还没完全加载）。\n\n'
                + '点「确定」继续生成（封面上会用「公务员录用考试试卷」）；\n'
                + '点「取消」先刷新页面重试。');
            if (!ok) {
                hideMask();
                setStatus('已取消，请刷新页面后重试');
                throw new Error('no question');
            }
            opt.title = '公务员录用考试试卷';
            $('fp-title').value = opt.title;
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

    function renderPreview(state, isTighten) {
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
                // 首次渲染稳定后（图片/字体已就位），自动再切一次消除竞态空白 ——
                // 等价于手动切换一次换页模式，但复用同一 iframe、保留滚动位置，不跳页。
                // 只触发一次（isTighten 标记防止递归），用 setTimeout 等文档真正安静下来。
                if (!isTighten) {
                    setTimeout(() => {
                        try {
                            if (ov.contains(frame) && frame.contentWindow.__fpRetighten) {
                                frame.contentWindow.__fpRetighten();
                                // 重切后把滚动位置对齐到刚才的位置，避免跳页
                                const wy = frame.contentWindow.scrollY || 0;
                                frame.contentWindow.scrollTo(0, Math.max(0, Math.min(y, wy + 0)));
                            }
                        } catch (e) {}
                    }, 400);
                }
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
            // 与 generate() 同样的处理：没抓到先重试一次，仍不行就明确提示刷新
            if (!isShenlun) {
                const cnt = (a) => (a || []).filter((i) => i && i.kind === 'question').length;
                if (cnt(items) === 0) {
                    await sleep(1500);
                    const again = await extractXingce(() => {});
                    if (cnt(again) > cnt(items)) items = again;
                }
            }
            const questionCount = items.filter((i) => i.kind === 'question').length;
            if (!items.length || questionCount === 0) {
                hideMask();
                setStatus('<span style="color:#dc2626">没抓到题目，请刷新页面重试</span>');
                alert('没有在当前页面找到题目。\n请刷新页面、等题目完全显示出来后再试。');
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

    // 注：更新/注入机制回归 1.8.1 验证过的稳定逻辑（见 forceUpdate，重注入前删 5 个固定 id 再注入新版）。
    // 1.8.7 初版曾自行加入 __FP_INJECTED__ / destroyOldInstance 防重接管，实测在「传新版后首次更新」场景
    // 反而造成面板叠加卡死，故回退，不引入未经长期验证的注入机制改动。

    // 1.8.8 —— 选项排布「按组统一」原则明确化：
    // 列数由 layoutFor 按整组最长项（q.maxUnits / 大图）统一决定，整组共用同一 class，
    // 因此同一道题的选项永远列数一致：要么都横排（grid-4 一行4个 / grid-2 一行2个），
    // 要么都逐行独占（grid-1）。当组里有任一选项长到要独占一行时，整组走 grid-1，
    // 其余选项也跟着逐行独占，绝不会出现「有的横排、有的折行」的参差。
    // 注：曾尝试把 grid-2/grid-4 改成 flex:1 1 auto 做「逐选项自适应」，
    // 结果把列数拆到每个选项头上、反而制造了组内参差，已回退为固定列宽。
    // 另修一处：图形推理题选项图未抓取、只剩字母「A/B/C/D」时，pickOptions 仍因单字母例外
    // 把 allImage 判为 true，致使 layoutFor 误套 140 特判把短选项顶成 grid-2；
    // 现加 anyImg 信号，只有选项里真有 <img> 才按图宽估算，纯字母短选项正确归到 grid-4（一行4个）。

    // 1.8.9 —— 极致省纸（ultra）四处留白根因修复，智能平衡（smart）零改动：
    // ① 选项可拆页：canSplitNode 放开「纯文本长选项」在 ultra 下的行边界撕开（只影响单独成行的 grid-1 选项，
    //    一行多选项因 cut 按「行」成块、撕开仅触发于单原子块，仍整行走，不会变 3+1）。
    // ② 题号续排：题干被撕开时，**续排段不再印题号**（1.8.25 产品决定，见 splitTextAtom 注释）；
    //    另加 sweepEmptyShells 兜底删掉重排中漏清的空题壳。
    // ③ 长段填缝：ultra 撕开门槛 SPLIT_MIN 从 8% 压到 1.5%（约 1 行），下限 MINH 压到 14px（约 1 行），
    //    页尾剩 1~2 行空位也能把单段长题干撕开续排，吃掉留白（多段题干本就按段成块、天然可跨页）。
    // ④ 图文分离：drill 对「含 img 的纯容器」也往下钻，让文字段与图片段各自成独立原子；
    //    粉笔题干外的 <div _ngcontent> 常把「文字 p + 图片 p」裹一起，此前焊成同一块致整题跟图翻页，
    //    现文字先留本页、图片翻下页（行内公式 img 的 <p> 仍整段保留，不强行劈公式）。
    // ⑤ 行内公式图估值修正：layoutFor 对「无可读宽度的小图」（maxImgW=0）的 imgNeed 特判值
    //    从 140 降到 70。原值对行内分数/根号等小公式图（实际 ~35px 宽）高估约 4 倍，
    //    页边距 ≥20mm 时把本该一行 4 个的短选项顶成 grid-2；70 足以容纳常见行内公式图，
    //    同时在各页边距下均能归到 grid-4。有 width 属性的大图仍走 maxImgW*figScale 路径（封顶140）。

    // 1.8.10 —— 行内公式图（flag="tex"）随文字大小缩放，消除「分数特别大」：
    //    此前 .fp-opt img / .fp-stem img 用 max-width:140px + height:auto，让公式图按
    //    原图像素（粉笔以 fontSize=18 渲染，分子/分母两行高约 45px）显示，在 15px 正文里
    //    显得大近 3 倍、特别突兀。现加专属规则 img[flag="tex"]{height:1.15em;width:auto}，
    //    锁成跟文字同高且随字号（用户面板设置）走 —— 仅公式图生效，配图（tarzan/images 无 flag）
    //    与图形选项（.fp-opt-img）都不命中，保持 140×100 原样。vertical-align:-0.2em 做上下居中微调。

    // 1.8.11 —— 分数图（\frac 等）仍偏高、且大字号下显得比文字小：
    //    粉笔 tex 图的图底落在「分数底部」，整张分数在基线之上，统一规则的 -0.2em 仍明显偏高；
    //    1.15em 又偏小，字号放大时比例更缩水。改法：提取时按 latex 内容给分数图打 fp-tex-frac
    //    （普通行内符号 x/上标不打标），渲染层对分数图用 1.3em + vertical-align:-0.32em，
    //    使分数横向中线≈文字中线、且随字号同步放大（值经无头浏览器实测：分数中心与纯文字中线偏移≈0）。
    //    仅动公式图，配图与选项图零影响。

    // 1.8.12 —— 真机确认 1.8.10/1.8.11 的公式图仍偏大+偏高：根因是粉笔公式图自带
    //    内联 style="aspect-ratio: 20/43 !important; height: auto !important"（有时还有 width/height）。
    //    内联 !important 优先级高于样式表 !important，脚本的 height:1.15em/1.3em 被它压住，
    //    公式图按原图尺寸（~43px 高）显示 → 偏大；且没走 vertical-align → 偏高。
    //    另：真实页面 latex 参数是编码 token（latex=HWUiiW14_...），读不到 \frac，
    //    故 1.8.11 靠正则打 fp-tex-frac 的办法落空。改法：
    //    ① tagTexFracImg 对每张 flag="tex" 图清除内联 aspect-ratio/width/height，让 CSS 真正接管；
    //    ② 改用 data-fp-ar="宽/高" 的宽高比判断分数 —— 瘦高（高≥宽×1.4）即按分数打 fp-tex-frac，
    //       套用 1.3em + vertical-align:-0.32em（横向中线≈文字中线）；其余公式图维持 1.15em/-0.2em。
    //    配图（tarzan/images 无 flag）、图形选项（.fp-opt-img）均不命中，零影响。
    //
    // 1.8.13 —— 1.8.12 在真机仍偏大+偏高、且字号放大时分数相对文字更小：根因是分数识别只读了
    //    data-fp-ar，而线上粉笔公式图往往不带该属性（只内联 aspect-ratio），漏判后分数退回原图 ~43px
    //    （固定像素、不随字号缩放 → 字号越大对比越小）。改法：
    //    ① 分数识别改用粉笔「内联 aspect-ratio」（永远存在）为主、data-fp-ar 兜底，不再漏判；
    //    ② 不再依赖「清内联 + 类选择器优先级」链路，直接对每张 flag="tex" 图写内联 !important
    //       （aspect-ratio:auto / height / vertical-align 等）——脚本后写的内联 !important 天然压过
    //       粉笔内联 !important 与任何样式表，分数稳定 1.3em、横向中线≈文字中线、随字号同步放大。
    //    配图与图形选项仍零影响。修正经无头浏览器实测（含「无 data-fp-ar」形态）。
    //
    // 1.8.14 —— 真机定位到 1.8.13「分数仍偏大、不随字号、不对齐」的真正根因（注：1.8.13 的
    //    tagTexFracImg 其实已正确识别并写出 height:1.3em / vertical-align:-0.32em，问题出在下游）：
    //    scaleFigures() 在 waitReady() 里被【轮询】执行（图片解码前每 250ms 一次，最长 15 秒），
    //    而它的分支 `if (naturalWidth>0 && naturalHeight>0 && !getAttribute('data-fp-ar'))` 会对
    //    没有 data-fp-ar 的图写 `height:auto!important` —— 后写的内联 !important 直接盖掉
    //    tagTexFracImg 设好的 1.3em。真机 DOM 里那行 `height: auto !important` 正是它写的。
    //    后果：① 高度退回粉笔原图像素（~43px 固定高，不随字号缩放 → 字号越大分数越小）；
    //          ② 破坏竖向对齐；③ 图高被算成 0 时，paginate() 用 getBoundingClientRect 量高度会
    //          严重低估块高 → 排版判断失真，大字号下出现大面积空白页。
    //    改法：scaleFigures 里先判 `flag==="tex"`，是行内公式图就整段跳过（既不再写 height:auto，
    //    也不参与 >150px 的宽度缩放），尺寸与对齐全权交给 tagTexFracImg。
    //    实测（无头 Chromium，复刻 55 题形态）：修复前 height:auto → 计算高 0px；修复后稳定
    //    1.3em，15px→19.5px、18px→23.39px、25px→32.5px 随字号同步；-0.32em 在各字号下
    //    分数中线与文字中线偏差 ≤0.75px。
    //
    // 1.8.15 —— 1.8.10 以来「分数图一直偏小」的最后一块拼图：尺寸基准选错了。
    //    分数是「分子/分母上下排布」的瘦高图，视觉尺寸取决于**宽度**，而旧逻辑一律按
    //    **高度**锁 1.15em/1.3em —— 分数图宽高比约 0.47~0.67，按高度锁高后宽度只剩
    //    0.6 字，所以怎么看都比文字小一圈。现按宽高比分三档（实测数据见 tagTexFracImg）：
    //      ① 瘦高（h ≥ w×1.25，真实分数 20/43、29/43）→ 按**宽度 1em** 与文字齐宽，
    //         高度按比例撑开（约 2.15 字），下沉 -0.7em 后中线与文字对齐（偏差 ≤0.75px）；
    //      ② 常规符号（℃ / 单字母 / 上下标，约 1.0~1.33）→ 按**高度 1.15em** 与文字齐高；
    //      ③ 长公式（宽/高 可达 6.7）→ 同样按**高度 1.15em**，宽度自然撑开 7.66 字，不会被压扁。
    //    阈值 1.25（判定线 宽/高=0.80）落在真实分数(≤0.67)与符号(≥1.0)之间的空白带正中。
    //    已知局限：极宽的多位数分数（如 12345/2，宽/高≈1.0）与符号尺寸无从区分，会落进②档；
    //    粉笔 latex 是加密 token 无法读取内容辅助判断，此为当前信息下的最优解。
    //    CSS 侧同步改为 width:1em/height:auto/-0.7em，与内联值保持一致，避免两边打架。
    //
    // 1.8.16 —— 真机仍「分数比文字小」的根因：提取时拿不到宽高比。
    //    粉笔的 data-fp-ar 是**图片加载完成后**才异步补上的，脚本抓 DOM 时常常还没写上；
    //    而内联 aspect-ratio 又已被分页逻辑写成 auto。于是 tagTexFracImg 的三个来源全部落空
    //    （旧写法 `img.style.aspectRatio || data-fp-ar` 里 'auto' 是真值会短路掉后者）
    //    → w=h=0 → 分数被误判成符号档 → 又变回「比文字小」。真机 DOM 佐证：img 上只剩
    //    data-fp-w="1"、没有 data-fp-ar，样式是 height:1.15em/-0.2em（符号档的特征值）。
    //    改法三处：
    //      ① tagTexFracImg 三个来源逐个校验（属性 → 内联比例 → naturalWidth/Height），
    //         任一项能解析出「宽/高」就用，不再被 'auto' 短路；
    //      ② scaleFigures 里对 flag="tex" 的图，在图片解码后用真实像素**补判一次**并重设样式
    //         （该函数由 waitReady 轮询调用，解码后才可信；注意它运行在生成页自己的 <script> 里，
    //          取不到外层函数，故内联了一份等价逻辑，改判定时两处必须同步）；
    //      ③ 分数下沉量不再写死，改按每张图的比例算：va = 常数 - (高/宽) ÷ 2（常数 1.8.17 实测校准为 0.383）。
    //         比例不同高度就不同（20/43→2.15 字、29/43→1.48 字），写死一个 em 必然有一类错位。
    //    实测（无头 Chromium）：分数 20/43 与 29/43 均 1 字宽、中线偏差 ≤0.31px；
    //    摄氏度 / 长公式维持 1.15 字高、偏差 ≤0.75px；三档互不影响。
    //
    // 1.8.17 —— 真机新现象「同一道题里分数有大有小」的根因：**把解码中间值永久固化了**。
    //    证据：54 题第 2 个分数（-2/3）在真机 DOM 上被写成 data-fp-ar="37/43"，
    //    而同题的 7/9 是 20/43。37/43 → 宽/高 0.86，超过判定线 → 掉进「符号档」→ 该图只有
    //    0.9 字高，旁边正常的分数是 1 字宽、2.15 字高，于是同题内一大一小。
    //    37 是假宽度：图片解码没完成时浏览器会先返回一个中间值（解码完成后才回落到真实的 20）。
    //    1.8.16 的两条路径都会把这个中间值**钉死**：
    //      ① `setAttribute('data-fp-ar', naturalWidth+'/'+naturalHeight)` 写进属性，
    //         下一轮进来发现「属性 == 当前读数」→ 判定已处理 → 直接跳过，错误永久保留；
    //      ② 更隐蔽的是 inner aspect-ratio：它一旦有值就**参与固有尺寸计算**，
    //         naturalWidth 会被反过来钳到由它推算出的宽度上，自己把自己锁死，永不纠正。
    //    改法四条：
    //      ① 抽出统一出口 applyTexSize(img, w, h) —— 三档判定与尺寸只此一份实现，
    //         tagTexFracImg 与 scaleFigures 都调它（旧版两边各写一份，改一处漏一处）；
    //      ② scaleFigures 对 flag="tex" 每轮都按**当前**读数重算重设（幂等，重复调用无副作用），
    //         只记录信息性的 data-fp-tex-ar，不再用「属性是否相等」当跳过依据 ——
    //         读数一旦被纠正，下一轮样式自动跟上，不会被历史错误绑架；
    //      ③ 所有「按 naturalSize 写比例」的路径统一加 complete 闸门，
    //         解码没完的图一律不碰（普通配图同理）；
    //      ④ 判定线由 1.25（宽/高 0.80）左移到 1.65（0.606）。
    //         原值太贴真实分数（0.67）且与「矮符号」24/30 只差在一条线上（实测 24/30 被判成分数档）；
    //         0.606 离最近的符号 1.0 留 0.4 余量、离最宽的分数 ~0.8 留 0.2 余量，两边都不擦线。
    //    另附：生成页新增 `html{text-size-adjust:none}`。浏览器「字号调整 / 文字缩放」会把
    //    以 em 计尺寸的公式图一起放大（位图放大会发虚），关掉后打印页永远按脚本算的 px 字号渲染。
    //    实测（无头 Chromium，四张同源 20/43 的图分别预置 data-fp-ar=20/43 / 37/43 / 内联 37/43 / 无属性）：
    //    修复前两档分裂（16.0×34.4 与 8.5×18.4），修复后四张全部收敛到 16.00×34.39、分数档、va=-0.69em；
    //    三档互不误伤：分数 1.00 字宽、摄氏度 1.15 字高、长公式 7.66 字宽。
    //    对齐改按「墨迹中心法」重新校准：下沉常数 0.35 → 0.383（把「国」字画到 canvas 取墨迹上下
    //    边界的中点作为文字视觉中心），分数中线偏差 0.70px → 0.11px，符号档 -0.2em 实测 0.25px。
    //
    // 1.8.18 —— 修复 1.8.17 引入的**致命回归**：生成试卷直接失败，报
    //    `applyTexSize is not defined`。
    //    原因纯粹是作用域：applyTexSize 定义在【生成页自己】的 <script> 里 ——
    //    那是另一个文档、另一个作用域，而调用它的 tagTexFracImg 跑在油猴脚本的外层。
    //    1.8.17 为了「判定逻辑只留一份」，把 tagTexFracImg 的三档实现删掉改成调 applyTexSize，
    //    于是提取题干的第一步（pickStem → markTexFrac → tagTexFracImg）就抛错，
    //    整个抓取流程中断 → 试卷根本生成不出来。
    //    教训：这两段代码虽然逻辑相同，却**必须各存一份**，不能抽公共函数 ——
    //    它们的宿主是「外层脚本」与「生成页脚本」两个互不可见的作用域。
    //    修法：外层恢复一份自包含的三档实现（tagTexFracImg 内联，不依赖任何外部函数），
    //    常量 TEX_FRAC_K / TEX_SINK_C 在外层与生成页各声明一次，两处行尾标了「同步点」，
    //    改判定时搜索该词逐个核对（本次已核对：1.65 / 0.383 两处一致）。
    //    另加装「跨作用域调用」静态自查：脚本里生成页 <script> 的函数名，不得在外层被调用。
    //    验证方式（这次不再只看逻辑）：把整个油猴脚本放进 Node 的 vm 里跑通启动，
    //    再用它生成的试卷 HTML 在无头 Chromium 里加载，页面内挂 window.onerror 捕手 ——
    //    结果 CLEAN_NO_JS_ERROR，且 fp-tex-frac 正确打在分数图上、分页正常。
    //
    // 1.8.19 —— 彻底解决「有的分数正常、有的分数偏小」，方法是**照抄粉笔原生的做法**。
    //    症状（用户实测）：分子分母只有一位数且无负号的分数正常；
    //    带负号的、分子分母大于一位数的分数明显偏小。同一道题里分数大小不一。
    //
    //    真因：过去 8 个版本都用同一个错误模型 —— 拿「宽高比」把公式图分成
    //    「分数档 / 符号档」，再各给一套尺寸。实测真机 22 张图，这个模型从根上就不成立：
    //      20/43(3/2) → 判成分数 ✅ ；29/43(15/2) → 判成符号 ❌ ；37/43(-2/3) → 判成符号 ❌
    //    用户的描述完全对上：能落进 20/43 这个比例的，恰好只有「一位数且无负号」那一种。
    //    而分数外框 43、整式外框 20，差了两倍多却视觉一样大 —— 因为分数那 43px 里装的是
    //    **两行**，每行仍是同一个字号。**外框高根本不是判断依据。**
    //
    //    粉笔原生怎么做的：把它的公式图逐张下载量测，答案很干净 ——
    //      图片 URL 里写死 fontSize=18，**图片内部就是用 18px 字号渲染的**；
    //      粉笔的 CSS 只做一件事：按原始像素 1:1 显示，**不做任何缩放**。
    //      因为「图片内部字号」与「正文字号」本来就是同一个数，天然一样大。
    //    所以正确做法只有一条：**等比缩放，让「图片内部字号」等于「当前正文字号」**。
    //      缩放比 = 正文字号px / 18 → 显示尺寸 = 原始像素 × 该比值，用 em 写出。
    //    这样正文 15px / 18px / 25px 下公式内部的字始终与旁边正文一样大，
    //    分数、整式、长公式、多位数分数全部自动正确 ——
    //    **不再需要任何「分档」「阈值」「特判」**，旧常量 TEX_FRAC_K / TEX_SINK_C 就此删除。
    //    基线对齐同理：图片底边那一行像素就是基线（粉笔导出的图统一留 3px 下边距），
    //    vertical-align 则按**每张图自己的底边留白**逐张算（实测 3~6px 不等）。
    //    踩过的坑：1.8.19 初版写死一个 -0.06em 想「把 3px 下边距压掉一点」，
    //    但真机各图留白并不统一（3/2 与 15/2 是 4px、-2/3 与 30° 是 3px、△AOD 是 6px），
    //    写死一个数必然有的压多了、有的压不够 —— 于是水平线又歪了。
    //    1.8.20 改为 canvas 逐像素量出每张图的实际留白，再逐张写内联下沉量。
    //    实测五张图墨迹底边的离散度从 4px 降到 0.02px。
    //
    //    实测验证（真机那 5 张代表性公式图，三档字号）：
    //      统一到 em 后跨字号完全一致 —— 3/2 恒为 1.111×2.389、
    //      15/2 恒为 1.611×2.389、-2/3 恒为 2.055×2.389、
    //      30° 恒为 1.722×1.111、△AOD 恒为 3.667×1.278。
    //      18px 正文字号下缩放比精确为 1.0000（与粉笔原生 1:1 完全吻合）。
    //      肉眼复核：3/2、15/2、-2/3 三个分数大小完全一致，底边都坐在基线上；
    //      30°、△AOD 的墨迹与旁边「国」字同高。
    //    回归防护：check-scope.js 增加两条 —— ①检测旧常量是否残留；
    //      ②跨作用域调用检测（本轮负向验证过：故意注入一次 applyTexSize 调用能被抓出）。
    /* ---------------- 1.8.33 启动重构：幂等 runInit + 路由变化重跑 ----------------
     *
     * ★ 这一节才是「课程题组抓不到」的**真正解药**（已用真机 DOM 实测确认）：
     *   病根是**时序**，不是选择器 —— 外壳（.tis-container）一直在，只是脚本跑的时候
     *   Angular 还没把 app-ti 塞进 DOM。实测对照（t30/probe_tiroot.js）：
     *     题目已渲染 → 抓到 9 题 ／ 外壳都在但题目未渲染 → 抓到 0 题 ← 用户遇到的现场
     *
     * 真机控制台日志给出的顺序是关键证据：
     *     路由事件结束：/remote/exam/https:%2F%2Fspa.fenbi.com%2Fti%2Fexam%2Fexercise%2F1_1_3sdocaj
     *     [试卷排版打印] v1.8.32 已就绪  …/exercise/1_1_3sdocaj?routecs=xingce
     * 「已就绪」打在路由结束之后 —— 说明脚本**不是**跑在页面加载前，
     * 而是跑在 Angular 把题目塞进 DOM 之前。旧写法只在全站发一次初始化：
     *     setTimeout(autoCount, 1200)  ← 一次性的，错过就没了
     * 于是面板在、题数空、点生成报「没抓到题目」。
     *
     * 做法：把启动包成 runInit()，用 window.__fpInitUrl 记下「上次按哪个地址初始化过」，
     *   地址没变就整个不动（幂等，重复触发不会叠面板）；
     *   地址变了（课程页 → 题组 iframe 内路由跳转）就重新走一遍探测。
     *   统计与标题本来就是轮询，重入无害。
     *
     * ⚠️ 刻意**不**用 setInterval 轮询 location.href 来兜底：
     *   spa.fenbi.com 是 pushState 路由，轮询抓不到自身跳转；
     *   而且会把 _ngcontent 变化之类的无关重渲染也算进来，反复重建面板 ——
     *   典型的「看着聪明但会坑用户」的花活。只认真正会派发的事件，宁少不错。
     */
    if (!window.__fpInitUrl) {
        Object.defineProperty(window, '__fpInitUrl', { value: '', writable: true, configurable: true });
    }

    // 进入做题页即自动统计题数 / 材料数并显示（轻量，不打扰）。
    // 1.8.33：改成「轮询到有题为止」，并设 12s 死线，避免在非做题页上无限轮询。
    function startPollCount() {
        (function pollCount(tries) {
            if (busy) return;
            if (tries >= 24) return;              // 24 × 500ms = 12s 死线
            setTimeout(function () {
                Promise.resolve(autoCount()).then(function () {
                    // 面板已显示题数 → 说明抓到了，停止轮询
                    const el = $('fp-stat');
                    if (el && /共\s*<b>/.test(el.innerHTML || '')) return;
                    pollCount(tries + 1);
                });
            }, tries === 0 ? 800 : 500);
        })(0);
    }

    // 把真实试卷名回填到面板（幂等，重入无害）。
    // 不能用固定延迟：试卷名是 Angular 异步渲染的，写死 900ms 在慢机器／弱网上会跑空，
    // 于是 readPaperTitle() 退到 document.title（粉笔的静态标题就是「粉笔题库」），
    // 卷子封面上会印出一个毫无意义的「粉笔题库」。所以改成轮询，读到为止。
    //
    // 只有拿到**真正有意义**的试卷名才回填：
    //   旧写法「元素一出现就取」会踩两个坑 —— 粉笔的元素常先以 title="null" 占位出现，
    //   于是把假名字写进输入框；再叠加「拿不到就退 document.title」的兜底，
    //   最终封面上印的要么是 null、要么是无意义的「粉笔题库」。
    // 现在「值可用才写」，读不到就保持 placeholder（正在读取当前试卷…），
    // 生成时会强制重新读一次，读不到就明确提示用户刷新。
    function pollTitle(deadline) {
        const el = $('fp-title');
        if (!el) return;
        // 用户已经改过或已回填过，不再动它
        if (el.value.trim() && el.value !== TITLE_PLACEHOLDER) return;
        const t = readPaperTitle();
        if (t) { el.value = t; return; }
        if (Date.now() >= deadline) return;   // 超时仍读不到：留空占位，交给生成时的提示
        setTimeout(() => pollTitle(deadline), 400);
    }

    function runInit() {
        const here = String(location.href);
        if (window.__fpInitUrl === here) return;   // 同一地址重复触发：一个指头都不碰
        window.__fpInitUrl = here;

        // 面板可能已存在（同址重入或用户已打开预览）—— 有就只重挂统计，不重建
        if (!$('fp-panel')) {
            injectStyle();
            const { panel } = buildPanel();
            bindPanel(panel, $('fp-mask'), () => run('print'), () => run('save'), () => openPreview());
            applySettings(readSettings());
            syncShenlunUI();
        }
        startPollCount();
        pollTitle(Date.now() + 10000);
        checkUpdate();
    }

    // 路由监听：地址真的变了才可能重跑（runInit 内部还会再判一次，双保险）。
    //   原生 popstate / hashchange 覆盖浏览器前进后退；
    //   粉笔 SPA 自己的路由事件名字拿不到，试几个常见名，派发不了就静默跳过 ——
    //   有原生这两个已够用，不为第三类事件写花哨兜底。
    ['popstate', 'hashchange'].forEach((ev) => window.addEventListener(ev, () => runInit()));
    ['fp-route-change', 'route-change', 'ng-router-change'].forEach((ev) => {
        try { window.addEventListener(ev, () => setTimeout(runInit, 300)); } catch (e) { /* 忽略 */ }
    });

    runInit();

    console.log('%c[试卷排版打印] v' + VERSION + ' 已就绪', 'color:#16a34a;font-weight:bold');
})();    // 1.8.23  修好 1.8.22 的对齐：公式没错，但**一次都没生效**
    //   用户反馈原话：「妈耶我不知道你改在哪里了……这个效果和刚才有任何区别吗，
    //   完全一样，分数比他高那么多」。证据是他贴的真机 DOM ——
    //   图片的 vertical-align 全是 -0.17em，正是 1.8.22 的兜底常量，
    //   说明新写的 measureTex / texAlignEm **一次都没跑过**。
    //
    //   根因（无头 Chromium 复现）：tagTexFracImg 由 markTexFrac() 在**游离的 div** 上调用：
    //       d = document.createElement('div'); d.innerHTML = html;   ← 图还没进文档
    //       d.querySelectorAll('img[flag="tex"]').forEach(tagTexFracImg);
    //   此时 <img> 尚未开始加载，实测读数：
    //       游离节点 nw=0 complete=false ／ 插入文档同步读 nw=0 ／ 500ms 后 nw=20
    //   而 1.8.22 的 tagTexFracImg 第一行就是
    //       if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) return;
    //   → 尺寸与对齐一个都没写，全部落空。
    //
    //   修法一：**尺寸不再依赖解码**。新增 texNatSize()，按可信度从四个来源解析原始宽高：
    //       ① data-fp-tex-ar  ② data-fp-ar  ③ 内联 aspect-ratio  ④ naturalWidth/Height
    //   前三个是属性，不依赖图片解码，游离节点里也读得到 —— 尺寸照写不误。
    //
    //   修法二：**对齐改成两档精度**，关键在于认清「哪些量真的需要图片像素」：
    //       图高(em)        ← 来自属性，不需要像素
    //       文字视觉中线    ← canvas 画「国」字量得，与公式图无关
    //       墨迹中线距图顶  ← **只有这个需要读图片像素**
    //   于是：
    //       ① 图已解码 → va = charMid/fs − 图高(em) + 墨迹中线距图顶(em)   精确
    //       ② 图未解码 → va = charMid/fs − 图高(em)/2                      近似
    //   两档配合：游离阶段先用 ② 保证「有值可用」，生成页 scaleFigures 在解码后
    //   调 applyTexSize 用 ① 精修一次（该机制 1.8.17 已建立，幂等）。
    //
    //   为什么 ② 必须有 ① 兜着（实测数据）：**墨迹中线并不在图的正中**。
    //   逐张量五张真机图的「墨迹中线距图顶 − 图高/2」：
    //       3/2 −0.5px ／ 15/2 −0.5px ／ −2/3 0px ／ 30° 0px ／ **△AOD −1.5px**
    //   只用 ② 时 △AOD 实测偏低 **1.53px**（肉眼可见）；走 ① 后降到 0.02px。
    //   所以能读像素时一定不能偷懒用 ②。
    //
    //   兜底链收敛为两级（**删除 TEX_SINK_FALLBACK**）：
    //       ① 正常：上面两档
    //       ② canvas 不可用 → TEX_CHAR_MID_REF(0.39) − 图高/2
    //   绝不再退回「按底留白贴基线」（1.8.20 的老毛病：会把分数压到基线上，
    //   正是用户报过的「分数比文字低一大截」）。
    //
    //   为什么公式里不再出现「图墨迹中线」也能算准 va：
    //     1.8.22 写的是 va = charMid/fs − 图高 + inkMidEm，要求先知道 inkMidEm；
    //     1.8.23 拆成两档，解码前用图高中点代替 inkMidEm，解码后补上真值。
    //     两者在解码后数学完全等价，差别只在「解码前也有值可用」。
    //
    //   实测（无头 Chromium，脚本真实产出值）：
    //     · 游离节点专项：五张图在 naturalWidth=0 时**全部写出**正确的
    //       width/height/vertical-align（1.8.22 在这里全军覆没）；
    //     · 4 档字号（18/22/25/32px）× 5 张真机图 = 20 组，图墨迹中线 − 文字视觉中线
    //       偏差 **全部 ≤ 0.02px**；
    //     · 参考线复核（蓝线=文字中线、红线=图中线）：两行共 6 张图，偏差全是 **+0.00px**。
    //
    //   已知未改（用户 2026-09-22 明确表示「不改这条了」）：
    //     分数图高 2.389em > 文字行高，即**分数比文字高**。这是 1.8.19 定的
    //     「等比缩放」（显示尺寸 = 原图像素 ÷ 18）的固有结果，好处是多位数与负号
    //     分数都能正确处理。若日后要改，方向是「宽度封顶」：等比但 w ≤ 1.45em，
    //     可把 3/2 与 15/2 的宽度差从 1.45 倍压到 1.3 倍以内，且不会被压扁。
    //
    //   踩坑记录（本轮新增两条）：
    //     ① 本段注释位于**外层模板串内**，注释里出现反引号会提前闭合模板串
    //        （` 在模板串里是定界符）→ node --check 报 Unexpected token 'if'；
    //     ② 造测试页时 `+'\n'+` 后面紧跟 `+// 注释` 会让 JS 把注释后的表达式
    //        接成一项，拼接结果里冒出字面量 NaN —— 注释要挪到表达式外面。
    //
    // 1.8.22  行内公式图对齐重写：让「图的墨迹中线」精确落在「文字视觉中线」上
    //   需求原话：「分数的横向中线 和相邻文字的横向中线没有对齐，不在一条线上」。
    //   注意这是**纵向**问题 —— 说的是分数那条水平分数线，要与相邻文字的水平中线重合，
    //   不是图在左右方向的位置（实测图片左右留白本就对称：5/5、5/5、4/5、3/4、4/4）。
    //
    //   1.8.21 为什么错：分数用 vertical-align:middle。middle 是让图在**行盒**里居中，
    //     而行盒中心 ≠ 文字视觉中心 —— 汉字有上下不对称的字体留白（实测「某」上 16px、下 1px），
    //     视觉中心在基线上方约 0.4 个字号高，比行盒中心低。实测 middle 的偏差：
    //       18px → -1.38px、25px → -2.07px、32px → -2.77px
    //     **偏差随字号线性放大** —— 字号越大错得越明显，所以小字号下看着"还行"。
    //
    //   1.8.22 怎么修：不分类，改用一条公式让图墨迹中线对齐文字视觉中线：
    //       va = (文字视觉中线 / 字号) − 图高(em) + (图墨迹中线距图顶 / 18)
    //     单行公式的墨迹几乎占满图高 → 后两项相消，结果趋近"贴基线"；
    //     分数墨迹居中且图高很大 → 结果自动变成大负值，把图中线顶到文字中线上。
    //     也就是说「贴基线」与「行内居中」本来就是同一条公式的两个特例，
    //     1.8.19~1.8.21 反复纠结的"怎么分类"是个伪问题 —— 不需要分类。
    //
    //   文字视觉中线**运行时用 canvas 实画一个「国」字量出来**，不写常数：
    //     实测「文字墨迹中线 / 字号」比值在 0.375~0.425 之间浮动（±6%），
    //     因为汉字墨迹底边距基线随字号在 1~3px 间非整数变化。写死常数必在某段字号失准
    //     （实测固定 -0.80em 时，16~20px 偏差 ≤0.26px 很准，但 22px 起涨到 +0.8~+1.5px）。
    //     canvas 实测则任何字号、任何字体都准。
    //
    //   踩坑记录（都花了时间，值得记下）：
    //     ① **顺序**：必须先钉死图片尺寸（会触发回流），**再**量基线与文字中线。
    //        反过来先量后改，回流会让基线移动，算出的 va 全错（实测偏差涨到 ±18px）。
    //     ② canvas 量图片墨迹时，画布要按**自然尺寸**建、且 drawImage 显式给目标宽高，
    //        否则图会被按渲染尺寸拉伸，量出的墨迹高离谱（实测 43px 的图量成 648px）。
    //     ③ 量文字墨迹时基线要放在画布纵向中部偏下（本实现取 2 倍字号处），
    //        否则大字号下字形会超出画布顶部，量不到上边界。
    //     ④ 参考字选「国」：全包围结构，墨迹范围最贴近汉字的视觉中心，比「某」更稳。
    //
    //   实测结果（外层与生成页两份实现一致，四字号端到端验证）：
    //     图      墨迹高   18px        22px        25px        32px
    //     20x43    36     -0.8333em   -0.8586em   -0.8622em   -0.8472em
    //     29x43    36     -0.8333em   -0.8586em   -0.8622em   -0.8472em
    //     37x43    37     -0.8056em   -0.8308em   -0.8344em   -0.8194em
    //     31x20    14     -0.1667em   -0.1919em   -0.1956em   -0.1806em
    //     66x23    14     -0.3333em   -0.3586em   -0.3622em   -0.3472em
    //   全部 20 组「图墨迹中线 − 文字视觉中线」偏差 ≤ 0.02px。
    //   像素级复核：截图里 3/2 分数图与左侧汉字的墨迹中线 y 完全相同（+0.00px）。
    //
    //   常量：TEX_BASE_PX / TEX_REF_CHAR / TEX_CHAR_MID_REF（两处各声明一次，标了「同步点」）
    //   函数：texNatSize（解析原始宽高）/ measureTex（图片墨迹）/
    //         measureCharMid（文字视觉中线）/ texAlignEm（解 va，两档精度）
    //
    // 1.8.21 —— 对齐规则改按需求分两类（单行贴基线 / 分数行内居中）。
    //    需求原话：① 单行公式（30°、△AOD）图片底部与文字基线保持一致；
    //             ② 分数这类「高度明显大于行高」的图，应在行内垂直居中
    //                （图垂直中心线 = 行水平中心线），而不是顶对齐或底对齐。
    //    怎么分类？用**墨迹高度**：实测分数墨迹高 36~37px、单行公式 14px，两簇零重叠；
    //    取阈值 24px（约 1.33em，正落在两簇之间的空白带）判「是否分数」。
    //    为什么不用外框高：粉笔导出的图上下都有留白且留白不固定（3~6px），
    //    外框会把两类图拉进 20~43 的连续区间，分不干净；墨迹高才是干净的两簇。
    //    实现：分数写 vertical-align:middle；单行仍按**自己**的底边留白下沉贴基线。
    //    行距影响（已与用户确认「接受行距被撑开」）：分数图高 2.389em > 行盒 1.6em，
    //    含分数的行会被撑开到图片高度（18px 字号下 28.8px → 51.8px）；
    //    不含分数的行**完全不受影响**，分数行之后的行距也自动恢复。
    //    实测（18px / 25px 两档字号，脚本真实产出值）：
    //      分数 3/2、15/2、-2/3 —— 图中心 − 行中心 = 0.00px（完全居中）；
    //      单行 30°、△AOD —— 图墨迹底 − 基线 = 0.00 ~ -0.02px（完全贴平）。
    //    ⚠️ 踩坑记录：中途给 CSS 兜底块写了一条 vertical-align:baseline，
    //    结果与上面「普通配图 vertical-align:middle!important」的通用规则打架，
    //    把公式图的 vertical-align 顶成了 baseline，居中直接失效。
    //    教训：公式图的对齐**只由 JS 内联值决定**，样式表里一个都别写。
    //

