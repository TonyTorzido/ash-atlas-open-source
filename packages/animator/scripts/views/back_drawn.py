# Atlas Animator five-anims (2026-10-19): DRAWN back art for the stock body and the soldier-crop hair.
# The generated back was rejected (views/body-back = the front art with small edits; turnback_hair --style fill).
# The art is drawn separately (ART_DROPS/stock-back-draw); this script does everything deterministic
# around it. Run from packages/animator:
#
#   python scripts/views/back_drawn.py refs        references into ART_DROPS/stock-back-draw/refs (+ frames.json)
#   python scripts/views/back_drawn.py register    the untouched generations (output/body-back.png, hair-back.png)
#                                                  -> registered canvas layers + register.report.json in
#                                                  docs/plans/atlas-animator-demos/views/body-back-drawn
#   python scripts/views/back_drawn.py rig <stock-back rig.anim.json> <out dir> <stem>
#                                                  the registered body pasted into a copy of the back stock rig's atlas
#
# Registration (both pieces): the generation is resized from its reference frame into the canvas box, then aligned by
# a small scale/translation search that maximises silhouette IoU with the target; then the silhouette is FORCED:
#   - body: the rig's rest silhouette (the stock front rest render's opaque mask, identical to the back's). Outside it
#     the drawing is dropped; inside it, any pixel the drawing left as background takes the nearest drawn colour; the
#     outer outline band (within OUTLINE_BAND px of the edge) is the rig's own ink (the stock front render's pixels),
#     so the ink weight and the anti-aliased edge are identical. The head (a separate region) is not taken.
#   - hair: outside the head egg the alpha is the live front hair's (mirrored about the head axis: seen from behind
#     its silhouette is the same), so the crown and side tufts end where the 0 deg hair ends; inside the egg the alpha
#     is the drawing's (its nape line and tufts). Colour = the drawing, with nearest-colour fill under the forced mask.
# The rig paste keeps the mesh, skeleton, weights and animations VERBATIM (only atlas texels change): every atlas texel
# of the body slots (torso skin, tank, hips skin, shorts, both fists) is mapped to its rest canvas position (setup
# world vertices, barycentric over the UV triangles; fists by their region transform) and takes the drawn colour there
# when its slot is the topmost opaque slot at that canvas pixel; texels hidden at rest (under another slot) take the
# nearest visible texel's new colour in the same region. Gates as views/body-back/body-back.report.json.
import argparse
import json
import math
import shutil
import subprocess
import tempfile
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).parent))
from turnfront import apply, setup_world  # noqa: E402
from turnfront_face import Live, egg_rows, mirror, place_hair  # noqa: E402

HERE = Path(__file__).resolve().parents[2]  # packages/animator
DEMOS = HERE.parents[1] / "docs/plans/atlas-animator-demos"
RIG = DEMOS / "views/turned-front/five-anims/rig"
DROP = Path("C:/Users/dev/Documents/art-drops/stock-back-draw")
FINAL = DEMOS / "views/body-back-drawn"  # the registered layers (committed), read by the rig paste and turnback_hair --style drawn
BG = np.array([0xb4, 0xb9, 0xc2])
BODY_BOX = (-13, 152, 1097, 1262)  # canvas crop of the body reference, square (1110 -> 1024; outside the canvas = bg)
BODY_REF = (1024, 1024)
HEAD_REF = 1024
OUTLINE_BAND = 3  # px from the silhouette edge taken from the rig's own render (anti-aliased edge + outline core)
HAIR = "soldier-crop-hair"
EGG_OVERLAP = 2  # the hair reaches this many px into the egg outline (turnback_hair.EGG_OVERLAP)
STRETCH_PX, ENVELOPE = 140, 61  # nape_reach: rows stretched above the hair bottom; envelope smoothing width (px)


def render(out_dir: Path, scale, clip, frame, pairs):
    subprocess.run(["npx", "tsx", "scripts/swag/render-rest.ts", str(out_dir), str(scale), clip, str(frame), *[f"{k}={v}" for k, v in pairs.items()]],
                   cwd=HERE, check=True, shell=True)


def sil(rgb):
    return np.abs(rgb[..., :3].astype(int) - BG).sum(-1) > 0


