'use strict';
/**
 * transport.js — 低级 CDP 连接与 target 级原语。
 * 依赖 Node >= 21 自带全局 WebSocket,零 npm 包。仅被 api/monitor/browser 依赖。
 */

const HOST = process.env.CDP_HOST || '127.0.0.1';
const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://${HOST}:${PORT}`;

async function getJson(path) {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`HTTP ${r.status} GET ${path}`);
  return r.json();
}

// 轮询等待的通用 sleep(CLI/daemon 多处复用)。
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// ---- target 发现 / 选择 ----

async function listTargets() {
  const all = await getJson('/json/list');
  // 全局筛掉 DevTools 调试窗(type 也是 page,url 以 devtools:// 开头)。
  // 这样 list/resolve/daemon 全都碰不到它们,`--target xxx` 也不会误配到 DevTools 窗。
  return all.filter(t => t.type === 'page' && !/^devtools:\/\//.test(t.url || ''));
}

function resolveTarget(list, match) {
  if (list.length === 0) throw new Error('浏览器里没有可用的 page tab');
  if (!match) {
    return list.find(t => !/^(about:|edge:\/\/|chrome:\/\/|devtools:)/.test(t.url || '')) || list[0];
  }
  const exact = list.find(t => t.id === match);
  if (exact) return exact;
  const subs = list.filter(t =>
    (t.id || '').includes(match) ||
    (t.url || '').includes(match) ||
    (t.title || '').includes(match)
  );
  // 子串命中多个时优先非 devtools 窗(DevTools 的 url/title 也含目标字符串,常在列表前)。
  const sub = subs.find(t => !/^devtools:\/\//.test(t.url || '')) || subs[0];
  if (sub) return sub;
  throw new Error(`没有找到匹配 "${match}" 的 tab。可用: ${list.map(t => t.id.slice(0, 8) + ':' + (t.title || t.url).slice(0, 30)).join(' | ')}`);
}

// ---- 页面级连接与执行 ----

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

// ---- target 级高层原语(api 与 monitor 共用) ----

/** 在 target 执行 JS,返回 returnByValue 的值。 */
async function evaluate(target, expression, timeout) {
  const ws = await pageWs(target);
  const v = await evalJs(ws, expression, timeout);
  ws.close();
  return v;
}

/** 用 id 或 url/title 子串定位 target;不传则取第一个普通网页。 */
async function resolve(match) {
  return resolveTarget(await listTargets(), match);
}

/** 列出所有 page tab(含手动开的)。 */
async function list() {
  return listTargets();
}

module.exports = {
  HOST, PORT, BASE, getJson, sleep,
  wsConnect, send, attachDispatcher,
  listTargets, resolveTarget, pageWs, browserWs, evalJs,
  evaluate, resolve, list,
};
