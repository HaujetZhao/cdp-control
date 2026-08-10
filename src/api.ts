/**
 * api.ts — 高层页面操作 API(CLI 与 run 脚本共用)。
 * 依赖 transport(连接)+ inject-loader(注入脚本装配)+ monitor(maybeSpawnDaemon)。
 * 不包含 logs/ensure(分别在 monitor/browser),由 cdp.ts 入口组装为最终 api 对象。
 */
import { writeFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { pageWs, browserWs, send, evalJs, evaluate, resolve, list, sleep, Target } from './transport';
import { inject, viewExpr, locateExpr, infoExpr, foldExpr, findExpr, articleExpr } from './inject-loader';
import { parseKeySpec } from './keys';
import { maybeSpawnDaemon, injectMonitor } from './monitor';
import { matchFolds, hostOf, pathOf, loadFolds, addFold, removeFold } from './folds';
import { loadLinkRules, addLinkRule, removeLinkRule } from './ignore-links';
import { normArg, type TargetArg } from './target-arg';
import { diffTabs } from './tab-diff';

/**
 * 统一执行注入脚本并解包结果契约:
 * 注入脚本成功返回任意值(可含 {ok:true});失败返回 {ok:false, err}。
 * 这里统一把失败抛成异常,调用方无需各自判 ok。数据类入口(snapshot 等返回裸数组/对象)自然通过。
 * 例外:ref 失效自愈({ok:false, refInvalid:true, recovered})不抛——上层据此打印 recovered view,不走反馈。
 */
async function invoke<T>(target: Target, expr: string, timeout?: number): Promise<T> {
  const r = await evaluate(target, expr, timeout);
  if (r && typeof r === 'object' && (r as any).ok === false && !(r as any).refInvalid) throw new Error((r as any).err || '操作失败');
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

export interface ViewOpts {
  selector?: string; visibleOnly?: boolean; ref?: number; ancestor?: number;
  scrollToLoad?: boolean; scrollPages?: number; scrollTo?: string; scrollWait?: number;
  maxLen?: number; // 文本截断阈值;缺省不截断
}

/** 结构视图:把 target 页面建为紧凑简化 HTML 树(文本 + 结构)。锚点互斥:ref 优先,其次 selector,缺省 body;
 * ancestor 为统一爬父修饰符(对任一锚点生效);visibleOnly 只输出视口内可见元素;scrollToLoad 先滚动触发懒加载再建视图
 *   (默认 ±1 屏回弹;scrollPages 改为循环滚 N 屏;scrollTo 先滚到该 selector 元素,如 B站评论区)。
 * 折叠:Node 侧按 target 页 hostname+pathname 读 fold-selectors.csv 命中规则(path glob 限定同域名下页面路径),
 * 传入注入侧 buildView 折叠成一行(跨会话持久)。 */
export async function view(target: Target, opts: ViewOpts = {}): Promise<any> {
  const folds = matchFolds(hostOf(target.url), pathOf(target.url)).map(r => ({ selector: r.selector, note: r.note }));
  const ignore = loadLinkRules().map(r => r.pattern);
  return invoke(target, viewExpr(opts.selector, opts.visibleOnly, opts.ref, opts.ancestor, opts.scrollToLoad, folds, opts.scrollPages, opts.scrollTo, opts.scrollWait, ignore.length ? ignore : undefined, opts.maxLen), 30000);
}

/** 一次性抓取页面:临时 open 新 tab 打开 url → 等页面加载(至少 interactive)→ view 建树 → 关闭 tab,
 * 返回视图 lines(替代 web fetch MCP:一次拿到整页文本+结构,不残留 tab)。
 * 顺序固定:open(新 tab)→ resolve(拿 target 对象)→ 等加载 → view → close;close 在 finally 保证关。 */
export async function fetchPage(url: string): Promise<string[]> {
  const tid = await open(url);
  let t: Target | undefined;
  try {
    t = await resolve(tid);
    // 等页面渲染出实质内容(body 有非空文本),避免 SPA 懒加载首帧只有空 body 就抓;加载慢/超时按现状 view(拿空树,优雅降级)。
    try { await waitForFn(t, `document.body && document.body.innerText.trim().length > 0`, { timeout: 20000, interval: 300 }); } catch {}
    const r = await view(t);
    return r.lines ?? [];
  } finally {
    if (t) { try { await close(t); } catch {} }
  }
}

/** 按 view 的 ref 序号反查稳定 CSS selector,可选 ancestor 向上爬 N 层父级。刷新后 ref 失效,可用返回的 selector 复用。 */
export async function locate(target: Target, ref: number, ancestor?: number): Promise<any> {
  return invoke(target, locateExpr(ref, ancestor));
}

/** info:列目标元素(爬 ancestor 后)从 html 到自身的祖先链,每层 tag/id/class/语义 data-* /aria/role + 建议 selector。
 * 供 agent 挑稳定锚点自己写 fold add 这种 uBlock 式短规则(如 #biliMainHeader),而非只靠 genSel 猜一个。 */
export async function info(target: Target, ref: number, ancestor?: number): Promise<any> {
  return invoke(target, infoExpr(ref, ancestor));
}

/** article:按 view 的 ref 提取子树为格式友好的 Markdown 文章(保序、不截断)。ancestor 可选向上爬父。
 * 链接黑名单(ignore-links.ts 读入的持久规则)命中只留文本、去 URL。 */
export async function article(target: Target, ref: number, ancestor?: number): Promise<any> {
  const ignore = loadLinkRules().map(r => r.pattern);
  return invoke(target, articleExpr(ref, ancestor, ignore.length ? ignore : undefined));
}

/** ignore-links 黑名单管理(add/rm/list)。pattern 为链接通配符(glob,匹配 hostname+pathname)。
 * view 与 article 共用:命中只留文本(article 去 URL;view 内联文本并与相邻段合并)。 */
export async function ignoreLink(action: 'add' | 'rm' | 'list', pattern?: string, note?: string, id?: number): Promise<any> {
  if (action === 'add') return { ok: true, rule: addLinkRule(pattern || '', note || '') };
  if (action === 'rm') return { ok: removeLinkRule(id!), removed: id };
  return { ok: true, rules: loadLinkRules() };
}

export interface FoldOpts {
  ref?: number; ancestor?: number; note?: string; save?: boolean; domain?: string; path?: string;
  add?: { domain: string; path: string; selector: string; note: string }; list?: boolean; rm?: number;
}

/** find:按文本(--text)或 selector(--selector)找元素,登记 ref 返回(追加,不重置)。
 * - text:整页穿透 shadow 搜"自身或后代文本含关键词"的元素;selector:document.querySelector(支持 `>>>` shadow 链)。
 * - ancestor:命中后向上爬 N 层到区域容器。all:收集全部命中而非首个。
 * - 返回 {ok, hits:[{ref, tag, text, line}]}(line 是该元素 formatView 的一行输出,含 [ref=N])。 */
export interface FindOpts { text?: string; selector?: string; ancestor?: number; all?: boolean }
export async function find(target: Target, opts: FindOpts = {}): Promise<any> {
  return invoke(target, findExpr(opts));
}
/** 折叠规则管理(取代 stash):
 *  - add {domain, path, selector, note}:加持久规则(fold-selectors.csv)
 *  - rm <id>:删持久规则(其它规则 id 不重排)
 *  - list:列持久 + 会话级临时
 *  - ref + save:从 ref 反查 selector + 当前 hostname,落盘持久规则
 *  - ref(无 save):会话级临时折叠(注入 __cdpFolds,刷新失效) */
export async function fold(target: Target, opts: FoldOpts = {}): Promise<any> {
  if (opts.rm != null) return { ok: removeFold(opts.rm), removed: opts.rm };
  if (opts.list) {
    const persist = loadFolds();
    const tmp = await invoke<{ folds: any[] }>(target, foldExpr({ list: true }));
    return { ok: true, persist, tmp: tmp.folds };
  }
  if (opts.add) { return { ok: true, rule: addFold(opts.add.domain, opts.add.path, opts.add.selector, opts.add.note) }; }
  if (opts.save) {
    // locate 失效(refInvalid)时 invoke 不抛、透传 recovered;此时 loc.selector 是 undefined,
    // 不能 addFold,直接把 recovered 透传给 CLI 走自愈打印。
    const loc = await invoke<{ selector: string } | { ok: false; refInvalid: true; recovered: any }>(target, locateExpr(opts.ref!, opts.ancestor));
    if ((loc as any)?.refInvalid) return loc as any;
    const domain = opts.domain || hostOf(target.url);
    return { ok: true, rule: addFold(domain, opts.path || '', (loc as any).selector, opts.note || (loc as any).selector) };
  }
  return invoke(target, foldExpr({ ref: opts.ref, ancestor: opts.ancestor, note: opts.note }));
}

/** 操作目标类型 TargetArg 与归一化函数 normArg(含 {ref:N} 误用防呆)抽在 src/target-arg.ts,纯函数零依赖可单测。 */
export type { TargetArg } from './target-arg';

// —— 操作后自动反馈(opts + tab diff)——

/** 操作反馈配置。feedbackDelay:操作后等待毫秒(默认 1000,给异步/懒加载内容出现留时间);noFeedback:关闭反馈。 */
export interface FeedbackOpts { feedbackDelay?: number; noFeedback?: boolean }

/** 反馈结构:内容变化(注入侧)+ tab 变化(Node 侧 /json/list diff)。 */
export interface FeedbackResult {
  note?: string;                                    // 说明(如"页面已跳转,旧 ref 失效,以下是新页整页视图")
  reloaded?: boolean;                               // 注入侧判定:本次是否整页重载(换 document)
  blocks?: { lines: string[]; count: number }[];   // 去重折叠后的新增内容块(可空);重载时为整页视图单块
  changes?: { before?: string; after: string }[];  // 文本变化(过滤前后相同),如 [{before:'63',after:'64'}]
  tabs?: { opened: Target[]; closed: Target[]; navigated?: { id: string; from: string; to: string }[] };
}

/**
 * 用反馈包裹一次动作:装 observer(注入) → 快照 tab → 执行动作 → 等 feedbackDelay → 收反馈(注入) → 再快照 tab。
 * 动作本身返回 {ok:true,...};这里把结果展开并附上 feedback(内容 + tab diff)。noFeedback 时不做任何等待/观察/diff,返回 feedback:null。
 */
async function runWithFeedback<T>(target: Target, doAction: () => Promise<T>, opts: FeedbackOpts = {}): Promise<T & { feedback: FeedbackResult | null }> {
  if (opts.noFeedback) return { ...(await doAction()), feedback: null };
  await invoke(target, inject('feedback-start'));
  const before = await list();
  try {
    const result = await doAction();
    // ref 失效自愈:无真实动作发生,跳过反馈等待/采集/tab diff,直接把 recovered 透传给 CLI。
    if (result && typeof result === 'object' && (result as any).refInvalid) {
      return { ...result, feedback: null } as any;
    }
    await sleep(opts.feedbackDelay ?? 1000);
    const after = await list();
    const tabs = diffTabs(before, after);
    // 增量反馈先行。是否整页重载(真导航换 document)由注入侧 reloaded 判定,而非仅看 URL 变化:
    // 锚点/历史跳转(URL 变但同 document)旧 DOM/ref 全有效,仍走增量;整页导航才整页 view 重建。
    const fb = await invoke<FeedbackResult>(target, inject('feedback-collect'));
    const nav = tabs.navigated?.[0];
    if (nav && fb.reloaded) {
      // 整页重载:旧 document/observer 已失效,增量(append ref)只会给 agent 一堆失效 ref;
      // 改走整页 view(不带 ref/selector → __cdpRefs 从 0 重建),把新页整棵树给 agent 并注明。
      // 用新 URL 过滤 fold 规则:view 按 target.url 算 hostname+pathname,重载后必须用新地址
      // (target.id 不变、ws 不变,仍连同一页面,只覆盖 url 即可)。
      const v = await view({ ...target, url: nav.to });
      return {
        ...result,
        feedback: {
          blocks: v.lines?.length ? [{ lines: v.lines, count: 1 }] : [],
          changes: [],
          note: `页面已跳转: ${nav.from} → ${nav.to};旧页 DOM/ref 全部失效,以上为新页整页视图(ref 从 0 重建)`,
          tabs,
        },
      };
    }
    return { ...result, feedback: { ...fb, tabs } };
  } catch (err) {
    // 动作抛错(如 ref 失效):也断开 observer,避免 __cdpFeedback 残留影响下次;再重抛原错误。
    try { await invoke(target, inject('feedback-collect')); } catch {}
    throw err;
  }
}

/** 点击 target 页面上匹配 selector 或 ref 的元素(默认带操作后反馈)。 */
export async function click(target: Target, arg: TargetArg, opts: FeedbackOpts = {}): Promise<any> {
  return runWithFeedback(target, () => invoke(target, inject('click', normArg(arg))), opts);
}

/** 向 target 页面输入框填值(按 selector 或 ref,派发 input/change;默认带操作后反馈)。 */
export async function fill(target: Target, arg: TargetArg, value: string, opts: FeedbackOpts = {}): Promise<any> {
  return runWithFeedback(target, () => invoke(target, inject('fill', { ...normArg(arg), value })), opts);
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

/** 聚焦 target 页面上匹配 selector 或 ref 的元素(默认带操作后反馈)。 */
export async function focus(target: Target, arg: TargetArg, opts: FeedbackOpts = {}): Promise<any> {
  return runWithFeedback(target, () => invoke(target, inject('focus', normArg(arg))), opts);
}

/** 返回 target 页面当前焦点元素(document.activeElement)信息,无焦点返回 null。 */
export async function getFocus(target: Target): Promise<any> {
  return invoke(target, inject('get-focus'));
}

/** 在 target 页面按真实键盘事件(组合键用 Ctrl+Shift+A 写法;默认带操作后反馈,如 PageDown 滚动触发懒加载)。
 * 滚动类键(PageUp/PageDown/Home/End)的 keyDown 透传 CDP commands(如 scrollPageDown)触发浏览器内置滚动
 * ——光发 keyDown/keyUp 事件到 JS 层不触发原生滚动。 */
export async function pressKey(target: Target, keySpec: string, opts: FeedbackOpts = {}): Promise<any> {
  const { key, code, kc, modifiers, commands } = parseKeySpec(keySpec);
  return runWithFeedback(target, async () => {
    await withPage(target, async (ws) => {
      // keyDown 带 commands 触发原生滚动(仅滚动类键有 commands);keyUp 不需要重复传。
      const down: any = { type: 'keyDown', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers };
      if (commands) down.commands = commands;
      await send(ws, 'Input.dispatchKeyEvent', down);
      await send(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers });
    });
    return { ok: true as const };
  }, opts);
}

/** 将鼠标移到 target 页面指定元素中心(按 selector 或 ref,触发 mouseover/mouseenter;默认带操作后反馈)。 */
export async function hover(target: Target, arg: TargetArg, opts: FeedbackOpts = {}): Promise<any> {
  return runWithFeedback(target, async () => {
    const pos = await invoke<{ ok: boolean; refInvalid?: boolean; x: number; y: number }>(target, inject('hover', normArg(arg)));
    if (pos?.refInvalid) return pos; // ref 失效:注入侧已自愈,不 dispatch 鼠标
    if (!pos?.ok) throw new Error('未找到: ' + (typeof arg === 'string' ? arg : 'ref=' + arg.ref));
    await withPage(target, async (ws) => {
      await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
    });
    return { ok: true as const };
  }, opts);
}

// 核心 api 对象(不含 logs/ensure,入口 cdp.ts 组装补全)。
const coreApi = {
  list, resolve, open, close, navigate, eval: evaluate,
  view, locate, info, article, ignoreLink, fold, find, fetchPage, click, fill, waitFor, waitForFn, shot, focus, getFocus, pressKey, hover,
};

export { coreApi };
