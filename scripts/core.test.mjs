// mdcore.ts 的单元测试。
//
// 这一层是"纯逻辑"：不依赖 DOM、不依赖 marked，所以能直接在 Node 里跑。
// 覆盖的都是最容易出错、又最难靠肉眼发现的部分：
//   - 公式误判（把 "$100" 当公式）
//   - 标题行号偏移（滚动同步与大纲跳转都靠它）
//   - 列表缩进/标记的边界
//   - 滚动同步的计算、光标跟随与节流

import test from "node:test";
import assert from "node:assert/strict";

import {
  attachHeadingLines,
  computePreviewScrollTop,
  contentOffset,
  createTrailingThrottle,
  emptyListItem,
  escapeHtml,
  fillListMarkers,
  looksLikeMath,
  normalizeListMarkers,
  outdentAmounts,
  outdentText,
  pickAnchorAtLine,
  renderMath,
  scanHeadings,
  shouldFollowCursor,
  stripTags,
  visualizeWhitespace,
} from "../src/services/mdcore.ts";

// --------------------------------------------------------------- 基础工具

test("escapeHtml 会转义 & < > \"", () => {
  assert.equal(
    escapeHtml(`<img src="x" onerror='1'> & 2`),
    "&lt;img src=&quot;x&quot; onerror='1'&gt; &amp; 2",
  );
});

test("stripTags 取纯文本", () => {
  assert.equal(stripTags("<span class='k'>\\frac{a}{b}</span>"), "\\frac{a}{b}");
});

test("visualizeWhitespace 让看不见的空白现形", () => {
  // 半角空格 → ·，全角空格 → □，不换行空格 → ◇，制表符 → →
  assert.equal(
    visualizeWhitespace("  文字\u3000全角\u00a0不换行\tTab"),
    "··文字□全角◇不换行→Tab",
  );
  assert.equal(visualizeWhitespace("\u3000\u3000- 未申请"), "□□-·未申请");
});

// --------------------------------------------------------------- 数学公式

test("looksLikeMath 不把价格当公式", () => {
  assert.equal(looksLikeMath("100"), false);
  assert.equal(looksLikeMath("3.14"), false);
  assert.equal(looksLikeMath("100 元"), false);
  assert.equal(looksLikeMath("随便一段中文"), false);
  assert.equal(looksLikeMath(""), false);
});

test("looksLikeMath 接受真正的公式", () => {
  assert.equal(looksLikeMath("a"), true);
  assert.equal(looksLikeMath("x^2"), true);
  assert.equal(looksLikeMath("a \\ne 0"), true);
  assert.equal(looksLikeMath("\\frac{a}{b}"), true);
  assert.equal(looksLikeMath("E = mc^2"), true);
});

test("renderMath 渲染行内公式，且不动价格", () => {
  const html = renderMath("<p>当 $a \\ne 0$ 时，价格是 $100 和 $200</p>");
  assert.match(html, /class="katex"/, "行内公式应被 KaTeX 渲染");
  assert.match(html, /\$100 和 \$200/, "价格必须原样保留");
});

test("renderMath 渲染块级公式", () => {
  assert.match(renderMath("<p>$$x = \\frac{-b}{2a}$$</p>"), /katex-display/);
});

test("renderMath 遇非法公式不抛异常", () => {
  const html = renderMath("<p>$\\notacommand{$$</p>");
  assert.equal(typeof html, "string");
  assert.ok(html.length > 0);
});

// --------------------------------------------------------------- 标题目录

test("scanHeadings 记录真实行号", () => {
  const src = ["# 一", "", "正文", "", "## 二", "", "### 三"].join("\n");
  assert.deepEqual(
    scanHeadings(src).map((h) => [h.level, h.text, h.line]),
    [
      [1, "一", 0],
      [2, "二", 4],
      [3, "三", 6],
    ],
  );
});

test("scanHeadings 跳过围栏代码块里的 #", () => {
  const src = ["# 真标题", "```bash", "# 这是 shell 注释", "```", "## 之后的标题"].join("\n");
  assert.deepEqual(
    scanHeadings(src).map((h) => h.text),
    ["真标题", "之后的标题"],
  );
});

