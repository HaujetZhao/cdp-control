# recipe 站点规则聚合 + 抽取/呈现分层 — 设计

> 日期:2026-08-10 · 状态:已实现(经两轮子代理实测 + 两轮设计辩论收敛)

## 问题

原 recipe 是**一文件一规则**:`rules/recipes/<site>.js` 导出 `{scope, extract}`。病根:

1. **文件名与 scope 强绑定**。文件名是"作者心智里的站点",scope 是"URL 形态",两件正交的事被硬绑进一个文件一条规则。想给知乎加「专栏」就得起新文件名、担心与知乎问题页撞车——这正是用户提出的痛点。
2. **抽取/呈现/定位熔在一个 eval+拼串 blob**。定位(selector)、抽取(clean/num/ref)、呈现(push 字符串 + 硬编码操作提示)混在一个模板字符串里,无法单测、无法复用、refOf 静默丢 ref。

两轮子代理对着真实页面 `view` vs `view --tree` 对比,收集了 13 条痛点(见下),驱动了这套设计。

## 抽象层级

从根问题「给 Agent 最小 token、最可靠句柄」出发,四个抽象层:

### L0 站点规则聚合(用户核心诉求)
**一文件 = 一站点,文件名只是聚合标签;文件导出规则数组,`scope` 与 extract 正交、可多对一/一对多。**

```js
// rules/recipes/zhihu.js
const { clean, refstr, opHint } = require('./_lib.js');
async function questionExtract(cdp, ctx) { … return { lines }; }
async function zhuanlanExtract(cdp, ctx) { … return { lines }; }
module.exports = [
  { name: '问题/回答页', scope: 'www.zhihu.com/question/*', extract: questionExtract },
  { name: '专栏文章',    scope: 'zhuanlan.zhihu.com/p/*',    extract: zhuanlanExtract },
];
```
- `scope: string | string[]` —— 数组 = 同一抽取逻辑服务多个 URL 形态(同布局、多地址)。
- 数组元素 = 同站点不同布局(不同 extract)。
- 匹配在**跨文件 × 跨规则**上做全序;排序键取每条规则与其 URL 最匹配的那个 scope(通配符最少 → 更长 → 声明顺序)。见 `recipe-runner.ts` 的 `bestScope`。
- 主机名字面量 glob 不会跨 `.` 吞子域(`www.zhihu.com/*` 永不命中 `zhuanlan.zhihu.com/p/*`),故"子域被 www 吞"是假担忧(实测证)。

### L1 抽取/呈现分层(消灭 #8 最大摩擦)
**砍掉"数据对象 + 共享 renderer"的过度抽象**(知乎的难度在排版层、站点特有,renderer 兜不住且为单一消费者造通用抽象是过度设计)。改为:
- **eval 只做 DOM 读**(返回 raw 文本 + ref),不掺任何归一化/排版。
- **Node 侧共享 `_lib.js`**(`clean`/`refstr`/`opHint`,纯函数可单测)负责归一化与 ref 呈现。
- recipe 仍手拼 `{lines}` 字符串,但**不再手抄 clean/refstr**、不硬编码操作文案(操作提示归 `opHint`)。

### L2 可靠句柄(治 #1/#2/#3/#6/#9/#12)
- `refOf` **只查已建树节点、绝不按需注册**——按需注册会 `push parentRef:null` 的孤儿节点,平移 ref 全局号、断 `recoverRef` 的 parentRef 跳表自愈链(机制级硬伤,核对 `view-core.ts` 的 assign 证实)。未命中返回 `null` 而非 `-1`,语义=「断言未建树」(不过度承诺为"页面没有该元素")。
- 共享原语 `txt`(剥零宽/扁平空白)、`num`(解析"1.5万"数字)、`query(container, sel)`(容器内检索,杜绝孤儿 selector 串场)。(`num`/`query` 按需引入,当前 `_lib.js` 落地 `clean`/`refstr`/`opHint` 三个实际用到的。)

### L3 收敛匹配(不造统一抽象层)
- recipe 与 ignore-links 共享一维 hostname+pathname glob(`urlMatches`,已收敛于 `url-scope.ts`)。
- **fold 的二维匹配(host × path)保持私有**——三者匹配语义本就不同(实测证),硬统一会扯坏 fold 多维匹配。只在"规则文件组织 + 作用域匹配工具"这层共享,各变换逻辑私有。

## 痛点 → 抽象吸收表

| 痛点(实测) | 吸收 |
|---|---|
| #7 一文件一规则、同域名多布局表达不了 | L0 站点规则聚合 |
| #8 浏览器抽取+Node呈现混一个文件不可测 | L1 分层 + `_lib.js` 可单测 |
| #1 refOf/clean/refstr 每文件手抄 | L1 `_lib.js` 复用 |
| #2 refOf 静默返回-1 丢 ref | L2 refOf 返回 null |
| #6 recipe 隐式依赖 view 建树副作用 | L1 eval 只做 DOM 读,职责显式 |
| #3 裸数字 selector 脆弱 | L2 `num`/`txt`(按需) |
| #9/#12 孤儿 selector 串场 | L2 `query(container, sel)` |
| #5 手拼字符串无结构 | 保留(recipe 无结构恰是特性) |
| #13 操作提示硬编码 | L1 `opHint` 归框架侧 |
| #4 点击才有内容的 expander | L1 输出提示 + ref,交给 agent click |

## 实现要点

- `recipe-runner.ts`:`listRuleFiles`/`matchRecipe`/`runRecipe` 改为 async;用动态 `import()` 加载 CJS recipe 文件(`pathToFileURL`),ESM 测试与 esbuild CJS bundle 都可用;`_lib.js` 被排除出规则扫描。
- `rules/recipes/_lib.js`:共享 CJS 工具(纯函数),seed-once 自 `src/rules/recipes/` 拷贝。
- 测试:`tests/recipe-runner.test.ts` 覆盖 同文件多规则 / 一规则多 scope / 主机名字面量子域隔离 / 跨文件规则级全序 / `_lib` 纯函数。
- 验收:真实双场景(问题页 + 专栏页)各自命中对应规则,证明"同文件多布局 + 一规则多形态"组合能力上线前被真实用例测过。
