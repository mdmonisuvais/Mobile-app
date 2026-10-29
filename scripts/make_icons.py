"""Generate launcher icons into the generated Android project (run after `npx cap add android`)."""
import os, sys
from PIL import Image, ImageDraw

RES = sys.argv[1] if len(sys.argv) > 1 else "android/app/src/main/res"
BG = (16, 36, 58)
TEAL = (45, 212, 191)
TEAL2 = (15, 118, 110)

def draw_mark(size, pad_ratio):
    """Bar chart + rising line mark on transparent canvas."""
    S = size * 4
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = S * pad_ratio
    w = S - 2 * pad
    bars = [0.35, 0.55, 0.45, 0.8]
    bw = w / (len(bars) * 2 - 1)
    base = S - pad
    for i, h in enumerate(bars):
        x0 = pad + i * 2 * bw
        d.rounded_rectangle([x0, base - h * w * 0.85, x0 + bw, base], radius=bw * 0.25,
                            fill=TEAL if i == 3 else (153, 246, 228))
    pts = [(pad + bw * 0.5 + i * 2 * bw, base - h * w * 0.85 - w * 0.10) for i, h in enumerate(bars)]
    d.line(pts, fill=(255, 255, 255), width=int(S * 0.025), joint="curve")
    for p in pts:
        r = S * 0.022
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)

def gradient_bg(size):
    img = Image.new("RGB", (size, size), BG)
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size)
            px[x, y] = tuple(int(BG[i] * (1 - t) + TEAL2[i] * t) for i in range(3))
    return img

sizes = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
for dpi, s in sizes.items():
    folder = os.path.join(RES, f"mipmap-{dpi}")
    if not os.path.isdir(folder):
        continue
    # legacy square + round
    bg = gradient_bg(s).convert("RGBA")
    mark = draw_mark(s, 0.2)
    sq = bg.copy(); sq.alpha_composite(mark)
    rounded = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    mask = Image.new("L", (s * 4, s * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s * 4, s * 4], radius=s * 4 * 0.22, fill=255)
    rounded.paste(sq, (0, 0), mask.resize((s, s), Image.LANCZOS))
    rounded.save(os.path.join(folder, "ic_launcher.png"))
    circle = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    cm = Image.new("L", (s * 4, s * 4), 0)
    ImageDraw.Draw(cm).ellipse([0, 0, s * 4, s * 4], fill=255)
    circle.paste(sq, (0, 0), cm.resize((s, s), Image.LANCZOS))
    circle.save(os.path.join(folder, "ic_launcher_round.png"))
    # adaptive foreground is 108dp-based: scale 108/48
    fs = int(s * 108 / 48)
    fg = Image.new("RGBA", (fs, fs), (0, 0, 0, 0))
    m = draw_mark(int(fs * 0.62), 0.04)
    fg.alpha_composite(m, ((fs - m.width) // 2, (fs - m.height) // 2))
    fg.save(os.path.join(folder, "ic_launcher_foreground.png"))

values = os.path.join(RES, "values")
os.makedirs(values, exist_ok=True)
with open(os.path.join(values, "ic_launcher_background.xml"), "w") as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#10243A</color>\n</resources>\n')
print("icons written to", RES)
