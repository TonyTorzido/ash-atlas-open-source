# Atlas Animator multi-view swag, step 3 (docs/plans/atlas-animator-views.md): the per-view structure map.
#   python structure_map.py <design.json> <view> <template dir> <out dir> [<side landmarks.json>]
#   (side: <template dir> holds torso/, near/, far/, one swag:template output per piece domain)
# <template dir> = the swag:template output for that view's body (body.png + allowed-mask.png: the importer's own
# allowed area, so the guide, the polish and the gates share one silhouette). Writes, at the polish crop scale
# (canvas crop 576x384 at x8/3 = 1536x1024, the scale the front was drawn at; never upscaled art):
#   structure-<view>.svg   the construction as vectors (crop coordinates): allowed area, band inner edges, placket
#                          line, frog crosses, hatched "none" zones (features the presence table forbids on this view)
#   guide-<view>.png       the edit target: faint body, the allowed area flat light grey with a dark border
#                          (the border becomes the bold outline, as in every approved front), thin cyan construction
#                          lines and hatched none zones
#   front-on-body.png      the approved front on the faint body at the same crop and scale (the design to match)
#   palette.png, motif.png the palette swatch (roles) and a brocade tile crop from the front
# Every number comes from the design spec, the domain's allowed mask and the front's band geometry: no hand drawing.
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as nd

sys.path.insert(0, str(Path(__file__).parent))
from common import CROP, GEN, DROPS, bands, load, masks  # noqa: E402

K = GEN[0] / (CROP[2] - CROP[0])  # 8/3
CYAN = (0, 170, 220)
HATCH = (200, 60, 160)


def to_crop(x, y):
    return ((x - CROP[0]) * K, (y - CROP[1]) * K)


def resolve(p):
    return Path(str(p).replace("ART_DROPS", str(DROPS)))


def edge_rows(mask, cols, which):
    """Per column: the mask's top or bottom row."""
    out = []
    for x in cols:
        ys = np.nonzero(mask[:, x])[0]
        if len(ys):
            out.append((x, int(ys.min() if which == "top" else ys.max())))
    return out


def construction(spec, view, allowed):
    """Construction primitives (canvas px): polylines (band inner edges, placket), crosses (frogs), hatch rects."""
    front = load(resolve(spec["front"]))
    fb = bands(front)
    pres = spec["presence"][view]
    bw = spec["bands"]
    lines, crosses, hatches = [], [], []
    mid = fb["mid"]
    # hem: the allowed area's bottom edge raised by the hem band width, across the torso
    hx = range(int(min(c["x0"] for c in fb["hem"])), int(max(c["x1"] for c in fb["hem"])) + 1)
    ink = spec["outlineWidth"]  # the band starts inside the bold outline
    lines.append(("hem band", [(x, y - ink - bw["hem"]) for x, y in edge_rows(allowed, hx, "bottom")]))
    # cuffs: the front cuff band's inner (sleeve-side) edge; the back silhouette is the front's, so it carries over
    for c in fb["cuff"]:
        comp = np.zeros_like(allowed)
        tr = nd.binary_closing(masks(front)["trim"], iterations=1)
        comp[c["y0"]:c["y1"] + 1, c["x0"]:c["x1"] + 1] = tr[c["y0"]:c["y1"] + 1, c["x0"]:c["x1"] + 1]
        lines.append(("cuff band", edge_rows(comp, range(c["x0"], c["x1"] + 1), "top")))
    # collar: the stand collar is seen from outside on every view; its band runs along the neckline top edge
    cx0, cx1 = min(c["x0"] for c in fb["collar"]), max(c["x1"] for c in fb["collar"])
    lines.append(("collar band", [(x, y + ink + bw["collar"]) for x, y in edge_rows(allowed, range(cx0, cx1 + 1), "top")]))
    pl = fb["placket"]
    if pres.get("placket") and pl:
        lines.append(("placket", [(pl["x0"], fb["collarBottom"]), (pl["x0"], fb["hemTop"])]))
        lines.append(("placket", [(pl["x1"], fb["collarBottom"]), (pl["x1"], fb["hemTop"])]))
    elif pl:
        hatches.append(("no placket", (pl["x0"] - 4, fb["collarBottom"] + 6, pl["x1"] + 4, fb["hemTop"] - 6)))
    if pres.get("frogs"):
        crosses += [tuple(f) for f in fb["frogs"]]
    else:
        for fx, fy in fb["frogs"]:
            hatches.append(("no frog", (fx - 40, fy - 10, fx + 40, fy + 10)))
    return lines, crosses, hatches


