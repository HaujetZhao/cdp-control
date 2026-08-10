/**
 * article-links.test.ts — article 链接黑名单的纯函数单测(hrefForMatch/globToRegExp/linkRuleMatch/
 * matchLinkBlacklist/parseLinkRules)。文件读写(addLinkRule/removeLinkRule)用临时文件验证落盘往返。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hrefForMatch, globToRegExp, linkRuleMatch, matchLinkBlacklist, parseLinkRules,
  loadLinkRules, addLinkRule, removeLinkRule,
} from '../src/article-links.ts';

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-links-'));
  const prev = process.env.CDP_ARTICLE_LINKS_FILE;
  process.env.CDP_ARTICLE_LINKS_FILE = join(dir, 'article-links.csv');
  try { return fn(dir); }
  finally {
    process.env.CDP_ARTICLE_LINKS_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('hrefForMatch: 去协议/query/fragment,留 hostname+pathname', () => {
  assert.equal(hrefForMatch('https://zhida.zhihu.com/search?content_id=1&q=x#f'), 'zhida.zhihu.com/search');
  assert.equal(hrefForMatch('http://a.com/x/y?z=1'), 'a.com/x/y');
});

test('hrefForMatch: 非法 URL 返回原串', () => {
  assert.equal(hrefForMatch('not-a-url'), 'not-a-url');
});

test('globToRegExp: * 匹配任意字符(含 /)', () => {
  assert.equal(globToRegExp('zhida.zhihu.com/search*').test('zhida.zhihu.com/search'), true);
  assert.equal(globToRegExp('zhida.zhihu.com/search*').test('zhida.zhihu.com/search/extra'), true);
  assert.equal(globToRegExp('*.zhihu.com/*').test('www.zhihu.com/question/x'), true);
  assert.equal(globToRegExp('*.zhihu.com/*').test('baidu.com/x'), false);
});

test('linkRuleMatch: 空 pattern 全命中;非空 glob 命中 hrefForMatch', () => {
  assert.equal(linkRuleMatch({ id: 1, pattern: '', note: '' }, 'https://anything.com/x'), true);
  assert.equal(linkRuleMatch({ id: 1, pattern: 'zhida.zhihu.com/search*', note: '' }, 'https://zhida.zhihu.com/search?q=词'), true);
  assert.equal(linkRuleMatch({ id: 1, pattern: 'zhida.zhihu.com/search*', note: '' }, 'https://example.com/x'), false);
});

test('matchLinkBlacklist: 命中任一即 true', () => {
  const rules = [{ id: 1, pattern: 'zhida.zhihu.com/search*', note: '' }];
  assert.equal(matchLinkBlacklist(rules, 'https://zhida.zhihu.com/search?q=a'), true);
  assert.equal(matchLinkBlacklist(rules, 'https://www.baidu.com/x'), false);
  assert.equal(matchLinkBlacklist([], 'https://zhida.zhihu.com/search'), false);
});

test('parseLinkRules: 3 列 id/pattern/note,注释与垃圾行跳过', () => {
  const txt = '# 注释\n\n1\tzhida.zhihu.com/search*\t知乎词\nnotnum\ta\tb\n2\t*.x.com/*\t\n';
  const r = parseLinkRules(txt);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { id: 1, pattern: 'zhida.zhihu.com/search*', note: '知乎词' });
  assert.deepEqual(r[1], { id: 2, pattern: '*.x.com/*', note: '' });
});

test('addLinkRule/removeLinkRule: 落盘往返 + id 单调 + 删除不重排', () => withTmpDir(() => {
  assert.deepEqual(loadLinkRules(), []);
  const a = addLinkRule('zhida.zhihu.com/search*', '知乎词');
  const b = addLinkRule('*.ads.com/*');
  assert.equal(a.id, 1); assert.equal(b.id, 2); // 单调递增
  assert.equal(loadLinkRules().length, 2);
  assert.equal(removeLinkRule(1), true);
  assert.equal(removeLinkRule(99), false);
  const left = loadLinkRules();
  assert.equal(left.length, 1);
  assert.equal(left[0].id, 2); // 删除 1 后 2 不重排
}));
