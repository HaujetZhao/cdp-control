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

// 精简结构树:无参数,输出整页 body 的"文本 + 结构"紧凑树。
// 核心简化逻辑:丢垃圾标签、折叠纯包装节点、穿透 shadow DOM、合并交互/标题叶。
// 不做可见性判定(不查 computed style、不筛视口)——整页结构一次给全,由 hasText/productive
// 过滤无文本壳子树以控输出量。输出为带缩进的文本结构(标签 + 引用文本),无 [看]/[架]/[X] 状态前缀。
// 注意:不能有模板字符串反引号(会被注入/读到页面里)。
function buildTreeExpr() {
  return `(() => {
  const root = document.body;
  if (!root) return { ok: false, err: '未找到: body' };
  const DROP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'SVG', 'PATH', 'BR', 'IFRAME', 'PICTURE', 'SOURCE', 'USE']); // svg/path/br 图标链纯噪音,按钮保留(含操作信息)
  const strip = (s) => (s || '').replace(/[\\u200B\\u200C\\u200D\\u2060\\uFEFF\\s]+/g, ' ').trim();
  const ownText = (el) => { const parts = []; for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) parts.push(n.nodeValue); return strip(parts.join(' ')); };
  // 穿透 shadow DOM 收集整棵子树的文本(深度上限 d<8 防爆炸)。innerText 不穿透 shadow 边界,
  // 注释正文常藏在多层 web component 里(如 bili-rich-text>p>span),深度边界兜底必须用这个。
  const grabText = (el, d) => {
    const gt = el.tagName || '';
    if (gt === 'STYLE' || gt === 'SCRIPT' || gt === 'TEMPLATE' || gt === 'NOSCRIPT' || gt === 'LINK' || gt === 'META' || gt === 'TITLE') return '';
    const parts = [];
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) parts.push(n.nodeValue);
    if (d < 8) {
      if (el.shadowRoot) parts.push(grabText(el.shadowRoot, d + 1));
      for (let i = 0; i < el.children.length; i++) parts.push(grabText(el.children[i], d + 1));
    }
    return parts.join(' ');
  };
  // 泛化:children 含 light DOM + shadowRoot 子(穿透 Web Component shadow DOM,如 B站评论区)
  const childrenOf = (el) => { const k = []; for (let i = 0; i < el.children.length; i++) k.push(el.children[i]); if (el.shadowRoot) for (let i = 0; i < el.shadowRoot.children.length; i++) k.push(el.shadowRoot.children[i]); return k; };
  // 可交互:按钮/链接/输入/有 onclick|tabindex|role=button。无文字但可交互的节点保留(有操作价值)。
  const interactive = (el) => {
    const t = el.tagName;
    if (t === 'BUTTON' || t === 'A' || t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return true;
    return el.hasAttribute ? (el.hasAttribute('onclick') || el.hasAttribute('tabindex') || el.getAttribute('role') === 'button') : false;
  };

  // 精简整棵 body:丢垃圾标签、折叠纯包装节点(有内容/可交互才保留)、穿透 shadow DOM。
  // 不做可见性判定——整页结构一次给全,输出量由下方 hasText/productive 过滤控制。
  function simplify(el, depth) {
    const inter = interactive(el);
    // title 属性是标准可访问标签(操作栏如"点赞（Q）"/"投币（W）")。先记下,是否当自含叶子待 size 判定。
    const title = el.getAttribute ? (el.getAttribute('title') || '') : '';
    let text = ownText(el);
    const node = {
      tag: el.tagName.toLowerCase(),
      isContent: !!text || el.tagName === 'IMG' || inter, // 有文字/img/交互 = 有内容,可显示
      text, inter,
      imgAlt: el.tagName === 'IMG' ? (el.getAttribute('alt') || '') : '',
      kids: [],
    };
    // 总是下钻(无深度上限):有子节点的容器(如评论区)永远展开为独立项。
    for (const k of childrenOf(el)) {
      const kt = k.tagName.toUpperCase(); // svg 等 SVG 元素的 tagName 返回小写,统一转大写匹配 DROP
      if (DROP.has(kt)) continue;
      node.kids.push(simplify(k, depth + 1));
    }
    // 叶子兜底:仅当节点没有子节点(真叶子)时,才用穿透 shadow 的 grabText 抓取自身深层文本
    // (如 bili-rich-text>p>span 里藏正文的叶子)。有子节点的容器不走这里,保持展开。
    if (!text && !node.kids.length) text = strip(grabText(el, 0)).slice(0, 120);
    if (!text && (inter || el.tagName === 'IMG') && el.innerText) text = strip(el.innerText).slice(0, 80);
    node.text = text;
    node.isContent = !!text || el.tagName === 'IMG' || inter;
    node.size = 1 + node.kids.reduce((a, k) => a + k.size, 0);
    // title 兜底:无文本且小巧(如操作栏图标项,size≤8)才当自含叶子,标签 + 后代数值合并成一行;
    // 大容器带 title(多为 tooltip)不折叠,避免误吞内容。
    if (!text && title && node.size <= 8 && el.tagName !== 'SVG' && el.tagName !== 'path' && el.tagName !== 'USE') {
      node.leafValue = strip(title).slice(0, 40);
      node.isContent = true;
    }
    return node;
  }
  const tree = simplify(root, 0);

  // 自底向上标记:本节点或任一后代是否含"可读语义"(文本/img alt)→ 决定整段无文本的壳子树能否省略。
  // 注意不算 inter:裸 a/button(无文字)不是可读内容,其包装链应随叶子一起省略,否则会悬空。
  function markText(n) {
    let h = !!(n.text || n.imgAlt);
    for (const k of n.kids) if (markText(k)) h = true;
    n.hasText = h;
    return h;
  }
  markText(tree);

  const out = [];
  // 自带语义的叶子:交互元素(a/button/input)或 img → 折叠其包装链,直接显示自身(如 li>a "首页")。
  const leafish = (n) => n.inter || n.tag === 'img';
  const leafLabel = (n) => {
    let l = n.tag;
    if (n.tag === 'img' && n.imgAlt) l += ' "' + n.imgAlt.slice(0, 40) + '"';
    else if (n.text) l += ' "' + n.text.slice(0, 60) + '"';
    return l;
  };
  // title 自含项的数值:取后代里第一个文本(如点赞项标题"点赞（Q）" + 数值"22.9万")。
  const firstTxt = (arr) => { for (const k of arr) { if (k.text) return k.text; const t = firstTxt(k.kids); if (t) return t; } return ''; };
  // 内联短项判定/标签:允许浅层包装(如 span>button "赞同 576"),但含深层长文本则不可内联。
  const inlineLen = (n) => { // 节点可视文本总长(递归求和,超阈值提前停只判"够不够短")
    if (n.text) return n.text.length;
    if (n.imgAlt) return 2;
    if (n.leafValue) return n.leafValue.length + firstTxt(n.kids).length;
    let sum = 0;
    for (const k of n.kids) { sum += inlineLen(k); if (sum > 24) return sum; }
    return sum;
  };
  const inlineable = (n) => { const l = inlineLen(n); return l > 0 && l <= 24; };
  const leafText = (n) => { // 取可视文本(自身或首个有文本后代),供内联行显示
    if (n.text) return n.text;
    for (const k of n.kids) { const t = leafText(k); if (t) return t; }
    return '';
  };
  const inlineLabel = (n) => {
    if (n.tag === 'img' && n.imgAlt) return 'img "' + n.imgAlt.slice(0, 20) + '"';
    if (n.leafValue) { const v = firstTxt(n.kids); return '"' + n.leafValue + (v ? ' ' + v : '') + '"'; }
    return '"' + leafText(n).slice(0, 24) + '"';
  };
  // 琐碎叶子:空文本,或纯符号短串(如 "/"、"·" 分隔装饰)。GitHub 仓库名 "owner/repo" 的 "/" 即属此类,
  // 冗余于旁边的 a 文本,会撑破单子折叠链。过滤后不计入 productive(不显示、不阻塞折叠/分组)。
  const isTrivialLeaf = (n) => {
    const t = leafText(n).trim();
    if (!t) return true;
    return t.length <= 2 && /^[^\w一-龥]+$/.test(t);
  };
  // 路径压缩 + 共享父链:
  //  - 单子包装 → 累积进 path 下钻;
  //  - 多子包装(共享父)→ 先输出共享链,子逐个从空 path 重开;
  //  - 叶子 → 若 leafish(交互/img)折叠包装直接显示;若纯文本容器保留链(div > h1 "标题")。
  function walk(n, depth, path) {
    if (n.isContent) { // 内容节点
      if (n.leafValue) { // title 自含项:标签 + 后代数值合并成一行(如"点赞（Q） 22.9万"),不展开结构
        const val = firstTxt(n.kids);
        const head = path.length ? path.join(' > ') + ' > ' : '';
        out.push('  '.repeat(depth) + head + '"' + n.leafValue + (val ? ' ' + val.slice(0, 60) : '') + '"');
        return;
      }
      // 有子文本 → 作为容器下钻(标题/正文/操作栏各自独立,别压成一行吞掉统计);
      // 仅无子文本的真叶子、或小巧交互叶(a>span,size≤8)才 emit 自身。
      const hasChildText = n.kids.some(k => k.hasText);
      if (leafish(n) && n.size <= 8) { // 交互/img 小巧叶:折叠包装直接显示(如 a>span "首页")
        if (n.text || n.imgAlt) out.push('  '.repeat(depth) + leafLabel(n));
        return;
      }
      if (!hasChildText) { // 真叶子(无子文本):span 或纯文本容器,emit 自身
        if (n.tag === 'span') { // span 纯内联文本:当作普通文本,不显示 span 标签
          if (n.text) {
            const head = path.length ? path.join(' > ') : ''; // 有父链则挂父链;无父链(多子父直子)则只留文本
            out.push('  '.repeat(depth) + (head ? head + ' ' : '') + '"' + n.text.slice(0, 60) + '"');
          }
          return;
        }
        // 纯文本容器:保留累积的包装链(div > h1 "标题")
        const line = '  '.repeat(depth) + (path.length ? path.join(' > ') + ' > ' : '') + leafLabel(n);
        out.push(line);
        return;
      }
      // 有子文本的内容容器(如知乎卡片)→ 落到下方共享下钻逻辑
    }
    // 无内容包装 / 有子文本的内容容器
    const kids = n.kids;
    if (!kids.length) return;
    const newPath = path.concat([n.tag]);
    // 按"会产生输出的子"(hasText:有文本/图片 alt)数量折叠,而非子总数:
    //  1 个 → 折叠进链下钻(纯包装单链,如弹幕区的一串 div,省成一行);
    //  0 个 → 整段无语义,省略;
    //  ≥2 → 共享父,先输出共享链,再逐个下钻。
    const productive = kids.filter(k => k.hasText && !isTrivialLeaf(k));
    if (productive.length === 1) { walk(productive[0], depth, newPath); return; }
    if (productive.length >= 2) {
      // 短文本兄弟项(全为内联短项)压成一行:如操作栏按钮组、标签行,省行数提密度
      if (productive.every(inlineable)) {
        const items = productive.map(inlineLabel).join(' ');
        out.push('  '.repeat(depth) + (newPath.length ? newPath.join(' > ') + ' ' : '') + items);
        return;
      }
      if (newPath.length) out.push('  '.repeat(depth) + newPath.join(' > '));
      for (const k of productive) walk(k, depth + 1, []);
    }
    // productive.length === 0:无语义子树,整段省略
  }
  // 根单独输出一行(表示整个 body),子从 path=[] 重新开始(根的 tag 不计入包装链)。
  out.push(tree.tag + (tree.text ? ' "' + tree.text.slice(0, 60) + '"' : ''));
  for (const k of tree.kids) walk(k, 1, []);
  return { ok: true, lines: out };
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
  GEN_SEL, SNAPSHOT_JS, buildTreeExpr, FIND_EL, CLICK_JS, FILL_JS, FOCUS_JS,
  GET_FOCUS_JS, OUTLINE_JS, CONTENT_JS, MONITOR_JS, buildReadExpr,
};
