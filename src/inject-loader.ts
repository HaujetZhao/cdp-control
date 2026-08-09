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
 * @param name 注入入口名(对应 dist/inject/<name>.js),如 'tree' / 'click'。
 * @param args 可选参数对象,序列化为 JSON 前置到 `var __CDP_ARG__`。无参数则不前置。
 */
export function inject(name: string, args?: unknown): string {
  const code = read(name);
  if (args === undefined) return code;
  return `var __CDP_ARG__ = ${JSON.stringify(args)};\n${code}`;
}

/** 结构树入口(唯一感知命令)。锚点互斥:ref 优先,其次 selector,缺省整页 body;
 * visibleOnly 只输出视口内可见;ancestor 为统一爬父修饰符(对任一锚点生效);folds 为当前 hostname 命中的折叠规则。
 * scrollToLoad 启用滚动加载(默认 ±1 屏回弹);scrollPages 循环滚 N 屏(边滚边检测增长);
 * scrollTo 先滚到该 selector 元素(B站评论区容器)。 */
export function treeExpr(
  selector?: string, visibleOnly?: boolean, ref?: number, ancestor?: number,
  scrollToLoad?: boolean, folds?: unknown, scrollPages?: number, scrollTo?: string,
): string {
  return inject('tree', {
    selector, visibleOnly: visibleOnly || undefined, ref, ancestor,
    scrollToLoad: scrollToLoad || undefined,
    scrollPages: scrollPages != null ? scrollPages : undefined,
    scrollTo: scrollTo || undefined,
    folds,
  });
}

/** locate:按 tree 的 ref 反查稳定 CSS selector,可选 --ancestor 爬父。 */
export function locateExpr(ref: number, ancestor?: number): string {
  return inject('ref', { ref, ancestor });
}

/** lineage:列目标元素(爬 ancestor 后)从 html 到自身的祖先链,供 agent 挑稳定锚点写 fold 规则。 */
export function lineageExpr(ref: number, ancestor?: number): string {
  return inject('lineage', { ref, ancestor });
}

/** 读控制台日志入口。 */
export function readExpr(levelSet: string[] | null, since: number): string {
  return inject('read', levelSet ? { level: levelSet, since } : { since });
}

/** fold:会话级临时折叠(ref/ancestor/note;list 列出临时;clear 清空临时)。持久规则由 Node 侧 folds.ts 处理。 */
export function foldExpr(args: { ref?: number; ancestor?: number; note?: string; list?: boolean; clear?: boolean }): string {
  return inject('fold', args);
}
