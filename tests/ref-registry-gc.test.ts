/**
 * ref-registry-gc.test.ts — 登记表只追加不回收的前提:死槽不 pin 元素(WeakRef 跨 job 后真被 GC 释放)、
 * 号码永不复用、死槽仍归 'live' 类可沿 parentRef 自愈。用 v8 flag + vm 拿到 gc(),不依赖 --expose-gc。
 * V8 KeepDuringJob:同一 job 内 new WeakRef / deref 过的目标保活到 job 结束,故 GC 前必须 await 宏任务。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { classifyRef, entryEl, entryParent, lookupRef, registerRef, type RefEntry } from '../src/inject/lib/find-root.ts';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const tick = () => new Promise<void>(r => setTimeout(r, 0));
const collect = async () => { await tick(); for (let i = 0; i < 3; i++) { gc(); await tick(); } };

type G = typeof globalThis & { __cdpRefs?: RefEntry[]; __cdpRefIndex?: WeakMap<Element, number> };
const g = globalThis as G;
const fake = () => ({ nodeType: 1, isConnected: true } as unknown as Element);

test('registerRef: 元素释放后 WeakRef 槽位跨 job 被 GC 清空,槽数不变、号码不复用、死槽仍可分类为 live', async () => {
  delete g.__cdpRefs;
  delete g.__cdpRefIndex;
  const N = 20_000;
  const keep = fake();
  registerRef(keep, null);
  (() => {
    let prev: number | null = 0;
    for (let i = 0; i < N; i++) prev = registerRef(fake(), prev); // 链式 parentRef,元素离开闭包即无强引用
  })();
  assert.equal(g.__cdpRefs?.length, N + 1);

  await collect();
  const refs = g.__cdpRefs!;
  let released = 0;
  for (let i = 1; i <= N; i++) if (entryEl(refs[i]) === undefined) released++;
  assert.equal(released, N, '死槽的 WeakRef 必须全部释放(不 pin detached 元素)');
  assert.equal(entryEl(refs[0]), keep, '仍被持有的元素不受影响');
  assert.equal(refs.length, N + 1, '释放不缩表:槽位/号码保持');
  assert.equal(entryParent(refs[N]), N - 1, '死槽保留 parentRef,recoverRef 仍能沿链上爬');
  assert.equal(classifyRef(N).kind, 'live', '死槽仍是曾登记(live 类),不是 never');

  const fresh = fake();
  assert.equal(registerRef(fresh, null), N + 1, '新元素只追加新号,绝不复用已释放的号');
  assert.equal(lookupRef(fresh), N + 1);
});
