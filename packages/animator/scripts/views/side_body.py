# Atlas Animator multi-view swag, phase 2 step 1 (docs/plans/atlas-animator-views.md): the TURNED-SIDE body art.
#   python side_body.py guide  <out dir>              the reference inputs (ref/) for one side-body draw
#   python side_body.py polish <gen.png> <out dir>    register + polish one returned draw onto the rig canvas
# The side body is drawn ONE view per draw at the polish scale (8/3 canvas px per px, the front's draw scale): a
# portrait 1024x1536 output covers the canvas crop SIDE_CROP (384x576 canvas px: neck to below the feet), so the
# returned art is only ever downsampled (x3/8) onto the 1086x1448 canvas, never enlarged.
# Guide = code-built construction on the canvas: the approved turned pose (threeview-test-01 step3a panel 2, the
# owner's pick) registered to the front body by the front panel's own fit (scale + offset: panel 1 vs the front
# body's alpha box), shown as a faint pose shape, plus the front body's landmark rows as thin cyan lines (neck under
# the head, shoulder top, fist bottom, shorts waist, shorts leg hem, ground). The front body at the same scale is the
# style reference. Every number is measured from the front body PNG and the reference; nothing is hand placed.
# Polish: background -> alpha (distance from the guide's flat grey, holes filled), registration by the ground row
# and the pose centre (whole-pixel shift, reported; scale is fixed by the guide), downsample once to 1x canvas,
# skin/shorts/ink Lab remap to the front body's palette on interior pixels (view_polish's remap), ink check.
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as nd

sys.path.insert(0, str(Path(__file__).parent))
from common import DROPS, from_lab, kmeans_lab, lum, save_json, to_lab  # noqa: E402

K = 8 / 3
SIDE_CROP = (350, 670, 734, 1246)  # canvas px, 384x576 -> 1024x1536
OUT_SIZE = (1024, 1536)
FRONT_BODY = DROPS / "player-smooth-01/final/bodies/template7-clean.png"
TURNED_REF = DROPS / "threeview-test-01/step3a/output/gen-1.png"  # 3 panels: front | turned | back, 512 px each
BG = (180, 185, 194)  # the render background (#b4b9c2), also the guide background
CYAN = (0, 170, 220)
NECK_TOP = 630  # canvas row the neck is continued up to (the front head's bottom is ~650: covered)


def fg_mask(rgb, bg, tol=26):
    d = np.abs(rgb.astype(int) - np.array(bg)).sum(-1)
    m = d > tol
    m = nd.binary_opening(m, iterations=2)
    lab, n = nd.label(m)
    if n == 0:
        return m
    sizes = nd.sum(m, lab, range(1, n + 1))
    keep = np.isin(lab, 1 + np.nonzero(sizes >= 0.02 * sizes.max())[0])
    return nd.binary_fill_holes(keep)


def landmarks(front):
    """Rows on the canvas, measured from the front body (alpha + material)."""
    al = front[..., 3] > 128
    rgb = front[..., :3].astype(int)
    ys = np.nonzero(al.any(1))[0]
    width = np.array([al[y].sum() for y in range(front.shape[0])])
    sat = rgb.max(-1) - rgb.min(-1)
    shorts = al & (sat < 30) & (lum(front[..., :3]) > 170)
    rows = shorts.sum(1) > 40
    lab, n = nd.label(rows)
    srows = np.nonzero(lab == n)[0]  # the shorts: the lowest run of white-material rows (the tank is the run above)
    trows = np.nonzero(lab == 1)[0]
    # neck: the narrowest row between the head and the shoulders (head = the wide top blob)
    mid = range(ys.min() + int(0.35 * (ys.max() - ys.min())), ys.min() + int(0.55 * (ys.max() - ys.min())))
    neck = min(mid, key=lambda y: width[y])
    sh = neck + int(np.argmax(np.diff(width[neck:neck + 80]) > 0) or 0)
    sh = next(y for y in range(neck, neck + 120) if width[y] > 1.8 * width[neck])
    # fists: the widest rows below the shoulders end where the width drops to the hips/shorts width
    below = range(srows.min(), srows.max())
    fist_bottom = max(y for y in below if width[y] > 1.35 * width[srows.max()])
    return dict(neck=int(neck), shoulderTop=int(sh), tankTop=int(trows.min()), waist=int(srows.min()), shortsHem=int(srows.max()),
                fistBottom=int(fist_bottom), ground=int(ys.max()), headTop=int(ys.min()))


