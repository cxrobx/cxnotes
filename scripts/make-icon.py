#!/usr/bin/env python3
"""Generate the CXNotes app icon.

Drawn rather than exported so the icon is reproducible and stays byte-identical
across rebuilds.

Geometry is **inherited from** `cxtasks/scripts/make-icon.py`, which in turn
measured it from `cxmail/src-tauri/icons/128x128@2x.png`, so all three icons sit
together in the Dock as a family:

    canvas          transparent; the tile does NOT bleed to the edge
    tile            80.5% of the canvas, symmetric margins
    tile corner     superellipse, n = 5.5 — Apple's squircle. A plain rounded
                    rectangle is visibly wrong: cxmail's corner insets measure
                    50/33/23/14/7/3/1 at dy=0/2/5/10/20/30/40 from the top,
                    where a circular arc of the same radius would give
                    50/…/20/10/… — the real corner is squarer for longer.
    object          74.8% x 45.6% of the tile, aspect 1.64, dead-centred
    tile fill       vertical gradient #34343A → #25252A
    object fill     #F3F3F3 with #2A2A2F detail
    accent          exactly one, spent once

cxmail's object is an envelope; cxtasks' is a task card with a green check.
Ours is a recording card: a red record dot on the left, a level-meter waveform
on the right.

**Why a waveform and not another check-like mark.** At 16px the whole card is
about 10 x 6 px, so interior detail survives only as silhouette. A third white
card carrying a small coloured mark would be indistinguishable from cxtasks in
the Dock. The waveform's broken vertical rhythm is the one interior treatment
that still reads as a different *shape* once the detail dissolves — hence few
bars (5) with strong height variation rather than a dense equaliser, which
averages to a grey smear when downsampled.

Flat tile + flat object throughout: no gloss, bevel, drop shadow or inner
highlight. (cxmail's generator has some — it is the older one; cxtasks is the
canon.)

Unlike Tauri, electron-builder applies no mask of its own to the macOS icon, so
the squircle and its transparent margin are baked into the PNG here.

Usage: python3 scripts/make-icon.py
"""

from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ASSETS = Path(__file__).resolve().parent.parent / "assets"

TILE_TOP = (0x34, 0x34, 0x3A)
TILE_BOTTOM = (0x25, 0x25, 0x2A)
OBJECT = (0xF3, 0xF3, 0xF3)
DETAIL = (0x2A, 0x2A, 0x2F)
ACCENT = (0xE5, 0x48, 0x4D)  # record red — the single accent

# Inherited from cxtasks, as fractions so they scale to any canvas.
TILE_FRAC = 206 / 256      # tile edge / canvas
CARD_W_FRAC = 154 / 206    # card width / tile
CARD_H_FRAC = 94 / 206     # card height / tile
SQUIRCLE_N = 5.5

# Card-local layout, as fractions of the card box.
DOT_CX = 0.190             # record dot centre, x
DOT_R = 0.165              # record dot radius, as a fraction of card HEIGHT
BAR_X0 = 0.365             # first bar, left edge
BAR_W = 0.062              # bar width
BAR_GAP = 0.055            # gap between bars
BAR_HEIGHTS = (0.30, 0.76, 0.48, 0.62, 0.26)  # as fractions of card height

SS = 6  # supersampling — PIL has no AA, so draw big and downsample


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def squircle_points(cx: float, cy: float, a: float, n: float, steps: int = 1440):
    """Superellipse |x/a|^n + |y/a|^n = 1, as a polygon."""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        x = a * math.copysign(abs(ct) ** (2 / n), ct)
        y = a * math.copysign(abs(st) ** (2 / n), st)
        pts.append((cx + x, cy + y))
    return pts


def draw_icon(size: int) -> Image.Image:
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # ── tile ──────────────────────────────────────────────────────────────
    tile = S * TILE_FRAC
    c = S / 2
    a = tile / 2

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).polygon(squircle_points(c, c, a, SQUIRCLE_N), fill=255)

    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    top, bottom = c - a, c + a
    for y in range(int(top), int(bottom) + 1):
        t = (y - top) / max(1.0, bottom - top)
        gd.line([(0, y), (S, y)], fill=lerp(TILE_TOP, TILE_BOTTOM, t) + (255,))
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)

    # ── card ──────────────────────────────────────────────────────────────
    cw = tile * CARD_W_FRAC
    ch = tile * CARD_H_FRAC
    x0, y0 = c - cw / 2, c - ch / 2
    d.rounded_rectangle(
        (x0, y0, x0 + cw, y0 + ch), radius=ch * 0.14, fill=OBJECT
    )

    # ── record dot (left) ─────────────────────────────────────────────────
    dot_r = ch * DOT_R
    dot_x, dot_y = x0 + cw * DOT_CX, y0 + ch * 0.5
    d.ellipse(
        (dot_x - dot_r, dot_y - dot_r, dot_x + dot_r, dot_y + dot_r), fill=ACCENT
    )

    # ── waveform (right) ──────────────────────────────────────────────────
    # Bars are centred on the card's midline and capped with a radius of half
    # their width, matching the cxtasks ruled lines.
    bw = cw * BAR_W
    for i, h_frac in enumerate(BAR_HEIGHTS):
        bx = x0 + cw * (BAR_X0 + i * (BAR_W + BAR_GAP))
        bh = ch * h_frac
        by = y0 + (ch - bh) / 2
        d.rounded_rectangle((bx, by, bx + bw, by + bh), radius=bw / 2, fill=DETAIL)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)

    # electron-builder reads this one (package.json → build.mac.icon).
    draw_icon(1024).save(ASSETS / "icon.png")
    print("  icon.png (1024x1024)")

    if shutil.which("iconutil") is None:
        print("WARNING: iconutil not found — icon.icns was not regenerated")
        return

    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for base in (16, 32, 128, 256, 512):
            draw_icon(base).save(iconset / f"icon_{base}x{base}.png")
            draw_icon(base * 2).save(iconset / f"icon_{base}x{base}@2x.png")
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(ASSETS / "icon.icns")],
            check=True,
        )
        print("  icon.icns")


if __name__ == "__main__":
    main()
