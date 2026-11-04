# Atlas Animator turned-front, (2026-10-19): a FACE and HAIR on the turned head, turned by one general rule.
# Deterministic, no image generation. packages/animator/README.md.
#
#   python scripts/views/turnfront_face.py <rig.anim.json> <out dir> <out stem> --deg 15
#       --eyes almond-calm --brows almond-calm --nose none --mouth smile-line --hair soldier-crop-hair
#       [--hair-mode shift|flip|none] [--preview head.png]
#   (run from packages/animator; <rig> is a turnfront.py rig, or any front template7 rig at --deg 0)
#
# Where the layers come from (the game's own placement, nothing hand-placed):
# - Face: the smooth sets (art drops eyes-smooth-01/final-solo, eyes-smooth-01/brows, face-smooth-01/final; 1086 x 1448
#   head-canvas layers, not yet in the catalog). They are placed the way the game places an ANCHORED face feature
#   (shared/src/appearance.ts resolveAppearanceLocalTransform with a feature point): the PNG's featureAnchor texture
#   point lands on the category's featureArea default point (catalog families eyes/nose/mouth: (0, 8.4), (0, 12.2),
#   (0, 14.1) face-anchor units), at the live eyes scale (0.03 units per texture px, the brown-eyes placement; the
#   smooth layers are drawn at the live eyes' size). The featureAnchor of each PNG (authored in Studio for live art;
#   these have none yet) is the art's opaque-box centre; noses and mouths were aligned to shared centre lines when
#   drawn, so any nose fits any mouth. Brows have no catalog category: they ride their eyes (same anchor and point).
# - Hair: the live hair PNGs with their live catalog placement (face anchor + offset, scale, pivot), exactly as the
#   game draws them (checked against the live look: template7-clean + brown-eyes + hair).
# - Units -> canvas: the live body template is drawn with anchor (0.5, 1) at (0, offsetY) and scale 42 / 1448 x
#   bodyTransforms.idle.scale, so one unit = 1 / (0.04786) canvas px and the egg head lands on the rig's head region.
#
# DEFAULT, (-face-mode project-clamped): with the projection's local horizontal
# scale clamped to <= 1 per piece (project_piece: no feature ever widens; the far side keeps its foreshortening and
# the anchor keeps the projection's shift) and the hair shift derived from the same projection at the fringe tip on
# the axis (fringe_shift: R sin theta).: the face turns by the body angle and every face layer
# is warped column by column through the egg's surface (project_layer): x' = c + R sin(asin u - theta) per row, so the
# features foreshorten by their position and the shift is the projection itself; the only darkening is the head's own
# far-side crescent. The rule below is (-face-mode slide), kept so the evidence rebuilds.
#
# The turn rule (per piece, from its anchor; the same for every eye / brow / nose / mouth / hair option):
# - The face turns by PHI = FACE_GAIN x theta (the head leads the body; 15 -> 30 deg, 20 -> 40 deg) on a sphere fitted
#   row by row to the egg: u = (anchor x - row centre) / row half-width, depth z = sqrt(1 - u^2) + BUMP (nose 0.18,
#   mouth 0.08: they stand proud of the eye line, so they move further), new x = centre + R (u cos PHI - z sin PHI).
# - Eyes and brows split at the head axis into a far (screen-left) and a near piece, each anchored at its own box
#   centre. Near eye: full size. Far eye: width x (1 - FAR_NARROW sin PHI) (0.82 at 15, 0.77 at 20) about its anchor,
#   darkened by FAR_DARK sin PHI. Brows follow their eyes (the eye's shift, narrowing, pivot and darkening).
#   Mouth: width x (1 - MOUTH_NARROW sin PHI). Nose: unscaled.
# - Fit: the far eye/brow may not cross the head outline: if the far piece's outer edge would come within EDGE_MARGIN
#   px of the egg's outline (at its rows), PHI is reduced for the whole face (reported as phiUsed), so a face turns as
#   one piece.
# - Hair: optionally FLIPPED about the head axis first (--hair-mode flip), then warped row by row so its silhouette
#   ends stay put and its interior (parting, fringe, swoop) slides toward the facing side: far side dx = -S (1 - u^2),
#   near side dx = -S (1 - u)^2 (1 + 2u), u = (x - axis) / that side's own row half-extent (lightly smoothed over
#   rows), S = HAIR_SHIFT x egg half-width x sin PHI (capped at half the far extent, so the map stays monotone). Then the far-side crescent shade (the head's, ALPHA_PER_SIN sin theta).
# --mirror-inputs (five-anims, 2026-10-19): every face layer and the hair are mirrored about the head axis BEFORE the
# turn. The rig is then rendered and the render image-flipped (the turned-RIGHT clip): the flip puts the parting,
# the swoop and the eye catchlights back on their own side, so a right-facing clip keeps the character's handedness.
# Writes <out>/<stem>.anim.json + .atlas.json + .atlas.png (the rig plus `face` and `hair` region slots on the head
# bone, drawn after the head: head, face, hair) and <stem>.face.json (every value used).
import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

from turnfront import ALPHA_PER_SIN, apply, far_shade, inv_apply, setup_world

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
DROPS = Path("C:/Users/dev/Documents/art-drops")
CATALOG = REPO / "packages/shared/src/data/player-appearance-catalog.json"
ASSETS = REPO / "packages/player-renderer/src/assets/player-appearance"
PLAYER_BASE_HEIGHT_PX = 42  # player-renderer/src/proceduralBody.ts
# units per texture px for the smooth layers: they were drawn on the smooth head template (skull 593 px wide), the rig
# egg (= the live template7 head) is 440 px wide, so 440 / 593 = 0.742 canvas px per texture px keeps the drawn
# face-to-head proportion (the live brown-eyes' 0.03 is for the older, larger-drawn eye art)
HEAD_FIT = 440 / 593

FACE_GAIN = 1.6
BUMP = {"eye": 0.0, "brow": 0.02, "nose": 0.18, "mouth": 0.08}
FAR_NARROW, FAR_DARK, MOUTH_NARROW = 0.36, 0.22, 0.25
EDGE_MARGIN = 16  # canvas px kept between the far eye/brow and the egg's outer edge (the outline is ~10 px)
MIN_GAP, FAR_MIN_K = 0.45, 0.62  # far-to-near eye gap kept (x the drawn gap); the far eye's narrowest squeeze
HAIR_SHIFT = 0.8
PROJECT_GAIN = 1.0  #: the face turns with the body
# refine P6: "those eyes are just too wide ... in general too wide for all models". Every eye style
# is narrowed about each eye's own centre by EYE_WIDTH_DEFAULT unless the style sets its own EYE_WIDTH entry
# (--eye-width overrides both). On the turned view the facing-side eye keeps >= EYE_CLEAR_TARGET x its straight-front
# outer-corner clearance to the head silhouette (G11 fails under EYE_CLEAR_MIN).
# picked the L15 100% width with the edge-clearance ease, so the default is back to 1.0
# (as drawn); the EYE_WIDTH table and --eye-width stay for per-style or one-off narrowing.
EYE_WIDTH_DEFAULT = 1.0
EYE_WIDTH: dict[str, float] = {}
# "for now no nose". nose = NO_NOSE (the default) leaves the nose layer empty, so the rig gets no nose
# slot; any drawn nose style still works when chosen.
NO_NOSE = "none"
# "a little dash for nose, simple, not a dot". Procedural dash noses, no drawn art: one
# anti-aliased stroke in the mouth line's own ink colour and weight (measured from the chosen mouth layer), tapered
# soft ends, its box centred on the nose feature point (where the drawn noses' box centres land). Length in eye widths
# (one eye's alpha > 0.16 box). In the rig's front frame the far / shading side is screen-left (FAR_DIR = -1): the
# dash-v's lower end and the dash-tick's short leg lean that way. They are drawn AFTER --mirror-inputs mirrors the
# drawn layers (only the point is mirrored), so the image-flipped turned-right clip still has them on its far side.
#   style: (polyline in units of the length, + y down, x toward the far side; length x eye width)
DASH_NOSES = {
    "dash-v": ([(-0.09, -0.5), (0.09, 0.5)], 0.32),  # near-vertical, ~10 deg tilt, foot toward the far side
    "dash-tick": ([(-0.05, -0.5), (0.0, 0.32), (0.06, 0.46), (0.16, 0.5), (0.42, 0.44)], 0.30),  # side + bottom
    "dash-h": ([(-0.5, 0.0), (0.5, 0.0)], 0.27),
}
FAR_DIR = -1.0
DASH_TAPER = 0.35  # stroke width at the tips, x the full weight (sin^0.5 ramp between)
EYE_CLEAR_TARGET, EYE_CLEAR_MIN = 0.85, 0.70
# refine P7: eyes, brows, nose and mouth are separate swappable region slots on the head bone (in
# this draw order, the order the baked face pasted them), each warped as before; the blink swaps the eyes slot only.
FACE_PARTS = ("eyes", "brows", "nose", "mouth")
PIECE_PART = {"eye": "eyes", "brow": "brows", "nose": "nose", "mouth": "mouth"}

