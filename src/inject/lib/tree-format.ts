/**
 * tree-format.ts — 结构树输出的纯变换(无 DOM 依赖,可在 Node 里单测)。
 * 输入是 simplify 从 DOM 采集成的一棵内部 TreeNode 树;这里把树折叠/内联成输出行数组。
 * 与 DOM 完全解耦,逻辑从旧 scripts.js / tree.js 逐字搬移,语义不变。
 */

import { inlineable, leafText, firstTxt, isTrivialLeaf } from './tree-utils.ts';

/** 内部节点:simplify(DOM 采集)的产物,也是 formatTree 的输入。字段与旧 tree.ts 的 interface Node 一一对应。 */
export interface TreeNode {
  tag: string; isContent: boolean; text: string; inter: boolean; imgAlt: string;
  kids: TreeNode[]; size: number; hasText: boolean; leafValue?: string;
  agg?: boolean;   // 显示文本来自 innerText/grabText 兜底(聚合文本)而非直接文本节点
  shadow?: boolean; // 宿主带 shadowRoot:其下子节点来自 shadow DOM,CSS 选择器不能穿透,须用 xpath 定位
}

/** tag 输出,宿主带 shadowRoot 时追加 [shadow],提示该子树在 shadow DOM 内。 */
const tagLabel = (n: TreeNode) => n.tag + (n.shadow ? '[shadow]' : '');

/** 标记节点是否有可视文本(自身 text/imgAlt 或任一后代)。返回根节点结果。 */
export function markText(n: TreeNode): boolean {
  let h = !!(n.text || n.imgAlt);
  for (const k of n.kids) if (markText(k)) h = true;
  n.hasText = h;
  return h;
}

/**
 * 把已建好的 TreeNode 树折叠成带缩进的输出行数组(标签 + 引用文本)。与旧 tree.js 的
 * leafish / leafLabel / inlineLabel / walk 及末尾 push(tree.tag...) + for-walk 调用逐字一致。
 */
export function formatTree(tree: TreeNode): string[] {
  const out: string[] = [];
  const leafish = (n: TreeNode) => n.inter || n.tag === 'img';
  const leafLabel = (n: TreeNode) => {
    let l = tagLabel(n);
    if (n.tag === 'img' && n.imgAlt) l += ' "' + n.imgAlt.slice(0, 40) + '"';
    else if (n.text) l += (n.agg ? ' ~' : ' ') + '"' + n.text.slice(0, 60) + '"';
    return l;
  };
  const inlineLabel = (n: TreeNode) => {
    if (n.tag === 'img' && n.imgAlt) return 'img "' + n.imgAlt.slice(0, 20) + '"';
    if (n.leafValue) { const v = firstTxt(n.kids); return '"' + n.leafValue + (v ? ' ' + v : '') + '"'; }
    return (n.agg ? '~' : '') + '"' + leafText(n).slice(0, 24) + '"';
  };

  function walk(n: TreeNode, depth: number, path: string[]) {
    if (n.isContent) {
      if (n.leafValue) {
        const val = firstTxt(n.kids);
        const head = path.length ? path.join(' > ') + ' > ' : '';
        out.push('  '.repeat(depth) + head + '"' + n.leafValue + (val ? ' ' + val.slice(0, 60) : '') + '"');
        return;
      }
      const hasChildText = n.kids.some(k => k.hasText);
      if (leafish(n) && n.size <= 8) {
        if (n.text || n.imgAlt) out.push('  '.repeat(depth) + leafLabel(n));
        return;
      }
      if (!hasChildText) {
        if (n.tag === 'span') {
          if (n.text) {
            const head = path.length ? path.join(' > ') : '';
            out.push('  '.repeat(depth) + (head ? head + ' ' : '') + '"' + n.text.slice(0, 60) + '"');
          }
          return;
        }
        const line = '  '.repeat(depth) + (path.length ? path.join(' > ') + ' > ' : '') + leafLabel(n);
        out.push(line);
        return;
      }
    }
    const kids = n.kids;
    if (!kids.length) return;
    const newPath = path.concat([tagLabel(n)]);
    const productive = kids.filter(k => k.hasText && !isTrivialLeaf(k));
    if (productive.length === 1) { walk(productive[0], depth, newPath); return; }
    if (productive.length >= 2) {
      if (productive.every(inlineable)) {
        const items = productive.map(inlineLabel).join(' ');
        out.push('  '.repeat(depth) + (newPath.length ? newPath.join(' > ') + ' ' : '') + items);
        return;
      }
      if (newPath.length) out.push('  '.repeat(depth) + newPath.join(' > '));
      for (const k of productive) walk(k, depth + 1, []);
    }
  }

  out.push(tagLabel(tree) + (tree.text ? ' "' + tree.text.slice(0, 60) + '"' : ''));
  for (const k of tree.kids) walk(k, 1, []);
  return out;
}
