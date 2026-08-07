#!/usr/bin/env node
/**
 * cdp.js — 通过 Chrome DevTools Protocol (CDP) 控制本地浏览器的零依赖脚本。
 *
 * 取代 chrome-devtools-mcp:直接连 CDP 9222,能操作"手动开的 tab"(
 * MCP 会漏看的那种)。依赖 Node >= 21 自带全局 WebSocket,无需任何 npm 包。
 *
 * 两种用法:
 * 1) 单命令(适合快速探页面 / 单步操作):
 *    node cdp.js list
 *    node cdp.js open <url>
 *    node cdp.js close <target>
 *    node cdp.js navigate <url> [--target <匹配>]
 *    node cdp.js eval "<js>" [--target <匹配>]
 *    node cdp.js snapshot [--target <匹配>]
 *    node cdp.js click <selector> [--target <匹配>]
 *    node cdp.js fill <selector> <值> [--target <匹配>]
 *    node cdp.js shot [--file out.png] [--target <匹配>]
 *
 * 2) 脚本批处理(推荐做自动化——一次连接、按序执行,避免多次模型往返):
 *    node cdp.js run ./auto.js
 *    脚本里直接用全局 `cdp` API,可写循环/条件/等待:
 *       await cdp.navigate(t, url); await cdp.waitFor(t, sel); await cdp.click(t, sel);
 *
 * <匹配> 可以是 /json/list 里的 target id,也可以是 url 或 title 的子串。
 * 不指定 --target 时,自动选第一个普通网页(跳过 about:/edge:///chrome:// 等)。
 */
'use strict';

const HOST = process.env.CDP_HOST || '127.0.0.1';
const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://${HOST}:${PORT}`;

// ==================== 低级工具:HTTP + WebSocket ====================

async function getJson(path) {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`HTTP ${r.status} GET ${path}`);
  return r.json();
}

function wsConnect(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { return reject(new Error(`创建 WebSocket 失败: ${e.message}`)); }
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`连接超时: ${url}`)); }, timeout);
    ws.onopen = () => { clearTimeout(t); resolve(ws); };
    ws.onerror = () => { clearTimeout(t); reject(new Error(`WebSocket 连接失败: ${url}`)); };
  });
}

let seq = 0;
const pending = new Map();

function attachDispatcher(ws, onEvent) {
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    // 事件消息没有 id(Runtime.consoleAPICalled / exceptionThrown / Log.entryAdded 等)。
    // 单命令场景不传 onEvent,事件照旧忽略;监听 daemon 传入回调收集日志。
    if (msg.id === undefined) {
      if (onEvent) { try { onEvent(msg.method, msg.params); } catch {} }
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`${p.method} → ${msg.error.message}`));
    else p.resolve(msg.result);
  };
}

