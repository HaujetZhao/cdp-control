/**
 * ignore-links.ts — 链接黑名单的持久化(Node 侧)。
 * 命中黑名单的链接在 article/view 里**只留文本、去 URL**(如知乎 `zhida.zhihu.com/search?...` 词汇释义内部链接,
 * URL 是超长 search 串、无跳转价值,文本才是正文里的词)。跨会话持久。
 *
 * 文件格式(csv,tab 分隔,3 列,dist/ignore-links.csv,与 cdp.js 同级便于手动编辑):
 *   <id>\t<pattern>\t<note>
 *   - id:稳定标识(单调递增,删除不重排)
 *   - pattern:链接通配符(glob,`*` 匹配任意字符含 /),匹配 href 的 hostname+pathname(去协议/去 query)
 *     —— 如 `zhida.zhihu.com/search*` 命中 https://zhida.zhihu.com/search?content_id=...&q=词
 *   - note:备注
 * 行首 # 为注释。pattern 为空 = 匹配所有。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { globToRegExp } from './url-scope.ts';

export interface LinkRule { id: number; pattern: string; note: string }

/** 规则文件路径:与 cdp.js 同级(dist/ 下),便于手动编辑;随 dist 拷贝走、跨会话持久。
 * 测试用 CDP_IGNORE_LINKS_FILE 覆盖到临时文件,避免写进真实 dist/ignore-links.csv。 */
function linksPath(): string {
  return process.env.CDP_IGNORE_LINKS_FILE || join(__dirname, 'ignore-links.csv');
}

/** 取链接用于模式匹配的串:hostname + pathname(去协议/去 query/去 fragment)。解析失败返回原串。 */
export function hrefForMatch(href: string): string {
  try {
    const u = new URL(href);
    return u.hostname + u.pathname;
  } catch { return href; }
}

/** 单条规则是否命中某链接:pattern 为空 = 全命中;否则 glob 匹配 hrefForMatch(href)(globToRegExp 共享自 url-scope)。 */
export function linkRuleMatch(rule: LinkRule, href: string): boolean {
  if (!rule.pattern) return true;
  return globToRegExp(rule.pattern).test(hrefForMatch(href));
}

/** 链接是否命中任一黑名单规则。 */
export function matchLinkBlacklist(rules: LinkRule[], href: string): boolean {
  return rules.some(r => linkRuleMatch(r, href));
}

/**
 * 解析规则文本(逐行 tab 分列,3 列 id/pattern/note)。
 * 第一列必须纯数字 id,否则该行跳过(旧格式/垃圾行,不迁移)。行首 # 注释;空行跳过。
 */
export function parseLinkRules(text: string): LinkRule[] {
  const rules: LinkRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const parts = raw.split('\t');
    if (!/^\d+$/.test(parts[0].trim())) continue;
    rules.push({
      id: parseInt(parts[0], 10),
      pattern: (parts[1] || '').trim(),
      note: (parts[2] || '').trim(),
    });
  }
  return rules;
}

/** 读全部持久黑名单规则;文件不存在返回空数组。 */
export function loadLinkRules(): LinkRule[] {
  const p = linksPath();
  if (!existsSync(p)) return [];
  try { return parseLinkRules(readFileSync(p, 'utf8')); }
  catch { return []; }
}

/** 重写规则文件(保留各规则原 id,不按行号重排)。 */
function writeLinkRules(rules: LinkRule[]): void {
  const text = rules.map(r => `${r.id}\t${r.pattern}\t${r.note}`).join('\n') + '\n';
  writeFileSync(linksPath(), text, 'utf8');
}

/** 追加一条持久黑名单规则。id = max(现有 id)+1(单调递增,不重排)。 */
export function addLinkRule(pattern: string, note = ''): LinkRule {
  const rules = loadLinkRules();
  const id = rules.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const rule: LinkRule = { id, pattern, note };
  rules.push(rule);
  writeLinkRules(rules);
  return rule;
}

/** 按 id 删除一条持久黑名单规则;**保留其它规则原 id**(不重排)。返回是否删到。 */
export function removeLinkRule(id: number): boolean {
  const rules = loadLinkRules();
  const next = rules.filter(r => r.id !== id);
  if (next.length === rules.length) return false;
  writeLinkRules(next);
  return true;
}
