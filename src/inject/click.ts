/**
 * click.ts — 点击指定 selector 元素(入口)。参数:__CDP_ARG__.sel。
 */
import { setResult } from './lib/result';
import type { FindArgs } from './lib/arg';

declare const __CDP_ARG__: FindArgs;

(() => {
  const el = document.querySelector(__CDP_ARG__.sel) as HTMLElement | null;
  if (!el) return setResult({ ok: false, err: '未找到: ' + __CDP_ARG__.sel });
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.click();
  return setResult({ ok: true, tag: el.tagName.toLowerCase() });
})();
