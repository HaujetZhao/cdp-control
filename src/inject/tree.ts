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
import { findRoot, refElement, climbAncestors } from './lib/find-root';
import type { TreeArgs } from './lib/arg';

declare const __CDP_ARG__: TreeArgs;

// 整段包成 async(通过 setResult 传 promise,footer await):支持 --scroll-to-load 先异步滚动再建树。
setResult((async () => {
  // 锚点互斥:--ref 优先(读上一次 tree 登记的 __cdpRefs,须在下方清空表之前解析),
  // 其次 selector/xpath,缺省 body。--ancestor 为统一爬父修饰符,对任一锚点生效。
  let root: Element | null;
  if (__CDP_ARG__.ref != null) {
    root = climbAncestors(refElement(__CDP_ARG__.ref), __CDP_ARG__.ancestor);
    if (!root || root.nodeType !== 1) return setResult({ ok: false, err: `ref=${__CDP_ARG__.ref} 无效或已失效(ref 是会话句柄,页面刷新后失效;需先重新 tree 拿到新 ref)` });
  } else {
    root = climbAncestors(findRoot(__CDP_ARG__.selector, __CDP_ARG__.xpath), __CDP_ARG__.ancestor);
    if (!root || root.nodeType !== 1) return setResult({ ok: false, err: '未找到匹配的根节点(selector/xpath 未命中)' });
  }
  // 全局 ref 登记表:本次 tree 遍历重建,index 即输出里的 [ref=i]。agent 用真实元素引用操作,穿透 shadow。
  (globalThis as any).__cdpRefs = [];
  // --scroll-to-load:先上下滚动触发懒加载(评论区等首屏外的内容),再建树。模拟真实用户滚动。
  // 最多滚 steps 个视口高,不追求到底(防无限流加载爆炸);滚完回顶。
  async function scrollToLoad() {
    const steps = 6, pause = 120;
    const h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const vh = innerHeight || document.documentElement.clientHeight || 800;
    const target = Math.min(h, steps * vh);
    for (let y = 0; y < target; y += vh) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, pause)); }
    window.scrollTo(0, 0); await new Promise(r => setTimeout(r, pause));
  }
  if (__CDP_ARG__.scrollToLoad) await scrollToLoad();
  // visible-only:只输出当前视口内几何可见、且非隐藏(display:none/opacity:0/visibility:hidden)的元素,
  // 模拟 agent"看到当前屏幕"。非视口但有视口内后代的节点退化为纯容器骨架,不输出自身文本/ref。
  const visibleOnly = !!__CDP_ARG__.visibleOnly;

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
  // visible-only:元素是否落在当前视口内且可见(非 display:none/opacity:0/visibility:hidden)。
  // rect 宽高为 0 即 display:none(不占位);再查 opacity/visibility。getComputedStyle 较贵,只在 rect 相交后查。
  const isInView = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.top >= innerHeight || r.bottom <= 0 || r.left >= innerWidth || r.right <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.opacity !== '0';
  };
  // visible-only 裁剪:返回"子树是否含视口内可见节点"。非视口但有视口内后代的节点退化为纯容器骨架
  // (清空自身文本/ref,让 formatTree 不输出视口外的内容),但保留 kids 供进入视口内的后代显示。
  function prune(n: TreeNode): boolean {
    n.kids = n.kids.filter(k => prune(k));
    const hasView = !!n.inView || n.kids.length > 0;
    if (!n.inView) {
      n.text = ''; n.leafValue = undefined; n.imgAlt = ''; n.ref = undefined; n.agg = false;
      n.isContent = false;
    }
    return hasView;
  }

  function simplify(el: Element | ShadowRoot, depth: number): TreeNode {
    const isEl = el instanceof Element;
    const tag = (el as Element).tagName?.toLowerCase() || 'frag';
    const inter = isEl ? interactive(el as Element) : false;
    const title = isEl ? (el.getAttribute('title') || '') : '';
    let text = isEl ? ownText(el as Element) : '';
    // visible-only 下只登记视口内可见内容节点的 ref,序号连续、输出的 [ref=i] 都指向真实可操作元素。
    const inView = visibleOnly && isEl ? isInView(el as Element) : true;
    let ref: number | undefined;
    if (isEl && inView && (inter || !!text)) {
      ref = (globalThis as any).__cdpRefs.length;
      (globalThis as any).__cdpRefs.push(el as Element);
    }
    const node: TreeNode = {
      tag,
      isContent: !!text || (isEl && el.tagName === 'IMG') || inter,
      text, inter, ref, inView,
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
    // 交互/图片元素自身无直接文本时,用 grabText 聚合后代文本(空格分隔,穿透 shadow;替代 innerText——后者会把 inline 数字连排成 "822.2万904906:02")。
    if (!text && (inter || (isEl && el.tagName === 'IMG'))) { text = strip(grabText(el, 0)).slice(0, 80); node.agg = true; }
    node.text = text;
    node.isContent = !!text || (isEl && el.tagName === 'IMG') || inter;
    node.size = 1 + node.kids.reduce((a, k) => a + k.size, 0);
    if (!text && title && !node.kids.some(k => k.text) && node.size <= 8 && (el as Element).tagName !== 'SVG' && (el as Element).tagName !== 'path' && (el as Element).tagName !== 'USE') {
      node.leafValue = strip(title).slice(0, 40);
      node.isContent = true;
    }
    return node;
  }
  const tree = simplify(root, 0);
  if (visibleOnly) { tree.kids = tree.kids.filter(k => prune(k)); }
  markText(tree);
  return setResult({ ok: true, lines: formatTree(tree) });
})());
