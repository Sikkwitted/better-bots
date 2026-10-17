"""Generate web/avatars from the 3D renders.

One render per body x character, teal, on transparency, in
tools/avatars/3d/<shape>/<style>.png. The builder splits each render into body
(the teal), eyes (the two dark ellipses inside it), hair, and the other
accessories, recolours the body to every palette colour under the render's own
light, and writes one static face per shape x style x colour (and a white-haired
one where the character has hair). The console animates thinking and typing in CSS.

    pip install pillow numpy
    python3 tools/avatars/build_avatars.py
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = ROOT / "tools/avatars/3d"
OUTPUT_DIR = ROOT / "web/avatars"

SHAPES = ["round", "blob", "square", "oval", "triangle", "droplet"]
# Must match web/avatar.js; test/avatar.test.js pins COLORS.
STYLES = ["crown", "glasses", "monocle", "hair", "pencil", "headset", "plain", "cap"]
COLORS = ["#51FFCD", "#37FF5D", "#F5FF32", "#FF8234", "#FEDE8D", "#E1FFF3", "#B5B5B5", "#000000", "#FE3E51"]
HAIR_STYLES = ["hair", "pencil", "monocle", "glasses", "headset"]   # get a -white variant

CANVAS = 192
BODY_WIDTH = 122          # the body's width on the canvas, whatever sits on it
BODY_CENTRE_Y = 106       # a little below centre, so crowns have headroom
WORK = 384                # recolour at 2x, then downsample: cleaner edges

# The render's teal, mid-tone, as the reference the shading is measured against.
TEAL_REF = np.array([72, 217, 182], dtype=np.float32)
TEAL_HUE = 0.46
LUM = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def hex_rgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)


def luminance(rgb):
    return rgb @ LUM


# ------------------------------------------------------------------ separate

def hls(rgb):
    """Hue [0,1), lightness, saturation for an (..., 3) float array in 0..255."""
    r, g, b = rgb[..., 0] / 255, rgb[..., 1] / 255, rgb[..., 2] / 255
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    l = (mx + mn) / 2
    d = mx - mn
    s = np.where(d == 0, 0, d / (1 - np.abs(2 * l - 1) + 1e-6))
    m = d > 0
    rc = np.where(m, (mx - r) / (d + 1e-6), 0)
    gc = np.where(m, (mx - g) / (d + 1e-6), 0)
    bc = np.where(m, (mx - b) / (d + 1e-6), 0)
    h = np.where(mx == r, bc - gc, np.where(mx == g, 2 + rc - bc, 4 + gc - rc))
    return (h / 6) % 1, l, s


def components(mask):
    """Label 4-connected components of a boolean mask -> (labels, count)."""
    labels = np.zeros(mask.shape, dtype=np.int32)
    h, w = mask.shape
    n = 0
    stack = []
    for y, x in zip(*np.nonzero(mask)):
        if labels[y, x]:
            continue
        n += 1
        labels[y, x] = n
        stack.append((y, x))
        while stack:
            cy, cx = stack.pop()
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and labels[ny, nx] == 0:
                    labels[ny, nx] = n
                    stack.append((ny, nx))
    return labels, n


def _step(mask, grow_, square):
    """One pixel of erosion or dilation, by a 3x3 square or a plus."""
    pad = np.pad(mask, 1, constant_values=False)
    h, w = mask.shape
    shifts = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if square or dy == 0 or dx == 0]
    out = mask.copy()
    for dy, dx in shifts:
        moved = pad[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
        out = out | moved if grow_ else out & moved
    return out


def erode(mask, radius):
    """Erode by an octagon of `radius`: square and plus steps in turn, close to a disk."""
    for i in range(radius):
        mask = _step(mask, False, i % 2 == 0)
    return mask


def dilate(mask, radius):
    for i in range(radius):
        mask = _step(mask, True, i % 2 == 0)
    return mask


def grow(labels, within, limit):
    """Spread each label through `within`, at most `limit` pixels, each pixel to the
    label nearest it along the way (a geodesic Voronoi)."""
    labels = labels.copy()
    for _ in range(limit):
        spread = labels.copy()
        for axis, step in ((0, 1), (0, -1), (1, 1), (1, -1)):
            shifted = np.roll(labels, step, axis=axis)
            edge = [slice(None)] * 2
            edge[axis] = 0 if step == 1 else -1
            shifted[tuple(edge)] = 0
            take = (spread == 0) & within & (shifted > 0)
            spread[take] = shifted[take]
        if (spread == labels).all():
            break
        labels = spread
    return labels


def headset_band(rgb, a, ink, body_w):
    """The headset band and the two ear cups. The band is the same near-black as
    the hair and lies across it, so it is found by shape: an arch from one cup to
    the other. Fit an ellipse to its outer edge where it crosses the top of the
    head, and take the band's thickness inward from that edge."""
    hue, light, sat = hls(rgb)
    cream = (a > 0.5) & (hue > 0.04) & (hue < 0.2) & (sat > 0.15) & (light > 0.55)
    labels, n = components(cream)
    cups = sorted(range(1, n + 1), key=lambda i: np.count_nonzero(labels == i))[-2:]
    if len(cups) < 2:
        raise ValueError("headset: expected two ear cups")
    ends = sorted((np.nonzero(labels == i)[1].mean(), np.nonzero(labels == i)[0].min()) for i in cups)
    (xl, top_l), (xr, top_r) = ends
    xc, span = (xl + xr) / 2, xr - xl
    solid = (a > 0.5) & (body_w < 0.5)
    h, w = ink.shape
    edge, runs = [], []
    for x in range(int(xl + 0.15 * span), int(xr - 0.15 * span)):
        filled = np.nonzero(solid[:, x])[0]
        if not len(filled):
            continue
        y = y0 = filled.min()
        while y < h and solid[y, x]:
            y += 1
        edge.append((x, y0))
        runs.append(y - y0)
    # Where the band rests on the hair a run is band and hair together; the band
    # alone is the most common run length.
    runs = np.array(runs)
    usable = runs[(runs > 0.03 * span) & (runs < 0.12 * span)]
    counts, bins = np.histogram(usable, bins=np.arange(0.03 * span, 0.12 * span, 3))
    thickness = bins[counts.argmax()] + 1.5
    # Ellipse centred between the cups: ((x-xc)/A)^2 + ((y-yc)/B)^2 = 1, best yc by search.
    edge = np.array(edge, dtype=np.float64)
    best = None
    for yc in np.linspace(min(top_l, top_r) - 0.3 * span, max(top_l, top_r) + 0.3 * span, 80):
        m = np.stack([(edge[:, 0] - xc) ** 2, (edge[:, 1] - yc) ** 2], axis=1)
        k = np.linalg.lstsq(m, np.ones(len(edge)), rcond=None)[0]
        if (k <= 0).any():
            continue
        err = np.abs(m @ k - 1).mean()
        if best is None or err < best[0]:
            best = (err, yc, 1 / np.sqrt(k[0]), 1 / np.sqrt(k[1]))
    _, yc, ax, ay = best
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
    u, v = (xs - xc) / ax, (ys - yc) / ay
    r = np.sqrt(u * u + v * v) + 1e-9
    inward = (1 - r) / (np.sqrt((u / ax) ** 2 + (v / ay) ** 2) / r)   # distance in from the outer edge
    band = ink & (inward > -3) & (inward < thickness + 3) & (ys < max(top_l, top_r) + thickness)
    return band, np.isin(labels, cups)


