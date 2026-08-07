'use strict';
/**
 * scripts.js — 注入/读取到页面里执行的 JS 字符串常量与构造器。
 * 纯字符串,不依赖 transport/api。供 api.js(页面操作)与 monitor.js(监控)复用。
 */

const GEN_SEL = `
function genSel(el){
  if(!el) return null;
  if(el.id) return '#'+CSS.escape(el.id);
  let path=[]; let cur=el;
  while(cur && cur.nodeType===1){
    if(cur.id){ path.unshift('#'+CSS.escape(cur.id)); break; }
    let part=cur.tagName.toLowerCase();
    let parent=cur.parentElement;
    if(parent){
      let sibs=Array.from(parent.children).filter(c=>c.tagName===cur.tagName);
      if(sibs.length>1) part+=':nth-of-type('+(sibs.indexOf(cur)+1)+')';
    }
    path.unshift(part); cur=parent;
  }
  return path.join(' > ');
}
`;

const SNAPSHOT_JS = GEN_SEL + `
(() => {
  const seen = new Set(); const out = [];
  const sel = 'a, button, input, textarea, select, summary, [role=button], [role=link], [role=checkbox], [role=radio], [onclick], [tabindex]';
  const els = document.querySelectorAll(sel);
  for (const el of els) {
    if (seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (el.disabled) continue;
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.placeholder || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    if (!text && el.tagName !== 'input' && el.tagName !== 'textarea') continue;
    out.push({
      tag: el.tagName.toLowerCase(), text,
      href: el.href || undefined, type: el.type || undefined,
      placeholder: el.placeholder || undefined, checked: el.checked ?? undefined,
      selector: genSel(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  return out.slice(0, 300);
})()`;

// 几何视图:视口内"叶子文本块 + 可交互 + 图片"清单,按堆叠(有效 z + DOM 序)从顶到底排序。
// 每块:kind/text/tag/role/name/rect/z/occluded/selector。视口优先、全块排序、遮挡标注。
// 注意:不能有模板字符串反引号(会被注入/读到页面里)。
const VIEW_JS = GEN_SEL + `
(() => {
  const IW = window.innerWidth, IH = window.innerHeight;
  const px = Math.round(IW * 0.15), py = Math.round(IH * 0.15); // 视口余量,防贴边裁切误判
  const vp = { l: -px, t: -py, r: IW + px, b: IH + py };
  const INTERACTIVE = 'a, button, input, textarea, select, summary, [role=button], [role=link], [role=checkbox], [role=radio], [onclick], [tabindex]';
  const visible = (el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0;
  };
  // 有效 z:沿堆叠上下文链累加——自 z-index + 每个"定位且 z-index 非 auto"的祖先的 z-index(近似)。
  function effZ(el) {
    let z = 0, cur = el;
    while (cur && cur.nodeType === 1) {
      const cs = getComputedStyle(cur);
      if (cs.position !== 'static' && cs.zIndex !== 'auto') z += parseInt(cs.zIndex, 10) || 0;
      cur = cur.parentElement;
    }
    return z;
  }
  // 有直接文本 = 自身 childNodes 里含非空白文本节点(叶子,防父容器重复包后代)。
  const directText = (el) => {
    for (let i = 0; i < el.childNodes.length; i++) {
      const n = el.childNodes[i];
      if (n.nodeType === 3 && (n.nodeValue || '').trim()) return true;
    }
    return false;
  };
  const isImg = (el) => el.tagName === 'IMG' && !/^data:/.test(el.src || '') && (el.width || 0) > 16 && (el.height || 0) > 16;
  // 区域聚焦:window.__CDP_IN / __CDP_OUT(由 api.view 前置设置)
  const IN_SEL = window.__CDP_IN || '', OUT_SELS = window.__CDP_OUT || [];
  const inRoot = IN_SEL ? (document.querySelector(IN_SEL) || null) : null;
  const outRoots = OUT_SELS.map(s => document.querySelector(s)).filter(Boolean);
  const inRegion = (el) => inRoot ? inRoot.contains(el) : true;
  const inOut = (el) => outRoots.some(r => r === el || r.contains(el));
  const out = [];
  const seen = new Set();
  const all = document.querySelectorAll('*');
  for (const el of all) {
    if (seen.has(el)) continue; seen.add(el);
    if (el.nodeType !== 1) continue;
    if (!visible(el)) continue;
    if (!inRegion(el) || inOut(el)) continue;
    const interactive = el.matches(INTERACTIVE);
    const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
    if (!interactive && !isInput && !isImg(el) && !directText(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (!(r.right > vp.l && r.bottom > vp.t && r.left < vp.r && r.top < vp.b)) continue; // 视口过滤
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.placeholder || '').replace(/[\\u200B\\u200C\\u200D\\u2060\\uFEFF]+/g, '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    if (!text && !isImg(el) && !isInput) continue;
    out.push({
      kind: isImg(el) ? 'image' : (interactive || isInput) ? 'interactive' : 'text',
      text,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || el.getAttribute('aria-role') || undefined,
      name: el.getAttribute('aria-label') || undefined,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      z: effZ(el),
      occluded: false,
      selector: genSel(el),
    });
  }
  if (inRoot) {
    // 区域聚焦:按阅读顺序(DOM 序)排列,不做全局 z 混排、不标遮挡。
  } else {
    // 堆叠排序:z 降序,同 z 按 DOM 序(数组 push 顺序即 DOM 序)。
    out.sort((a, b) => (b.z - a.z) || (out.indexOf(a) - out.indexOf(b)));
    // 遮挡标注:块被"更高 z 且覆盖其中心"的块遮住 → occluded。window.__CDP_OC 可关(由 api.view 前置设置)。
    const cx = (b) => b.rect.x + b.rect.w / 2, cy = (b) => b.rect.y + b.rect.h / 2;
    const covers = (a, b) => a.rect.x <= cx(b) && cx(b) <= a.rect.x + a.rect.w && a.rect.y <= cy(b) && cy(b) <= a.rect.y + a.rect.h;
    if (window.__CDP_OC !== false) {
      for (let i = 0; i < out.length; i++) {
        for (let j = 0; j < i; j++) { // j 在 i 之上:仅当"严格更高 z"(真实弹窗 fixed+高 z),防同 z 卡片容器误判子元素
          if (out[j].z > out[i].z && covers(out[j], out[i]) && out[j].text !== out[i].text) { out[i].occluded = true; break; }
        }
      }
    }
  }
  return { viewport: { w: IW, h: IH }, blocks: out.slice(0, 100), truncated: out.length > 100 };
})()`;

