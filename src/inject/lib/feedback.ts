/**
 * feedback.ts — 操作后自动反馈(注入侧):MutationObserver 采集本次操作产生的 DOM 变化。
 * 分为两段,跨两次 Runtime.evaluate 调用协作,observer 状态暂存于全局 __cdpFeedback:
 *   startFeedback()   — 装 observer,记录 childList 新增 + 文本变化(前后值)。
 *   collectFeedback() — 断开 observer,取"顶层新增元素"逐块建树拼接,产摘要。
 * 等待时长由 Node 侧(sleep)控制,不在此注入侧;node 侧在两次调用之间等待 delayMs。
 *
 * ref 语义:collect **不重置 __cdpRefs,只追加**——反馈新增的 ref 从现有长度递增,不顶掉整页旧 ref
 * (整页 tree 才重置)。agent 用反馈树的增量 ref 操作新增内容,同时原 ref 依旧有效。
 *
 * shadow 穿透:MutationObserver 默认只观察调用 observe 的那棵树,**不进 shadowRoot**——B站点赞数、
 * 弹幕等多在 shadow 内,变化压根不进反馈。startFeedback 对 document + 所有 shadowRoot(限深度 ≤3)
 * 各起一个 observer,且 childList 新增节点若带 shadowRoot 也补装,保证 shadow 内变化能被采集。
 */
import { buildTree } from './tree-core';
import { markText, formatTree } from './tree-format';

export interface FeedbackResult { blocks: FeedbackBlock[]; changes: FeedbackChange[] }

/** 一个去重后的新增内容块:lines 为该块 tree 行,count 为它在本次出现的次数(重复块折叠)。 */
export interface FeedbackBlock { lines: string[]; count: number }

/** 一次文本变化:before 为旧值(可缺),after 为新值。 */
export interface FeedbackChange { before?: string; after: string }

interface FeedbackState { added: Node[]; changes: FeedbackChange[] }

/** shadow 递归观察深度上限(防极深 shadow 树导致 observer 爆炸;B站等典型页面 shadow 嵌套 ≤3)。 */
const MAX_SHADOW_DEPTH = 3;

/** 取 mutation 里新增/移除的直接文本节点文本。 */
const textNodes = (nodes: NodeList): string[] =>
  Array.from(nodes).filter(n => n.nodeType === 3).map(n => (n.nodeValue || '').trim()).filter(Boolean);

/**
 * 启动反馈观察:对 document 及其所有 shadowRoot(限深度 ≤3)各起一个 MutationObserver,
 * 记录 childList 新增节点与文本变化(前后值;attributes 不进反馈,噪声大)。
 * childList 新增节点若带 shadowRoot,补装 observer,覆盖运行时挂载的 shadow host。
 */
