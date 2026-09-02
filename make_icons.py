#!/usr/bin/env python3
"""Иконки «Кальки» — тот же знак, что на стартовом экране: два скруглённых
квадрата внахлёст, верхний полупрозрачный, как лист кальки поверх листа."""
from PIL import Image, ImageDraw
import os

OUT = os.path.dirname(os.path.abspath(__file__))
BG = (0x0D, 0x10, 0x0F)
ACCENT = (0x8F, 0xB8, 0xA5)


def icon(size):
    s = size * 4
    im = Image.new("RGB", (s, s), BG)
    d = ImageDraw.Draw(im, "RGBA")
    pad, side, rad, w = s * .17, s * .49, s * .10, max(2, int(s * .028))
    # нижний лист — только контур
    d.rounded_rectangle([pad, pad, pad + side, pad + side], radius=rad, outline=ACCENT + (255,), width=w)
    # верхний — со сдвигом и лёгкой заливкой
    off = s * .17
    d.rounded_rectangle([pad + off, pad + off, pad + off + side, pad + off + side],
                        radius=rad, fill=ACCENT + (46,), outline=ACCENT + (255,), width=w)
    return im.resize((size, size), Image.LANCZOS)


for n in (32, 180, 192, 512):
    im = icon(n)
    name = f"favicon-{n}.png" if n == 32 else f"icon-{n}.png"
    im.save(os.path.join(OUT, name))
    print(name)
