# Atlas Animator multi-view (docs/plans/atlas-animator-views.md): the TURNED-SIDE HEAD art (face + hair), replacing
# the shared front head that stood in on the side rig.
#   python side_head.py guide  <out dir>              the reference inputs (ref/) for one side-head draw
#   python side_head.py polish <gen.png> <out dir>    polish one returned draw onto the rig canvas (layers/head.turned.png)
# Drawn at the polish scale: a square output (asked 1024x1024; the tool may return 1254x1254) covers the canvas crop HEAD_CROP (780x780 canvas px: hair top
# to the shoulders), so the returned art is only ever downsampled (780/size) onto the 1086x1448 canvas, never enlarged.
# Guide = the side body art (body-side.png) with the shared head's shape (the side rig's head region: crop x keep
# polygon) as a pale flat shape with a thin grey edge, and cyan dashed rows: head top, eye line, chin. The live look
# reference = the shared head with the live face and hair layers (scripts/proto-face-hair.ts placement, moved onto the
# side head joint: +22 px x) at the same crop and scale, with the same rows.
# Polish: background -> alpha (distance from the flat grey, holes filled), downsample once (premultiplied), cut the
# head from the body (every row above CUT_ROW; below it only inside the head shape grown by CHIN_GROW px), chin
# registration (whole-pixel dy so the head's lowest row inside the head shape's columns lands on the shape's chin row,
# limit 5% of the head height), Lab cluster remap to the live look's palette on interior pixels, outline gate (dark
# outline px per contour px >= 0.9x the live look's) with at most two antialiased 1 px re-ink passes.
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as nd

sys.path.insert(0, str(Path(__file__).parent))
from common import DROPS, lum, save_json  # noqa: E402
from side_body import fg_mask, front_palette, remap  # noqa: E402

HERE = Path(__file__).resolve().parents[2]
CANON = HERE / "fixtures/canonical/body-side"
SHARED = CANON / "layers/head.shared.png"
OUT_LAYER = CANON / "layers/head.turned.png"
BODY = DROPS / "views-body-side/body-side.png"
GAME = Path("C:/Users/dev/Documents/game/packages/player-renderer/src/assets/player-appearance")
# live face + hair (scripts/proto-face-hair.ts: canvas dy on the front head), moved onto the side head joint (+22, 0)
LIVE = [("eyes/browneyes.png", 22, -74), ("hair/soldiercrophairmale.png", 22, -138)]
HEAD_CROP = (200, 20, 980, 800)  # canvas px, 780x780 -> 1024x1024
OUT_SIZE = (1024, 1024)
K = OUT_SIZE[0] / (HEAD_CROP[2] - HEAD_CROP[0])
BG = (180, 185, 194)
CYAN = (0, 170, 220)
ROWS = {"headTop": 172, "eyeLine": 541, "chin": 653}
CUT_ROW = 610
CHIN_GROW = 6
NOTCH = 2  # canvas row: above it every foreground px is head or hair; below it only the head shape (chin)


def head_shape():
    """The side rig's current head region (side_presets.shared_head): head.shared.png alpha inside the region keep."""
    reg = json.loads((CANON / "side-near-arm.part.json").read_text(encoding="utf-8"))
    r = next(x for x in reg["regions"] if x["name"] == "head")
    a = np.array(Image.open(SHARED).convert("RGBA"))
    m = Image.new("L", a.shape[1::-1], 0)
    ImageDraw.Draw(m).polygon([tuple(p) for p in r["keep"]], fill=255)
    a[..., 3] = np.minimum(a[..., 3], np.array(m))
    return a, r


def layer(rel, dx, dy, size):
    im = Image.open(GAME / rel).convert("RGBA")
    out = Image.new("RGBA", size, (0, 0, 0, 0))
    out.paste(im, (dx, dy), im)
    return out


def live_look():
    head, _ = head_shape()
    c = Image.fromarray(head)
    for rel, dx, dy in LIVE:
        c.alpha_composite(layer(rel, dx, dy, c.size))
    return np.array(c)


def to_out(img):
    return img.crop(HEAD_CROP).resize(OUT_SIZE, Image.LANCZOS)


def rows(img):
    d = ImageDraw.Draw(img)
    for y in ROWS.values():
        Y = (y - HEAD_CROP[1]) * K
        for x0 in range(0, img.width, 24):
            d.line([(x0, Y), (x0 + 14, Y)], fill=CYAN, width=3)
    return img


