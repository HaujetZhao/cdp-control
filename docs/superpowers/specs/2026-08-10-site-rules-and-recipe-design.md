# 站点抽取配方(recipe)+ 规则存储统一 设计文档

日期：2026-08-10
状态：待终审(经子代理对抗审核一轮后修订)

## 背景

`view` 的树是**通用**的——任何页面都能压成带 ref 的紧凑树。但对**已知站点**(知乎问题页、CSDN 博客页…),agent 真正想要的是**聚焦的、语义化的摘要**:问题 + 回答者 + 点赞/评论/收藏 + 可操作 ref,其余噪声(顶栏、边栏、推荐)全部隐去。当前没有机制表达"对这个站,感知时只呈现这些字段"。

另有**存储位置缺陷**:fold/ignore 权威副本在 `src/`,build 拷到 `dist/`,但运行时 `fold add`/`ignore-link add` 写的是 `dist/` → **下次 build 覆盖丢失**。规则作为用户数据,本不该住在构建产物目录。这也是 clobber bug 的根源。

## 目标

1. 新增**抽取配方(recipe)**:URL 命中的过程式站点摘要(文本 + 内嵌 ref),供 agent 聚焦读已知站点。
2. `view` 命令默认启用 recipe:命中则输出摘要,未命中回落现有树;`view --tree` 强制树。
3. 规则存储统一:fold / ignore-links / recipe 都进**同一规则目录**,默认种子入库、实时规则 gitignore,修 clobber。
4. 抽出共享工具 `globToRegExp`(消 3 份重复)与 `hostOf`/`pathOf`(fold/recipe 共用)。
5. 配合性协调整改:`run` 引擎抽共享 + 捕获返回值(供 recipe 复用)。
6. 实现放新分支,分阶段提交,最后 merge 到 main。

## 非目标

- **不**把 fold / ignore-links / recipe 强并成一个"站点感知规则"**概念基座**。三者匹配维度、应用时机、执行模型各不相同(fold:域名×path 正交、Node 按当前页过滤;ignore:hostname+pathname 拼接串单 glob、浏览器逐链接匹配;recipe:URL→执行过程)。真正共享的只有**一个纯函数工具**与**一个存储目录**,不构成一个机制基座(律 1/律 2)。
- 不做**自动**主内容识别器(readability 式启发式)。recipe 靠站点知识手写,是"一次作者、反复复用"的资产。
- 不保留向后兼容、不写 migration、不加 fallback(遵循激进重构原则)。旧 `dist/*.csv` 不迁移,seed 只从 `src/rules/` 拷默认(见存储)。

---

## 架构:三个独立改动,不共享抽象伞

### 改动 1:共享工具 `src/url-scope.ts`(纯函数,消重复)

抽出唯一 `globToRegExp`(从 folds.ts:62 迁出),`hostOf`/`pathOf`(从 folds.ts:31-45 迁出)。三者(及其它需要处)共用;fold 保留"域名×path 正交"组合、ignore-links 保留"拼接串单 glob"语义,各自内部调共享函数。

- **浏览器侧**(`inject/lib/ignore-links.ts:13`)那份内联 regex 是**逐链接匹配**(与"哪条规则作用于当前页"不同问题),不与 Node 共享;在文档标注其与 Node `globToRegExp` 同构。

### 改动 2:规则存储统一(修 clobber)

**新结构**:内置默认(入库)+ 实时(用户),单层实时、seed-once。

```
src/rules/                     ← 内置默认(入库、权威、seed 的初始源)
  fold.csv
  ignore-links.csv
  recipes/                     ← 官方示例 recipe(入库,可版本化)
rules/                         ← 实时(skill 根,gitignore;运行时读写;build 不清不覆盖)
  fold.csv
  ignore-links.csv
  recipes/*.js
dist/                          ← 不再携带规则(纯代码)
```