test("scanHeadings 支持 Setext 标题", () => {
  const hits = scanHeadings(["大标题", "=====", "", "小标题", "-----"].join("\n"));
  assert.deepEqual(
    hits.map((h) => [h.level, h.text, h.line]),
    [
      [1, "大标题", 0],
      [2, "小标题", 3],
    ],
  );
});

test("scanHeadings 不把列表项 '-' 误判成 Setext", () => {
  assert.equal(scanHeadings(["- 第一项", "- 第二项"].join("\n")).length, 0);
});

test("scanHeadings 能闭合缩进围栏（列表项里的代码块）", () => {
  // 回归：列表项内的围栏缩进 4 空格，这是合法 CommonMark。
  // 早期版本开/闭共用一个正则，缩进围栏关不掉，围栏状态一路翻转，
  // 导致后面所有标题都扫不出来——大纲整段丢失。
  const src = [
    "# 标题一",
    "",
    "1. 第一项",
    "",
    "    ```",
    "    代码",
    "    ```",
    "",
    "## 标题二",
    "",
    "```js",
    "// 普通代码块",
    "```",
    "",
    "### 标题三",
  ].join("\n");
  const hits = scanHeadings(src);
  assert.deepEqual(
    hits.map((h) => h.text),
    ["标题一", "标题二", "标题三"],
  );
  // 行号必须与源码真实位置一致，且严格递增
  assert.deepEqual(
    hits.map((h) => h.line),
    ["# 标题一", "## 标题二", "### 标题三"].map((h) => src.split("\n").indexOf(h)),
  );
});

test("scanHeadings 接受 ~~~ 围栏", () => {
  assert.deepEqual(
    scanHeadings(["~~~", "# 围栏内的井号", "~~~", "", "# 真标题"].join("\n")).map((h) => h.text),
    ["真标题"],
  );
});

test("scanHeadings 忽略只有井号的空标题", () => {
  assert.deepEqual(
    scanHeadings(["#", "## ", "### 真标题"].join("\n")).map((h) => h.text),
    ["真标题"],
  );
});

test("attachHeadingLines 按顺序给标题贴行号", () => {
  const html = "<h1>一</h1>\n<p>x</p>\n<h2>二</h2>\n";
  const out = attachHeadingLines(html, scanHeadings(["# 一", "", "## 二"].join("\n")));
  assert.match(out, /<h1 data-line="0">/);
  assert.match(out, /<h2 data-line="2">/);
});

test("attachHeadingLines 在标题为空时原样返回", () => {
  const html = "<h1>一</h1>";
  assert.equal(attachHeadingLines(html, []), html);
});

// --------------------------------------------------------------- 列表缩进
// 用户报的"名单贴不住"：从聊天记录复制来的名单常带 4 个以上空格，
// 而 CommonMark 规定列表标记前最多 3 个空格，超了就不再是列表。

test("outdentAmounts 统计行首空白数量", () => {
  assert.deepEqual(outdentAmounts(["未申请", "  未申请", "    未申请"]), [0, 2, 4]);
});

test("outdentAmounts 不动没有缩进的行", () => {
  assert.deepEqual(outdentAmounts(["# 标题", "- 列表", "正文"]), [0, 0, 0]);
});

test("outdentAmounts 制表符也算缩进", () => {
  assert.deepEqual(outdentAmounts(["\t未申请", "\t\t孙力"]), [1, 2]);
});

test("outdentAmounts 认全角空格（微信/Word 粘来的常见坑）", () => {
  assert.deepEqual(outdentAmounts(["\u3000\u3000未申请"]), [2]);
  assert.deepEqual(outdentAmounts(["\u00a0\u00a0孙力"]), [2]);
  assert.equal(outdentText("\u3000\u3000- 未申请"), "- 未申请");
});

test("outdentText 让 4 空格缩进的名单真正贴左", () => {
  const pasted = ["名单：", "    - 未申请", "    - 孙力", "    - 魏郝然"].join("\n");
  assert.equal(
    outdentText(pasted),
    ["名单：", "- 未申请", "- 孙力", "- 魏郝然"].join("\n"),
  );
});

