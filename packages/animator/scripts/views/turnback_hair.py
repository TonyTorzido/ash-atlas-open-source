# Atlas Animator lineup test (2026-10-19): HAIR on the BACK view, straight and turned 15 deg, deterministic.
# docs/plans/atlas-animator-demos/views/turned-front/lineup/README.md.
#
#   python scripts/views/turnback_hair.py <back rig.anim.json> <out dir> <out stem> --deg 15 [--hair soldier-crop-hair]
#       [--style fill|cap] [--mirror-inputs] [--layer hair.npy] [--preview head.png]
#   (run from packages/animator; <back rig> is a `turnfront.py --back` rig)
#
# There is no back-of-head hair art yet. A STAND-IN back hair is derived from the live front hair:
# 1. The live hair PNG at its live catalog placement (turnfront_face.place_hair), MIRRORED about the head axis (seen
#    from behind, the parting and swoop swap sides); its silhouette (crown and side tufts) is the same from behind.
# 2. Under it, a flat cel-shaded CAP fills the egg where the face would be, down to a nape line (the egg inset by its
#    outline width; the nape is a shallow arc, lowest on the axis, with short pointed crop ends), in the hair's own
#    palette: a mid base, a darker band toward the nape, and an outline along the nape edge. The front fringe tufts
#    then read as layered locks over the cap.
# The turn (--deg > 0) is the turned-front hair rule, mirrored for the back view. The body turns toward screen-left;
# the back of the head faces the camera, so its centre line shifts AWAY from the facing side (toward screen-right) by
# the projection R sin(theta) (R = the egg's half-width at its widest row, where the back of the skull is nearest the
# camera), and the screen-right side is the far side: it compresses and darkens (the head's crescent, ALPHA_PER_SIN
# sin theta). back_warp is turnfront_face.hair_warp mirrored (same profiles), with smoother per-row extents, so the
# silhouette ends stay pinned as in the front. The head itself already moved toward the facing side with the
# head bone (turnfront.py, HEAD_FWD), and its egg carries the mirrored far-side crescent (turnfront.py --back).
#
# --style fill (DEFAULT, five-anims 2026-10-19; the cap style above, now --style cap, read as a helmet: the mirrored
# fringe locks lay over the cap like layers instead of growing from the crown):
# 1. The live hair mirrored about the head axis, as above.
# 2. Mask = hair alpha OR the egg above a smooth nape arc (NAPE_CENTRE / NAPE_SIDE). The egg is inset by its MEASURED
#    outline width minus EGG_OVERLAP px, so the hair covers to the head's outline (no skin crescent between them).
# 3. The CROWN band (rows above CROWN_FRAC of the egg height, feathered over CROWN_FEATHER rows) is the hair art
#    verbatim. Below it, every texel farther than SIL_KEEP x the ink width from the mask's outer edge is FILL: the
#    nearest opaque non-ink hair colour (distance-transform indices), blurred sigma FILL_SIGMA, blended FILL_MEDIAN
#    toward the hair's median colour, vertical shade crown +4 % / nape -8 %. No interior fringe ink is left; the
#    side tufts keep their own silhouette ink.
# 4. Strand hints (STRANDS): thin tapered darker strokes from a crown whorl toward the nape, so the fill reads as hair
#    growing from the crown.
# 5. Nape ink along the arc in the MEASURED outline colour (median of the hair's darkest 5 %) and width (median top
#    edge ink run, column scans).
# --style drawn (DEFAULT, five-anims round 2, 2026-10-19; owner: the fill "is kinda fucked up", a bowl over a skin
# crescent): the DRAWN back hair, views/body-back-drawn/hair-back-canvas.png (hand drawing registered by
# back_drawn.py: front frame, 0 deg, already in the back orientation; alpha outside the egg = the mirrored live front
# hair's, so the silhouette ends match the 0 deg hair). The turn is the fill's: the 2c warp + pin taper, shift
# R sin(theta) with R = the egg half-width at the NAPE_CENTRE row; pin-holes closed the same way.
# --mirror-inputs: the finished 0 deg layer is mirrored about the head axis before the turn (walk up-right is an image
# flip of that render, which puts the parting back on its side).
# Turn (fill): the 2c warp's extent rule plus a pin taper (back_warp extent="2c"); shift R sin(theta), R = the egg's
# half-width at the nape centre row.
# Writes <out>/<stem>.anim.json + .atlas.json + .atlas.png (the rig plus a `hair` region slot on the head bone, drawn
# after the head) and <stem>.face.json (every value used).
import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

