/**
 * xpath.ts — 按 xpath 查元素(注入入口,shadow 穿透,含分步诊断)。
 * 返回全部命中(带 tag/文本/selector)与逐位置步 trace,用于 cdp xpath 排查。
 */
import { setResult } from './lib/result';
import { xpathEval } from './lib/find-root';
import { genSel } from './lib/genSel';
import type { XpathArgs } from './lib/arg';

declare const __CDP_ARG__: XpathArgs;

(() => {
  const { ok, count, nodes, trace } = xpathEval(__CDP_ARG__.path);
  const matches = nodes.slice(0, 20).map(el => {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return { tag: el.tagName.toLowerCase(), text, selector: genSel(el) };
  });
  return setResult({ ok, count, matches, trace });
})();
