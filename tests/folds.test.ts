/**
 * folds.test.ts — fold 规则文件的纯函数单测(parseRules/domainMatch/hostOf)。
 * 文件读写(loadFolds/addFold/removeFold)依赖磁盘,按 ponytail 用临时 CDP_USER_DATA 验证落盘往返。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRules, domainMatch, hostOf } from '../src/folds.ts';

test('parseRules: 域名+selector+# 备注;行号=所在行(1 基)', () => {
  const txt = '# 注释\n\nwww.bilibili.com  .bili-header  # 顶部导航\n*.zhihu.com .AppHeader #知乎顶栏\n';
  const r = parseRules(txt);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { id: 3, domain: 'www.bilibili.com', selector: '.bili-header', note: '顶部导航' });
  assert.deepEqual(r[1], { id: 4, domain: '*.zhihu.com', selector: '.AppHeader', note: '知乎顶栏' });
});

test('parseRules: 无备注(# 缺省)行不报错', () => {
  const r = parseRules('a.com .x\n');
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