from turnfront import ALPHA_PER_SIN, apply, far_shade, setup_world
from turnfront_face import Live, add_regions, crop_img, egg_row, egg_rows, mirror, paste, place_hair

DRAWN = Path(__file__).resolve().parents[4] / "docs/plans/atlas-animator-demos/views/body-back-drawn/hair-back-canvas.png"
NAPE_CENTRE = 0.88  # nape hairline on the axis, as a fraction of the egg height from its top
NAPE_SIDE = 0.78  # at the egg's sides
EDGE_INSET = 11  # px inside the egg outline (the egg's own outline stays visible beside the cap)
OUTLINE = 7  # nape-edge outline width, px
# crop ends along the nape: locks of these widths (px, laid out from the axis outward, mirrored to both sides with a
# half-lock offset so the two sides differ) and depth (px); each lock is a rounded point (parabolic sides)
LOCKS = (58, 44, 66, 50, 40, 62, 48, 56, 42, 60)
LOCK_DEPTH = 24
SHADOW_PX = 70  # the darker band: this many px above the (smooth) nape line, with a gentle wave
# --style fill (default)
EGG_OVERLAP = 2  # the fill reaches this many px into the egg's measured outline (hair covers to the outline)
CROWN_FRAC = 0.30  # crown band: rows above egg top + CROWN_FRAC x egg height are the hair art verbatim
CROWN_FEATHER = 28  # rows over which the crown band blends into the fill
SIL_KEEP = 1.6  # below the crown, art within SIL_KEEP x ink width of the mask's outer edge stays (silhouette ink)
FILL_SIGMA, FILL_MEDIAN = 6.0, 0.45  # nearest-colour fill blur, blend toward the median colour
SHADE_TOP, SHADE_NAPE = 1.04, 0.92  # vertical shade: crown +4 %, nape -8 %
INK_LUM = 0.2  # luminance below which a hair texel is ink
PIN_BAND = 0.12  # fill warp: the displacement tapers to 0 over the outer 12 % of each row's raw extent
WHORL = (-0.215, -0.056)  # (on the mirrored art's own parting, where its crown locks converge)  # crown whorl, (dx, dy) from (axis, crown row) as fractions of the egg height
# strand hints: (end u across the nape, -1..1 of the egg half-width x 0.82; sideways bow as a fraction of the egg
# height; px above the nape where it stops); drawn in the ink colour at STRAND_ALPHA, STRAND_W px wide
STRANDS = ((-0.86, -0.07, 30), (-0.55, -0.05, 58), (-0.18, -0.02, 36), (0.16, 0.03, 70), (0.50, 0.06, 32), (0.84, 0.08, 52))
STRAND_ALPHA, STRAND_W = 0.30, 4.5


def hair_palette(hair: np.ndarray):
    """Outline / shadow / base tones from the hair's own opaque texels (luminance quantiles)."""
    px = hair[hair[..., 3] > 0.9][:, :3]
    lum = px @ np.array([0.299, 0.587, 0.114])
    order = np.argsort(lum)
    q = lambda f: px[order[int(f * (len(order) - 1))]]  # noqa: E731
    return {"outline": q(0.04), "shadow": q(0.25), "base": q(0.5)}