class Parts:
    """A render split into layers at source resolution, placed on the working canvas."""

    def __init__(self, source, style):
        src = Image.open(source).convert("RGBA")
        src = src.crop(src.getbbox())
        rgba = np.asarray(src, dtype=np.float32)
        rgb, a = rgba[..., :3], rgba[..., 3] / 255
        hue, light, sat = hls(rgb)
        opaque = a > 0.5
        # Body: the teal. Soft weight so anti-aliased edges recolour partially.
        hue_d = np.minimum(np.abs(hue - TEAL_HUE), 1 - np.abs(hue - TEAL_HUE))
        body_w = np.clip(1 - hue_d / 0.09, 0, 1) * np.clip((sat - 0.2) / 0.25, 0, 1) * np.clip((light - 0.12) / 0.1, 0, 1)
        body_w = np.where(opaque, body_w, 0)
        # Teal the body bounces onto hair, frames and bands, and the body's own soft
        # edge: recoloured with the body, or it shows as a teal fringe on any other fill.
        self.teal = np.clip(1 - hue_d / 0.09, 0, 1) * np.clip((sat - 0.15) / 0.2, 0, 1)

        # Eyes: thick dark blobs surrounded by body. Glasses frames and a monocle
        # ring can touch them, so thin dark lines are shaved off before looking.
        dark = opaque & (light < 0.2) & (body_w < 0.5)
        ys, xs = np.nonzero(body_w > 0.5)
        bx0, bx1, by0, by1 = xs.min(), xs.max(), ys.min(), ys.max()
        bw = bx1 - bx0
        shave = max(2, round(0.02 * bw))
        labels, n = components(erode(dark, shave))
        blobs = []
        for i in range(1, n + 1):
            m = labels == i
            cy, cx = np.nonzero(m)
            hgt, wid = cy.max() - cy.min() + 2 * shave, cx.max() - cx.min() + 2 * shave
            if not (0.03 * bw < wid < 0.22 * bw and 0.05 * bw < hgt < 0.32 * bw and hgt > wid * 0.9):
                continue
            # Inside the body: the row through the middle hits teal on both sides.
            row = int(cy.mean())
            if (body_w[row, :cx.min()] > 0.5).any() and (body_w[row, cx.max() + 1:] > 0.5).any():
                blobs.append((m, len(cy), cx.mean(), cy.mean()))
        # Bits of frame or chain can pass too; the eyes are the best-matched pair,
        # side by side, the same size, on one line.
        def mismatch(p, q):
            if abs(p[2] - q[2]) < 0.15 * bw:
                return float("inf")
            return abs(p[1] - q[1]) / max(p[1], q[1]) + 4 * abs(p[3] - q[3]) / bw
        pairs = [(mismatch(p, q), p, q) for i, p in enumerate(blobs) for q in blobs[i + 1:]]
        best = min(pairs, key=lambda t: t[0], default=None)
        cores = np.zeros_like(dark)
        self.eye_count = 0
        if best and best[0] < 1:
            cores = best[1][0] | best[2][0]
            self.eye_count = 2
        eye = dark & dilate(cores, shave + 1)
        eye_rows = np.nonzero(eye.any(axis=1))[0]

        self.hair = self._hair(rgb, a, body_w, eye, hue, light, sat, eye_rows, bw, style)

        # Geometry on the canvas: body width fixed, centre from the body's box,
        # treating it as a sphere so a cap on top does not move it.
        self.scale = (WORK / CANVAS) * BODY_WIDTH / bw
        cx_src = (bx0 + bx1) / 2
        cy_src = by1 - bw / 2
        self.offset = (WORK / 2 - cx_src * self.scale, (WORK / CANVAS) * BODY_CENTRE_Y - cy_src * self.scale)

        self.rgb, self.alpha = rgb, a
        self.body_w, self.eye = body_w, eye
        self.shade = luminance(rgb) / luminance(TEAL_REF)          # the render's light, per pixel

    def _hair(self, rgb, a, body_w, eye, hue, light, sat, eye_rows, bw, style):
        """The hair, highlights and all. It is the same near-black as glasses frames,
        so it is told apart by shape: shave off everything thin, keep the thick
        pieces above the eyes, then grow them back a short way along the grey, each
        pixel going to whichever piece is nearest. A headset band is fitted first
        and left out."""
        eyes_top = eye_rows.min()
        ink = (a > 0) & (body_w < 0.5) & ~eye & (
            ((sat < 0.35) & (light < 0.7)) | ((hue > 0.40) & (hue < 0.72) & (light < 0.5)))
        self.ink = ink
        # Pieces of grey the hair must not take: near the eyes, and a headset.
        keep_off = dilate(eye, max(2, round(0.03 * bw)))
        if style == "headset":
            band, cups = headset_band(rgb, a, ink, body_w)
            ink = ink & ~band
            keep_off |= dilate(band | cups, 3)
        labels, n = components(erode(ink, max(2, round(0.03 * bw))))
        hair_ids = []
        for i in range(1, n + 1):
            ys, xs = np.nonzero(labels == i)
            # Hair starts well above the eyes; ear cups and the band's ends do not,
            # and frames and a monocle ring are too thin to be left at all.
            if len(ys) >= 0.005 * bw * bw and ys.min() < eyes_top - 0.2 * bw and ys.mean() < eyes_top:
                hair_ids.append(i)
        # Out to the shaved edge and the strand tips, but not along a band or frame.
        grown = grow(labels, ink & ~keep_off, round(0.11 * bw))
        hair = np.isin(grown, hair_ids)
        # Locks at the sides and behind the head are left over, cut off from the
        # rest by the head in front of them: grey beside the hair and off to the
        # side of the eyes is hair too, as is a fleck above them. Frames and a
        # monocle are larger and reach across an eye.
        eye_cols = np.nonzero(eye.any(axis=0))[0]
        beside = dilate(hair, max(2, round(0.02 * bw)))
        rest, n = components(ink & ~hair)
        for i in np.unique(rest[beside]):
            piece = rest == i
            cols = np.nonzero(piece.any(axis=0))[0]
            across = cols.min() <= eye_cols.max() and cols.max() >= eye_cols.min()
            fleck = np.count_nonzero(piece) < 0.003 * bw * bw and np.nonzero(piece)[0].max() < eyes_top
            if i and (fleck or not across) and not (piece & keep_off).any():
                hair |= piece
        # The render's warm rim light catches the hair's edge in peach; it goes with
        # the hair. A pencil or an ear cup is a larger warm piece and stays.
        warm = (a > 0) & (body_w < 0.5) & ~eye & ~ink & ((hue < 0.17) | (hue > 0.95))
        rest, n = components(warm)
        for i in range(1, n + 1):
            if np.count_nonzero(rest == i) >= 0.015 * bw * bw:
                keep_off |= dilate(rest == i, 3)
        hair |= warm & dilate(hair, max(2, round(0.02 * bw))) & ~keep_off
        return hair

    def place(self, img: Image.Image) -> Image.Image:
        """Scale to working resolution and place on the working canvas."""
        w, h = img.size
        scaled = img.resize((max(1, round(w * self.scale)), max(1, round(h * self.scale))), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (WORK, WORK), (0, 0, 0, 0))
        canvas.alpha_composite(scaled, (round(self.offset[0]), round(self.offset[1])))
        return canvas