function send(ws, method, params = {}, timeout = 20000) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`命令超时: ${method}`)); }, timeout);
    pending.set(id, { resolve, reject, timer, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// ==================== target 发现 / 选择 ====================

async function listTargets() {
  const all = await getJson('/json/list');
  return all.filter(t => t.type === 'page');
}

function resolveTarget(list, match) {
  if (list.length === 0) throw new Error('浏览器里没有可用的 page tab');
  if (!match) {
    return list.find(t => !/^(about:|edge:\/\/|chrome:\/\/|devtools:)/.test(t.url || '')) || list[0];
  }
  const exact = list.find(t => t.id === match);
  if (exact) return exact;
  const sub = list.find(t =>
    (t.id || '').includes(match) ||
    (t.url || '').includes(match) ||
    (t.title || '').includes(match)
  );
  if (sub) return sub;
  throw new Error(`没有找到匹配 "${match}" 的 tab。可用: ${list.map(t => t.id.slice(0, 8) + ':' + (t.title || t.url).slice(0, 30)).join(' | ')}`);
}

// ==================== 页面级连接与执行 ====================

async function pageWs(target, onEvent) {
  if (!target.webSocketDebuggerUrl) throw new Error('该 target 没有调试地址');
  const ws = await wsConnect(target.webSocketDebuggerUrl);
  attachDispatcher(ws, onEvent);
  return ws;
}

async function browserWs() {
  const v = await getJson('/json/version');
  const ws = await wsConnect(v.webSocketDebuggerUrl);
  attachDispatcher(ws);
  return ws;
}

async function evalJs(ws, expression, timeout = 20000) {
  const r = await send(ws, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  }, timeout);
  if (r.exceptionDetails) {
    const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
    throw new Error(`页面执行出错: ${desc}`);
  }
  return r.result?.value;
}

// ==================== 内置页面脚本 ====================

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

const CLICK_JS = (sel) => `
(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return { ok: false, err: '未找到: ' + ${JSON.stringify(sel)} };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.click();
  return { ok: true, tag: el.tagName.toLowerCase() };
})()`;

const FILL_JS = (sel, value) => `
(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return { ok: false, err: '未找到: ' + ${JSON.stringify(sel)} };
  if (!['input','textarea','select','[contenteditable=true]'].some(x => el.matches(x))) return { ok:false, err:'不是输入元素: '+el.tagName };
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
             : el.tagName === 'INPUT' ? HTMLInputElement.prototype
             : HTMLElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, tag: el.tagName.toLowerCase() };
})()`;

const FOCUS_JS = (sel) => `
(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return { ok: false, err: '未找到: ' + ${JSON.stringify(sel)} };
  el.focus();
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

// ==================== 高层操作 API(CLI 和脚本共用) ====================

/**
 * 列出所有 page tab(含手动开的)。
 * @returns {Promise<Array>} [{id,title,url,webSocketDebuggerUrl,...}]
 */
async function list() {
  return listTargets();
}

/**
 * 用 id 或 url/title 子串定位 target;不传则取第一个普通网页。
 */
async function resolve(match) {
  return resolveTarget(await listTargets(), match);
}

/**
 * 新开一个 tab,返回 targetId。
 */
async function open(url = 'about:blank') {
  const ws = await browserWs();
  const { targetId } = await send(ws, 'Target.createTarget', { url, newWindow: false });
  ws.close();
  maybeSpawnDaemon(); // 打开页面即自动种上控制台监听(异步、失败不阻塞)
  return targetId;
}

/**
 * 关闭 target。
 */
async function close(target) {
  const ws = await browserWs();
  await send(ws, 'Target.closeTarget', { targetId: target.id });
  ws.close();
}

/**
 * 导航 target 到 url。
 */
async function navigate(target, url) {
  const ws = await pageWs(target);
  await send(ws, 'Page.navigate', { url });
  ws.close();
}

/**
 * 在 target 执行 JS,返回 returnByValue 的值。
 */
async function evaluate(target, expression, timeout) {
  const ws = await pageWs(target);
  const v = await evalJs(ws, expression, timeout);
  ws.close();
  return v;
}

/**
 * 提取 target 页面可交互元素清单。
 */
async function snapshot(target) {
  return evaluate(target, SNAPSHOT_JS, 30000);
}

/**
 * 点击 target 页面上匹配 selector 的元素。
 */
async function click(target, selector) {
  const r = await evaluate(target, CLICK_JS(selector));
  if (!r?.ok) throw new Error(r?.err || '点击失败');
  return r;
}

/**
 * 向 target 页面输入框填值(派发 input/change)。
 */
async function fill(target, selector, value) {
  const r = await evaluate(target, FILL_JS(selector, value));
  if (!r?.ok) throw new Error(r?.err || '填充失败');
  return r;
}

/**
 * 等 target 页面上出现匹配 selector 的元素(轮询),超时抛错。
 */
async function waitFor(target, selector, { timeout = 15000, interval = 300 } = {}) {
  const ws = await pageWs(target);
  const start = Date.now();
  try {
    while (true) {
      const found = await evalJs(ws, `!!document.querySelector(${JSON.stringify(selector)})`);
      if (found) return true;
      if (Date.now() - start > timeout) throw new Error(`等待超时( ${timeout}ms ): ${selector}`);
      await new Promise(r => setTimeout(r, interval));
    }
  } finally {
    ws.close();
  }
}

/**
 * 轮询执行 JS 布尔表达式直到返回真值,超时抛错。用于"等状态/等结果"(如等元素出现后
 * 又变化、等某条件达成),而 waitFor 只等元素出现。例:
 *   await cdp.waitForFn(t, `document.querySelector('#btn')?.disabled === false`);
 */
async function waitForFn(target, expression, { timeout = 15000, interval = 300 } = {}) {
  const ws = await pageWs(target);
  const start = Date.now();
  try {
    while (true) {
      const v = await evalJs(ws, `Boolean(${expression})`);
      if (v) return true;
      if (Date.now() - start > timeout) throw new Error(`等待超时( ${timeout}ms ): ${expression}`);
      await new Promise(r => setTimeout(r, interval));
    }
  } finally {
    ws.close();
  }
}

/**
 * 截图 target 页面到文件,返回文件路径。
 */
async function shot(target, file) {
  const ws = await pageWs(target);
  const r = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  ws.close();
  if (!r.data) throw new Error('截图失败:无数据');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const out = file || `shot_${Date.now()}.png`;
  fs.writeFileSync(path.resolve(out), Buffer.from(r.data, 'base64'));
  return out;
}

/**
 * 聚焦 target 页面上匹配 selector 的元素。
 */
async function focus(target, selector) {
  const r = await evaluate(target, FOCUS_JS(selector));
  if (!r?.ok) throw new Error(r?.err || '聚焦失败');
  return r;
}

/**
 * 返回 target 页面当前焦点元素(document.activeElement)信息,无焦点返回 null。
 */
async function getFocus(target) {
  return evaluate(target, GET_FOCUS_JS);
}

/**
 * 提取 target 页面大纲:标题层级(h1-h6)+ 关键链接。
 */
async function outline(target) {
  return evaluate(target, OUTLINE_JS);
}

/**
 * 提取 target 页面主内容文本(去导航/页脚/表单,截断)。
 */
async function content(target) {
  return evaluate(target, CONTENT_JS, 30000);
}

// 键名 → CDP key/code/虚拟键码
const KEYMAP = {
  enter: { key: 'Enter', code: 'Enter', kc: 13 }, tab: { key: 'Tab', code: 'Tab', kc: 9 },
  escape: { key: 'Escape', code: 'Escape', kc: 27 }, backspace: { key: 'Backspace', code: 'Backspace', kc: 8 },
  'delete': { key: 'Delete', code: 'Delete', kc: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', kc: 38 }, arrowdown: { key: 'ArrowDown', code: 'ArrowDown', kc: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', kc: 37 }, arrowright: { key: 'ArrowRight', code: 'ArrowRight', kc: 39 },
  home: { key: 'Home', code: 'Home', kc: 36 }, end: { key: 'End', code: 'End', kc: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', kc: 33 }, pagedown: { key: 'PageDown', code: 'PageDown', kc: 34 },
  space: { key: ' ', code: 'Space', kc: 32 }, f5: { key: 'F5', code: 'F5', kc: 116 },
};
function parseKeySpec(spec) {
  const parts = String(spec).toLowerCase().split('+').map(s => s.trim()).filter(Boolean);
  let modifiers = 0, main = '';
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') modifiers |= 2;
    else if (p === 'shift') modifiers |= 8;
    else if (p === 'alt') modifiers |= 1;
    else if (p === 'meta' || p === 'win' || p === 'cmd') modifiers |= 4;
    else main = p;
  }
  if (!main) throw new Error('按键描述缺少主键,如 Ctrl+A / Enter');
  if (main.length === 1) {
    const up = main.toUpperCase();
    const kc = main === ' ' ? 32 : up.charCodeAt(0);
    const code = main === ' ' ? 'Space' : /[0-9]/.test(main) ? 'Digit' + main : /[A-Z]/.test(up) ? 'Key' + up : 'Unknown';
    return { key: main === ' ' ? ' ' : up, code, kc, modifiers };
  }
  const m = KEYMAP[main];
  if (m) return { ...m, modifiers };
  throw new Error(`未知按键: ${main}(支持 Ctrl/Shift/Alt 组合,如 Ctrl+Shift+A;功能键: Enter/Tab/Escape/Arrow/Home/F5 等)`);
}

/**
 * 在 target 页面按真实键盘事件(组合键用 Ctrl+Shift+A 写法)。
 */
async function pressKey(target, keySpec) {
  const { key, code, kc, modifiers } = parseKeySpec(keySpec);
  const ws = await pageWs(target);
  await send(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers });
  await send(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers });
  ws.close();
}

/**
 * 将鼠标移到 target 页面指定元素中心(触发 mouseover/mouseenter)。
 */
async function hover(target, selector) {
  const pos = await evaluate(target, `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return null; el.scrollIntoView({block:'center',behavior:'instant'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; })()`);
  if (!pos) throw new Error('未找到: ' + selector);
  const ws = await pageWs(target);
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  ws.close();
}

// ==================== 控制台监听(常驻 daemon) ====================
// 读控制台日志本质是"推式 + 长连接":要收到 Runtime.consoleAPICalled / exceptionThrown /
// Log.entryAdded 事件,必须有一条活着的 WebSocket 连着 page target 且发过 Runtime.enable。
// 每次 node cdp.js xxx 是独立进程、跑完即退,所以跨 agent 回合 / 刷新存活 / 自动补种
// 都要求一个常驻后台进程(listen daemon)持续持有 WS、缓冲事件,agent 读时查它的 HTTP 接口。
// 关键:CDP 事件挂在 target 上,Runtime.enable 在同一 target 刷新后保持 → 刷新存活天然成立。

const LOGS_PORT = Number(process.env.CDP_LOGS_PORT) || 9333;

// CDP RemoteObject → 可安全 JSON 的普通值(节点/函数/循环引用降级为描述文本)。
function serializeRemoteArg(ro) {
  if (ro == null) return null;
  if (ro.type === 'string' || ro.type === 'number' || ro.type === 'boolean') return ro.value;
  if (ro.type === 'undefined') return undefined;
  if (ro.type === 'object' && ro.subtype === 'null') return null;
  const d = typeof ro.description === 'string' ? ro.description : '';
  return d.length > 500 ? d.slice(0, 500) + '…' : d;
}

async function spawnDaemon() {
  const { spawn } = await import('node:child_process');
  const script = process.argv[1] || __filename;
  const child = spawn(process.execPath, [script, 'listen'], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function daemonHealthy(port = LOGS_PORT) {
  try { const r = await fetch(`http://127.0.0.1:${port}/health`); return r.ok; } catch { return false; }
}

