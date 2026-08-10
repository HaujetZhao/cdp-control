/**
 * recipe-runner.ts — 站点抽取配方的加载与执行(Node 侧)。
 *
 * recipe = URL 作用域的 Node 模块(CJS `module.exports={scope, extract}`),放 `rules/recipes/<name>.js`。
 * 命中时 `view`/`fetch`(CLI action 顶层分发)跑它,得到 `{lines}`(文本+内嵌 [ref=N])。
 * 与 fold/ignore-links 共享 `rules/` 目录与 url-scope 匹配;但它是**独立机制**(过程式编排,非 view 内纯变换)。
 *
 * 信任边界:recipe 是作者信任的本地代码(等同 run 脚本),非沙箱。extract 收到 `cdp` 参数(完整 api)。
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { urlMatches } from './url-scope.ts';
import { rulesDir } from './rules-store.ts';

interface RecipeMeta {
  scope: string;
  extract: (cdp: any, ctx: { target: any; opts: any }) => Promise<{ lines?: string[] } | null>;
}

export interface RecipeHit { name: string; meta: RecipeMeta }

/** 列出 rules/recipes/*.js 的 recipe(读取 scope 做匹配;加载失败的跳过)。 */
function listRecipes(): RecipeHit[] {
  const dir = join(rulesDir(), 'recipes');
  if (!existsSync(dir)) return [];
  const hits: RecipeHit[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    let meta: RecipeMeta;
    try { meta = require(join(dir, f)) as RecipeMeta; } catch { continue; }
    if (meta && typeof meta.scope === 'string' && meta.scope) hits.push({ name: f.slice(0, -3), meta });
  }
  return hits;
}

/** 找命中 url 的最具体 recipe:通配符最少 → scope 更长 → 声明顺序(确定性全序)。 */
export function matchRecipe(url: string): RecipeHit | null {
  const wild = (s: string) => (s.match(/\*/g) || []).length;
  const hits = listRecipes().filter(r => urlMatches(r.meta.scope, url));
  if (!hits.length) return null;
  hits.sort((a, b) =>
    (wild(a.meta.scope) - wild(b.meta.scope)) || (b.meta.scope.length - a.meta.scope.length));
  return hits[0];
}

/** 跑命中 url 的 recipe,返回 `{lines}`;无命中 / extract 异常 / 返回不含 lines → null(上层安全回落树)。 */
export async function runRecipe(url: string, cdp: any, target: any, opts: any): Promise<{ lines: string[] } | null> {
  const r = matchRecipe(url);
  if (!r) return null;
  try {
    const out = await r.meta.extract(cdp, { target, opts });
    if (!out || !Array.isArray(out.lines)) return null;
    return { lines: out.lines };
  } catch (e) {
    console.error(`[recipe ${r.name}] 失败,回落树:`, (e as Error)?.message || e);
    return null;
  }
}
