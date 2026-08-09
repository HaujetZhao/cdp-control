/**
 * find.ts — 注入侧操作目标解析(click/fill/focus/hover 共享)+ ref 失效自愈。
 * 优先按 ref(tree 登记的全局真实元素引用,可穿透 shadow DOM);否则按 CSS selector。
 * ref 的取法:window.__cdpRefs 是 tree 遍历时登记的引用数组,index 即 tree 输出的 [ref=i]。
 * --ancestor:按 ref 定位后向上爬 N 层父级再操作(把内容叶子抬到语义区域容器)。
 */
import { climbAncestors } from './find-root';
import { buildTree } from './tree-core';
import { markText, formatTree } from './tree-format';

export interface OperableArg { sel?: string; ref?: number; ancestor?: number }

type RefEntry = { el: Element; parentRef: number | null };

/** 解析操作目标:ref 命中返回登记的真实元素(可选再爬 ancestor 层);否则 document.querySelector(sel)。找不到返回 null。 */
export function findTarget(arg: OperableArg): Element | null {
  if (arg.ref != null) {
    const refs = (globalThis as any).__cdpRefs as RefEntry[] | Element[] | undefined;
    const entry = refs ? refs[arg.ref] : undefined;
    // 兼容两种登记表形态:纯 Element[](过渡/手塞)或 {el, parentRef}。
    const el = entry instanceof Element ? entry : entry?.el;
    if (!(el instanceof Element)) return null;
    return climbAncestors(el, arg.ancestor || 0);
  }
  return arg.sel ? document.querySelector(arg.sel) : null;
}

/** 目标描述(错误/日志用):ref=12(或 ref=12↑3)或 sel=<selector>。 */
export function targetLabel(arg: OperableArg): string {
  if (arg.ref != null) return 'ref=' + arg.ref + (arg.ancestor ? `↑${arg.ancestor}` : '');
  return (arg.sel ?? '');
}

/** 找不到目标时的结果:ref 失效→自愈(沿 parentRef 跳表找最近存活祖先,局部 tree 给 agent 用新 ref 重试);
 * selector 未命中→普通错误。 */
export function notFoundResult(arg: OperableArg): any {
  if (arg.ref != null) return { ok: false, refInvalid: true, recovered: recoverRef(arg.ref) };
  return { ok: false, err: '未找到: ' + targetLabel(arg) };
}

/**
 * ref 失效自愈:沿 __cdpRefs[i].parentRef 跳表向上找首个仍 connected 的祖先,
 * 以它为根做局部 tree(增量 ref,不重置全局表——复用反馈机制,原整页 ref 不受影响),
 * 返回 {rootRef, lines} 供 agent 用新 ref 重试。整链都失效(页面刷新)返回 null。
 */
export function recoverRef(ref: number): { rootRef: number; lines: string[] } | null {
  const refs = (globalThis as any).__cdpRefs as RefEntry[] | undefined;
  if (!refs) return null;
  let cur: number | null = ref;
  let guard = 0;
  while (cur != null && guard++ < 9999) {
    const entry = refs[cur] as RefEntry | undefined;
    const el: Element | undefined = entry instanceof Element ? entry : entry?.el;
    if (el instanceof Element && el.isConnected) {
      const t = buildTree(el, { viewport: true });
      markText(t);
      return { rootRef: cur, lines: formatTree(t) };
    }
    cur = entry?.parentRef ?? null;
  }
  return null;
}
