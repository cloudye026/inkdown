// 生成应用图标。
//
// 设计原则：**小尺寸优先**。16px 任务栏上只认得出一两个形状，所以每个方案最多一个
// 主图形 + 一个辅助元素，靠对比和留白撑住辨识度。
//
// 方案（`node scripts/make-icon.mjs a|b|b2|c|d`）：
//   a   紫罗兰渐变底 + 白色 M + 光标条
//   b   紫罗兰渐变底 + 白色纸页（折角）+ 井号（v1，留作对比）
//   b2  同上，纸页中间换成 MD（v2）
//   c   深石墨底 + 白色 M + 亮蓝下划线
//   d   近黑 squircle + 银白 MD（D 的右上角折起）+ 下方浅灰横杆（照参考图做的，当前）
//
// 自己写栅格化是因为这台机器没有图形库：4× 超采样后降采样得到抗锯齿边缘。
// 输出 **RGBA**（圆角外面透明）：早期版本输出 RGB，圆角外是纯黑，任务栏上会出现四个黑角。
//
// ⚠️ 改这个文件请用编辑器 / 写文件工具，**不要用 PowerShell 的 Set-Content**：
// 会把多字节 UTF-8 弄坏（这个坑踩过：注释变乱码、还丢了字节）。
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SS = 4; // 超采样倍数

