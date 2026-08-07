'use strict';
/**
 * api.js — 高层页面操作 API(CLI 与 run 脚本共用)。
 * 依赖 transport(连接)+ scripts(页面脚本)+ monitor(maybeSpawnDaemon)。
 * 不包含 logs/ensure(分别在 monitor/browser),由 cdp.js 入口组装为最终 api 对象。
 */

const { pageWs, browserWs, send, evalJs, evaluate, resolve, list, sleep } = require('./transport');
const { SNAPSHOT_JS, buildTreeExpr, buildAtExpr, CLICK_JS, FILL_JS, FOCUS_JS, GET_FOCUS_JS, OUTLINE_JS, CONTENT_JS } = require('./scripts');
const { maybeSpawnDaemon, injectMonitor } = require('./monitor');

/** 新开一个 tab,返回 targetId。 */
async function open(url = 'about:blank') {
  const ws = await browserWs();
  const { targetId } = await send(ws, 'Target.createTarget', { url, newWindow: false });
  ws.close();
  // 同步直接注入监控(不等 daemon 0.5-2s 轮询),让 open 返回后立刻可打日志/读。
  maybeSpawnDaemon(); // 同时拉起 daemon,补持久 WS 会话(刷新存活靠它)
  try {
    const t = await resolve(targetId);
    await injectMonitor(t);
  } catch {}
  return targetId;
}

/** 关闭 target。 */
async function close(target) {
  const ws = await browserWs();
  await send(ws, 'Target.closeTarget', { targetId: target.id });
  ws.close();
}

/** 导航 target 到 url。 */
async function navigate(target, url) {
  const ws = await pageWs(target);
  await send(ws, 'Page.navigate', { url });
  ws.close();
}

/** 提取 target 页面可交互元素清单。 */
async function snapshot(target) {
  return evaluate(target, SNAPSHOT_JS, 30000);
}

/**
 * 子树钻取:把 target 页面匹配 selector 的元素 DOM 子树输出为紧凑简化 HTML 树。
 * 感知主命令——唯一感知入口。
 * 无 selector 也无 --at 时:树整页 body 的简化 HTML 树,按视口范围(中心上下各一个视口高)筛选。
 * opts:{maxClass(默认2), out 排除区域, vp 视口过滤(默认true,false=全部),
 *       vm 纵向余量(默认1,中心上下各 N 个视口高), at 坐标锚定(center|x,y|相对比例,取该屏点最顶层元素),
 *       vis selector 多匹配取视口内那个}。
 */
async function tree(target, selector, opts = {}) {
  let sel = selector;
  if (opts.at) { // 坐标锚定:用 elementFromPoint 解析屏幕点 → 树其"最近语义容器"
    const hit = await evaluate(target, buildAtExpr(opts.at), 30000);
    if (!hit?.selector) throw new Error(`--at 坐标点(${opts.at})无可解析元素`);
    sel = hit.selector;
  } else if (!sel) { // 无参 → 整页 body 的简化 HTML 树,视口中心上下各 N 视口高筛选
    sel = 'body';
  }
  const r = await evaluate(target, buildTreeExpr(sel, opts.maxClass, opts.out, opts.vp, opts.vm, opts.vis), 30000);
  if (!r?.ok) throw new Error(r?.err || 'tree 失败');
  return r;
}

/** 点击 target 页面上匹配 selector 的元素。 */
async function click(target, selector) {
  const r = await evaluate(target, CLICK_JS(selector));
  if (!r?.ok) throw new Error(r?.err || '点击失败');
  return r;
}

/** 向 target 页面输入框填值(派发 input/change)。 */
async function fill(target, selector, value) {
  const r = await evaluate(target, FILL_JS(selector, value));
  if (!r?.ok) throw new Error(r?.err || '填充失败');
  return r;
}

// 共享轮询原语:反复 eval 一段 JS 布尔表达式直到真值或超时。desc 用于超时报错文案。
async function pollWait(target, expression, desc, { timeout = 15000, interval = 300 } = {}) {
  const ws = await pageWs(target);
  const start = Date.now();
  try {
    while (true) {
      const v = await evalJs(ws, `Boolean(${expression})`);
      if (v) return true;
      if (Date.now() - start > timeout) throw new Error(`等待超时( ${timeout}ms ): ${desc}`);
      await sleep(interval);
    }
  } finally {
    ws.close();
  }
}

/** 等 target 页面上出现匹配 selector 的元素(轮询),超时抛错。 */
async function waitFor(target, selector, opts = {}) {
  return pollWait(target, `!!document.querySelector(${JSON.stringify(selector)})`, selector, opts);
}

/** 轮询执行 JS 布尔表达式直到返回真值,超时抛错。例: cdp.waitForFn(t, `document.querySelector('#btn')?.disabled === false`)。 */
async function waitForFn(target, expression, opts = {}) {
  return pollWait(target, expression, expression, opts);
}

/** 截图 target 页面到文件,返回文件路径。 */
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

/** 聚焦 target 页面上匹配 selector 的元素。 */
async function focus(target, selector) {
  const r = await evaluate(target, FOCUS_JS(selector));
  if (!r?.ok) throw new Error(r?.err || '聚焦失败');
  return r;
}

/** 返回 target 页面当前焦点元素(document.activeElement)信息,无焦点返回 null。 */
async function getFocus(target) {
  return evaluate(target, GET_FOCUS_JS);
}

/** 提取 target 页面大纲:标题层级(h1-h6)+ 关键链接。 */
async function outline(target) {
  return evaluate(target, OUTLINE_JS);
}

/** 提取 target 页面主内容文本(去导航/页脚/表单,截断)。 */
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

/** 在 target 页面按真实键盘事件(组合键用 Ctrl+Shift+A 写法)。 */
async function pressKey(target, keySpec) {
  const { key, code, kc, modifiers } = parseKeySpec(keySpec);
  const ws = await pageWs(target);
  await send(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers });
  await send(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers });
  ws.close();
}

/** 将鼠标移到 target 页面指定元素中心(触发 mouseover/mouseenter)。 */
async function hover(target, selector) {
  const pos = await evaluate(target, `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return null; el.scrollIntoView({block:'center',behavior:'instant'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; })()`);
  if (!pos) throw new Error('未找到: ' + selector);
  const ws = await pageWs(target);
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  ws.close();
}

// 核心 api 对象(不含 logs/ensure,入口 cdp.js 组装补全)。
const coreApi = {
  list, resolve, open, close, navigate, eval: evaluate,
  snapshot, tree, click, fill, waitFor, waitForFn, shot, focus, getFocus, outline, content, pressKey, hover,
};

module.exports = { coreApi, open, navigate };
