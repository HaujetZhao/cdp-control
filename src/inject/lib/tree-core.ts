/**
 * tree-core.ts — 结构树建树 core(从 DOM 采集精简树)。
 * 被 tree 入口与操作反馈(feedback-collect)共享:把"整棵 DOM 区域 → 内部 TreeNode 树"的逻辑集中于此。
 * 含 DOM 采集(simplify)与 visible-only 裁剪(prune),与纯变换(formatTree/markText)分离。
 *
 * 注意:buildTree 只"追加" ref 到 __cdpRefs,**不重置**——重置时机由调用方决定
 * (tree 入口在整页建树前重置;反馈收集在拼接多个新增块前重置一次,保证跨块 ref 连续)。
 */
import type { TreeNode } from './tree-format.ts';
import { tmpFolds } from './fold.ts';
import type { FoldItem } from './arg.ts';

export interface TreeBuildOpts { visibleOnly?: boolean; viewport?: boolean; folds?: FoldItem[] }

const DROP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'SVG', 'PATH', 'BR', 'IFRAME', 'PICTURE', 'SOURCE', 'USE']);
/** 压空白 + 零宽字符、首尾 trim 的归一化(供文本采集/比对统一用)。 */
export const strip = (s: string) => (s || '').replace(/[​‌‍⁠﻿\s]+/g, ' ').trim();
const ownText = (el: Element) => {
  const parts: string[] = [];
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) parts.push(n.nodeValue);
  return strip(parts.join(' '));
};
// 穿透 shadow DOM 收集整棵子树的文本(深度上限 d<8 防爆炸)。
const grabText = (el: Element | ShadowRoot, d: number): string => {
  const gt = el instanceof Element ? el.tagName : '';
  if (gt === 'STYLE' || gt === 'SCRIPT' || gt === 'TEMPLATE' || gt === 'NOSCRIPT' || gt === 'LINK' || gt === 'META' || gt === 'TITLE') return '';
  const parts: string[] = [];
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) parts.push(n.nodeValue);
  if (d < 8) {
    if (el instanceof Element && el.shadowRoot) parts.push(grabText(el.shadowRoot, d + 1));
    for (let i = 0; i < el.children.length; i++) parts.push(grabText(el.children[i], d + 1));
  }
  return parts.join(' ');
};
/** 取元素自身**直接**子文本节点拼成的文本(不含子元素文本,空白归一化)。find/locate 都要避免子树聚合误导。 */
export const ownElText = (el: Element): string => ownText(el);
/** 穿透 shadow 取整棵子树文本(空格分隔)。供 find 文本搜索比对"元素或后代是否含关键词"。 */
export const subtreeText = (el: Element | ShadowRoot): string => strip(grabText(el, 0));
// 泛化:children 含 light DOM + shadowRoot 子(穿透 Web Component shadow DOM,如 B站评论区)
/** 取元素的 light 子 + shadowRoot 子(穿透 Web Component shadow DOM,如 B站评论区)。 */
export const childrenOf = (el: Element): (Element | ShadowRoot)[] => {
  const k: (Element | ShadowRoot)[] = [];
  for (let i = 0; i < el.children.length; i++) k.push(el.children[i]);
  if (el.shadowRoot) for (let i = 0; i < el.shadowRoot.children.length; i++) k.push(el.shadowRoot.children[i]);
  return k;
};
const interactive = (el: Element): boolean => {
  const t = el.tagName;
  if (t === 'BUTTON' || t === 'A' || t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return true;
  return el.hasAttribute ? (el.hasAttribute('onclick') || el.hasAttribute('tabindex') || el.getAttribute('role') === 'button') : false;
};
// visible-only:元素是否落在当前视口内且可见(非 display:none/opacity:0/visibility:hidden)。
// rect 宽高为 0 即 display:none(不占位);再查 opacity/visibility。getComputedStyle 较贵,只在 rect 相交后查。
const isInView = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (r.top >= innerHeight || r.bottom <= 0 || r.left >= innerWidth || r.right <= 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.opacity !== '0';
};
// 便宜的在视区判定(viewport 标记用):只查 rect 与视口相交 + 宽高>0,不查 getComputedStyle(省开销)。
export const isInViewport = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return !(r.top >= innerHeight || r.bottom <= 0 || r.left >= innerWidth || r.right <= 0);
};
// visible-only 裁剪:返回"子树是否含视口内可见节点"。非视口但有视口内后代的节点退化为纯容器骨架
// (清空自身文本/ref,让 formatTree 不输出视口外的内容),但保留 kids 供进入视口内的后代显示。
function prune(n: TreeNode): boolean {
  n.kids = n.kids.filter(k => prune(k));
  const hasView = !!n.inView || n.kids.length > 0;
  if (!n.inView) {
    n.text = ''; n.leafValue = undefined; n.imgAlt = ''; n.ref = undefined; n.agg = false;
    n.isContent = false; n.inputInfo = undefined;
  }
  return hasView;
}

/** 从 root 建精简树。opts.visibleOnly:建树后按视口可见裁剪(沿用 tree --visible-only 语义);
 * opts.viewport:对带 ref 的节点算 node.view(输出 [ref=i·屏] 标记),见 lib/tree-format.ts。 */
