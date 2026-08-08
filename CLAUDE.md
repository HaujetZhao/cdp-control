# cdp-browser-control 开发者说明

> 面向**开发者**(维护本 skill 源码的人)。**agent 使用本 skill 时只需要 `SKILL.md`,不需要看这里。**
> 运行入口:`node dist/cdp.js`(需先构建)。

## 构建

本项目的 `dist/`(实际运行产物)不提交 git,改动源码后需重建:

```bash
npm install      # 首次:装 esbuild / typescript / @types/node
npm run build    # tsc --noEmit(类型检查) + esbuild(编译 + 打包注入脚本)
npm test         # node:test 跑 tests/*.test.ts(零运行时依赖)
```

`npm run build` 产出的 `dist/` 结构:
```
dist/cdp.js              入口(require.main 守卫,组装 api + CLI)
dist/api.js / transport.js / monitor.js / browser.js / inject-loader.js   Node 侧
dist/inject/*.js         注入到浏览器页面跑的 JS(esbuild 打包成自包含 IIFE)
```

## 源码结构(两层,彻底分离)

| 目录 | 内容 | 运行环境 | 编译 |
|---|---|---|---|
| `src/*.ts` | Node 侧(连接 CDP、CLI、api) | Node | esbuild 转译 CJS(不打包) |
| `src/inject/*.ts` | 注入浏览器页面执行的 JS | 浏览器(DOM lib) | esbuild bundle 成 IIFE → `dist/inject/` |
| `src/inject/lib/` | 注入侧共享模块(genSel/result/arg/monitor-inject/tree-utils) | 浏览器 | 打进各入口 |

依赖单向无环:`transport ← inject-loader/api ← monitor/browser ← cdp`。

## 注入脚本契约(改动注入脚本必读)

注入脚本经 esbuild 打包成自包含 IIFE,`Runtime.evaluate` 的 `returnByValue` 取整体完成值。
esbuild 会把入口包进 module wrapper、吞掉返回值,故:

1. **结果写入**:注入脚本把结果写到全局 `globalThis.__cdpResult`(用 `src/inject/lib/result.ts` 的 `setResult`)。
2. **footer 读取**:`build.mjs` 给每个入口统一追加 footer `;(()=>{const r=globalThis.__cdpResult;delete globalThis.__cdpResult;return r})()`——整体完成值即结果,且读完即删、无残留。
3. **参数传递**:注入脚本用自由标识符 `__CDP_ARG__`(TS 里 `declare const __CDP_ARG__: XxxArgs`),Node 侧 `src/inject-loader.ts` 注入前拼一行 `var __CDP_ARG__ = <json>;`。无需字符串替换。
4. **入参数类型**在 `src/inject/lib/arg.ts`(FindArgs/FillArgs/TreeArgs/ReadArgs)。

**新增注入入口的步骤**:在 `src/inject/` 加一个 `.ts`(顶层,不进 lib/),用 `setResult` + 可选 `__CDP_ARG__`,重建即可自动打包成 `dist/inject/<名>.js`。**注意**:注入侧代码跑在浏览器,不能用 Node API;类型只在编译期(DOM lib)。

## 测试

- `tests/*.test.ts` 用 Node 内置 `node:test` + `node:assert/strict`,零运行时依赖。
- 目前测 `src/inject/lib/tree-utils.ts` 的纯函数(inlineLen/inlineable/leafText/firstTxt/isTrivialLeaf)。
- 注入侧 DOM 相关逻辑(如 tree 的 simplify/walk)依赖真实 DOM,靠浏览器实测验收(见 SKILL.md 用法),不写单测。

## 文档分工

- `SKILL.md`:面向 **agent 使用**,只讲怎么调 `dist/cdp.js`,不含构建/源码结构。
- `CLAUDE.md`(本文件):面向 **开发者**,含构建、源码结构、注入契约、测试。
- `docs/superpowers/specs/`:设计文档。根目录不再放 DESIGN md。