test("outdentText 保留空行与行尾内容", () => {
  assert.equal(
    outdentText(["    未申请  ", "", "  孙力"].join("\n")),
    ["未申请  ", "", "孙力"].join("\n"),
  );
});

test("outdentText 幂等：已贴左的内容不再变化", () => {
  assert.equal(outdentText("      - 未申请"), "- 未申请");
  assert.equal(outdentText("- 未申请"), "- 未申请");
  assert.equal(outdentText(outdentText("   - 未申请")), "- 未申请");
});

// --------------------------------------------------------------- 列表补标记
// 从聊天记录复制名单通常只有第一行带 "- "，后面几行会被解析成第一个列表项的续行
// → 预览里一个圆点套好几行。

test("fillListMarkers 给续行补上标记", () => {
  const src = ["延平 返程已关联", "- 未申请", "孙力", "魏郝然"].join("\n");
  const { text, added } = fillListMarkers(src);
  assert.equal(added, 2);
  assert.equal(text, ["延平 返程已关联", "- 未申请", "- 孙力", "- 魏郝然"].join("\n"));
});

test("fillListMarkers 不动段落正文", () => {
  const src = ["这是普通段落", "第二行也是正文", "", "另一段"].join("\n");
  const { text, added } = fillListMarkers(src);
  assert.equal(added, 0);
  assert.equal(text, src);
});

test("fillListMarkers 空行结束列表块", () => {
  const src = ["- 未申请", "孙力", "", "这段是正文", "也是正文"].join("\n");
  const { text, added } = fillListMarkers(src);
  assert.equal(added, 1);
  assert.equal(text, ["- 未申请", "- 孙力", "", "这段是正文", "也是正文"].join("\n"));
});

test("fillListMarkers 保留已有标记与编号列表", () => {
  const { text, added } = fillListMarkers(["1. 第一项", "第二项", "3) 第三项"].join("\n"));
  assert.equal(added, 1);
  assert.equal(text, ["1. 第一项", "- 第二项", "3) 第三项"].join("\n"));
});

test("fillListMarkers 不碰缩进超过 3 空格的行", () => {
  const { text, added } = fillListMarkers(["- 顶层", "      深层内容", "普通续行"].join("\n"));
  assert.equal(added, 1);
  assert.match(text, /^      深层内容$/m);
});

test("fillListMarkers 幂等：重复执行不重复加标记", () => {
  const once = fillListMarkers(["- a", "b"].join("\n")).text;
  const twice = fillListMarkers(once);
  assert.equal(twice.added, 0);
  assert.equal(twice.text, once);
});

// --------------------------------------------------------------- 编号列表兼容
// CommonMark 允许 `1.foo`（标记后直接跟内容），marked 不认——会把
// `8.发票主体不一致` 当成段落，用户看到的就是"列表项掉出去、还变成代码块"。

test("normalizeListMarkers 给编号标记后补空格", () => {
  const src = ["1. 子目录", "2.", "7.", "8.发票主体不一致，待确认是否改名。"].join("\n");
  const { text, fixed } = normalizeListMarkers(src);
  assert.equal(fixed, 1);
  assert.equal(
    text,
    ["1. 子目录", "2.", "7.", "8. 发票主体不一致，待确认是否改名。"].join("\n"),
  );
});

test("normalizeListMarkers 同时支持 1) 写法", () => {
  const { text, fixed } = normalizeListMarkers("1)第一条");
  assert.equal(fixed, 1);
  assert.equal(text, "1) 第一条");
});

test("normalizeListMarkers 不动已经有空格的行", () => {
  const src = ["1. 正常", "2. 也正常", "10. 十号"].join("\n");
  const { text, fixed } = normalizeListMarkers(src);
  assert.equal(fixed, 0);
  assert.equal(text, src);
});

test("normalizeListMarkers 不碰项目符号列表与正文", () => {
  const src = ["- 项目符号不需要空格规则", "普通段落 8.不是行首", "a.b.c 也不是"].join("\n");
  assert.equal(normalizeListMarkers(src).fixed, 0);
});

