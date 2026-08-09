/**
 * find-root.ts — 从 selector 求建树根元素 + ref 解析(注入侧,无 Node 依赖)。
 * 被 tree / locate / 操作动作入口复用。xpath 已退役,定位只走 selector + ref。
 */

/**
 * 求建树根元素:selector 命中返回首个元素,否则 body。
 * selector 未命中返回 null(由调用方决定是否报错)。
 */
export function findRoot(selector?: string): Element | null {
  if (selector) return document.querySelector(selector);
  return document.body;
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
