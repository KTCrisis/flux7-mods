"""Bake a studio portrait into the raw RGB grid the shodan7 Raster draws.

usage: python tools/bake.py <portrait.png> [--box x0 y0 x1 y1] [--size 64]
Writes assets/face.rgb (size x size pixels, 3 bytes each, row-major).
"""
import argparse
from pathlib import Path

from PIL import Image, ImageEnhance

ROOT = Path(__file__).resolve().parent.parent

p = argparse.ArgumentParser()
p.add_argument("portrait")
p.add_argument("--box", type=int, nargs=4, default=None)
p.add_argument("--size", type=int, default=64)
a = p.parse_args()

img = Image.open(a.portrait).convert("RGB")
if a.box:
    img = img.crop(tuple(a.box))
img = ImageEnhance.Contrast(img).enhance(1.25)
img = img.resize((a.size, a.size), Image.LANCZOS)
out = ROOT / "assets" / "face.rgb"
out.write_bytes(img.tobytes())
img.resize((a.size * 8, a.size * 8), Image.NEAREST).save(ROOT / "assets" / "face-preview.png")
print(f"{out} {a.size}x{a.size}")