export function startFeedback(): void {
  if ((globalThis as any).__cdpFeedback) return; // 已启动则复用(防重复装)
  const st: FeedbackState = { added: [], changes: [] };
  const mos: MutationObserver[] = [];
  // callback 在所有 observer 间共享:统一推 state,并给新增带 shadowRoot 的节点补装。
  const onMutate = (ms: MutationRecord[]) => {
    for (const m of ms) {
      if (m.type === 'characterData' && m.target.nodeType === 3) {
        // 原地改字符(如点赞数字 textContent 直接改 data):characterDataOldValue 记录了旧值,拼成 旧→新。
        const before = (m.oldValue || '').trim();
        const after = ((m.target as Text).nodeValue || '').trim();
        if (after && before !== after) st.changes.push(before ? { before, after } : { after });
      } else if (m.type === 'childList') {
        // 文本替换(如 element.textContent=值 删旧加新 Text):removedNodes=旧值、addedNodes=新值,一对一配对成 旧→新。
        const befores = textNodes(m.removedNodes);
        const afters = textNodes(m.addedNodes);
        const k = Math.min(befores.length, afters.length);
        for (let i = 0; i < k; i++) st.changes.push({ before: befores[i], after: afters[i] });
        for (let i = k; i < afters.length; i++) st.changes.push({ after: afters[i] });
        // 记录新增元素节点(顶层去重靠 collect),并给带 shadowRoot 的新节点补装 observer(动态 shadow host)。
        for (const n of Array.from(m.addedNodes)) {
          if (n.nodeType === 1) {
            st.added.push(n);
            observeShadowTree(n as Element, currentDepth(m.target));
          }
        }
      }
    }
  };

  // 每棵被观察的树记录其 shadow 深度,用于新增节点补装时判定是否超限。document 视为深度 0。
  const depthMap = new Map<Node, number>();
  // 给定已观察树内任一节点,取其所属观察根的深度:先看 rootNode(观察根本身)命中,否则沿 host 链回溯。
  function currentDepth(target: Node): number {
    let n: Node | null = target;
    while (n) {
      // n 的根节点(穿过普通 DOM 树到观察根本身):若是已登记的观察根直接返回。
      const root: Node = (n as any).getRootNode ? (n as any).getRootNode() : n;
      if (depthMap.has(root)) return depthMap.get(root)!;
      // 否则跨越 shadow 边界到 host 继续上爬(host 可能在更外层观察根内)。
      if (root instanceof ShadowRoot) { n = (root as ShadowRoot).host; continue; }
      return 0; // 已到 document 且未命中(理论不会发生,document 一定登记)
    }
    return 0;
  }

  // 递归为 root 及其内所有 shadowRoot 装 observer;depth 为 root 本身的 shadow 深度(document=0)。
  function observeAll(root: Node, depth: number): void {
    const mo = new MutationObserver(onMutate);
    mo.observe(root, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
    mos.push(mo);
    depthMap.set(root, depth);
    if (depth >= MAX_SHADOW_DEPTH) return; // 超深度不再下钻
    // 深度优先找 root 内带 shadowRoot 的元素,对其 shadowRoot 递归 observeAll。
    const hostEls = root instanceof Document || root instanceof ShadowRoot
      ? (root as any).querySelectorAll('*')
      : (root as Element).querySelectorAll?.('*') ?? [];
    for (const el of Array.from(hostEls)) {
      const sr = (el as Element).shadowRoot;
      if (sr) observeAll(sr, depth + 1);
    }
  }
  // 给一棵元素子树(运行时新增 host)内所有 shadowRoot 补装 observer;depth 用宿主所在观察根的深度。
  function observeShadowTree(el: Element, hostDepth: number): void {
    if (hostDepth >= MAX_SHADOW_DEPTH) return;
    const sr = (el as any).shadowRoot;
    if (sr) observeAll(sr, hostDepth + 1);
    const kids = el.querySelectorAll?.('*') ?? [];
    for (const k of Array.from(kids)) {
      const ksr = (k as Element).shadowRoot;
      if (ksr) observeAll(ksr, hostDepth + 1);
    }
  }

  observeAll(document, 0);
  (globalThis as any).__cdpFeedback = { mos, state: st };
}

/** 收尾反馈:断开 observer,把本次新增内容去重折叠 + 文本变化过滤,返回结构化结果。 */
export function collectFeedback(opts: { viewport?: boolean } = {}): FeedbackResult {
  const fb = (globalThis as any).__cdpFeedback;
  if (!fb) return { blocks: [], changes: [] };
  for (const mo of fb.mos as MutationObserver[]) mo.disconnect();
  (globalThis as any).__cdpFeedback = null;
  const { added, changes } = fb.state as FeedbackState;
  // 顶层新增元素:本次 addedNodes 中、没有元素祖先也在本次新增集合里的节点(去嵌套,避免父容器把整棵子树又算一遍)。
  // 祖先链穿透 shadow:parentElement 在 shadow 边界为 null,改走 composedPath 思路——沿 parentNode/host 上爬。
  const els = added.filter(n => n.nodeType === 1) as Element[];
  const set = new Set(els);
  const roots = els.filter(el => !hasAncestorInSet(el, set));
  // 不重置 __cdpRefs:反馈新增 ref 从现有长度递增,顶掉旧 ref 会丢整页句柄(曾踩坑)。
  // 逐块建树,按整块 lines 去重折叠(同内容多次出现,如广告,只留一条 + 计数)。
  const seen = new Map<string, FeedbackBlock>();
  const order: string[] = [];
  for (const el of roots) {
    const t = buildTree(el, { viewport: opts.viewport });
    markText(t);
    const blines = formatTree(t);
    if (!blines.length) continue;
    // 折叠签名去掉 ref 号(内容相同但 ref 不同的重复块应视为同一条,如重复广告)。
    const sig = blines.join('\n').replace(/\[ref=\d+(·屏)?\]/g, '');
    if (seen.has(sig)) { seen.get(sig)!.count++; }
    else { seen.set(sig, { lines: blines, count: 1 }); order.push(sig); }
  }
  const blocks = order.map(s => seen.get(s)!);
  // 文本变化:过滤"前后相同"(无实质变化,如广告原地刷新),只留真变化;去重取前 5。
  const seenCh = new Set<string>();
  const real: FeedbackChange[] = [];
  for (const c of changes) {
    if (c.before && c.before === c.after) continue;
    const key = c.before ? `${c.before}→${c.after}` : `·${c.after}`;
    if (seenCh.has(key)) continue;
    seenCh.add(key);
    real.push(c);
    if (real.length >= 5) break;
  }
  return { blocks, changes: real };
}

/** 沿 parentElement 上爬,穿透 shadow 边界(host),判定 el 的祖先是否在 set 内(顶层新增去嵌套用)。 */
function hasAncestorInSet(el: Element, set: Set<Element>): boolean {
  let n: Node | null = el.parentElement;
  while (n) {
    if (n.nodeType === 1 && set.has(n as Element)) return true;
    // shadow 边界:parentElement 为 null,但 rootNode 是 ShadowRoot 时跳到 host 继续。
    if ((n as any).parentElement) { n = (n as any).parentElement; continue; }
    const root = (n as any).getRootNode && (n as any).getRootNode();
    n = root && root instanceof ShadowRoot ? (root as ShadowRoot).host : null;
  }
  return false;
}