def head_geom(rig_path: Path):
    """Head egg rows (canvas, front frame), axis, and the egg box, as turnback_hair.build."""
    doc = json.loads(rig_path.read_text(encoding="utf-8"))
    atlas_path = rig_path.with_name(rig_path.name.replace(".anim.json", ".atlas.json"))
    atlas = json.loads(atlas_path.read_text(encoding="utf-8"))
    page = atlas["pages"][0]
    page_img = np.asarray(Image.open(atlas_path.parent / page["file"]).convert("RGBA"))
    head_att = doc["skins"][next(iter(doc["skins"]))]["attachments"]["head"]["head"]
    reg = page["regions"][head_att["path"]]
    hm = setup_world(doc["bones"])["head"]
    hx, hy = apply(hm, head_att["x"], head_att["y"])
    hc = (hx - hm[0, 2] + doc["canvas"]["originX"], hy + doc["canvas"]["originY"])
    head_alpha = page_img[reg["y"]:reg["y"] + reg["height"], reg["x"]:reg["x"] + reg["width"], 3]
    rows = egg_rows(head_alpha, hc[0] - reg["width"] / 2, hc[1] - reg["height"] / 2)
    axis = float(np.median([c for c, _ in rows.values()]))
    return rows, axis


def egg_fill(rows, H=1448, W=1086, inset=0.0):
    xs = np.arange(W) + 0.5
    m = np.zeros((H, W), bool)
    for y, (c, r) in rows.items():
        if 0 <= y < H:
            m[y] = np.abs(xs - c) <= r - inset
    return m


def head_box(rows, hair_a):
    ys, xs = np.where(hair_a > 0.16)
    ey = list(rows)
    x0 = min(xs.min(), min(c - r for c, r in rows.values()))
    x1 = max(xs.max(), max(c + r for c, r in rows.values()))
    y0, y1 = min(ys.min(), min(ey)), max(ys.max(), max(ey)) + 60  # + the neck top
    side = int(max(x1 - x0, y1 - y0) + 80)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return (int(round(cx - side / 2)), int(round(cy - side / 2)), int(round(cx - side / 2)) + side, int(round(cy - side / 2)) + side)


def to_ref(img: np.ndarray, box, size, fill=BG):
    """Crop (padding outside the canvas with fill) and resize."""
    x0, y0, x1, y1 = box
    shape = (y1 - y0, x1 - x0) + img.shape[2:]
    out = np.empty(shape, img.dtype)
    out[...] = fill if img.ndim == 3 else 0
    sx0, sy0, sx1, sy1 = max(0, x0), max(0, y0), min(img.shape[1], x1), min(img.shape[0], y1)
    out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = img[sy0:sy1, sx0:sx1]
    return Image.fromarray(out).resize(size, Image.LANCZOS)


def on_bg(layer):
    a = layer[..., 3:4]
    return np.clip((layer[..., :3] * a + BG / 255 * (1 - a)) * 255 + 0.5, 0, 255).astype(np.uint8)


