# 把一张"设计稿"图片做成应用图标源图。
#
# 为什么需要单独一步：设计稿是白底方形图，直接当图标会出现白角；而
# scripts/make-icon.mjs 是自己栅格化画的，解不了 PNG。这里用 Pillow：
#   1) 用**暗色阈值**找图标本体（不用"非白"阈值：设计稿四周有一圈很淡的投影，
#      按"非白"找会把影子算进画布，结果是图标四周多出一圈灰、整体显得发虚）
#   2) 从四边泛洪，把与边框连通的"非本体"像素标成背景 → alpha 0
#      （只从**边框**出发，所以图标内部的白字不会被误伤）
#   3) 收掉 1~2px 与白底混色的过渡带，且**不做模糊**：
#      模糊过的 alpha 在缩放时会摊成几像素的灰晕，这才是"图标发虚"的主因
#   4) 放大到 1024（900→1024 只有 1.14 倍，LANCZOS 足够），**不锐化**：
#      锐化会在底板外边缘产生过冲亮边，比原来的糊更显眼
#
# 用法：python scripts/make-icon-from-image.py icon-source-original.png
import sys
from collections import deque

from PIL import Image, ImageFilter, ImageOps

SRC = sys.argv[1] if len(sys.argv) > 1 else "icon-source-original.png"
TARGET = 1024
# 图标本体是近黑底板（亮度约 8~30）；白底、边框、投影都在 200 以上，用 200 一刀切
BODY_THRESHOLD = 200
# 收边半径（像素）：设计稿边缘有 1~2px 半白过渡带
ERODE = 2

im = Image.open(SRC).convert("RGB")
w, h = im.size
gray = im.convert("L")
gp = gray.load()

# 1) 用暗色阈值找本体包围盒（投影被排除）
minx, miny, maxx, maxy = w, h, -1, -1
for y in range(h):
    for x in range(w):
        if gp[x, y] < BODY_THRESHOLD:
            if x < minx:
                minx = x
            if y < miny:
                miny = y
            if x > maxx:
                maxx = x
            if y > maxy:
                maxy = y
if maxx < 0:
    raise SystemExit("找不到图标本体（整张图都亮于阈值）")

# 补成正方形：设计稿里图标的宽高可能差几个像素，直接拉伸会变形
side = max(maxx - minx + 1, maxy - miny + 1)
cx = (minx + maxx + 1) / 2
cy = (miny + maxy + 1) / 2
left = int(round(cx - side / 2))
top = int(round(cy - side / 2))
if left < 0 or top < 0 or left + side > w or top + side > h:
    raise SystemExit("四周留白不够，裁不出正方形（需要时手动调整原图）")
tile = im.crop((left, top, left + side, top + side))
tw, th = tile.size
print(f"原图 {w}×{h} → 本体 {maxx - minx + 1}×{maxy - miny + 1}，正方形裁剪 {tw}×{th} @({left},{top})")

# 2) 从四边泛洪：能走到的都是"本体之外"
tp = tile.convert("L").load()
seen = bytearray(tw * th)
queue = deque()


def push_outside(x, y):
    if seen[y * tw + x]:
        return
    if tp[x, y] >= BODY_THRESHOLD:  # 亮 = 背景
        seen[y * tw + x] = 1
        queue.append((x, y))


for x in range(tw):
    push_outside(x, 0)
    push_outside(x, th - 1)
for y in range(th):
    push_outside(0, y)
    push_outside(tw - 1, y)

while queue:
    x, y = queue.popleft()
    if x > 0:
        push_outside(x - 1, y)
    if x + 1 < tw:
        push_outside(x + 1, y)
    if y > 0:
        push_outside(x, y - 1)
    if y + 1 < th:
        push_outside(x, y + 1)

mask = Image.new("L", (tw, th), 255)
mp = mask.load()
outside = 0
for y in range(th):
    for x in range(tw):
        if seen[y * tw + x]:
            mp[x, y] = 0
            outside += 1
print(f"背景像素 {outside}（{outside / (tw * th) * 100:.1f}%）")

# 3) 收 ERODE 像素：去掉与白底混色的过渡带，边界变成底板自己的深色。
#    注意：PIL 的 MinFilter 在图像边缘是"复制边缘像素"，最外那几行/列永远收不进去，
#    所以先补一圈透明边框、收完再裁回去。
win = ERODE * 2 + 1
padded = ImageOps.expand(mask, border=ERODE, fill=0)
mask = padded.filter(ImageFilter.MinFilter(win)).crop((ERODE, ERODE, ERODE + tw, ERODE + th))

# 3b) 把"透明区"先填成图标底板自己的深色再放大：
#     否则放大时的 LANCZOS 会从白底采样，边缘混进浅色。
mask_px = mask.load()
tile_px = tile.load()
solid = Image.new("RGB", (tw, th), (8, 8, 10))
solid_px = solid.load()
for y in range(th):
    for x in range(tw):
        if mask_px[x, y] > 0:
            solid_px[x, y] = tile_px[x, y]

# 4) 放大（不锐化），alpha 单独放大
big = solid.resize((TARGET, TARGET), Image.LANCZOS)
mask_big = mask.resize((TARGET, TARGET), Image.LANCZOS)
out = big.convert("RGBA")
out.putalpha(mask_big)
out.save("icon-source.png")
out.resize((32, 32), Image.LANCZOS).save("icon-preview-32.png")
print(f"已生成 icon-source.png（{TARGET}×{TARGET}，RGBA）与 icon-preview-32.png（32×32）")
print("下一步：npx tauri icon icon-source.png，然后重新打包")
