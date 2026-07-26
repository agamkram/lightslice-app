#!/usr/bin/env python3
"""Generate LightSlice home-screen icons (spectrum + selection band motif)."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
BG = (10, 14, 20)


def wavelength_rgb(nm: float) -> tuple[int, int, int]:
    r = g = b = 0.0
    if 380 <= nm < 440:
        r = -(nm - 440) / (440 - 380)
        b = 1.0
    elif 440 <= nm < 490:
        g = (nm - 440) / (490 - 440)
        b = 1.0
    elif 490 <= nm < 510:
        g = 1.0
        b = -(nm - 510) / (510 - 490)
    elif 510 <= nm < 580:
        r = (nm - 510) / (580 - 510)
        g = 1.0
    elif 580 <= nm < 645:
        r = 1.0
        g = -(nm - 645) / (645 - 580)
    elif 645 <= nm <= 780:
        r = 1.0

    factor = 0.0
    if 380 <= nm < 420:
        factor = 0.3 + 0.7 * (nm - 380) / 40
    elif 420 <= nm < 701:
        factor = 1.0
    elif 701 <= nm <= 780:
        factor = 0.3 + 0.7 * (780 - nm) / 80

    gamma = 0.8

    def to(c: float) -> int:
        return int(round(255 * (max(0.0, min(1.0, c * factor)) ** gamma)))

    return to(r), to(g), to(b)


def build_icon(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size), BG)
    px = img.load()

    # dark field with soft radial glow
    cx = cy = size / 2
    for y in range(size):
        for x in range(size):
            dx = (x - cx) / size
            dy = (y - cy) / size
            d = math.sqrt(dx * dx + dy * dy)
            v = max(0.0, 1.0 - d * 1.6)
            px[x, y] = (
                int(10 + v * 18),
                int(14 + v * 22),
                int(20 + v * 28),
            )

    # full EM-ish band across middle
    band_y0 = int(size * 0.42)
    band_y1 = int(size * 0.58)
    for x in range(size):
        t = x / max(1, size - 1)
        # map x to pseudo-spectrum: left cool dark, center rainbow, right dark
        if t < 0.28:
            col = (30, 58, 95)
        elif t < 0.36:
            col = (124, 45, 18)
        elif t < 0.64:
            u = (t - 0.36) / 0.28
            nm = 400 + u * 300
            col = wavelength_rgb(nm)
        elif t < 0.74:
            col = (76, 29, 149)
        else:
            col = (31, 41, 55)
        for y in range(band_y0, band_y1):
            px[x, y] = col

    base = img.convert("RGBA")
    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)

    # selection bracket on visible region
    x0, x1 = int(size * 0.42), int(size * 0.56)
    od.rectangle((x0, band_y0, x1, band_y1), outline=(250, 204, 21, 230), width=max(2, size // 90))
    mid = (x0 + x1) // 2
    od.line((mid, band_y0 - size * 0.04, mid, band_y1 + size * 0.04), fill=(250, 204, 21, 200), width=max(2, size // 128))

    # reticle motif
    rx, ry = int(size * 0.72), int(size * 0.28)
    rr = max(8, size // 14)
    od.ellipse((rx - rr, ry - rr, rx + rr, ry + rr), outline=(61, 156, 245, 220), width=max(2, size // 100))
    od.line((rx - rr * 1.6, ry, rx - rr * 0.45, ry), fill=(61, 156, 245, 200), width=max(2, size // 120))
    od.line((rx + rr * 0.45, ry, rx + rr * 1.6, ry), fill=(61, 156, 245, 200), width=max(2, size // 120))
    od.line((rx, ry - rr * 1.6, rx, ry - rr * 0.45), fill=(61, 156, 245, 200), width=max(2, size // 120))
    od.line((rx, ry + rr * 0.45, rx, ry + rr * 1.6), fill=(61, 156, 245, 200), width=max(2, size // 120))

    base = Image.alpha_composite(base, overlay)

    vignette = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    vd = ImageDraw.Draw(vignette)
    pad = int(size * 0.06)
    vd.rounded_rectangle(
        (pad, pad, size - pad, size - pad),
        radius=size // 8,
        outline=(61, 156, 245, 160),
        width=max(2, size // 64),
    )
    base = Image.alpha_composite(base, vignette)

    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse(
        (size * 0.2, size * 0.2, size * 0.8, size * 0.8),
        fill=(61, 156, 245, 24),
    )
    base = Image.alpha_composite(
        base, glow.filter(ImageFilter.GaussianBlur(radius=size // 18))
    )
    return base.convert("RGB")


def save_icons() -> None:
    icon_512 = build_icon(512)
    icon_512.save(ROOT / "icon-512.png", "PNG")
    icon_180 = icon_512.resize((180, 180), Image.Resampling.LANCZOS)
    icon_180.save(ROOT / "apple-touch-icon.png", "PNG")
    print(f"Wrote {ROOT / 'icon-512.png'}")
    print(f"Wrote {ROOT / 'apple-touch-icon.png'}")


if __name__ == "__main__":
    save_icons()
