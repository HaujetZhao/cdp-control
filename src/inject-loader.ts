/**
 * inject-loader.ts — 注入脚本的加载与参数装配。
 *
 * 打包后的注入脚本(esbuild IIFE + footer 读全局)放在 dist/inject/<name>.js。
 * 本模块读取它,若需要参数则在前面拼一行 `var __CDP_ARG__ = <json>;`(注入脚本用自由标识符引用),
 * 返回可直接传给 CDP Runtime.evaluate 的完整表达式。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** dist/inject 目录(相对本模块编译产物所在 dist/)。 */
const INJECT_DIR = path.join(__dirname, 'inject');

// 缓存避免重复读盘。
const cache = new Map<string, string>();

/** 读取打包后的注入脚本源(去末尾换行)。 */
function read(name: string): string {
  if (!cache.has(name)) {
    cache.set(name, readFileSync(path.join(INJECT_DIR, `${name}.js`), 'utf8').trim());
  }
  return cache.get(name)!;
}

/**
 * 生成注入表达式。
 * @param name 注入入口名(对应 dist/inject/<name>.js),如 'tree' / 'snapshot' / 'click'。
 * @param args 可选参数对象,序列化为 JSON 前置到 `var __CDP_ARG__`。无参数则不前置。
 */
export function inject(name: string, args?: unknown): string {
  const code = read(name);
  if (args === undefined) return code;
  return `var __CDP_ARG__ = ${JSON.stringify(args)};\n${code}`;
}

/** 结构树入口(唯一感知命令)。selector/xpath 可选,缺省整页 body。 */
export function treeExpr(selector?: string, xpath?: string): string {
  return inject('tree', { selector, xpath });
}

/** 悬停入口(返回元素中心视口坐标)。 */
export function hoverExpr(sel: string): string {
  return inject('hover', { sel });
}

/** 读控制台日志入口。 */
export function readExpr(levelSet: string[] | null, since: number): string {
  return inject('read', levelSet ? { level: levelSet, since } : { since });
}
