/**
 * hover.ts — 鼠标移到指定 selector 元素中心(入口)。参数:__CDP_ARG__.sel。
 * 返回元素中心的视口坐标(Node 侧据此 dispatchMouseEvent)。元素不存在返回 {ok:false}。
 */
import { setResult } from './lib/result';
import { findTarget, targetLabel } from './lib/find';
import type { FindArgs } from './lib/arg';

declare const __CDP_ARG__: FindArgs;

(() => {
  const el = findTarget(__CDP_ARG__) as HTMLElement | null;
  if (!el) return setResult({ ok: false, err: '未找到: ' + targetLabel(__CDP_ARG__) });
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return setResult({
    ok: true,
    x: Math.round(r.x + r.width / 2),
    y: Math.round(r.y + r.height / 2),
  });
})();