def register_turned(front):
    """The turned reference panel on the canvas: the front panel's fit to the front body applied to panel 2."""
    g = np.array(Image.open(TURNED_REF).convert("RGB"))
    bg = np.median(g[5:40, 5:40].reshape(-1, 3), 0)
    p1 = fg_mask(g[:, 30:500], bg)
    p2 = fg_mask(g[:, 530:1010], bg)
    al = front[..., 3] > 128
    fy, fx = np.nonzero(al)
    y1, x1 = np.nonzero(p1)
    s = (fy.max() - fy.min()) / (y1.max() - y1.min())
    # canvas = (gen - gen_anchor) * s + canvas_anchor: the ground row, and the head's centre column (the body
    # turns about its vertical axis, so the turned head stays over the same canvas x as the front head)
    def head_cx(m):
        yy, xx = np.nonzero(m)
        top = yy < yy.min() + 0.3 * (yy.max() - yy.min())
        return (xx[top].min() + xx[top].max()) / 2
    cx_f = head_cx(al)
    W, H = front.shape[1], front.shape[0]
    panel = np.dstack([g[:, 530:1010], (p2 * 255).astype(np.uint8)])
    im = Image.fromarray(panel).resize((round(panel.shape[1] * s), round(panel.shape[0] * s)), Image.LANCZOS)
    ox = round(cx_f - head_cx(p2) * s)
    oy = round(fy.max() - y1.max() * s)
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    canvas.alpha_composite(im, (ox, oy)) if ox >= 0 and oy >= 0 else canvas.paste(im, (ox, oy), im)
    # the reference was drawn at 0.82x with its own proportions (higher shorts, longer legs): a piecewise-linear
    # row warp puts its neck, shorts top, shorts bottom and ground on the front's rows (the skeleton's proportions)
    t = np.array(canvas)
    src = turned_rows(t)
    dst = landmarks(front)
    keys = ["headTop", "neck", "waist", "shortsHem", "ground"]
    sy = np.interp(np.arange(H), [dst[k] for k in keys], [src[k] for k in keys])
    out = np.zeros_like(t)
    for ch in range(4):
        out[..., ch] = nd.map_coordinates(t[..., ch].astype(float), [np.repeat(sy[:, None], W, 1), np.repeat(np.arange(W, dtype=float)[None], H, 0)], order=1).clip(0, 255)
    return Image.fromarray(out), dict(scale=float(s), offset=[ox, oy], rowsBefore={k: src[k] for k in keys}, rowsAfter={k: dst[k] for k in keys},
                                      note="panel 2 placed with panel 1's fit (head centre column, ground), then rows warped to the front's landmarks")


def turned_rows(t):
    al = t[..., 3] > 128
    ys = np.nonzero(al.any(1))[0]
    width = al.sum(1)
    rgb = t[..., :3].astype(int)
    white = al & ((rgb.max(-1) - rgb.min(-1)) < 30) & (lum(t[..., :3]) > 170)
    rows = white.sum(1) > 40
    lab, n = nd.label(rows)
    big = 1 + int(np.argmax(nd.sum(rows, lab, range(1, n + 1))))
    sr = np.nonzero(lab == big)[0]
    mid = range(ys.min() + int(0.35 * (ys.max() - ys.min())), ys.min() + int(0.55 * (ys.max() - ys.min())))
    return dict(headTop=int(ys.min()), neck=int(min(mid, key=lambda y: width[y])), waist=int(sr.min()), shortsHem=int(sr.max()), ground=int(ys.max()))


def to_out(x, y):
    return ((x - SIDE_CROP[0]) * K, (y - SIDE_CROP[1]) * K)


