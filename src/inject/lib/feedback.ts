/**
 * feedback.ts — 操作后自动反馈(注入侧):MutationObserver 采集本次操作产生的 DOM 变化。
 * 分为两段,跨两次 Runtime.evaluate 调用协作,observer 状态暂存于全局 __cdpFeedback:
 *   startFeedback()   — 装 observer,记录 childList 新增 + 文本变化(前后值)。
 *   collectFeedback() — 断开 observer,取"顶层新增元素"逐块建树拼接,产摘要。
 * 等待时长由 Node 侧(sleep)控制,不在此注入侧;node 侧在两次调用之间等待 delayMs。
 *
 * ref 语义:collect **不重置 __cdpRefs,只追加**——反馈新增的 ref 从现有长度递增,不顶掉整页旧 ref
 * (整页 tree 才重置)。agent 用反馈树的增量 ref 操作新增内容,同时原 ref 依旧有效。
 */
import { buildTree } from './tree-core';
import { markText, formatTree } from './tree-format';

export interface FeedbackResult { lines: string[]; summary: string }

/** 一次文本变化:before 为旧值(可缺,如原地改字符 characterData 拿不到旧值),after 为新值。 */
interface TextChange { before?: string; after: string }

interface FeedbackState { added: Node[]; changes: TextChange[] }

/** 取 mutation 里新增/移除的直接文本节点文本。 */
const textNodes = (nodes: NodeList): string[] =>
  Array.from(nodes).filter(n => n.nodeType === 3).map(n => (n.nodeValue || '').trim()).filter(Boolean);

/** 启动反馈观察:记录 childList 新增节点与文本变化(前后值;attributes 不进反馈,噪声大)。 */
export function startFeedback(): void {
  if ((globalThis as any).__cdpFeedback) return; // 已启动则复用(防重复装)
  const st: FeedbackState = { added: [], changes: [] };
  const mo = new MutationObserver(ms => {
    for (const m of ms) {
      for (const n of Array.from(m.addedNodes)) st.added.push(n);
      if (m.type === 'characterData' && m.target.nodeType === 3) {
        // 原地改字符(如点赞数字 textContent 直接改 data):characterDataOldValue 记录了旧值,拼成 旧→新。
        const before = (m.oldValue || '').trim();
        const after = ((m.target as Text).nodeValue || '').trim();
        if (after && before !== after) st.changes.push(before ? { before, after } : { after });
      } else if (m.type === 'childList') {
        // 文本替换(如 element.textContent=值 删旧加新 Text):removedNodes=旧值、addedNodes=新值,一对一配对成 旧→新。
        const befores = textNodes(m.removedNodes);
        const afters = textNodes(m.addedNodes);
        const k = Math.min(befores.length, afters.length);
        for (let i = 0; i < k; i++) st.changes.push({ before: befores[i], after: afters[i] });
        for (let i = k; i < afters.length; i++) st.changes.push({ after: afters[i] });
      }
    }
  });
  mo.observe(document, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
  (globalThis as any).__cdpFeedback = { mo, state: st };
}

/** 收尾反馈:断开 observer,把本次新增内容 tree 拼接为 lines + 摘要。返回 FeedbackResult。 */
export function collectFeedback(opts: { viewport?: boolean } = {}): FeedbackResult {
  const fb = (globalThis as any).__cdpFeedback;
  if (!fb) return { lines: [], summary: '新增 0 个内容块' };
  fb.mo.disconnect();
  (globalThis as any).__cdpFeedback = null;
  const { added, changes } = fb.state as FeedbackState;
  // 顶层新增元素:本次 addedNodes 中、没有元素祖先也在本次新增集合里的节点(去嵌套,避免父容器把整棵子树又算一遍)。
  const els = added.filter(n => n.nodeType === 1) as Element[];
  const set = new Set(els);
  const roots = els.filter(el => {
    let p = el.parentElement;
    while (p) { if (set.has(p)) return false; p = p.parentElement; }
    return true;
  });
  // 不重置 __cdpRefs:反馈新增 ref 从现有长度递增,顶掉旧 ref 会丢整页句柄(曾踩坑)。
  const lines: string[] = [];
  for (const el of roots) {
    const t = buildTree(el, { viewport: opts.viewport });
    markText(t);
    lines.push(...formatTree(t));
  }
  // 文本变化摘要:前后值都报(before → after);无 before 只报 after。去重(前=后/重复变化)取前 5。
  const seen = new Set<string>();
  const uniq: TextChange[] = [];
  for (const c of changes) {
    const key = c.before ? `${c.before}→${c.after}` : `·${c.after}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
    if (uniq.length >= 5) break;
  }
  let summary = `新增 ${roots.length} 个内容块`;
  if (uniq.length) summary += '; 文本变化: ' + uniq.map(c => c.before ? `${c.before} → ${c.after}` : `"${c.after}"`).join(' ');
  return { lines, summary };
}
