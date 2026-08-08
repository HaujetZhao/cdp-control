/**
 * snapshot.ts — 提取可交互元素清单(入口)。返回带标签/文本/选择器/坐标的数组,最多 300 条。
 */
import { setResult } from './lib/result';
import { genSel } from './lib/genSel';

(() => {
  const seen = new Set();
  const out: any[] = [];
  const sel = 'a, button, input, textarea, select, summary, [role=button], [role=link], [role=checkbox], [role=radio], [onclick], [tabindex]';
  const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
  for (const el of els) {
    if (seen.has(el)) continue;
    seen.add(el);
    const e = el as any; // 元素跨度大(a/button/input/...),用 any 访问各自特有属性
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (e.disabled) continue;
    const text = (e.innerText || e.value || el.getAttribute('aria-label') || el.title || e.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!text && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') continue;
    out.push({
      tag: el.tagName.toLowerCase(), text,
      href: e.href || undefined, type: e.type || undefined,
      placeholder: e.placeholder || undefined, checked: e.checked ?? undefined,
      selector: genSel(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  return setResult(out.slice(0, 300));
})();