def back_cap(rows, axis: float, egg_top: int, egg_bot: int, pal) -> tuple[np.ndarray, dict]:
    hgt = egg_bot - egg_top
    cap = np.zeros((1448, 1086, 4), np.float32)
    xs = np.arange(1086) + 0.5
    half_w = max(r for _, r in rows.values())

    u = np.clip((xs - axis) / half_w, -1, 1)
    base = egg_top + hgt * (NAPE_SIDE + (NAPE_CENTRE - NAPE_SIDE) * (1 - u * u))
    # locks: per side, lock k spans [edges[k], edges[k+1]] from the axis; the right side starts half a lock later
    tooth = np.zeros_like(xs)
    for side, off in ((-1, 0.0), (1, LOCKS[0] / 2)):
        d = side * (xs - axis) + off
        edges = np.concatenate([[0.0], np.cumsum(LOCKS * 4)])
        k = np.clip(np.searchsorted(edges, d, side="right") - 1, 0, len(edges) - 2)
        w = edges[k + 1] - edges[k]
        t = np.clip((d - edges[k]) / w, 0, 1)  # 0..1 across the lock
        val = (1 - np.abs(2 * t - 1)) ** 1.7  # a pointed lock tip mid-lock, rounded valleys between locks
        sel = side * (xs - axis) >= 0
        tooth[sel] = val[sel]
    ny = base + LOCK_DEPTH * (tooth - 0.5)
    inside = np.zeros((1448, 1086), bool)
    for y, (c, r) in rows.items():
        if 0 <= y < 1448:
            inside[y] = (np.abs(xs - c) <= r - EDGE_INSET) & (y <= ny)
    yy = np.arange(1448)[:, None]
    # shadow band toward the nape, its upper boundary a gentle wave so it reads as painted, not a cut
    shadow_top = base - SHADOW_PX + 9 * np.sin((xs - axis) / 31.0)
    dist = ndimage.distance_transform_edt(inside)
    edge = (dist <= OUTLINE) & inside & (yy > egg_top + hgt * 0.45)  # outline along the nape (lower) edge only
    col = np.where((yy >= shadow_top[None, :])[..., None], pal["shadow"], pal["base"])
    col = np.where(edge[..., None], pal["outline"], col)
    cap[..., :3] = col
    # soft 1 px anti-aliased edge
    cap[..., 3] = np.clip(dist / 1.5, 0, 1) * inside
    info = {"napeCentre": NAPE_CENTRE, "napeSide": NAPE_SIDE, "edgeInset": EDGE_INSET, "outline": OUTLINE,
            "locks": list(LOCKS), "lockDepth": LOCK_DEPTH, "shadowPx": SHADOW_PX, "palette": {k: [int(round(v * 255)) for v in c] for k, c in pal.items()}}
    return cap, info


