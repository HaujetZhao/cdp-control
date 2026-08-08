/**
 * focus.ts — 聚焦指定 selector 元素(入口)。参数:__CDP_ARG__.sel。
 */
import { setResult } from './lib/result';
import { findTarget, findErrMsg } from './lib/find';
import { genSel } from './lib/genSel';
import type { FindArgs } from './lib/arg';

declare const __CDP_ARG__: FindArgs;

(() => {
  const el = findTarget(__CDP_ARG__) as HTMLElement | null;
  if (!el) return setResult({ ok: false, err: findErrMsg(__CDP_ARG__) });
  el.focus();
  return setResult({ ok: true, tag: el.tagName.toLowerCase(), selector: genSel(el) });
})();
