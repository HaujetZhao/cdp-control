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
  const { count, nodes, value, trace } = xpathEval(__CDP_ARG__.path);
  // 注意:不用 ok 字段(未命中是合法结果,count===0 即代表未命中);
  // 避免 api.invoke 把 {ok:false} 误判为注入失败抛异常。
  const matches = nodes.slice(0, 20).map(el => {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return { tag: el.tagName.toLowerCase(), text, selector: genSel(el) };
  });
  // value:标量表达式(count()/算术/字面量)的结果;节点查询时为 null,此时只输出 matches。
  return setResult(value === null ? { count, matches, trace } : { count, value, matches, trace });
})();