def measure_ink(hair: np.ndarray):
    """The hair art's outline: colour = median of its darkest 5 % opaque texels; width = median dark run at the top
    edge over column scans (entering from above)."""
    a = hair[..., 3]
    lum = hair[..., :3] @ np.array([0.299, 0.587, 0.114], np.float32)
    op = a > 0.9
    px = hair[op][:, :3]
    lv = lum[op]
    ink_col = np.median(px[lv <= np.quantile(lv, 0.05)], axis=0)
    xs = np.where(a.max(axis=0) > 0.5)[0]
    runs = []
    for x in xs[len(xs) // 8: -(len(xs) // 8): 5]:
        ys = np.where(a[:, x] > 0.5)[0]
        y, n = ys[0], 0
        while y < a.shape[0] and a[y, x] > 0.5 and lum[y, x] < INK_LUM:
            n += 1
            y += 1
        if n:
            runs.append(n)
    return ink_col, float(np.median(runs))


def nape_line(rows, axis: float, egg_top: int, egg_bot: int, xs: np.ndarray) -> np.ndarray:
    hgt = egg_bot - egg_top
    half_w = max(r for _, r in rows.values())
    u = np.clip((xs - axis) / half_w, -1, 1)
    return egg_top + hgt * (NAPE_SIDE + (NAPE_CENTRE - NAPE_SIDE) * (1 - u * u))


def egg_mask(rows, xs, inset, H, below=None):
    m = np.zeros((H, len(xs)), bool)
    for y, (c, r) in rows.items():
        if 0 <= y < H:
            m[y] = np.abs(xs - c) <= r - inset
            if below is not None:
                m[y] &= y <= below
    return m


def strand_hints(rows, axis, hgt, whorl, nape, xs, H, W):
    """Thin tapered strokes from the crown whorl toward the nape (quadratic curves with a sideways bow)."""
    strand = np.zeros((H, W), np.float32)
    half = max(r for _, r in rows.values())
    for u_end, bow, stop in STRANDS:
        ex = axis + u_end * half * 0.82
        ey = float(np.interp(ex, xs, nape)) - stop
        cx, cy = (whorl[0] + ex) / 2 + bow * hgt, (whorl[1] + ey) / 2
        for t in np.linspace(0, 1, 500):
            px = (1 - t) ** 2 * whorl[0] + 2 * (1 - t) * t * cx + t * t * ex
            py = (1 - t) ** 2 * whorl[1] + 2 * (1 - t) * t * cy + t * t * ey
            w = STRAND_W * (0.35 + 0.65 * math.sin(math.pi * min(1.0, t)))  # tapered at both ends
            fade = min(1.0, t * 5)  # fades in from the whorl
            x0, y0 = int(px) - 4, int(py) - 4
            for qy in range(max(0, y0), min(H, y0 + 9)):
                for qx in range(max(0, x0), min(W, x0 + 9)):
                    d = math.hypot(qx + 0.5 - px, qy + 0.5 - py)
                    v = min(1.0, max(0.0, w / 2 + 0.5 - d)) * fade
                    if v > strand[qy, qx]:
                        strand[qy, qx] = v
    return strand


def back_fill(hair: np.ndarray, rows, axis: float, egg_top: int, egg_bot: int, egg_outline: float):
    """--style fill (see the header). hair = the live hair already mirrored about the axis."""
    H, W = hair.shape[:2]
    xs = np.arange(W) + 0.5
    yy = np.arange(H)[:, None].astype(np.float32)
    hgt = egg_bot - egg_top
    ink_col, ink_w = measure_ink(hair)
    nape = nape_line(rows, axis, egg_top, egg_bot, xs)
    inset = max(0.0, egg_outline - EGG_OVERLAP)
    egg = egg_mask(rows, xs, inset, H, None) & (yy + 0.5 <= nape[None, :] + 0.5)
    a = hair[..., 3]
    mask = egg | (a > 0.5)
    # coverage: the hair's own alpha, or the egg part (anti-aliased by its distance to its edge)
    d_egg = ndimage.distance_transform_edt(egg)
    cov = np.maximum(a, np.clip(d_egg / 1.2, 0, 1))
    # fill colour: nearest opaque non-ink hair texel, blurred, blended toward the median, vertical shade
    lum = hair[..., :3] @ np.array([0.299, 0.587, 0.114], np.float32)
    src = (a > 0.9) & (lum >= INK_LUM)
    med = np.median(hair[src][:, :3], axis=0)
    _, (iy, ix) = ndimage.distance_transform_edt(~src, return_indices=True)
    near = hair[iy, ix, :3]
    near = np.stack([ndimage.gaussian_filter(near[..., c], FILL_SIGMA) for c in range(3)], -1)
    fill = near * (1 - FILL_MEDIAN) + med * FILL_MEDIAN
    t = np.clip((yy - egg_top) / np.maximum(nape[None, :] - egg_top, 1), 0, 1)
    fill = fill * (SHADE_TOP + (SHADE_NAPE - SHADE_TOP) * t)[..., None]
    crown_y = egg_top + CROWN_FRAC * hgt
    whorl = (axis + WHORL[0] * hgt, crown_y + WHORL[1] * hgt)
    strand = strand_hints(rows, axis, hgt, whorl, nape, xs, H, W) * STRAND_ALPHA
    fill = fill * (1 - strand[..., None]) + ink_col * strand[..., None]
    # crown band verbatim (feathered); below it, the art only near the mask's outer edge (silhouette ink)
    keep_sil = ndimage.distance_transform_edt(mask) <= SIL_KEEP * ink_w
    crown_w = np.clip((crown_y + CROWN_FEATHER / 2 - yy) / CROWN_FEATHER, 0, 1) * np.ones((1, W), np.float32)
    art_w = np.maximum(crown_w, ndimage.gaussian_filter(keep_sil.astype(np.float32), 1.0)) * (a > 0.02)
    art_over = hair[..., :3] * a[..., None] + fill * (1 - a[..., None])
    rgb = art_over * art_w[..., None] + fill * (1 - art_w[..., None])
    # nape ink: the measured width along the arc, inside the egg part, where the art is not already the outline
    d_nape = yy + 0.5 - nape[None, :]  # > 0 below the arc
    band = np.clip(d_nape + ink_w + 0.5, 0, 1) * np.clip(0.5 - d_nape, 0, 1)
    band = band * egg_mask(rows, xs, inset, H) * (1 - art_w)
    rgb = rgb * (1 - band[..., None]) + ink_col * band[..., None]
    out = np.zeros((H, W, 4), np.float32)
    out[..., :3] = np.clip(rgb, 0, 1)
    out[..., 3] = cov * mask
    info = {"style": "fill", "inkColour": [int(round(v * 255)) for v in ink_col], "inkWidthPx": ink_w,
            "eggOutlinePx": egg_outline, "eggOverlap": EGG_OVERLAP, "eggInset": inset, "crownRow": round(crown_y, 1),
            "crownFrac": CROWN_FRAC, "crownFeather": CROWN_FEATHER, "silKeep": SIL_KEEP, "fillSigma": FILL_SIGMA,
            "fillMedian": FILL_MEDIAN, "shade": [SHADE_TOP, SHADE_NAPE], "median": [int(round(v * 255)) for v in med],
            "napeCentre": NAPE_CENTRE, "napeSide": NAPE_SIDE, "napeRowAxis": round(float(np.interp(axis, xs, nape)), 1),
            "strands": [list(v) for v in STRANDS], "strandAlpha": STRAND_ALPHA, "whorl": [round(float(v), 1) for v in whorl]}
    return out, info


def egg_outline_width(head: np.ndarray) -> float:
    """Median dark run (luminance < 0.3) entering the egg from the left and the right on its middle rows."""
    a = head[..., 3]
    lum = head[..., :3].astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32) / 255
    runs = []
    for y in range(int(head.shape[0] * 0.35), int(head.shape[0] * 0.75), 4):
        cols = np.where(a[y] > 128)[0]
        if len(cols) < 20:
            continue
        for x0, step in ((cols[0], 1), (cols[-1], -1)):
            n, x = 0, x0
            while 0 <= x < a.shape[1] and lum[y, x] < 0.3 and a[y, x] > 128:
                n += 1
                x += step
            runs.append(n)
    return float(np.median(runs))

