/**
 * tree.ts — 结构树入口(注入到浏览器页面执行)。
 * 精简整页 body(或指定区域)为"文本 + 结构"紧凑树。丢垃圾标签、折叠纯包装节点、
 * 穿透 shadow DOM、合并交互/标题叶。不做可见性判定——整页结构一次给全。
 *
 * 契约:读取 __CDP_ARG__.rootExpr(解析建树根元素的 JS 表达式串),把结果写入 setResult。
 * 输出为带缩进文本行数组(标签 + 引用文本),无 [看]/[架]/[X] 状态前缀。
 */
import { setResult } from './lib/result';
import { markText, formatTree, type TreeNode } from './lib/tree-format';
import { findRoot } from './lib/find-root';
import type { TreeArgs } from './lib/arg';

declare const __CDP_ARG__: TreeArgs;

(() => {
  const root = findRoot(__CDP_ARG__.selector, __CDP_ARG__.xpath);
  if (!root || root.nodeType !== 1) return setResult({ ok: false, err: '未找到匹配的根节点(selector/xpath 未命中)' });

  const DROP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'SVG', 'PATH', 'BR', 'IFRAME', 'PICTURE', 'SOURCE', 'USE']);
  const strip = (s: string) => (s || '').replace(/[​‌‍⁠﻿\s]+/g, ' ').trim();
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
  // 泛化:children 含 light DOM + shadowRoot 子(穿透 Web Component shadow DOM,如 B站评论区)
  const childrenOf = (el: Element): (Element | ShadowRoot)[] => {
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

  function simplify(el: Element | ShadowRoot, depth: number): TreeNode {
    const isEl = el instanceof Element;
    const tag = (el as Element).tagName?.toLowerCase() || 'frag';
    const inter = isEl ? interactive(el as Element) : false;
    const title = isEl ? (el.getAttribute('title') || '') : '';
    let text = isEl ? ownText(el as Element) : '';
    const node: TreeNode = {
      tag,
      isContent: !!text || (isEl && el.tagName === 'IMG') || inter,
      text, inter,
      imgAlt: isEl && el.tagName === 'IMG' ? (el.getAttribute('alt') || '') : '',
      // 宿主带 shadowRoot:其下的子节点展平自 shadow DOM,CSS 选择器无法穿透,须用 xpath 定位
      shadow: isEl && !!(el as Element).shadowRoot,
      kids: [], size: 0, hasText: false, agg: false,
    };
    for (const k of childrenOf(el as Element)) {
      const kt = k instanceof Element ? k.tagName.toUpperCase() : '';
      if (DROP.has(kt)) continue;
      node.kids.push(simplify(k, depth + 1));
    }
    if (!text && !node.kids.length) { text = strip(grabText(el, 0)).slice(0, 120); node.agg = true; }
    if (!text && (inter || (isEl && el.tagName === 'IMG')) && (el as HTMLElement).innerText) { text = strip((el as HTMLElement).innerText).slice(0, 80); node.agg = true; }
    node.text = text;
    node.isContent = !!text || (isEl && el.tagName === 'IMG') || inter;
    node.size = 1 + node.kids.reduce((a, k) => a + k.size, 0);
    if (!text && title && node.size <= 8 && (el as Element).tagName !== 'SVG' && (el as Element).tagName !== 'path' && (el as Element).tagName !== 'USE') {
      node.leafValue = strip(title).slice(0, 40);
      node.isContent = true;
    }
    return node;
  }
  const tree = simplify(root, 0);
  markText(tree);
  return setResult({ ok: true, lines: formatTree(tree) });
})();