test("normalizeListMarkers 跳过围栏代码块（不能改代码内容）", () => {
  const src = ["```", "8.这是代码，别动", "```", "8.这是列表，要补"].join("\n");
  const { text, fixed } = normalizeListMarkers(src);
  assert.equal(fixed, 1);
  assert.match(text, /8\.这是代码，别动/);
  assert.match(text, /8\. 这是列表，要补/);
});

test("normalizeListMarkers 幂等", () => {
  const once = normalizeListMarkers("8.内容").text;
  const twice = normalizeListMarkers(once);
  assert.equal(twice.fixed, 0);
  assert.equal(twice.text, once);
});

test("normalizeListMarkers 忽略行尾的孤立编号", () => {
  assert.equal(normalizeListMarkers("8.").fixed, 0);
});

// --------------------------------------------------------------- 空列表项回车
// 用户报的"回车的 bug"：CodeMirror 自带的续行在空列表项上只加空行、保留标记。

test("emptyListItem 识别各种空列表项", () => {
  // 第 4 个参数是行内偏移长度：有换行符时为 line.length + 1
  assert.ok(emptyListItem("- ", 2, false, 3));
  assert.ok(emptyListItem("-", 1, false, 2));
  assert.ok(emptyListItem("  - ", 4, false, 5), "缩进列表也算");
  assert.ok(emptyListItem("1. ", 3, false, 4));
  assert.ok(emptyListItem("- [ ] ", 6, false, 7), "任务列表空项");
  assert.ok(emptyListItem("- [x] ", 6, false, 7));
});

test("emptyListItem 不处理非空项与普通行", () => {
  assert.equal(emptyListItem("- 有内容", 6, false, 7), null);
  assert.equal(emptyListItem("普通文字", 4, false, 5), null);
  assert.equal(emptyListItem("- ", 0, false, 3), null, "光标在标记之前不处理");
});

test("emptyListItem 不把空行/纯空白当成标记（否则回车会多插一个换行）", () => {
  // 回归：正则曾有"所有部分都可选"的版本，导致空字符串也匹配 →
  // 在空行上按回车会走"退出标记"分支，凭空多出一个空行。
  assert.equal(emptyListItem("", 0, false, 0), null);
  assert.equal(emptyListItem("", 0, true, 0), null);
  assert.equal(emptyListItem(" ", 1, false, 2), null);
  assert.equal(emptyListItem("   ", 3, false, 4), null);
});

test("emptyListItem 识别引用里嵌套的列表标记（`> - ` / `> 1. `）", () => {
  // 回归：早期模式只认"纯引用"或"纯列表"，`> - ` 落到 CodeMirror 手上时
  // 会被保留成半截 `> `，而不是整行清掉。
  assert.ok(emptyListItem("> - ", 4, false, 5), "引用里的空无序项");
  assert.ok(emptyListItem("> 1. ", 5, false, 6), "引用里的空有序项");
  assert.ok(emptyListItem("> > - ", 6, false, 7), "两层引用里的空项");
  assert.ok(emptyListItem("> > > ", 6, false, 7), "三层空引用");
  // 有内容时绝不能处理
  assert.equal(emptyListItem("> - 有内容", 8, false, 9), null);
});

test("emptyListItem 非最后一行：整行连换行一起删", () => {
  assert.deepEqual(emptyListItem("- ", 2, false, 3), {
    markerLength: 2,
    deleteFrom: 0,
    deleteTo: 3,
    insert: "",
  });
});

test("emptyListItem 最后一行：整行删掉并补一个换行", () => {
  assert.deepEqual(emptyListItem("- ", 2, true, 2), {
    markerLength: 2,
    deleteFrom: 0,
    deleteTo: 2,
    insert: "\n",
  });
});

// --------------------------------------------------------------- 滚动同步
// 用户报的"预览区和编辑器不会同步"：旧实现遇到**没有标题**的文档直接 return，
// 表现为完全不动；锚点内部还用硬编码 26px/行 推算，必然漂移。