// 异步确保 daemon 在跑(打开页面时自动种监听;失败不阻塞主流程)。
async function maybeSpawnDaemon() {
  try { await ensureDaemon(); } catch {}
}

async function ensureDaemon(port = LOGS_PORT) {
  if (await daemonHealthy(port)) return port;
  await spawnDaemon();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    await new Promise(r => setTimeout(r, 300));
    if (await daemonHealthy(port)) return port;
  }
  throw new Error('监听 daemon 启动失败');
}

async function daemonGetJson(port, path) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!r.ok) throw new Error(`监听 daemon HTTP ${r.status}: ${path}`);
  return r.json();
}

async function pidFilePath() {
  const os = await import('node:os');
  const path = await import('node:path');
  return path.join(os.tmpdir(), 'cdp-listen.pid');
}

/**
 * 常驻监听主体(listen 子命令)。持有到各 page target 的 WS + Runtime/Log.enable,缓冲
 * 控制台事件,暴露本地 HTTP 接口供 logs 查询。轮询 /json/list 自动 attach 新 tab(含
 * 手动开的)与刷新后的同 target(WS 不断、enable 保持 → 事件继续进来)。
 */
async function cmdListen() {
  const http = await import('node:http');
  const fs = await import('node:fs');
  const path = await import('node:path');

  const buffers = new Map(); // targetId -> { target, entries:[], listeningSince }
  const attached = new Map(); // targetId -> ws

  function handleEvent(target, method, params) {
    const b = buffers.get(target.id);
    if (!b) return;
    let entry = null;
    if (method === 'Runtime.consoleAPICalled') {
      entry = {
        ts: Date.now(), targetId: target.id, url: target.url, title: target.title,
        type: 'console', level: (params.type || 'log').toLowerCase(),
        args: (params.args || []).map(serializeRemoteArg),
      };
    } else if (method === 'Runtime.exceptionThrown') {
      const ed = params.exceptionDetails || {};
      const ex = ed.exception?.description || ed.text || '';
      entry = {
        ts: Date.now(), targetId: target.id, url: target.url, title: target.title,
        type: 'exception', level: 'error',
        args: [String(ex).slice(0, 2000)], line: ed.lineNumber, col: ed.columnNumber,
      };
    } else if (method === 'Log.entryAdded') {
      const e = params.entry || {};
      entry = {
        ts: (e.timestamp || Date.now()), targetId: target.id, url: target.url, title: target.title,
        type: 'browser', level: (e.level || '').toLowerCase(),
        args: [String(e.text || '').slice(0, 2000)], source: e.source,
      };
    }
    if (!entry) return;
    b.entries.push(entry);
    if (b.entries.length > 2000) b.entries.splice(0, b.entries.length - 2000);
  }

  async function attach(target) {
    let ws;
    try { ws = await pageWs(target, (m, p) => handleEvent(target, m, p)); } catch { return; }
    attached.set(target.id, ws);
    ws.onclose = () => attached.delete(target.id); // 断了下轮重连,缓冲保留
    if (!buffers.has(target.id)) buffers.set(target.id, { target, entries: [], listeningSince: Date.now() });
    try { await send(ws, 'Runtime.enable', {}, 5000); await send(ws, 'Log.enable', {}, 5000); } catch {}
  }

  async function syncAttach() {
    let list;
    try { list = await listTargets(); } catch { return; }
    for (const t of list) if (!attached.has(t.id)) await attach(t);
  }

  function applyFilter(entries, levelSet, since) {
    let out = entries.filter(e => e.ts >= since);
    if (levelSet) out = out.filter(e => levelSet.includes(e.level));
    else out = out.filter(e => e.type !== 'browser'); // 默认排除浏览器级噪音
    return out;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${LOGS_PORT}`);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    const send = (code, obj) => { res.statusCode = code; res.end(JSON.stringify(obj)); };
    try {
      if (url.pathname === '/health') return send(200, { ok: true, targets: buffers.size });
      if (url.pathname === '/shutdown') { fs.unlinkSync(await pidFilePath()); server.close(); process.exit(0); }
      if (url.pathname === '/logs') {
        const match = url.searchParams.get('target');
        const levelSet = url.searchParams.get('level')?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) || null;
        const since = Number(url.searchParams.get('since')) || 0;
        let list = [];
        try { list = await listTargets(); } catch {}
        let target = null;
        if (match) { try { target = resolveTarget(list, match); } catch {} }
        else target = list.find(t => !/^(about:|edge:\/\/|chrome:\/\/|devtools:)/.test(t.url || '')) || list[0] || null;
        if (!target) return send(200, { entries: [], targets: list.map(t => ({ id: t.id, title: t.title, url: t.url })), note: '没有匹配的 target' });
        // 自动补种:手动开的 tab 尚未 attach → 现在就种上(只能从此刻起捕获)
        if (!attached.has(target.id)) await attach(target);
        const b = buffers.get(target.id) || { target, entries: [], listeningSince: Date.now() };
        return send(200, {
          target: { id: target.id, title: target.title, url: target.url },
          listeningSince: b.listeningSince ?? null,
          entries: applyFilter(b.entries, levelSet, since),
        });
      }
      return send(404, { error: 'unknown route' });
    } catch (err) {
      send(500, { error: err.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(LOGS_PORT, '127.0.0.1', resolve);
  });
  await syncAttach();
  setInterval(() => { syncAttach().catch(() => {}); }, 500);
  fs.writeFileSync(await pidFilePath(), String(process.pid));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  console.error(`监听 daemon 就绪 :${LOGS_PORT},attached=${buffers.size}`);
}

/**
 * 读 target 的控制台日志(走 daemon HTTP,带自动补种)。脚本模式用。
 * @param {object|string} target target 对象或 id/url/title 子串
 * @param {{level?:string, since?:number}} [opts] level 逗号分隔;since 毫秒时间戳
 * @returns {Promise<Array>} 日志条目
 */
async function logs(target, opts = {}) {
  const port = await ensureDaemon();
  const id = typeof target === 'object' ? (target.id || target) : target;
  const qs = new URLSearchParams();
  if (id !== undefined && id !== null) qs.set('target', String(id));
  if (opts.level) qs.set('level', opts.level);
  if (opts.since) qs.set('since', String(opts.since));
  const d = await daemonGetJson(port, '/logs?' + qs);
  return d.entries || [];
}

// ---- 确保浏览器打开(小白场景:自动探测默认浏览器并启动 CDP) ----

async function isBrowserReady() {
  try {
    const v = await getJson('/json/version');
    return !!(v && v.webSocketDebuggerUrl);
  } catch { return false; }
}

async function findBrowserExe() {
  const { existsSync } = await import('node:fs');
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA || ''}/Microsoft/Edge/Application/msedge.exe`,
    `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
  ];
  return cands.find(p => existsSync(p)) || null;
}

function browserNameFromExe(exe) {
  if (!exe) return '未知浏览器';
  if (/Edge/i.test(exe)) return 'Microsoft Edge';
  if (/Chrome/i.test(exe)) return 'Google Chrome';
  return exe;
}

// 热启动时浏览器非本次启动,exe 拿不到;从 /json/version 的 Browser 字段推断浏览器名(如 "Edg/127"/"Chrome/126")。
async function probeBrowserName() {
  try {
    const v = await getJson('/json/version');
    const b = (v && v.Browser) || '';
    if (/Edg\//i.test(b)) return `Microsoft Edge (${b})`;
    if (/Chrome\//i.test(b)) return `Google Chrome (${b})`;
    return b || '未知浏览器';
  } catch { return '未知浏览器'; }
}

/**
 * 确保有 CDP 浏览器在跑。没有则自动探测 Edge/Chrome 并用独立用户数据目录启动(不干扰用户平时浏览器)。
 * @param {string} [url] 可选:浏览器就绪后打开该 url
 * @returns {Promise<{ready:boolean, started:boolean, browser?:string, userData?:string, url?:string, targetId?:string}>}
 *   started=true 冷启动(本次启动);false 热启动(浏览器本就就绪,exe/userData 无法可靠获取)。
 */
async function ensureBrowser(url) {
  let started = false;
  let exe = null;
  let userData = null;
  if (!(await isBrowserReady())) {
    exe = await findBrowserExe();
    if (!exe) throw new Error('未找到可用的 Edge/Chrome,请手动用 --remote-debugging-port 启动浏览器');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    userData = process.env.CDP_USER_DATA || path.join(os.homedir(), '.cdp-browser');
    fs.mkdirSync(userData, { recursive: true });
    const { spawn } = await import('node:child_process');
    const child = spawn(exe, [
      `--remote-debugging-port=${PORT}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${userData}`,
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    started = true;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      await new Promise(r => setTimeout(r, 500));
      if (await isBrowserReady()) break;
    }
    if (!(await isBrowserReady())) throw new Error('浏览器启动超时,请检查(或手动打开一个 Edge/Chrome)');
  }
  const browser = started ? browserNameFromExe(exe) : await probeBrowserName();
  const res = { ready: true, started, browser, userData }; // 热启动时 browser 从 /json/version 推断,userData 为 null
  if (url) {
    let targetId;
    if (started) {
      // 冷启动:本次由 ensure 启动的浏览器自带一个空白首 tab,直接导航它,不再 open 新开(避免留多余空 tab)。
      const pages = await listTargets();
      const first = resolveTarget(pages, undefined); // 取第一个普通网页
      await navigate(first, url);
      targetId = first.id;
    } else {
      // 热启动:浏览器已就绪,新开一个 tab 放链接,不覆盖用户现有页面。
      targetId = await open(url);
    }
    res.url = url;
    res.targetId = targetId;
    maybeSpawnDaemon(); // 打开页面即自动种上控制台监听
  }
  return res;
}

const api = { list, resolve, open, close, navigate, eval: evaluate, snapshot, click, fill, waitFor, waitForFn, shot, focus, getFocus, outline, content, pressKey, hover, logs, ensure: ensureBrowser };

// ==================== CLI ====================

function parseArgs(argv) {
  const args = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target' || a === '--file' || a === '--url' || a === '--level' || a === '--since') opts[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) opts[a.slice(2)] = true;
    else args.push(a);
  }
  return { args, opts };
}

async function main() {
  const { args, opts } = parseArgs(process.argv.slice(2));
  const cmd = args.shift();

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`用法: node cdp.js <子命令> [参数]
  ensure [--url <url>]     确保浏览器已打开(自动探测 Edge/Chrome 启动 CDP),可选 --url 直接导航
  list                     列出所有 page tab(含手动开的)
  open <url>               新开一个 tab
  close <target>           关闭 tab
  navigate <url> [--target]导航到 url
  eval "<js>" [--target]   在页面执行 JS,返回 JSON 值
  snapshot [--target]      提取可交互元素清单(标签/文本/选择器/坐标)
  click <selector> [--target] 点击元素
  fill <selector> <值> [--target] 填入输入框并触发 input/change
  focus <selector> [--target] 聚焦元素(配合按键用)
  get_focus [--target]   查看当前焦点元素在哪
  press_key <键> [--target] 按键/组合键,如 Enter、Ctrl+Shift+A、Tab
  hover <selector> [--target] 鼠标移到元素上(触发 mouseover)
  outline [--target]     页面大纲:标题层级 + 关键链接
  content [--target]     提取主内容文本(去导航/页脚,截断)
  shot [--file out.png] [--target] 截图
  logs [--target] [--level error,warn] [--since <ms>] [--json]
                         读 target 控制台日志(常驻 daemon,支持过滤;自动补种)
  listen                 启动/前台运行控制台监听 daemon(常驻后台,一般不手动调)
  listen-stop            停止控制台监听 daemon
  run <脚本文件>         执行自动化脚本(脚本里用全局 cdp API,可循环/等待)
环境变量: CDP_HOST / CDP_PORT(默认 127.0.0.1:9222)
         CDP_LOGS_PORT(监听 daemon 端口,默认 9333)
<匹配>: target id,或 url/title 子串;不传则自动选第一个普通网页`);
    return;
  }

  // run:执行脚本文件(把 cdp API 注入全局,包装成 async,支持顶层 await)
  if (cmd === 'run') {
    const file = args[0];
    if (!file) throw new Error('run 需要脚本文件路径');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const abs = path.resolve(file);
    const code = fs.readFileSync(abs, 'utf8');
    global.cdp = api;
    const fn = new Function('cdp', `return (async () => {\n${code}\n})();`);
    await fn(api);
    return;
  }

  if (cmd === 'ensure') {
    const r = await api.ensure(opts.url);
    const lines = [];
    lines.push(r.started ? '模式: 冷启动(本次由 ensure 启动浏览器)' : '模式: 热启动(浏览器本就已通过 CDP 就绪)');
    lines.push(`浏览器: ${r.browser || '未知'}`);
    lines.push(r.userData
      ? `用户数据目录: ${r.userData}`
      : `用户数据目录: 未知(浏览器非本次启动,可设环境变量 CDP_USER_DATA 指定)`);
    if (r.url) { lines.push(`已打开: ${r.url}`); lines.push(`targetId: ${r.targetId}`); }
    else lines.push('已连接: 未导航');
    console.log(lines.join('\n'));
    return;
  }

  if (cmd === 'list') {
    const list = await api.list();
    if (list.length === 0) { console.log('(没有 page tab)'); return; }
    const line = t => `${t.id}  ${t.title || '(无标题)'}  ${t.url}`;
    console.log(list.map((t, i) => `${i + 1}. ${line(t)}`).join('\n'));
    return;
  }

  if (cmd === 'open') {
    const url = args[0] || 'about:blank';
    const tid = await api.open(url);
    console.log(`已打开: ${url}\ntargetId: ${tid}`);
    return;
  }
  if (cmd === 'close') {
    const t = await api.resolve(args[0]);
    await api.close(t);
    console.log(`已关闭: ${t.title || t.url}`);
    return;
  }

  if (cmd === 'listen') { await cmdListen(); return; } // 常驻,不会返回

  if (cmd === 'listen-stop') {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    // 优雅关闭:daemon 在发响应前 process.exit,response 被截断 reject 也算成功发起。
    try { await fetch(`http://127.0.0.1:${LOGS_PORT}/shutdown`, { method: 'POST' }); } catch {}
    let stopped = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      if (!(await daemonHealthy(LOGS_PORT))) { stopped = true; break; }
      await new Promise(r => setTimeout(r, 200));
    }
    if (!stopped) { // 优雅关闭未生效 → 杀 pid 兜底
      const pf = path.join(os.tmpdir(), 'cdp-listen.pid');
      if (fs.existsSync(pf)) {
        const pid = Number(fs.readFileSync(pf, 'utf8'));
        try { process.kill(pid); stopped = true; } catch {}
        try { fs.unlinkSync(pf); } catch {}
      }
    }
    console.log(stopped ? '已停止监听 daemon' : '未发现运行中的监听 daemon');
    return;
  }

  if (cmd === 'logs') {
    const port = await ensureDaemon();
    const qs = new URLSearchParams();
    if (opts.target) qs.set('target', opts.target);
    if (opts.level) qs.set('level', opts.level);
    if (opts.since) qs.set('since', opts.since);
    const d = await daemonGetJson(port, '/logs?' + qs);
    const entries = d.entries || [];
    if (opts.json) { console.log(JSON.stringify(entries, null, 2)); return; }
    if (entries.length === 0) {
      console.log(`(无控制台日志${d.target ? ' · ' + d.target.title : ''})`);
      if (d.note) console.log(d.note);
      return;
    }
    console.log(`→ ${d.target?.title || ''} ${d.target?.url || ''}`);
    for (const e of entries) {
      const t = new Date(e.ts).toTimeString().slice(0, 8);
      const loc = (e.line != null) ? ` (${e.line}:${e.col ?? ''})` : '';
      console.log(`[${t}][${e.level}] ${e.args.map(a => a == null ? 'undefined' : String(a)).join(' ')}${loc}`);
    }
    return;
  }

  const target = await api.resolve(opts.target);
  console.error(`→ target: ${target.title || ''} ${target.url}`);

  switch (cmd) {
    case 'navigate': {
      const url = args[0];
      if (!url) throw new Error('navigate 需要 url');
      await api.navigate(target, url);
      console.log(`已导航到: ${url}`);
      break;
    }
    case 'eval': {
      const js = args.join(' ');
      if (!js) throw new Error('eval 需要要执行的 JS');
      console.log(JSON.stringify(await api.eval(target, js), null, 2));
      break;
    }
    case 'snapshot': {
      const value = await api.snapshot(target);
      if (!Array.isArray(value) || value.length === 0) { console.log('(没有可交互元素)'); break; }
      console.log(value.map((e, i) =>
        `${i + 1}. [${e.tag}] "${e.text || e.placeholder || ''}"  ${e.href ? e.href : ''}  sel=${e.selector}`
      ).join('\n'));
      break;
    }
    case 'click': {
      const sel = args[0];
      if (!sel) throw new Error('click 需要 selector');
      const r = await api.click(target, sel);
      console.log(`已点击: ${sel} (${r.tag})`);
      break;
    }
    case 'fill': {
      const sel = args[0], val = args[1];
      if (!sel || val === undefined) throw new Error('fill 需要 selector 和 值');
      await api.fill(target, sel, val);
      console.log(`已填入: ${sel} ← ${val}`);
      break;
    }
    case 'focus': {
      const sel = args[0];
      if (!sel) throw new Error('focus 需要 selector');
      const r = await api.focus(target, sel);
      console.log(`已聚焦: ${sel} (${r.tag})`);
      break;
    }
    case 'get_focus': {
      const f = await api.getFocus(target);
      if (!f) { console.log('(当前无焦点元素)'); break; }
      console.log(`焦点在: [${f.tag}] "${f.text || ''}" ${f.id ? '#' + f.id : ''} sel=${f.selector}`);
      break;
    }
    case 'press_key': {
      const key = args[0];
      if (!key) throw new Error('press_key 需要按键,如 Enter、Ctrl+Shift+A');
      await api.pressKey(target, key);
      console.log(`已按键: ${key}`);
      break;
    }
    case 'hover': {
      const sel = args[0];
      if (!sel) throw new Error('hover 需要 selector');
      await api.hover(target, sel);
      console.log(`已悬停: ${sel}`);
      break;
    }
    case 'outline': {
      const o = await api.outline(target);
      console.log(`标题: ${o.title}\nURL: ${o.url}\n`);
      console.log('— 标题层级 —');
      console.log(o.headings.map(h => '  '.repeat(Math.max(0, h.level - 1)) + `H${h.level}: ${h.text}  sel=${h.selector}`).join('\n') || '(无标题)');
      console.log('\n— 关键链接 —');
      console.log(o.links.map((l, i) => `${i + 1}. ${l.text}  ${l.href}`).join('\n') || '(无)');
      break;
    }
    case 'content': {
      const c = await api.content(target);
      console.log(`标题: ${c.title}\nURL: ${c.url}\n`);
      console.log(c.text || '(无正文)');
      break;
    }
    case 'shot': {
      const file = await api.shot(target, opts.file);
      console.log(`已截图: ${file}`);
      break;
    }
    default:
      throw new Error(`未知命令: ${cmd}(用 node cdp.js help 看用法)`);
  }
}

// 作为模块被 require 时导出 API;作为脚本运行时走 CLI
if (require.main === module) {
  main().catch(err => { console.error(`错误: ${err.message}`); process.exit(1); });
} else {
  module.exports = api;
}
