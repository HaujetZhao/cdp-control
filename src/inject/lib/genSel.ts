/**
 * genSel.ts — 为 DOM 元素生成唯一选择器 / 绝对 xpath。
 * 被 get-focus / xpath / locate 复用,打包打进各入口。
 * genXpath 仅覆盖 light DOM(shadow 内元素的 parentElement 在 shadow 边界为 null,路径断)。
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

/**
 * 生成绝对 xpath(/html/body/div[1]/div[2]/…),每步 tag + 兄弟序号(1 基)。
 * 与 DevTools "Copy full XPath" 同构,喂回 tree --xpath-file 可定位同一元素(刷新后仍可用)。
 * 局限:shadow DOM 内元素 parentElement 在边界为 null,路径断在该处;已知可接受。
 */
export function genXpath(el: Element | null): string {
  if (!el) return '';
  const parts: string[] = [];
  let cur: Element = el;
  for (;;) {
    const parent: Element | null = cur.parentElement;
    if (!parent) { parts.unshift(cur.tagName.toLowerCase()); break; } // 顶层(html)不带序号
    // xpath `tag[n]` 语义是"同名兄弟序号"(跳过中间其它标签),不是"第 n 个元素子"。
    const same = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
    const idx = same.indexOf(cur) + 1;
    parts.unshift(`${cur.tagName.toLowerCase()}[${idx}]`);
    cur = parent;
  }
  return '/' + parts.join('/');
}
