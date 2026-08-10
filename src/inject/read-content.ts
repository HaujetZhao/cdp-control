/**
 * read-content.ts — 展开再读的容器定位注入入口(同步):按 `container` selector 重查正文容器,
 * 末尾追加登记进 __cdpRefs(展开常重渲染替换容器元素、旧 ref 失效),返回新 ref 供 Node 侧 article 取全文。
 *
 * **为何纯同步、不含点击/等待**:展开点击若在本 eval 内再 `await setTimeout`,会与
 * Runtime.evaluate 的 awaitPromise 交互而卡死(实测 zhihu 展开点击)。故点击(同步 eval 先返回)、
 * Node 侧 sleep、再本入口重查,三者分开——各自同步、互不阻塞。
 *
 * 展开重渲染替换容器 → 每次重查按 selector 命中新元素,末尾追加(append 不平移既有号,同 find-entry)。
 * 折叠判定(要不要展开)仍由 recipe 决定,入口只保证"给定容器 selector 拿到它的稳定 ref"。
 */
import { setResult } from './lib/result';
import { findRoot } from './lib/find-root';
import type { ReadContentArgs } from './lib/arg';

declare const __CDP_ARG__: ReadContentArgs;

(() => {
  const el = findRoot(__CDP_ARG__.container);
  if (!el) return setResult({ ok: false, err: `read: 未找到容器: ${__CDP_ARG__.container}` });
  // 容器 ref:已在树则复用;展开重渲染的新元素则末尾追加(append 不平移已有 ref,同 find-entry)。
  const refs = (globalThis as any).__cdpRefs;
  let idx = -1;
  if (refs && Array.isArray(refs)) {
    idx = refs.findIndex((r: any) => r && (r.el ?? r) === el);
    if (idx < 0) { idx = refs.length; refs.push({ el, parentRef: null }); }
  }
  return setResult({ ok: true, ref: idx < 0 ? null : idx, tag: el.tagName.toLowerCase() });
})();
