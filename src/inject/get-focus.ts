/**
 * get-focus.ts — 返回当前焦点元素(document.activeElement)信息(入口);无焦点返回 null。
 */
import { setResult } from './lib/result';
import { genSel } from './lib/genSel';

(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) return setResult(null);
  return setResult({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || (el as HTMLInputElement).value || '').trim().slice(0, 40) || undefined,
    id: el.id || undefined,
    selector: genSel(el),
  });
})();