def cmd_refs():
    refs = DROP / "refs"
    tmp = refs / "_render"
    refs.mkdir(parents=True, exist_ok=True)
    render(tmp, 1, "rest", 0, {"stockfront": RIG / "stock-front.anim.json", "frontface": RIG / "front-turn00-faceA.anim.json",
                               "backbald": RIG / "back-turn00.anim.json"})
    sf = np.asarray(Image.open(tmp / "stockfront.png").convert("RGB"))
    ff = np.asarray(Image.open(tmp / "frontface.png").convert("RGB"))
    bb = np.asarray(Image.open(tmp / "backbald.png").convert("RGB"))
    m = sil(sf)
    to_ref(sf, BODY_BOX, BODY_REF).save(refs / "ref-body-front.png")
    to_ref((m * 255).astype(np.uint8), BODY_BOX, BODY_REF).save(refs / "ref-body-silhouette.png")
    atlas = json.loads((RIG / "stock-front.atlas.json").read_text(encoding="utf-8"))
    Image.open(RIG / atlas["pages"][0]["file"]).save(refs / "ref-body-front-atlas.png")
    # hair: the live front hair at 0 deg, the egg, and the back target shape
    rows, axis = head_geom(RIG / "back-turn00.anim.json")
    front_hair = place_hair(Live(), HAIR)
    hb = head_box(rows, front_hair[..., 3])
    to_ref(ff, hb, (HEAD_REF, HEAD_REF)).save(refs / "ref-hair-front.png")
    to_ref(on_bg(front_hair), hb, (HEAD_REF, HEAD_REF)).save(refs / "ref-hair-front-only.png")
    to_ref(bb, hb, (HEAD_REF, HEAD_REF)).save(refs / "ref-head-back-bald.png")
    # back target shape: mirrored front hair silhouette + the whole egg, except a neck-wide skin strip at the bottom
    mh = mirror(front_hair, axis)[..., 3] > 0.5
    egg = egg_fill(rows)
    neck_half, strip_top = neck_strip(bb, rows, axis)
    yy, xx = np.mgrid[0:1448, 0:1086]
    dx = (xx + 0.5 - axis) / neck_half
    strip = (np.abs(dx) <= 1) & (yy >= strip_top + 16 * dx ** 4)  # a neck-wide notch with rounded corners
    target = (mh | egg) & ~(strip & egg)
    guide = bb.copy()
    guide[target] = (guide[target] * 0.25 + np.array([104, 70, 44]) * 0.75).astype(np.uint8)
    to_ref(guide, hb, (HEAD_REF, HEAD_REF)).save(refs / "ref-hair-back-shape.png")
    frames = {"bodyBox": BODY_BOX, "bodyRef": BODY_REF, "headBox": hb, "headRef": HEAD_REF, "headAxis": axis,
              "neckHalf": neck_half, "stripTop": strip_top, "eggRows": [min(rows), max(rows)]}
    (refs / "frames.json").write_text(json.dumps(frames, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(frames))


def neck_strip(bb, rows, axis):
    """Neck half-width (measured just below the egg on the back render) and the top row of the skin strip."""
    egg_bot = max(rows)
    m = sil(bb)
    y = egg_bot + 12
    cols = np.where(m[y])[0]
    cols = cols[np.abs(cols - axis) < 120]
    neck_half = float((cols.max() - cols.min() + 1) / 2) if len(cols) else 50.0
    egg_top = min(rows)
    strip_top = int(round(egg_top + 0.90 * (egg_bot - egg_top)))
    return neck_half, strip_top


def cmd_maptest(rig, render_png, out_png):
    """Mapping check: the user map's colours vs the renderer's own rest render (1x)."""
    doc, atlas, page_img = load_rig(Path(rig))
    lays = layers(doc, atlas["pages"][0])
    own, col = owner_map(lays, page_img)
    ref = np.asarray(Image.open(render_png).convert("RGB")).astype(int)
    m = own >= 0
    d = np.abs(col[..., :3].astype(int) - ref).sum(-1)
    inner = ndimage.binary_erosion(m, iterations=2)
    print("layers", [(L["slot"], L["path"].split("/")[-1], len(L["tris"])) for L in lays])
    print("owned px", int(m.sum()), "render sil px", int(sil(ref).sum()), "xor", int((m ^ sil(ref)).sum()),
          "mean |d| inner", float(d[inner].mean()), "p95", float(np.percentile(d[inner], 95)))
    vis = np.zeros_like(ref)
    vis[m] = col[m, :3]
    Image.fromarray(np.concatenate([vis, ref], 1).astype(np.uint8)).save(out_png)


# ---------------------------------------------------------------- registration
def from_ref(gen: Image.Image, box):
    """A generation in its reference frame -> canvas-size RGB via the reference box (outside the canvas dropped)."""
    x0, y0, x1, y1 = box
    g = np.asarray(gen.convert("RGB").resize((x1 - x0, y1 - y0), Image.LANCZOS))
    out = np.zeros((1448, 1086, 3), np.uint8)
    out[...] = BG
    sx0, sy0, sx1, sy1 = max(0, x0), max(0, y0), min(1086, x1), min(1448, y1)
    out[sy0:sy1, sx0:sx1] = g[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0]
    return out


def bg_mask(rgb, tol=26):
    """Background = close to the frame colour (the generation's backdrop drifts a few levels) and connected to the
    image border."""
    near = np.abs(rgb.astype(int) - BG).max(-1) <= tol
    lab, _ = ndimage.label(near)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]).tolist())) - {0}
    return np.isin(lab, list(border))


def shift_img(img, dx, dy, fill):
    out = np.empty_like(img)
    out[...] = fill
    H, W = img.shape[:2]
    xs0, xd0 = max(0, -dx), max(0, dx)
    ys0, yd0 = max(0, -dy), max(0, dy)
    w, h = W - abs(dx), H - abs(dy)
    out[yd0:yd0 + h, xd0:xd0 + w] = img[ys0:ys0 + h, xs0:xs0 + w]
    return out


def scale_about(img, sc, cx, cy, order=1, cval=0.0):
    """Scale a 2D array by sc about (cx, cy) (output pixel p samples input (p - c) / sc + c)."""
    return ndimage.affine_transform(img.astype(np.float32), np.diag([1 / sc, 1 / sc]), offset=[cy - cy / sc, cx - cx / sc], order=order, cval=cval)


