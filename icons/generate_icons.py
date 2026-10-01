#!/usr/bin/env python3
"""Generate the app icons. Run from anywhere: python3 icons/generate_icons.py (needs Pillow)."""
import os
from PIL import Image, ImageDraw

ACCENT = (79, 70, 229, 255)      # indigo #4f46e5
WHITE = (255, 255, 255, 255)
OUT = os.path.dirname(os.path.abspath(__file__))
SS = 4  # supersampling factor

def draw_icon(size, rounded=True, check_scale=0.56, bg=True):
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if bg:
        if rounded:
            d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=ACCENT)
        else:
            d.rectangle([0, 0, s, s], fill=ACCENT)
    # checkmark centred in a box of check_scale * size
    box = s * check_scale
    ox = (s - box) / 2
    oy = (s - box) / 2
    pts = [(0.04, 0.54), (0.36, 0.86), (0.96, 0.18)]
    pts = [(ox + x * box, oy + y * box * 1.0) for x, y in pts]
    # vertically centre the glyph (spans y 0.18..0.86)
    shift = s / 2 - (pts[1][1] + pts[2][1]) / 2
    pts = [(x, y + shift) for x, y in pts]
    w = int(box * 0.15)
    d.line(pts, fill=WHITE, width=w, joint="curve")
    for x, y in (pts[0], pts[2]):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)

def save(img, name):
    img.save(os.path.join(OUT, name), optimize=True)
    print("wrote", name, img.size)

save(draw_icon(192), "icon-192.png")
save(draw_icon(512), "icon-512.png")
# maskable: full-bleed square, glyph inside the central safe zone (80% circle)
save(draw_icon(512, rounded=False, check_scale=0.42), "icon-maskable-512.png")
# iOS applies its own rounding and dislikes transparency: full-bleed square
save(draw_icon(180, rounded=False, check_scale=0.56), "apple-touch-icon.png")
save(draw_icon(32), "favicon-32.png")
big = draw_icon(256)
big.save(os.path.join(OUT, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
print("wrote favicon.ico")
