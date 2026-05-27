"""Generates build/icon.png — 512x512 Slide Show Viewer app icon."""
from PIL import Image, ImageDraw, ImageFilter
import os

SIZE   = 512
CX, CY = SIZE // 2, SIZE // 2
ACCENT = (108, 99, 255)
OUT    = os.path.join(os.path.dirname(__file__), "icon.png")

def rr(draw, xy, r, fill=None, outline=None, width=1):
    draw.rounded_rectangle(xy, radius=r, fill=fill, outline=outline, width=width)

def add_glow(base, cx, cy, radius, color, blur=30, strength=0.5):
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for i in range(radius, 0, -1):
        a = int(i * strength)
        d.ellipse([cx-i, cy-i, cx+i, cy+i], fill=(*color, min(255, a)))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    return Image.alpha_composite(base, layer)

# ── base ──────────────────────────────────────────────────────────────────────
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
rr(draw, [0, 0, SIZE-1, SIZE-1], 112, fill=(13, 13, 13, 255))

# Background radial glow
img = add_glow(img, CX, CY-20, 180, ACCENT, blur=55, strength=0.35)
draw = ImageDraw.Draw(img)

# ── film frame ────────────────────────────────────────────────────────────────
FX0, FY0, FX1, FY1 = 78, 102, 434, 382
FW, FH = FX1 - FX0, FY1 - FY0

# Interior gradient — draw row by row on a temp image then paste with mask
interior = Image.new("RGBA", (FW, FH), (0,0,0,0))
id_ = ImageDraw.Draw(interior)
for y in range(FH):
    t  = y / FH
    r_ = int(16 + t * 10)
    g_ = int(12 + t *  7)
    b_ = int(46 - t * 16)
    id_.line([(0, y), (FW-1, y)], fill=(r_, g_, b_, 255))

# Build a rounded mask for the interior
int_mask = Image.new("L", (FW, FH), 0)
ImageDraw.Draw(int_mask).rounded_rectangle([0, 0, FW-1, FH-1], radius=9, fill=255)

# Paste interior onto main canvas
int_full = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
int_full.paste(interior, (FX0, FY0))

full_mask = Image.new("L", (SIZE, SIZE), 0)
full_mask.paste(int_mask, (FX0, FY0))

img.paste(int_full, mask=full_mask)
draw = ImageDraw.Draw(img)

# ── mountains ─────────────────────────────────────────────────────────────────
m1 = [(FX0,           FY1),
      (FX0 + FW*0.04, FY1),
      (FX0 + FW*0.27, FY0 + FH*0.50),
      (FX0 + FW*0.51, FY1)]
draw.polygon([(int(x), int(y)) for x,y in m1], fill=(26, 20, 50, 255))

m2 = [(FX0 + FW*0.30, FY1),
      (FX0 + FW*0.62, FY0 + FH*0.36),
      (FX0 + FW*0.96, FY1),
      (FX1,           FY1)]
draw.polygon([(int(x), int(y)) for x,y in m2], fill=(20, 14, 40, 255))

# Horizon purple glow
hy = FY0 + int(FH * 0.55)
hgl = Image.new("RGBA", (SIZE, SIZE), (0,0,0,0))
hgd = ImageDraw.Draw(hgl)
for i in range(24):
    a = max(0, 88 - i * 4)
    hgd.line([(FX0, hy + i), (FX1, hy + i)], fill=(*ACCENT, a))
hgl = hgl.filter(ImageFilter.GaussianBlur(3))
img = Image.alpha_composite(img, hgl)
draw = ImageDraw.Draw(img)

# ── frame border ─────────────────────────────────────────────────────────────
rr(draw, [FX0, FY0, FX1, FY1], 10, fill=None, outline=(*ACCENT, 210), width=3)

# ── film-strip perforations ───────────────────────────────────────────────────
PW, PH, PR  = 11, 15, 3
STRIP       = 24
# Top strip background
rr(draw, [FX0+3, FY0-STRIP, FX1-3, FY0], 0, fill=(9, 8, 20, 230))
# Bottom strip background
rr(draw, [FX0+3, FY1, FX1-3, FY1+STRIP], 0, fill=(9, 8, 20, 230))

step = 28
for x in range(FX0 + 20, FX1 - 16, step):
    yt = FY0 - STRIP + (STRIP - PH) // 2
    rr(draw, [x, yt, x+PW, yt+PH], PR, fill=(*ACCENT, 210))
    yb = FY1 + (STRIP - PH) // 2
    rr(draw, [x, yb, x+PW, yb+PH], PR, fill=(*ACCENT, 210))

# ── play button ───────────────────────────────────────────────────────────────
pcx = CX
pcy = FY0 + FH // 2 + 6

# Glow
img = add_glow(img, pcx, pcy, 60, ACCENT, blur=14, strength=2.8)
draw = ImageDraw.Draw(img)

# Frosted circle
draw.ellipse([pcx-34, pcy-34, pcx+34, pcy+34], fill=(*ACCENT, 70))
draw.ellipse([pcx-32, pcy-32, pcx+32, pcy+32], fill=(0, 0, 0, 30))

# Triangle
TS  = 24
tri = [
    (int(pcx - TS*0.42), int(pcy - TS*0.58)),
    (int(pcx - TS*0.42), int(pcy + TS*0.58)),
    (int(pcx + TS*0.64), int(pcy)),
]
draw.polygon(tri, fill=(255, 255, 255, 248))

# ── final rounded-square mask ─────────────────────────────────────────────────
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE-1, SIZE-1], 112, fill=255)
img.putalpha(mask)

img.save(OUT)
print(f"Saved: {OUT}")