# ------------------------------------------------------------------- colour

def render(parts: Parts, fill: str, hair: str = "dark") -> Image.Image:
    target = hex_rgb(fill)
    dark_fill = luminance(target) < 80
    s = parts.shade[..., None]

    # Body: the target colour under the render's light. A dark body gets its
    # form from gloss, not shade, so highlights are added rather than scaled.
    if dark_fill:
        base = np.maximum(target, 26)                       # black reads as black, not as a hole
        body = base * np.clip(s, 0.55, 1.0) + np.clip(s - 0.95, 0, 1) ** 1.2 * 170
    else:
        body = target * s
        # Light fills clip to white too easily; ease the top end.
        body = np.where(body > 235, 235 + (body - 235) * 0.35, body)
    body = np.clip(body, 0, 255)

    # Accessories keep their own colours, except that the teal the render's body
    # bounced onto them becomes the new body's colour.
    drawn = parts.rgb + (body - parts.rgb) * parts.teal[..., None]
    acc = drawn
    if dark_fill:
        # Near-black hair, frames and bands lift to charcoal so they stay distinct
        # from a black body; an even lift keeps their highlights where they were.
        acc = np.where(parts.ink[..., None], drawn * 0.8 + 50, acc)
    if hair == "white":
        # Map the hair's own light onto white: shadow stays grey, gloss goes brightest.
        white = 178 + luminance(drawn)[..., None] * 0.85
        white = np.where(white > 245, 245 + (white - 245) * 0.4, white)
        acc = np.where(parts.hair[..., None], white * np.array([0.98, 0.99, 1.0]), acc)

    # Eyes: the render's dark ellipses, or light ones on a dark body.
    if dark_fill:
        eye_rgb = np.broadcast_to(np.array([250, 255, 255], dtype=np.float32), parts.rgb.shape) \
            * np.clip(0.99 + s * 0.04, 0.99, 1.02)
    else:
        eye_rgb = np.broadcast_to(np.array([20, 16, 36], dtype=np.float32), parts.rgb.shape) \
            * np.clip(s * 0.5 + 0.6, 0.7, 1.15)

    a, w, eye = parts.alpha, parts.body_w, parts.eye

    def layer(rgb, alpha):
        out = np.concatenate([np.clip(rgb, 0, 255), (np.clip(alpha, 0, 1) * 255)[..., None]], axis=-1).astype(np.uint8)
        return parts.place(Image.fromarray(out))

    frame = Image.new("RGBA", (WORK, WORK), (0, 0, 0, 0))
    frame.alpha_composite(layer(body, a * w * ~eye))
    frame.alpha_composite(layer(body, a * eye))              # the body continued behind the eyes
    if dark_fill:
        # On a dark body the eyes glow: a soft white halo under them.
        halo = layer(np.broadcast_to(np.array([230, 250, 255], dtype=np.float32), parts.rgb.shape), a * eye)
        halo = halo.filter(ImageFilter.GaussianBlur(WORK / 36))
        r, g, b, ga = halo.split()
        frame.alpha_composite(Image.merge("RGBA", (r, g, b, ga.point(lambda v: min(255, int(v * 1.6))))))
    frame.alpha_composite(layer(eye_rgb, a * eye))
    frame.alpha_composite(layer(acc, a * (1 - w) * ~eye))
    return frame.resize((CANVAS, CANVAS), Image.Resampling.LANCZOS)


def build() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUTPUT_DIR.glob("avatar-*"):
        old.unlink()
    written = 0
    for shape in SHAPES:
        for style in STYLES:
            parts = Parts(SOURCE_DIR / shape / f"{style}.png", style)
            if parts.eye_count != 2:
                raise ValueError(f"{shape}/{style}: found {parts.eye_count} eyes, expected 2")
            for fill in COLORS:
                hairs = ["dark", "white"] if style in HAIR_STYLES else ["dark"]
                for hair in hairs:
                    suffix = "-white" if hair == "white" else ""
                    render(parts, fill, hair).save(OUTPUT_DIR / f"avatar-{shape}-{style}-{fill.lstrip('#')}{suffix}.png", optimize=True)
                    written += 1
        print(f"{shape}: ok")
    return written


if __name__ == "__main__":
    print(f"wrote {build()} faces to {OUTPUT_DIR.relative_to(ROOT)}")