// 共享的"按 selector 找元素、找不到即返回失败"页面前奏,供 CLICK/FILL/FOCUS 复用。
const FIND_EL = (sel) => `
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return { ok: false, err: '未找到: ' + ${JSON.stringify(sel)} };
`;

const CLICK_JS = (sel) => `(() => {
${FIND_EL(sel)}  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.click();
  return { ok: true, tag: el.tagName.toLowerCase() };
})()`;

const FILL_JS = (sel, value) => `(() => {
${FIND_EL(sel)}  if (!['input','textarea','select','[contenteditable=true]'].some(x => el.matches(x))) return { ok:false, err:'不是输入元素: '+el.tagName };
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
             : el.tagName === 'INPUT' ? HTMLInputElement.prototype
             : HTMLElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, tag: el.tagName.toLowerCase() };
})()`;

const FOCUS_JS = (sel) => `(() => {
${FIND_EL(sel)}  el.focus();
  return { ok: true, tag: el.tagName.toLowerCase() };
})()`;

const GET_FOCUS_JS = GEN_SEL + `
(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  return { tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 40) || undefined, id: el.id || undefined, selector: genSel(el) };
})()`;

const OUTLINE_JS = GEN_SEL + `
(() => {
  const headings = [];
  document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(el => {
    const t = (el.innerText || '').trim().slice(0, 80);
    if (t) headings.push({ level: +el.tagName[1], text: t, selector: genSel(el) });
  });
  const links = [];
  const seen = new Set();
  document.querySelectorAll('nav a, header a, main a').forEach(a => {
    const t = (a.innerText || '').trim().slice(0, 40);
    const k = (t || a.href).slice(0, 60);
    if (seen.has(k)) return; seen.add(k);
    if (!t && !a.href) return;
    links.push({ text: t || '(链接)', href: a.href || '' });
  });
  return { title: document.title, url: location.href, headings: headings.slice(0, 60), links: links.slice(0, 80) };
})()`;

