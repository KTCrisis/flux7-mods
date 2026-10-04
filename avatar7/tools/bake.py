"""Bake a studio portrait into the raw RGB grid avatar7 draws.

usage: python tools/bake.py <persona> [--box x0 y0 x1 y1] [--size 64] [--frame talk]
Reads personas/<persona>/portrait.png, writes face.rgb (size x size pixels,
3 bytes each, row-major) and face-preview.png (x8) beside it.

With --frame <name>, reads portrait-<name>.png instead, an edit of the same
portrait (open mouth, frown), shifts it onto portrait.png first (edits drift
by a few pixels, which would make the face jitter when frames alternate),
then writes face-<name>.rgb and face-<name>-preview.png with the same box.
"""
import argparse
from pathlib import Path

from PIL import Image, ImageEnhance

from align import offset

ROOT = Path(__file__).resolve().parent.parent

p = argparse.ArgumentParser()
p.add_argument("persona")
p.add_argument("--box", type=int, nargs=4, default=None)
p.add_argument("--size", type=int, default=64)
p.add_argument("--frame", default=None)
p.add_argument("--reach", type=int, default=40, help="largest shift searched, in pixels")
a = p.parse_args()


folder = ROOT / "personas" / a.persona
img = Image.open(folder / "portrait.png").convert("RGB")
suffix = ""
if a.frame:
    suffix = f"-{a.frame}"
    frame = Image.open(folder / f"portrait{suffix}.png").convert("RGB").resize(img.size)
    dx, dy = offset(img, frame, a.reach)
    # Shifted onto black: ImageChops.offset would wrap the strip that leaves
    # one edge back in at the other, and the face's edge would jump.
    img = Image.new("RGB", frame.size)
    img.paste(frame, (dx, dy))
    print(f"{a.frame}: shifted by {dx}, {dy}")
if a.box:
    img = img.crop(tuple(a.box))
img = ImageEnhance.Contrast(img).enhance(1.25)
img = img.resize((a.size, a.size), Image.LANCZOS)
(folder / f"face{suffix}.rgb").write_bytes(img.tobytes())
img.resize((a.size * 8, a.size * 8), Image.NEAREST).save(folder / f"face{suffix}-preview.png")
print(f"{folder / f'face{suffix}.rgb'} {a.size}x{a.size}")