def align(gen_rgb, fg, target, centre, max_shift=30, scales=np.arange(0.95, 1.0501, 0.005)):
    """Scale about centre + integer shift maximising IoU(fg, target). Returns (rgb, fg, params)."""
    cx, cy = centre
    ty, tx = [float(np.mean(v)) for v in np.where(target)]
    best = None
    for sc in scales:
        f = scale_about(fg, sc, cx, cy) > 0.5
        fy, fx = [float(np.mean(v)) for v in np.where(f)]
        bx, by = int(round(tx - fx)), int(round(ty - fy))
        for dy in range(by - 3, by + 4):
            for dx in range(bx - 3, bx + 4):
                if abs(dx) > max_shift or abs(dy) > max_shift:
                    continue
                g = shift_img(f, dx, dy, False)
                iou = (g & target).sum() / max(1, (g | target).sum())
                if best is None or iou > best[0]:
                    best = (float(iou), float(sc), dx, dy)
    iou, sc, dx, dy = best
    rgb = np.stack([scale_about(gen_rgb[..., c], sc, cx, cy, cval=float(BG[c])) for c in range(3)], -1)
    rgb = shift_img(np.clip(rgb + 0.5, 0, 255).astype(np.uint8), dx, dy, BG)
    f = shift_img(scale_about(fg, sc, cx, cy) > 0.5, dx, dy, False)
    return rgb, f, dict(scale=round(sc, 4), dx=int(dx), dy=int(dy), iou=round(iou, 4))


def nearest_fill(rgb, valid, where):
    """rgb at `where` <- the nearest `valid` pixel's colour."""
    _, (iy, ix) = ndimage.distance_transform_edt(~valid, return_indices=True)
    out = rgb.copy()
    out[where] = rgb[iy[where], ix[where]]
    return out


def hair_class(rgb, front_hair):
    """Hair pixels of a drawing: nearer (Lab) to the front hair's colours than to skin / backdrop / shirt / outline
    ones; the largest connected blob after closing and hole filling."""
    from common import to_lab
    a = front_hair[..., 3] > 0.9
    hair_cols = (front_hair[a][:, :3] * 255)[::97]
    others = np.array([[250, 200, 160], [244, 196, 152], [224, 160, 120], [180, 185, 194], [232, 226, 222], [200, 196, 194],
                       [69, 64, 61], [58, 16, 1]], float)
    lab = to_lab(rgb.reshape(-1, 3))

    def dmin(cols):
        d = np.full(len(lab), np.inf)
        for c in to_lab(cols):
            d = np.minimum(d, ((lab - c) ** 2).sum(-1))
        return d
    m = (dmin(hair_cols) < dmin(others)).reshape(rgb.shape[:2])
    m = ndimage.binary_closing(m, iterations=2)
    m = ndimage.binary_fill_holes(m)
    lab_, n = ndimage.label(m)
    if n:
        sizes = ndimage.sum(m, lab_, range(1, n + 1))
        m = lab_ == (1 + int(np.argmax(sizes)))
    return m


def skin_strip_width(alpha, egg, rows):
    """Widest run of uncovered egg (alpha < 0.5) on the egg's lower half, short of its last 6 rows."""
    best = 0
    top, bot = min(rows), max(rows)
    for y in range(int(top + 0.5 * (bot - top)), bot - 6):
        row = egg[y] & (alpha[y] < 0.5)
        if row.any():
            lab_, n = ndimage.label(row)
            best = max(best, max(int((lab_ == i).sum()) for i in range(1, n + 1)))
    return best


def egg_ink(rows):
    """The head egg's outline width (turnback_hair.egg_outline_width on the back rig's head region)."""
    from turnback_hair import egg_outline_width
    doc, atlas, page_img = load_rig(RIG / "back-turn00.anim.json")
    head_att = doc["skins"][next(iter(doc["skins"]))]["attachments"]["head"]["head"]
    r = atlas["pages"][0]["regions"][head_att["path"]]
    return egg_outline_width(page_img[r["y"]:r["y"] + r["height"], r["x"]:r["x"] + r["width"]])


