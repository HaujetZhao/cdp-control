/**
 * folds.test.ts — fold 规则文件的纯函数单测(parseRules/domainMatch/hostOf)。
 * 文件读写(loadFolds/addFold/removeFold)依赖磁盘,按 ponytail 用临时 CDP_USER_DATA 验证落盘往返。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRules, domainMatch, hostOf } from '../src/folds.ts';

test('parseRules: 三列 tab 分隔;行号=所在行(1 基);# 注释行跳过', () => {
  const txt = '# 注释\n\nwww.bilibili.com\t.bili-header\t顶部导航\n*.zhihu.com\t.AppHeader\t知乎顶栏\n';
  const r = parseRules(txt);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { id: 3, domain: 'www.bilibili.com', selector: '.bili-header', note: '顶部导航' });
  assert.deepEqual(r[1], { id: 4, domain: '*.zhihu.com', selector: '.AppHeader', note: '知乎顶栏' });
});

test('parseRules: selector 含空格(后代选择器)不被切碎', () => {
  const r = parseRules('www.bilibili.com\t#app > div:nth-of-type(2) > div\t顶栏\n');
  assert.equal(r.length, 1);
  assert.equal(r[0].selector, '#app > div:nth-of-type(2) > div');
});

test('parseRules: 无备注(第三列空)行不报错', () => {
  const r = parseRules('a.com\t.x\t\n');
  assert.deepEqual(r[0], { id: 1, domain: 'a.com', selector: '.x', note: '' });
});

test('parseRules: 仅域名无 selector 的行跳过', () => {
  assert.equal(parseRules('a.com\n').length, 0);
});

test('domainMatch: 精确域名', () => {
  assert.equal(domainMatch('www.bilibili.com', 'www.bilibili.com'), true);
  assert.equal(domainMatch('www.bilibili.com', 'bilibili.com'), false);
  assert.equal(domainMatch('www.bilibili.com', ''), false);
});

test('domainMatch: *.suffix 通配匹配自身 + 任意子域', () => {
  assert.equal(domainMatch('*.zhihu.com', 'zhihu.com'), true);
  assert.equal(domainMatch('*.zhihu.com', 'www.zhihu.com'), true);
  assert.equal(domainMatch('*.zhihu.com', 'a.b.zhihu.com'), true);
  assert.equal(domainMatch('*.zhihu.com', 'notzhihu.com'), false);
  assert.equal(domainMatch('*.zhihu.com', 'com'), false);
});

test('hostOf: 正常 url 取 hostname;非法/about:blank 返回空串', () => {
  assert.equal(hostOf('https://www.bilibili.com/video/BV1'), 'www.bilibili.com');
  assert.equal(hostOf('about:blank'), '');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(undefined), '');
});
