#!/usr/bin/env -S uv run --with pillow --script
"""Generates the PWA app icons. Run once; re-run only if the look changes."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BG_TOP, BG_BOT = (255, 92, 138), (214, 51, 108)
GLYPH = "说"          # "speak"
CJK_FONTS = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
]


def font_at(size: int):
    for path in CJK_FONTS:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def draw_icon(size: int, *, shape: str) -> Image.Image:
    """shape: "rounded" (own corners), "square" (full-bleed), "maskable"
    (full-bleed, content kept inside the inner 80% safe zone)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Vertical gradient background.
    for y in range(size):
        t = y / max(1, size - 1)
        d.line(
            [(0, y), (size, y)],
            fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOT)) + (255,),
        )

    if shape == "rounded":
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, size - 1, size - 1], radius=int(size * 0.225), fill=255
        )
        img.putalpha(mask)

    scale = 0.44 if shape == "maskable" else 0.58
    f = font_at(int(size * scale))
    box = ImageDraw.Draw(img).textbbox((0, 0), GLYPH, font=f)
    x = (size - (box[2] - box[0])) / 2 - box[0]
    y = (size - (box[3] - box[1])) / 2 - box[1]
    ImageDraw.Draw(img).text((x, y), GLYPH, font=f, fill=(255, 255, 255, 255))
    return img


for size in (192, 512):
    draw_icon(size, shape="rounded").save(OUT / f"icon-{size}.png")

draw_icon(512, shape="maskable").save(OUT / "icon-maskable-512.png")

# iOS applies its own rounded mask to the home-screen icon and composites the
# result over black. A rounded icon with transparent corners therefore shows
# black wedges inside Apple's mask, so this one must be square and fully
# opaque -- RGB, no alpha channel at all.
draw_icon(180, shape="square").convert("RGB").save(OUT / "apple-touch-icon.png")

print(f"Wrote {len(list(OUT.glob('*.png')))} icons to {OUT.relative_to(ROOT)}")