def write_svg(path, allowed, lines, crosses, hatches):
    from skimage import measure
    cs = measure.find_contours(np.pad(allowed, 1).astype(float), 0.5)
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {GEN[0]} {GEN[1]}" width="{GEN[0]}" height="{GEN[1]}">',
             '<defs><pattern id="none" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
             f'<line x1="0" y1="0" x2="0" y2="14" stroke="rgb{HATCH}" stroke-width="3"/></pattern></defs>']
    for c in cs:
        if len(c) < 50:
            continue
        pts = " ".join("%.1f,%.1f" % to_crop(p[1] - 1, p[0] - 1) for p in c[::3])
        parts.append(f'<polygon id="allowed" points="{pts}" fill="rgb(205,205,210)" stroke="rgb(60,60,66)" stroke-width="24"/>')
    for name, pl in lines:
        pts = " ".join("%.1f,%.1f" % to_crop(x, y) for x, y in pl[::2])
        parts.append(f'<polyline class="{name}" points="{pts}" fill="none" stroke="rgb{CYAN}" stroke-width="3"/>')
    for x, y in crosses:
        X, Y = to_crop(x, y)
        parts.append(f'<path class="frog" d="M{X-18:.1f},{Y:.1f}H{X+18:.1f}M{X:.1f},{Y-18:.1f}V{Y+18:.1f}" stroke="rgb{CYAN}" stroke-width="3"/>')
    for name, (x0, y0, x1, y1) in hatches:
        X0, Y0 = to_crop(x0, y0)
        X1, Y1 = to_crop(x1, y1)
        parts.append(f'<rect class="{name}" x="{X0:.1f}" y="{Y0:.1f}" width="{X1-X0:.1f}" height="{Y1-Y0:.1f}" fill="url(#none)" fill-opacity="0.35"/>')
    parts.append("</svg>")
    Path(path).write_text("\n".join(parts) + "\n", encoding="utf-8")


def crop_up(img):
    return img.crop(CROP).resize(GEN, Image.LANCZOS)


