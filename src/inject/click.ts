/**
 * click.ts — 点击指定 selector 元素(入口)。参数:__CDP_ARG__.sel。
 */
import { setResult } from './lib/result';
import { findTarget, notFoundResult } from './lib/find';
import { genSel } from './lib/genSel';
import type { FindArgs } from './lib/arg';

declare const __CDP_ARG__: FindArgs;

(() => {
  const el = findTarget(__CDP_ARG__) as HTMLElement | null;
  if (!el) return setResult(notFoundResult(__CDP_ARG__));
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.click();
  // 附唯一 selector:后续对该元素操作优先用 selector 而非 ref,避免 ref 重渲染失效。
  return setResult({ ok: true, tag: el.tagName.toLowerCase(), selector: genSel(el) });
})();