def nape_reach(rgb, fg, cover):
    """The hair must cover the egg (inside its outline) down to the nape, except the neck strip. The drawing stops
    short at the sides, so per column the lower STRETCH_PX rows of the hair are stretched down until a smoothed
    envelope of its bottom edge (running max, then mean, over ENVELOPE px) reaches the bottom of `cover`; the tufts
    keep their own pointed ends. What is still uncovered between tufts takes the hair's shadow tone (the under-layer)."""
    H, W = fg.shape
    out_rgb, out_fg = rgb.astype(np.float32).copy(), fg.astype(np.float32).copy()
    cols = np.where(cover.any(0))[0]
    yt = np.array([np.where(cover[:, x])[0].max() for x in cols], float)
    yb = np.array([np.where(fg[:, x])[0].max() if fg[:, x].any() else 0 for x in cols], float)
    env = ndimage.uniform_filter1d(ndimage.maximum_filter1d(yb, ENVELOPE), ENVELOPE)
    for x, t, b in zip(cols, yt, env):
        if t <= b + 0.5:
            continue
        y0 = b - STRETCH_PX
        ys = np.arange(int(y0), int(t) + 1)
        src = y0 + (ys - y0) * (b - y0) / (t - y0)
        for c in range(3):
            out_rgb[ys, x, c] = np.interp(src, np.arange(H), rgb[:, x, c].astype(np.float32))
        out_fg[ys, x] = np.interp(src, np.arange(H), fg[:, x].astype(np.float32))
    m = out_fg > 0.5
    from common import lum
    L = lum(rgb[fg])
    shadow = np.median(rgb[fg][(L > np.quantile(L, 0.12)) & (L < np.quantile(L, 0.3))], axis=0)
    gap = cover & ~m
    out_rgb[gap] = shadow
    m |= gap
    return np.clip(out_rgb + 0.5, 0, 255).astype(np.uint8), m, int(gap.sum())


def hair_target(frames, rows, axis, front_hair):
    mh = mirror(front_hair, axis)
    egg = egg_fill(rows)
    yy, xx = np.mgrid[0:1448, 0:1086]
    dx = (xx + 0.5 - axis) / frames["neckHalf"]
    strip = (np.abs(dx) <= 1) & (yy >= frames["stripTop"] + 16 * dx ** 4) & egg
    return mh, egg, strip, ((mh[..., 3] > 0.5) | egg) & ~strip


