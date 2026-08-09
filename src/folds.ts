/**
 * folds.ts — fold 折叠规则的持久化(Node 侧)。
 * 规则文件放在浏览器用户数据目录(CDP_USER_DATA,默认 ~/.cdp-browser)下 folds.txt,
 * 跨会话持久、跨项目共享(规则是"针对站点的浏览器偏好",不属于任何业务项目)。
 *
 * 文件格式(类 uBlock Origin):
 *   <域名>  <selector>  # <备注>
 * 域名可为精确(www.bilibili.com)或后缀通配(*.zhihu.com 匹配 zhihu.com 及其所有子域)。
 * selector 暂不支持含空格(单个复合选择器,折叠通常针对单个容器 class)。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export interface FoldRule { id: number; domain: string; selector: string; note: string }

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

/** 域名匹配:精确,或 *.suffix 后缀通配(suffix 自身 + 其任意子域)。 */
export function domainMatch(domain: string, hostname: string): boolean {
  if (!hostname) return false;
  if (domain.startsWith('*.')) {
    const base = domain.slice(2);
    return hostname === base || hostname.endsWith('.' + base);
  }
  return hostname === domain;
}

/** 解析规则文本(逐行;# 后为备注;空行/纯注释跳过)。id = 行号(1 基),供 rm 定位。 */
export function parseRules(text: string): FoldRule[] {
  const rules: FoldRule[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const hash = raw.indexOf('#');
    const body = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (!body) continue;
    const note = (hash >= 0 ? raw.slice(hash + 1) : '').trim();
    const parts = body.split(/\s+/);
    if (parts.length < 2) continue; // 至少 domain + selector
    const [domain, selector] = parts;
    rules.push({ id: i + 1, domain, selector, note });
  }
  return rules;
}

/** 读全部持久规则;文件不存在返回空数组。 */
export function loadFolds(): FoldRule[] {
  const p = foldsPath();
  if (!existsSync(p)) return [];
  try { return parseRules(readFileSync(p, 'utf8')); }
  catch { return []; }
}

/** 重写规则文件(丢掉 id,id 仅内存定位用)。 */
function writeRules(rules: Omit<FoldRule, 'id'>[]): void {
  const p = foldsPath();
  mkdirSync(dirname(p), { recursive: true });
  const text = rules.map(r => `${r.domain}\t${r.selector}` + (r.note ? `\t# ${r.note}` : '')).join('\n') + '\n';
  writeFileSync(p, text, 'utf8');
}

/** 追加一条持久规则。 */
export function addFold(domain: string, selector: string, note: string): FoldRule {
  const rules = loadFolds();
  const id = rules.length ? Math.max(...rules.map(r => r.id)) + 1 : 1;
  rules.push({ id, domain, selector, note });
  writeRules(rules);
  return { id, domain, selector, note };
}

/** 按 id 删除一条持久规则;返回是否删到。 */
export function removeFold(id: number): boolean {
  const rules = loadFolds();
  const next = rules.filter(r => r.id !== id);
  if (next.length === rules.length) return false;
  writeRules(next);
  return true;
}

/** 筛选匹配某 hostname 的规则(供 tree 时注入侧折叠用)。 */
export function matchFolds(hostname: string): FoldRule[] {
  return loadFolds().filter(r => domainMatch(r.domain, hostname));
}
