/**
 * rules-store.ts — 规则持久化的统一目录与 seed-once(Node 侧)。
 *
 * 规则统一住 `~/.cdp-control/rules`(数据 home,spec「数据归用户目录」):用户本机它是指向
 * `src/rules/` 的符号链接(用户规则=根本规则,运行时读写直接落 git 工作树的 src/rules),干净环境
 * 是真实目录,seed-once 首跑缺文件时从包内 `src/rules/` 拷默认。recipe 作者代码直接读 git 权威、
 * 不做镜像(曾 seed 到 `rules/recipes/` 双份必漂移——见 2026-08 实测 _lib.js 漂移 22 字节)。
 *
 * 默认定位:`rulesDir()` 用 homedir(不依赖 __dirname,故 src/测试与 dist/编译一致);
 * `srcRulesDir()` 仍用 __dirname 定位包内 `src/rules/`(publish 随包,seed 源稳定)。
 */
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 实时规则目录(默认 ~/.cdp-control/rules,可用 CDP_RULES_DIR 覆盖用于测试)。 */
export function rulesDir(): string {
  return process.env.CDP_RULES_DIR || join(homedir(), '.cdp-control', 'rules');
}

/** 内置默认源(包内 src/rules/)。测试用 CDP_RULES_DEFAULT_DIR 覆盖(避免依赖 __dirname,strip-types 下无 __dirname)。 */
function srcRulesDir(): string {
  return process.env.CDP_RULES_DEFAULT_DIR || join(__dirname, '..', 'src', 'rules');
}

/** recipe 作者代码目录(直接读 git 权威,不做 gitignored 镜像)。recipe-runner 扫此加载。 */
export function srcRecipesDir(): string {
  return join(srcRulesDir(), 'recipes');
}

// 运行时可写数据的 live 文件名 → seed 文件名(src/rules/ 下同名)。
const SEEDS: readonly string[] = ['fold.csv', 'ignore-links.csv'];

/** seed-once:确保每个运行时可写规则文件在 rules/ 存在(缺则从 src/rules/ 拷默认)。幂等。 */
export function ensureRules(): void {
  mkdirSync(rulesDir(), { recursive: true });
  for (const name of SEEDS) {
    const live = join(rulesDir(), name);
    if (existsSync(live)) continue; // 已存在 → 不覆盖(保留用户编辑)
    const src = join(srcRulesDir(), name);
    if (existsSync(src)) copyFileSync(src, live);
  }
}

/** 实时 fold 规则文件路径(先 seed)。 */
export function foldsLivePath(): string {
  ensureRules();
  return join(rulesDir(), 'fold.csv');
}

/** 实时 ignore-links 规则文件路径(先 seed)。 */
export function linksLivePath(): string {
  ensureRules();
  return join(rulesDir(), 'ignore-links.csv');
}
