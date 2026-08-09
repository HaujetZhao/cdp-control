/**
 * cli-guard.test.ts — normArg 防呆单测:字符串形态的 \"{ref:N}\" 应抛友好错误,
 * 不让 querySelector('{ref:80}') 抛原生 CSS 异常暴露内部栈。
 * 其它形态(普通 selector 字符串、{ref:n} 真对象、{ref,ancestor} 对象)正常通过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normArg } from '../src/target-arg.ts';

test('normArg: 字符串形态 {ref:80} 抛友好错误(对象字面量当 selector 误用)', () => {
  assert.throws(() => normArg('{ref:80}'), /对象字面量字符串/);
  assert.throws(() => normArg('{ ref: 80 }'), /对象字面量字符串/); // 含空格
  assert.throws(() => normArg('{ref:80,ancestor:2}'), /对象字面量字符串/); // 多字段
});

test('normArg: 前后含噪声但仍匹配 `{...ref...}` 模式也拦', () => {
  // 任务书正则 /^\{[\s\S]*ref[\s\S]*\}$/ 只要首 { 末 ref 后 } 就命中
  assert.throws(() => normArg('{\n  ref: 80\n}'), /对象字面量字符串/); // 多行
});

test('normArg: 真对象 {ref:n} 正常通过(脚本 API 合法用法)', () => {
  assert.deepEqual(normArg({ ref: 80 }), { ref: 80 });
  assert.deepEqual(normArg({ ref: 80, ancestor: 2 }), { ref: 80, ancestor: 2 });
});

test('normArg: 普通 selector 字符串正常通过(归一化为 {sel})', () => {
  assert.deepEqual(normArg('#main > .btn'), { sel: '#main > .btn' });
  assert.deepEqual(normArg('a[href="/x"]'), { sel: 'a[href="/x"]' });
});

test('normArg: 形如对象但不含 ref 的字符串不拦(不是 ref 误用,真当 selector)', () => {
  // \"{foo:1}\" 不含 ref,不当 ref 误用拦,正常当 selector(即便 querySelector 会失败也由调用方报)
  assert.deepEqual(normArg('{foo:1}'), { sel: '{foo:1}' });
});