def guide_png(body, allowed, lines, crosses, hatches):
    """Same construction as the SVG, rasterised directly at the crop scale (lines are drawn at 1536x1024, not
    upscaled). The base is the established edit target of every approved front (setup.py): faint body, the
    allowed area flat light grey inside a 10 canvas px dark border."""
    white = Image.new("RGBA", body.size, (255, 255, 255, 255))
    t = np.array(Image.alpha_composite(white, body).convert("RGB")).astype(float)
    t = 255 - (255 - t) * 0.25
    t[allowed] = (60, 60, 66)
    t[nd.binary_erosion(allowed, iterations=10)] = (205, 205, 210)
    g = crop_up(Image.fromarray(t.astype(np.uint8))).convert("RGBA")
    over = Image.new("RGBA", GEN, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    inner = crop_up(Image.fromarray((nd.binary_erosion(allowed, iterations=10) * 255).astype(np.uint8))).point(lambda v: 255 if v > 127 else 0)
    for name, (x0, y0, x1, y1) in hatches:
        X0, Y0 = to_crop(x0, y0)
        X1, Y1 = to_crop(x1, y1)
        hl = Image.new("RGBA", GEN, (0, 0, 0, 0))
        hd = ImageDraw.Draw(hl)
        for s in range(int(X0 - (Y1 - Y0)), int(X1), 14):
            hd.line([(s, Y1), (s + (Y1 - Y0), Y0)], fill=HATCH + (110,), width=2)
        clip = Image.new("L", GEN, 0)
        ImageDraw.Draw(clip).rectangle((X0, Y0, X1, Y1), fill=255)
        hl.putalpha(Image.fromarray(np.minimum(np.array(hl)[..., 3], np.array(clip))))
        over.alpha_composite(hl)
    for name, pl in lines:
        d.line([to_crop(x, y) for x, y in pl], fill=CYAN + (255,), width=3)
    for x, y in crosses:
        X, Y = to_crop(x, y)
        d.line([(X - 18, Y), (X + 18, Y)], fill=CYAN + (255,), width=3)
        d.line([(X, Y - 18), (X, Y + 18)], fill=CYAN + (255,), width=3)
    # construction marks only inside the light allowed area (never on the outline border)
    over.putalpha(Image.fromarray(np.minimum(np.array(over)[..., 3], np.array(inner))))
    return Image.alpha_composite(g, over).convert("RGB")


def palette_png(spec):
    pal = spec["palette"]
    im = Image.new("RGB", (160 * len(pal), 200), (255, 255, 255))
    d = ImageDraw.Draw(im)
    for i, p in enumerate(pal):
        d.rectangle((i * 160 + 6, 6, i * 160 + 154, 150), fill=tuple(p["rgb"]))
        d.text((i * 160 + 8, 160), p["role"], fill=(0, 0, 0))
        d.text((i * 160 + 8, 178), "#%02x%02x%02x" % tuple(p["rgb"]), fill=(0, 0, 0))
    return im


def motif_png(spec):
    """A brocade tile from the front's left torso panel (between the side seam and the placket, collar to hem):
    fabric, sheen and roundels only, no placket or frogs, at the crop scale."""
    front = Image.open(resolve(spec["front"])).convert("RGBA")
    lm = spec["landmarks"]["front"]
    px = lm["placketX"] or (spec["canvas"][0] / 2)
    box = (int(px - 125), int(lm["collarBottom"] + 12), int(px - 46), int(lm["hemTop"] - 4))  # right edge clears the frog loops
    bg = Image.new("RGBA", front.size, (255, 255, 255, 255))
    bg.alpha_composite(front)
    t = bg.crop(box)
    return t.resize((round(t.width * K), round(t.height * K)), Image.LANCZOS).convert("RGB")


# --- turned side (phase 2c): three separable pieces, one allowed mask each (swag:template on each piece's domain,
# fixtures/garments/views/<item>-{torso,near,far}.domain.json from scripts/views/side-domain.ts), no axis reflection.
# The guide draws them in the body's draw order (far sleeve, torso, near sleeve over it), each with its own dark
# border, so the overlaps read as the bold outline of the piece in front.
PLACKET_FRAC = 0.11  # centre front of a ~60 deg turned torso: (sqrt(a^2/4 + 0.75 b^2) - 0.866 b) / (2 sqrt(...)), a = 1.4 b


def side_masks(tdir):
    return {k: np.array(Image.open(Path(tdir) / k / "allowed-mask.png").convert("L")) > 127 for k in ("far", "torso", "near")}


def construction_side(spec, ms, lm):
    """Side construction (canvas px) from the side pieces' masks and the side domain's landmarks."""
    front = load(resolve(spec["front"]))
    fb = bands(front)
    pres = spec["presence"]["side"]
    bw = spec["bands"]
    ink = spec["outlineWidth"]
    torso = ms["torso"]
    lines, crosses, hatches = [], [], []
    hem = np.array(lm["cuts"]["torso:hem"])
    hx = range(int(hem[:, 0].min()), int(hem[:, 0].max()) + 1)
    lines.append(("hem band", [(x, y - ink - bw["hem"]) for x, y in edge_rows(torso, hx, "bottom")]))
    neck = np.array(lm["cuts"]["torso:neckline"])
    nx = range(int(neck[:, 0].min()) + 2, int(neck[:, 0].max()) - 1)
    lines.append(("collar band", [(x, y + ink + bw["collar"]) for x, y in edge_rows(torso, nx, "top")]))
    for key in ("near", "far"):
        cut = np.array(lm["cuts"][f"{key}:cuff"])
        e = np.array(lm["elbowward"][key])
        off = e * (ink + bw["cuff"])
        lines.append(("cuff band", [(float(x + off[0]), float(y + off[1])) for x, y in cut]))
    # the visible front opening: the placket's centre at PLACKET_FRAC of the torso's width from its front (screen-left) edge
    y0, y1 = int(fb["collarBottom"]), int(fb["hemTop"])
    cen = []
    for y in range(y0, y1 + 1):
        xs = np.nonzero(torso[y])[0]
        if len(xs):
            cen.append((xs.min() + PLACKET_FRAC * (xs.max() - xs.min()), y))
    pw = bw["placket"] / 2
    if pres.get("placket"):
        lines.append(("placket", [(x - pw, y) for x, y in cen]))
        lines.append(("placket", [(x + pw, y) for x, y in cen]))
    cmap = {y: x for x, y in cen}
    if pres.get("frogs"):
        for fx, fy in fb["frogs"][: pres["frogs"]]:
            yy = int(round(fy))
            if yy in cmap:
                crosses.append((cmap[yy], fy))
    # each construction line stays on the visible part of its own piece (a far cuff line never crosses the torso)
    vis = {"far": nd.binary_erosion(ms["far"] & ~ms["torso"] & ~ms["near"], iterations=10),
           "torso": nd.binary_erosion(ms["torso"] & ~ms["near"], iterations=10), "near": nd.binary_erosion(ms["near"], iterations=10)}
    owner = ["torso", "torso", "near", "far", "torso", "torso"]
    clipped = []
    for (name, pl), k in zip(lines, owner):
        run = []
        for x, y in pl:
            xi, yi = int(round(x)), int(round(y))
            if 0 <= yi < vis[k].shape[0] and 0 <= xi < vis[k].shape[1] and vis[k][yi, xi]:
                run.append((x, y))
            elif len(run) > 1:
                clipped.append((name, run))
                run = []
            else:
                run = []
        if len(run) > 1:
            clipped.append((name, run))
    return clipped, crosses, hatches


def guide_png_side(body, ms, lines, crosses, hatches):
    white = Image.new("RGBA", body.size, (255, 255, 255, 255))
    t = np.array(Image.alpha_composite(white, body).convert("RGB")).astype(float)
    t = 255 - (255 - t) * 0.25
    inner_all = np.zeros(ms["torso"].shape, bool)
    for k in ("far", "torso", "near"):
        m = ms[k]
        inner = nd.binary_erosion(m, iterations=10)
        t[m] = (60, 60, 66)
        t[inner] = (205, 205, 210)
        inner_all &= ~m
        inner_all |= inner
    allowed = ms["far"] | ms["torso"] | ms["near"]
    g = crop_up(Image.fromarray(t.astype(np.uint8))).convert("RGBA")
    over = Image.new("RGBA", GEN, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    for name, pl in lines:
        d.line([to_crop(x, y) for x, y in pl], fill=CYAN + (255,), width=3)
    for x, y in crosses:
        X, Y = to_crop(x, y)
        d.line([(X - 18, Y), (X + 18, Y)], fill=CYAN + (255,), width=3)
        d.line([(X, Y - 18), (X, Y + 18)], fill=CYAN + (255,), width=3)
    inner = crop_up(Image.fromarray((inner_all * 255).astype(np.uint8))).point(lambda v: 255 if v > 127 else 0)
    over.putalpha(Image.fromarray(np.minimum(np.array(over)[..., 3], np.array(inner))))
    return Image.alpha_composite(g, over).convert("RGB"), allowed


def main_side(spec, tdir, out, landmarks):
    ms = side_masks(tdir)
    lm = json.loads(Path(landmarks).read_text(encoding="utf-8"))
    body = Image.open(Path(tdir) / "torso" / "body.png").convert("RGBA")
    lines, crosses, hatches = construction_side(spec, ms, lm)
    img, allowed = guide_png_side(body, ms, lines, crosses, hatches)
    img.save(out / "guide-side.png")
    write_svg(out / "structure-side.svg", allowed, lines, crosses, hatches)
    for k, m in ms.items():
        Image.fromarray((m * 255).astype(np.uint8)).save(out / f"allowed-side-{k}.png")
    white = Image.new("RGBA", body.size, (255, 255, 255, 255))
    t = 255 - (255 - np.array(Image.alpha_composite(white, body).convert("RGB")).astype(float)) * 0.25
    crop_up(Image.fromarray(t.astype(np.uint8)).convert("RGB")).save(out / "body-side.png")
    print("structure map side lines", [n for n, _ in lines], "frogs", len(crosses))


def main(spec_path, view, tdir, out, landmarks=None):
    spec = json.loads(Path(spec_path).read_text(encoding="utf-8"))
    tdir, out = Path(tdir), Path(out)
    out.mkdir(parents=True, exist_ok=True)
    if view == "side":
        return main_side(spec, tdir, out, landmarks)
    allowed = np.array(Image.open(tdir / "allowed-mask.png").convert("L")) > 127
    body = Image.open(tdir / "body.png").convert("RGBA")
    lines, crosses, hatches = construction(spec, view, allowed)
    write_svg(out / f"structure-{view}.svg", allowed, lines, crosses, hatches)
    guide_png(body, allowed, lines, crosses, hatches).save(out / f"guide-{view}.png")
    white = Image.new("RGBA", body.size, (255, 255, 255, 255))
    t = 255 - (255 - np.array(Image.alpha_composite(white, body).convert("RGB")).astype(float)) * 0.25
    faint = Image.fromarray(t.astype(np.uint8)).convert("RGBA")
    crop_up(Image.alpha_composite(faint, Image.open(resolve(spec["front"])).convert("RGBA")).convert("RGB")).save(out / "front-on-body.png")
    crop_up(faint.convert("RGB")).save(out / f"body-{view}.png")
    palette_png(spec).save(out / "palette.png")
    motif_png(spec).save(out / "motif.png")
    print("structure map", view, "lines", [n for n, _ in lines], "frogs", len(crosses), "none zones", [n for n, _ in hatches])


if __name__ == "__main__":
    main(*sys.argv[1:6])