def cmd_register():
    frames = json.loads((DROP / "refs/frames.json").read_text(encoding="utf-8"))
    tmp = DROP / "refs/_render"
    fin = FINAL
    fin.mkdir(parents=True, exist_ok=True)
    rep = {}
    # body: aligned to the rig's rest silhouette, then forced to it
    sf = np.asarray(Image.open(tmp / "stockfront.png").convert("RGB"))
    target = sil(sf)
    gen = from_ref(Image.open(DROP / "output/body-back.png"), frames["bodyBox"])
    fg = ~bg_mask(gen)
    ys, xs = np.where(target)
    rgb, fga, prm = align(gen, fg, target, (float(xs.mean()), float(ys.mean())))
    holes = target & ~fga
    body = nearest_fill(rgb, fga & target, holes)
    body[~target] = BG
    Image.fromarray(body).save(fin / "body-back-canvas.png")
    rep["body"] = dict(align=prm, droppedPx=int((fga & ~target).sum()), filledPx=int(holes.sum()), silhouettePx=int(target.sum()))
    # hair: aligned to the target shape; alpha forced (outside the egg = the mirrored front hair's)
    rows, axis = head_geom(RIG / "back-turn00.anim.json")
    front_hair = place_hair(Live(), HAIR)
    mh, egg, strip, target_h = hair_target(frames, rows, axis, front_hair)
    genh = from_ref(Image.open(DROP / "output/hair-back.png"), frames["headBox"])
    hair_fg = hair_class(genh, front_hair) & ndimage.binary_dilation(target_h, iterations=30)
    rgbh, fgh, prmh = align(genh, hair_fg, target_h, (axis, float(np.mean(list(rows)))))
    rgbh, fgh, gap_px = nape_reach(rgbh, fgh, egg_fill(rows, inset=egg_ink(rows) - EGG_OVERLAP) & ~strip)
    soft = ndimage.gaussian_filter(fgh.astype(np.float32), 0.8)
    egg_soft = ndimage.gaussian_filter(egg.astype(np.float32), 0.8)
    alpha = mh[..., 3] * (1 - egg_soft) + np.maximum(soft, mh[..., 3]) * egg_soft
    col = nearest_fill(rgbh, fgh, alpha > 0.02)
    layer = np.zeros((1448, 1086, 4), np.float32)
    layer[..., :3] = col / 255.0
    layer[..., 3] = np.clip(alpha, 0, 1)
    Image.fromarray(np.clip(layer * 255 + 0.5, 0, 255).astype(np.uint8)).save(fin / "hair-back-canvas.png")
    far = (egg_soft < 1e-3)
    rep["hair"] = dict(align=prmh, axis=axis, napeStripTop=frames["stripTop"], neckHalf=frames["neckHalf"],
                       outsideEggAlphaEqualsFront=bool(np.abs(layer[..., 3][far] - mh[..., 3][far]).max() < 1e-3),
                       napeGapFilledPx=gap_px, skinStripMaxWidthPx=skin_strip_width(layer[..., 3], egg, rows), neckWidthPx=2 * frames["neckHalf"])
    (fin / "register.report.json").write_text(json.dumps(rep, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(rep))


# ---------------------------------------------------------------- rest-pose texel <-> canvas mapping
def load_rig(rig_path: Path):
    doc = json.loads(Path(rig_path).read_text(encoding="utf-8"))
    atlas_path = Path(str(rig_path).replace(".anim.json", ".atlas.json"))
    atlas = json.loads(atlas_path.read_text(encoding="utf-8"))
    page_img = np.asarray(Image.open(atlas_path.parent / atlas["pages"][0]["file"]).convert("RGBA")).copy()
    return doc, atlas, page_img


def layers(doc, page):
    """Draw-ordered pieces at the setup pose: dict(slot, path, rect, xy (N,2) canvas, uv (N,2) region px, tris (M,3))."""
    w0 = setup_world(doc["bones"])
    ox, oy = doc["canvas"]["originX"], doc["canvas"]["originY"]
    skin = doc["skins"][next(iter(doc["skins"]))]["attachments"]
    meshes = {}
    for slot, atts in skin.items():
        for a in atts.values():
            if a["type"] == "mesh":
                meshes[slot] = a
    out = []
    for s in doc["slots"]:
        name = s["name"]
        pieces = []
        att = skin.get(name, {}).get(s.get("attachment")) if s.get("attachment") else None
        if att is not None and att["type"] == "region":
            rg = page["regions"][att["path"]]
            r = math.radians(att.get("rotation", 0.0))
            hw, hh = att["width"] / 2 * att.get("scaleX", 1), att["height"] / 2 * att.get("scaleY", 1)
            m = w0[s["bone"]]
            xy = []
            for u, v in ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)):
                lx, ly = att["x"] + math.cos(r) * u - math.sin(r) * v, att["y"] + math.sin(r) * u + math.cos(r) * v
                X, Y = apply(m, lx, ly)
                xy.append((X + ox, Y + oy))
            uv = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], float) * [rg["width"], rg["height"]]
            pieces.append((att["path"], np.array(xy), uv, np.array([[0, 1, 2], [0, 2, 3]])))
        # mesh triangles drawn at this slot: its own attachment's ungrouped tris, or any mesh's group named after it
        for mslot, a in meshes.items():
            groups = a.get("groups")
            tris = np.array(a["triangles"]).reshape(-1, 3)
            if groups:
                if name not in groups:
                    continue
                sel = np.concatenate([tris[t0:t1] for t0, t1 in groups[name]])
            elif mslot == name and s.get("attachment"):
                sel = tris
            else:
                continue
            rg = page["regions"][a["path"]]
            pieces.append((a["path"], mesh_world(a, w0) + [ox, oy], np.array(a["uvs"]).reshape(-1, 2) * [rg["width"], rg["height"]], sel))
        for path, xy, uv, tris in pieces:
            out.append(dict(slot=name, path=path, rect=page["regions"][path], xy=xy, uv=uv, tris=tris))
    return out


def mesh_world(a, w0):
    names, v, pts, i = a["bones"], a["vertices"], [], 0
    while i < len(v):
        n = int(v[i])
        i += 1
        x = y = 0.0
        for _ in range(n):
            bi, lx, ly, wt = int(v[i]), v[i + 1], v[i + 2], v[i + 3]
            X, Y = apply(w0[names[bi]], lx, ly)
            x += wt * X
            y += wt * Y
            i += 4
        pts.append((x, y))
    return np.array(pts)


def raster(src, dst, tris, shape):
    """For every pixel centre of a (H, W) grid inside a triangle of dst: the barycentric image of it in src.
    Returns (ys, xs, sx, sy) arrays (first triangle wins)."""
    H, W = shape
    seen = np.zeros(shape, bool)
    out = []
    for t in tris:
        (x0, y0), (x1, y1), (x2, y2) = dst[t]
        bx0, bx1 = max(0, int(math.floor(min(x0, x1, x2)))), min(W, int(math.ceil(max(x0, x1, x2))) + 1)
        by0, by1 = max(0, int(math.floor(min(y0, y1, y2)))), min(H, int(math.ceil(max(y0, y1, y2))) + 1)
        if bx1 <= bx0 or by1 <= by0:
            continue
        det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(det) < 1e-9:
            continue
        gy, gx = np.mgrid[by0:by1, bx0:bx1]
        px, py = gx + 0.5, gy + 0.5
        l0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / det
        l1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / det
        l2 = 1 - l0 - l1
        ins = (l0 >= -1e-4) & (l1 >= -1e-4) & (l2 >= -1e-4) & ~seen[by0:by1, bx0:bx1]
        if not ins.any():
            continue
        seen[by0:by1, bx0:bx1] |= ins
        s = src[t]
        sx = l0 * s[0, 0] + l1 * s[1, 0] + l2 * s[2, 0]
        sy = l0 * s[0, 1] + l1 * s[1, 1] + l2 * s[2, 1]
        out.append((gy[ins], gx[ins], sx[ins], sy[ins]))
    if not out:
        return (np.zeros(0, int),) * 2 + (np.zeros(0),) * 2
    return tuple(np.concatenate([o[k] for o in out]) for k in range(4))