LAYER_FILES = {
    "eyes": "eyes-smooth-01/final-solo/eyes-{}.png",
    "brows": "eyes-smooth-01/brows/brows-{}.png",
    "nose": "face-smooth-01/final/nose-{}.png",
    "mouth": "face-smooth-01/final/mouth-{}.png",
}


class Live:
    """The live catalog's body template transform, face anchor, feature areas and hair placements."""

    def __init__(self):
        c = json.loads(CATALOG.read_text(encoding="utf-8"))
        body = c["bodyVariants"][0]
        bt = body["bodyTransforms"]["idle"]
        self.kb = PLAYER_BASE_HEIGHT_PX / 1448 * bt["scale"]  # units per canvas px
        self.body_y = bt["offsetY"]
        self.face = next(p for p in body["poses"] if p["poseId"] == "idle")["anchors"]["face"]
        self.areas = {f["categoryId"]: f["featureArea"] for f in c["families"] if f.get("featureArea")}
        self.apps = {a["appearanceId"]: a for a in c["appearances"]}

    def canvas(self, ux, uy):
        return 543 + ux / self.kb, 1448 + (uy - self.body_y) / self.kb

    def feature_point(self, cat):
        p = self.areas[cat]["defaultPoint"]
        return self.canvas(self.face["x"] + p["x"], self.face["y"] + p["y"])


def premul_resize(im: Image.Image, w: int, h: int) -> Image.Image:
    return im.convert("RGBa").resize((max(1, w), max(1, h)), Image.LANCZOS).convert("RGBA")


def paste(dst: np.ndarray, src: Image.Image, x: int, y: int):
    """Alpha-over a piece onto a float RGBA canvas (straight alpha) at integer x, y."""
    s = np.asarray(src).astype(np.float32) / 255
    h, w = s.shape[:2]
    x0, y0, x1, y1 = max(0, x), max(0, y), min(dst.shape[1], x + w), min(dst.shape[0], y + h)
    if x1 <= x0 or y1 <= y0:
        return
    s = s[y0 - y:y1 - y, x0 - x:x1 - x]
    d = dst[y0:y1, x0:x1]
    a = s[..., 3:4]
    out_a = a + d[..., 3:4] * (1 - a)
    rgb = (s[..., :3] * a + d[..., :3] * d[..., 3:4] * (1 - a)) / np.maximum(out_a, 1e-6)
    d[..., :3], d[..., 3:4] = rgb, out_a


def place_feature(live: Live, path: Path, cat: str, anchor_from: Path | None = None):
    """The layer placed like an anchored feature: its featureAnchor (opaque-box centre; brows use their eyes')
    on the category's default point, at HEAD_FIT. Returns (canvas-size float RGBA, k)."""
    im = Image.open(path).convert("RGBA")
    ref = Image.open(anchor_from).convert("RGBA") if anchor_from else im
    x0, y0, x1, y1 = ref.getchannel("A").point(lambda v: 255 if v > 40 else 0).getbbox()
    ax, ay = (x0 + x1) / 2, (y0 + y1) / 2
    k = HEAD_FIT
    px, py = live.feature_point(cat)
    out = np.zeros((1448, 1086, 4), np.float32)
    w, h = round(im.width * k), round(im.height * k)
    paste(out, premul_resize(im, w, h), round(px - ax * k), round(py - ay * k))
    return out, k


def line_ink(mouth: np.ndarray):
    """The mouth line's ink: (straight RGB of its opaque core, stroke weight in canvas px = the median per-column
    alpha sum over the middle half of the mouth's box)."""
    a = mouth[..., 3]
    core = a > 0.9
    rgb = np.median(mouth[core][:, :3], axis=0) if core.any() else np.array([85, 39, 16], np.float32) / 255
    b = bbox(mouth)
    q = (b[2] - b[0]) // 4
    weight = float(np.median(a[:, b[0] + q:b[2] - q].sum(axis=0)))
    return rgb.astype(np.float32), weight


