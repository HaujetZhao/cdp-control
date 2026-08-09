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
  shadow?: boolean; // 宿主带 shadowRoot:其下子节点来自 shadow DOM,CSS 选择器不能穿透,须用 ref 定位
  ref?: number;    // tree 登记的全局引用序号(见 __cdpRefs),输出标注 [ref=i],agent 用它直接操作真实元素
  fold?: string;   // 命中折叠规则:输出一行 ▸ [ref=i] <备注>,不展开子树(但保留 ref,tree --ref i 可展开)
  hasInter?: boolean; // 自身或任一后代可交互——含交互子代的包装节点不可内联折叠,否则交互叶的 ref 被整颗吞掉
  inView?: boolean; // visible-only:自身是否落在当前视口内且可见(仅 Element 计算;包装节点不查)
  view?: boolean;   // viewport 标记:带 ref 的节点是否在当前视区内(便宜判定,rect+宽高,不查 computed style)。true → 输出 [ref=i·屏]
}

/** tag 输出,宿主带 shadowRoot 时追加 [shadow],提示该子树在 shadow DOM 内。 */
const tagLabel = (n: TreeNode) => n.tag + (n.shadow ? '[shadow]' : '');

/** 可操作标注:节点登记过 ref 时追加 [ref=i],agent 据此直接操作真实元素;n.view 为 true 时追加 ·屏(在当前视区)。 */
const refTag = (n: TreeNode) => (n.ref != null ? ' [ref=' + n.ref + (n.view ? '·屏' : '') + ']' : '');

/** 标记节点是否有可视文本(自身 text/imgAlt 或任一后代),并顺带计算 hasInter(自身或任一后代可交互)。
 * 返回根节点"是否有文本"结果。hasInter 用于内联折叠判断:含交互子代的包装节点不能折叠,否则交互叶的 ref 丢失。 */
export function markText(n: TreeNode): boolean {
  let h = !!(n.text || n.imgAlt);
  let hi = !!n.inter;
  for (const k of n.kids) { if (markText(k)) h = true; if (k.hasInter) hi = true; }
  n.hasText = h;
  n.hasInter = hi;
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
    return l + refTag(n);
  };
  const inlineLabel = (n: TreeNode) => {
    if (n.tag === 'img' && n.imgAlt) return 'img "' + n.imgAlt.slice(0, 20) + '"';
    if (n.leafValue) {
      const v = firstTxt(n.kids);
      // leafValue 与后代首文本相同时去重(title 兜底值==子 <a> 直接文本,如 B站视频卡片),否则拼成 "X X" 重复。
      const tail = v && v !== n.leafValue ? ' ' + v : '';
      return '"' + n.leafValue + tail + '"';
    }
    return (n.agg ? '~' : '') + '"' + leafText(n).slice(0, 24) + '"';
  };

  function walk(n: TreeNode, depth: number, path: string[]) {
    // 折叠节点:输出一行带备注的折叠标识 + ref,不展开子树(子树里的嵌套折叠在 tree --ref i 展开时才显现)。
    if (n.fold != null) {
      out.push('  '.repeat(depth) + '▸ [ref=' + n.ref + '] ' + n.fold + (n.shadow ? '[shadow]' : ''));
      return;
    }
    // 整页 tree 对带 shadowRoot 的 host(depth>0 子节点,已登记 ref)只输出占位行,不展开其 shadow 子树
    // ——深入 shadow 用 `tree --ref N` / `--selector-file`(局部 tree 时该 host 是根 depth=0,正常展开)。
    if (depth > 0 && n.shadow && n.ref != null) {
      out.push('  '.repeat(depth) + tagLabel(n) + refTag(n));
      return;
    }
    if (n.isContent) {
      if (n.leafValue) {
        const val = firstTxt(n.kids);
        const head = path.length ? path.join(' > ') + ' > ' : '';
        // leafValue 与后代首文本相同去重,避免 "X X"(B站视频卡片 H3[title]>a)。
        const tail = val && val !== n.leafValue ? ' ' + val.slice(0, 60) : '';
        out.push('  '.repeat(depth) + head + '"' + n.leafValue + tail + '"' + refTag(n));
        return;
      }
      const hasChildText = n.kids.some(k => k.hasText);
      if (leafish(n) && n.size <= 8) {
        // 交互节点(含空 input)无文本也输出裸标签行——否则 fill 目标在 tree 里不可见、ref 拿不到
        if (n.text || n.imgAlt || n.inter) out.push('  '.repeat(depth) + leafLabel(n));
        return;
      }
      if (!hasChildText) {
        if (n.tag === 'span') {
          if (n.text) {
            const head = path.length ? path.join(' > ') : '';
            out.push('  '.repeat(depth) + (head ? head + ' ' : '') + '"' + n.text.slice(0, 60) + '"' + refTag(n));
          }
          return;
        }
        const line = '  '.repeat(depth) + (path.length ? path.join(' > ') + ' > ' : '') + leafLabel(n);
        out.push(line);
        return;
      }
      // 自身直接文本 + 文本子节点并存(富文本段落,如知乎 <p>own<span>nested</span></p>):
      // 下方 productive 折叠/走子只输出子节点、把自身文本整段吞掉——先把它作为本节点文本行保住。
      if (n.text) {
        const head = path.length ? path.join(' > ') + ' ' : '';
        out.push('  '.repeat(depth) + head + '"' + n.text.slice(0, 60) + '"' + refTag(n));
      }
    }
    const kids = n.kids;
    if (!kids.length) return;
    const newPath = path.concat([tagLabel(n)]);
    // productive = 有文本且非琐碎叶,或可交互,或折叠节点,或带 ref 的 shadow host
    // (后两者 hasText/inter 都 false,需显式纳入才能 walk 到占位/▸ 输出;空壳 shadow host 不纳入就会从整页 tree 消失)
    const productive = kids.filter(k => (k.hasText && !isTrivialLeaf(k)) || k.inter || k.fold != null || (k.shadow && k.ref != null));
    if (productive.length === 1) { walk(productive[0], depth, newPath); return; }
    if (productive.length >= 2) {
      // 交互/带 ref/含交互子代的节点不内联折叠:必须各自成行,否则 [ref=i] 标注被吞、agent 拿不到可操作句柄。
      // 含交互子代(hasInter)也不能折叠——纯包装 DIV 内含按钮时,内联只取第一个文本,把其它交互叶的 ref 整颗吞掉(如知乎评论动作行)。
      if (productive.every(k => inlineable(k) && !k.inter && !k.hasInter && k.ref == null)) {
        const items = productive.map(inlineLabel).join(' ');
        out.push('  '.repeat(depth) + (newPath.length ? newPath.join(' > ') + ' ' : '') + items);
        return;
      }
      if (newPath.length) out.push('  '.repeat(depth) + newPath.join(' > '));
      for (const k of productive) walk(k, depth + 1, []);
    }
  }

  out.push(tagLabel(tree) + (tree.text ? ' "' + tree.text.slice(0, 60) + '"' : '') + refTag(tree));
  for (const k of tree.kids) walk(k, 1, []);
  return out;
}