def back_warp(layer: np.ndarray, axis: float, shift: float, alpha: float, extent: str = "dilated", egg_half: float = 0.0) -> np.ndarray:
    """The turned-front hair warp (turnfront_face.hair_warp), mirrored for the back: interior texels slide toward
    screen-RIGHT, the silhouette ends stay pinned. Near (screen-left) side dx = +S (1 - u)^2 (1 + 2u) on |u|, far
    (screen-right) side dx = +S (1 - u^2). Each side's per-row extent is its raw opaque extent DILATED over +-40 rows
    (maximum filter) and smoothed, so it never undercuts the silhouette and does not jump between rows at the nape's
    crop points (the raw per-row extent does: that tore the nape edge). Then the far-side crescent on the same
    extents.
    extent="2c" (the fill style, whose nape is a smooth arc): turnfront_face.hair_warp's own extent rule (raw, lightly
    smoothed sigma 6 and never below raw, floor half the egg half-width), plus a PIN_BAND taper so the displacement is
    exactly 0 at each row's raw end: the side silhouette (tuft tips included) stays where it is at 0 deg."""
    a = layer[..., 3]
    hgt, wid = a.shape
    ext = np.zeros((2, hgt), np.float32)
    for y in range(hgt):
        cols = np.where(a[y] > 0.05)[0]
        if len(cols):
            ext[0, y], ext[1, y] = max(1.0, axis - cols[0]), max(1.0, cols[-1] + 1 - axis)
    raw = ext.copy()
    if extent == "2c":
        ext = np.maximum(ext, ndimage.gaussian_filter1d(ext, 6, axis=1))
        ext = np.maximum(ext, 0.5 * egg_half)
    else:
        ext = ndimage.maximum_filter1d(ext, 81, axis=1)
        ext = np.maximum(raw, ndimage.gaussian_filter1d(ext, 12, axis=1))
    xs = np.arange(wid, dtype=np.float32) + 0.5
    pm = layer.copy()
    pm[..., :3] *= pm[..., 3:4]
    src_x = np.zeros((hgt, wid), np.float32)
    shade = np.ones((hgt, wid), np.float32)
    for y in range(hgt):
        if not ext[:, y].any():
            src_x[y] = xs - 0.5
            continue
        el, er = max(ext[0, y], 1.0), max(ext[1, y], 1.0)
        ss = min(shift, 0.49 * er)
        u = np.clip((xs - axis) / np.where(xs < axis, el, er), -1, 1)
        au = np.abs(u)
        prof = np.where(u > 0, 1 - u * u, (1 - au) ** 2 * (1 + 2 * au))
        if extent == "2c" and raw[:, y].any():
            rl, rr = max(raw[0, y], 1.0), max(raw[1, y], 1.0)
            ur = np.abs((xs - axis) / np.where(xs < axis, rl, rr))
            prof = prof * np.clip((1 - ur) / PIN_BAND, 0, 1)
            # keep the map monotone through the taper: the taper's slope x the profile there stays below 0.8 / px
            # (narrow rows, e.g. the crown tip, then barely shift: their ends are pinned too)
            for r_side, e_side, far in ((rr, er, True), (rl, el, False)):
                ub = (1 - PIN_BAND) * r_side / e_side
                pb = 1 - ub * ub if far else (1 - ub) ** 2 * (1 + 2 * ub)
                if pb > 1e-6:
                    ss = min(ss, 0.8 * PIN_BAND * r_side / pb)
        fwd = xs + ss * prof
        src_x[y] = np.interp(xs, fwd, xs) - 0.5
        uf = (xs - axis) / er  # far side = screen-right
        shade[y] = [far_shade(-v, 1.0, alpha) for v in uf]
    coords = [np.repeat(np.arange(hgt)[:, None], wid, 1).astype(np.float32), src_x]
    out = np.zeros_like(layer)
    for ch in range(4):
        out[..., ch] = ndimage.map_coordinates(pm[..., ch], coords, order=1, mode="constant")
    out[..., :3] = np.where(out[..., 3:4] > 1e-6, out[..., :3] / np.maximum(out[..., 3:4], 1e-6), 0)
    out[..., :3] *= shade[..., None]
    return np.clip(out, 0, 1)


