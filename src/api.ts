/**
 * api.ts — 高层页面操作 API(CLI 与 run 脚本共用)。
 * 依赖 transport(连接)+ inject-loader(注入脚本装配)+ monitor(maybeSpawnDaemon)。
 * 不包含 logs/ensure(分别在 monitor/browser),由 cdp.ts 入口组装为最终 api 对象。
 */
import { writeFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { pageWs, browserWs, send, evalJs, evaluate, resolve, list, sleep, Target } from './transport';
import { inject, treeExpr, locateExpr } from './inject-loader';
import { parseKeySpec } from './keys';
import { maybeSpawnDaemon, injectMonitor } from './monitor';

/**
 * 统一执行注入脚本并解包结果契约:
 * 注入脚本成功返回任意值(可含 {ok:true});失败返回 {ok:false, err}。
 * 这里统一把失败抛成异常,调用方无需各自判 ok。数据类入口(snapshot 等返回裸数组/对象)自然通过。
 */
async function invoke<T>(target: Target, expr: string, timeout?: number): Promise<T> {
  const r = await evaluate(target, expr, timeout);
  if (r && typeof r === 'object' && (r as any).ok === false) throw new Error((r as any).err || '操作失败');
  return r as T;
}

/**
 * 连接抽象:开 target 页 ws → 执行回调(回调收到已连接的 ws)→ finally 关闭。返回回调返回值。
 * 消除「拿 ws → 用 → 关」样板,关闭时机统一在 finally,保证异常/正常路径都关。
 */
async function withPage<T>(target: Target, fn: (ws: WebSocket) => Promise<T>): Promise<T> {
  const ws = await pageWs(target);
  try { return await fn(ws); } finally { ws.close(); }
}

/** 连接抽象:开浏览器级 ws → 执行回调 → finally 关闭。返回回调返回值。 */
async function withBrowser<T>(fn: (ws: WebSocket) => Promise<T>): Promise<T> {
  const ws = await browserWs();
  try { return await fn(ws); } finally { ws.close(); }
}

/** 新开一个 tab,返回 targetId。ws 在 maybeSpawnDaemon() 之前已关闭。 */
export async function open(url = 'about:blank'): Promise<string> {
  const { targetId } = await withBrowser(async (ws) => {
    const r = await send(ws, 'Target.createTarget', { url, newWindow: false });
    return { targetId: r.targetId };
  });
  maybeSpawnDaemon();
  try {
    const t = await resolve(targetId);
    await injectMonitor(t);
  } catch {}
  return targetId;
}

/** 关闭 target。 */
export async function close(target: Target): Promise<void> {
  await withBrowser(async (ws) => {
    await send(ws, 'Target.closeTarget', { targetId: target.id });
  });
}

/** 导航 target 到 url。 */
export async function navigate(target: Target, url: string): Promise<void> {
  await withPage(target, async (ws) => {
    await send(ws, 'Page.navigate', { url });
  });
}

export interface TreeOpts { selector?: string; xpath?: string; visibleOnly?: boolean; ref?: number; ancestor?: number }

/** 结构树:把 target 页面建为紧凑简化 HTML 树(文本 + 结构)。锚点互斥:ref 优先,其次 selector,最后 xpath,缺省 body;
 * ancestor 为统一爬父修饰符(对任一锚点生效);visibleOnly 只输出视口内可见元素。 */
export async function tree(target: Target, opts: TreeOpts = {}): Promise<any> {
  return invoke(target, treeExpr(opts.selector, opts.xpath, opts.visibleOnly, opts.ref, opts.ancestor), 30000);
}

/** 按 tree 的 ref 序号反查稳定定位器(selector + xpath),可选 ancestor 向上爬 N 层父级。刷新后 ref 失效,可用返回的定位器复用。 */
export async function locate(target: Target, ref: number, ancestor?: number): Promise<any> {
  return invoke(target, locateExpr(ref, ancestor));
}

/** 操作目标:selector 字符串,或 {ref:n, ancestor?} 用 tree 登记的引用序号(穿透 shadow,可选爬父)。 */
export type TargetArg = string | { ref: number; ancestor?: number };

/** 归一化操作目标为注入侧参数:字符串→{sel},对象→{ref}。 */
function normArg(a: TargetArg): { sel?: string; ref?: number } {
  return typeof a === 'string' ? { sel: a } : a;
}

/** 点击 target 页面上匹配 selector 或 ref 的元素。 */
export async function click(target: Target, arg: TargetArg): Promise<any> {
  return invoke(target, inject('click', normArg(arg)));
}

/** 向 target 页面输入框填值(按 selector 或 ref,派发 input/change)。 */
export async function fill(target: Target, arg: TargetArg, value: string): Promise<any> {
  return invoke(target, inject('fill', { ...normArg(arg), value }));
}

// 共享轮询原语:反复 eval 一段 JS 布尔表达式直到真值或超时。desc 用于超时报错文案。
export async function pollWait(target: Target, expression: string, desc: string, { timeout = 15000, interval = 300 } = {}): Promise<boolean> {
  const ws = await pageWs(target);
  const start = Date.now();
  try {
    while (true) {
      // 单次 eval 的超时时限 = pollWait 剩余时间;剩余已耗尽则直接按超时抛错,不让 evalJs 独占默认 20s。
      const remaining = timeout - (Date.now() - start);
      if (remaining <= 0) throw new Error(`等待超时( ${timeout}ms ): ${desc}`);
      const v = await evalJs(ws, `Boolean(${expression})`, remaining);
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

/** 截图 target 页面到文件,返回文件路径。写文件在关闭 ws 之后做。 */
export async function shot(target: Target, file?: string): Promise<string> {
  const r = await withPage(target, async (ws) => {
    return await send(ws, 'Page.captureScreenshot', { format: 'png' });
  });
  if (!r.data) throw new Error('截图失败:无数据');
  const out = file || `shot_${Date.now()}.png`;
  writeFileSync(pathResolve(out), Buffer.from(r.data, 'base64'));
  return out;
}

/** 聚焦 target 页面上匹配 selector 或 ref 的元素。 */
export async function focus(target: Target, arg: TargetArg): Promise<any> {
  return invoke(target, inject('focus', normArg(arg)));
}

/** 返回 target 页面当前焦点元素(document.activeElement)信息,无焦点返回 null。 */
export async function getFocus(target: Target): Promise<any> {
  return invoke(target, inject('get-focus'));
}

/** 在 target 页面按真实键盘事件(组合键用 Ctrl+Shift+A 写法)。 */
export async function pressKey(target: Target, keySpec: string): Promise<void> {
  const { key, code, kc, modifiers } = parseKeySpec(keySpec);
  await withPage(target, async (ws) => {
    await send(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers });
    await send(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers });
  });
}

/** 将鼠标移到 target 页面指定元素中心(按 selector 或 ref,触发 mouseover/mouseenter)。 */
export async function hover(target: Target, arg: TargetArg): Promise<void> {
  const pos = await invoke<{ ok: boolean; x: number; y: number }>(target, inject('hover', normArg(arg)));
  if (!pos?.ok) throw new Error('未找到: ' + (typeof arg === 'string' ? arg : 'ref=' + arg.ref));
  await withPage(target, async (ws) => {
    await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  });
}

// 核心 api 对象(不含 logs/ensure,入口 cdp.ts 组装补全)。
const coreApi = {
  list, resolve, open, close, navigate, eval: evaluate,
  tree, locate, click, fill, waitFor, waitForFn, shot, focus, getFocus, pressKey, hover,
};

export { coreApi };
