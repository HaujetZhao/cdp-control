# cdp-browser-control 开发者说明

> 面向**开发者**(维护本 skill 源码的人)。**agent 使用本 skill 时只需要 `SKILL.md`,不需要看这里。**
> 运行入口:`node dist/cdp.js`(需先构建)。

## 构建

本项目的 `dist/`(实际运行产物)不提交 git,改动源码后需重建:

```bash
npm install      # 首次:装 esbuild / typescript / @types/node / commander
npm run build    # tsc --noEmit(类型检查) + esbuild(编译 + 打包注入脚本)
npm test         # node:test 跑 tests/*.test.ts(零运行时依赖)
```

`npm run build` 产出的 `dist/` 结构:
```
dist/cdp.js              入口 bundle(commander + 全部 src 模块,自包含:拷走 dist 即可运行)
dist/*.js                其余 Node 侧(api/transport/monitor/browser/inject-loader/keys,转译保留)
dist/inject/*.js         注入到浏览器页面跑的 JS(esbuild 打包成自包含 IIFE)
```

## 源码结构(两层,彻底分离)

| 目录 | 内容 | 运行环境 | 编译 |
|---|---|---|---|
| `src/*.ts` | Node 侧(连接 CDP、CLI、api、纯函数模块) | Node | `src/cdp.ts` 入口 esbuild bundle(含 commander)→ `dist/cdp.js`;其余转译 CJS(不打包) |
| `src/inject/*.ts` | 注入浏览器页面执行的 JS(入口) | 浏览器(DOM lib) | esbuild bundle 成 IIFE → `dist/inject/` |
| `src/inject/lib/` | 注入侧共享模块(genSel/result/arg/monitor-inject/tree-utils/tree-format/find-root) | 浏览器 | 打进各入口 |

依赖单向无环:`transport ← inject-loader/api ← monitor/browser ← cdp`。

## 注入脚本契约(改动注入脚本必读)

注入脚本经 esbuild 打包成自包含 IIFE,`Runtime.evaluate` 的 `returnByValue` 取整体完成值。
esbuild 会把入口包进 module wrapper、吞掉返回值,故:

1. **结果写入**:注入脚本把结果写到全局 `globalThis.__cdpResult`(用 `src/inject/lib/result.ts` 的 `setResult`)。
2. **footer 读取**:`build.mjs` 给每个入口统一追加 footer `;(()=>{const r=globalThis.__cdpResult;delete globalThis.__cdpResult;return r})()`——整体完成值即结果,且读完即删、无残留。
3. **参数传递**:注入脚本用自由标识符 `__CDP_ARG__`(TS 里 `declare const __CDP_ARG__: XxxArgs`),Node 侧 `src/inject-loader.ts` 注入前拼一行 `var __CDP_ARG__ = <json>;`。无需字符串替换。
4. **入参数类型**在 `src/inject/lib/arg.ts`(FindArgs/FillArgs/TreeArgs/LocateArgs/ReadArgs)。

**新增注入入口的步骤**:在 `src/inject/` 加一个 `.ts`(顶层,不进 lib/),用 `setResult` + 可选 `__CDP_ARG__`,重建即可自动打包成 `dist/inject/<名>.js`。**注意**:注入侧代码跑在浏览器,不能用 Node API;类型只在编译期(DOM lib)。

**ref 登记表契约**:tree 遍历时把内容/交互元素登记进 `window.__cdpRefs`,`[ref=i]` 序号即其下标;tree 每次重建时**先清空再重排**(序号随树变,别跨树假设)。`tree`/`locate`/`click`/`fill`/`focus`/`hover` 都靠它按 ref 定位。共享解析在 `lib/find-root.ts` 的 `refElement`(ref→元素)+ `climbAncestors`(向上爬父,`--ancestor` 用);`locate`(注入入口 `src/inject/ref.ts`)用它们把 ref 翻译成稳定定位器:`genSel`(CSS selector)+ `genXpath`(绝对 xpath,同名兄弟序号语义,与 DevTools Copy full XPath 一致;仅覆盖 light DOM——shadow 内元素 parentElement 在边界为 null,路径断)。`genXpath` 的 `tag[n]` 是"同名兄弟序号",不是"第 n 个元素子"(曾因此 bug 未命中),已加单测锁定。

## 返回契约(api.ts 的 `invoke`)

Node 侧统一用 `invoke(target, expr)` 执行注入脚本并解包结果:注入脚本成功返回任意值(可含 `{ok:true}`);失败返回 `{ok:false, err}`。`invoke` 统一把 `{ok:false}` 抛成异常,调用方无需各自判 ok。数据类入口(tree/locate 等返回裸对象)自然通过。改 api 方法时统一走 `invoke`,别再散落 `r?.ok` 检查。

## 测试

- `tests/*.test.ts` 用 Node 内置 `node:test` + `node:assert/strict`,零运行时依赖。
- 纯函数单测覆盖:`src/inject/lib/tree-utils.ts`(inlineLen/inlineable/leafText/firstTxt/isTrivialLeaf)、`src/inject/lib/tree-format.ts`(formatTree/markText,结构树折叠内联的纯变换)、`src/inject/lib/genSel.ts`(genSel/genXpath)、`src/inject/lib/find-root.ts`(normalizeXpath/splitAxis/refElement/climbAncestors,后两者用假元素链模拟 DOM)、`src/keys.ts`(parseKeySpec)、`src/transport.ts`(resolveTarget)。
- 注入侧 DOM 相关逻辑(如 tree 的 simplify(DOM 采集)、find-root 的 shadow 穿透)依赖真实 DOM,靠浏览器实测验收(见 SKILL.md 用法),不写单测。

## 文档分工

- `SKILL.md`:面向 **agent 使用**,只讲怎么调 `dist/cdp.js`,不含构建/源码结构。
- `CLAUDE.md`(本文件):面向 **开发者**,含构建、源码结构、注入契约、测试。
- `docs/superpowers/specs/`:设计文档。根目录不再放 DESIGN md。


---

以上为 Agent 自动生成，从此以下为用户所写。

上面的所有约定仅表示开发的历史路径，不代表未来约束。

重构、加新功能，在新的 branch 做，以迭代的方式分阶段提交，最后 merge 到 main。

这个项目是为服务 Agent 更好地读网页写的，一切以服务 Agent 为目标，所有的不合理通通可被扔，一切的重构要激进，要以最优为先，无需背负兼容性顾虑。