export class Canvas {
  constructor(size) {
    this.size = size;
    this.buf = new Float32Array(size * size * 4); // RGBA 0..1
  }
  /** 以 even-odd 规则填充多边形（点用 [x,y] 数组） */
  fillPolygon(points, [r, g, b], alpha = 1) {
    const n = points.length;
    if (n < 3) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of points) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.size - 1, Math.ceil(maxY));

    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      const xs = [];
      for (let i = 0; i < n; i++) {
        const [x1, y1p] = points[i];
        const [x2, y2p] = points[(i + 1) % n];
        if (y1p === y2p) continue;
        const lo = Math.min(y1p, y2p);
        const hi = Math.max(y1p, y2p);
        if (cy < lo || cy >= hi) continue;
        const t = (cy - y1p) / (y2p - y1p);
        xs.push(x1 + t * (x2 - x1));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.floor(xs[k]));
        const xb = Math.min(this.size - 1, Math.ceil(xs[k + 1]));
        for (let x = xa; x <= xb; x++) {
          const cx = x + 0.5;
          if (cx < xs[k] || cx >= xs[k + 1]) continue;
          this.blend(x, y, r, g, b, alpha);
        }
      }
    }
  }
  /** 圆角矩形内缩判定：点在圆角矩形里就返回 true */
  inRoundRect(cx, cy, x, y, w, h, radius) {
    if (cx < x || cx > x + w || cy < y || cy > y + h) return false;
    const dx = Math.max(x + radius - cx, 0, cx - (x + w - radius));
    const dy = Math.max(y + radius - cy, 0, cy - (y + h - radius));
    return dx * dx + dy * dy <= radius * radius;
  }
  fillRoundRect(x, y, w, h, radius, color, alpha = 1) {
    const [r, g, b] = color;
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.size - 1, Math.ceil(x + w));
    const y1 = Math.min(this.size - 1, Math.ceil(y + h));
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        if (this.inRoundRect(xx + 0.5, yy + 0.5, x, y, w, h, radius)) {
          this.blend(xx, yy, r, g, b, alpha);
        }
      }
    }
  }
  /** 竖向渐变的圆角矩形 */
  fillRoundRectVertical(x, y, w, h, radius, top, bottom, alpha = 1) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.size - 1, Math.ceil(x + w));
    const y1 = Math.min(this.size - 1, Math.ceil(y + h));
    for (let yy = y0; yy <= y1; yy++) {
      const cy = yy + 0.5;
      if (cy < y || cy > y + h) continue;
      const t = Math.min(1, Math.max(0, (cy - y) / h));
      const r = top[0] + (bottom[0] - top[0]) * t;
      const g = top[1] + (bottom[1] - top[1]) * t;
      const b = top[2] + (bottom[2] - top[2]) * t;
      for (let xx = x0; xx <= x1; xx++) {
        if (this.inRoundRect(xx + 0.5, cy, x, y, w, h, radius)) {
          this.blend(xx, yy, r, g, b, alpha);
        }
      }
    }
  }
  /**
   * squircle（超椭圆）底板：|dx/rx|^n + |dy/ry|^n <= 1。
   * n=2 是椭圆，n→∞ 是矩形；4~5 之间就是 iOS 那种"圆角但过渡更顺"的轮廓。
   */
  fillSquircleVertical(cx, cy, rx, ry, n, top, bottom, alpha = 1) {
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(this.size - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(this.size - 1, Math.ceil(cy + ry));
    for (let yy = y0; yy <= y1; yy++) {
      const dy = Math.abs((yy + 0.5 - cy) / ry);
      const t = Math.min(1, Math.max(0, (yy + 0.5 - (cy - ry)) / (2 * ry)));
      const r = top[0] + (bottom[0] - top[0]) * t;
      const g = top[1] + (bottom[1] - top[1]) * t;
      const b = top[2] + (bottom[2] - top[2]) * t;
      for (let xx = x0; xx <= x1; xx++) {
        const dx = Math.abs((xx + 0.5 - cx) / rx);
        if (Math.pow(dx, n) + Math.pow(dy, n) <= 1) this.blend(xx, yy, r, g, b, alpha);
      }
    }
  }
  /** 按 y 做竖向渐变填充多边形（纸页用） */
  fillPolygonVertical(points, top, bottom, yTop, yBottom, alpha = 1) {
    const n = points.length;
    if (n < 3) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of points) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.size - 1, Math.ceil(maxY));
    const span = Math.max(1, yBottom - yTop);
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      const t = Math.min(1, Math.max(0, (cy - yTop) / span));
      const r = top[0] + (bottom[0] - top[0]) * t;
      const g = top[1] + (bottom[1] - top[1]) * t;
      const b = top[2] + (bottom[2] - top[2]) * t;
      const xs = [];
      for (let i = 0; i < n; i++) {
        const [x1p, y1p] = points[i];
        const [x2p, y2p] = points[(i + 1) % n];
        if (y1p === y2p) continue;
        const lo = Math.min(y1p, y2p);
        const hi = Math.max(y1p, y2p);
        if (cy < lo || cy >= hi) continue;
        const k = (cy - y1p) / (y2p - y1p);
        xs.push(x1p + k * (x2p - x1p));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.floor(xs[k]));
        const xb = Math.min(this.size - 1, Math.ceil(xs[k + 1]));
        for (let x = xa; x <= xb; x++) {
          if (x + 0.5 < xs[k] || x + 0.5 >= xs[k + 1]) continue;
          this.blend(x, y, r, g, b, alpha);
        }
      }
    }
  }
  /**
   * 逐行求多条闭合路径的交点（even-odd 用）：返回 { y0, y1, 每行排序后的 xs }。
   *
   * 用多条路径而不是单条自相交路径：D 的圈内要挖孔，各自算交点再统一排序成对填充，
   * 孔就自然挖出来了。
   */
  _collect(rings) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const ring of rings) {
      for (const [, y] of ring) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.size - 1, Math.ceil(maxY));
    const spans = [];
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      const xs = [];
      for (const ring of rings) {
        const n = ring.length;
        for (let i = 0; i < n; i++) {
          const [x1p, y1p] = ring[i];
          const [x2p, y2p] = ring[(i + 1) % n];
          if (y1p === y2p) continue;
          const lo = Math.min(y1p, y2p);
          const hi = Math.max(y1p, y2p);
          if (cy < lo || cy >= hi) continue;
          const k = (cy - y1p) / (y2p - y1p);
          xs.push(x1p + k * (x2p - x1p));
        }
      }
      xs.sort((a, b) => a - b);
      spans.push(xs);
    }
    return { y0, y1, spans };
  }
  /** 多路径 even-odd 实心填充（带孔字形用） */
  fillRings(rings, color, alpha = 1) {
    const [r, g, b] = color;
    const { y0, y1, spans } = this._collect(rings);
    for (let y = y0; y <= y1; y++) {
      const xs = spans[y - y0];
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.floor(xs[k]));
        const xb = Math.min(this.size - 1, Math.ceil(xs[k + 1]));
        for (let x = xa; x <= xb; x++) {
          if (x + 0.5 < xs[k] || x + 0.5 >= xs[k + 1]) continue;
          this.blend(x, y, r, g, b, alpha);
        }
      }
    }
  }
  /** 多路径 even-odd + 竖向渐变（银白字母"上白下灰"用） */
  fillRingsVertical(rings, top, bottom, yTop, yBottom, alpha = 1) {
    const { y0, y1, spans } = this._collect(rings);
    const span = Math.max(1, yBottom - yTop);
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      const t = Math.min(1, Math.max(0, (cy - yTop) / span));
      const r = top[0] + (bottom[0] - top[0]) * t;
      const g = top[1] + (bottom[1] - top[1]) * t;
      const b = top[2] + (bottom[2] - top[2]) * t;
      const xs = spans[y - y0];
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.floor(xs[k]));
        const xb = Math.min(this.size - 1, Math.ceil(xs[k + 1]));
        for (let x = xa; x <= xb; x++) {
          if (x + 0.5 < xs[k] || x + 0.5 >= xs[k + 1]) continue;
          this.blend(x, y, r, g, b, alpha);
        }
      }
    }
  }
  blend(x, y, r, g, b, a) {
    const i = (y * this.size + x) * 4;
    const dr = r / 255;
    const dg = g / 255;
    const db = b / 255;
    this.buf[i] = this.buf[i] * (1 - a) + dr * a;
    this.buf[i + 1] = this.buf[i + 1] * (1 - a) + dg * a;
    this.buf[i + 2] = this.buf[i + 2] * (1 - a) + db * a;
    this.buf[i + 3] = Math.min(1, this.buf[i + 3] + a);
  }
  /**
   * 降采样到目标尺寸，输出 **RGBA**。
   *
   * 必须先按 alpha 加权再平均颜色：圆角边缘之外的像素是透明的、颜色为 0，
   * 直接平均会把边缘压成黑边（早期的四个黑角就是这么来的）。
   */
  downsampleRgba(target) {
    const out = Buffer.alloc(target * target * 4);
    const f = this.size / target;
    for (let y = 0; y < target; y++) {
      for (let x = 0; x < target; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let aSum = 0;
        let n = 0;
        for (let sy = Math.floor(y * f); sy < Math.floor((y + 1) * f); sy++) {
          for (let sx = Math.floor(x * f); sx < Math.floor((x + 1) * f); sx++) {
            const i = (sy * this.size + sx) * 4;
            const a = this.buf[i + 3];
            r += this.buf[i] * a;
            g += this.buf[i + 1] * a;
            b += this.buf[i + 2] * a;
            aSum += a;
            n++;
          }
        }
        const o = (y * target + x) * 4;
        out[o] = Math.round((aSum > 0 ? r / aSum : 0) * 255);
        out[o + 1] = Math.round((aSum > 0 ? g / aSum : 0) * 255);
        out[o + 2] = Math.round((aSum > 0 ? b / aSum : 0) * 255);
        out[o + 3] = Math.round((aSum / n) * 255);
      }
    }
    return out;
  }
}

