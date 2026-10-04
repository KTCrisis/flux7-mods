"""Bake a studio backdrop into the raw RGB grid avatar7 draws under the text.

usage: python tools/bake_scene.py <persona> [--width 384]
Reads personas/<persona>/scene.png, a wide render (a skyline, a shore), writes
scene.rgb (width x its height kept to the render's ratio, 3 bytes a pixel,
row-major) and scene-preview.png (x4) beside it. persona.json names it in its
ambient: {"kind": "scene", "file": "scene.rgb", "width": W, "height": H}.
"""
import argparse
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

p = argparse.ArgumentParser()
p.add_argument("persona")
p.add_argument("--width", type=int, default=384)
a = p.parse_args()

d = ROOT / "personas" / a.persona
src = Image.open(d / "scene.png").convert("RGB")
h = round(src.height * a.width / src.width)
out = src.resize((a.width, h), Image.LANCZOS)
(d / "scene.rgb").write_bytes(out.tobytes())
out.resize((a.width * 4, h * 4), Image.NEAREST).save(d / "scene-preview.png")
print(f"{d / 'scene.rgb'}: {a.width}x{h}")