const CONTENT_JS = `
(() => {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,svg,nav,footer,header,form,aside,iframe,button,a').forEach(e => e.remove());
  const lines = (clone.innerText || '').split('\\n').map(s => s.trim()).filter(l => l.length > 1);
  return { title: document.title, url: location.href, text: lines.join('\\n').slice(0, 6000) };
})()`;

// 子树钻取:把指定元素的 DOM 子树输出为紧凑层级树(一行一节点,缩进=深度)。
// 过滤垃圾:丢 script/style/link/meta 等、零宽/空白文本、纯图标空 span、哈希/自动生成 class;
// 折叠纯包装节点(单元素子 + 无自身文本 + 无 id/class);只显白名单 class + 自身文本截断。
// 注意:不能有模板字符串反引号(会被注入/读到页面里)。
function buildTreeExpr(sel, maxDepth = 8, maxClass = 2, out = []) {
  return `(() => {
  const root = document.querySelector(${JSON.stringify(sel)});
  if (!root) return { ok: false, err: '未找到: ' + ${JSON.stringify(sel)} };
  const DROP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);
  const OUT_SELS = ${JSON.stringify(Array.isArray(out) ? out : [out])};
  const outRoots = OUT_SELS.map(s => document.querySelector(s)).filter(Boolean);
  const isOut = (el) => outRoots.some(r => r === el || r.contains(el));
  const strip = (s) => (s || '').replace(/[\\u200B\\u200C\\u200D\\u2060\\uFEFF\\s]+/g, ' ').trim();
  const visible = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0; };
  const isJunkClass = (c) => !c || /^css-[A-Za-z0-9]+$/.test(c) || /^[A-Za-z0-9]{6,}$/.test(c);
  const goodClass = (el) => {
    const raw = (el.getAttribute && el.getAttribute('class')) || '';
    return raw.split(/\\s+/).filter(c => !isJunkClass(c)).slice(0, ${maxClass});
  };
  const ownText = (el) => { let t = ''; for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue; return strip(t); };
  const collapse = (el) => {
    let cur = el;
    while (true) {
      const kids = [...cur.children].filter(c => !DROP.has(c.tagName) && visible(c));
      if (kids.length === 1 && !ownText(cur) && !cur.id && goodClass(cur).length === 0
          && cur.tagName !== 'IMG' && kids[0].children.length > 0) { cur = kids[0]; continue; }
      break;
    }
    return cur;
  };
  const out = [];
  const walk = (el, depth) => {
    const c = collapse(el);
    const kids = [...c.children].filter(k => !DROP.has(k.tagName) && visible(k) && !isOut(k));
    const tag = c.tagName.toLowerCase();
    let label = tag;
    if (c.id) label += '#' + c.id;
    const cls = goodClass(c);
    if (cls.length) label += '.' + cls.join('.');
    const t = ownText(c);
    const line = '  '.repeat(depth) + label;
    if (c.tagName === 'IMG') out.push(line + (c.getAttribute('alt') ? ' "' + c.getAttribute('alt').slice(0, 40) + '"' : ''));
    else if (t) out.push(line + ' "' + t.slice(0, 60) + '"');
    else out.push(line);
    if (depth >= ${maxDepth}) return;
    for (const k of kids) walk(k, depth + 1);
  };
  walk(root, 0);
  return { ok: true, selector: ${JSON.stringify(sel)}, lines: out };
})()`;
}