- **seed-once**:首次运行时,`rules/` 缺某文件 → 从 `src/rules/` 拷贝默认。此后 build **不再覆盖**(修 clobber)。**不迁旧 dist csv**(实现时放弃:dist 常已被旧 build 冲标成默认,迁移价值低,且 `__dirname` 层级差异使测试变贵)。
- **运行时读写**(`fold add`/`ignore-link add`/recipe 落盘)→ 一律 `rules/`。
- 定位:`join(__dirname,'../rules')`(`__dirname` 即 dist)。
- **clobber 根源厘清**:不是"规则在 dist"本身,而是 `build.mjs` 每次 build **无条件 `copyFileSync` 覆盖** + 运行时 `fold add` 写同一 dist 文件。所以修复 = 让运行时读写与 build 覆盖**不再撞同一文件**(规则搬进 `rules/`,build 不再碰)。
- **显式取舍(单层,不采用双层)**:放弃"dist 自包含规则"(拷 dist 不再带默认规则)。对**原位个人用**的 skill,规则是数据非代码、少有人拷 dist 到别机;单层 `rules/` 免去"内置+实时"永久两源合并复杂度。**代价已声明**:① dist-only 部署缺默认规则 → **须同步删掉 CLAUDE.md/folds.ts 等"随 dist 拷贝走"的旧承诺**(见实现计划,否则注释变过期谎言);② 已装用户拿不到 `src/rules/` 后续默认升级(改 `src/rules/` 需手动再 seed);③ gitignore 的 `rules/` 无内置备份/迁移机(用户自行备份)。若日后真需要移植,再改双层。

### 改动 3:抽取配方 recipe(独立新枝)

**执行模型**:recipe = **URL 作用域的 Node 模块**,复用 `run` 脚本引擎,但**捕获返回值**(文本行)。

```js
// rules/recipes/zhihu.js  (纯 JS,不接 build;项目编译 CJS,故用 module.exports)
module.exports = {
  scope: 'www.zhihu.com/question/*',          // host+path glob
  async extract(cdp, ctx) {
    // ctx: { target, opts }
    const tree = await cdp.view(target);                     // 原始树(纯结构,无分发→无递归)
    const article = await cdp.article(target, 110);          // 按需取回答全文(签名 article(target, ref, ancestor?))
    // …用 cdp.view/article/find/locate 组装,作者自行排版…
    return { lines: [ /* 文本行,内嵌 [ref=N] */ ] };
  },
};
```

- **模块约定(钉死)**:recipe 是 **CJS `module.exports = { scope, extract }`**。`.js` 在 CJS 项目里用 `export default` 会直接抛错。运行时 `require()` 载入,走与 `run` 相同的执行面。
- **为什么 Node 而非注入**:复用全部既有编排能力(view/article/find/click/eval),注入脚本够不到 Node API(CLAUDE.md「注入侧跑浏览器」)。回答正文大字段靠 `view` 拿 ref + `article <ref>` 按需展开,不给摘要灌全文。
- **信任边界(明说)**:recipe 是**作者信任的本地代码**,等同 `run` 脚本;不是沙箱边界。默认只有作者本人写。recipe 收到 `cdp` 参数,通常不需要 `require`;若需要,沿用 run 的 `safeRequire` 白名单(不含 npm 包,故 recipe 不能引第三方库——接受,recipe 靠 `cdp.eval`/`cdp.view` 够用)。
- **输出 = `{ lines: string[] }`**:作者自行排版(各站摘要天然不同,统一 schema 是过度设计),`[ref=N]` 约定内嵌(与 view 同款)。CLI 打印前补一行图例,让 `[ref=N]` 自解释。

### view 分发(CLI action 顶层,不污染 api 基元)

