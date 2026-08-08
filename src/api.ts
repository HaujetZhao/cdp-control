/**
 * api.ts — 高层页面操作 API(CLI 与 run 脚本共用)。
 * 依赖 transport(连接)+ inject-loader(注入脚本装配)+ monitor(maybeSpawnDaemon)。
 * 不包含 logs/ensure(分别在 monitor/browser),由 cdp.ts 入口组装为最终 api 对象。
 */
import { writeFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { pageWs, browserWs, send, evalJs, evaluate, resolve, list, sleep, Target } from './transport';
import { inject, hoverExpr, treeExpr, xpathExpr } from './inject-loader';
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

/** 提取 target 页面可交互元素清单。 */
export async function snapshot(target: Target): Promise<any> {
  return invoke(target, inject('snapshot'), 30000);
}

export interface TreeOpts { selector?: string; xpath?: string }

/** 结构树:把 target 页面建为紧凑简化 HTML 树(文本 + 结构)。 */
export async function tree(target: Target, opts: TreeOpts = {}): Promise<any> {
  return invoke(target, treeExpr(opts.selector, opts.xpath), 30000);
}

/** 按 xpath 查元素(注入侧 xpathEval 解析,shadow 穿透,返回命中列表 + 分步诊断)。 */
export async function xpath(target: Target, path: string): Promise<any> {
  return invoke(target, xpathExpr(path));
}

/** 点击 target 页面上匹配 selector 的元素。 */
export async function click(target: Target, selector: string): Promise<any> {
  return invoke(target, inject('click', { sel: selector }));
}

/** 向 target 页面输入框填值(派发 input/change)。 */
export async function fill(target: Target, selector: string, value: string): Promise<any> {
  return invoke(target, inject('fill', { sel: selector, value }));
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

/** 聚焦 target 页面上匹配 selector 的元素。 */
export async function focus(target: Target, selector: string): Promise<any> {
  return invoke(target, inject('focus', { sel: selector }));
}

/** 返回 target 页面当前焦点元素(document.activeElement)信息,无焦点返回 null。 */
export async function getFocus(target: Target): Promise<any> {
  return invoke(target, inject('get-focus'));
}

/** 提取 target 页面大纲:标题层级(h1-h6)+ 关键链接。 */
export async function outline(target: Target): Promise<any> {
  return invoke(target, inject('outline'));
}

/** 提取 target 页面主内容文本(去导航/页脚/表单,截断)。 */
export async function content(target: Target): Promise<any> {
  return invoke(target, inject('content'), 30000);
}

/** 在 target 页面按真实键盘事件(组合键用 Ctrl+Shift+A 写法)。 */
export async function pressKey(target: Target, keySpec: string): Promise<void> {
  const { key, code, kc, modifiers } = parseKeySpec(keySpec);
  await withPage(target, async (ws) => {
    await send(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers });
    await send(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers });
  });
}

/** 将鼠标移到 target 页面指定元素中心(触发 mouseover/mouseenter)。坐标获取那段保持不动。 */
export async function hover(target: Target, selector: string): Promise<void> {
  const pos = await invoke<{ ok: boolean; x: number; y: number }>(target, hoverExpr(selector));
  if (!pos?.ok) throw new Error('未找到: ' + selector);
  await withPage(target, async (ws) => {
    await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  });
}

// 核心 api 对象(不含 logs/ensure,入口 cdp.ts 组装补全)。
const coreApi = {
  list, resolve, open, close, navigate, eval: evaluate,
  snapshot, tree, xpath, click, fill, waitFor, waitForFn, shot, focus, getFocus, outline, content, pressKey, hover,
};

export { coreApi };
