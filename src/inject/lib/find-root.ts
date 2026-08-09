/**
 * find-root.ts — 从 selector 求建树根元素 + ref 解析(注入侧,无 Node 依赖)。
 * 被 tree / locate / 操作动作入口复用。xpath 已退役,定位只走 selector + ref。
 */

/** __cdpRefs 槽位形态:tree 登记的是 {el, parentRef}(ref 自愈后最终形态);兼容过渡期的纯 Element[]。 */
export type RefEntry = { el: Element; parentRef: number | null } | Element;

/** 取 __cdpRefs 数组(可能为 undefined / 空)。 */
export function getRefs(): RefEntry[] | undefined {
  return (globalThis as any).__cdpRefs as RefEntry[] | undefined;
}

/** entry 取元素(兼容 {el,parentRef} 与裸 Element 两种形态)。 */
export function entryEl(entry: RefEntry | undefined): Element | undefined {
  if (!entry) return undefined;
  return entry instanceof Element ? entry : entry.el;
}

/** entry 取 parentRef(裸 Element 形态无 parentRef,视作根 → null)。 */
export function entryParent(entry: RefEntry | undefined): number | null {
  if (!entry || entry instanceof Element) return null;
  return entry.parentRef ?? null;
}

/** ref 失效自愈的分类(纯逻辑,无 DOM 调用,可单测):
 *  - 'none':无登记表(整页未 tree 过 / 已清空),无可恢复。
 *  - 'never':ref 越界或该槽从未登记(agent 打错号),不走跳表自愈。maxRef 给文案核对。
 *  - 'live':曾登记,需沿 parentRef 链找首个仍 connected 的祖先。start=起始跳表号。 */
export type RefClass =
  | { kind: 'none' }
  | { kind: 'never'; maxRef: number }
  | { kind: 'live'; start: number; maxRef: number };

export function classifyRef(ref: number): RefClass {
  const refs = getRefs();
  if (!refs || !refs.length) return { kind: 'none' };
  const maxRef = refs.length - 1;
  if (ref < 0 || ref > maxRef || !refs[ref]) return { kind: 'never', maxRef };
  return { kind: 'live', start: ref, maxRef };
}

/**
 * 求建树根元素:selector 命中返回首个元素,否则 body。
 * selector 未命中返回 null(由调用方决定是否报错)。
 *
 * 支持 shadow 链:`a >>> b >>> c`。`>>>` 是本工具自定义的 shadow 穿透分隔符(非标准 CSS),
 * 由 locate 对 shadow 内元素生成,让 `tree --selector-file` 能复用。解析方式:
 *   第一段在 document 上 querySelector;之后每段在前一段元素的 shadowRoot 上 querySelector,
 *   逐层穿透(标准 CSS 无法跨 shadow 边界)。任一段未命中 / host 无 shadowRoot → null。
 */
export function findRoot(selector?: string): Element | null {
  if (!selector) return document.body;
  const parts = selector.split('>>>').map(s => s.trim());
  if (parts.length === 1) return document.querySelector(parts[0]);
  // shadow 链:逐段穿透 shadowRoot
  let node: any = document.querySelector(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    if (!node || !node.shadowRoot) return null;
    node = node.shadowRoot.querySelector(parts[i]);
  }
  return node ?? null;
}

/**
 * 按 tree 输出的 ref 序号取真实元素(ref 存于 window.__cdpRefs,会话句柄)。
 * 页面刷新后 __cdpRefs 随 document 重建而清空,此时返回 null(ref 失效)。
 * tree / locate 共用同一解析:先取 ref 元素,再 climbAncestors 爬到目标容器。
 */
export function refElement(ref: number): Element | null {
  const arr = (globalThis as any).__cdpRefs;
  const entry = arr && arr[ref];
  // 兼容两种登记表形态:纯 Element[](过渡)或 {el, parentRef}(ref 自愈后的最终形态)。
  const el = entry && (entry.el ?? entry);
  return el && el.nodeType === 1 ? (el as Element) : null;
}

/**
 * 从元素向上爬 ancestor 层父级(默认 0 = 不爬,返回自身)。
 * 用来把"内容叶子的 ref"抬升到"语义区域容器"——纯包装容器本身无 ref,只能从叶子往上爬。
 * 遇无父元素(html 或 shadow 边界)即停。
 */
export function climbAncestors(el: Element | null, ancestor = 0): Element | null {
  let e = el;
  for (let i = 0; i < ancestor; i++) if (e && e.parentElement) e = e.parentElement;
  return e;
}
