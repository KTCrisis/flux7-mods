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

import numpy as np
from PIL import Image, ImageEnhance

ROOT = Path(__file__).resolve().parent.parent

p = argparse.ArgumentParser()
p.add_argument("persona")
p.add_argument("--box", type=int, nargs=4, default=None)
p.add_argument("--size", type=int, default=64)
p.add_argument("--frame", default=None)
p.add_argument("--reach", type=int, default=40, help="largest shift searched, in pixels")
a = p.parse_args()


def offset(base: Image.Image, frame: Image.Image, reach: int = 40) -> tuple[int, int]:
    """The (dx, dy) that best lays frame over base: the peak of the cross-correlation
    of their edges (FFT, zero-padded), within reach. Edges, not raw pixels, so
    large black areas do not pull the match."""
    def edges(im: Image.Image) -> np.ndarray:
        g = np.asarray(im.convert("L").resize((base.width // 2, base.height // 2)), dtype=np.float32)
        e = np.hypot(np.diff(g, axis=0, append=g[-1:]), np.diff(g, axis=1, append=g[:, -1:]))
        return e - e.mean()
    b, f = edges(base), edges(frame)
    h, w = b.shape
    size = (2 * h, 2 * w)
    corr = np.fft.irfft2(np.fft.rfft2(b, size) * np.conj(np.fft.rfft2(f, size)), size)
    r = reach // 2
    best, at = None, (0, 0)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            v = corr[dy % size[0], dx % size[1]]
            if best is None or v > best:
                best, at = v, (dx * 2, dy * 2)
    return at


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