def guide(out):
    out = Path(out)
    ref = out / "ref"
    ref.mkdir(parents=True, exist_ok=True)
    front = np.array(Image.open(FRONT_BODY).convert("RGBA"))
    lm = landmarks(front)
    turned, reg = register_turned(front)
    turned.save(out / "turned-ref-canvas.png")
    t = np.array(turned)
    pose = nd.binary_fill_holes(t[..., 3] > 128)
    # guide on the canvas: flat background, the pose as a pale flat shape with a thin mid-grey edge (a pose guide,
    # not a hard silhouette), the turned reference faintly inside it for the arm/leg arrangement
    c = np.zeros(front.shape[:2] + (3,), float) + BG
    faint = 255 - (255 - t[..., :3].astype(float)) * 0.35
    c[pose] = 0.5 * faint[pose] + 0.5 * np.array([226, 228, 232])
    edge = pose & ~nd.binary_erosion(pose, iterations=2)
    c[edge] = (120, 124, 132)
    g = Image.fromarray(c.astype(np.uint8)).crop(SIDE_CROP).resize(OUT_SIZE, Image.LANCZOS)
    d = ImageDraw.Draw(g)
    rows = {k: lm[k] for k in ("neck", "shoulderTop", "waist", "fistBottom", "shortsHem", "ground")}
    for k, y in rows.items():
        Y = to_out(0, y)[1]
        if 0 <= Y < OUT_SIZE[1]:
            for x0 in range(0, OUT_SIZE[0], 24):  # dashed
                d.line([(x0, Y), (x0 + 14, Y)], fill=CYAN, width=3)
    g.save(ref / "guide-side.png")
    # the approved front body at the same scale (its own wider crop, same rows)
    al = front[..., 3] > 128
    xs = np.nonzero(al.any(0))[0]
    fbox = (int(xs.min()) - 16, SIDE_CROP[1], int(xs.max()) + 16, SIDE_CROP[3])
    fb = Image.new("RGBA", front.shape[1::-1], BG + (255,))
    fb.alpha_composite(Image.fromarray(front))
    fbi = fb.crop(fbox).resize((round((fbox[2] - fbox[0]) * K), OUT_SIZE[1]), Image.LANCZOS).convert("RGB")
    fd = ImageDraw.Draw(fbi)
    for k, y in rows.items():
        Y = (y - SIDE_CROP[1]) * K
        for x0 in range(0, fbi.width, 24):
            fd.line([(x0, Y), (x0 + 14, Y)], fill=CYAN, width=3)
    fbi.save(ref / "front-body.png")
    # the owner's turned pick, panel 2 alone, at its native size (pose and turn reference only; never pasted)
    Image.open(TURNED_REF).convert("RGB").crop((512, 0, 1024, 1024)).save(ref / "turned-pick.png")
    save_json(out / "guide.json", dict(crop=SIDE_CROP, scale=K, outSize=OUT_SIZE, landmarks=lm, rowsInOutput={k: round(to_out(0, y)[1], 1) for k, y in rows.items()}, turnedRegistration=reg))
    print(json.dumps(dict(landmarks=lm, reg=reg)))


