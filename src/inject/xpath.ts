/**
 * xpath.ts — 按 xpath 查元素(注入入口,shadow 穿透,含分步诊断)。
 * 返回全部命中(带 tag/文本/selector)与逐位置步 trace,用于 cdp xpath 排查。
 */
import { setResult } from './lib/result';
import { xpathEval } from './lib/find-root';
import { genSel } from './lib/genSel';
import type { XpathArgs } from './lib/arg';

declare const __CDP_ARG__: XpathArgs;

/** 命中节点的可视文本:textContent 不含 shadow DOM 子树,命中 shadow 宿主时文本会空。
 * 有 shadowRoot 的宿主递归采集 light+shadow 全量文本(供 agent 分辨命中是谁);
 * 无 shadow 用原生 textContent(快)。 */
function visibleText(el: Element): string {
  if (!el.shadowRoot) return el.textContent || '';
  let s = '';
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) s += c.nodeValue ?? '';
      else if (c.nodeType === 1) { walk(c); if ((c as Element).shadowRoot) walk((c as Element).shadowRoot!); }
    }
  };
  walk(el);
  walk(el.shadowRoot!);
  return s;
}

(() => {
  const { count, nodes, value, trace } = xpathEval(__CDP_ARG__.path);
  // 注意:不用 ok 字段(未命中是合法结果,count===0 即代表未命中);
  // 避免 api.invoke 把 {ok:false} 误判为注入失败抛异常。
  const matches = nodes.slice(0, 20).map(el => {
    const text = visibleText(el).replace(/\s+/g, ' ').trim().slice(0, 80);
    return { tag: el.tagName.toLowerCase(), text, selector: genSel(el) };
  });
  // value:标量表达式(count()/算术/字面量)的结果;节点查询时为 null,此时只输出 matches。
  return setResult(value === null ? { count, matches, trace } : { count, value, matches, trace });
})();
