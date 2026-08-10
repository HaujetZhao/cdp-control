// zhihu.js — 知乎问题/回答页 recipe:下沉到回答层,每条回答可见 作者/赞同/评/藏/分享 + 内容预览,带可操作 ref。
// 机制:cdp.view 先建树填充 window.__cdpRefs,再 cdp.eval 按站点 selector 读结构化数据到 Node,拼成聚焦文本行。
// 容器/字段 selector 均由实测得出,见文件尾部「selector 实测清单」。
module.exports = {
  scope: 'www.zhihu.com/question/*',

  async extract(cdp, ctx) {
    const { target } = ctx;
    const v = await cdp.view(target); // 建树 → 填充 __cdpRefs
    void v;

    // 一次 eval 读全部回答 + 页头关键项。ref=i 指 __cdpRefs[i].el(对应当前树,保持新鲜)。
    const r = await cdp.eval(target, `(function(){
      const refs = window.__cdpRefs || [];
      const refOf = (el) => refs.findIndex(r => r && r.el === el);
      // 知乎文本常带零宽空格(​)与弯引号、多余空白;归一化:剥零宽/转空白/去首尾。
      const clean = (s) => (s || '').replace(/[​‌‍﻿]/g, '').replace(/\\s+/g, ' ').trim();
      const h1 = document.querySelector('h1');
      const h1Ref = h1 ? refOf(h1) : -1;

      // 「查看全部 N 个回答」链接(ref 取首个命中,可操作入口)
      const vv = document.querySelector('.ViewAll a, .ViewAll');
      const vvRef = vv ? refOf(vv) : -1;
      const vvText = vv ? clean(vv.textContent) : '';

      // 逐回答:容器统一 .ContentItem.AnswerItem(含被精读的 host 回答与「更多回答」cascade 中的回答)
      const answers = [...document.querySelectorAll('.ContentItem.AnswerItem')].map((el, idx) => {
        const author = el.querySelector('.AuthorInfo-name');
        const bio    = el.querySelector('.AuthorInfo-badgeText');
        const rich   = el.querySelector('.RichContent-inner');
        const vote   = el.querySelector('.VoteButton');
        const act    = [].slice.call(el.querySelectorAll('.ContentItem-actions button, .ContentItem-actions a'));
        // 动作条按钮文本即「赞同 X」/「N 条评论」/「收藏数」/「分享数」;统一剥离零宽后使用。
        const vb = vote ? clean(vote.textContent) : '';
        const vText = vb.replace(/^已/, '');   // 被精读回答按钮前缀「已赞同」→ 剥「已」
        const at = (i) => act[i] ? { ref: refOf(act[i]), t: clean(act[i].textContent) } : null;
        return {
          seq: idx + 1,
          ref: refOf(el),                    // 容器 → view/article <ref> 展开全文
          authorRef: author ? refOf(author) : -1,
          author: author ? clean(author.textContent) : '',
          bio: bio ? clean(bio.textContent) : '',
          richRef: rich ? refOf(rich) : -1,  // 正文 → article <ref> 取全文
          preview: rich ? clean(rich.textContent).slice(0, 160) : '',
          voteText: vText,
          voteRef: vote ? refOf(vote) : -1,
          comment: at(2),   // 评论按钮「N 条评论」
          collect: at(3),   // 收藏数
          share: at(4),     // 分享数
        };
      });

      return { h1: h1 ? h1.textContent.trim() : '', h1Ref, vvRef, vvText, answers };
    })()`);

    const out = [];
    function refstr(ref) { return ref >= 0 ? ` [ref=${ref}]` : ''; }

    // 页头:问题标题 + 查看全部回答入口
    if (r.h1) out.push(`# ${r.h1}${refstr(r.h1Ref)}`);
    if (r.vvText) out.push(`▸ 回答: ${r.vvText}${refstr(r.vvRef)} (view 该 ref 展开答案区)`);
    out.push('');

    // 逐回答
    const ans = r.answers || [];
    if (!ans.length) {
      out.push('(未读到任何回答,可能需要 view --scroll-to-load 后再试)');
    }
    for (const a of ans) {
      // 赞同按钮文本已含「赞同 X」,直接复用;评论/收藏/分享取其按钮文本。
      const metaBits = [];
      if (a.voteText) metaBits.push(a.voteRef >= 0 ? `${a.voteText}${refstr(a.voteRef)}` : a.voteText);
      if (a.comment && a.comment.t) metaBits.push(`评论 ${a.comment.t}${refstr(a.comment.ref)}`);
      if (a.collect && a.collect.t) metaBits.push(`收藏 ${a.collect.t}${refstr(a.collect.ref)}`);
      if (a.share && a.share.t) metaBits.push(`分享 ${a.share.t}${refstr(a.share.ref)}`);
      out.push(`── 回答 ${a.seq}${a.author ? ' · ' + a.author : ''}${refstr(a.authorRef)}${a.bio ? ' (' + a.bio + ')' : ''}`);
      out.push(`    ${metaBits.join('  ')}`);
      out.push(`    ${a.preview || '本回答无可预览文本。'}`);
      out.push(`    展开全文: article ${a.richRef} · 定位容器: view ${a.ref}`);
      out.push('');
    }

    return { lines: out };
  },
};

/*
== selector 实测清单(知乎 2026-08,答案区) ==
容器(每回答,含精读的 host 回答 + 更多回答 cascade): .ContentItem.AnswerItem
  作者名      .AuthorInfo-name
  作者签名    .AuthorInfo-badgeText
  内容容器    .RichContent-inner(textContent 即全文)
  赞同按钮    .VoteButton(文本如「赞同 1.5 万」;被精读时前坠「已」需剥除)
  动作条      .ContentItem-actions button/a,按序:[赞同][反对][N 条评论➜index2][收藏数➜3][分享数➜4][分享][更多]
「查看全部 N 个回答」链接: .ViewAll a / .ViewAll(全页多处,取首即可操作)
== 坑 / 取舍 ==
- .List-item 只含 cascade 回答,漏掉当前正在精读的 host 回答;.ContentItem.AnswerItem 三类全收。
- 收藏/分享无语义 label,动作条里仍是裸数字(收藏数、分享数),故按固定 index 取。
- 被精读回答 vote 文本为「已赞同 X」,统一剥「已」。
- 全文过长(部分回答 ~1.3 万+字):预览 160 字 + 暴露正文/容器 ref,Agent 需全文用 article <ref>。
- refs 依赖 cdp.view 建树后的 __cdpRefs;同一 extract 内连续 view+eval 保持新鲜。
*/
