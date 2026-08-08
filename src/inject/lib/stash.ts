/**
 * stash.ts — 会话级暂存区域集合(类比 git stash:把长页里 agent 不想要的区域"藏起来",随时可 pop 恢复)。
 * 把导航/推荐/广告等区域的「真实 DOM 元素」存进页面全局 __cdpStash(有序数组)。
 * buildTree 遇到数组内元素即整棵子树跳过 → 之后的整页 tree 不再输出,无需筛选。
 * 可逆:stashPop 按索引恢复单个区域,stashClear 清空全部。
 * 生命周期:与 __cdpRefs 一致,页面刷新(新 document)自动清空。
 */
import { refElement, climbAncestors } from './find-root.ts';

export interface StashEntry { el: Element; summary: string }

/** 暂存区域数组(不存在返回 null)。buildTree 读取用。 */
export function stashSet(): Element[] | null {
  return (globalThis as any).__cdpStash ?? null;
}

function ensureSet(): Element[] {
  if (!(globalThis as any).__cdpStash) (globalThis as any).__cdpStash = [];
  return (globalThis as any).__cdpStash;
}

function summaryOf(el: Element): string {
  const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
  return (t || el.tagName).slice(0, 40);
}

/** 按 ref 逐个解析为元素(可选 --ancestor 爬父到容器)并暂存;无效 ref 跳过。返回暂存摘要 + 跳过数。 */
export function stash(refs: number[], ancestor = 0): { stashed: StashEntry[]; skipped: number } {
  const arr = ensureSet();
  const stashed: StashEntry[] = [];
  let skipped = 0;
  for (const r of refs) {
    const el = climbAncestors(refElement(r), ancestor);
    if (!el) { skipped++; continue; }
    if (!arr.includes(el)) arr.push(el);
    stashed.push({ el, summary: summaryOf(el) });
  }
  return { stashed, skipped };
}

/** 列出当前暂存区域摘要(不含 el 序列化,供 CLI/agent 回顾)。 */
export function stashList(): StashEntry[] {
  const arr = stashSet();
  if (!arr) return [];
  return arr.map(el => ({ el, summary: summaryOf(el) }));
}

/** 恢复(pop)第 i 个暂存区域(默认最近一个)并移除,返回其摘要;越界/空返回 null。 */
export function stashPop(i = -1): StashEntry | null {
  const arr = stashSet();
  if (!arr || arr.length === 0) return null;
  const idx = i < 0 ? arr.length - 1 : i; // 默认最新(数组末尾);显式 i 按列表下标
  if (idx < 0 || idx >= arr.length) return null;
  const [el] = arr.splice(idx, 1);
  return { el, summary: summaryOf(el) };
}

/** 清空暂存区域。 */
export function stashClear(): void {
  (globalThis as any).__cdpStash = [];
}
