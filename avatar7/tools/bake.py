"""Bake a studio portrait into the raw RGB grid avatar7 draws.

usage: python tools/bake.py <persona> [--box x0 y0 x1 y1] [--size 64]
Reads personas/<persona>/portrait.png, writes face.rgb (size x size pixels,
3 bytes each, row-major) and face-preview.png (x8) beside it.
"""
import argparse
from pathlib import Path

from PIL import Image, ImageChops, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parent.parent

p = argparse.ArgumentParser()
p.add_argument("persona")
p.add_argument("--box", type=int, nargs=4, default=None)
p.add_argument("--size", type=int, default=64)
p.add_argument("--sharpen", type=int, default=90, help="unsharp mask percent after the reduction, 0 for none")
a = p.parse_args()

folder = ROOT / "personas" / a.persona
img = Image.open(folder / "portrait.png").convert("RGB")
if a.box:
    img = img.crop(tuple(a.box))
img = ImageEnhance.Contrast(img).enhance(1.25)
img = img.resize((a.size, a.size), Image.LANCZOS)
# At 64 pixels the reduction softens every edge; an unsharp mask gives the
# features back their line.
# The mask may darken an edge at will but lighten it by a few levels only,
# or pale faces (Ada) burn to white.
if a.sharpen:
    sharp = img.filter(ImageFilter.UnsharpMask(radius=1, percent=a.sharpen, threshold=2))
    img = ImageChops.darker(sharp, ImageChops.add(img, Image.new("RGB", img.size, (10, 10, 10))))
(folder / "face.rgb").write_bytes(img.tobytes())
img.resize((a.size * 8, a.size * 8), Image.NEAREST).save(folder / "face-preview.png")
print(f"{folder / 'face.rgb'} {a.size}x{a.size}")
