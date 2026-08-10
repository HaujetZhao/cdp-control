# 站点抽取配方(recipe)+ 规则存储统一 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增**抽取配方 recipe**(URL 命中的过程式站点摘要,文本+内嵌 ref),`view` 命令默认跑 recipe、未命中回落树、`--tree` 强制树;规则存储统一进 `rules/`(修 clobber);抽共享 `globToRegExp` 消重复;`run` 引擎抽共享并捕获返回值供 recipe 复用。

**Architecture:** 三个独立改动,不共享抽象伞:①`src/url-scope.ts` 共享纯函数工具;②规则存储统一 `src/rules/`(默认)+ `rules/`(实时,gitignore)+ seed-once;③recipe = URL 作用域 Node 模块(复用 run 引擎、返回 `{lines}`),CLI `view` action 顶层分发,`api.view` 保持纯结构。详见 spec。

**Tech Stack:** TypeScript / esbuild(注入 IIFE)/ commander CLI / node:test 零依赖单测。

**设计文档:** `docs/superpowers/specs/2026-08-10-site-rules-and-recipe-design.md`

**构建/测试命令:**
- 类型检查+打包: `npm run build`(tsc --noEmit + esbuild)
- 单测: `npm test`(node:test 跑 `tests/*.test.ts`)
- 新增 Node 模块 `src/*.ts` 与注入入口 `src/inject/*.ts` 会被 build.mjs 自动收集,无需改构建脚本。

**关键约定:**
- 注入侧 DOM 逻辑不写单测,靠**浏览器实测**(CDP 9222,知乎页)。
- 纯函数(url-scope、rules seed 迁移)写单测,`CDP_RULES_DIR` 覆盖临时目录。
- commit 不带 `Co-Authored-By`。
- 每阶段改完 `npm run build` 重建再回测。
- **零兼容**:旧 dist csv 不迁移,seed 只从 src/rules/ 拷默认,不写 migration/fallback。

---

## Task 1: 抽共享 `src/url-scope.ts`(消 globToRegExp 重复)

**Files:**
- Add: `src/url-scope.ts`(globToRegExp / hostOf / pathOf / urlMatches)
- Modify: `src/folds.ts`(改用共享 globToRegExp/hostOf/pathOf)
- Modify: `src/ignore-links.ts`(改用共享 globToRegExp)
- Test: `tests/url-scope.test.ts`

- [ ] **Step 1: 建 `src/url-scope.ts` 纯函数**
`globToRegExp(glob)`: `*`→`.*`,两端锚定(唯一实现,从 folds.ts:62 迁出)。`hostOf`/`pathOf` 从 folds.ts:31-45 迁出。`urlMatches(pattern, url)`:host+path glob 匹配(recipe 作用域用)。
- [ ] **Step 2: `folds.ts`/`ignore-links.ts` 改调共享实现**
删各自 `globToRegExp`;fold 保留 domainMatch×pathMatch 正交组合、ignore-links 保留拼接串单 glob 语义,内部调共享函数。
- [ ] **Step 3: 单测 `tests/url-scope.test.ts`**
globToRegExp 通配、hostOf/pathOf、urlMatches(含 `*.suffix`/`suffix.*`/空 path)。

## Task 2: 规则存储统一 `src/rules/` + `rules/`(修 clobber)

