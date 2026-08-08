/**
 * keys.test.ts — parseKeySpec 纯函数单测(Node 内置 node:test,零依赖)。
 * 覆盖单键、组合键、功能键、空格、未知键抛错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeySpec } from '../src/keys.ts';

test('单字母键:大写 key + KeyCode', () => {
  const r = parseKeySpec('a');
  assert.equal(r.key, 'A');
  assert.equal(r.code, 'KeyA');
  assert.equal(r.kc, 65);
  assert.equal(r.modifiers, 0);
});

test('组合键 Ctrl+Shift+A:modifiers 位叠加', () => {
  const r = parseKeySpec('Ctrl+Shift+A');
  assert.equal(r.key, 'A');
  assert.equal(r.modifiers, 2 | 8); // ctrl(2) + shift(8)
});

test('control 别名等价 ctrl', () => {
  const r = parseKeySpec('Control+A');
  assert.equal(r.modifiers, 2);
});

test('功能键 Enter', () => {
  const r = parseKeySpec('Enter');
  assert.equal(r.key, 'Enter');
  assert.equal(r.code, 'Enter');
  assert.equal(r.kc, 13);
});

test('空格键', () => {
  const r = parseKeySpec('space');
  assert.equal(r.key, ' ');
  assert.equal(r.code, 'Space');
  assert.equal(r.kc, 32);
});

test('数字键:Digit 前缀', () => {
  const r = parseKeySpec('5');
  assert.equal(r.code, 'Digit5');
  assert.equal(r.kc, 53);
});

test('meta 组合(Cmd 别名)', () => {
  const r = parseKeySpec('Cmd+Enter');
  assert.equal(r.modifiers, 4);
  assert.equal(r.key, 'Enter');
});

test('缺主键抛错', () => {
  assert.throws(() => parseKeySpec('Ctrl+'), /缺少主键/);
});

test('未知功能键抛错', () => {
  assert.throws(() => parseKeySpec('F7'), /未知按键/);
});
