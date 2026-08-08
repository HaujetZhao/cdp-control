/**
 * prune.ts — prune 注入入口(按 ref 删减整页 tree 区域)。
 * 把 agent 不要的区域的 ref 解析成元素登记进 __cdpPrune;之后的整页 tree 不再输出。
 * 契约:读取 __CDP_ARG__(refs 数组 / clear / list),结果写 setResult。
 * 同步入口,footer await 原样通过。
 */
import { setResult } from './lib/result';
import { registerPrune, clearPrune, listPrune } from './lib/prune.ts';
import type { PruneArgs } from './lib/arg';

declare const __CDP_ARG__: PruneArgs;

setResult((() => {
  if (__CDP_ARG__.clear) {
    clearPrune();
    return { ok: true, cleared: true };
  }
  if (__CDP_ARG__.list) {
    return { ok: true, pruned: listPrune().map(p => p.summary) };
  }
  const { pruned, skipped } = registerPrune(__CDP_ARG__.refs || []);
  return { ok: true, pruned: pruned.map(p => p.summary), skipped };
})());
