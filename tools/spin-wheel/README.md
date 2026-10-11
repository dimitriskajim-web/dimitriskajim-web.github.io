# TCGQuestlog spin-the-wheel generator

Makes vertical (1080x1920) MP4 clips for the cat series. A wheel of cat faces
spins and lands on one cat, then **TODAY'S VICTIM:** and the cat's name pop in.
You get one clip per cat, in two versions:

| file | background | use it for |
|---|---|---|
| `output/wheel_<cat>_full.mp4` | brand navy with a purple glow | dropping straight into a video |
| `output/wheel_<cat>_green.mp4` | pure `#00FF00` | overlaying on your own footage with Chroma Key in CapCut |

Each clip is about 5 s: 0.3 s idle, 3.5 s spin, 1.2 s reveal. The full and
green clips for a cat use the same spin, so you can swap one for the other.

## Install

You need Python 3.9 or newer and ffmpeg.

```bash
cd tools/spin-wheel
pip install -r requirements.txt
```

If you don't have ffmpeg installed (`ffmpeg -version` fails), the
`imageio-ffmpeg` package in requirements.txt provides one. You can also install
it with `brew install ffmpeg` (Mac), `winget install ffmpeg` (Windows) or
`sudo apt install ffmpeg` (Linux).

The first run downloads the Rajdhani and Exo 2 fonts from Google Fonts into
`fonts/`. If you're offline it falls back to a system font and prints a warning.

## Try it with placeholder cats first

```bash
python wheel.py --placeholders --preview   # make test images, save still frames
python wheel.py                            # encode every clip
```

`--placeholders` creates coloured circles with letters for any photo in
`cats.json` that doesn't exist yet. It never overwrites real photos.
`--preview` saves a few still frames and a contact sheet per clip to
`output/preview/` without encoding video.

## Add your cats

1. Put a photo of each cat in `cats/`. Any size, orientation or format works
   (JPG, PNG, WebP, HEIC exported as JPG...). Phone rotation (EXIF) is handled. The
   photo is cropped to a centred square and then to a circle, so keep the face
   near the middle.

   **Cut-out heads** (PNG or WebP with a transparent background) work best. The
   whole head, ears included, is fitted inside the circle on a light lavender
   badge. Whiskers are ignored when sizing. Change how much of the circle the
   head fills with `"cutout_fill"` (default 0.92), or per cat with `"fill"`.
2. List them in `cats.json` (2 to 10 cats):

```json
"cats": [
  { "name": "Luna",   "photo": "cats/luna.jpg" },
  { "name": "Nugget", "photo": "cats/nugget.jpg", "center": [0.5, 0.4] }
]
```

Names can use any alphabet. Rajdhani and Exo 2 have no Greek or Cyrillic
letters, so names that need them switch automatically to similar fonts (Fira Sans
Extra Condensed for the reveal, Play on the wheel). In the reveal, Greek capitals
drop their accents (Ορέστης → ΟΡΕΣΤΗΣ). The file is named
`wheel_ορέστης_full.mp4`, and `--cat Ορέστης` (or `--cat ορέστης`) builds just that cat.

`center` (regular photos) and `fill` (cut-out heads) are optional. `center` moves the crop when the face isn't centred: `[x, y]`
from 0 to 1, so `[0.5, 0.4]` shifts it a little toward the top of the photo.

3. Delete the placeholder images you replaced. You don't have to delete them if
   you used the same filenames.

## Run it

```bash
python wheel.py                     # every cat, full + green
python wheel.py --cat Luna          # one cat
python wheel.py --style green       # full | green | both (default both)
python wheel.py --cat Luna --preview  # still frames only, quick check
python wheel.py --seed 42           # repeatable spin
python wheel.py --fps 60            # override fps
python wheel.py --jobs 2            # clips rendered in parallel
```

Each run randomises the start angle and where the pointer stops. It always
stops inside the right cat's slice, but never exactly on its centre line. Set
`"seed"` in `cats.json` (or pass `--seed`) for the same spin every time.

## Settings (`cats.json` → `settings`)

| key | default | what it does |
|---|---|---|
| `fps` | 30 | frames per second (60 is smoother but takes about twice as long to render) |
| `idle_seconds` / `spin_seconds` / `reveal_seconds` | 0.3 / 3.5 / 1.2 | timing |
| `rotations` | 5 | full turns before it lands |
| `easing` | `quint` | `quint` (very slow, dramatic ending) or `cubic` (gentler) |
| `max_offset` | 0.35 | how far from the slice centre it may stop (fraction of slice width) |
| `seed` | `null` | number = same spin every run |
| `reveal_title` | `TODAY'S VICTIM:` | heading text |
| `watermark` / `watermark_text` | `true` / `tcgquestlog.com` | bottom watermark |
| `confetti` | `true` | confetti burst on reveal |
| `motion_blur` | `true` | blur while spinning fast |
| `pointer_tick` | `true` | pointer flicks as each divider passes |
| `green_despill_photos` | `true` | strips green tints from photos in the green version (see below) |
| `cutout_fill` | 0.92 | how much of the circle a cut-out head fills (lower = smaller head, more ear room) |
| `photo_background` | `#ede9fe` | circle colour behind cut-out heads and transparent photos |
| `crf` | 18 | H.264 quality (lower = bigger, sharper) |

## Using the green version in CapCut

**Phone (CapCut app)**
1. Open your project with the main video on the timeline.
2. Tap **Overlay → Add overlay** and pick `wheel_<cat>_green.mp4`.
3. Pinch to resize and position it over the main video.
4. With the overlay selected, tap **Remove BG → Chroma key** (older versions: **Cutout → Chroma key**).
5. Use the colour picker on the green area. Set **Intensity** to about 20–40 and
   raise **Shadow** a little if an edge is still visible.

**Desktop (CapCut for Windows/Mac)**
1. Drag `wheel_<cat>_green.mp4` onto a track above your main video.
2. Select it and open **Video → Cutout → Chroma key** in the right panel.
3. Pick the green with the eyedropper, then adjust **Intensity** and **Shadow**
   the same way.

Why it keys cleanly:
- The wheel, text, pointer and confetti use only navy, purple, lavender, gold
  and white. None of these are close to green.
- Edges are cut hard against the green. Soft edge pixels are blended into a
  thin navy outline, never into green, so you don't get a green halo after keying.
- If a cat photo has green in it (grass, a green blanket, green eyes), those
  pixels are toned down in the green version only. Otherwise CapCut would
  punch holes in the cat. Set `green_despill_photos` to `false` to turn this off.

## Notes

- Output is H.264 High profile, `yuv420p`, BT.709, with `+faststart`. This
  imports cleanly into CapCut on phone and desktop.
- Frames are streamed straight into ffmpeg, so no temporary frame files are
  written. A half-written `.part.mp4` is deleted if a render fails.
- `output/` and `fonts/` are git-ignored. This folder is inside the GitHub Pages
  repo, so anything you commit to `cats/` is published on the website. Leave
  real photos uncommitted, or add `cats/` to `.gitignore`, if you don't want
  them public.
