"""Generate rounded-corner PNG, ICO, and ICNS icons from icon-source.png.

Windows 11 app-icon style: squircle-ish rounded corners (~22% radius),
anti-aliased via supersampling, subtle top highlight for depth.
"""
from io import BytesIO
from pathlib import Path
from PIL import Image, ImageDraw

BUILD_DIR = Path(__file__).resolve().parent
# Always read from the untouched square source; outputs never overwrite it
SRC = BUILD_DIR / "icon-source.png"

MASTER_SIZE = 1024
CORNER_RATIO = 0.22
SS = 4  # supersample factor for clean corner AA

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
ICNS_ENTRIES = [
    ("icp4", 16),
    ("ic11", 32),
    ("icp5", 32),
    ("ic12", 64),
    ("icp6", 64),
    ("ic07", 128),
    ("ic13", 256),
    ("ic08", 256),
    ("ic14", 512),
    ("ic09", 512),
    ("ic10", 1024),
]


def rounded_mask(size: int, radius: int) -> Image.Image:
    big = Image.new("L", (size * SS, size * SS), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, size * SS - 1, size * SS - 1),
        radius=radius * SS,
        fill=255,
    )
    return big.resize((size, size), Image.LANCZOS)


def top_highlight(size: int, mask: Image.Image) -> Image.Image:
    """Subtle white gradient on top half, clipped to rounded mask."""
    hl = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(hl)
    half = size // 2
    for i in range(half):
        alpha = int(30 * (1 - i / half) ** 2)
        d.rectangle((0, i, size, i + 1), fill=(255, 255, 255, alpha))
    clipped = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    clipped.paste(hl, (0, 0), mask=mask)
    return clipped


def inner_border(size: int, radius: int) -> Image.Image:
    b = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    ImageDraw.Draw(b).rounded_rectangle(
        (SS, SS, size * SS - SS - 1, size * SS - SS - 1),
        radius=(radius - 1) * SS,
        outline=(255, 255, 255, 55),
        width=SS * 2,
    )
    return b.resize((size, size), Image.LANCZOS)


def render_icon(size: int, with_polish: bool) -> Image.Image:
    """Rounded icon at given size."""
    base = (
        Image.open(SRC)
        .convert("RGBA")
        .resize((size, size), Image.LANCZOS)
    )
    radius = max(2, int(size * CORNER_RATIO))
    mask = rounded_mask(size, radius)

    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask=mask)

    if with_polish:
        out = Image.alpha_composite(out, top_highlight(size, mask))
        out = Image.alpha_composite(out, inner_border(size, radius))

    return out


def png_bytes(image: Image.Image) -> bytes:
    buf = BytesIO()
    image.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def write_icns(path: Path):
    chunks = []
    for kind, size in ICNS_ENTRIES:
        image = render_icon(size, with_polish=(size >= 48))
        data = png_bytes(image)
        chunks.append(kind.encode("ascii") + (len(data) + 8).to_bytes(4, "big") + data)

    body = b"".join(chunks)
    path.write_bytes(b"icns" + (len(body) + 8).to_bytes(4, "big") + body)


def main():
    # Large clean PNG for BrowserWindow (512) with polish
    big = render_icon(512, with_polish=True)
    big.save(BUILD_DIR / "icon.png", "PNG", optimize=True)
    print(f"wrote icon.png 512x512")

    ref = render_icon(256, with_polish=True)
    ref.save(BUILD_DIR / "icon-256-rounded.png", "PNG", optimize=True)
    print(f"wrote icon-256-rounded.png 256x256")

    # Multi-resolution ico. Small sizes (<=32) skip polish (too noisy).
    icons = []
    for s in ICO_SIZES:
        icons.append(render_icon(s, with_polish=(s >= 48)))

    ico = BUILD_DIR / "icon.ico"
    icons[-1].save(
        ico,
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=icons[:-1],
    )
    print(f"wrote icon.ico sizes={ICO_SIZES}")

    header = BUILD_DIR / "installerHeaderIcon.ico"
    icons[-1].save(
        header,
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=icons[:-1],
    )
    print(f"wrote installerHeaderIcon.ico")

    icns = BUILD_DIR / "icon.icns"
    write_icns(icns)
    print(f"wrote icon.icns sizes={[s for _, s in ICNS_ENTRIES]}")


if __name__ == "__main__":
    main()
