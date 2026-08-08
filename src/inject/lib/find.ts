/**
 * find.ts — 注入侧操作目标解析(click/fill/focus/hover 共享)。
 * 优先按 ref(tree 登记的全局真实元素引用,可穿透 shadow DOM);否则按 CSS selector。
 * ref 的取法:window.__cdpRefs 是 tree 遍历时登记的引用数组,index 即 tree 输出的 [ref=i]。
 */

export interface OperableArg { sel?: string; ref?: number }

/** 解析操作目标:ref 命中返回登记的真实元素;否则 document.querySelector(sel)。找不到返回 null。 */
export function findTarget(arg: OperableArg): Element | null {
  if (arg.ref != null) {
    const refs = (globalThis as any).__cdpRefs;
    const el = refs ? refs[arg.ref] : undefined;
    return el instanceof Element ? el : null;
  }
  return arg.sel ? document.querySelector(arg.sel) : null;
}

/** 目标描述(错误/日志用):ref=12 或 sel=<selector>。 */
export function targetLabel(arg: OperableArg): string {
  return arg.ref != null ? 'ref=' + arg.ref : (arg.sel ?? '');
}