// 注入到每个页面的监控脚本(hook console/onerror/unhandledrejection → window.__cdpLogs)。
// 存的是**活的嵌套对象**(读时再结构化序列化),可看对象结构 + 调用链(stack)。
// window.__cdpMon 哨兵保证幂等(重复注入 / 每次 document 重建只装一次)。
// 注意:不能有模板字符串反引号,因为它会作为表达式被注入 / 读到页面里。
const MONITOR_JS = `(() => {
  if (window.__cdpMon) return;
  window.__cdpMon = true;
  var logs = (window.__cdpLogs = window.__cdpLogs || []);
  var CAP = 2000;
  function push(e) { logs.push(e); if (logs.length > CAP) logs.splice(0, logs.length - CAP); }
  function stack() { try { return new Error().stack; } catch (e) { return ''; } }
  var lv = { log: 1, info: 1, warn: 1, error: 1, debug: 1 };
  for (var k in lv) {
    var orig = console[k];
    if (typeof orig !== 'function') continue;
    (function (name, base) {
      console[name] = function () {
        push({ ts: Date.now(), type: 'console', level: name, args: Array.prototype.slice.call(arguments), stack: stack() });
        return base.apply(console, arguments);
      };
    })(k, orig);
  }
  window.addEventListener('error', function (ev) {
    push({ ts: Date.now(), type: 'exception', level: 'error', message: ev.message || '', source: ev.filename || '', line: ev.lineno, col: ev.colno, reason: ev.error, stack: (ev.error && ev.error.stack) || ev.message || '' });
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    push({ ts: Date.now(), type: 'rejection', level: 'error', reason: r, stack: (r && r.stack) || stack() });
  });
})()`;

// 读表达式 = 幂等注入监控脚本 + 结构化序列化 window.__cdpLogs。
// 序列化保留普通对象/数组的**嵌套结构**,循环引用 → [循环]、DOM 节点 → <DIV#id>、
// Error → {name,message}、深度/键数封顶(防爆炸)。level 过滤与 since 时间戳在页面侧完成。
function buildReadExpr(levelSet, since) {
  const filter = levelSet
    ? '(' + JSON.stringify(levelSet) + '.indexOf(e.level) !== -1)'
    : 'e.type !== "browser"';
  return MONITOR_JS + '\n;(() => {\n'
    + '  var arr = window.__cdpLogs || [];\n'
    + '  var since = ' + (since || 0) + ';\n'
    + '  function makeStruct() {\n'
    + '    var seen = new WeakSet();\n'
    + '    return function struct(v, d) {\n'
    + '      if (v === null) return null;\n'
    + '      var t = typeof v;\n'
    + '      if (t === "string" || t === "number" || t === "boolean") return v;\n'
    + '      if (t === "undefined") return undefined;\n'
    + '      if (t === "function" || t === "symbol" || t === "bigint") return String(v);\n'
    + '      if (t !== "object") return String(v);\n'
    + '      if (d > 8) return "[深]";\n'
    + '      if (v instanceof Error) return { name: v.name, message: v.message };\n'
    + '      if (Array.isArray(v)) { var a = []; for (var i = 0; i < v.length && i < 50; i++) a.push(struct(v[i], d + 1)); return a; }\n'
    + '      if (v.nodeType) return "<" + (v.nodeName || "?") + (v.id ? "#" + v.id : "") + ">";\n'
    + '      if (seen.has(v)) return "[循环]";\n'
    + '      seen.add(v); var o = {}; var n = 0;\n'
    + '      for (var k in v) { if (n++ >= 30) { o["..."] = "(+more)"; break; } try { o[k] = struct(v[k], d + 1); } catch (e) { o[k] = String(v[k]); } }\n'
    + '      return o;\n'
    + '    };\n'
    + '  }\n'
    + '  return arr.filter(function (e) { return e.ts >= since && ' + filter + '; }).map(function (e) {\n'
    + '    var struct = makeStruct();\n'
    + '    var o = { ts: e.ts, type: e.type, level: e.level, args: (e.args || []).map(function (a) { return struct(a, 0); }) };\n'
    + '    if (e.stack) o.stack = e.stack;\n'
    + '    if (e.message) o.message = e.message;\n'
    + '    if (e.source) o.source = e.source;\n'
    + '    if (e.line != null) o.line = e.line;\n'
    + '    if (e.col != null) o.col = e.col;\n'
    + '    if (e.reason !== undefined) o.reason = struct(e.reason, 0);\n'
    + '    return o;\n'
    + '  });\n'
    + '})()';
}

module.exports = {
  GEN_SEL, SNAPSHOT_JS, VIEW_JS, buildTreeExpr, FIND_EL, CLICK_JS, FILL_JS, FOCUS_JS,
  GET_FOCUS_JS, OUTLINE_JS, CONTENT_JS, MONITOR_JS, buildReadExpr,
};
