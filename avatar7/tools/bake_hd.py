"""Bake the pictures avatar7 shows as real images, where the terminal can
(kitty, Ghostty): the portrait and its frames at --size, the scene at --width.

usage: python tools/bake_hd.py <persona>... | --all [--size 384] [--width 768]
Writes, beside each persona's PNGs, face-hd.rgb (and face-talk-hd.rgb,
face-deny-hd.rgb when the frames exist) and scene-hd.rgb: raw RGB, 3 bytes a
pixel, row-major. Derived from the PNGs and kept out of git (.gitignore).

The portrait's crop is the one bake.py was given with --box, kept in hd.json
as "box" with the baked sizes (persona.json stays as written by hand). When
it is missing, it is recovered from face.rgb, the 64 px bake, by matching it
against the portrait at every scale and offset.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance

from align import offset

ROOT = Path(__file__).resolve().parent.parent
LOW = 64

p = argparse.ArgumentParser()
p.add_argument("personas", nargs="*")
p.add_argument("--all", action="store_true")
p.add_argument("--size", type=int, default=384)
p.add_argument("--width", type=int, default=768)
a = p.parse_args()


def recover_box(portrait: Image.Image, face: np.ndarray) -> list[int]:
    """The square crop of portrait that bake.py reduced to face: for each side,
    scale the whole portrait so that side becomes LOW pixels, then slide a
    LOW x LOW window over it. Coarse on a grid of 8, then refined by 1."""
    target = face.astype(np.float32)
    best = (float("inf"), [0, 0, portrait.width, portrait.height])

    def score(side: int, x: int, y: int) -> float:
        crop = portrait.crop((x, y, x + side, y + side))
        crop = ImageEnhance.Contrast(crop).enhance(1.25).resize((LOW, LOW), Image.LANCZOS)
        return float(np.mean((np.asarray(crop, dtype=np.float32) - target) ** 2))

    for side in range(portrait.width, 255, -32):
        for y in range(0, portrait.height - side + 1, 32):
            for x in range(0, portrait.width - side + 1, 32):
                s = score(side, x, y)
                if s < best[0]:
                    best = (s, [x, y, x + side, y + side])
    for step in (8, 2, 1):
        improved = True
        while improved:
            improved = False
            x0, y0, x1, _ = best[1]
            side = x1 - x0
            for ds, dx, dy in [(0, step, 0), (0, -step, 0), (0, 0, step), (0, 0, -step), (step, 0, 0), (-step, 0, 0), (step, -step // 2 or -1, -step // 2 or -1)]:
                ns, nx, ny = side + ds, x0 + dx, y0 + dy
                if ns < 64 or nx < 0 or ny < 0 or nx + ns > portrait.width or ny + ns > portrait.height:
                    continue
                s = score(ns, nx, ny)
                if s < best[0]:
                    best = (s, [nx, ny, nx + ns, ny + ns])
                    improved = True
    print(f"  box recovered: {best[1]} (mean squared error {best[0]:.1f})")
    return best[1]


def bake(persona: str) -> None:
    folder = ROOT / "personas" / persona
    hd_path = folder / "hd.json"
    hd = json.loads(hd_path.read_text()) if hd_path.exists() else {}
    base = Image.open(folder / "portrait.png").convert("RGB")
    print(persona)

    box = hd.get("box")
    if box is None:
        low = np.frombuffer((folder / "face.rgb").read_bytes(), dtype=np.uint8).reshape(LOW, LOW, 3)
        box = recover_box(base, low)
    hd = {"box": box, "size": a.size}

    for frame in ("", "talk", "deny"):
        suffix = f"-{frame}" if frame else ""
        src = folder / f"portrait{suffix}.png"
        if not src.exists() or (frame and not (folder / f"face{suffix}.rgb").exists()):
            continue
        img = base
        if frame:
            # Same alignment as bake.py --frame, so the HD frames do not jitter.
            edit = Image.open(src).convert("RGB").resize(base.size)
            dx, dy = offset(base, edit)
            img = Image.new("RGB", edit.size)
            img.paste(edit, (dx, dy))
        img = ImageEnhance.Contrast(img.crop(tuple(box))).enhance(1.25)
        img = img.resize((a.size, a.size), Image.LANCZOS)
        (folder / f"face{suffix}-hd.rgb").write_bytes(img.tobytes())
        print(f"  face{suffix}-hd.rgb {a.size}x{a.size}")

    scene = folder / "scene.png"
    if scene.exists():
        src = Image.open(scene).convert("RGB")
        h = round(src.height * a.width / src.width)
        (folder / "scene-hd.rgb").write_bytes(src.resize((a.width, h), Image.LANCZOS).tobytes())
        hd["sceneWidth"], hd["sceneHeight"] = a.width, h
        print(f"  scene-hd.rgb {a.width}x{h}")
    hd_path.write_text(json.dumps(hd) + "\n")


names = sorted(d.name for d in (ROOT / "personas").iterdir() if (d / "portrait.png").exists()) if a.all else a.personas
for name in names:
    bake(name)
