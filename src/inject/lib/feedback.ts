/**
 * feedback.ts — 操作后自动反馈(注入侧):MutationObserver 采集本次操作产生的 DOM 变化。
 * 分为两段,跨两次 Runtime.evaluate 调用协作,observer 状态暂存于全局 __cdpFeedback:
 *   startFeedback()   — 装 observer,记录 childList 新增 + characterData 文本变化。
 *   collectFeedback() — 断开 observer,取"顶层新增元素"逐块建树拼接,产摘要。期间重置 __cdpRefs 一次,
 *                       使拼接出来的 [ref=i] 跨块连续,agent 可直接用反馈树的 ref 操作新增内容。
 * 等待时长由 Node 侧(sleep)控制,不在此注入侧;node 侧在两次调用之间等待 delayMs。
 */
import { buildTree } from './tree-core';
import { markText, formatTree } from './tree-format';

export interface FeedbackResult { lines: string[]; summary: string }

interface FeedbackState { added: Node[]; texts: string[] }

/** 启动反馈观察:记录 childList 新增节点与 characterData 文本变化(attributes 不进反馈,噪声大)。 */
export function startFeedback(): void {
  if ((globalThis as any).__cdpFeedback) return; // 已启动则复用(防重复装)
  const st: FeedbackState = { added: [], texts: [] };
  const mo = new MutationObserver(ms => {
    for (const m of ms) {
      for (const n of Array.from(m.addedNodes)) st.added.push(n);
      if (m.type === 'characterData' && m.target.nodeType === 3) {
        const t = (m.target.textContent || '').trim();
        if (t) st.texts.push(t);
      }
    }
  });
  mo.observe(document, { childList: true, subtree: true, characterData: true });
  (globalThis as any).__cdpFeedback = { mo, state: st };
}

/** 收尾反馈:断开 observer,把本次新增内容 tree 拼接为 lines + 摘要。返回 {ok:true, ...FeedbackResult}。 */
export function collectFeedback(opts: { viewport?: boolean } = {}): FeedbackResult {
  const fb = (globalThis as any).__cdpFeedback;
  if (!fb) return { lines: [], summary: '新增 0 个内容块' };
  fb.mo.disconnect();
  (globalThis as any).__cdpFeedback = null;
  const { added, texts } = fb.state as FeedbackState;
  // 顶层新增元素:本次 addedNodes 中、没有元素祖先也在本次新增集合里的节点(去嵌套,避免父容器把整棵子树又算一遍)。
  const els = added.filter(n => n.nodeType === 1) as Element[];
  const set = new Set(els);
  const roots = els.filter(el => {
    let p = el.parentElement;
    while (p) { if (set.has(p)) return false; p = p.parentElement; }
    return true;
  });
  // 重置全局 ref 一次,再逐块建树拼接 → 跨块 ref 连续,agent 用反馈树 ref 操作新增内容。
  (globalThis as any).__cdpRefs = [];
  const lines: string[] = [];
  for (const el of roots) {
    const t = buildTree(el, { viewport: opts.viewport });
    markText(t);
    lines.push(...formatTree(t));
  }
  const uniqTexts = [...new Set(texts)].slice(0, 5);
  let summary = `新增 ${roots.length} 个内容块`;
  if (uniqTexts.length) summary += '; 文本变化: ' + uniqTexts.map(t => '"' + t.slice(0, 20) + '"').join(' ');
  return { lines, summary };
}