def front_palette(front, k=7):
    al = nd.binary_erosion(front[..., 3] > 200, iterations=3)
    lab = to_lab(front[..., :3][al].reshape(-1, 3))
    return kmeans_lab(lab[:: max(1, len(lab) // 60000)], k)


def remap(a, cents, edge_in=6):
    """Per-cluster Lab ramp shift (front cluster centre - this art's cluster median) on interior pixels; the
    outline band (edge_in px) and the ink cluster (the darkest) are left as painted."""
    al = a[..., 3] > 200
    inner = nd.binary_erosion(al, iterations=edge_in)
    lab = to_lab(a[..., :3][inner].reshape(-1, 3))
    lbl = np.argmin(((lab[:, None, :] - cents[None]) ** 2).sum(-1), 1)
    new = lab.copy()
    offs = {}
    for i in range(1, len(cents)):
        sel = lbl == i
        if sel.sum() < 50:
            continue
        off = cents[i] - np.median(lab[sel], 0)
        if np.linalg.norm(off) > 12:  # not the same material: leave it (reported)
            offs[f"c{i}"] = dict(skipped=off.round(1).tolist())
            continue
        new[sel] += off
        offs[f"c{i}"] = off.round(2).tolist()
    out = a.copy()
    out[..., :3][inner] = from_lab(new)
    return out, offs


def polish(gen, out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    g = np.array(Image.open(gen).convert("RGB"))
    rep = dict(source=str(gen), size=list(g.shape[1::-1]))
    if g.shape[:2] != OUT_SIZE[::-1]:
        rep["error"] = f"returned size {g.shape[1::-1]} != {OUT_SIZE}"
    bg = np.median(np.concatenate([g[:8].reshape(-1, 3), g[-8:].reshape(-1, 3), g[:, :8].reshape(-1, 3), g[:, -8:].reshape(-1, 3)]), 0)
    m = fg_mask(g, bg, tol=34)
    # soft alpha at 1x: downsample the mask with the colour (premultiplied), once
    W, H = Image.open(FRONT_BODY).size
    w, h = round(OUT_SIZE[0] / K), round(OUT_SIZE[1] / K)
    rgba = np.dstack([g, (m * 255).astype(np.uint8)])
    small = Image.fromarray(rgba).resize((w, h), Image.LANCZOS)
    pm = np.array(Image.fromarray((g * m[..., None]).astype(np.uint8)).resize((w, h), Image.LANCZOS)).astype(float)
    a = np.array(small)[..., 3].astype(float)
    col = np.clip(pm / np.maximum(a[..., None] / 255, 1e-3), 0, 255)
    canvas = np.zeros((H, W, 4), np.uint8)
    canvas[SIDE_CROP[1]:SIDE_CROP[1] + h, SIDE_CROP[0]:SIDE_CROP[0] + w, :3] = col.astype(np.uint8)
    canvas[SIDE_CROP[1]:SIDE_CROP[1] + h, SIDE_CROP[0]:SIDE_CROP[0] + w, 3] = a.astype(np.uint8)
    canvas[canvas[..., 3] < 8] = 0
    # the crop starts below the head's bottom: the neck continues up under the head (the top row repeated up to
    # the front's neck row minus NECK_UNDER px; the head layer covers it, so no seam can show between head and neck)
    y0 = SIDE_CROP[1]
    top = canvas[y0 + 1].copy()
    for y in range(NECK_TOP, y0 + 1):
        canvas[y] = top
    # registration: the ground row to the front's ground, whole pixels (scale is fixed by the guide)
    front = np.array(Image.open(FRONT_BODY).convert("RGBA"))
    lm = landmarks(front)
    al = canvas[..., 3] > 128
    ys, xs = np.nonzero(al)
    dy = lm["ground"] - int(ys.max())
    canvas = np.roll(canvas, dy, axis=0)
    rep["registration"] = dict(groundShiftPx=dy, limitPx=round(0.02 * (lm["ground"] - lm["neck"]), 1))
    # palette: the front body's material clusters, remapped on interior pixels (outline band kept)
    pal = front_palette(front)
    canvas, rep["paletteOffsets"] = remap(canvas, pal)
    # outline gate (plan: measured along contours, >= 0.9x the front's): dark outline px per contour px, below the
    # neck (the front's head excluded); one deterministic re-ink pass (1 px ink ring outside) when it is short
    def ink_per_contour(a):
        a = a.copy()
        a[:NECK_TOP + 40] = 0
        al = a[..., 3] > 128
        band = al & (lum(a[..., :3]) < 70) & (nd.distance_transform_edt(al) < 20)
        per = (al & ~nd.binary_erosion(al)).sum()
        return float(band.sum() / max(per, 1))
    f_ink = ink_per_contour(front)
    s_ink = ink_per_contour(canvas)
    rep["outline"] = dict(front=round(f_ink, 2), before=round(s_ink, 2), ratioBefore=round(s_ink / f_ink, 3))
    passes = 0
    while s_ink / f_ink < 0.9 and passes < 2:
        al = canvas[..., 3] > 128
        inkc = np.median(canvas[..., :3][al & (lum(canvas[..., :3]) < 40)], 0)
        d = nd.distance_transform_edt(~al)
        ring = (d > 0) & (d < 2)
        na = np.clip(2.0 - d, 0, 1) * 255  # antialiased 1 px ring: full at 1 px out, fading over the next px
        canvas[ring, :3] = inkc.astype(np.uint8)
        canvas[ring, 3] = np.maximum(canvas[ring, 3], na[ring]).astype(np.uint8)
        passes += 1
        s_ink = ink_per_contour(canvas)
    rep["outline"].update(reinkPasses=passes, after=round(s_ink, 2), ratio=round(s_ink / f_ink, 3), ok=bool(s_ink / f_ink >= 0.9))
    Image.fromarray(canvas).save(out / "body-side.png")
    save_json(out / "polish.json", rep)
    print(json.dumps(rep))


if __name__ == "__main__":
    {"guide": guide, "polish": polish}[sys.argv[1]](*sys.argv[2:])
