/**
 * api.ts — 高层页面操作 API(CLI 与 run 脚本共用)。
 * 依赖 transport(连接)+ inject-loader(注入脚本装配)+ monitor(maybeSpawnDaemon)。
 * 不包含 logs/ensure(分别在 monitor/browser),由 cdp.ts 入口组装为最终 api 对象。
 */
import { pageWs, browserWs, send, evalJs, evaluate, resolve, list, sleep, Target } from './transport';
import { inject, clickExpr, fillExpr, focusExpr, treeExpr } from './inject-loader';
import { maybeSpawnDaemon, injectMonitor } from './monitor';

/** 新开一个 tab,返回 targetId。 */
export async function open(url = 'about:blank'): Promise<string> {
  const ws = await browserWs();
  const { targetId } = await send(ws, 'Target.createTarget', { url, newWindow: false });
  ws.close();
  maybeSpawnDaemon();
  try {
    const t = await resolve(targetId);
    await injectMonitor(t);
  } catch {}
  return targetId;
}

/** 关闭 target。 */
export async function close(target: Target): Promise<void> {
  const ws = await browserWs();
  await send(ws, 'Target.closeTarget', { targetId: target.id });
  ws.close();
}

/** 导航 target 到 url。 */
export async function navigate(target: Target, url: string): Promise<void> {
  const ws = await pageWs(target);
  await send(ws, 'Page.navigate', { url });
  ws.close();
}

/** 提取 target 页面可交互元素清单。 */
export async function snapshot(target: Target): Promise<any> {
  return evaluate(target, inject('snapshot'), 30000);
}

export interface TreeOpts { selector?: string; xpath?: string }

/** 结构树:把 target 页面建为紧凑简化 HTML 树(文本 + 结构)。 */
export async function tree(target: Target, opts: TreeOpts = {}): Promise<any> {
  const r = await evaluate(target, treeExpr(rootExprOf(opts)), 30000);
  if (!r?.ok) throw new Error(r?.err || 'tree 失败');
  return r;
}

/** 把 selector/xpath 选项翻译成页面侧求根元素的 JS 表达式;缺省返回 body。 */
export function rootExprOf({ selector, xpath }: TreeOpts = {}): string {
  if (selector) return `document.querySelector(${JSON.stringify(selector)})`;
  if (xpath) return shadowXPathExpr(JSON.stringify(xpath));
  return 'document.body';
}

/** shadow 穿透版 xpath 求根。document.evaluate 不接受 shadowRoot(DocumentFragment)作上下文,
 * 故对 document + 每个 shadowRoot 的顶层子元素各求值一次,按文档序取第一个元素命中(去重)。 */
export function shadowXPathExpr(xpJson: string): string {
  return `(() => {
  const xp = ${xpJson};
  const ctxs = [document];
  const seenRoot = new Set([document]);
  const stack = [document];
  while (stack.length) {
    const n = stack.pop();
    const kids = [];
    if (n.shadowRoot) kids.push(n.shadowRoot);
    for (const c of n.children || []) kids.push(c);
    for (const c of kids) if (!seenRoot.has(c)) { seenRoot.add(c); stack.push(c); }
    if (n.nodeType === 11)
      for (const c of n.children || []) ctxs.push(c);
  }
  const seen = new Set();
  for (const root of ctxs) {
    let r;
    try { r = document.evaluate(xp, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); }
    catch (e) { return null; }
    const node = r.singleNodeValue;
    if (node && node.nodeType === 1 && !seen.has(node)) { seen.add(node); return node; }
  }
  return null;
})()`;
}

/** 点击 target 页面上匹配 selector 的元素。 */
export async function click(target: Target, selector: string): Promise<any> {
  const r = await evaluate(target, clickExpr(selector));
  if (!r?.ok) throw new Error(r?.err || '点击失败');
  return r;
}