test("computePreviewScrollTop：没有标题时按比例同步（旧实现完全不动）", () => {
  assert.equal(
    computePreviewScrollTop({
      line: 50,
      totalLines: 100,
      ratio: 0.5,
      anchors: [],
      contentHeight: 2000,
      viewportHeight: 400,
    }),
    800,
  );
});

test("computePreviewScrollTop：无标题、滚到顶部返回 0", () => {
  assert.equal(
    computePreviewScrollTop({
      line: 1,
      totalLines: 100,
      ratio: 0,
      anchors: [],
      contentHeight: 2000,
      viewportHeight: 400,
    }),
    0,
  );
});

test("computePreviewScrollTop：无标题、滚到底不超过 maxScroll", () => {
  assert.equal(
    computePreviewScrollTop({
      line: 100,
      totalLines: 100,
      ratio: 1,
      anchors: [],
      contentHeight: 2000,
      viewportHeight: 400,
    }),
    1600,
  );
});

test("computePreviewScrollTop：内容比视口短时返回 0", () => {
  assert.equal(
    computePreviewScrollTop({
      line: 50,
      totalLines: 100,
      ratio: 1,
      anchors: [],
      contentHeight: 300,
      viewportHeight: 400,
    }),
    0,
  );
});

test("computePreviewScrollTop：第一行落在第一个标题之前 → 顶部", () => {
  assert.equal(
    computePreviewScrollTop({
      line: 1,
      totalLines: 200,
      ratio: 0,
      anchors: [
        { line: 10, offsetTop: 200 },
        { line: 100, offsetTop: 1200 },
      ],
      contentHeight: 2000,
      viewportHeight: 400,
    }),
    0,
  );
});

test("computePreviewScrollTop：锚点内按实际像素插值，不再用固定 26px/行", () => {
  // 锚点：行 0 在 0px、行 100 在 1000px → 每行 10px。
  // scrollLine=50 是 1 基 → 行索引 49 → 490px。
  // 若还用硬编码 26px/行，会算成 1274px，严重跑偏。
  assert.equal(
    computePreviewScrollTop({
      line: 50,
      totalLines: 200,
      ratio: 0.5,
      anchors: [
        { line: 0, offsetTop: 0 },
        { line: 100, offsetTop: 1000 },
      ],
      contentHeight: 3000,
      viewportHeight: 400,
    }),
    490,
  );
});

test("computePreviewScrollTop：命中的正是锚点本身 → 对齐锚点", () => {
  assert.equal(
    computePreviewScrollTop({
      line: 101,
      totalLines: 200,
      ratio: 0.5,
      anchors: [
        { line: 0, offsetTop: 0 },
        { line: 100, offsetTop: 1000 },
      ],
      contentHeight: 3000,
      viewportHeight: 400,
    }),
    1000,
  );
});

test("computePreviewScrollTop：最后一个锚点之后用剩余高度插值", () => {
  const top = computePreviewScrollTop({
    line: 50,
    totalLines: 100,
    ratio: 0.5,
    anchors: [{ line: 0, offsetTop: 0 }],
    contentHeight: 1000,
    viewportHeight: 200,
  });
  assert.ok(Math.abs(top - 494.95) < 1, `应约为 495，实际 ${top}`);
});

test("computePreviewScrollTop：结果被夹在可滚动范围内", () => {
  assert.equal(
    computePreviewScrollTop({
      line: 999,
      totalLines: 1000,
      ratio: 1,
      anchors: [{ line: 0, offsetTop: 0 }],
      contentHeight: 1000,
      viewportHeight: 200,
    }),
    800,
  );
});

test("computePreviewScrollTop：异常输入不产生 NaN", () => {
  const top = computePreviewScrollTop({
    line: 0,
    totalLines: 0,
    ratio: Number.NaN,
    anchors: [{ line: 0, offsetTop: 0 }],
    contentHeight: 0,
    viewportHeight: 0,
  });
  assert.ok(Number.isFinite(top), `结果必须是有限数，实际 ${top}`);
});