def guide(out):
    out = Path(out)
    ref = out / "ref"
    ref.mkdir(parents=True, exist_ok=True)
    head, _ = head_shape()
    body = Image.open(BODY).convert("RGBA")
    c = Image.new("RGBA", body.size, BG + (255,))
    c.alpha_composite(body)
    g = np.array(c)[..., :3].astype(float)
    shape = nd.binary_fill_holes(head[..., 3] > 128)
    g[shape] = (226, 228, 232)
    edge = shape & ~nd.binary_erosion(shape, iterations=2)
    g[edge] = (120, 124, 132)
    rows(to_out(Image.fromarray(g.astype(np.uint8)))).save(ref / "guide-side-head.png")
    lv = Image.new("RGBA", body.size, BG + (255,))
    lv.alpha_composite(Image.fromarray(live_look()))
    rows(to_out(lv).convert("RGB")).save(ref / "live-front-head.png")
    save_json(out / "guide.json", dict(crop=HEAD_CROP, scale=round(K, 5), outSize=OUT_SIZE, rows=ROWS,
                                       rowsInOutput={k: round((y - HEAD_CROP[1]) * K, 1) for k, y in ROWS.items()}))
    print("wrote", ref)


def polish(gen, out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    g = np.array(Image.open(gen).convert("RGB"))
    rep = dict(source=str(gen), size=list(g.shape[1::-1]))
    side = HEAD_CROP[2] - HEAD_CROP[0]
    if g.shape[0] != g.shape[1] or g.shape[0] < side:
        raise SystemExit(f"returned size {g.shape[1::-1]}: must be square and >= {side} px (never enlarged), redraw")
    rep["scale"] = round(side / g.shape[0], 5)  # the same framing as the guide; the tool may return 1254 px
    bg = np.median(np.concatenate([g[:8].reshape(-1, 3), g[-8:].reshape(-1, 3), g[:, :8].reshape(-1, 3), g[:, -8:].reshape(-1, 3)]), 0)
    m = fg_mask(g, bg, tol=34)
    head, _ = head_shape()
    H, W = head.shape[:2]
    w = h = HEAD_CROP[2] - HEAD_CROP[0]
    small = Image.fromarray(np.dstack([g, (m * 255).astype(np.uint8)])).resize((w, h), Image.LANCZOS)
    pm = np.array(Image.fromarray((g * m[..., None]).astype(np.uint8)).resize((w, h), Image.LANCZOS)).astype(float)
    a = np.array(small)[..., 3].astype(float)
    col = np.clip(pm / np.maximum(a[..., None] / 255, 1e-3), 0, 255)
    canvas = np.zeros((H, W, 4), np.uint8)
    x0, y0 = HEAD_CROP[:2]
    canvas[y0:y0 + h, x0:x0 + w, :3] = col.astype(np.uint8)
    canvas[y0:y0 + h, x0:x0 + w, 3] = a.astype(np.uint8)
    canvas[canvas[..., 3] < 8] = 0
    # chin registration (whole px dy): the face's skin (the largest skin-coloured component that starts above the eye
    # line; the neck's skin is cut off from it by the chin outline) ends at the chin's inner edge; the chin outline's
    # dark run below it gives the art's chin row, which lands on the head shape's chin row
    shape = nd.binary_fill_holes(head[..., 3] > 128)
    sy, sx = np.nonzero(shape)
    chin_shape = int(sy.max())
    look = live_look()
    lal = nd.binary_erosion(look[..., 3] > 200, iterations=3)
    skin_ref = np.median(look[..., :3][lal & shape & (np.arange(H)[:, None] > ROWS["eyeLine"] + 40)], 0)
    skin = (canvas[..., 3] > 200) & (np.abs(canvas[..., :3].astype(int) - skin_ref).max(-1) < 34)
    lab, n = nd.label(skin)
    tops = nd.minimum(np.arange(H)[:, None].repeat(W, 1), lab, range(1, n + 1))
    sizes = nd.sum(skin, lab, range(1, n + 1))
    face = 1 + max((i for i in range(n) if tops[i] < ROWS["eyeLine"]), key=lambda i: sizes[i])
    fy, fx = np.nonzero(lab == face)
    inner = int(fy.max())
    col = int(np.median(fx[fy == inner]))
    run = 0
    while inner + 1 + run < H and lum(canvas[inner + 1 + run, col, :3][None])[0] < 90 and canvas[inner + 1 + run, col, 3] > 128:
        run += 1
    chin_art = inner + run
    limit = round(0.05 * (ROWS["chin"] - ROWS["headTop"]), 1)
    dy = int(np.clip(chin_shape - chin_art, -limit, limit))
    canvas = np.roll(canvas, dy, axis=0)
    rep["registration"] = dict(chinShape=chin_shape, chinArt=chin_art, chinInk=run, dyPx=dy, limitPx=limit, skinRef=skin_ref.round().tolist())
    # cut the head from the body: every row above CUT_ROW; below it only inside the head shape grown by CHIN_GROW px
    # and, in the columns under the face's skin, no lower than the chin outline (the face's lowest skin px + the
    # measured chin ink + 2 px of antialiased edge): the art's own neck and jaw shadow under the chin go
    keep = nd.binary_dilation(shape, iterations=CHIN_GROW)
    facem = np.roll(lab == face, dy, axis=0)
    for x in np.nonzero(facem.any(0))[0]:
        keep[int(np.nonzero(facem[:, x])[0].max()) + run + 3:, x] = False
    keep[:CUT_ROW] = True
    canvas[~keep] = 0
    # drop specks not connected to the head
    lab, n = nd.label(canvas[..., 3] > 0)
    if n > 1:
        sizes = nd.sum(np.ones_like(lab), lab, range(1, n + 1))
        canvas[~np.isin(lab, 1 + np.nonzero(sizes >= 0.01 * sizes.max())[0])] = 0
    # narrow notches (gaps between hair locks under ~NOTCH px wide) closed with the art's ink: a rotated head renders
    # them as translucent hairlines inside the silhouette (validator tears)
    al = canvas[..., 3] > 128
    yy, xx = np.mgrid[-NOTCH:NOTCH + 1, -NOTCH:NOTCH + 1]
    closed = nd.binary_closing(np.pad(al, NOTCH + 1), structure=(xx ** 2 + yy ** 2) <= NOTCH ** 2)[NOTCH + 1:-NOTCH - 1, NOTCH + 1:-NOTCH - 1]
    # and every see-through px inside the closed silhouette (1 px in from its edge) made solid: the background-grey
    # specks the alpha key left inside the hair would show as hairlines once their neighbours are solid
    solid = nd.binary_erosion(nd.binary_fill_holes(closed), iterations=1)
    fill = solid & ~al
    soft = solid & al & (canvas[..., 3] < 255)
    inkc = np.median(canvas[..., :3][al & (lum(canvas[..., :3]) < 40)], 0)
    canvas[fill, :3] = inkc.astype(np.uint8)
    canvas[solid, 3] = 255
    rep["solidSoftPx"] = int(soft.sum())
    rep["notchFillPx"] = int(fill.sum())
    pal = front_palette(look, k=8)
    canvas, rep["paletteOffsets"] = remap(canvas, pal)

    def ink_per_contour(a):
        al = a[..., 3] > 128
        band = al & (lum(a[..., :3]) < 70) & (nd.distance_transform_edt(al) < 20)
        per = (al & ~nd.binary_erosion(al)).sum()
        return float(band.sum() / max(per, 1))

    f_ink, s_ink = ink_per_contour(look), ink_per_contour(canvas)
    rep["outline"] = dict(live=round(f_ink, 2), before=round(s_ink, 2), ratioBefore=round(s_ink / f_ink, 3))
    passes = 0
    while s_ink / f_ink < 0.9 and passes < 2:
        al = canvas[..., 3] > 128
        inkc = np.median(canvas[..., :3][al & (lum(canvas[..., :3]) < 40)], 0)
        d = nd.distance_transform_edt(~al)
        ring = (d > 0) & (d < 2)
        na = np.clip(2.0 - d, 0, 1) * 255
        canvas[ring, :3] = inkc.astype(np.uint8)
        canvas[ring, 3] = np.maximum(canvas[ring, 3], na[ring]).astype(np.uint8)
        passes += 1
        s_ink = ink_per_contour(canvas)
    rep["outline"].update(reinkPasses=passes, after=round(s_ink, 2), ratio=round(s_ink / f_ink, 3), ok=bool(s_ink / f_ink >= 0.9))
    ys, xs = np.nonzero(canvas[..., 3] > 0)
    rep["box"] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    Image.fromarray(canvas).save(out / "head.turned.png")
    save_json(out / "polish.json", rep)
    print(json.dumps(rep))


if __name__ == "__main__":
    {"guide": guide, "polish": polish}[sys.argv[1]](*sys.argv[2:])
