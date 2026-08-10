/**
 * rules-store.test.ts — 规则持久化统一目录 + seed-once 单测。
 * 用 CDP_RULES_DIR 指到临时目录,避免碰真实 rules/ 与 dist/。验证:
 *   首跑缺文件 → 从 src/rules/ 拷默认;已有 → 不覆盖(修 clobber);运行时 fold add 写进 rules/ 持久。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRules, foldsLivePath, linksLivePath } from '../src/rules-store.ts';
import { addFold } from '../src/folds.ts';

// strip-types(ESM)下无 __dirname,默认源用 CDP_RULES_DEFAULT_DIR 指到真实 src/rules。
const DEFAULT_RULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'rules');

function withRulesDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-rules-'));
  const prev = process.env.CDP_RULES_DIR;
  const prevD = process.env.CDP_RULES_DEFAULT_DIR;
  process.env.CDP_RULES_DIR = dir;
  process.env.CDP_RULES_DEFAULT_DIR = DEFAULT_RULES;
  try { return fn(dir); }
  finally {
    process.env.CDP_RULES_DIR = prev;
    process.env.CDP_RULES_DEFAULT_DIR = prevD;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('seed-once: 首跑缺文件从 src/rules/ 拷默认', () => {
  withRulesDir((dir) => {
    ensureRules();
    const fold = join(dir, 'fold.csv');
    assert.ok(existsSync(fold), 'fold.csv 被 seed');
    assert.ok(existsSync(join(dir, 'ignore-links.csv')), 'ignore-links.csv 被 seed');
    // 内容与默认源一致(默认源含 zhihu/csdn 折叠规则)
    assert.ok(readFileSync(fold, 'utf8').includes('www.zhihu.com'), '默认 fold.csv 含知乎规则');
    assert.equal(foldsLivePath(), join(dir, 'fold.csv'));
    assert.equal(linksLivePath(), join(dir, 'ignore-links.csv'));
  });
});

test('seed-once: 已有文件不被覆盖(修 clobber)', () => {
  withRulesDir((dir) => {
    const fold = join(dir, 'fold.csv');
    writeFileSync(fold, 'CUSTOM_RULE\n');
    ensureRules();
    assert.equal(readFileSync(fold, 'utf8'), 'CUSTOM_RULE\n', '已存在的用户编辑不被覆盖');
  });
});

test('运行时 fold add 写进 rules/ 且跨调用持久', () => {
  withRulesDir((dir) => {
    addFold('www.test.com', '/x/*', '.sel', '自定义');
    const fold = join(dir, 'fold.csv');
    assert.ok(readFileSync(fold, 'utf8').includes('www.test.com'), 'addFold 落盘 rules/fold.csv');
    // 二次读(不带 env CDP_FOLD_FILE)仍能读到,证明规则持久在 rules/
    ensureRules();
    assert.ok(readFileSync(fold, 'utf8').includes('www.test.com'), '跨调用不丢');
  });
});
