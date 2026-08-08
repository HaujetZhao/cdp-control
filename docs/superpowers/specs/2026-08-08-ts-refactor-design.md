# 设计文档:cau 项目全 TS + esbuild 重构

日期:2026-08-08
状态:已批准(用户确认「方案C: 全 TS + 打包」「编译到 dist/ 再跑」)

## 1. 问题

当前 `lib/scripts.js` 里注入到浏览器页面的 JS 全部是**手写模板字符串**:

- 无语法高亮 / 无语法检查(编辑器只看到一个 `\`` 字符串,内层纯黑)。
- 转义地狱:内层 `\n` → `\\n`、`​` → `\\u200B`、反引号被禁用。
- 无法 `require`、无法直接单测,逻辑只能靠浏览器实测。
- 170 行挤在一个 `return \`...\`` 里,prettier/eslint 无法格式化。

同样的病在 `lib/api.js` 的 `shadowXPathExpr` 也有。所有注入脚本(`SNAPSHOT/CLICK/FILL/MONITOR/CONTENT/tree`)全被殃及。

## 2. 目标

把「Node 侧注入代码」和「注入到浏览器页面里跑的 JS」彻底拆开,各自用 TS 编写、各自编译:

- 写注入脚本时是正经 TS(语法高亮、可选链、缩进、可 `import` 复用)。
- 反引号禁用 / `\n` 转义由 esbuild 处理,不再手写「字符串里的字符串」。
- 注入侧纯函数可单测,不用再靠浏览器实测猜行为。
- 全项目有类型(注入侧用 DOM lib,Node 侧用 node types)。

## 3. 两层代码结构

| | Node 侧 | 注入页侧 |
|---|---|---|
| 目录 | `src/` | `src/inject/` |
| 运行环境 | Node | 浏览器(DOM lib) |
| 编译 | esbuild → `dist/` CJS | esbuild → `dist/inject/*.js` 自包含 IIFE |
| 产出 | `dist/cdp.js` `dist/api.js` 等 | 纯字符串文件 |

### 3.1 注入侧(`src/inject/`)

每个入口一个文件,打包后是一个自包含 IIFE 字符串(Node 读到后注入 CDP `Runtime.evaluate`):

- `genSel.ts` — 共享的 `genSel` 纯函数。
- `snapshot.ts` — 可交互元素清单。
- `tree.ts` — 结构树(最大最复杂,含 tree-utils)。
- `tree-utils.ts` — 抽出的纯函数:`isTrivialLeaf`/`inlineable`/`inlineLen`/`leafText`/`firstTxt`/`strip` 等。
- `content.ts` — 主内容文本。
- `outline.ts` — 标题层级 + 关键链接。
- `monitor.ts` — 控制台监控脚本。
- `click.ts` `fill.ts` `focus.ts` — 操作类(含 `FIND_EL`)。

打包规则:每个文件用 esbuild `format=iife` 打成一个自包含字符串,存到 `dist/inject/<name>.js`。Node 侧 `readFileSync` 读取后注入。

注入字符串里可以有任意字符(含反引号),因为 Node 侧只是「读文件 → `JSON.stringify` 传给 CDP」,不再嵌入别的模板串——反引号禁用限制消失。

### 3.2 Node 侧(`src/`)

- `cdp.ts` — CLI 入口 + 最终 api 组装。
- `api.ts` — 高层页面操作 API(调 transport + 注入脚本)。
- `transport.ts` — 低级 CDP 连接与 target 原语。
- `browser.ts` — 确保浏览器就绪。
- `monitor.ts` — 控制台监听 daemon + logs。
- `types.ts` — 共享类型(Target、日志条目、api 形状等)。

依赖关系沿用现状,保持无环:`transport` ← `api`/`monitor`/`browser`。

### 3.3 共享辅助(`src/inject/_shared/` 可选)

注入脚本之间共享的纯工具(如 `genSel`、`strip`、`escapeCss`)放独立模块,esbuild 打进各入口。

## 4. 构建管线

```
npm run build
  ├─ tsc --noEmit            # 类型检查(esbuild 不查类型)
  └─ esbuild
       ├─ src/*.ts        → dist/  (platform=node, format=cjs, packages=external)
       └─ src/inject/*.ts → dist/inject/*.js  (format=iife, bundle, minify 可选)
```

- Node 侧 esbuild 配置:`platform=node, format=cjs, packages=external`(Node 内建模块不外打)。
- 注入侧 esbuild 配置:`format=iife, bundle=true`(把 import 的共享模块打进去,产出自包含 IIFE)。
- `tsc --noEmit` 负责类型检查(esbuild 不做类型检查)。

### 4.1 注入脚本的运行时读取

