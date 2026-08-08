/**
 * genSel.ts — 为 DOM 元素生成唯一选择器(优先 id,否则 tag:nth-of-type 路径)。
 * 被 snapshot / get-focus / outline 复用,打包打进各入口。
 */

/** 生成唯一 CSS 选择器;无效元素返回 null。 */
export function genSel(el: Element | null): string | null {
  if (!el) return null;
  if (el.id) return '#' + CSS.escape(el.id);
  const path: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1) {
    if (cur.id) { path.unshift('#' + CSS.escape(cur.id)); break; }
    let part = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const sibs = Array.from(parent.children).filter(c => c.tagName === cur!.tagName);
      if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
    }
    path.unshift(part);
    cur = parent;
  }
  return path.join(' > ');
}