/** 向 target 页面输入框填值(派发 input/change)。 */
export async function fill(target: Target, selector: string, value: string): Promise<any> {
  const r = await evaluate(target, fillExpr(selector, value));
  if (!r?.ok) throw new Error(r?.err || '填充失败');
  return r;
}

// 共享轮询原语:反复 eval 一段 JS 布尔表达式直到真值或超时。desc 用于超时报错文案。
export async function pollWait(target: Target, expression: string, desc: string, { timeout = 15000, interval = 300 } = {}): Promise<boolean> {
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
export async function waitFor(target: Target, selector: string, opts?: any): Promise<boolean> {
  return pollWait(target, `!!document.querySelector(${JSON.stringify(selector)})`, selector, opts);
}

/** 轮询执行 JS 布尔表达式直到返回真值,超时抛错。 */
export async function waitForFn(target: Target, expression: string, opts?: any): Promise<boolean> {
  return pollWait(target, expression, expression, opts);
}

/** 截图 target 页面到文件,返回文件路径。 */
export async function shot(target: Target, file?: string): Promise<string> {
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
export async function focus(target: Target, selector: string): Promise<any> {
  const r = await evaluate(target, focusExpr(selector));
  if (!r?.ok) throw new Error(r?.err || '聚焦失败');
  return r;
}

/** 返回 target 页面当前焦点元素(document.activeElement)信息,无焦点返回 null。 */
export async function getFocus(target: Target): Promise<any> {
  return evaluate(target, inject('get-focus'));
}

/** 提取 target 页面大纲:标题层级(h1-h6)+ 关键链接。 */
export async function outline(target: Target): Promise<any> {
  return evaluate(target, inject('outline'));
}

/** 提取 target 页面主内容文本(去导航/页脚/表单,截断)。 */
export async function content(target: Target): Promise<any> {
  return evaluate(target, inject('content'), 30000);
}

// 键名 → CDP key/code/虚拟键码
const KEYMAP: Record<string, { key: string; code: string; kc: number }> = {
  enter: { key: 'Enter', code: 'Enter', kc: 13 }, tab: { key: 'Tab', code: 'Tab', kc: 9 },
  escape: { key: 'Escape', code: 'Escape', kc: 27 }, backspace: { key: 'Backspace', code: 'Backspace', kc: 8 },
  'delete': { key: 'Delete', code: 'Delete', kc: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', kc: 38 }, arrowdown: { key: 'ArrowDown', code: 'ArrowDown', kc: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', kc: 37 }, arrowright: { key: 'ArrowRight', code: 'ArrowRight', kc: 39 },
  home: { key: 'Home', code: 'Home', kc: 36 }, end: { key: 'End', code: 'End', kc: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', kc: 33 }, pagedown: { key: 'PageDown', code: 'PageDown', kc: 34 },
  space: { key: ' ', code: 'Space', kc: 32 }, f5: { key: 'F5', code: 'F5', kc: 116 },
};
function parseKeySpec(spec: string): { key: string; code: string; kc: number; modifiers: number } {
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
export async function pressKey(target: Target, keySpec: string): Promise<void> {
  const { key, code, kc, modifiers } = parseKeySpec(keySpec);
  const ws = await pageWs(target);
  await send(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers });
  await send(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers });
  ws.close();
}

/** 将鼠标移到 target 页面指定元素中心(触发 mouseover/mouseenter)。 */
export async function hover(target: Target, selector: string): Promise<void> {
  const pos = await evaluate(target, `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return null; el.scrollIntoView({block:'center',behavior:'instant'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; })()`);
  if (!pos) throw new Error('未找到: ' + selector);
  const ws = await pageWs(target);
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  ws.close();
}

// 核心 api 对象(不含 logs/ensure,入口 cdp.ts 组装补全)。
const coreApi = {
  list, resolve, open, close, navigate, eval: evaluate,
  snapshot, tree, click, fill, waitFor, waitForFn, shot, focus, getFocus, outline, content, pressKey, hover,
};

export { coreApi };