// ---------------- 字形 ----------------

/** M 字形（单个多边形，nonzero 填充） */
function mGlyph(x, y, w, h, stem) {
  const mid = x + w / 2;
  return [
    [x, y + h],
    [x, y],
    [x + stem, y],
    [mid, y + h * 0.58],
    [x + w - stem, y],
    [x + w, y],
    [x + w, y + h],
    [x + w - stem, y + h],
    [x + w - stem, y + h * 0.44],
    [mid, y + h],
    [x + stem, y + h * 0.44],
    [x + stem, y + h],
  ];
}

/**
 * D 字形：左边一条直边，右边是**半椭圆**的肚子。
 * bowlW 控制肚子横向半径（=w 就是半圆，太圆；0.6~0.8 之间才像字母 D）。
 */
function dGlyph(x, y, w, h, bowlW, steps = 16) {
  const ry = h / 2;
  const cx = x + w - bowlW;
  const cy = y + ry;
  const pts = [
    [x, y],
    [cx, y],
  ];
  for (let i = 1; i < steps; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / steps;
    pts.push([cx + Math.cos(a) * bowlW, cy + Math.sin(a) * ry]);
  }
  pts.push([cx, y + h]);
  pts.push([x, y + h]);
  return pts;
}

/**
 * 纸页外形：左下三个角是圆角，右上角切一刀当折角。
 * 顺时针给点（折角 → 右边 → 下边 → 左边 → 上边）。
 */
