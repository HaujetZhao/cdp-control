/**
 * folds.test.ts — fold 规则文件的纯函数单测(parseRules/domainMatch/hostOf/pathOf/matchFolds)。
 * 文件读写(loadFolds/addFold/removeFold 迁移+稳定 id)依赖磁盘,用临时 CDP_USER_DATA 验证落盘往返。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRules, domainMatch, hostOf, pathOf, matchFolds, loadFolds, addFold, removeFold,
} from '../src/folds.ts';

// 每个需要落盘的测试用独立临时目录,避免互相污染 / 污染用户真实 folds.txt。
function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-folds-'));
  const prev = process.env.CDP_USER_DATA;
  process.env.CDP_USER_DATA = dir;
  try { return fn(dir); }
  finally {
    process.env.CDP_USER_DATA = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('parseRules: 旧三列格式(无 id)→ id 留 0,等 loadFolds 迁移补号', () => {
  const txt = '# 注释\n\nwww.bilibili.com\t.bili-header\t顶部导航\n*.zhihu.com\t.AppHeader\t知乎顶栏\n';
  const r = parseRules(txt);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { id: 0, domain: 'www.bilibili.com', selector: '.bili-header', note: '顶部导航', pathPrefix: undefined });
  assert.deepEqual(r[1], { id: 0, domain: '*.zhihu.com', selector: '.AppHeader', note: '知乎顶栏', pathPrefix: undefined });
});

test('parseRules: 新四列格式(带 id)→ 保留原 id', () => {
  const r = parseRules('3\twww.bilibili.com\t.bili-header\t顶部导航\n7\t*.zhihu.com\t.AppHeader\t知乎顶栏\n');
  assert.equal(r.length, 2);
  assert.equal(r[0].id, 3);
  assert.equal(r[1].id, 7);
});

test('parseRules: 五列(带 pathPrefix)→ 第 5 列读入', () => {
  const r = parseRules('1\twww.bilibili.com\t#biliMainHeader\t顶栏\t/video\n');
  assert.equal(r.length, 1);
  assert.equal(r[0].pathPrefix, '/video');
});

test('parseRules: selector 含空格(后代选择器)不被切碎', () => {
  const r = parseRules('1\twww.bilibili.com\t#app > div:nth-of-type(2) > div\t顶栏\n');
  assert.equal(r.length, 1);
  assert.equal(r[0].selector, '#app > div:nth-of-type(2) > div');
});

test('parseRules: 第一列纯数字才当 id;域名(含.)不被误判', () => {
  // 旧格式首列是域名(www.bilibili.com),不能当成 id
  const r = parseRules('www.bilibili.com\t.x\t顶栏\n');
  assert.equal(r[0].id, 0);
  assert.equal(r[0].domain, 'www.bilibili.com');
});

test('parseRules: 无备注(第三列空)行不报错', () => {
  const r = parseRules('1\ta.com\t.x\t\n');
  assert.deepEqual(r[0], { id: 1, domain: 'a.com', selector: '.x', note: '', pathPrefix: undefined });
});

test('parseRules: 仅域名无 selector 的行跳过', () => {
  assert.equal(parseRules('1\ta.com\n').length, 0);
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

test('pathOf: 正常 url 取 pathname;无路径返回 /;非法返回空串', () => {
  assert.equal(pathOf('https://www.bilibili.com/video/BV1'), '/video/BV1');
  assert.equal(pathOf('https://www.bilibili.com/'), '/');
  assert.equal(pathOf('about:blank'), '');
  assert.equal(pathOf(undefined), '');
});

test('matchFolds: 无 pathPrefix 规则只看域名', () => {
  const txt = '1\twww.bilibili.com\t#hdr\t顶栏\n';
  withTmpDir(dir => {
    writeFileSync(join(dir, 'folds.txt'), txt, 'utf8');
    const m = matchFolds('www.bilibili.com', '/video/BV1');
    assert.equal(m.length, 1);
    assert.equal(m[0].selector, '#hdr');
  });
});

test('matchFolds: pathPrefix 规则要求 pathname 前缀命中(同域名跨页区分)', () => {
  // 同域名两条不同 pathPrefix 规则:视频页 vs 账户页,验证跨页不互相命中
  const txt = '1\twww.bilibili.com\t#videoHdr\t视频页顶栏\t/video\n2\twww.bilibili.com\t#accountHdr\t账户页顶栏\t/account\n';
  withTmpDir(dir => {
    writeFileSync(join(dir, 'folds.txt'), txt, 'utf8');
    // 视频页只命中 /video 规则(/account 不命中)
    let m = matchFolds('www.bilibili.com', '/video/BV1');
    assert.equal(m.length, 1);
    assert.equal(m[0].selector, '#videoHdr');
    // 账户页只命中 /account 规则
    m = matchFolds('www.bilibili.com', '/account/home');
    assert.equal(m.length, 1);
    assert.equal(m[0].selector, '#accountHdr');
    // 首页 / 不命中任何带 pathPrefix 的规则
    m = matchFolds('www.bilibili.com', '/');
    assert.equal(m.length, 0);
  });
});

test('matchFolds: pathPrefix 规则在 pathname 为空(非法 url)时不命中', () => {
  const txt = '1\twww.bilibili.com\t#videoHdr\t顶栏\t/video\n';
  withTmpDir(dir => {
    writeFileSync(join(dir, 'folds.txt'), txt, 'utf8');
    assert.equal(matchFolds('www.bilibili.com', '').length, 0);
  });
});

test('loadFolds: 旧三列格式自动迁移补号 + 重写为四列', () => {
  withTmpDir(dir => {
    writeFileSync(join(dir, 'folds.txt'), 'www.bilibili.com\t.a\tA\n*.zhihu.com\t.b\tB\n', 'utf8');
    const r = loadFolds();
    assert.equal(r.length, 2);
    assert.equal(r[0].id, 1);
    assert.equal(r[1].id, 2);
    // 重写后文件应是四列格式(带 id)
    const txt = readFileSync(join(dir, 'folds.txt'), 'utf8');
    assert.ok(txt.startsWith('1\twww.bilibili.com\t.a\tA\n'));
    assert.ok(txt.includes('2\t*.zhihu.com\t.b\tB\n'));
  });
});

test('addFold: id 单调递增(max+1),不按行号重排', () => {
  withTmpDir(dir => {
    writeFileSync(join(dir, 'folds.txt'), '5\ta.com\t.a\tA\n8\tb.com\t.b\tB\n', 'utf8');
    const r = addFold('c.com', '.c', 'C');
    assert.equal(r.id, 9); // max(5,8)+1
    const all = loadFolds();
    assert.deepEqual(all.map(x => x.id), [5, 8, 9]);
  });
});

test('addFold: 带 pathPrefix 落盘为五列', () => {
  withTmpDir(dir => {
    const r = addFold('www.bilibili.com', '#biliMainHeader', '顶栏', '/video');
    assert.equal(r.pathPrefix, '/video');
    const txt = readFileSync(join(dir, 'folds.txt'), 'utf8');
    assert.equal(txt, '1\twww.bilibili.com\t#biliMainHeader\t顶栏\t/video\n');
  });
});

test('removeFold: 按 id 删,其它规则保留原 id(连续 rm 不漏删)', () => {
  withTmpDir(dir => {
    writeFileSync(join(dir, 'folds.txt'), '5\ta.com\t.a\tA\n8\tb.com\t.b\tB\n9\tc.com\t.c\tC\n', 'utf8');
    // 模拟 agent 连续删两条:先删 5,再删 8(B8 bug 场景:行号重排会导致第二次删错)
    assert.equal(removeFold(5), true);
    let all = loadFolds();
    assert.deepEqual(all.map(x => x.id), [8, 9]); // 删 5 后 8、9 不变
    assert.equal(removeFold(8), true);
    all = loadFolds();
    assert.deepEqual(all.map(x => x.id), [9]); // 只剩 9,没漏删
  });
});

test('removeFold: 删不存在的 id 返回 false,文件不变', () => {
  withTmpDir(dir => {
    writeFileSync(join(dir, 'folds.txt'), '5\ta.com\t.a\tA\n', 'utf8');
    assert.equal(removeFold(99), false);
    assert.equal(loadFolds().length, 1);
  });
});