def dash_nose(style: str, px: float, py: float, eye_w: float, rgb: np.ndarray, weight: float, far_dir: float = FAR_DIR):
    """A procedural dash nose (DASH_NOSES) as a canvas-size float RGBA layer, its alpha > 0.16 box centred on (px, py).
    The polyline is resampled densely; each pixel takes the nearest sample's distance d and arc position t, and its
    alpha is the stroke coverage clip(w(t) / 2 - d + 0.5) with w(t) = weight (TAPER + (1 - TAPER) sin(pi t)^0.5)."""
    pts, k = DASH_NOSES[style]
    L = k * eye_w
    p = np.array([(far_dir * x * L, y * L) for x, y in pts], np.float64)
    seg = np.linalg.norm(np.diff(p, axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    n = max(2, int(s[-1] * 8))
    ts = np.linspace(0, s[-1], n)
    samp = np.stack([np.interp(ts, s, p[:, 0]), np.interp(ts, s, p[:, 1])], 1)
    wt = weight * (DASH_TAPER + (1 - DASH_TAPER) * np.sin(np.pi * ts / s[-1]) ** 0.5)

    def render(ox, oy):
        r = int(math.ceil(weight)) + 3
        x0, x1 = int(math.floor(ox + samp[:, 0].min())) - r, int(math.ceil(ox + samp[:, 0].max())) + r
        y0, y1 = int(math.floor(oy + samp[:, 1].min())) - r, int(math.ceil(oy + samp[:, 1].max())) + r
        gy, gx = np.mgrid[y0:y1, x0:x1].astype(np.float64) + 0.5
        d = np.hypot(gx[..., None] - ox - samp[:, 0], gy[..., None] - oy - samp[:, 1])
        cov = np.clip(wt / 2 - d + 0.5, 0, 1).max(axis=-1)  # per sample coverage, the strongest wins
        out = np.zeros((1448, 1086, 4), np.float32)
        out[y0:y1, x0:x1, :3] = rgb
        out[y0:y1, x0:x1, 3] = cov
        return out

    lay = render(px, py)
    b = bbox(lay)  # recentre: the alpha box centre on the point (sub-px)
    return render(2 * px - (b[0] + b[2]) / 2, 2 * py - (b[1] + b[3]) / 2)


def place_hair(live: Live, aid: str):
    a = live.apps[aid]
    p = a["placements"]["idle"]
    im = Image.open(ASSETS / a["assetKey"]).convert("RGBA")
    sx, sy = p["scaleX"], p.get("scaleY", p["scaleX"])
    kx, ky = sx / live.kb, sy / live.kb
    cx, cy = live.canvas(live.face["x"] + p.get("offsetX", 0), live.face["y"] + p.get("offsetY", 0))
    w, h = round(im.width * kx), round(im.height * ky)
    out = np.zeros((1448, 1086, 4), np.float32)
    paste(out, premul_resize(im, w, h), round(cx - p.get("pivotX", 0.5) * w), round(cy - p.get("pivotY", 0.5) * h))
    return out


def egg_rows(head_alpha: np.ndarray, ox: float, oy: float):
    """Per canvas row: (centre, half-width) of the head egg's opaque span (texture placed at ox, oy)."""
    rows = {}
    for ty in range(head_alpha.shape[0]):
        cols = np.where(head_alpha[ty] > 128)[0]
        if len(cols) > 8:
            rows[int(round(oy + ty))] = (ox + (cols[0] + cols[-1] + 1) / 2, (cols[-1] + 1 - cols[0]) / 2)
    return rows


def mirror(layer: np.ndarray, axis: float) -> np.ndarray:
    """Mirror a canvas layer about the vertical line x = axis (column x -> 2 axis - 1 - x)."""
    a = int(round(2 * axis))
    out = np.zeros_like(layer)
    src = layer[:, ::-1]
    sh = a - layer.shape[1]
    if sh >= 0:
        out[:, sh:] = src[:, :layer.shape[1] - sh]
    else:
        out[:, :sh] = src[:, -sh:]
    return out


def split_halves(layer: np.ndarray, axis: float):
    far, near = layer.copy(), layer.copy()
    a = int(round(axis))
    far[:, a:] = 0
    near[:, :a] = 0
    return far, near


def narrow_eyes(eyes: np.ndarray, axis: float, width: float) -> np.ndarray:
    """Refine P6: each eye scaled
    horizontally by `width` about its own centre (the alpha > 0.16 box centre of its half of the layer). Height and
    the centre-to-centre spacing are kept. Runs on the front-frame layer, before the blink frames are built from it
    and before the projection, so the open and blink eyes match and the turn never widens them."""
    if abs(width - 1) < 1e-6:
        return eyes
    out = np.zeros_like(eyes)
    for half in split_halves(eyes, axis):
        b = bbox(half)
        if b is None:
            continue
        cx = (b[0] + b[2] - 1) / 2
        pm = np.concatenate([half[..., :3] * half[..., 3:4], half[..., 3:4]], -1)
        ys, xs = np.mgrid[0:eyes.shape[0], 0:eyes.shape[1]].astype(np.float32)
        src_x = cx + (xs - cx) / width
        sc = np.stack([ndimage.map_coordinates(pm[..., c], [ys, src_x], order=1, mode="constant") for c in range(4)], -1)
        a = sc[..., 3:4]
        rgb = np.where(a > 1e-6, sc[..., :3] / np.maximum(a, 1e-6), 0)
        o_a = a + out[..., 3:4] * (1 - a)
        out[..., :3] = (rgb * a + out[..., :3] * out[..., 3:4] * (1 - a)) / np.maximum(o_a, 1e-6)
        out[..., 3:4] = o_a
    return out


def bbox(layer: np.ndarray):
    ys, xs = np.where(layer[..., 3] > 0.16)
    return (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1) if len(xs) else None


def crop_img(layer: np.ndarray, b) -> Image.Image:
    x0, y0, x1, y1 = b
    return Image.fromarray(np.clip(layer[y0:y1, x0:x1] * 255 + 0.5, 0, 255).astype(np.uint8))


def turn_face(pieces, rows, phi, narrow_phi):
    """pieces: dicts {kind, side, layer}. Returns placed pieces [(img, x, y)] + per-piece report + ok flag.
    Near eye: its centre mapped on the sphere, full size. Far eye: its centre mapped, width x (1 - FAR_NARROW sin),
    then squeezed (moved in, and narrowed down to FAR_MIN_K) to keep EDGE_MARGIN from the egg's outer edge and MIN_GAP
    x the drawn eye gap from the near eye. Brows ride their eye (same shift, scale and pivot). ok = False when the far
    eye cannot fit at FAR_MIN_K (the caller then lowers PHI for the whole face)."""
    def row(y):
        return rows[min(rows, key=lambda yy: abs(yy - y))]

    def sphere(x, y, bump=0.0):
        cen, r = row(y)
        u = max(-1.0, min(1.0, (x - cen) / r))
        return cen + r * (u * math.cos(phi) - (math.sqrt(1 - u * u) + bump) * math.sin(phi))

    by = {(p["kind"], p["side"]): p for p in pieces}
    boxes = {key: bbox(p["layer"]) for key, p in by.items()}
    tf = {}  # key -> (pivot x, dx, kx, dark)
    ok = True
    ne, fe = boxes.get(("eye", "near")), boxes.get(("eye", "far"))
    if ne:
        c = (ne[0] + ne[2]) / 2
        tf[("eye", "near")] = (c, sphere(c, (ne[1] + ne[3]) / 2) - c, 1.0, 1.0)
    if fe:
        c, w = (fe[0] + fe[2]) / 2, fe[2] - fe[0]
        cy = (fe[1] + fe[3]) / 2
        k = 1 - FAR_NARROW * math.sin(narrow_phi)
        nc = sphere(c, cy)
        # the far group's outer edge (eye or brow, whichever reaches further out) and the near eye's inner edge
        fb = boxes.get(("brow", "far"))
        out_off = max(c - fe[0], c - fb[0] if fb else 0.0)  # pivot-to-outer-edge distance before scaling
        cen, half = row(cy)
        left_lim = cen - half + EDGE_MARGIN
        right_lim = None
        if ne:
            gap0 = ne[0] - fe[2]
            right_lim = ne[0] + tf[("eye", "near")][1] - MIN_GAP * gap0
        if nc - out_off * k < left_lim:
            nc = left_lim + out_off * k
        if right_lim is not None and nc + (fe[2] - c) * k > right_lim:
            # squeeze: narrow until the eye fits between the limits
            k2 = (right_lim - left_lim) / (out_off + (fe[2] - c))
            if k2 < FAR_MIN_K:
                ok = False
            k = max(FAR_MIN_K, min(k, k2))
            nc = left_lim + out_off * k
        tf[("eye", "far")] = (c, nc - c, k, 1 - FAR_DARK * math.sin(narrow_phi))
    for side in ("near", "far"):
        if ("eye", side) in tf:
            tf[("brow", side)] = tf[("eye", side)]
    for kind in ("nose", "mouth"):
        b = boxes.get((kind, "mid"))
        if b:
            c = (b[0] + b[2]) / 2
            k = 1 - MOUTH_NARROW * math.sin(narrow_phi) if kind == "mouth" else 1.0
            tf[(kind, "mid")] = (c, sphere(c, (b[1] + b[3]) / 2, BUMP[kind]) - c, k, 1.0)
    out, rep = [], []
    for key, p in by.items():
        b = boxes[key]
        if b is None or key not in tf:
            continue
        pivot, dx, kx, dark = tf[key]
        img = crop_img(p["layer"], b)
        if abs(kx - 1) > 1e-6:
            img = premul_resize(img, round(img.width * kx), img.height)
        if dark != 1.0:
            arr = np.asarray(img).astype(np.float32)
            arr[..., :3] *= dark
            img = Image.fromarray(np.clip(arr + 0.5, 0, 255).astype(np.uint8))
        nx = pivot + dx + (b[0] - pivot) * kx
        out.append((img, int(round(nx)), int(b[1])))
        cen, half = row((b[1] + b[3]) / 2)
        rep.append({"piece": f"{key[0]}-{key[1]}", "anchor": [round((b[0] + b[2]) / 2, 1), round((b[1] + b[3]) / 2, 1)],
                    "dx": round(dx, 1), "kx": round(kx, 3), "dark": round(dark, 3), "left": int(round(nx)),
                    "right": int(round(nx)) + img.width, "eggLeft": round(cen - half, 1), "eggRight": round(cen + half, 1)})
    return out, rep, ok


def far_margin(rep):
    """Smallest gap (canvas px) between a far eye/brow's left edge and the egg's left edge at its rows."""
    return min([r["left"] - r["eggLeft"] for r in rep if r["piece"] in ("eye-far", "brow-far")] or [1e9])


LOCK_U = 0.8  # refine P4 fringe edge: |u| from which the far shift is fully faded below the lock row


def _smooth(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


LOCK_RAMP = 40  # refine P4 (item 6): rows over which the far shift fades out below the egg's widest row


def hair_warp(hair: np.ndarray, axis: float, egg_half: float, phi: float, alpha: float, shift: float | None = None,
              lock_row: int | None = None):
    """lock_row (refine P4, REFINE-PLAN item 6): below the egg's widest row the far side-lock keeps its unwarped place
    (the far shift fades to 0 over LOCK_RAMP rows), so its inner edge never pulls off the cheek (the egg outline stays
    put); above it, the round-2 warp is unchanged."""
    a = hair[..., 3]
    hgt, wid = a.shape
    # each side's own row extent (left of the axis, right of it), lightly smoothed over rows and never below the raw
    # extent, so the silhouette ends stay pinned and strand gaps do not tear the shift between rows
    ext = np.zeros((2, hgt), np.float32)
    for y in range(hgt):
        cols = np.where(a[y] > 0.05)[0]
        if len(cols):
            ext[0, y], ext[1, y] = max(1.0, axis - cols[0]), max(1.0, cols[-1] + 1 - axis)
    if not ext.any():
        return hair, 0.0
    ext = np.maximum(ext, ndimage.gaussian_filter1d(ext, 6, axis=1))
    ext = np.maximum(ext, 0.5 * egg_half)
    s = HAIR_SHIFT * egg_half * math.sin(phi) if shift is None else shift
    xs = np.arange(wid, dtype=np.float32) + 0.5
    out = np.zeros_like(hair)
    pm = hair.copy()
    pm[..., :3] *= pm[..., 3:4]
    yy = np.arange(hgt)
    src_x = np.zeros((hgt, wid), np.float32)
    fold = -1.0  # max backward step of the forward map (> 0 = the warp folds)
    for y in yy:
        # far side (screen-left): dx = -S (1 - u^2); near side: -S (1 - u)^2 (1 + 2u) (smoothstep, flat at both
        # ends) so the near edge over the scalp barely moves and no bald strip opens behind the hair
        ss = min(s, 0.49 * ext[0, y])
        u = (xs - axis) / np.where(xs < axis, ext[0, y], ext[1, y])
        u = np.clip(u, -1, 1)
        lock = 1.0
        if lock_row is not None and y > lock_row:
            t = min(1.0, (y - lock_row) / LOCK_RAMP)
            lock = 1.0 - t * t * (3 - 2 * t)
        # refine P4 fringe edge: the lock fade only reaches the outer far side (|u| >= LOCK_U); near the axis the far
        # profile stays 1 like the near one. Fading the whole far half made the shift jump by S (1 - lock) at the
        # axis, which folded the warp there (a vertical, ink-less cut through the central fringe lock below the
        # lock row and a dangling ink stub above it on R15/L15).
        lk = lock + (1.0 - lock) * (1.0 - _smooth(-u / LOCK_U))
        prof = np.where(u < 0, lk * (1 - u * u), (1 - u) ** 2 * (1 + 2 * u))
        fwd = xs - ss * prof
        fold = max(fold, float(-np.diff(fwd).min()))
        src_x[y] = np.interp(xs, fwd, xs) - 0.5
    coords = [np.repeat(yy[:, None], wid, 1).astype(np.float32), src_x]
    for ch in range(4):
        out[..., ch] = ndimage.map_coordinates(pm[..., ch], coords, order=1, mode="constant")
    rgb = out[..., :3] / np.maximum(out[..., 3:4], 1e-6)
    out[..., :3] = np.where(out[..., 3:4] > 1e-6, rgb, 0)
    # far-side crescent: per row, the hair's own span
    if alpha > 0:
        for y in yy:
            cols = np.where(out[y, :, 3] > 0.05)[0]
            if len(cols) < 4:
                continue
            mid, half = (cols[0] + cols[-1] + 1) / 2, (cols[-1] + 1 - cols[0]) / 2
            u = (xs - mid) / half
            out[y, :, :3] *= np.array([far_shade(v, 1.0, alpha) for v in u], np.float32)[:, None]
    return np.clip(out, 0, 1), s


FRINGE_GAP = 3.0  # refine P4 (item 5): canvas px kept between the hair and either eye's upper-lid ink
FRINGE_FEATHER = 2.0
FRINGE_EXT = 40  # rows below the eye band over which the cut columns stay cut


def fringe_clear(hair: np.ndarray, face: np.ndarray, eyes_src: np.ndarray):
    """Clip the hair alpha over the eyes so the fringe ends >= FRINGE_GAP px above the upper-lid ink of either eye
    (the face layers are untouched; the head egg shows through as skin). The eye rows come from the eyes layer's
    rows (+-6 px for the projection); per column of the face inside those rows the first opaque row is the lid top."""
    eb = bbox(eyes_src)
    if eb is None:
        return hair, {}
    x0, y0, x1, y1 = eb
    fa = face[..., 3]
    band = fa[max(0, y0 - 6):y1 + 6] > 0.5
    cols = np.where(band.any(0))[0]
    if not len(cols):
        return hair, {}
    hgt = hair.shape[0]
    keep = np.ones(hair.shape[:2], np.float32)
    yy = np.arange(hgt, dtype=np.float32)[:, None]
    lid = np.full(hair.shape[1], np.inf, np.float32)
    lid[cols] = np.argmax(band[:, cols], axis=0) + max(0, y0 - 6)
    # widen by the feather so the clip edge is soft sideways too
    lid = ndimage.minimum_filter1d(lid, 5)
    cut = lid - FRINGE_GAP  # the hair fades out over FRINGE_FEATHER px ending at lid - gap
    keep = np.clip((cut[None, :] - yy) / FRINGE_FEATHER, 0, 1)
    keep[:, ~np.isfinite(lid)] = 1.0
    # below the eyes: side locks untouched, except that the band's cut columns carry on down FRINGE_EXT rows, so a
    # lock cut at the eye corner keeps one straight (inked) cut edge instead of leaving its lower tip poking out under
    # the cleared band as a stray ink stub (refine P4 fringe edge)
    yb = int(y1 + 6)
    keep[yb:yb + FRINGE_EXT, :] = keep[yb - 1][None, :]
    keep[yb + FRINGE_EXT:, :] = 1.0
    out = hair.copy()
    before = (hair[..., 3] > 0.5)
    out[..., 3] *= keep
    lid_rows = lid[np.isfinite(lid)]
    covered = before & (yy > cut[None, :]) & np.isfinite(cut)[None, :] & (yy < y1 + 6)
    strays = _drop_strays(hair, out)
    ink, width, inked = _ink_cut_edge(hair, out)
    return out, {"lidTopMin": float(lid_rows.min()), "clearedPx": int(covered.sum()), "gapPx": FRINGE_GAP,
                 "strayPxRemoved": strays, "cutInk": ink, "cutInkWidthPx": width, "cutInkPx": inked}


STRAY_MAX = 600  # canvas px: a clipped-off remnant at most this big is dropped (refine P4 fringe edge)


def _drop_strays(hair: np.ndarray, out: np.ndarray) -> int:
    """Drop hair pieces the clip cut loose: a component of the clipped alpha (> 0.05) of at most STRAY_MAX px that
    was part of a bigger component before the clip (a lock's ink tail left under the cleared band). Pieces that were
    already separate in the drawing are kept."""
    pre_lab, _ = ndimage.label(hair[..., 3] > 0.05, np.ones((3, 3)))
    pre_size = np.bincount(pre_lab.ravel())
    lab, n = ndimage.label(out[..., 3] > 0.05, np.ones((3, 3)))
    size = np.bincount(lab.ravel())
    removed = 0
    for i in range(1, n + 1):
        if size[i] > STRAY_MAX:
            continue
        m = lab == i
        if pre_size[np.bincount(pre_lab[m]).argmax()] > size[i] + STRAY_MAX:
            out[..., 3][m] = 0.0
            removed += int(size[i])
    return removed


def _ink_cut_edge(hair: np.ndarray, out: np.ndarray):
    """Give the clip's cut edge the hair's own outline ink. Measured on the unclipped hair: the ink colour is the
    median of the dark texels (lum below the 35th percentile) within 2 px of the outer alpha edge; the width is the
    dark-texel area within 8 px of that edge divided by the edge length. The ink is painted inside the kept hair along
    the cut (texels within that width of the removed hair), with a 1 px soft inner edge; alpha is unchanged."""
    a0 = hair[..., 3] > 0.5
    outside = ~a0
    d_out = ndimage.distance_transform_edt(~outside)  # distance from outside the hair, inside it
    edge = a0 & (d_out <= 1.0)
    lum = hair[..., :3] @ np.array([0.299, 0.587, 0.114], np.float32)
    near = a0 & (d_out <= 2.0)
    thr = np.percentile(lum[near], 35)
    dark = a0 & (lum <= thr)
    ink = np.median(hair[..., :3][near & dark], axis=0)
    width = float(np.clip((dark & (d_out <= 8.0)).sum() / max(1, edge.sum()), 2.0, 8.0))
    removed = a0 & (out[..., 3] < 0.5)
    if not removed.any():
        return [round(float(v) * 255) for v in ink], round(width, 2), 0
    d = ndimage.distance_transform_edt(~removed)
    wgt = np.clip(width + 0.5 - d, 0.0, 1.0) * (out[..., 3] > 0.02)
    out[..., :3] = out[..., :3] * (1 - wgt[..., None]) + ink[None, None, :] * wgt[..., None]
    return [round(float(v) * 255) for v in ink], round(width, 2), int((wgt > 0.5).sum())


BLINK_INK_LUM = 0.16  # the almond-calm lid ink is lum ~0.12; the lash shade under it ~0.20, the iris ~0.30
BLINK_INK_MAX = 14  # rows: the upper-lid ink run is capped (the ink is ~10 rows at HEAD_FIT)
BLINK_FRAMES = {"half": [58, 61], "closed": [59, 60]}  # idle_weight_shift frames (30 fps); open again at 62


def blink_eyes(eyes: np.ndarray):
    """Refine P3 (REFINE-PLAN item 3): half and closed eyes built deterministically from the open eye layer (front
    frame, before the turn). Per column with eye alpha: t / b = first / last row with alpha > 0.5, the upper-lid ink =
    the run of dark texels (lum <= BLINK_INK_LUM) from t (plus the soft rows above t), at most BLINK_INK_MAX and half
    the eye height. The lid band moves down by f (b - lid bottom) (half f = 0.5, closed f = 1, so the closed lid lands
    on the lower-lid line and follows its curve); everything above the moved band is cleared (the head skin under the
    eye shows), the iris and sclera below it stay (half) or go (closed: only the lower-lid ink stays, under the band).
    Vertical moves only, never past b: no column gains alpha above its open top or below its open bottom, so the eyes
    never widen (gated on the projected layers in build())."""
    hgt, wid = eyes.shape[:2]
    a = eyes[..., 3]
    lum = eyes[..., :3] @ np.array([0.299, 0.587, 0.114], np.float32)
    pm = eyes.copy()
    pm[..., :3] *= pm[..., 3:4]
    outs = {"half": np.zeros_like(eyes), "closed": np.zeros_like(eyes)}
    yy = np.arange(hgt, dtype=np.float64)
    cols = np.where((a > 0.5).any(0))[0]
    tops = np.array([np.argmax(a[:, x] > 0.5) for x in cols])
    # lash spikes above the lid line: a column whose top is > 1 px above the median of its 9 neighbours starts its
    # lid band at that median instead (the spike is dropped, it would ride down as a stray tick)
    tmed = ndimage.median_filter(tops, 9, mode="nearest")
    for x, t0, tm in zip(cols, tops, tmed):
        rows = np.where(a[:, x] > 0.5)[0]
        t, b = int(rows[0]), int(rows[-1])
        soft = np.where(a[:, x] > 0.02)[0]
        ts, bs = int(soft[0]), int(soft[-1])
        if t0 < tm - 1:
            t = ts = int(tm) - 1
        # the first 1-3 rows are the ink's antialiased (lighter) edge: the run starts at the first dark row there
        cap = min(BLINK_INK_MAX, max(2, (b - t + 1) // 2))
        k = next((j for j in range(4) if t + j <= b and lum[t + j, x] <= BLINK_INK_LUM), None)
        if k is None:
            k = 1
        else:
            while t + k <= b and lum[t + k, x] <= BLINK_INK_LUM and k < cap:
                k += 1
        lid_bot = t + k - 1
        band = pm[:, x].astype(np.float64)
        band[:ts] = 0
        band[lid_bot + 1:] = 0
        lower = pm[:, x].astype(np.float64)
        # lower-lid ink: the dark run ending at b
        kb = next((j for j in range(4) if b - j > lid_bot and lum[b - j, x] <= BLINK_INK_LUM), None)
        if kb is None:
            kb = 0
        else:
            while b - kb > lid_bot and lum[b - kb, x] <= BLINK_INK_LUM and kb < BLINK_INK_MAX:
                kb += 1
        for name, f in (("half", 0.5), ("closed", 1.0)):
            d = f * (b - lid_bot)
            moved = np.stack([np.interp(yy - d, yy, band[:, c], left=0, right=0) for c in range(4)], 1)
            base = lower.copy()
            if name == "half":
                base[: int(math.floor(lid_bot + d)) + 1] = 0  # above (and under) the moved lid: cleared
            else:
                base[: b - kb + 1 if kb else bs + 1] = 0  # only the lower-lid ink (and its soft bottom) stays
            # premultiplied alpha-over: moved band over the base
            col = moved + base * (1 - moved[:, 3:4])
            col[bs + 1:] = 0  # never below the open eye's own bottom
            outs[name][:, x] = col
    for o in outs.values():
        al = o[..., 3:4]
        o[..., :3] = np.where(al > 1e-6, o[..., :3] / np.maximum(al, 1e-6), 0)
        np.clip(o, 0, 1, out=o)
    return outs["half"], outs["closed"]


def egg_row(rows, y):
    return rows[y] if y in rows else rows[min(rows, key=lambda yy: abs(yy - y))]


def project_layer(layer: np.ndarray, rows, phi: float) -> np.ndarray:
    """: the layer painted on the egg's front surface and turned with the head by phi.
    Per canvas row the egg is a circle of its own centre c and half-width R (a surface of revolution about the head's
    vertical axis, depth = width): a texel at u = (x - c) / R sits at surface angle asin(u) and is seen at
    x' = c + R sin(asin(u) - phi). Inverse-mapped per output column (u = sin(asin(u') + phi)), bilinear in premultiplied
    alpha. So every feature compresses toward the far limb (by cos(asin u - phi) / cos(asin u)), near features widen
    very slightly, and the shift is the projection itself (no slide, no uniform scale). Texels turned past the far
    limb (asin u - phi < -90 deg) are hidden."""
    hgt, wid = layer.shape[:2]
    ys = np.where(layer[..., 3].max(axis=1) > 0)[0]
    out = np.zeros_like(layer)
    if not len(ys):
        return out
    pm = layer.copy()
    pm[..., :3] *= pm[..., 3:4]
    xs = np.arange(wid, dtype=np.float64) + 0.5
    y0, y1 = ys[0], ys[-1] + 1
    src = np.full((y1 - y0, wid), -10.0)
    for y in range(y0, y1):
        c, r = egg_row(rows, y)
        up = (xs - c) / r
        ok = np.abs(up) <= 1
        a = np.arcsin(np.clip(up, -1, 1)) + phi
        ok &= a <= math.pi / 2
        src[y - y0] = np.where(ok, c + r * np.sin(np.minimum(a, math.pi / 2)) - 0.5, -10.0)
    coords = [np.repeat(np.arange(y0, y1)[:, None], wid, 1).astype(np.float64), src]
    for ch in range(4):
        out[y0:y1, :, ch] = ndimage.map_coordinates(pm[..., ch], coords, order=1, mode="constant")
    a = out[..., 3:4]
    out[..., :3] = np.where(a > 1e-6, out[..., :3] / np.maximum(a, 1e-6), 0)
    return np.clip(out, 0, 1)


def egg_shade(layer: np.ndarray, rows, alpha: float) -> np.ndarray:
    """The head's own far-side crescent (turnfront.far_shade on the egg's row span), so the far eye darkens only as
    subtly as the skin under it (up to ALPHA_PER_SIN sin theta = 9 % at 15 deg, at the far limb)."""
    out = layer.copy()
    xs = np.arange(layer.shape[1]) + 0.5
    for y in np.where(layer[..., 3].max(axis=1) > 0)[0]:
        c, r = egg_row(rows, y)
        out[y, :, :3] *= np.array([far_shade(v, 1.0, alpha) for v in (xs - c) / r], np.float32)[:, None]
    return out


def project_report(layers, face, rows, axis, phi):
    """Per piece (far/near eye, far/near brow, nose, mouth): box before and after, shift of the box centre and width
    ratio (measured on the projected layer)."""
    rep = []
    for name, kind in (("eyes", "eye"), ("brows", "brow"), ("nose", "nose"), ("mouth", "mouth")):
        src = layers[name]
        dst = project_layer(src, rows, phi)
        b0 = bbox(src)
        if b0 is None:
            continue
        c, r = egg_row(rows, (b0[1] + b0[3]) / 2)
        cut = c + r * math.sin(math.asin(max(-1.0, min(1.0, (axis - c) / r))) - phi)  # where the axis is seen
        sf, sn = split_halves(src, axis)
        df, dn = split_halves(dst, cut)
        parts = (("far", sf, df), ("near", sn, dn)) if kind in ("eye", "brow") else (("mid", src, dst),)
        for side, a, b in parts:
            ba, bb = bbox(a), bbox(b)
            if ba is None or bb is None:
                continue
            rep.append({"piece": f"{kind}-{side}", "before": [int(v) for v in ba], "after": [int(v) for v in bb],
                        "dx": round((bb[0] + bb[2] - ba[0] - ba[2]) / 2, 1), "kx": round((bb[2] - bb[0]) / (ba[2] - ba[0]), 3)})
    return rep


def project_piece(layer: np.ndarray, rows, phi: float, anchor_x: float, ease: float = 0.0) -> np.ndarray:
    """: the  surface projection with its local
    horizontal scale clamped to <= 1. Per row the projection's slope is f'(u) = cos(asin u - phi) / sqrt(1 - u^2) (< 1
    toward the far limb, > 1 on the near side). The piece is anchored at anchor_x, which lands exactly where the
    projection puts it (c + R sin(asin u_a - phi): the position shift is the projection's), and the map is integrated
    outward from the anchor with slope min(f', 1): far-side parts still foreshorten (gently, as in 2b), nothing ever
    widens, and the warp stays curved (the slope varies per column). Texels past the far limb collapse (hidden).
    Refine P6: `ease` (canvas px, signed) moves the landed anchor after the projection (the edge-clearance ease)."""
    hgt, wid = layer.shape[:2]
    ys = np.where(layer[..., 3].max(axis=1) > 0)[0]
    out = np.zeros_like(layer)
    if not len(ys):
        return out
    pm = layer.copy()
    pm[..., :3] *= pm[..., 3:4]
    xs = np.arange(wid, dtype=np.float64) + 0.5
    y0, y1 = ys[0], ys[-1] + 1
    src = np.full((y1 - y0, wid), -10.0)
    for y in range(y0, y1):
        c, r = egg_row(rows, y)
        u = np.clip((xs - c) / r, -0.999999, 0.999999)
        a = np.arcsin(u) - phi
        slope = np.where(a > -math.pi / 2, np.cos(a) / np.sqrt(1 - u * u), 1e-4)
        slope = np.clip(slope, 1e-4, 1.0)
        ua = max(-0.999999, min(0.999999, (anchor_x - c) / r))
        xa = c + r * math.sin(math.asin(ua) - phi) + ease
        cum = np.concatenate([[0.0], np.cumsum(slope[:-1])])  # integral of the slope from column 0 (unit columns)
        ia = anchor_x - 0.5
        cum_a = np.interp(ia, np.arange(wid), cum)
        fwd = xa + (cum - cum_a)
        src[y - y0] = np.interp(xs, fwd, xs, left=-9.5, right=-9.5) - 0.5  # output centre -> source index
    coords = [np.repeat(np.arange(y0, y1)[:, None], wid, 1).astype(np.float64), src]
    for ch in range(4):
        out[y0:y1, :, ch] = ndimage.map_coordinates(pm[..., ch], coords, order=1, mode="constant")
    a = out[..., 3:4]
    out[..., :3] = np.where(a > 1e-6, out[..., :3] / np.maximum(a, 1e-6), 0)
    return np.clip(out, 0, 1)


def edge_clearance(layer: np.ndarray, rows, axis: float):
    """Refine P6 (G11): the smallest horizontal gap, over the piece's rows, between its outer alpha extreme (> 0.16)
    and the egg silhouette (the head alpha edge) on the piece's own side of the axis. None for an empty piece."""
    b = bbox(layer)
    if b is None:
        return None
    left = (b[0] + b[2]) / 2 < axis
    a = layer[..., 3] > 0.16
    gaps = []
    for y in range(b[1], b[3]):
        xs = np.where(a[y])[0]
        if not len(xs):
            continue
        c, r = egg_row(rows, y)
        gaps.append(xs[0] - (c - r) if left else (c + r) - (xs[-1] + 1))
    return float(min(gaps))


def project_clamped(layers, rows, axis, phi, anchors=None, eases=None, clear_min=None):
    """Each piece (far/near eye, far/near brow, nose, mouth) through project_piece. Anchors: each eye's box centre;
    each brow uses its eye's anchor (brows ride their eyes); nose and mouth their box centres. Returns the face layer
    and per-piece box shift / width ratio.
    Refine P6:
    with clear_min set, an eye whose outer-corner clearance to the egg silhouette falls under clear_min x its own
    straight-front clearance is eased back toward the axis (whole px) until it clears; its brow takes the same ease.
    Only that eye moves, so the rest of the face keeps the full turn. eases = (far, near) px reuses a found ease (the
    blink faces)."""
    ef, en = split_halves(layers["eyes"], axis)
    bf, bn = split_halves(layers["brows"], axis)
    centre = lambda lay: (lambda b: None if b is None else (b[0] + b[2]) / 2)(bbox(lay))  # noqa: E731
    af, an = (centre(ef), centre(en)) if anchors is None else anchors
    eases = list(eases) if eases is not None else [0.0, 0.0]
    clear = {}
    for i, (side, lay, anc) in enumerate((("far", ef, af), ("near", en, an))):
        if anc is None:
            continue
        front = edge_clearance(lay, rows, axis)  # phi = 0 is the identity map
        w = project_piece(lay, rows, phi, anc, eases[i])
        if clear_min is not None and front is not None:
            inward = 1.0 if anc < axis else -1.0
            while edge_clearance(w, rows, axis) < clear_min * front and abs(eases[i]) < 40:
                eases[i] += inward
                w = project_piece(lay, rows, phi, anc, eases[i])
        clear[side] = {"frontPx": front, "turnedPx": edge_clearance(w, rows, axis), "easePx": eases[i]}
        clear[side]["ratio"] = None if not front else round(clear[side]["turnedPx"] / front, 3)
    pieces = [("eye-far", ef, af, eases[0]), ("eye-near", en, an, eases[1]),
              ("brow-far", bf, af if af is not None else centre(bf), eases[0]),
              ("brow-near", bn, an if an is not None else centre(bn), eases[1]),
              ("nose-mid", layers["nose"], centre(layers["nose"]), 0.0),
              ("mouth-mid", layers["mouth"], centre(layers["mouth"]), 0.0)]
    face = np.zeros((1448, 1086, 4), np.float32)
    cats = {k: np.zeros((1448, 1086, 4), np.float32) for k in FACE_PARTS}
    rep = []
    for name, lay, anc, ease in pieces:
        b0 = bbox(lay)
        if b0 is None or anc is None:
            continue
        w = project_piece(lay, rows, phi, anc, ease)
        paste(face, crop_img(w, (0, 0, 1086, 1448)), 0, 0)
        paste(cats[PIECE_PART[name.split("-")[0]]], crop_img(w, (0, 0, 1086, 1448)), 0, 0)
        b1 = bbox(w)
        rep.append({"piece": name, "before": [int(v) for v in b0], "after": [int(v) for v in b1],
                    "dx": round((b1[0] + b1[2] - b0[0] - b0[2]) / 2, 1), "kx": round((b1[2] - b1[0]) / (b0[2] - b0[0]), 3), "anchor": anc,
                    "easePx": ease})
    for r in rep:
        if r["piece"].startswith("eye-"):
            r["clearance"] = clear.get(r["piece"][4:])
    return face, rep, cats


def fringe_shift(hair: np.ndarray, rows, axis: float, phi: float) -> tuple[float, int]:
    """ hair shift from the same projection: the fringe/parting sits on the head's front at the axis (u = 0),
    at the row where the hair over the face ends on the axis column (the fringe tip; the lowest opaque hair row inside
    the egg on that column). The projection moves u = 0 by R sin(phi) at that row's half-width R."""
    col = hair[:, int(round(axis)), 3]
    ys = [y for y in np.where(col > 0.5)[0] if y in rows]
    y = int(max(ys)) if ys else int(min(rows))
    return egg_row(rows, y)[1] * math.sin(phi), y


def build(rig_path: Path, deg: float, combo: dict, hair_mode: str, face_mode: str = "project", mirror_inputs: bool = False,
          blink: bool = False, eye_width: float = 1.0, eye_clear: float = EYE_CLEAR_TARGET):
    doc = json.loads(rig_path.read_text(encoding="utf-8"))
    atlas_path = rig_path.with_name(rig_path.name.replace(".anim.json", ".atlas.json"))
    atlas = json.loads(atlas_path.read_text(encoding="utf-8"))
    page = atlas["pages"][0]
    page_img = Image.open(atlas_path.parent / page["file"]).convert("RGBA")
    skin = doc["skins"][next(iter(doc["skins"]))]
    head_att = skin["attachments"]["head"]["head"]
    reg = page["regions"][head_att["path"]]
    w = setup_world(doc["bones"])
    hm = w["head"]
    hx, hy = apply(hm, head_att["x"], head_att["y"])
    # the head region's centre in the FRONT frame (the turned rig moved the head bone toward the facing side; the
    # front head sits on the body axis x = 0), canvas px
    hc = (hx - hm[0, 2] + doc["canvas"]["originX"], hy + doc["canvas"]["originY"])
    head_alpha = np.asarray(page_img)[reg["y"]:reg["y"] + reg["height"], reg["x"]:reg["x"] + reg["width"], 3]
    tox, toy = hc[0] - reg["width"] / 2, hc[1] - reg["height"] / 2
    rows = egg_rows(head_alpha, tox, toy)
    axis = np.median([c for c, _ in rows.values()])
    egg_half = max(h for _, h in rows.values())

    live = Live()
    theta = math.radians(deg)
    blinks, blink_rep = {}, []
    if blink and face_mode != "project-clamped":
        raise SystemExit("--blink needs --face-mode project-clamped")
    eyes_p = DROPS / LAYER_FILES["eyes"].format(combo["eyes"])
    layers = {
        "eyes": place_feature(live, eyes_p, "eyes")[0],
        "brows": place_feature(live, DROPS / LAYER_FILES["brows"].format(combo["brows"]), "eyes", anchor_from=eyes_p)[0],
        "nose": (np.zeros((1448, 1086, 4), np.float32) if combo["nose"] in (NO_NOSE, *DASH_NOSES)
                 else place_feature(live, DROPS / LAYER_FILES["nose"].format(combo["nose"]), "nose")[0]),
        "mouth": place_feature(live, DROPS / LAYER_FILES["mouth"].format(combo["mouth"]), "mouth")[0],
    }
    if mirror_inputs:
        layers = {k: mirror(v, axis) for k, v in layers.items()}
    layers["eyes"] = narrow_eyes(layers["eyes"], axis, eye_width)
    dash = None
    if combo["nose"] in DASH_NOSES:
        # drawn after the mirror: only the point mirrors, the shape keeps its far-side lean (see DASH_NOSES)
        npx, npy = live.feature_point("nose")
        if mirror_inputs:
            npx = round(2 * axis) - npx
        eb = bbox(split_halves(layers["eyes"], axis)[1])
        ink, weight = line_ink(layers["mouth"])
        layers["nose"] = dash_nose(combo["nose"], npx, npy, eb[2] - eb[0], ink, weight)
        dash = {"style": combo["nose"], "point": [round(npx, 2), round(npy, 2)], "eyeWidthPx": int(eb[2] - eb[0]),
                "lengthPx": round(DASH_NOSES[combo["nose"]][1] * (eb[2] - eb[0]), 1), "weightPx": round(weight, 2),
                "ink": [int(round(v * 255)) for v in ink], "taper": DASH_TAPER, "farDir": FAR_DIR,
                "box": [int(v) for v in bbox(layers["nose"])]}
    ef, en = split_halves(layers["eyes"], axis)
    bf, bn = split_halves(layers["brows"], axis)
    pieces = [{"kind": "eye", "side": "far", "layer": ef}, {"kind": "eye", "side": "near", "layer": en},
              {"kind": "brow", "side": "far", "layer": bf, "follow": True}, {"kind": "brow", "side": "near", "layer": bn, "follow": True},
              {"kind": "nose", "side": "mid", "layer": layers["nose"]}, {"kind": "mouth", "side": "mid", "layer": layers["mouth"]}]
    hair_phi = FACE_GAIN * theta  # the hair keeps the round-2 shift
    if face_mode == "slide":
        phi_target = FACE_GAIN * theta
        phi = phi_target
        for _ in range(60):
            placed, rep, ok = turn_face(pieces, rows, phi, phi_target)
            if phi <= 0 or ok:
                break
            phi = max(0.0, phi - math.radians(1))
        face = np.zeros((1448, 1086, 4), np.float32)
        for img, x, y in placed:
            paste(face, img, x, y)
    elif face_mode == "project-clamped":
        phi_target = phi = theta * PROJECT_GAIN
        face, rep, cats = project_clamped(layers, rows, axis, phi, clear_min=eye_clear if deg and eye_clear > 0 else None)
        eases = tuple(next((r["easePx"] for r in rep if r["piece"] == p), 0.0) for p in ("eye-far", "eye-near"))
        if deg:
            face = egg_shade(face, rows, ALPHA_PER_SIN * math.sin(theta))
            cats = {k: egg_shade(v, rows, ALPHA_PER_SIN * math.sin(theta)) for k, v in cats.items()}
        parts = [(k, cats[k]) for k in FACE_PARTS]
        if blink:
            # the blink faces reuse the open face's eye anchors, so only the lids move
            anchors = tuple(next((r["anchor"] for r in rep if r["piece"] == p), None) for p in ("eye-far", "eye-near"))
            for name, eyes_v in zip(("half", "closed"), blink_eyes(layers["eyes"])):
                _, _, cv = project_clamped({**layers, "eyes": eyes_v}, rows, axis, phi, anchors, eases)
                blinks[name] = egg_shade(cv["eyes"], rows, ALPHA_PER_SIN * math.sin(theta)) if deg else cv["eyes"]
                # gate: each projected eye's alpha box stays inside the open one's (0 px growth)
                for side, an, ea, ov, vv in zip(("far", "near"), anchors, eases, split_halves(layers["eyes"], axis), split_halves(eyes_v, axis)):
                    if an is None:
                        continue
                    bo, bv = bbox(project_piece(ov, rows, phi, an, ea)), bbox(project_piece(vv, rows, phi, an, ea))
                    grow = 0 if bv is None else int(max(bo[0] - bv[0], bo[1] - bv[1], bv[2] - bo[2], bv[3] - bo[3], 0))
                    blink_rep.append({"variant": name, "eye": side, "open": [int(v) for v in bo],
                                      "blink": None if bv is None else [int(v) for v in bv], "growthPx": grow})
    else:
        phi_target = phi = theta * PROJECT_GAIN
        face = np.zeros((1448, 1086, 4), np.float32)
        for name in ("eyes", "brows", "nose", "mouth"):
            paste(face, crop_img(project_layer(layers[name], rows, phi), (0, 0, 1086, 1448)), 0, 0)
        if deg:
            face = egg_shade(face, rows, ALPHA_PER_SIN * math.sin(theta))
        rep = project_report(layers, face, rows, axis, phi)
    hair = place_hair(live, combo["hair"]) if hair_mode != "none" else np.zeros((1448, 1086, 4), np.float32)
    if mirror_inputs:
        hair = mirror(hair, axis)
    if hair_mode == "flip":
        a = int(round(2 * axis))  # mirror about the axis: column x -> 2 axis - 1 - x
        flipped = np.zeros_like(hair)
        src = hair[:, ::-1]
        sh = a - hair.shape[1]
        if sh >= 0:
            flipped[:, sh:] = src[:, :hair.shape[1] - sh]
        else:
            flipped[:, :sh] = src[:, -sh:]
        hair = flipped
    hair_s, fringe_row = 0.0, None
    if deg and hair_mode != "none":
        fixed = None
        if face_mode == "project-clamped":  #: the hair shift from the face's own projection
            fixed, fringe_row = fringe_shift(hair, rows, axis, theta * PROJECT_GAIN)
        lock_row = max(rows, key=lambda yy: rows[yy][1])
        hair, hair_s = hair_warp(hair, axis, egg_half, hair_phi, ALPHA_PER_SIN * math.sin(theta), fixed, lock_row)
    fringe = {}
    if hair_mode != "none":
        hair, fringe = fringe_clear(hair, face, layers["eyes"])
    info = {"degrees": deg, "phiTarget": round(math.degrees(phi_target), 2), "phiUsed": round(math.degrees(phi), 2),
            "combo": combo, "hairMode": hair_mode, "hairShiftPx": round(hair_s, 2), "axis": round(float(axis), 2),
            "eggHalfWidth": round(float(egg_half), 2), "faceMode": face_mode, "fringeRow": fringe_row, "farEyeMarginPx": round(far_margin(rep), 1) if face_mode == "slide" else None, "pieces": rep,
            "headFit": round(HEAD_FIT, 4), "featurePoints": {c: live.areas[c]["defaultPoint"] for c in ("eyes", "nose", "mouth")},
            "gain": FACE_GAIN, "bump": BUMP, "farNarrow": FAR_NARROW, "farDark": FAR_DARK, "mouthNarrow": MOUTH_NARROW,
            "edgeMargin": EDGE_MARGIN, "hairShift": HAIR_SHIFT, "mirrorInputs": mirror_inputs, "fringeClear": fringe,
            "dashNose": dash, "eyeWidth (P6)": eye_width, "eyeClearTarget (P6)": eye_clear, "eyeClearMin (P6)": EYE_CLEAR_MIN, "lockRow (P4)": int(max(rows, key=lambda yy: rows[yy][1])), "lockRamp": LOCK_RAMP}
    if blink:
        info["blink"] = {"frames": BLINK_FRAMES, "inkLum": BLINK_INK_LUM, "eyes": blink_rep,
                         "maxGrowthPx": max(r["growthPx"] for r in blink_rep)}
    if face_mode != "project-clamped":
        parts = [("face", face)]  # the legacy modes keep one baked face region
    info["faceParts (P7)"] = {"slots": [k for k, lay in parts if bbox(lay) is not None], "maxDiffVsBaked255": split_diff(parts, face)}
    return doc, atlas, page_img, hm, head_att, hc, parts, hair, info, blinks


def split_diff(parts, face) -> int:
    """Refine P7 check: the separate part layers, each quantized as its atlas crop is (uint8) and composited in slot
    order, against the baked face quantized the same way; the max premultiplied-RGBA difference in 1/255 steps."""
    q = lambda lay: np.clip(lay * 255 + 0.5, 0, 255).astype(np.uint8).astype(np.float32) / 255  # noqa: E731
    comp = np.zeros_like(face)
    for _, lay in parts:
        comp_in = q(lay)
        a = comp_in[..., 3:4]
        o = a + comp[..., 3:4] * (1 - a)
        comp[..., :3] = (comp_in[..., :3] * a + comp[..., :3] * comp[..., 3:4] * (1 - a)) / np.maximum(o, 1e-6)
        comp[..., 3:4] = o
    pm = lambda lay: np.concatenate([lay[..., :3] * lay[..., 3:4], lay[..., 3:4]], -1)  # noqa: E731
    return int(np.ceil(np.abs(pm(comp) - pm(q(face))).max() * 255 - 1e-6))


def add_regions(doc, atlas, page_img, hm, head_att, hc, layers):
    """Append each canvas-size layer, cropped, to the atlas page and as a region slot on the head bone."""
    page = atlas["pages"][0]
    skin = doc["skins"][next(iter(doc["skins"]))]
    crops = []
    # refine P7: every face part (and blink eyes) is cropped to the baked face's box (the union of the parts), so its
    # texels sit in the atlas exactly as the baked face's did. Tight per-part crops rendered up to 80/255 off at view
    # 0.471 on the part edges (the page is sampled with mipmaps, so the texel alignment inside the page matters).
    fb = [bbox(e[1]) for e in layers if e[0] in FACE_PARTS]
    fb = [b for b in fb if b is not None]
    ref = (min(b[0] for b in fb), min(b[1] for b in fb), max(b[2] for b in fb), max(b[3] for b in fb)) if fb else None
    for entry in layers:
        name, layer = entry[0], entry[1]
        b = bbox(layer)
        if b is None:
            continue
        if ref is not None and (name in FACE_PARTS or name.startswith("eyes_blink")):
            b = ref
        crops.append((name, b, crop_img(layer, b), entry[2] if len(entry) > 2 else None))
    # the crops go in a column to the RIGHT of the page (five-anims 2026-10-19: stacking them below made the page
    # taller than the validator's 2048 px limit, an atlas error the source rig does not have)
    pad = 2
    x0c, y = page_img.width + pad, pad
    width = x0c + max([0] + [c[2].width + pad for c in crops])
    height = max(page_img.height, y + sum(c[2].height + pad for c in crops))
    new = Image.new("RGBA", (width, height))
    new.paste(page_img, (0, 0))
    slot_at = next(i for i, s in enumerate(doc["slots"]) if s["name"] == "head") + 1
    for name, (x0, y0, x1, y1), img, on_slot in crops:
        new.paste(img, (x0c, y))
        path = f"face/{name}"
        page["regions"][path] = {"x": x0c, "y": y, "width": img.width, "height": img.height}
        y += img.height + pad
        # canvas centre (front frame) -> head-local: offset from the head region's centre, rotated into the bone
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        hx, hy = apply(hm, head_att["x"], head_att["y"])
        lx, ly = inv_apply(hm, hx + (cx - hc[0]), hy + (cy - hc[1]))
        att = {"type": "region", "path": path, "x": round(float(lx), 4), "y": round(float(ly), 4),
               "rotation": head_att.get("rotation", 0), "width": img.width, "height": img.height}
        if on_slot:  # another attachment of an existing slot (the blink faces on the face slot)
            skin["attachments"][on_slot][name] = att
            continue
        skin["attachments"][name] = {name: att}
        doc["slots"].insert(slot_at, {"name": name, "bone": "head", "attachment": name})
        slot_at += 1
    page["width"], page["height"] = new.width, new.height
    return new


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rig")
    ap.add_argument("out")
    ap.add_argument("stem")
    ap.add_argument("--deg", type=float, required=True)
    for k, d in (("eyes", "almond-calm"), ("brows", "almond-calm"), ("nose", NO_NOSE), ("mouth", "smile-line"), ("hair", "soldier-crop-hair")):  # nose: none, dash-*, or drawn
        ap.add_argument(f"--{k}", default=d)
    ap.add_argument("--hair-mode", choices=("shift", "flip", "none"), default="shift")
    ap.add_argument("--face-mode", choices=("project-clamped", "project", "slide"), default="project-clamped",
                    help="project-clamped =  (default: projected, never widens, hair shift from the projection); project =; slide = ")
    ap.add_argument("--mirror-inputs", action="store_true", help="mirror face and hair about the head axis before the turn")
    ap.add_argument("--blink", action="store_true",
                    help="refine P3: add face_blink_half / face_blink_closed to the face slot and the idle blink keys")
    ap.add_argument("--eye-width", type=float, default=None,
                    help="refine P6: each eye's horizontal scale about its own centre, before the blink and the turn "
                         "(1 = as drawn; default: the style's EYE_WIDTH entry, else EYE_WIDTH_DEFAULT)")
    ap.add_argument("--eye-clear", type=float, default=EYE_CLEAR_TARGET,
                    help="refine P6: turned eyes keep >= this x their straight-front edge clearance (0 = no ease; comparison only)")
    ap.add_argument("--preview")
    a = ap.parse_args()
    combo = {k: getattr(a, k) for k in ("eyes", "brows", "nose", "mouth", "hair")}
    doc, atlas, page_img, hm, head_att, hc, parts, hair, info, blinks = build(Path(a.rig), a.deg, combo, a.hair_mode, a.face_mode,
                                                                            a.mirror_inputs, a.blink,
                                                                            a.eye_width if a.eye_width is not None else EYE_WIDTH.get(a.eyes, EYE_WIDTH_DEFAULT), a.eye_clear)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if info["faceParts (P7)"]["maxDiffVsBaked255"] > 1:
        raise SystemExit(f"split face parts differ from the baked face by {info['faceParts (P7)']['maxDiffVsBaked255']}/255 (limit 1)")
    new = add_regions(doc, atlas, page_img, hm, head_att, hc, parts + [("hair", hair)]
                      + [(f"eyes_blink_{k}", v, "eyes") for k, v in blinks.items()])
    if a.blink:
        clip = doc["animations"]["idle_weight_shift"]
        fps = clip.get("fps", 30)
        (h0, h1), (c0, _) = BLINK_FRAMES["half"], BLINK_FRAMES["closed"]
        keys = [(h0, "eyes_blink_half"), (c0, "eyes_blink_closed"), (h1, "eyes_blink_half"), (h1 + 1, "eyes")]
        # key times floored to 5 decimals: a key rounded up past f / fps would start one frame late
        clip.setdefault("slots", {})["eyes"] = {"attachment": [{"time": 0, "name": "eyes"}]
                                                + [{"time": math.floor(f / fps * 1e5) / 1e5, "name": n} for f, n in keys]}
    doc["name"] = a.stem
    (out / f"{a.stem}.anim.json").write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    atlas["pages"][0]["file"] = f"{a.stem}.atlas.png"
    (out / f"{a.stem}.atlas.json").write_text(json.dumps(atlas, indent=1), encoding="utf-8")
    new.save(out / f"{a.stem}.atlas.png")
    info["rig"] = Path(a.rig).as_posix()
    (out / f"{a.stem}.face.json").write_text(json.dumps(info, indent=1), encoding="utf-8")
    if a.preview:
        reg = atlas["pages"][0]["regions"][head_att["path"]]
        head = page_img.crop((reg["x"], reg["y"], reg["x"] + reg["width"], reg["y"] + reg["height"]))
        can = np.zeros((1448, 1086, 4), np.float32)
        paste(can, head, int(round(hc[0] - reg["width"] / 2)), int(round(hc[1] - reg["height"] / 2)))
        for _, lay in parts:
            paste(can, crop_img(lay, (0, 0, 1086, 1448)), 0, 0)
        paste(can, crop_img(hair, (0, 0, 1086, 1448)), 0, 0)
        crop_img(can, (180, 0, 906, 720)).save(a.preview)
    print(a.stem, info["faceMode"], "phi", info["phiTarget"], "->", info["phiUsed"], "far margin", info["farEyeMarginPx"], "hair S", info["hairShiftPx"])


if __name__ == "__main__":
    main()
