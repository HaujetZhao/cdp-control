/**
 * prune.ts — 会话级排除区域集合(按 ref 删减整页 tree 区域)。
 * 把 agent 不想要的长页区域(导航/推荐/广告)的「真实 DOM 元素」存进页面全局 __cdpPrune(Set)。
 * buildTree 遇到集合内元素即整棵子树跳过 → 之后的整页 tree 不再输出,无需筛选。
 * 生命周期:与 __cdpRefs 一致,页面刷新(新 document)自动清空。
 */
import { refElement, climbAncestors } from './find-root.ts';

export interface PruneEntry { el: Element; summary: string }

/** 排除区域集合(不存在返回 null)。buildTree 读取用。 */
export function pruneSet(): Set<Element> | null {
  return (globalThis as any).__cdpPrune ?? null;
}

function ensureSet(): Set<Element> {
  if (!(globalThis as any).__cdpPrune) (globalThis as any).__cdpPrune = new Set();
  return (globalThis as any).__cdpPrune;
}

function summaryOf(el: Element): string {
  const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
  return (t || el.tagName).slice(0, 40);
}

/** 按 ref 逐个解析为元素(可选 --ancestor 爬父到容器)并登记进排除集合;无效 ref 跳过。返回登记摘要 + 跳过数。 */
export function registerPrune(refs: number[], ancestor = 0): { pruned: PruneEntry[]; skipped: number } {
  const set = ensureSet();
  const pruned: PruneEntry[] = [];
  let skipped = 0;
  for (const r of refs) {
    const el = climbAncestors(refElement(r), ancestor);
    if (!el) { skipped++; continue; }
    if (!set.has(el)) set.add(el);
    pruned.push({ el, summary: summaryOf(el) });
  }
  return { pruned, skipped };
}

/** 清空排除集合。 */
export function clearPrune(): void {
  (globalThis as any).__cdpPrune = new Set();
}

/** 列出当前已排除区域摘要(不含 el 序列化,供 CLI/agent 回顾)。 */
export function listPrune(): PruneEntry[] {
  const set = pruneSet();
  if (!set) return [];
  return [...set].map(el => ({ el, summary: summaryOf(el) }));
}
