// services/popover.ts 的单元测试。
//
// 主题选择面板会从两个完全不同的位置弹出来：顶栏右上角的 ☾（视口顶部），
// 状态栏右下角的主题名（视口底部）。定位写错的表现是"面板跑到屏幕外面去"，
// 而这种问题在单测里一眼可见、在界面上却要碰运气才会遇到。

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TOP, placePopover } from "../src/services/popover.ts";

const VIEWPORT = { width: 1360, height: 800 };
const WIDTH = 352;

const anchor = (o) => ({ left: 0, right: 0, top: 0, bottom: 0, ...o });

test("顶栏的锚点：面板挂在按钮下方、右对齐", () => {
  const p = placePopover({
    anchor: anchor({ left: 1270, right: 1302, top: 6, bottom: 32 }),
    viewport: VIEWPORT,
    width: WIDTH,
  });
  assert.equal(p.above, false);
  assert.equal(p.top, 38); // bottom(32) + gap(6)
  assert.equal(p.left, 950); // right(1302) - width(352)
  assert.equal(p.bottom, undefined);
});

test("状态栏的锚点：向上弹，用 bottom 定位（面板高度事先不知道）", () => {
  const p = placePopover({
    anchor: anchor({ left: 1290, right: 1352, top: 770, bottom: 792 }),
    viewport: VIEWPORT,
    width: WIDTH,
  });
  assert.equal(p.above, true);
  assert.equal(p.bottom, 800 - 770 + 6);
  assert.equal(p.top, undefined);
});

test("靠右边的锚点不会把面板顶出屏幕", () => {
  const p = placePopover({
    anchor: anchor({ left: 1350, right: 1360, top: 6, bottom: 32 }),
    viewport: VIEWPORT,
    width: WIDTH,
  });
  assert.equal(p.left, 1360 - WIDTH - 8);
});

test("靠左边的锚点不会跑到负坐标", () => {
  const p = placePopover({
    anchor: anchor({ left: 2, right: 30, top: 6, bottom: 32 }),
    viewport: VIEWPORT,
    width: WIDTH,
  });
  assert.equal(p.left, 8);
});

test("窗口比面板还窄时也留在可视区内", () => {
  const p = placePopover({
    anchor: null,
    viewport: { width: 300, height: 600 },
    width: WIDTH,
  });
  assert.equal(p.left, 8);
});

test("没有锚点（命令面板里打开）时落在顶栏下方的右侧", () => {
  const p = placePopover({ anchor: null, viewport: VIEWPORT, width: WIDTH });
  assert.equal(p.above, false);
  assert.equal(p.top, DEFAULT_TOP);
  assert.equal(p.left, 1360 - WIDTH - 8);
});