def build(rig_path: Path, deg: float, hair_id: str, style: str = "drawn", mirror_inputs: bool = False):
    doc = json.loads(rig_path.read_text(encoding="utf-8"))
    atlas_path = rig_path.with_name(rig_path.name.replace(".anim.json", ".atlas.json"))
    atlas = json.loads(atlas_path.read_text(encoding="utf-8"))
    page = atlas["pages"][0]
    page_img = Image.open(atlas_path.parent / page["file"]).convert("RGBA")
    skin = doc["skins"][next(iter(doc["skins"]))]
    head_att = skin["attachments"]["head"]["head"]
    reg = page["regions"][head_att["path"]]
    hm = setup_world(doc["bones"])["head"]
    hx, hy = apply(hm, head_att["x"], head_att["y"])
    hc = (hx - hm[0, 2] + doc["canvas"]["originX"], hy + doc["canvas"]["originY"])  # front frame, as turnfront_face
    head_alpha = np.asarray(page_img)[reg["y"]:reg["y"] + reg["height"], reg["x"]:reg["x"] + reg["width"], 3]
    rows = egg_rows(head_alpha, hc[0] - reg["width"] / 2, hc[1] - reg["height"] / 2)
    axis = float(np.median([c for c, _ in rows.values()]))
    egg_half = max(h for _, h in rows.values())
    egg_top, egg_bot = min(rows), max(rows)

    front_hair = place_hair(Live(), hair_id)
    hair = mirror(front_hair, axis)
    if style == "cap":  # the lineup checkpoint's stand-in (kept for the before/after sheet)
        pal = hair_palette(front_hair)
        cap, style_info = back_cap(rows, axis, egg_top, egg_bot, pal)
        back = np.zeros_like(cap)
        paste(back, crop_img(cap, (0, 0, 1086, 1448)), 0, 0)
        paste(back, crop_img(hair, (0, 0, 1086, 1448)), 0, 0)
        shift_r = egg_half
    elif style == "drawn":  # five-anims round 2: the drawn back hair (back_drawn.py register), front frame at 0 deg
        back = np.asarray(Image.open(DRAWN).convert("RGBA")).astype(np.float32) / 255
        nape_row = egg_top + NAPE_CENTRE * (egg_bot - egg_top)
        style_info = {"style": "drawn", "art": DRAWN.relative_to(DRAWN.parents[5]).as_posix(), "napeRowAxis": round(float(nape_row), 1),
                      "crownRow": round(egg_top + CROWN_FRAC * (egg_bot - egg_top), 1)}
        shift_r = egg_row(rows, int(round(nape_row)))[1]  # the egg half-width at the nape centre row, as the fill
    else:
        head_rgba = np.asarray(page_img)[reg["y"]:reg["y"] + reg["height"], reg["x"]:reg["x"] + reg["width"]]
        back, style_info = back_fill(hair, rows, axis, egg_top, egg_bot, egg_outline_width(head_rgba))
        shift_r = egg_row(rows, int(round(style_info["napeRowAxis"])))[1]  # the egg half-width at the nape centre
    if mirror_inputs:
        back = mirror(back, axis)
    theta = math.radians(deg)
    shift = shift_r * math.sin(theta)
    if deg:
        back = back_warp(back, axis, shift, ALPHA_PER_SIN * math.sin(theta), "dilated" if style == "cap" else "2c", egg_half)
    holes = 0
    if style in ("fill", "drawn"):  # the warp's resampling can open pin-holes where a side tuft meets the fill: close them
        m = back[..., 3] > 0.5
        hole = ndimage.binary_fill_holes(m) & ~m
        holes = int(hole.sum())
        if holes:
            _, (iy, ix) = ndimage.distance_transform_edt(~m, return_indices=True)
            back[hole, :3] = back[iy[hole], ix[hole], :3]
            back[hole, 3] = 1.0
    info = {"degrees": deg, "view": "back", "hair": hair_id, "style": style, "mirrorInputs": mirror_inputs,
            "standIn": {"fill": "live front hair mirrored + generated back fill (no back art)", "cap": "live front hair mirrored + cel cap (no back art)",
                        "drawn": "drawn back hair, registered: alpha outside the egg = the mirrored live front hair's"}[style],
            "axis": round(axis, 2), "eggHalfWidth": round(float(egg_half), 2), "eggRows": [egg_top, egg_bot],
            "shiftRadius": round(float(shift_r), 2), "hairShiftPx": round(shift, 2), "shiftDirection": "screen-right (away from the facing side)",
            "alpha": round(ALPHA_PER_SIN * math.sin(theta), 4), "holesClosedPx": holes, "styleInfo": style_info}
    return doc, atlas, page_img, hm, head_att, hc, back, info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rig")
    ap.add_argument("out")
    ap.add_argument("stem")
    ap.add_argument("--deg", type=float, required=True)
    ap.add_argument("--hair", default="soldier-crop-hair")
    ap.add_argument("--style", choices=("drawn", "fill", "cap"), default="drawn",
                    help="drawn = the drawn back hair (default); fill = generated back fill; cap = lineup checkpoint")
    ap.add_argument("--mirror-inputs", action="store_true", help="mirror the 0 deg back hair about the head axis before the turn")
    ap.add_argument("--layer", help="also save the hair layer (canvas-size float RGBA, front frame) as .npy here")
    ap.add_argument("--preview")
    a = ap.parse_args()
    doc, atlas, page_img, hm, head_att, hc, hair, info = build(Path(a.rig), a.deg, a.hair, a.style, a.mirror_inputs)
    if a.layer:
        np.save(a.layer, hair.astype(np.float16))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    new = add_regions(doc, atlas, page_img, hm, head_att, hc, [("hair", hair)])
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
        paste(can, crop_img(hair, (0, 0, 1086, 1448)), 0, 0)
        crop_img(can, (180, 0, 906, 720)).save(a.preview)
    print(a.stem, "hair shift", info["hairShiftPx"], "egg", info["eggRows"], "axis", info["axis"])


if __name__ == "__main__":
    main()
