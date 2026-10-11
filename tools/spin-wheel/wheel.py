#!/usr/bin/env python3
"""TCGQuestlog "spin the wheel" clip generator.

Renders one vertical MP4 per cat in which a wheel of cat faces spins and
lands on that cat, in two styles:

  full   brand background (navy + purple glow)
  green  pure #00FF00 background for CapCut Chroma Key

Usage:
  python wheel.py                      # all cats, both styles
  python wheel.py --cat Luna           # just one cat
  python wheel.py --style green        # full | green | both
  python wheel.py --preview            # save still frames only, no encoding
  python wheel.py --placeholders       # create test images for missing photos
"""

import argparse
import json
import math
import multiprocessing as mp
import random
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

HERE = Path(__file__).resolve().parent
FONTS_DIR = HERE / "fonts"

# Design system
NAVY = (15, 15, 26)        # #0f0f1a
PURPLE = (108, 99, 255)    # #6c63ff
ACCENT = (167, 139, 250)   # #a78bfa
GOLD = (240, 192, 64)      # #f0c040
WHITE = (255, 255, 255)
CHROMA = (0, 255, 0)       # #00ff00
# Used only for the last slice when the cat count is odd, so two slices of
# the same colour never touch.
MID = tuple((a + b) // 2 for a, b in zip(PURPLE, ACCENT))

DEFAULT_SETTINGS = {
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "idle_seconds": 0.3,
    "spin_seconds": 3.5,
    "reveal_seconds": 1.2,
    "rotations": 5,
    "easing": "quint",            # quint | cubic
    "max_offset": 0.35,           # max landing offset, as a fraction of slice width
    "seed": None,                 # set a number for repeatable spins
    "reveal_title": "TODAY'S VICTIM:",
    "watermark": True,
    "watermark_text": "tcgquestlog.com",
    "motion_blur": True,
    "confetti": True,
    "pointer_tick": True,
    "green_despill_photos": True,  # remove green tints from photos in the green version
    "cutout_fill": 0.92,           # cut-out heads (transparent PNG/WebP): share of the circle the head fills
    "photo_background": "#ede9fe", # circle colour behind cut-out heads
    "crf": 18,
    "output_dir": "output",
}

# Google Fonts files, keyed by local filename.
FONT_FILES = {
    "Rajdhani-Bold.ttf": ("Rajdhani", 700),
    "Exo2-Bold.ttf": ("Exo 2", 700),
    "Exo2-ExtraBold.ttf": ("Exo 2", 800),
    # Rajdhani and Exo 2 have no Greek or Cyrillic letters; these similar
    # fonts are used automatically for names that need them.
    "FiraSansExtraCondensed-Bold.ttf": ("Fira Sans Extra Condensed", 700),
    "Play-Bold.ttf": ("Play", 700),
}
FALLBACK_FONTS = [
    "DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "Arial Bold.ttf",
    "arialbd.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]


# ---------------------------------------------------------------- fonts

def ensure_fonts(quiet=False):
    """Download the brand fonts into ./fonts/ if they are not there yet."""
    FONTS_DIR.mkdir(exist_ok=True)
    for filename, (family, weight) in FONT_FILES.items():
        dest = FONTS_DIR / filename
        if dest.exists() and dest.stat().st_size > 1000:
            continue
        try:
            css_url = ("https://fonts.googleapis.com/css2?family="
                       f"{family.replace(' ', '+')}:wght@{weight}")
            # A plain user agent makes Google Fonts serve .ttf instead of .woff2.
            req = urllib.request.Request(css_url, headers={"User-Agent": "Mozilla/4.0"})
            css = urllib.request.urlopen(req, timeout=20).read().decode()
            url = re.search(r"url\((https://[^)]+\.ttf)\)", css).group(1)
            data = urllib.request.urlopen(url, timeout=30).read()
            dest.write_bytes(data)
            if not quiet:
                print(f"  downloaded font {filename}")
        except Exception as exc:  # offline, blocked, API changed...
            if not quiet:
                print(f"  ! could not download {family} {weight} ({exc}); using a fallback font")


_font_cache = {}


def load_font(filename, size):
    key = (filename, size)
    if key in _font_cache:
        return _font_cache[key]
    font = None
    for candidate in [FONTS_DIR / filename, *FALLBACK_FONTS]:
        try:
            font = ImageFont.truetype(str(candidate), size)
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default(size=size)
    _font_cache[key] = font
    return font


_glyph_cache = {}


def has_glyphs(filename, text):
    """True if the font has a real glyph for every character in text."""
    font = load_font(filename, 40)
    missing = bytes(font.getmask("\U0010FFFD"))   # what a missing glyph looks like
    for ch in set(text):
        if ch.isspace():
            continue
        key = (filename, ch)
        if key not in _glyph_cache:
            _glyph_cache[key] = bytes(font.getmask(ch)) != missing
        if not _glyph_cache[key]:
            return False
    return True


def heading_font(size, text=""):
    if text and not has_glyphs("Rajdhani-Bold.ttf", text):
        return load_font("FiraSansExtraCondensed-Bold.ttf", size)
    return load_font("Rajdhani-Bold.ttf", size)


def name_font(size, text=""):
    if text and not has_glyphs("Exo2-ExtraBold.ttf", text):
        return load_font("Play-Bold.ttf", size)
    return load_font("Exo2-ExtraBold.ttf", size)


def display_upper(text):
    """Uppercase for the reveal. Greek capitals drop their accent marks
    (Ορέστης -> ΟΡΕΣΤΗΣ), as is standard in Greek all-caps text."""
    decomposed = unicodedata.normalize("NFD", text.upper())
    return unicodedata.normalize("NFC", decomposed.replace("\u0301", "").replace("\u0342", ""))


def text_image(text, font, fill, stroke=0, stroke_fill=NAVY):
    """Render text to a tightly-cropped RGBA image."""
    probe = ImageDraw.Draw(Image.new("L", (1, 1)))
    l, t, r, b = probe.textbbox((0, 0), text, font=font, stroke_width=stroke)
    img = Image.new("RGBA", (r - l + 4, b - t + 4), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((2 - l, 2 - t), text, font=font, fill=fill,
                             stroke_width=stroke, stroke_fill=stroke_fill)
    return img


def fit_font(text, font_fn, max_size, min_size, max_width, stroke_ratio=0.0):
    """Largest font size (down to min_size) where text fits in max_width."""
    probe = ImageDraw.Draw(Image.new("L", (1, 1)))
    size = max_size
    while size > min_size:
        font = font_fn(size, text)
        l, _, r, _ = probe.textbbox((0, 0), text, font=font,
                                    stroke_width=int(size * stroke_ratio))
        if r - l <= max_width:
            break
        size -= 2
    return font_fn(size, text), size


# ---------------------------------------------------------------- photos

def fit_cutout(img, fill, background):
    """For a cut-out head with a transparent background: centre the whole head
    in a square so it fills `fill` of the circle (ears included), on `background`."""
    alpha = img.getchannel("A").point(lambda a: 255 if a > 128 else 0)
    # an opening removes thin whiskers so they don't count toward the head size
    head = alpha.filter(ImageFilter.MinFilter(9)).filter(ImageFilter.MaxFilter(9)).getbbox()
    if head is None:
        head = alpha.getbbox() or (0, 0, img.width, img.height)
    img = img.crop(head)
    w, h = img.size
    side = int(max(w, h) / fill)
    canvas = Image.new("RGBA", (side, side), background + (255,))
    canvas.alpha_composite(img, ((side - w) // 2, min(side - h, (side - h) // 2 + int(side * 0.03))))
    return canvas


def load_photo(path, diameter, center=(0.5, 0.5), despill=False,
               cutout_fill=0.92, background=(237, 233, 254)):
    """Open a photo, fix EXIF rotation, crop to a centred square, circle-mask it."""
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA", "P", "PA"):
        img = img.convert("RGBA")
        if img.getchannel("A").getextrema()[0] < 128:
            img = fit_cutout(img, cutout_fill, background)
        else:
            bg = Image.new("RGBA", img.size, background + (255,))
            img = Image.alpha_composite(bg, img)
    img = img.convert("RGB")
    img = ImageOps.fit(img, (diameter, diameter), Image.LANCZOS, centering=center)
    if despill:
        # Classic green despill: green may never exceed max(red, blue), so no
        # part of a photo can be keyed out by CapCut's chroma key.
        a = np.asarray(img).astype(np.int16)
        a[..., 1] = np.minimum(a[..., 1], np.maximum(a[..., 0], a[..., 2]))
        img = Image.fromarray(a.astype(np.uint8))
    img = img.convert("RGBA")
    img.putalpha(circle_mask(diameter))
    return img


def circle_mask(diameter, ss=4):
    big = Image.new("L", (diameter * ss, diameter * ss), 0)
    ImageDraw.Draw(big).ellipse((0, 0, diameter * ss - 1, diameter * ss - 1), fill=255)
    return big.resize((diameter, diameter), Image.LANCZOS)


# ---------------------------------------------------------------- easing

def ease_out(t, kind):
    t = min(max(t, 0.0), 1.0)
    if kind == "cubic":
        return 1 - (1 - t) ** 3
    return 1 - (1 - t) ** 5


def ease_out_back(t, s=1.9):
    t = min(max(t, 0.0), 1.0) - 1
    return t * t * ((s + 1) * t + s) + 1


# ---------------------------------------------------------------- geometry

def slice_under_pointer(rotation, n):
    """Index of the slice under the top pointer after rotating the wheel
    clockwise by `rotation` degrees (slice i is centred at i*360/n)."""
    sw = 360.0 / n
    pointer_in_wheel = (-rotation) % 360.0
    return int(((pointer_in_wheel + sw / 2) % 360.0) // sw)


def plan_spin(target, n, rotations, max_offset, rng):
    """Pick start and end angles so the wheel lands inside the target slice."""
    sw = 360.0 / n
    start = rng.uniform(0, 360)
    # Off-centre, but never closer than (0.5 - max_offset) of a slice to a border.
    offset = rng.uniform(0.08, max_offset) * sw * rng.choice((-1, 1))
    end_mod = (-(target * sw) + offset) % 360.0
    end = start + rotations * 360.0 + ((end_mod - start) % 360.0)
    assert slice_under_pointer(end, n) == target
    return start, end, offset


# ---------------------------------------------------------------- renderer

class Renderer:
    """Builds the static assets for one style and renders frames from them."""

    def __init__(self, cats, settings, style):
        self.cats = cats
        self.s = settings
        self.style = style
        self.n = len(cats)
        self.W, self.H = settings["width"], settings["height"]
        k = self.W / 1080.0                      # layout scales with width
        self.k = k
        self.R = int(round(480 * k))              # wheel radius
        self.cx, self.cy = self.W // 2, int(round(self.H * 0.552))
        self.hub_r = int(round(72 * k))

        self.background = self._build_background()
        self._bg_rgba = self.background.convert("RGBA")
        self._navy_rgba = Image.new("RGBA", (self.W, self.H), NAVY + (255,))
        self.wheel_rgb = self._build_wheel()
        self.wheel_mask = circle_mask(2 * self.R)
        self.pointer, self.pointer_pivot = self._build_pointer()
        self.hub = self._build_hub()
        self.title_img = self._build_title()
        self.watermark = self._build_watermark()

    # -- assets -------------------------------------------------------

    def _build_background(self):
        W, H = self.W, self.H
        if self.style == "green":
            return Image.new("RGB", (W, H), CHROMA)
        y = np.linspace(0, 1, H, dtype=np.float32)[:, None]
        x = np.linspace(0, 1, W, dtype=np.float32)[None, :]
        # vertical gradient (lighter purple tint toward the top) ...
        lin = 0.10 * (1 - y) ** 1.5
        # ... plus a soft purple glow behind the wheel
        dx = (x - 0.5) * W / H
        dy = y - self.cy / H
        glow = 0.32 * np.exp(-(dx ** 2 + dy ** 2) / (2 * 0.24 ** 2))
        amt = np.clip(lin + glow, 0, 1)[..., None]
        navy = np.array(NAVY, np.float32)
        purple = np.array(PURPLE, np.float32)
        img = navy + (purple - navy) * amt
        # tiny dither to avoid banding after H.264
        img += np.random.default_rng(1).uniform(-1.2, 1.2, img.shape)
        bg = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")
        # soft drop shadow under the wheel
        sh = Image.new("L", (W, H), 0)
        r = self.R + int(10 * self.k)
        off = int(18 * self.k)
        ImageDraw.Draw(sh).ellipse((self.cx - r, self.cy - r + off, self.cx + r, self.cy + r + off), fill=150)
        sh = sh.filter(ImageFilter.GaussianBlur(28 * self.k))
        bg.paste(Image.new("RGB", (W, H), (5, 5, 10)), (0, 0), sh)
        return bg

    def _slice_color(self, i):
        if self.n % 2 == 1 and i == self.n - 1:
            return MID
        return PURPLE if i % 2 == 0 else ACCENT

    def _build_wheel(self):
        """Wheel at rotation 0 as an RGB square (corners are navy, masked later)."""
        ss = 2
        R = self.R * ss
        S = 2 * R
        k = self.k * ss
        n = self.n
        sw = 360.0 / n
        c = S / 2

        navy_ring = 7 * k
        gold_ring = 16 * k
        r_face = R - navy_ring - gold_ring

        img = Image.new("RGB", (S, S), NAVY)
        d = ImageDraw.Draw(img)
        d.ellipse((c - r_face - 2, c - r_face - 2, c + r_face + 2, c + r_face + 2), fill=GOLD)
        for i in range(n):
            mid = -90 + i * sw
            d.pieslice((c - r_face, c - r_face, c + r_face, c + r_face),
                       mid - sw / 2, mid + sw / 2, fill=self._slice_color(i))

        # Slice contents: build each one upright at the top, then rotate into place.
        half = math.radians(sw / 2)
        margin = 40 * k                       # room for the pointer tip at the rim
        r_max = r_face - margin
        r_in = self.hub_r * ss + 24 * k       # keep clear of the hub
        ring = 7 * k
        # Outer radius of the photo badge (photo + gold ring + navy edge): the
        # largest circle that fits inside the wedge without touching a divider.
        sin_h = math.sin(half)
        outer = min(r_max * sin_h / (1 + sin_h) - 6 * k, (r_max - r_in) / 2)
        rho = int(outer - ring - 3 * k)
        dist = r_max - outer                  # photo centre distance from wheel centre
        label_r = dist - rho * 0.86           # name label overlaps bottom of photo

        content = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        for i, cat in enumerate(self.cats):
            layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            px, py = c, c - dist
            # navy + gold rings behind photo
            ld.ellipse((px - rho - ring - 3 * k, py - rho - ring - 3 * k,
                        px + rho + ring + 3 * k, py + rho + ring + 3 * k), fill=NAVY)
            ld.ellipse((px - rho - ring, py - rho - ring, px + rho + ring, py + rho + ring), fill=GOLD)
            photo = load_photo(cat["photo_path"], 2 * rho, cat.get("center", (0.5, 0.5)),
                               cutout_fill=cat.get("fill", self.s["cutout_fill"]),
                               background=hex_rgb(self.s["photo_background"]),
                               despill=self.style == "green" and self.s["green_despill_photos"])
            layer.alpha_composite(photo, (int(px - rho), int(py - rho)))

            # name pill, sized to fit inside the wedge at that radius
            max_font = int(46 * k)
            if n == 2:
                avail = r_face * 1.1
            else:
                avail = 2 * ((label_r - max_font * 0.7) * math.tan(half) - 10 * k)
            avail = min(avail, 2 * rho + 60 * k)
            pad_x, pad_y = 18 * k, 8 * k
            label = cat["name"]
            font, fsize = fit_font(label, name_font, max_font, int(16 * k), avail - 2 * pad_x)
            while len(label) > 2 and font.getlength(label) > avail - 2 * pad_x:
                label = label[:-2].rstrip() + "…"   # too long even at min size: truncate
            t = text_image(label, font, WHITE)
            tw, th = t.size
            bw, bh = tw + 2 * pad_x, th + 2 * pad_y
            lx, ly = c - bw / 2, c - label_r - bh / 2
            ld.rounded_rectangle((lx, ly, lx + bw, ly + bh), radius=bh / 2, fill=NAVY,
                                 outline=GOLD, width=max(2, int(4 * k)))
            layer.alpha_composite(t, (int(c - tw / 2), int(ly + (bh - th) / 2)))

            content.alpha_composite(layer.rotate(-i * sw, Image.BICUBIC, center=(c, c)))
        img.paste(content, (0, 0), content)

        # dividers
        for i in range(n):
            a = math.radians(-90 + i * sw + sw / 2)
            d.line((c, c, c + r_face * math.cos(a), c + r_face * math.sin(a)),
                   fill=GOLD, width=int(6 * k))
        # rim
        d.ellipse((c - R + navy_ring, c - R + navy_ring, c + R - navy_ring, c + R - navy_ring),
                  outline=GOLD, width=int(gold_ring))
        # pegs on the rim at each divider
        pr = 7 * k
        rr = r_face + gold_ring / 2
        for i in range(n):
            a = math.radians(-90 + i * sw + sw / 2)
            x, y = c + rr * math.cos(a), c + rr * math.sin(a)
            d.ellipse((x - pr - 3 * k, y - pr - 3 * k, x + pr + 3 * k, y + pr + 3 * k), fill=NAVY)
            d.ellipse((x - pr, y - pr, x + pr, y + pr), fill=(255, 240, 200))

        self._geom = dict(r_face=r_face / ss)
        return img.resize((2 * self.R, 2 * self.R), Image.LANCZOS)

    def _build_pointer(self):
        ss = 4
        k = self.k * ss
        w, h = int(120 * k), int(150 * k)
        img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        cx = w / 2
        head_r = 40 * k
        head_y = 50 * k
        tip_y = h - 8 * k
        o = 7 * k  # navy outline
        tri = [(cx - head_r * 0.95, head_y + 6 * k), (cx + head_r * 0.95, head_y + 6 * k), (cx, tip_y)]
        tri_o = [(cx - head_r * 0.95 - o, head_y + 4 * k), (cx + head_r * 0.95 + o, head_y + 4 * k), (cx, tip_y + o * 1.0)]
        d.polygon(tri_o, fill=NAVY)
        d.ellipse((cx - head_r - o, head_y - head_r - o, cx + head_r + o, head_y + head_r + o), fill=NAVY)
        d.polygon(tri, fill=GOLD)
        d.ellipse((cx - head_r, head_y - head_r, cx + head_r, head_y + head_r), fill=GOLD)
        # small bevel highlight + rivet
        d.ellipse((cx - 14 * k, head_y - 14 * k, cx + 14 * k, head_y + 14 * k), fill=NAVY)
        d.ellipse((cx - 8 * k, head_y - 8 * k, cx + 8 * k, head_y + 8 * k), fill=ACCENT)
        img = img.resize((w // ss, h // ss), Image.LANCZOS)
        pivot = (w / ss / 2, head_y / ss)
        return img, pivot

    def _build_hub(self):
        ss = 4
        r = self.hub_r * ss
        k = self.k * ss
        S = 2 * r
        img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.ellipse((0, 0, S - 1, S - 1), fill=NAVY)
        d.ellipse((6 * k, 6 * k, S - 6 * k, S - 6 * k), fill=GOLD)
        d.ellipse((16 * k, 16 * k, S - 16 * k, S - 16 * k), fill=NAVY)
        # paw print
        c = S / 2
        u = r / 72 * 1.0
        d.ellipse((c - 20 * u, c - 2 * u, c + 20 * u, c + 30 * u), fill=GOLD)
        for dx, dy, rr in ((-25, -16, 9), (-9, -30, 9.5), (9, -30, 9.5), (25, -16, 9)):
            d.ellipse((c + (dx - rr) * u, c + (dy - rr) * u, c + (dx + rr) * u, c + (dy + rr) * u), fill=GOLD)
        return img.resize((2 * self.hub_r, 2 * self.hub_r), Image.LANCZOS)

    def _build_title(self):
        font, size = fit_font(self.s["reveal_title"], heading_font, int(128 * self.k),
                              int(40 * self.k), self.W - 120 * self.k, 0.07)
        return text_image(self.s["reveal_title"], font, GOLD, stroke=max(3, int(size * 0.07)))

    def build_name(self, name):
        name = display_upper(name)
        font, size = fit_font(name, heading_font, int(200 * self.k),
                              int(60 * self.k), self.W - 100 * self.k, 0.06)
        return text_image(name, font, WHITE, stroke=max(4, int(size * 0.06)),
                          stroke_fill=PURPLE)

    def _build_watermark(self):
        if not self.s["watermark"]:
            return None
        font = heading_font(int(40 * self.k))
        return text_image(self.s["watermark_text"], font, ACCENT, stroke=max(2, int(3 * self.k)))

    def winner_mask(self, rotation, target):
        """Mask (wheel-sized) of the target slice as it sits after `rotation`."""
        ss = 2
        S = 2 * self.R * ss
        sw = 360.0 / self.n
        r = self._geom["r_face"] * ss
        mid = -90 + target * sw + rotation
        m = Image.new("L", (S, S), 0)
        c = S / 2
        ImageDraw.Draw(m).pieslice((c - r, c - r, c + r, c + r), mid - sw / 2, mid + sw / 2, fill=255)
        return m.resize((2 * self.R, 2 * self.R), Image.LANCZOS)

    def winner_outline(self, rotation, target):
        ss = 2
        S = 2 * self.R * ss
        sw = 360.0 / self.n
        r = self._geom["r_face"] * ss
        k = self.k * ss
        mid = -90 + target * sw + rotation
        c = S / 2
        img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        w = int(12 * k)
        box = (c - r + w / 2, c - r + w / 2, c + r - w / 2, c + r - w / 2)
        d.arc(box, mid - sw / 2, mid + sw / 2, fill=GOLD, width=w)
        for a in (mid - sw / 2, mid + sw / 2):
            ar = math.radians(a)
            d.line((c, c, c + r * math.cos(ar), c + r * math.sin(ar)), fill=GOLD, width=w)
        return img.resize((2 * self.R, 2 * self.R), Image.LANCZOS)

    # -- per-frame ----------------------------------------------------

    def rotated_wheel(self, rotation, blur_from=None):
        """Wheel rotated clockwise; with blur_from, averages sub-frame samples."""
        if blur_from is None or abs(rotation - blur_from) < 3:
            return self.wheel_rgb.rotate(-rotation, Image.BICUBIC, fillcolor=NAVY)
        delta = rotation - blur_from
        samples = int(min(8, max(2, math.ceil(abs(delta) / 6))))
        acc = None
        for j in range(samples):
            # shutter covers the latter 60% of the frame interval
            a = rotation - delta * 0.6 * (j / (samples - 1))
            arr = np.asarray(self.wheel_rgb.rotate(-a, Image.BILINEAR, fillcolor=NAVY), np.uint16)
            acc = arr if acc is None else acc + arr
        return Image.fromarray((acc // samples).astype(np.uint8))

    def compose(self, layers):
        """Composite foreground RGBA layers over the background for this style."""
        fg = Image.new("RGBA", (self.W, self.H), (0, 0, 0, 0))
        for img, pos in layers:
            if img is not None:
                fg.alpha_composite(img, (int(round(pos[0])), int(round(pos[1]))))
        if self.style == "full":
            out = self._bg_rgba.copy()
            out.alpha_composite(fg)
            return out.convert("RGB")
        # Green: hard cut between foreground and key colour. Partly transparent
        # edge pixels are blended toward navy instead of green, so edges stay
        # smooth but no green-tinted halo survives around the wheel or text.
        over_navy = self._navy_rgba.copy()
        over_navy.alpha_composite(fg)
        hard = fg.getchannel("A").point(lambda a: 255 if a > 15 else 0)
        return Image.composite(over_navy.convert("RGB"), self.background, hard)


def hex_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def scaled(img, scale):
    if scale <= 0.02:
        return None
    w, h = img.size
    return img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.BICUBIC)


class Confetti:
    COLORS = [GOLD, PURPLE, ACCENT, WHITE, (255, 214, 102)]

    def __init__(self, origin, k, rng, count=90):
        self.k = k
        self.p = []
        for _ in range(count):
            ang = math.radians(rng.uniform(-160, -20))
            speed = rng.uniform(900, 2100) * k
            self.p.append(dict(
                x=origin[0] + rng.uniform(-40, 40) * k, y=origin[1],
                vx=math.cos(ang) * speed, vy=math.sin(ang) * speed,
                w=rng.uniform(10, 20) * k, h=rng.uniform(18, 32) * k,
                rot=rng.uniform(0, 360), spin=rng.uniform(-900, 900),
                color=rng.choice(self.COLORS)))

    def layer(self, t, size):
        if t <= 0:
            return None
        img = Image.new("RGBA", size, (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        g = 2600 * self.k
        drag = math.exp(-1.6 * t)
        for p in self.p:
            # simple drag + gravity
            x = p["x"] + p["vx"] * (1 - drag) / 1.6
            y = p["y"] + p["vy"] * (1 - drag) / 1.6 + 0.5 * g * t * t * 0.55
            a = math.radians(p["rot"] + p["spin"] * t)
            flip = abs(math.cos(a * 1.7))  # fake 3D tumble
            hw, hh = p["w"] / 2 * max(flip, 0.35), p["h"] / 2
            ca, sa = math.cos(a), math.sin(a)
            pts = [(x + ca * dx - sa * dy, y + sa * dx + ca * dy)
                   for dx, dy in ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh))]
            d.polygon(pts, fill=p["color"])  # no anti-aliasing: hard edges for chroma key
        return img


# ---------------------------------------------------------------- clip

def render_frames(renderer, cat_index, spin, rng_seed):
    """Yield (time, frame) for one clip."""
    s = renderer.s
    fps = s["fps"]
    idle, spin_t, reveal_t = s["idle_seconds"], s["spin_seconds"], s["reveal_seconds"]
    total = idle + spin_t + reveal_t
    nframes = int(round(total * fps))
    start, end, _ = spin
    n = renderer.n
    sw = 360.0 / n
    R = renderer.R
    wx, wy = renderer.cx - R, renderer.cy - R
    rng = random.Random(rng_seed)

    name_img = renderer.build_name(renderer.cats[cat_index]["name"])
    final_wheel = renderer.rotated_wheel(end)
    win_mask = renderer.winner_mask(end, cat_index)
    win_outline = renderer.winner_outline(end, cat_index)
    dimmed = Image.blend(final_wheel, Image.new("RGB", final_wheel.size, NAVY), 0.6)
    bright = Image.blend(final_wheel, Image.new("RGB", final_wheel.size, (255, 244, 214)), 0.18)
    confetti = Confetti((renderer.cx, wy + 30 * renderer.k), renderer.k, rng) if s["confetti"] else None

    title_y = renderer.H * 0.125
    name_y = renderer.H * 0.21
    piv = renderer.pointer_pivot
    pointer_pos = (renderer.cx, wy - 20 * renderer.k)  # where the pivot sits on screen

    def angle_at(t):
        if t < idle:
            return start
        if t < idle + spin_t:
            return start + (end - start) * ease_out((t - idle) / spin_t, s["easing"])
        return end

    last_cross_t = -10.0
    prev_angle = angle_at(-1.0 / fps)
    for fi in range(nframes):
        t = fi / fps
        ang = angle_at(t)
        rt = t - idle - spin_t   # time into reveal (negative before)

        # wheel
        if rt < 0:
            blur_from = prev_angle if s["motion_blur"] else None
            wheel = renderer.rotated_wheel(ang, blur_from)
        else:
            hl = ease_out(rt / 0.18, "cubic")
            pulse = 0.5 + 0.5 * math.sin(rt * 2 * math.pi * 2.2)
            dim = Image.blend(final_wheel, dimmed, hl)
            win = Image.blend(final_wheel, bright, hl * (0.4 + 0.6 * pulse))
            wheel = Image.composite(win, dim, win_mask)
        wheel = wheel.convert("RGBA")
        wheel.putalpha(renderer.wheel_mask)
        if rt >= 0:
            o = win_outline.copy()
            o.putalpha(ImageChops.multiply(o.getchannel("A"),
                                           Image.new("L", o.size, int(255 * ease_out(rt / 0.15, "cubic")))))
            wheel.alpha_composite(o)

        # pointer tick: a divider pushes the pointer, then it springs back
        deflect = 0.0
        if s["pointer_tick"]:
            per_frame = abs(ang - prev_angle) / sw
            if int((ang + sw / 2) // sw) != int((prev_angle + sw / 2) // sw):
                last_cross_t = t
            f = ((ang + sw / 2) % sw) / sw
            if per_frame > 0.6:
                deflect = 16 + rng.uniform(-4, 4)
            elif f > 0.82 and rt < 0:
                deflect = 22 * (f - 0.82) / 0.18
            else:
                tau = t - last_cross_t
                deflect = 22 * math.exp(-tau / 0.09) * math.cos(tau * 2 * math.pi / 0.16)
        pointer = renderer.pointer.rotate(deflect, Image.BICUBIC, center=piv) if abs(deflect) > 0.3 else renderer.pointer
        ptr_pos = (pointer_pos[0] - piv[0], pointer_pos[1] - piv[1])

        layers = [(wheel, (wx, wy)),
                  (renderer.hub, (renderer.cx - renderer.hub_r, renderer.cy - renderer.hub_r)),
                  (pointer, ptr_pos)]
        if renderer.watermark is not None:
            wm = renderer.watermark
            layers.append((wm, (renderer.cx - wm.width / 2, renderer.H * 0.905 - wm.height / 2)))
        if rt >= 0:
            if confetti:
                layers.append((confetti.layer(rt, (renderer.W, renderer.H)), (0, 0)))
            for img, delay, dur, y in ((renderer.title_img, 0.08, 0.22, title_y),
                                       (name_img, 0.24, 0.26, name_y)):
                sc = ease_out_back((rt - delay) / dur) if rt > delay else 0
                im = scaled(img, sc)
                if im is not None:
                    layers.append((im, (renderer.cx - im.width / 2, y - im.height / 2)))

        prev_angle = ang
        yield t, renderer.compose(layers)


# ---------------------------------------------------------------- encode

def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def encode_clip(job):
    cats, settings, style, cat_index, spin, out_path, ffmpeg = job
    t0 = time.time()
    renderer = Renderer(cats, settings, style)
    W, H, fps = settings["width"], settings["height"], settings["fps"]
    tmp_path = out_path.with_suffix(".part.mp4")
    cmd = [ffmpeg, "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
           "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
           "-c:v", "libx264", "-preset", "medium", "-crf", str(settings["crf"]),
           "-profile:v", "high", "-pix_fmt", "yuv420p",
           "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
           "-color_range", "tv", "-movflags", "+faststart", "-f", "mp4", str(tmp_path)]
    # Frames are streamed straight into ffmpeg, so no temp frame files are
    # written; only the partial .mp4 needs cleaning up on failure.
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    try:
        for _, frame in render_frames(renderer, cat_index, spin, rng_seed=f"{cats[cat_index]['name']}-{spin[0]}"):
            proc.stdin.write(frame.tobytes())
        proc.stdin.close()
        if proc.wait() != 0:
            raise RuntimeError(f"ffmpeg failed for {out_path.name}")
        tmp_path.replace(out_path)
    except BaseException:
        proc.kill()
        tmp_path.unlink(missing_ok=True)
        raise
    return out_path, time.time() - t0


# ---------------------------------------------------------------- config / CLI

def slug(name):
    # Keeps letters from any alphabet, so "Ορέστης" -> wheel_ορέστης_full.mp4
    name = unicodedata.normalize("NFC", name).lower()
    return re.sub(r"[\W_]+", "-", name).strip("-") or "cat"


def load_config(path):
    cfg = json.loads(Path(path).read_text(encoding="utf-8"))
    settings = dict(DEFAULT_SETTINGS)
    settings.update(cfg.get("settings", {}))
    base = Path(path).resolve().parent
    cats = []
    for entry in cfg.get("cats", []):
        cat = dict(entry)
        cat["photo_path"] = str((base / entry["photo"]).resolve())
        if "center" in cat:
            cat["center"] = tuple(cat["center"])
        cats.append(cat)
    if not 2 <= len(cats) <= 10:
        sys.exit(f"cats.json must list between 2 and 10 cats (found {len(cats)}).")
    names = [slug(c["name"]) for c in cats]
    if len(set(names)) != len(names):
        sys.exit("Cat names must be unique.")
    if settings["width"] % 2 or settings["height"] % 2:
        sys.exit("width and height must be even numbers for yuv420p.")
    settings["output_dir"] = str((base / settings["output_dir"]).resolve())
    return cats, settings


PLACEHOLDER_COLORS = [(255, 107, 107), (255, 159, 67), (243, 104, 224), (84, 160, 255),
                      (200, 85, 61), (232, 67, 147), (95, 39, 205), (255, 205, 86),
                      (52, 73, 94), (160, 82, 45)]
# Different sizes and orientations to exercise the square crop + EXIF handling.
PLACEHOLDER_SIZES = [(1200, 1200), (1600, 900), (800, 1400), (640, 480), (1000, 1500)]


def make_placeholders(cats):
    for i, cat in enumerate(cats):
        path = Path(cat["photo_path"])
        if path.exists():
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        w, h = PLACEHOLDER_SIZES[i % len(PLACEHOLDER_SIZES)]
        color = PLACEHOLDER_COLORS[i % len(PLACEHOLDER_COLORS)]
        img = Image.new("RGB", (w, h), tuple(min(255, c // 3 + 150) for c in color))
        d = ImageDraw.Draw(img)
        r = min(w, h) * 0.42
        d.ellipse((w / 2 - r, h / 2 - r, w / 2 + r, h / 2 + r), fill=color)
        letter = display_upper(cat["name"][0])
        font = heading_font(int(r * 1.3), letter)
        d.text((w / 2, h / 2), letter, font=font, fill=WHITE, anchor="mm")
        exif = None
        if i % 5 == 3:
            # store rotated with an EXIF orientation tag, like a phone photo
            img = img.rotate(90, expand=True)
            exif = Image.Exif()
            exif[0x0112] = 6
        if path.suffix.lower() in (".jpg", ".jpeg"):
            img.save(path, quality=92, **({"exif": exif} if exif else {}))
        else:
            img.save(path, **({"exif": exif} if exif else {}))
        print(f"  placeholder -> {path.relative_to(HERE) if path.is_relative_to(HERE) else path}")


def save_preview(cats, settings, style, cat_index, spin, out_dir, times):
    renderer = Renderer(cats, settings, style)
    fps = settings["fps"]
    want = {int(round(t * fps)) for t in times}
    nframes = int(round((settings["idle_seconds"] + settings["spin_seconds"] + settings["reveal_seconds"]) * fps))
    want = {min(f, nframes - 1) for f in want}
    out = []
    for fi, (t, frame) in enumerate(render_frames(renderer, cat_index, spin,
                                                   rng_seed=f"{cats[cat_index]['name']}-{spin[0]}")):
        if fi in want:
            p = out_dir / f"preview_{slug(cats[cat_index]['name'])}_{style}_{t:.2f}s.png"
            frame.save(p)
            out.append((t, p))
    # contact sheet
    thumbs = [Image.open(p).resize((270, 480), Image.LANCZOS) for _, p in out]
    sheet = Image.new("RGB", (270 * len(thumbs) + 10 * (len(thumbs) + 1), 520), (40, 40, 50))
    d = ImageDraw.Draw(sheet)
    for j, ((t, _), th) in enumerate(zip(out, thumbs)):
        x = 10 + j * 280
        sheet.paste(th, (x, 30))
        d.text((x + 4, 6), f"{t:.2f}s", font=heading_font(20), fill=WHITE)
    sp = out_dir / f"sheet_{slug(cats[cat_index]['name'])}_{style}.png"
    sheet.save(sp)
    return sp


def main():
    ap = argparse.ArgumentParser(description="Generate TikTok spin-the-wheel clips for each cat.")
    ap.add_argument("--config", default=str(HERE / "cats.json"))
    ap.add_argument("--cat", help="build only this cat (name, case-insensitive)")
    ap.add_argument("--style", choices=("full", "green", "both"), default="both")
    ap.add_argument("--fps", type=int, help="override fps from the config")
    ap.add_argument("--seed", type=int, help="override the random seed from the config")
    ap.add_argument("--jobs", type=int, default=max(1, min(4, (mp.cpu_count() or 2) - 1)),
                    help="clips to render in parallel")
    ap.add_argument("--preview", action="store_true",
                    help="save still frames + a contact sheet to output/preview instead of encoding")
    ap.add_argument("--placeholders", action="store_true",
                    help="create placeholder images for any missing cat photos")
    args = ap.parse_args()

    cats, settings = load_config(args.config)
    if args.fps:
        settings["fps"] = args.fps
    if args.seed is not None:
        settings["seed"] = args.seed

    ensure_fonts()

    if args.placeholders:
        make_placeholders(cats)
    missing = [c["photo_path"] for c in cats if not Path(c["photo_path"]).exists()]
    if missing:
        sys.exit("Missing photos:\n  " + "\n  ".join(missing) +
                 "\nAdd them, or run with --placeholders to generate test images.")

    targets = list(range(len(cats)))
    if args.cat:
        targets = [i for i, c in enumerate(cats) if slug(c["name"]) == slug(args.cat)]
        if not targets:
            sys.exit(f"No cat named {args.cat!r}. Known: {', '.join(c['name'] for c in cats)}")
    styles = ["full", "green"] if args.style == "both" else [args.style]

    out_dir = Path(settings["output_dir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    seed = settings["seed"]
    master = random.Random(seed) if seed is not None else random.Random()
    # One spin per cat, shared by both styles so full and green match frame-for-frame.
    spins = {i: plan_spin(i, len(cats), settings["rotations"], settings["max_offset"],
                          random.Random(master.random())) for i in range(len(cats))}

    if args.preview:
        pdir = out_dir / "preview"
        pdir.mkdir(exist_ok=True)
        total = settings["idle_seconds"] + settings["spin_seconds"] + settings["reveal_seconds"]
        times = [0.0, settings["idle_seconds"] + 0.4, settings["idle_seconds"] + 1.6,
                 settings["idle_seconds"] + settings["spin_seconds"] - 0.05,
                 settings["idle_seconds"] + settings["spin_seconds"] + 0.3, total]
        for i in targets:
            for st in styles:
                sp = save_preview(cats, settings, st, i, spins[i], pdir, times)
                print(f"  preview -> {sp}")
        return

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        sys.exit("ffmpeg not found. Install it (see README) or `pip install imageio-ffmpeg`.")

    jobs = [(cats, settings, st, i, spins[i],
             out_dir / f"wheel_{slug(cats[i]['name'])}_{st}.mp4", ffmpeg)
            for i in targets for st in styles]
    print(f"Rendering {len(jobs)} clip(s) at {settings['width']}x{settings['height']} "
          f"{settings['fps']}fps with {min(args.jobs, len(jobs))} worker(s)...")
    t0 = time.time()
    if args.jobs > 1 and len(jobs) > 1:
        with mp.Pool(min(args.jobs, len(jobs))) as pool:
            for path, secs in pool.imap_unordered(encode_clip, jobs):
                print(f"  {path.name}  ({secs:.1f}s)")
    else:
        for job in jobs:
            path, secs = encode_clip(job)
            print(f"  {path.name}  ({secs:.1f}s)")
    print(f"Done in {time.time() - t0:.1f}s -> {out_dir}")


if __name__ == "__main__":
    main()