// --------------------------------------------------------------- 光标跟随
// 编辑时光标移动了，但编辑器不一定滚动，预览就停在原处不动。
// 规则要既能跟随、又不能在逐字符输入时把预览抖来抖去。

test("shouldFollowCursor：光标移出可视区 → 跟随", () => {
  assert.equal(shouldFollowCursor(50, 40, 1, 30), true, "光标在可视区下方");
  assert.equal(shouldFollowCursor(5, 40, 20, 60), true, "光标在可视区上方");
});

test("shouldFollowCursor：可视区内小幅移动 → 不跟随", () => {
  assert.equal(shouldFollowCursor(11, 10, 1, 30), false);
  assert.equal(shouldFollowCursor(12, 10, 1, 30), false);
});

test("shouldFollowCursor：可视区内移动达到阈值 → 跟随", () => {
  assert.equal(shouldFollowCursor(13, 10, 1, 30), true);
  assert.equal(shouldFollowCursor(25, 10, 1, 30), true);
});

test("shouldFollowCursor：连续按回车会随光标推进而跟随", () => {
  let last = 1;
  const followed = [];
  for (let line = 2; line <= 10; line++) {
    if (shouldFollowCursor(line, last, 1, 30)) {
      followed.push(line);
      last = line;
    }
  }
  assert.ok(followed.length >= 3, `应至少跟随几次，实际 ${JSON.stringify(followed)}`);
  assert.equal(followed.at(-1), 10, "最后一次移动应触发跟随");
});

// --------------------------------------------------------------- 节流尾补发
// 滚动停下时的最后一个事件落在节流窗口内被丢弃，预览就停在倒数第二个位置。

/** 可控时钟 + 手动推进的定时器，用于确定性地测试节流 */
function makeClock() {
  let time = 0;
  const timers = [];
  return {
    now: () => time,
    setTimer: (fn, ms) => {
      const t = { at: time + ms, fn, done: false };
      timers.push(t);
      return t;
    },
    advance(ms) {
      time += ms;
      for (const t of [...timers]) {
        if (!t.done && t.at <= time) {
          t.done = true;
          t.fn();
        }
      }
    },
  };
}

test("节流：窗口外的调用立即发出", () => {
  const clock = makeClock();
  const seen = [];
  const push = createTrailingThrottle((v) => seen.push(v), 16, clock);

  push(1);
  clock.advance(20);
  push(2);

  assert.deepEqual(seen, [1, 2]);
});

test("节流：窗口内只发第一次，窗口结束时补发最后一次", () => {
  const clock = makeClock();
  const seen = [];
  const push = createTrailingThrottle((v) => seen.push(v), 16, clock);

  push(1);
  push(2);
  push(3);
  push(4);

  assert.deepEqual(seen, [1], "窗口内不应立即发出");
  clock.advance(16);
  assert.deepEqual(seen, [1, 4], "应补发最后一次的值");
});

test("节流：补发之后新的调用又能立即发出", () => {
  const clock = makeClock();
  const seen = [];
  const push = createTrailingThrottle((v) => seen.push(v), 16, clock);

  push(1);
  push(2);
  clock.advance(16);
  clock.advance(16);
  push(3);

  assert.deepEqual(seen, [1, 2, 3]);
});

test("节流：只有一次调用时不会凭空补发", () => {
  const clock = makeClock();
  const seen = [];
  const push = createTrailingThrottle((v) => seen.push(v), 16, clock);

  push(1);
  clock.advance(100);

  assert.deepEqual(seen, [1]);
});

test("节流：连续快速调用不会堆积多个定时器", () => {
  const clock = makeClock();
  const seen = [];
  const push = createTrailingThrottle((v) => seen.push(v), 16, clock);

  push(0);
  for (let i = 1; i <= 20; i++) push(i);
  clock.advance(16);

  assert.deepEqual(seen, [0, 20]);
});