export function buildTree(root: Element | ShadowRoot, opts: TreeBuildOpts = {}): TreeNode {
  const visibleOnly = !!opts.visibleOnly;
  const viewport = !!opts.viewport;
  // 折叠规则来源:持久(Node 侧 folds.ts 按 hostname 过滤后传入)+ 会话级临时(__cdpFolds)。统一按 selector 匹配。
  const folds: FoldItem[] = [...(opts.folds || []), ...tmpFolds()];
  // 折叠判定:元素命中任一 fold selector → 返回备注,否则 null。
  const foldNote = (el: Element): string | null => {
    for (const f of folds) { try { if (el.matches(f.selector)) return f.note || f.selector; } catch {} }
    return null;
  };

  function simplify(el: Element | ShadowRoot, depth: number, parentRef: number | null): TreeNode | null {
    const isEl = el instanceof Element;
    // 折叠(非根元素命中 fold 规则):登记 ref(可展开)、设 fold=备注、不递归子树。
    // 根不折叠:tree --ref i 展开折叠容器时,根本身(=该容器)不该再被折叠,否则永远展不开。
    if (isEl && depth > 0) {
      const note = foldNote(el as Element);
      if (note !== null) {
        const e = el as Element;
        const ref = (globalThis as any).__cdpRefs.length;
        (globalThis as any).__cdpRefs.push({ el: e, parentRef });
        return {
          tag: e.tagName.toLowerCase(), isContent: true, text: '', inter: false, ref,
          inView: true, view: viewport ? isInViewport(e) : undefined, imgAlt: '',
          shadow: !!e.shadowRoot, kids: [], size: 1, hasText: false, agg: false, fold: note,
        };
      }
    }
    const tag = isEl ? el.tagName?.toLowerCase() || 'frag' : 'frag';
    const inter = isEl ? interactive(el as Element) : false;
    const title = isEl ? (el.getAttribute('title') || '') : '';
    let text = isEl ? ownText(el as Element) : '';
    // visible-only 下只登记视口内可见内容节点的 ref,序号连续、输出的 [ref=i] 都指向真实可操作元素。
    const inView = visibleOnly && isEl ? isInView(el as Element) : true;
    // 带 shadowRoot 的 host(如 bili-comments)无条件登记 ref:它们常无 light 文本、首屏还是空壳,
    // 不强制登记就会在整页 tree 里静默消失,agent 无从知道页面有评论区。登记后 formatTree 输出占位行。
    const hasShadow = isEl && inView && !!(el as Element).shadowRoot;
    let ref: number | undefined;
    let view: boolean | undefined;
    if (isEl && inView && (inter || !!text || hasShadow)) {
      ref = (globalThis as any).__cdpRefs.length;
      // 登记表存 {el, parentRef}:parentRef = 最近的已登记祖先 ref 号(跳表),供 ref 失效自愈向上找存活容器。
      (globalThis as any).__cdpRefs.push({ el: el as Element, parentRef });
      // viewport 标记:对带 ref 的节点算便宜的在视区判定(rect+宽高,不查 computed style)。
      if (viewport) view = isInViewport(el as Element);
    }
    const node: TreeNode = {
      tag,
      // shadow host 强制 isContent:空壳 host(无文本、shadow 子树也未加载)也要被 walk 到、输出占位,
      // 否则会被 productive 过滤掉,agent 在整页 tree 里看不到它存在。
      isContent: !!text || (isEl && el.tagName === 'IMG') || inter || hasShadow,
      text, inter, ref, inView, view,
      imgAlt: isEl && el.tagName === 'IMG' ? (el.getAttribute('alt') || '') : '',
      // 表单元素采集 type/value/placeholder(tree 显示),让 agent 看到搜索框内容、不必 eval。
      // textarea 采 value/placeholder;input 采 type/value/placeholder;select 不采(options 由交互展开)。
      inputInfo: isEl && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
        ? {
            type: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text') : undefined,
            value: ((el as any).value || '').slice(0, 40),
            placeholder: el.getAttribute('placeholder') || undefined,
          }
        : undefined,
      // 宿主带 shadowRoot:其下的子节点展平自 shadow DOM,CSS 选择器无法穿透,须用 ref 定位
      shadow: isEl && !!(el as Element).shadowRoot,
      kids: [], size: 0, hasText: false, agg: false,
    };
    // 子的 parentRef:本节点登记了 ref 就用本节点 ref,否则透传继承的 parentRef。
    const childParent = ref != null ? ref : parentRef;
    for (const k of childrenOf(el as Element)) {
      const kt = k instanceof Element ? k.tagName.toUpperCase() : '';
      if (DROP.has(kt)) continue;
      const kn = simplify(k, depth + 1, childParent);
      if (kn) node.kids.push(kn); // 跳过被排除的 null
    }
    if (!text && !node.kids.length) { text = strip(grabText(el, 0)).slice(0, 120); node.agg = true; }
    // 交互/图片元素自身无直接文本时,用 grabText 聚合后代文本(空格分隔,穿透 shadow;替代 innerText——后者会把 inline 数字连排成 "822.2万904906:02")。
    if (!text && (inter || (isEl && el.tagName === 'IMG'))) { text = strip(grabText(el, 0)).slice(0, 80); node.agg = true; }
    node.text = text;
    node.isContent = !!text || (isEl && el.tagName === 'IMG') || inter || hasShadow;
    node.size = 1 + node.kids.reduce((a, k) => a + k.size, 0);
    if (!text && title && !node.kids.some(k => k.text) && node.size <= 8 && (el as Element).tagName !== 'SVG' && (el as Element).tagName !== 'path' && (el as Element).tagName !== 'USE') {
      node.leafValue = strip(title).slice(0, 40);
      node.isContent = true;
    }
    return node;
  }

  let tree = simplify(root, 0, null);
  if (!tree) tree = { tag: 'body', isContent: false, text: '', inter: false, ref: undefined, inView: true, view: false, imgAlt: '', shadow: false, kids: [], size: 0, hasText: false, agg: false };
  if (visibleOnly) { tree.kids = tree.kids.filter(k => prune(k)); }
  return tree;
}