**Files:**
- Modify: `build.mjs`(不再 build 时把 fold/ignore csv 覆盖到 dist;dist 变纯代码)
- Add: `src/rules/fold.csv`、`src/rules/ignore-links.csv`(从现 src/*.csv 迁入)、`src/rules/recipes/`(官方示例)
- Modify: `src/folds.ts`/`src/ignore-links.ts`(路径 `dist/`→`rules/`;env `CDP_FOLD_FILE`→`CDP_RULES_DIR`)
- Add: `.gitignore` 加 `rules/`(仅实时,不入库)
- Test: `tests/rules-store.test.ts`

- [ ] **Step 1: 建 `src/rules/` 默认源;`build.mjs` 不再覆盖 dist csv**
迁移 fold.csv/ignore-links.csv 到 `src/rules/`;build.mjs 删掉 copyFileSync 覆盖 dist 的步骤(规则不再进 dist)。
- [ ] **Step 2: 读路径改 `rules/`,seed-once**
`join(__dirname,'../rules/...')`;首跑缺文件 → 从 `src/rules/` 拷默认;二次 build 不覆盖(不迁旧 dist)。
- [ ] **Step 3: `.gitignore` 加 `rules/`;单测 seed 往返**
`CDP_RULES_DIR` 临时目录:首跑 seed、二次不覆盖、运行时 `fold add` 写 `rules/` 持久。
- [ ] **Step 4: 同步删旧"随 dist 拷贝走"承诺**
`CLAUDE.md` 构建节、`folds.ts:3/26` 注释里"规则随 dist 拷贝走"的说法改为"规则在 `rules/`(数据非代码)",避免注释变过期谎言。

## Task 3: `run` 引擎抽共享 + 捕获返回值

**Files:**
- Modify: `src/cdp.ts`(抽 `runScript(fnBody, api, opts)` 共享 helper;`run` 命令副作用;返回值改为可捕获)

- [ ] **Step 1: 抽 `runScript` helper**
从 `run` 的 `new Function('cdp','require',...)` 封装抽出共享 helper,支持 run(副作用)与 recipe(返回 `{lines}`)两种消费。`run` 命令增加"返回非 undefined 则打印"。

## Task 4: recipe 执行 + view 分发 + 示例

**Files:**
- Add: `src/recipe-runner.ts`(按 URL 用 urlMatches 找 recipe、载入 `rules/recipes/<site>.js`、extract(cdp,ctx)、捕获 `{lines}`;异常/null→返回 null;多命中全序 tiebreaker)
- Modify: `src/cdp.ts`(抽 `dispatchView(target,opts)` 供 view/fetch 两个 action 共用;`cdp.recipe` 新方法)
- Add: `src/rules/recipes/zhihu.js`(示例:问题标题/被浏览/逐回答[回答者/内容预览/赞/评/藏 + ref]/查看全部回答 ref)

- [ ] **Step 1: `src/recipe-runner.ts`**
按 `urlMatches(scope, target.url)` 找 recipe;多命中全序(通配最少→scope 更长→声明顺序);`require()` 载入(recipe 为 CJS `module.exports={scope,extract}`),`extract(cdp,ctx)` 执行捕获。异常/返回 null → null。
- [ ] **Step 2: `dispatchView` 帮助函数(CLI view/fetch 共用)**
`api.view` 不动(纯结构,fetchPage/feedback 照旧)。`dispatchView(target,opts)`:无建树意图且命中 recipe → 打印 `{lines}`(补图例行);否则 → `api.view` 树。建树意图 = `--tree`/位置 `[n]`/`--selector-file`/`--visible-only`/`--scroll-*` 任一。分发处透传已解析 target。
- [ ] **Step 3: `view` 与 `fetch` action 都走 `dispatchView`**
`view` 默认分发、`--tree` 强制树;`fetch <url>` 打开页面后同样分发(命中摘要/未命中整树),否则 recipe 对读网页主入口失效。`cdp.recipe(target,opts)` 暴露给 run 脚本(命中 {lines}/未命中 null)。
- [ ] **Step 4: 示例 `src/rules/recipes/zhihu.js`(CJS)+ 浏览器实测**
知乎问题页摘要(带图例);验证:裸 `view` 分发、`view --visible-only`/`view <n>` 强制树、`view --tree` 强制树、`fetch <url>` 同样分发、recipe 内部 `cdp.view` 不递归、失败回落、`api.fetchPage`/操作反馈仍抓整树。

## Task 5: 文档 + 回归 + 收尾

- [ ] **Step 1: `npm test` 全绿、`npm run build` 通过**
- [ ] **Step 2: 更新 SKILL.md / CLAUDE.md / DESIGN.md**(见 spec「文档分工」)
- [ ] **Step 3: 浏览器实测清单逐项回测**,分阶段 commit,merge 回 main
