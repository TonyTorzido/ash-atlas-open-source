# Atlas Animator, round 18 (owner review 2026-10-16: the standard kung-fu jacket wins over the premium one; "clean it up"):
# a deterministic edit of the approved long-cuff jacket art (no new art, like scripts/kungfu-longcuff.ts):
#   1. the cream centre placket runs all the way up to the cream collar band: the placket's straight cross-section
#      (ink | cream | ink, taken from the first straight row below its rounded cap) is repeated up over the cap, the
#      collar base line and the black collar strip until it meets the band, so there is no black gap and the strip
#      keeps its exact width and colours;
#   2. calm fabric: the shade tone's thin fold/wrinkle streaks are removed and the broad side bands kept, in a softer shade. Shade = black-fabric texels darker than the
#      midpoint of the fabric base and shade tones. A morphological opening (disc radius OPEN_R) keeps only the broad
#      cel shapes (the side bands); a closing (CLOSE_R) fills thin base-colour slivers left inside them. Removed
#      texels take the fabric base colour, kept/filled ones the shade colour. Outline ink, cream trim and
#      transparency are never touched.
# Usage (from packages/animator): python scripts/kungfu-clean.py [in.png out.png]
#   default in  = ART_DROPS/swag-kungfu-01/v3-longcuff/kungfu-jacket-a-longcuff.png (kept unchanged)
#   default out = ART_DROPS/swag-kungfu-01/v4-clean/kungfu-jacket-a-clean.png
import os
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

ART_DROPS = os.environ.get("ART_DROPS", "C:/Users/dev/Documents/art-drops")
IN = f"{ART_DROPS}/swag-kungfu-01/v3-longcuff/kungfu-jacket-a-longcuff.png"
OUT = f"{ART_DROPS}/swag-kungfu-01/v4-clean/kungfu-jacket-a-clean.png"
INK = np.array([53, 15, 2])
BASE = np.array([47, 47, 49])
SHADE = np.array([37, 37, 40])
OPEN_R = 4    # px: shade shapes narrower than about 2*OPEN_R+1 are streaks
CLOSE_R = 3   # px: base slivers this thin inside a broad shade shape are filled
MIN_BAND_H = 40  # px: a kept shade shape shorter than this is a fold stroke, not a side band
VOPEN = 25    # px: vertical opening (drops diagonal creases attached to a band)
VCLOSE = 81   # px: vertical closing (rejoins a side band that its streaks had split in two)
# the kept bands are painted in a SOFTER shade than the art's (calmer, lower contrast): they run along the arm/torso seam,
# and the art's full shade there read 6.3 against the seam check's 6.2 bound (polish-seam-ink.py check, arm-seam mask)
SHADE_SOFT = np.array([41, 41, 44])
CX = 541    # canvas x of the placket centre line (the jacket's centre front)


def disc(r):
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return x * x + y * y <= r * r


def lum(c):
    return 0.299 * c[..., 0] + 0.587 * c[..., 1] + 0.114 * c[..., 2]


def is_cream(p):
    return p[..., 0] > 200


def extend_placket(a):
    """Repeat the straight placket cross-section up to the cream collar band. Returns rows changed."""
    op = a[..., 3] > 0
    col = a[:, CX]
    # the placket's first straight row: walking down the centre column, the first cream run below the collar band
    # whose row has cream exactly as wide as rows further down (not the rounded cap)
    ys = np.nonzero(op[:, CX])[0]
    y = ys.min()
    while y < a.shape[0] and not is_cream(col[y]):
        y += 1
    band_top = y
    while is_cream(col[y]):
        y += 1
    band_bottom = y - 1          # last cream row of the collar band
    while not is_cream(col[y]):
        y += 1
    cap_top = y                  # first cream row of the placket (its rounded cap)

    def run(yy):
        # the contiguous cream run through the centre column (frog loops beside it are separated by ink)
        if not is_cream(a[yy, CX]):
            return None
        l = r = CX
        while is_cream(a[yy, l - 1]):
            l -= 1
        while is_cream(a[yy, r + 1]):
            r += 1
        return (l, r)
    # the straight row: the first row below the cap whose width holds for the next 4 rows
    w = lambda yy: (run(yy)[1] - run(yy)[0]) if run(yy) else -1
    full = max(w(yy) for yy in range(cap_top, cap_top + 30))
    straight = next(yy for yy in range(cap_top, cap_top + 30) if all(w(yy + k) == full for k in range(0, 5)))
    c0, c1 = run(straight)
    # ink borders: the ink run on each side of the cream in that row
    x0 = c0
    inkish = lambda p: np.abs(p[:3] - INK).sum() < 30 or (p[0] - p[1]) > 12  # ink or its blend with cream
    while x0 > 0 and inkish(a[straight, x0 - 1]):
        x0 -= 1
    x1 = c1
    while x1 < a.shape[1] - 1 and inkish(a[straight, x1 + 1]):
        x1 += 1
    tmpl = a[straight, x0:x1 + 1].copy()
    for yy in range(band_bottom + 1, straight):
        a[yy, x0:x1 + 1] = tmpl
    print(f"placket: band y{band_top}-{band_bottom}, cap y{cap_top}, straight y{straight}, cream x{c0}-{c1}, "
          f"ink x{x0}-{x1}; rows {band_bottom + 1}-{straight - 1} set to the straight cross-section")
    return straight - band_bottom - 1


def calm_fabric(a):
    rgb = a[..., :3].astype(np.float64)
    op = a[..., 3] > 0
    fab = op & (rgb[..., 0] < 60) & (np.abs(rgb[..., 0] - rgb[..., 1]) < 8) & (np.abs(rgb - INK).sum(-1) >= 30)
    mid = (lum(BASE.astype(float)) + lum(SHADE.astype(float))) / 2
    shade = fab & (lum(rgb) < mid)
    kept = ndimage.binary_opening(shade, structure=disc(OPEN_R))
    # broad cel shapes only: the tall torso side bands; short pieces (sleeve fold strokes) are streaks
    lab, n = ndimage.label(kept)
    for i, sl in enumerate(ndimage.find_objects(lab)):
        if sl[0].stop - sl[0].start < MIN_BAND_H:
            kept[lab == i + 1] = False
    # the side bands are vertical: a vertical opening drops the diagonal armpit crease attached to them, a vertical
    # closing rejoins a band that the streaks inside it had split into pieces
    vert = lambda h: np.ones((h, 1), dtype=bool)
    kept = ndimage.binary_opening(kept, structure=vert(VOPEN))
    kept = ndimage.binary_closing(kept, structure=vert(VCLOSE))
    kept = ndimage.binary_opening(ndimage.binary_closing(kept, structure=disc(CLOSE_R)), structure=disc(CLOSE_R)) & fab
    removed = shade & ~kept
    filled = kept & ~shade
    # texels inside the fabric that are AA blends of base and shade follow the decision of their class
    a[fab & ~kept, :3] = BASE
    a[kept, :3] = SHADE_SOFT
    print(f"fabric: shade texels {int(shade.sum())}, kept broad {int((shade & kept).sum())}, "
          f"removed streaks {int(removed.sum())}, filled slivers {int(filled.sum())}")


def main():
    src, dst = (sys.argv[1], sys.argv[2]) if len(sys.argv) > 2 else (IN, OUT)
    a = np.array(Image.open(src).convert("RGBA")).astype(np.int32)
    extend_placket(a)
    calm_fabric(a)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    Image.fromarray(a.astype(np.uint8)).save(dst)
    print("wrote", dst)


if __name__ == "__main__":
    main()
