"""Shared by bake.py and bake_hd.py: lay an edited portrait frame over the original."""
import numpy as np
from PIL import Image


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