function pagePolygon(x, y, w, h, r, cut) {
  const pts = [];
  const arc = (cx, cy, from, to, steps = 6) => {
    for (let i = 0; i <= steps; i++) {
      const a = from + ((to - from) * i) / steps;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  const HALF = Math.PI / 2;
  pts.push([x + w - cut, y]); // 折角起点
  pts.push([x + w, y + cut]); // 折角斜边
  pts.push([x + w, y + h - r]);
  arc(x + w - r, y + h - r, 0, HALF); // 右下圆角
  pts.push([x + r, y + h]);
  arc(x + r, y + h - r, HALF, Math.PI); // 左下圆角
  pts.push([x, y + r]);
  arc(x + r, y + r, Math.PI, Math.PI * 1.5); // 左上圆角
  pts.push([x + w - cut, y]);
  return pts;
}

const WHITE = [255, 255, 255];

// ---------------- 方案 ----------------

/** a：紫罗兰渐变 + 白色 M + 光标条 */
function drawA(cv, S) {
  cv.fillRoundRectVertical(0, 0, S, S, S * 0.22, [91, 91, 214], [139, 92, 246]);
  const mX = 0.27;
  const mY = 0.335;
  const mW = 0.34;
  const mH = 0.33;
  cv.fillPolygon(mGlyph(mX * S, mY * S, mW * S, mH * S, mW * 0.26 * S), WHITE);
  // 光标：一根比 M 略高的圆头竖条，读作"插入点"
  cv.fillRoundRect(0.66 * S, 0.3 * S, 0.07 * S, 0.4 * S, 0.035 * S, WHITE);
}

/** b：紫罗兰渐变 + 白色纸页（折角）+ 深紫井号（v1，留作对比） */
function drawB(cv, S) {
  cv.fillRoundRectVertical(0, 0, S, S, S * 0.22, [67, 56, 202], [124, 58, 237]);
  cv.fillPolygon(
    [
      [0.26 * S, 0.15 * S],
      [0.62 * S, 0.15 * S],
      [0.74 * S, 0.27 * S],
      [0.74 * S, 0.85 * S],
      [0.26 * S, 0.85 * S],
    ],
    WHITE,
  );
  cv.fillPolygon(
    [
      [0.62 * S, 0.15 * S],
      [0.62 * S, 0.27 * S],
      [0.74 * S, 0.27 * S],
    ],
    [199, 210, 254],
  );
  const ink = [76, 29, 149];
  const t = 0.06 * S;
  for (const x of [0.395, 0.545]) {
    cv.fillPolygon(
      [
        [x * S, 0.36 * S],
        [x * S + t, 0.36 * S],
        [x * S + t, 0.68 * S],
        [x * S, 0.68 * S],
      ],
      ink,
    );
  }
  for (const y of [0.435, 0.555]) {
    cv.fillPolygon(
      [
        [0.335 * S, y * S],
        [0.665 * S, y * S],
        [0.665 * S, y * S + t],
        [0.335 * S, y * S + t],
      ],
      ink,
    );
  }
}

/** 纸页上的 MD：几何无衬线，两字母共用一个基线 */
function drawMD(cv, S, ink) {
  // 比例按"字面宽 / 字高 ≈ 0.7"来：太窄会像压缩字体，小尺寸还会糊成一根竖条
  const top = 0.35;
  const height = 0.3;
  const mW = 0.21;
  const dW = 0.19;
  const gap = 0.045;
  const x0 = (1 - (mW + gap + dW)) / 2;

  cv.fillPolygon(mGlyph(x0 * S, top * S, mW * S, height * S, mW * 0.31 * S), ink);

  // D 的笔画与 M 的竖笔对齐（0.045 会明显比 M 细，看着像两种字体）
  const stroke = 0.055;
  const dx = (x0 + mW + gap) * S;
  const bowl = 0.72; // 肚子横向半径占宽度的比例（1 就是半圆，太圆）
  const outer = dGlyph(dx, top * S, dW * S, height * S, dW * bowl * S);
  const inner = dGlyph(
    dx + stroke * S,
    (top + stroke) * S,
    (dW - 2 * stroke) * S,
    (height - 2 * stroke) * S,
    (dW - 2 * stroke) * bowl * S,
  );
  cv.fillRings([outer, inner], ink);
}

/** b2：squircle 紫色底 + 白色纸页（折角 + 折痕）+ MD */
function drawB2(cv, S) {
  cv.fillSquircleVertical(0.5 * S, 0.5 * S, 0.5 * S, 0.5 * S, 4.2, [112, 82, 255], [134, 44, 226]);

  const pageX = 0.245;
  const pageY = 0.145;
  const pageW = 0.51;
  const pageH = 0.71;
  const radius = 0.03;
  const cut = 0.115;

  // 纸页（竖向渐变：上白下淡紫）。不做外投影——试过，256px 下纸页右侧会糊出一道灰边，
  // 小尺寸又完全看不见；层次交给折角与折痕
  const page = pagePolygon(pageX * S, pageY * S, pageW * S, pageH * S, radius * S, cut * S);
  cv.fillPolygonVertical(page, [255, 255, 255], [250, 250, 255], pageY * S, (pageY + pageH) * S);

  // 折角：一整块淡紫 + 沿斜边一条更浅的折痕
  const fx = (pageX + pageW - cut) * S;
  const fy = pageY * S;
  const fw = cut * S;
  cv.fillPolygon(
    [
      [fx, fy],
      [fx, fy + fw],
      [fx + fw, fy + fw],
    ],
    [228, 222, 255],
  );
  cv.fillPolygon(
    [
      [fx, fy],
      [fx + fw * 0.14, fy],
      [fx + fw, fy + fw * 0.86],
      [fx + fw, fy + fw],
      [fx + fw * 0.86, fy + fw],
      [fx, fy + fw * 0.14],
    ],
    [203, 195, 250],
  );

  drawMD(cv, S, [76, 29, 149]);
}

/** c：深石墨渐变 + 白色 M + 亮蓝下划线 */
function drawC(cv, S) {
  cv.fillRoundRectVertical(0, 0, S, S, S * 0.22, [30, 41, 59], [15, 23, 42]);
  const mX = 0.21;
  const mY = 0.29;
  const mW = 0.42;
  const mH = 0.33;
  cv.fillPolygon(mGlyph(mX * S, mY * S, mW * S, mH * S, mW * 0.26 * S), WHITE);
  cv.fillRoundRect(0.21 * S, 0.7 * S, 0.58 * S, 0.06 * S, 0.03 * S, [96, 165, 250]);
}

/**
 * d：照参考图做的那一版——近黑 squircle + 银白 MD（D 的右上角像纸页一样折起）
 * + 下方浅灰横杆。
 *
 * 和前面几版的区别在气质：前面是"白纸放在彩色底板上"，这版是**字母本身就是那张纸**
 * ——MD 是银白色的实体，右上角折一下，底下一道灰杆收住重心。深底 + 亮字母在
 * 深色与浅色任务栏上都有对比；代价是深色任务栏上底板会融进背景（只剩字母）。
 */
function drawD(cv, S) {
  // 底板：近黑，上略亮下更暗
  cv.fillSquircleVertical(0.5 * S, 0.5 * S, 0.5 * S, 0.5 * S, 4.2, [26, 26, 28], [7, 7, 8]);

  const top = 0.285;
  const height = 0.395;
  const silverTop = [255, 255, 255];
  const silverBottom = [204, 204, 210];

  // M：几何字形，笔画占宽度的 0.18（参考图里的 M 很重）
  const mX = 0.18;
  const mW = 0.29;
  cv.fillPolygonVertical(
    mGlyph(mX * S, top * S, mW * S, height * S, mW * 0.18 * S),
    silverTop,
    silverBottom,
    top * S,
    (top + height) * S,
  );

  // D：外圈（左直边 + 大半圆肚子）+ 内圈挖孔
  const dX = 0.515;
  const dW = 0.325;
  const stroke = 0.052;
  const bowl = 0.78;
  const outer = dGlyph(dX * S, top * S, dW * S, height * S, dW * bowl * S);
  const inner = dGlyph(
    (dX + stroke) * S,
    (top + stroke) * S,
    (dW - 2 * stroke) * S,
    (height - 2 * stroke) * S,
    (dW - 2 * stroke) * bowl * S,
  );
  cv.fillRingsVertical([outer, inner], silverTop, silverBottom, top * S, (top + height) * S);

  // 折角：盖在 D 的右上角。先压一道阴影做"翻起来"的缝，再画灰面，
  // 最后沿斜边提一条亮线当纸的断面
  const cutX = dX + dW * 0.5;
  const cutY = top + height * 0.44;
  const r = 0.05; // 外侧圆角
  const fold = [
    [cutX * S, top * S],
    [(dX + dW - r) * S, top * S],
  ];
  for (let i = 0; i <= 10; i++) {
    const a = -Math.PI / 2 + (Math.PI / 2) * (i / 10);
    fold.push([(dX + dW - r + Math.cos(a) * r) * S, (top + r + Math.sin(a) * r) * S]);
  }
  fold.push([(dX + dW) * S, cutY * S]);

  // 阴影：折角往左下偏移一点，落在白色字母上形成"翻起"的缝
  cv.fillPolygon(
    fold.map(([x, y]) => [x - 0.008 * S, y + 0.008 * S]),
    [0, 0, 0],
    0.3,
  );
  cv.fillPolygonVertical(fold, [214, 214, 220], [138, 138, 146], top * S, cutY * S);
  // 斜面高光
  cv.fillPolygon(
    [
      [cutX * S, top * S],
      [(cutX + 0.012) * S, top * S],
      [(dX + dW) * S, (cutY - 0.012) * S],
      [(dX + dW) * S, cutY * S],
    ],
    [246, 246, 250],
  );

  // 下方横杆：浅灰圆头，宽度收在字母内
  cv.fillRoundRect(0.3 * S, 0.697 * S, 0.38 * S, 0.037 * S, 0.0185 * S, [198, 198, 204]);
}

export const VARIANTS = {
  a: { label: "渐变 M + 光标", draw: drawA },
  b: { label: "白纸 + 井号（v1）", draw: drawB },
  b2: { label: "白纸 + MD（v2）", draw: drawB2 },
  c: { label: "深石墨 M + 下划线", draw: drawC },
  d: { label: "深底 + 银白 MD + 折角（参考图）", draw: drawD },
};

/** 渲染某个方案到指定尺寸，返回 RGBA buffer */
export function renderVariant(id, size) {
  const cv = new Canvas(size * SS);
  VARIANTS[id].draw(cv, size * SS);
  return cv.downsampleRgba(size);
}

// ---------------- PNG 输出 ----------------

export function writePng(path, size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, "ascii");
    let c = 0xffffffff;
    const cin = Buffer.concat([t, data]);
    for (let i = 0; i < cin.length; i++) {
      c ^= cin[i];
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA，圆角外面透明
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", idat),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

// ---------------- 入口 ----------------

const SIZE = 1024;

function main() {
  const id = (process.argv[2] ?? "d").toLowerCase();
  if (!VARIANTS[id]) {
    console.error(`未知方案 ${id}，可选：${Object.keys(VARIANTS).join(" / ")}`);
    process.exit(1);
  }
  writePng("icon-source.png", SIZE, renderVariant(id, SIZE));
  writePng("icon-preview-32.png", 32, renderVariant(id, 32));
  console.log(
    `已生成 icon-source.png（1024×1024，方案 ${id}：${VARIANTS[id].label}）与 icon-preview-32.png（32×32）`,
  );
  console.log("下一步：npx tauri icon icon-source.png，然后重新打包");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
