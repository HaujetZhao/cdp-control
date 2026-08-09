/**
 * ref.ts — locate 注入入口:按 tree 的 ref 序号反查稳定 CSS selector。
 * ref 是会话句柄(存 window.__cdpRefs),页面刷新后失效;此命令把 ref 翻译成
 * 刷新后仍可用的 CSS selector,供 tree --selector-file 复用。
 * 可选 --ancestor 向上爬 N 层父级,把"内容叶子的 ref"抬升到"语义区域容器"。
 */
import { setResult } from './lib/result';
import { refElement, climbAncestors } from './lib/find-root';
import { genSel } from './lib/genSel';
import { notFoundResult, type OperableArg } from './lib/find';
import type { LocateArgs } from './lib/arg';

declare const __CDP_ARG__: LocateArgs;

(() => {
  const base = refElement(__CDP_ARG__.ref);
  if (!base) return setResult(notFoundResult({ ref: __CDP_ARG__.ref } as OperableArg));
  const el = climbAncestors(base, __CDP_ARG__.ancestor || 0);
  if (!el) return setResult({ ok: false, err: `ref=${__CDP_ARG__.ref} 向上爬 ${__CDP_ARG__.ancestor || 0} 层后无元素` });
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return setResult({ ok: true, tag: el.tagName.toLowerCase(), text, selector: genSel(el) });
})();