def owner_map(lays, page_img, shape=(1448, 1086)):
    """Topmost opaque (alpha > 128) layer per canvas pixel, and the atlas colour it shows (nearest texel)."""
    own = np.full(shape, -1, int)
    col = np.zeros(shape + (4,), np.uint8)
    for li, L in enumerate(lays):
        ys, xs, u, v = raster(L["uv"], L["xy"], L["tris"], shape)
        r = L["rect"]
        tx = np.clip(np.floor(u).astype(int), 0, r["width"] - 1) + r["x"]
        ty = np.clip(np.floor(v).astype(int), 0, r["height"] - 1) + r["y"]
        px = page_img[ty, tx]
        op = px[:, 3] > 128
        own[ys[op], xs[op]] = li
        col[ys[op], xs[op]] = px[op]
    return own, col


BODY_SLOTS = {"hips", "torso", "shorts", "tank", "upper_arm", "tank_armhole", "forearm", "hand", "upper_arm_r", "tank_armhole_r", "forearm_r", "hand_r"}
STROKE_DIFF = 40  # render vs texture-only reconstruction (sum |d| over RGB) above this = an engine contour stroke
STROKE_BAND = 8  # px the stroke mask is grown by: drawn pixels there are replaced (the engine draws its own ink)
HIDDEN_NECKLINE = ("tank", "neckline")  # the front V-neck trim contour; the back's scoop trim is drawn in the texture
SEAM_ROWS = (14, 96)  # shorts region rows of the seat seam (views/body-back back_body.py)


