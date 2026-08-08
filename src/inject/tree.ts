/**
 * tree.ts — 结构树入口(注入到浏览器页面执行)。
 * 精简整页 body(或指定区域)为"文本 + 结构"紧凑树。丢垃圾标签、折叠纯包装节点、
 * 穿透 shadow DOM、合并交互/标题叶。不做可见性判定——整页结构一次给全。
 *
 * 契约:读取 __CDP_ARG__.rootExpr(解析建树根元素的 JS 表达式串),把结果写入 setResult。
 * 输出为带缩进文本行数组(标签 + 引用文本),无 [看]/[架]/[X] 状态前缀。
 * 建树复用 lib/tree-core 的 buildTree;带 ref 的节点额外标在视区(view,输出 [ref=i·屏])。
 */
import { setResult } from './lib/result';
import { markText, formatTree } from './lib/tree-format';
import { buildTree } from './lib/tree-core';
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
  // --scroll-to-load:固定距离滚动触发懒加载(评论区等首屏外的内容),再建树。
  // 向下滚一屏、向上滚一屏,都是固定距离(= 一屏高),触发当前位置上下各一屏的懒加载后回到原位。
  // 刻意不大范围滚多屏再回顶——那会拉飞视口、让 agent 在已展开长内容页时丢失当前位置(曾踩坑)。
  async function scrollToLoad() {
    const pause = 120;
    const vh = innerHeight || document.documentElement.clientHeight || 800;
    const h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const start = Math.min(window.scrollY, Math.max(0, h - vh));
    const down = Math.min(start + vh, Math.max(0, h - vh)); // 向下固定一屏(不超文档底)
    window.scrollTo(0, down); await new Promise(r => setTimeout(r, pause));
    window.scrollTo(0, Math.max(0, down - vh)); await new Promise(r => setTimeout(r, pause)); // 向上固定一屏
    window.scrollTo(0, start); await new Promise(r => setTimeout(r, pause)); // 回原位
  }
  if (__CDP_ARG__.scrollToLoad) await scrollToLoad();
  const visibleOnly = !!__CDP_ARG__.visibleOnly;
  const tree = buildTree(root, { visibleOnly, viewport: true });
  markText(tree);
  return setResult({ ok: true, lines: formatTree(tree) });
})());
