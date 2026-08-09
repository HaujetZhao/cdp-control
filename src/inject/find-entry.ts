/**
 * find-entry.ts — find 命令注入入口(类 uBlock `:has-text()` 思想)。
 *
 * agent 的痛点:整页 tree 输出严禁 grep(SKILL 铁律),但 ref 又会随每次 tree 重排失效。
 * 想重新定位某个文本元素(如"28 条评论"按钮)时,只能整页 tree 再肉眼找——既费 token 又违规。
 * find 弥补:直接按文本/selector 找元素,登记新 ref 返回,不必整页重 tree。
 *
 * 两种匹配:
 *   1. --text <关键词>:在整页(穿透 shadow)DFS,命中"自身或后代文本含关键词"的元素,
 *      用 tree-core 的 subtreeText(穿透 shadow 取子树文本)比对。
 *   2. --selector <css>:document.querySelector(支持 `>>>` shadow 链,复用 findRoot)。
 *
 * 命中元素登记进 __cdpRefs(**追加**,不重置——保留整页旧 ref),拿 ref 号;buildTree 该元素
 * 取根行输出(把根节点 ref 标成 push 拿到的号,formatTree 自动输出 [ref=N])。
 * --text + --all:收集全部命中并各自登记;否则首个。
 * --ancestor:命中后向上爬 N 层到容器(把内容叶子抬到区域容器,与 tree/locate 一致)。
 *
 * 性能 sanity:深度上限(防深层 shadow 爆炸)、单节点 subtreeText 长度上限(截断后比对)。
 */
import { setResult } from './lib/result';
import { findRoot, climbAncestors } from './lib/find-root';
import { childrenOf, subtreeText, strip } from './lib/tree-core';
import { buildTree } from './lib/tree-core';
import { markText, formatTree } from './lib/tree-format';
import type { FindCmdArgs } from './lib/arg';

declare const __CDP_ARG__: FindCmdArgs;

const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'SVG', 'PATH', 'BR']);
const MAX_DEPTH = 14;      // DFS 深度上限(含深层 shadow 嵌套,防爆炸)
const TEXT_LIMIT = 4000;   // 单节点 subtreeText 截断上限(防巨型文本节点拖慢比对)

/** 把命中元素登记进 __cdpRefs(追加),返回 ref 号。parentRef=null:find 出的元素独立,无跳表父。 */
function registerHit(el: Element): number {
  const refs = (globalThis as any).__cdpRefs || ((globalThis as any).__cdpRefs = []);
  refs.push({ el, parentRef: null });
  return refs.length - 1;
}

/** 取命中元素的 line(formatTree 根行,标上分配的 ref 号)。 */
function lineOf(el: Element, ref: number): string {
  const tree = buildTree(el, { viewport: true });
  tree.ref = ref; // 根节点标上分配的 ref,formatTree 输出 [ref=N·屏?]
  markText(tree);
  const lines = formatTree(tree);
  return lines[0] || `${el.tagName.toLowerCase()} [ref=${ref}]`;
}

/** 文本命中:元素或后代文本(穿透 shadow)含关键词(substring 比对,大小写敏感)。 */
function textMatches(el: Element, needle: string): boolean {
  if (!needle) return false;
  const t = subtreeText(el);
  // 截断防巨型文本节点拖慢(超长文本节点命中关键词多半也在前段)。
  return (t.length > TEXT_LIMIT ? t.slice(0, TEXT_LIMIT) : t).includes(needle);
}

/** DFS(穿透 shadow)收集所有文本命中元素。限深度防深层 shadow 爆炸。 */
function searchText(root: Element, needle: string): Element[] {
  const hits: Element[] = [];
  const visited = new Set<any>(); // 防环/防 shadow 重入
  const walk = (node: Element | ShadowRoot, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (visited.has(node)) return;
    visited.add(node);
    // ShadowRoot 自身不参与匹配(无标签);只对其 light 子 + shadow 子递归
    if (node instanceof Element) {
      if (!DROP_TAGS.has(node.tagName) && textMatches(node, needle)) {
        hits.push(node);
        return; // 命中即止:不再深入其子(避免父子重复命中占满结果)
      }
    }
    for (const c of childrenOf(node as Element)) walk(c, depth + 1);
  };
  walk(root, 0);
  return hits;
}

(() => {
  const a = __CDP_ARG__;
  if (!a.text && !a.selector) return setResult({ ok: false, err: '需提供 --text 或 --selector' });

  let hits: Element[] = [];
  if (a.selector) {
    const el = findRoot(a.selector);
    if (el) hits = [el];
  } else {
    hits = searchText(document.body, a.text!);
  }
  if (!hits.length) {
    return setResult({ ok: false, err: a.selector ? `selector 未命中: ${a.selector}` : `未找到含文本的元素: "${a.text}"` });
  }

  // --all 收集全部;否则首个
  const picked = a.all ? hits : [hits[0]];
  const out = picked.map(el => {
    const target = climbAncestors(el, a.ancestor || 0) || el;
    const ref = registerHit(target);
    const tag = target.tagName.toLowerCase();
    const text = strip((target.textContent || '').replace(/\s+/g, ' ')).slice(0, 60);
    return { ref, tag, text, line: lineOf(target, ref) };
  });
  return setResult({ ok: true, hits: out });
})();
