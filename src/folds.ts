/**
 * folds.ts — fold 折叠规则的持久化(Node 侧)。
 * 规则文件放在浏览器用户数据目录(CDP_USER_DATA,默认 ~/.cdp-browser)下 folds.txt,
 * 跨会话持久、跨项目共享(规则是"针对站点的浏览器偏好",不属于任何业务项目)。
 *
 * 文件格式(tab 分隔,因 selector 可能含空格——genSel 生成后代选择器):
 *   <id>\t<域名>\t<selector>\t<备注>[\t<pathPrefix>]
 *   - id:稳定标识(单调递增,删除不重排),第一列纯数字即 id;旧格式无 id 行由 loadFolds 迁移补号
 *   - 域名:精确(www.bilibili.com)或后缀通配(*.zhihu.com 匹配 zhihu.com 及其所有子域)
 *   - pathPrefix:可选,有则要求页面 pathname 以它前缀(借鉴 uBlock matches-path,修同域名跨页错位)
 * 行首 # 为注释。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export interface FoldRule {
  id: number;
  domain: string;
  selector: string;
  note: string;
  pathPrefix?: string;
}

/** 规则文件路径:与浏览器用户数据同目录(跨会话/跨项目持久)。 */
function foldsPath(): string {
  const userData = process.env.CDP_USER_DATA || join(homedir(), '.cdp-browser');
  return join(userData, 'folds.txt');
}

/** 从 url 提取 hostname;非法/空白返回 ''(about:blank 等不参与 fold 匹配)。 */
export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try { return new URL(url).hostname; } catch { return ''; }
}

/** 从 url 提取 pathname(含根 /);非法/about:blank/无 hostname 返回 ''(与 hostOf 对齐,这些页不参与 fold)。 */
export function pathOf(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (!u.hostname) return ''; // about:blank 等无 host 的页不参与 fold
    return u.pathname || '/';
  } catch { return ''; }
}

/** 域名匹配:精确,或 *.suffix 后缀通配(suffix 自身 + 其任意子域)。 */
export function domainMatch(domain: string, hostname: string): boolean {
  if (!hostname) return false;
  if (domain.startsWith('*.')) {
    const base = domain.slice(2);
    return hostname === base || hostname.endsWith('.' + base);
  }
  return hostname === domain;
}

/** 第一列是否为 id(纯正整数,域名总含 . 或字母,不会误判)。 */
function isIdCol(s: string): boolean {
  return /^\d+$/.test(s.trim()) && s.trim() !== '0';
}

/**
 * 解析规则文本(逐行 tab 分列)。自适应新旧格式:
 *   - 第一列纯数字 → id 列,其后 domain/selector/note/pathPrefix
 *   - 否则旧格式:domain/selector/note/pathPrefix,id 留空(由 loadFolds 迁移补号)
 * 行首 # 注释;空行跳过;domain 或 selector 空跳过。
 * 返回的规则 id 可能为 0(表示"缺 id 待补"),供 loadFolds 判定是否需要迁移。
 */
export function parseRules(text: string): FoldRule[] {
  const rules: FoldRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const parts = raw.split('\t');
    let idx = 0;
    let id = 0;
    if (parts.length && isIdCol(parts[0])) {
      id = parseInt(parts[0], 10);
      idx = 1;
    }
    const domain = (parts[idx] || '').trim();
    const selector = (parts[idx + 1] || '').trim();
    const note = (parts[idx + 2] || '').trim();
    const pathPrefix = (parts[idx + 3] || '').trim() || undefined;
    if (!domain || !selector) continue;
    rules.push({ id, domain, selector, note, pathPrefix });
  }
  return rules;
}

/** 读全部持久规则;文件不存在返回空数组。读后若发现任何"缺 id"行,立即重写迁移(单调补号)。 */
export function loadFolds(): FoldRule[] {
  const p = foldsPath();
  if (!existsSync(p)) return [];
  let rules: FoldRule[];
  try { rules = parseRules(readFileSync(p, 'utf8')); }
  catch { return []; }
  if (rules.some(r => !r.id)) {
    // 旧格式或手工缺 id:按现有最大 id + 1 给缺 id 行补号,落盘迁移。
    let next = rules.reduce((m, r) => Math.max(m, r.id), 0);
    for (const r of rules) if (!r.id) r.id = ++next;
    writeRules(rules);
  }
  return rules;
}

/** 重写规则文件(保留各规则原 id,不再按行号重排——修连续 rm 漏删)。有 pathPrefix 才追加第 5 列。 */
function writeRules(rules: FoldRule[]): void {
  const p = foldsPath();
  mkdirSync(dirname(p), { recursive: true });
  const text = rules.map(r =>
    r.pathPrefix
      ? `${r.id}\t${r.domain}\t${r.selector}\t${r.note}\t${r.pathPrefix}`
      : `${r.id}\t${r.domain}\t${r.selector}\t${r.note}`,
  ).join('\n') + '\n';
  writeFileSync(p, text, 'utf8');
}

/** 追加一条持久规则。id = max(现有 id)+1(单调递增,不重排)。pathPrefix 可选。 */
export function addFold(domain: string, selector: string, note: string, pathPrefix?: string): FoldRule {
  const rules = loadFolds();
  const id = rules.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const rule: FoldRule = { id, domain, selector, note, pathPrefix: pathPrefix || undefined };
  rules.push(rule);
  writeRules(rules);
  return rule;
}

/** 按 id 删除一条持久规则;**保留其它规则原 id**(不重排)。返回是否删到。 */
export function removeFold(id: number): boolean {
  const rules = loadFolds();
  const next = rules.filter(r => r.id !== id);
  if (next.length === rules.length) return false;
  writeRules(next);
  return true;
}

/** 筛选匹配某 hostname(+pathname)的规则:domainMatch 外,有 pathPrefix 的再要求 pathname 前缀命中。 */
export function matchFolds(hostname: string, pathname?: string): FoldRule[] {
  return loadFolds().filter(r => {
    if (!domainMatch(r.domain, hostname)) return false;
    if (r.pathPrefix) {
      const p = pathname || '';
      // pathname 为空(非法 url/about:blank)时,带 pathPrefix 的规则不命中(避免误折)。
      return p.startsWith(r.pathPrefix);
    }
    return true;
  });
}