def cmd_rig(rig, out_dir, stem):
    """Paste final/body-back-canvas.png into a copy of the back stock rig's atlas (see the header)."""
    rig, out = Path(rig), Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    doc, atlas, page_img = load_rig(rig)
    src_doc = json.loads(rig.read_text(encoding="utf-8"))
    page = atlas["pages"][0]
    # the V-neck trim contour is front art: transparent (kept, so contact bands that name it stay valid)
    c = doc["skins"][next(iter(doc["skins"]))]["contours"][HIDDEN_NECKLINE[0]][HIDDEN_NECKLINE[1]]
    c["color"] = c["color"][:6] + "00"
    lays = layers(doc, page)
    own, recon = owner_map(lays, page_img)
    tmp = Path(tempfile.mkdtemp(prefix="back-drawn-"))
    probe = out / f"{stem}-probe.anim.json"
    probe.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    Path(str(probe).replace(".anim.json", ".atlas.json")).write_text(json.dumps(atlas), encoding="utf-8")
    render(tmp, 1, "rest", 0, {"probe": probe, "src": rig})
    probe.unlink()
    Path(str(probe).replace(".anim.json", ".atlas.json")).unlink()
    rend = np.asarray(Image.open(tmp / "probe.png").convert("RGB")).astype(int)
    stroke = sil(rend) & ((np.abs(rend - recon[..., :3].astype(int)).sum(-1) > STROKE_DIFF) | (own < 0))
    band = ndimage.binary_dilation(stroke, iterations=STROKE_BAND)
    drawn = np.asarray(Image.open(FINAL / "body-back-canvas.png").convert("RGB")).copy()
    for li, L in enumerate(lays):
        if L["slot"] not in BODY_SLOTS:
            continue
        mine = own == li
        if (mine & ~band).any() and (mine & band).any():
            drawn = nearest_fill(drawn, mine & ~band, mine & band)
    img = page_img.copy()
    set_mask = {}
    for li, L in enumerate(lays):
        if L["slot"] not in BODY_SLOTS:
            continue
        r = L["rect"]
        ty, tx, cx, cy = raster(L["xy"], L["uv"], L["tris"], (r["height"], r["width"]))
        ix, iy = np.clip(np.floor(cx).astype(int), 0, 1085), np.clip(np.floor(cy).astype(int), 0, 1447)
        ok = (own[iy, ix] == li) & (img[r["y"] + ty, r["x"] + tx, 3] > 0)
        vals = np.stack([ndimage.map_coordinates(drawn[..., k].astype(np.float32), [cy[ok] - 0.5, cx[ok] - 0.5], order=1, mode="nearest") for k in range(3)], -1)
        img[r["y"] + ty[ok], r["x"] + tx[ok], :3] = np.clip(vals + 0.5, 0, 255).astype(np.uint8)
        sm = set_mask.setdefault(L["path"], np.zeros((r["height"], r["width"]), bool))
        sm[ty[ok], tx[ok]] = True
    hidden = {}
    for path, sm in set_mask.items():
        r = page["regions"][path]
        sub = img[r["y"]:r["y"] + r["height"], r["x"]:r["x"] + r["width"]]
        where = (sub[..., 3] > 0) & ~sm
        sub[..., :3] = nearest_fill(sub[..., :3], sm, where)
        hidden[path.split("/")[-1]] = int(where.sum())
    seam = seat_seam(img, page["regions"]["canonical/template7-leg-shorts"])
    stem_files = {"anim": out / f"{stem}.anim.json", "atlas": out / f"{stem}.atlas.json", "png": out / f"{stem}.atlas.png"}
    doc["name"] = stem
    stem_files["anim"].write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    page["file"] = stem_files["png"].name
    stem_files["atlas"].write_text(json.dumps(atlas, indent=1), encoding="utf-8")
    Image.fromarray(img).save(stem_files["png"])
    # gates (as views/body-back/body-back.report.json)
    render(tmp, 1, "rest", 0, {"new": stem_files["anim"]})
    old = np.asarray(Image.open(tmp / "src.png").convert("RGB"))
    new = np.asarray(Image.open(tmp / "new.png").convert("RGB"))
    shutil.copy(tmp / "new.png", FINAL / "body-back-rest-1x.png")
    fs, bs = sil(old), sil(new)
    diff = np.abs(old.astype(int) - new.astype(int)).sum(-1) > 0
    strip = lambda d: {k: v for k, v in d.items() if k not in ("name", "skins")}  # noqa: E731
    sk_a, sk_b = (json.loads(json.dumps(d["skins"])) for d in (src_doc, doc))
    sk_b[next(iter(sk_b))]["contours"][HIDDEN_NECKLINE[0]][HIDDEN_NECKLINE[1]]["color"] = \
        sk_a[next(iter(sk_a))]["contours"][HIDDEN_NECKLINE[0]][HIDDEN_NECKLINE[1]]["color"]
    rep = dict(source=rig.as_posix(), art=(FINAL / "body-back-canvas.png").as_posix(), changedPx=int(diff.sum()),
               silhouetteXorPx=int((fs ^ bs).sum()), hiddenTexelsFilled=hidden, seatSeam=seam, strokeBandPx=int(band.sum()),
               neckline=f"contour {'/'.join(HIDDEN_NECKLINE)} colour alpha 00 (front V trim hidden; the scoop trim is drawn art)",
               gates=dict(silhouetteIdentical=bool((fs ^ bs).sum() == 0), meshSkeletonVerbatim=bool(strip(src_doc) == strip(doc) and sk_a == sk_b),
                          artChangedOnlyInside=bool((diff & ~fs).sum() == 0)))
    (out / f"{stem}.report.json").write_text(json.dumps(rep, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(rep))


def seat_seam(img, r):
    """A thin seat seam down the shorts' centre (the drawing has none): the region's dark tone, 2 px + a 1 px blend."""
    reg = img[r["y"]:r["y"] + r["height"], r["x"]:r["x"] + r["width"]]
    al = reg[..., 3] > 200
    cloth = np.median(reg[..., :3][al], axis=0)
    shade = np.percentile(reg[..., :3][al], 4, axis=0)
    cx = r["width"] // 2 + 1
    for y in range(*SEAM_ROWS):
        if al[y, cx - 1:cx + 2].all():
            reg[y, cx - 1:cx + 1, :3] = shade.astype(np.uint8)
            reg[y, cx + 1, :3] = ((shade + cloth) / 2).astype(np.uint8)
    return dict(x=cx, rows=list(SEAM_ROWS), colour=[int(v) for v in shade])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("refs", "register", "rig", "maptest"))
    ap.add_argument("args", nargs="*")
    a = ap.parse_args()
    if a.cmd == "refs":
        cmd_refs()
    elif a.cmd == "maptest":
        cmd_maptest(*a.args)
    elif a.cmd == "register":
        cmd_register()
    else:
        cmd_rig(*a.args)


if __name__ == "__main__":
    main()
