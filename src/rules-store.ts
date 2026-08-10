/**
 * rules-store.ts — 规则持久化的统一目录与 seed-once(Node 侧)。
 *
 * 规则是**数据非代码**,统一住在 skill 根的 `rules/`(gitignore,运行时读写,build 不清不覆盖),
 * 内置默认在 `src/rules/`(入库、权威、作为 seed 源)。fold / ignore-links / recipe 全部经此定位。
 *
 * seed-once:首跑某文件缺失时从 `src/rules/` 拷默认;已存在则不动(修 clobber——不再被 build 无条件覆盖)。
 *
 * 注意 `__dirname`:src(测试)与 dist(编译)同为项目根的**直接子目录**,故 `join(__dirname,'..')`
 * 在两种环境下都解析到项目根,`rules/` 与 `src/rules/` 的定位一致。
 */
import { existsSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 实时规则目录(默认 skill 根 rules/,可用 CDP_RULES_DIR 覆盖用于测试)。 */
export function rulesDir(): string {
  return process.env.CDP_RULES_DIR || join(__dirname, '..', 'rules');
}

/** 内置默认源(src/rules/)。测试用 CDP_RULES_DEFAULT_DIR 覆盖(避免依赖 __dirname,strip-types 下无 __dirname)。 */
function srcRulesDir(): string {
  return process.env.CDP_RULES_DEFAULT_DIR || join(__dirname, '..', 'src', 'rules');
}

// live 文件名 → seed 文件名(src/rules/ 下同名)。
const SEEDS: readonly string[] = ['fold.csv', 'ignore-links.csv'];

/** seed 默认 recipe:rules/recipes/ 缺某文件则从 src/rules/recipes/ 拷(已存在 → 不覆盖)。幂等。 */
function seedRecipes(): void {
  const srcDir = join(srcRulesDir(), 'recipes');
  const dstDir = join(rulesDir(), 'recipes');
  if (!existsSync(srcDir)) return;
  mkdirSync(dstDir, { recursive: true });
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith('.js')) continue;
    const dst = join(dstDir, f);
    if (!existsSync(dst)) copyFileSync(join(srcDir, f), dst);
  }
}

/** seed-once:确保每个规则文件在 rules/ 存在(缺则从 src/rules/ 拷默认)。幂等。 */
export function ensureRules(): void {
  mkdirSync(rulesDir(), { recursive: true });
  for (const name of SEEDS) {
    const live = join(rulesDir(), name);
    if (existsSync(live)) continue; // 已存在 → 不覆盖(保留用户编辑)
    const src = join(srcRulesDir(), name);
    if (existsSync(src)) copyFileSync(src, live);
  }
  seedRecipes();
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
