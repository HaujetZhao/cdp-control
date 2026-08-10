// zhihu.js — 知乎问题页摘要(示例 recipe,演示机制)。
// recipe 是 CJS:`module.exports={scope, extract}`。scope 用 url-scope 的 glob(hostname+pathname)。
// extract 收到完整 cdp api(可用 view/article/find/locate/eval/click 编排),返回 {lines}(文本+内嵌 [ref=N])。
// 信任边界:作者信任的本地代码,非沙箱。此示例从 view 树行解析稳定可取的字段;更完整逐回答抽取用 cdp.eval 按站点 selector。
module.exports = {
  scope: 'www.zhihu.com/question/*',

  async extract(cdp, ctx) {
    const { target } = ctx;
    const v = await cdp.view(target); // 原始树(纯结构,分发在 CLI action,此处无递归)
    const lines = v.lines || [];

    // 从 view 树行解析:{text, ref}
    const lineText = (l) => { const m = l.match(/"([^"]*)"/); return m ? m[1] : ''; };
    const lineRef = (l) => { const m = l.match(/\[ref=(\d+)/); return m ? m[1] : undefined; };

    const title = lines.find(l => /^ *h1 "/.test(l));
    const browse = lines.find(l => l.includes('"被浏览"'));
    const browseVal = lines.find(l => /^ *strong "/.test(l) && lineRef(l));
    const more = lines.find(l => /查看全部[\s\S]*个回答/.test(l));

    const out = [];
    if (title) out.push('# ' + lineText(title) + (lineRef(title) ? ` [ref=${lineRef(title)}]` : ''));
    if (browseVal) out.push('被浏览: ' + lineText(browseVal) + (lineRef(browseVal) ? ` [ref=${lineRef(browseVal)}]` : ''));
    if (browse) out.push('(' + lineText(browse) + (lineRef(browse) ? ` [ref=${lineRef(browse)}]` : '') + ')');
    out.push('');
    if (more) out.push('▸ 回答: ' + lineText(more) + (lineRef(more) ? ` [ref=${lineRef(more)}]` : '') + ' (view 该 ref 展开答案区)');

    // 完整逐回答抽取(回答者/赞/评/藏 + 内容 ref)需站点 selector,示例留注:
    //   const data = await cdp.eval(target, `[...document.querySelectorAll('.List-item')].map(el=>({...}))`);
    //   const authors = await cdp.find(target, { text: '作者名', all: true }); // 拿 ref
    // 然后在 out 里逐条拼文本 + ref。

    return { lines: out };
  },
};
