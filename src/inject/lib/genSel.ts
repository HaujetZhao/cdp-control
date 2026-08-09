/**
 * genSel.ts — 为 DOM 元素生成唯一 CSS 选择器。
 * 被 get-focus / locate 复用,打包打进各入口。
 * 仅覆盖 light DOM(shadow 内元素的 parentElement 在 shadow 边界为 null,路径断在 host 锚定)。
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