- **`api.view` 保持纯结构视图**(现行为),被 `fetchPage`/操作反馈整页重建内部复用,不塞 recipe。
- **recipe 分发只在 CLI action 顶层**:`view` 与 `fetch` 两个命令都走一个共享 `dispatchView(target, opts)` 帮助函数:
  - 命中 recipe(用 `urlMatches(scope, target.url)`)→ 跑 recipe 打印 `{lines}`(先补图例行);
  - 未命中或**用户表达了建树意图** → 现有 `api.view` 树。
- **建树意图 = 强制树**:`--tree`、位置 ref `[n]`、`--selector-file`、`--visible-only`、`--scroll-*` 任一 → 一律树,跳过 recipe。只有**裸 `view`**(无任何建树 option)才跑 recipe。规则:recipe 只在"无显式建树意图"时启用。
- **`fetch <url>` 同样分发**:`fetch` 是"替代 web fetch MCP"的**读网页主入口**,若不经分发则 recipe 对它完全失效。CLI `fetch` action 打开页面后调同一 `dispatchView`,命中输出摘要、未命中输出整树。`api.fetchPage` 保持纯树(内部/编程用)。
- 防递归自然消失:分发不在 api 层,recipe 内部调的是纯 `api.view`,无递归,不需要 `{tree:true}` flag。
- **多 recipe 命中全序**:通配最少 → scope 更长 → 声明顺序(确定性)。
- **target 透传**:分发处把已解析的 target 直接透传给 recipe-runner,不在内层重复 resolve。
- run 脚本若显式要摘要,调新方法 `cdp.recipe(target, opts)`(命中返回 `{lines}`,未命中返回 null);`cdp.view` 保持纯树。

## 数据流

```
view / fetch (CLI action) → dispatchView(target, opts)
  ├─ 命中 recipe 且无建树意图 → recipeRunner: 载入 rules/recipes/<site>.js → extract(cdp,{target})
  │     → {lines} → 补图例 → 原样打印
  └─ 未命中 / 建树意图(--tree/[n]/--selector-file/--visible-only/--scroll-*) → api.view 树

run / recipe → 共用 runScript helper(cdp 全局,run 副作用 / recipe 返回 {lines})
```

```
规则读写 → 一律 rules/(gitignore、build 不覆盖)
  seed: 首跑缺文件 → 从 src/rules/ 拷默认(不迁旧 dist)
```

```
url-scope.ts ← folds / ignore-links / recipe 分发(globToRegExp / hostOf / pathOf / urlMatches)
```

## 错误处理

- recipe 载入失败 / extract 抛错 / 返回 null → `view` 安全回落树并提示"recipe 失败,回落树"。
- recipe 作用域不匹配 → 正常回落,非错误。
- 运行时规则写入失败 → 复用现有报错(写 CSV 同路径错误)。

## 测试

- **纯函数单测**:`url-scope.ts`(globToRegExp/hostOf/pathOf/urlMatches)、rules seed 往返(`CDP_RULES_DIR` 覆盖临时目录:首跑缺文件→拷默认;已有不覆盖;二次 build 不覆盖;运行时 `fold add` 写 `rules/` 持久)。
- **浏览器实测**(DOM 依赖,遵循项目规范不写单测):`view` 命中 zhihu recipe 输出摘要(含图例)、裸 `view` 分发而 `view --visible-only`/`view <n>` 强制树、`view --tree` 强制树、`fetch <url>` 同样分发摘要、recipe 内部 `cdp.view` 不递归、失败回落、`api.fetchPage`/操作反馈不受 recipe 影响(仍抓整树)。
- **既有回归**:`npm test` 全绿;`npm run build` 通过。

## 文档分工

- `SKILL.md`:补 recipe 概念、`view` 默认分发 + `--tree`、`cdp.recipe`、rules 目录说明。
- `CLAUDE.md`:补 `url-scope.ts` 共享工具、recipe 执行模型与信任边界、rules 持久化与 seed。
- `DESIGN.md`:把「聚焦/感知规则」小节从"fold 持久化用 uBlock 语法"升级为"fold/ignore/recipe 共享 url-scope 工具 + 统一 rules 目录"。