test("节流：模拟真实滚动（每 4ms 一个事件）最终落在最后位置", () => {
  const clock = makeClock();
  const seen = [];
  const push = createTrailingThrottle((v) => seen.push(v), 16, clock);

  for (let i = 1; i <= 10; i++) {
    push(i);
    clock.advance(4);
  }
  clock.advance(16);

  assert.equal(seen.at(-1), 10, `最后一个位置必须是 10，实际 ${seen.at(-1)}`);
  assert.ok(seen.length <= 4, `事件应被压缩，实际发了 ${seen.length} 次`);
});

// ---------------------------------------------------------------- 大纲跳转
//
// 起因：点大纲不跳转。根因是它只让**编辑器**滚，而「预览视图」下编辑器是
// display:none —— 滚一个隐藏元素什么也看不见。现在预览也响应，
// 用的就是这个"按行号挑锚点"的逻辑。

const ANCHORS = [
  { line: 0, id: "a" },
  { line: 12, id: "b" },
  { line: 40, id: "c" },
  { line: 41, id: "d" },
];

test("pickAnchorAtLine：命中精确行", () => {
  assert.equal(pickAnchorAtLine(ANCHORS, 12)?.id, "b");
  assert.equal(pickAnchorAtLine(ANCHORS, 41)?.id, "d");
});

test("pickAnchorAtLine：没命中时取「前一个」锚点（正文属于上面的标题）", () => {
  assert.equal(pickAnchorAtLine(ANCHORS, 20)?.id, "b");
  assert.equal(pickAnchorAtLine(ANCHORS, 39)?.id, "b");
  assert.equal(pickAnchorAtLine(ANCHORS, 999)?.id, "d", "超过最后一项时停在最后一项");
});

test("pickAnchorAtLine：在第一项之前时退回第一项（不能返回 null 导致不滚动）", () => {
  const shifted = [
    { line: 5, id: "x" },
    { line: 9, id: "y" },
  ];
  assert.equal(pickAnchorAtLine(shifted, 0)?.id, "x");
});

test("pickAnchorAtLine：空列表返回 null", () => {
  assert.equal(pickAnchorAtLine([], 3), null);
});

test("contentOffset：用 getBoundingClientRect 求内容内位置（不用 offsetTop）", () => {
  // 关键回归：.pane-preview 是 static，标题的 offsetParent 会找到 BODY，
  // 于是 offsetTop 里混进标题栏高度。这里锁住正确的算法。
  //
  // 场景：标题栏 38px + 标签栏 46px = 84px；容器顶边在视口 84px 处；
  // 标题在视口 251px 处；容器已滚 0。
  //   offsetTop（错误）     = 251（含 38+46 的偏移）
  //   contentOffset（正确） = 251 - 84 + 0 = 167
  assert.equal(contentOffset(251, 84, 0), 167);
  // 滚动之后仍自洽：容器滚了 100，标题在视口 151
  assert.equal(contentOffset(151, 84, 100), 167);
  // 容器顶边在 0 时等于 elementTop + scrollTop
  assert.equal(contentOffset(300, 0, 50), 350);
});

test("contentOffset 与 offsetTop 的差异正是被误加进去的栏高", () => {
  const elementTop = 251;
  const containerTop = 84;
  const wrong = 251; // offsetTop，含 84 的偏移
  const right = contentOffset(elementTop, containerTop, 0);
  assert.equal(wrong - right, 84, "差值就是标题栏 + 标签栏的高度");
});

test("渲染出来的标题带 data-line，且与 scanHeadings 的 0 基行号一致", () => {
  // 大纲传的是 0 基行号，data-line 也是 0 基 —— 两者必须对齐，
  // 否则点大纲会跳到相邻标题。
  const md = ["# 第一章", "", "正文", "", "## 1.1 小节", "", "正文", "", "### 细节"].join("\n");
  const headings = scanHeadings(md);
  assert.deepEqual(
    headings.map((h) => h.line),
    [0, 4, 8],
  );
  const html = attachHeadingLines("<h1>第一章</h1><h2>1.1 小节</h2><h3>细节</h3>", headings);
  assert.match(html, /<h1 data-line="0"/);
  assert.match(html, /<h2 data-line="4"/);
  assert.match(html, /<h3 data-line="8"/);
});
