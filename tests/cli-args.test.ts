/**
 * cli-args.test.ts — parseArgs 纯函数单测(Node 内置 node:test,零依赖)。
 * 覆盖布尔 flag、取值 opt、位置参数、取值 opt 越界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli-args.ts';

test('位置参数收集进 args', () => {
  const r = parseArgs(['tree', '--selector', '#main']);
  assert.deepEqual(r.args, ['tree']);
});

test('取值 opt 吃到下一个 token', () => {
  const r = parseArgs(['tree', '--selector', '#main', '--xpath', '//div']);
  assert.equal(r.opts.selector, '#main');
  assert.equal(r.opts.xpath, '//div');
});

test('布尔 flag 置 true', () => {
  const r = parseArgs(['logs', '--json', '--target', 'x']);
  assert.equal(r.opts.json, true);
  assert.equal(r.opts.target, 'x');
});

test('取值 opt 后面没值 → undefined(不崩)', () => {
  const r = parseArgs(['logs', '--target']);
  assert.equal(r.opts.target, undefined);
});
