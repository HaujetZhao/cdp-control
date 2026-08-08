/**
 * stash.ts — stash 注入入口(类比 git stash:把 agent 不想要的区域暂存藏起,之后的整页 tree 不再输出,随时可 pop 恢复)。
 * 契约:读取 __CDP_ARG__(refs/ancestor 暂存,list 列出,pop 恢复,clear 清空),结果写 setResult。
 * 同步入口,footer await 原样通过。
 */
import { setResult } from './lib/result';
import { stash, stashList, stashPop, stashClear } from './lib/stash.ts';
import type { StashArgs } from './lib/arg';

declare const __CDP_ARG__: StashArgs;

setResult((() => {
  if (__CDP_ARG__.clear) {
    stashClear();
    return { ok: true, cleared: true };
  }
  if (__CDP_ARG__.pop != null) {
    const popped = stashPop(__CDP_ARG__.pop);
    return { ok: true, popped: popped ? popped.summary : null };
  }
  if (__CDP_ARG__.list) {
    return { ok: true, stashed: stashList().map((p, i) => ({ i, summary: p.summary })) };
  }
  const { stashed, skipped } = stash(__CDP_ARG__.refs || [], __CDP_ARG__.ancestor || 0);
  return { ok: true, stashed: stashed.map(p => p.summary), skipped };
})());