Node 侧不再 `import { buildTreeExpr } from './scripts'` 构造字符串,而是运行时读打包产物:

```ts
// src/inject-loader.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, string>();
export function loadInject(name: string): string {
  if (!cache.has(name)) {
    cache.set(name, readFileSync(path.join(__dirname, 'inject', `${name}.js`), 'utf8'));
  }
  return cache.get(name)!;
}
```

树根表达式的参数化(`--selector`/`--xpath`)沿用现有 `rootExprOf` 思路,但不再是拼进模板串——改为把参数单独 `JSON.stringify` 后与加载的 IIFE 串拼起来(仍需注意别把参数内嵌成字符串里的字符串;用 `JSON.stringify` 保持安全)。

### 4.2 注入返回值契约(关键,已实证)

`Runtime.evaluate` 的 `returnByValue` 取**整体代码最后一条表达式的完成值**。esbuild 打包会把入口包进外层 module wrapper(`require_tree()` 完成值是 `undefined`),直接吞掉返回值——`bundle:false` 也不例外。

**已实证的方案**:注入脚本把结果写到 `globalThis.__cdpResult`,esbuild 用 `footer` 追加一行"读取 + 删除 + 返回":

```
footer: { js: ';(() => { const r = globalThis.__cdpResult; delete globalThis.__cdpResult; return r; })()' }
```

实测:整体完成值正确返回,`globalThis.__cdpResult` 读取后即清除、无残留。这样注入侧可以正常用 `import` 复用共享模块(esbuild 打进 bundle),返回值契约不变——**单次 evaluate 拿结果,不引入第二轮往返**。

## 5. 可测试性

注入侧纯函数(`tree-utils.ts`)可在 Node 里直接测,不依赖 DOM。用 vitest(可选)或 Node 内置 `node:test` + `node:assert`(零额外依赖)。测试放 `tests/`。

DOM 依赖的集成逻辑(tree 的 `simplify`/`walk` 需真实 DOM)仍靠浏览器实测验收。

## 6. 迁移顺序

1. **脚手架**:`package.json`(type 处理 + scripts)、`tsconfig.json`、`esbuild` 构建脚本、`.gitignore`(dist/node_modules)。
2. **注入脚本先迁**:把 `scripts.js` 各脚本抽成 `src/inject/*.ts`,esbuild 打包,验证产物能注入跑通。
3. **Node 侧迁 `src/`**:`cdp.ts`/`api.ts`/`transport.ts`/`browser.ts`/`monitor.ts`/`types.ts`,改造为读注入产物。
4. **抽纯函数加单测**:`tree-utils.ts` + `tests/`。
5. **更新 SKILL.md**:`run` 指向 `node dist/cdp.js`;文档注明改代码后需 `npm run build`。
6. **清理**:删 `lib/`、`cdp.js`(旧入口),或保留 `dist` 为运行入口。

## 7. 运行方式(变更)

- 之前:`node cdp.js <子命令>`。
- 之后:`node dist/cdp.js <子命令>`(需先 `npm run build`)。
- 新增 `npm run build`(tsc --noEmit + esbuild)、`npm run typecheck`、`npm test`。

## 8. 新依赖

- `typescript`(类型检查)
- `esbuild`(打包/编译)
- `@types/node`(Node 侧类型)
- `vitest` 或 `node:test`(测试,可选,倾向 `node:test` 以保持轻量)

零依赖时代结束;代价是 `run` 前需 `npm run build`(用户已确认接受)。

## 8.5 文档分工(用户决策)

- **根目录 design md 规范进 `docs/`**。根目录 `DESIGN-console-logs.md`、`DESIGN-view-and-site-library.md` 已 `git mv` 到 `docs/`。
- **SKILL.md 只管怎么用 `cdp.js`**,不写任何构建/源码结构细节(agent 调用时不需要知道怎么编译)。
- **构建、目录结构、脚手架等开发者信息写进 CLAUDE.md**(本 skill 的 `CLAUDE.md`),面向开发者而非 agent。

## 9. 风险与注意

- **运行路径**:skill 被 Claude Code `run` 调用时需已构建;改代码后忘记 build 会跑旧逻辑。缓解:SKILL.md 写明、构建脚本加产物时间戳检查提示。
- **反引号**:注入产物是独立文件,不再有反引号禁用问题;但 esbuild 打包时若源码含反引号,产物也有,Node 注入用 `JSON.stringify` 传参即可安全。
- **`require.main === module` 模式**:`cdp.ts` 迁移后需等价写法(`import.meta.url` 或保留 CJS)。保持 CJS 输出以最小化 CLI 入口改动。
- **路径解析**:注入产物读取用 `__dirname`(CJS)相对定位,确保从任意 cwd 调 `run` 都能找到 `dist/inject/`。
