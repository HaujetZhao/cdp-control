/**
 * result.ts — 注入脚本的结果写入 helper。
 * 注入脚本把结果写到 globalThis.__cdpResult,build.mjs 的 footer 追加一行"读取+删除+返回",
 * 使 Runtime.evaluate 的 returnByValue 拿到整体完成值。类型上避免直接给 globalThis 加任意属性。
 */

/** 把注入脚本的结果写入全局契约变量,返回原值(便于链式 return)。 */
export function setResult<T>(v: T): T {
  (globalThis as unknown as { __cdpResult?: T }).__cdpResult = v;
  return v;
}
