/**
 * find-entry.ts — find 命令注入入口(类 uBlock `:has-text()` 思想,但语义更贴合 agent 找元素)。
 *
 * agent 的痛点:整页 tree 输出严禁 grep(SKILL 铁律),但 ref 又会随每次 tree 重排失效。
 * 想重新定位某个文本元素(如"28 条评论"按钮)时,只能整页 tree 再肉眼找——既费 token 又违规。
 * find 弥补:直接按文本/selector 找元素,登记新 ref 返回,不必整页重 tree。
 *
 * 两种匹配:
 *   1. --text <关键词>:在整页(穿透 shadow)DFS,命中"**元素自身直接文本**(ownElText,只取直接
 *      子文本节点)含关键词"的元素。注意不是子树文本(subtreeText)——后者会让最外层容器先命中
 *      (body 几乎含所有文本),agent 拿到的是祖先 div 而非"首页"那个 a 标签。用自身文本才能命中
 *      最具体的有文本元素(按钮/链接/文本节点)。uBlock `:has-text()` 是子树匹配(用于折叠容器),
 *      这里反过来要找具体元素,故用自身文本。
 *   2. --selector <css>:document.querySelector(支持 `>>>` shadow 链,复用 findRoot)。
 *
 * 命中元素登记进 __cdpRefs(**追加**,不重置——保留整页旧 ref),拿 ref 号;buildTree 该元素
 * 取根行输出(把根节点 ref 标成 push 拿到的号,formatTree 自动输出 [ref=N])。
 * --text + --all:收集全部命中并各自登记;否则首个。
 * --ancestor:命中后向上爬 N 层到容器(把内容叶子抬到区域容器,与 tree/locate 一致)。
 *
 * 性能 sanity:深度上限防深层 shadow 爆炸。
 */
import { setResult } from './lib/result';
import { findRoot, climbAncestors } from './lib/find-root';
import { childrenOf, ownElText } from './lib/tree-core';
import { buildTree } from './lib/tree-core';
import { markText, formatTree } from './lib/tree-format';
import type { FindCmdArgs } from './lib/arg';

declare const __CDP_ARG__: FindCmdArgs;

const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'SVG', 'PATH', 'BR']);
const MAX_DEPTH = 14;      // DFS 深度上限(含深层 shadow 嵌套,防爆炸)

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

/** 文本命中:元素**自身直接文本**(ownElText,只取直接子文本节点,空白归一化)含关键词。
 * 用自身文本而非子树文本,才能命中"首页"那个 a 标签而非包含它的祖先 div。 */
function textMatches(el: Element, needle: string): boolean {
  if (!needle) return false;
  return ownElText(el).includes(needle);
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
        return; // 命中即止:不再深入其子(自身文本命中的是最具体元素,子树里若还有同文本更深元素由 --all 另寻)
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
    // text 用元素自身直接文本(与 locate 一致,不子树聚合)
    const text = ownElText(target).slice(0, 60);
    return { ref, tag, text, line: lineOf(target, ref) };
  });
  return setResult({ ok: true, hits: out });
})();
