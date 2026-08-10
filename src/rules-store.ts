/**
 * rules-store.ts — 规则持久化的统一目录与 seed-once(Node 侧)。
 *
 * 规则分两种生命周期,分别落两处:
 * - **运行时可写数据**(fold.csv / ignore-links.csv):住 skill 根 `rules/`(gitignore,运行时读写),
 *   内置默认在 `src/rules/`(入库、权威),seed-once 首跑缺文件时拷默认,已存在不覆盖。
 * - **作者代码**(recipe,`src/rules/recipes/*.js`):直接读 git 权威,不做 gitignored 镜像
 *   (曾 seed 到 `rules/recipes/`,两份手动同步必然漂移——见 2026-08 实测 _lib.js 漂移 22 字节)。
 *
 * 注意 `__dirname`:src(测试)与 dist(编译)同为项目根的**直接子目录**,故 `join(__dirname,'..')`
 * 在两种环境下都解析到项目根,`rules/` 与 `src/rules/` 的定位一致。
 */
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 实时规则目录(默认 skill 根 rules/,可用 CDP_RULES_DIR 覆盖用于测试)。 */
export function rulesDir(): string {
  return process.env.CDP_RULES_DIR || join(__dirname, '..', 'rules');
}

/** 内置默认源(src/rules/)。测试用 CDP_RULES_DEFAULT_DIR 覆盖(避免依赖 __dirname,strip-types 下无 __dirname)。 */
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
