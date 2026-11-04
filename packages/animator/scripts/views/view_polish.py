# Atlas Animator multi-view swag, step 4 (docs/plans/atlas-animator-views.md): view polish additions + consistency gates.
#   python view_polish.py polish <gen.png> <allowed-mask.png> <design.json> <view> <out garment.png>
#   python view_polish.py gates <garment.png> <design.json> <view> [<report.json>]
#   python view_polish.py selftest <design.json> [<report.json>]
# polish = the repo polish.py (registration, waist fit, mask fill, outline repaint; kf-B's skin-only warm rule) on the
# view's allowed mask, then the deterministic repairs, in order, before any redraw:
#   1. length snap (generalised scripts/kungfu-longcuff.ts): a band zone that sits off its landmark moves by a
#      whole-pixel vector, the opened rows repeat the fabric row above the zone; capped at 25 px; a band is never
#      stretched to reach its landmark;
#   2. palette remap to the front palette in Lab on the non-ink pixels (per-role ramp shift, common.palette_remap).
# gates = the new consistency gates against the front (thresholds derived from the front, see design.json):
#   paletteRoles (role medians within the calibrated dE00), bandWidths (+-2 px), landmarks (hem and cuff rows +-3 px),
#   motifDensity (within 30%), motifIrregular (NN-distance CV >= 0.7x the front's: kills the grid look),
#   outlineWidth (along the contour, >= 0.9x the front's), presence (placket and frog count per view).
# selftest = the approved front passes every gate as itself, and each gate has a damaged control that must fail
# (and the length snap must repair its damaged control).
import importlib.util
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage as nd

sys.path.insert(0, str(Path(__file__).parent))
from common import DROPS, bands, de00, de76, load, masks, motifs, outline_width, palette_remap, role_medians, save_json  # noqa: E402

SNAP_MAX = 25
BAND_TOL, ROW_TOL = 2.0, 3.0
MOTIF_DENSITY_TOL, MOTIF_CV_MIN, OUTLINE_MIN = 0.30, 0.70, 0.90
GRID_ALIGN_MARGIN = 0.20  # gridAlign may exceed the front's by at most this share of roundels


def resolve(p):
    return Path(str(p).replace("ART_DROPS", str(DROPS)))


def load_spec(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))


# ---------------------------------------------------------------- repairs
def snap_zone(a, zone, v):
    """Moves the pixels of `zone` (bool, the band zone: fabric rows next to the band, the band, its ink) by the
    whole-pixel vector v = (dx, dy); the rows the zone leaves repeat the fabric row just outside the zone, opposite
    to v (the fabric continues along the move). Alpha is unchanged (the silhouette is the template's)."""
    dx, dy = int(v[0]), int(v[1])
    out = a.copy()
    src = a.copy()
    ys, xs = np.nonzero(zone)
    ty, tx = ys + dy, xs + dx
    ok = (ty >= 0) & (ty < a.shape[0]) & (tx >= 0) & (tx < a.shape[1])
    moved = np.zeros(zone.shape, bool)
    moved[ty[ok], tx[ok]] = True
    # opened pixels: in the zone but not covered by the moved zone -> fabric continued from outside the zone
    opened = zone & ~moved & (a[..., 3] > 0)
    step = (-int(np.sign(dx)), -int(np.sign(dy)))
    for y, x in zip(*np.nonzero(opened)):
        yy, xx = y, x
        while 0 <= yy < a.shape[0] and 0 <= xx < a.shape[1] and zone[yy, xx]:
            yy, xx = yy + step[1], xx + step[0]
        if 0 <= yy < a.shape[0] and 0 <= xx < a.shape[1]:
            out[y, x, :3] = src[yy, xx, :3]
    keep = a[..., 3] > 0
    tgt = moved & keep
    out[ty[ok][tgt[ty[ok], tx[ok]]], tx[ok][tgt[ty[ok], tx[ok]]], :3] = src[ys[ok][tgt[ty[ok], tx[ok]]], xs[ok][tgt[ty[ok], tx[ok]]], :3]
    return out


def length_snap(a, spec, view):
    """Hem: the band's top row vs the landmark (the band keeps its own painted width; the zone is the hem band plus
    the fabric rows above it down to the outline). Cuffs: the band top row vs the landmark, moved along the vertical
    (the cuff landmark row; the back silhouette is the front's). Offsets <= 3 px are left alone, > SNAP_MAX refused."""
    lm = spec["landmarks"][view]
    m = masks(a)
    b = bands(a, m)
    log = []
    if b["hem"] and lm.get("hemTop") is not None:
        top = min(c["y0"] for c in b["hem"])
        d = lm["hemTop"] - top
        if 3 < abs(d) <= SNAP_MAX:
            x0, x1 = min(c["x0"] for c in b["hem"]) - 10, max(c["x1"] for c in b["hem"]) + 10
            zone = np.zeros(m["A"].shape, bool)
            zone[top - 6:, x0:x1 + 1] = True
            zone &= m["A"]
            a = snap_zone(a, zone, (0, d))
            log.append(dict(band="hem", v=[0, int(d)]))
        elif abs(d) > SNAP_MAX:
            log.append(dict(band="hem", refused=int(d)))
    for c in b["cuff"]:
        side = "l" if c["cx"] < b["mid"] else "r"
        t = (lm.get("cuff") or {}).get(side)
        if not t:
            continue
        d = t["top"] - c["y0"]
        if 3 < abs(d) <= SNAP_MAX:
            zone = np.zeros(m["A"].shape, bool)
            zone[c["y0"] - 6:, c["x0"] - 12:c["x1"] + 13] = True
            zone &= m["A"]
            a = snap_zone(a, zone, (0, d))
            log.append(dict(band="cuff_" + side, v=[0, int(d)]))
        elif abs(d) > SNAP_MAX:
            log.append(dict(band="cuff_" + side, refused=int(d)))
    return a, log


WIDTH_SNAP_MAX = 6


def width_snap(a, spec, view):
    """Band-width snap for a band painted a few px narrower than the front's (2 < deficit <= WIDTH_SNAP_MAX): the
    band's INNER edge (its inner ink line and the inner half of the band) moves by a whole-pixel vertical vector
    toward the fabric side (snap_zone), and the opened rows repeat the band's middle row. The outer edge (on the
    template outline) and the band's own shading and stitches stay; the fabric gives up d rows. Cuffs grow upward
    (into the sleeve), the collar downward (into the back panel). A wider band is left to the gate."""
    pres = spec["presence"][view]
    bw = spec["bands"]
    m = masks(a)
    b = bands(a, m)
    trim = nd.binary_closing(m["trim"], iterations=1)
    log = []
    todo = []
    if pres.get("cuffs"):
        todo += [("cuff", c, -1) for c in b["cuff"]]
    if pres.get("collar"):
        todo += [("collar", c, +1) for c in b["collar"]]
    for kind, c, sgn in todo:
        deficit = bw[kind] - c["width"]
        if not (BAND_TOL < deficit <= WIDTH_SNAP_MAX):
            continue
        d = int(np.ceil(deficit * (1.15 if kind == "cuff" else 1.0)))  # slanted cuffs: vertical move > normal width
        zone = np.zeros(m["A"].shape, bool)
        for x in range(c["x0"], c["x1"] + 1):
            ys = np.nonzero(trim[c["y0"]:c["y1"] + 1, x])[0]
            if len(ys) < 4:
                continue
            t, btm = c["y0"] + ys.min(), c["y0"] + ys.max()
            midr = (t + btm) // 2
            if sgn < 0:
                zone[t - 9:midr + 1, x] = True
            else:
                zone[midr:btm + 10, x] = True
        zone &= m["A"] & (m["dt"] > 9)
        a = snap_zone(a, zone, (0, sgn * d))
        log.append(dict(band=kind, x=[c["x0"], c["x1"]], deficit=round(deficit, 1), v=[0, sgn * d]))
    return a, log


def palette_fix(a, spec):
    out, offs = palette_remap(a, spec["palette"])
    return out, offs


def run_polish(gen, mask_path, spec_path, view, out):
    P = Path(__file__).resolve().parents[1] / "swag/polish.py"
    sp = importlib.util.spec_from_file_location("polish", P)
    pm = importlib.util.module_from_spec(sp)
    sp.loader.exec_module(pm)

    def warm_highlights(rgb, alpha):  # kf-B's rule (swag-kungfu-02/tools/polish_kf.py): only skin-like warm pixels
        f = rgb.astype(float)
        sel = alpha & (f[..., 0] > 170) & (f[..., 0] - f[..., 2] > 60) & (f[..., 0] - f[..., 1] > 20)
        rgb[sel] = np.round(f[sel] * (170.0 / f[sel][:, :1])).astype(np.uint8)
        return int(sel.sum())
    pm.warm_highlights = warm_highlights
    pm.MASKS[view] = Path(mask_path)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    raw = out.with_name(out.stem + ".polish.png")
    r = pm.polish(Path(gen), view, raw)
    spec = load_spec(spec_path)
    a = load(raw)
    pre = gates(a, spec, view)  # the polished draw before the repairs
    a, snaps = length_snap(a, spec, view)
    a, wsnaps = width_snap(a, spec, view)
    a, offs = palette_fix(a, spec)
    Image.fromarray(a).save(out)
    rep = dict(polish=dict(zip(["iou", "scale", "dx", "dy", "ink", "filled", "fit", "skinLike"], [x if isinstance(x, (int, float, str)) else str(x) for x in r])),
               preRepairGates=dict(failed=pre["failed"], details=pre["details"]), lengthSnap=snaps, widthSnap=wsnaps, paletteOffsets=offs)
    return rep


# ---------------------------------------------------------------- gates
def gates(a, spec, view, front=None):
    front = front if front is not None else load(resolve(spec["front"]))
    pres = spec["presence"][view]
    lm = spec["landmarks"][view]
    m = masks(a)
    b = bands(a, m)
    res, ok = {}, {}
    # palette roles vs the front's role medians (same role assignment on both)
    thr = spec["paletteGate"]["thresholdDE00"]
    fm, vm = role_medians(front, spec["palette"]), role_medians(a, spec["palette"], m)
    rows = {}
    for k in fm:
        if k == "ink" or not fm[k]["lab"] or not vm[k]["lab"] or fm[k]["n"] < 500 or vm[k]["n"] < 500:
            continue
        rows[k] = dict(de00=round(de00(fm[k]["lab"], vm[k]["lab"]), 2), de76=round(de76(fm[k]["lab"], vm[k]["lab"]), 2), n=vm[k]["n"])
    res["paletteRoles"] = dict(threshold=thr, roles=rows)
    ok["paletteRoles"] = bool(rows) and all(r["de00"] <= thr for r in rows.values())
    # band widths
    bw = spec["bands"]
    meas = dict(collar=max([c["width"] for c in b["collar"]], default=None), cuff=[c["width"] for c in b["cuff"]],
                hem=max([c["width"] for c in b["hem"]], default=None))
    devs = {}
    if pres.get("collar"):
        devs["collar"] = None if meas["collar"] is None else round(meas["collar"] - bw["collar"], 1)
    if pres.get("hem"):
        devs["hem"] = None if meas["hem"] is None else round(meas["hem"] - bw["hem"], 1)
    if pres.get("cuffs"):
        devs["cuff"] = None if len(meas["cuff"]) != 2 else round(max(abs(w - bw["cuff"]) for w in meas["cuff"]), 1)
    if pres.get("placket"):
        devs["placket"] = None if not b["placket"] else round(b["placket"]["width"] - bw["placket"], 1)
    res["bandWidths"] = dict(target=bw, measured=meas, deviation=devs, tol=BAND_TOL)
    ok["bandWidths"] = all(v is not None and abs(v) <= BAND_TOL for v in devs.values())
    # landmark rows
    lr = {}
    if pres.get("hem") and b["hem"]:
        lr["hemTop"] = min(c["y0"] for c in b["hem"]) - lm["hemTop"]
        lr["hemBottom"] = max(c["y1"] for c in b["hem"]) - lm["hemBottom"]
    for c in b["cuff"]:
        s = "l" if c["cx"] < b["mid"] else "r"
        if lm["cuff"].get(s):
            lr[f"cuff_{s}_top"] = c["y0"] - lm["cuff"][s]["top"]
            lr[f"cuff_{s}_bottom"] = c["y1"] - lm["cuff"][s]["bottom"]
    res["landmarks"] = dict(deviation=lr, tol=ROW_TOL)
    ok["landmarks"] = bool(lr) and len([k for k in lr if k.startswith("cuff")]) == 4 and all(abs(v) <= ROW_TOL for v in lr.values())
    # motif
    mo = motifs(a, m)
    f0 = spec["motif"]
    ratio = mo["densityPer10k"] / f0["densityPer10k"] if f0["densityPer10k"] else 0
    res["motif"] = dict(count=mo["count"], densityPer10k=round(mo["densityPer10k"], 3), frontDensity=f0["densityPer10k"], ratio=round(ratio, 3),
                        nnCV=None if mo["nnCV"] is None else round(mo["nnCV"], 3), frontNnCV=f0["nnCV"],
                        gridAlign=None if mo["gridAlign"] is None else round(mo["gridAlign"], 3), frontGridAlign=f0["gridAlign"])
    if pres.get("brocade"):
        ok["motifDensity"] = abs(ratio - 1) <= MOTIF_DENSITY_TOL
        ok["motifIrregular"] = (mo["nnCV"] is not None and mo["nnCV"] >= MOTIF_CV_MIN * f0["nnCV"]
                                and mo["gridAlign"] is not None and mo["gridAlign"] <= f0["gridAlign"] + GRID_ALIGN_MARGIN)
    # outline width along the contour
    ow = outline_width(a, m)
    res["outlineWidth"] = dict(measured=round(ow, 2), front=spec["outlineWidth"], ratio=round(ow / spec["outlineWidth"], 3))
    ok["outlineWidth"] = ow >= OUTLINE_MIN * spec["outlineWidth"]
    # presence table
    has_pl = b["placket"] is not None
    res["presence"] = dict(placket=has_pl, frogs=len(b["frogs"]), expected=dict(placket=bool(pres.get("placket")), frogs=int(pres.get("frogs", 0))))
    ok["presence"] = has_pl == bool(pres.get("placket")) and len(b["frogs"]) == int(pres.get("frogs", 0))
    return dict(view=view, gates=ok, passed=all(ok.values()), failed=[k for k, v in ok.items() if not v], details=res)


# ---------------------------------------------------------------- damaged controls
def _hem_zone(a, b):
    x0, x1 = min(c["x0"] for c in b["hem"]) - 10, max(c["x1"] for c in b["hem"]) + 10
    top = min(c["y0"] for c in b["hem"])
    z = np.zeros(a.shape[:2], bool)
    z[top - 6:, x0:x1 + 1] = True
    return z & (a[..., 3] > 0)


def selftest(spec):
    front = load(resolve(spec["front"]))
    m = masks(front)
    b = bands(front, m)
    fabric_rgb = np.median(front[m["fabric"] & (m["dt"] > 14)][:, :3], 0).astype(np.uint8)
    out = {}

    def run(name, art, view, expect_fail):
        g = gates(art, spec, view, front)
        out[name] = dict(view=view, expectFail=expect_fail, failed=g["failed"], ok=(expect_fail in g["failed"]) if expect_fail else g["passed"])
        return g

    run("front_as_front", front, "front", None)
    # palette: the first test's warm side drift
    warm = front.copy()
    warm[..., :3] = np.clip(front[..., :3].astype(int) + np.array([5, -6, -12]), 0, 255).astype(np.uint8)
    run("palette_warm_drift", warm, "front", "paletteRoles")
    # palette repair: the remap brings it back
    fixed, _ = palette_remap(warm, spec["palette"])
    g = gates(fixed, spec, "front", front)
    out["palette_warm_drift_remapped"] = dict(view="front", expectFail=None, failed=g["failed"], ok="paletteRoles" not in g["failed"])
    # band width: the hem band's top 6 rows painted as fabric
    thin = front.copy()
    top = min(c["y0"] for c in b["hem"])
    tz = np.zeros(m["A"].shape, bool)
    tz[top:top + 6, :] = True
    tz &= m["trim"] | (m["L"] > 90)
    tz[:, int(b["placket"]["x0"]) - 2:int(b["placket"]["x1"]) + 3] = False
    thin[tz, :3] = fabric_rgb
    run("hem_band_thin", thin, "front", "bandWidths")
    # landmark: the hem band zone moved 10 px up (a high hem, as the first test's turned side)
    high = snap_zone(front, _hem_zone(front, b), (0, -10))
    run("hem_high_10px", high, "front", "landmarks")
    snapped, log = length_snap(high, spec, "front")
    g = gates(snapped, spec, "front", front)
    out["hem_high_10px_snapped"] = dict(view="front", expectFail=None, failed=g["failed"], snap=log, ok="landmarks" not in g["failed"] and "bandWidths" not in g["failed"])
    # band width repair: the left cuff band's inner 4 rows painted as sleeve fabric -> width snap restores it
    narrow = front.copy()
    c = [c for c in b["cuff"] if c["cx"] < b["mid"]][0]
    tr = nd.binary_closing(m["trim"], iterations=1)
    for x in range(c["x0"], c["x1"] + 1):
        ys = np.nonzero(tr[c["y0"]:c["y1"] + 1, x])[0]
        if len(ys) >= 8:
            narrow[c["y0"] + ys.min():c["y0"] + ys.min() + 4, x, :3] = fabric_rgb
    g0 = gates(narrow, spec, "front", front)
    fixed, wl = width_snap(narrow, spec, "front")
    g = gates(fixed, spec, "front", front)
    out["cuff_narrow_width_snapped"] = dict(view="front", expectFail=None, before=g0["failed"], failed=g["failed"], snap=wl,
                                            ok="bandWidths" in g0["failed"] and "bandWidths" not in g["failed"])
    # motif: brocade removed (fabric smoothed by a median filter where roundels are)
    plain = front.copy()
    sel = m["fabric"] & (m["dt"] > 8)
    for ch in range(3):
        src = np.where(m["fabric"], front[..., ch], fabric_rgb[ch]).astype(np.uint8)  # trim/ink never bleed in
        med = nd.median_filter(src, size=31)
        plain[..., ch][sel] = med[sel]
    run("motif_removed", plain, "front", "motifDensity")
    # motif: a regular grid of roundels (the first test's back) on the plain fabric: flat tonal disks r 12 at the
    # brief's roundel contrast (#36363e on #2b2b31), 60 px apart wherever the whole disk is plain fabric
    grid = plain.copy()
    yy, xx = np.mgrid[-12:13, -12:13]
    disk = yy ** 2 + xx ** 2 <= 144
    sel = m["fabric"] & (m["dt"] > 12)
    for gy in range(int(b["top"]) + 30, int(b["bottom"]) - 20, 60):
        for gx in range(int(b["mid"]) - 330, int(b["mid"]) + 331, 60):
            if sel[gy - 12:gy + 13, gx - 12:gx + 13][disk].all():
                region = grid[gy - 12:gy + 13, gx - 12:gx + 13]
                region[disk, :3] = np.clip(region[disk, :3].astype(int) + np.array([11, 11, 13]), 0, 255).astype(np.uint8)
    g = run("motif_grid", grid, "front", "motifIrregular")
    out["motif_grid"]["motif"] = g["details"]["motif"]
    # outline: the 9 px ink band thinned to 4 px (depth 5..10 repainted with the fabric next to it)
    thin_ink = front.copy()
    ring = m["ink"] & (m["dt"] > 4) & (m["dt"] <= 10)
    _, (iy, ix) = nd.distance_transform_edt(m["ink"] | ~m["A"], return_indices=True)
    thin_ink[ring, :3] = fabric_rgb
    run("outline_thin", thin_ink, "front", "outlineWidth")
    # presence: the front (placket + 3 frogs) checked as the back view
    run("front_as_back", front, "back", "presence")
    return dict(controls=out, allOk=all(v["ok"] for v in out.values()))


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "polish":
        gen, mask, sp, view, out = sys.argv[2:7]
        rep = run_polish(gen, mask, sp, view, out)
        rep["gates"] = gates(load(out), load_spec(sp), view)
        save_json(Path(out).with_suffix(".report.json"), rep)
        print(json.dumps(dict(polish=rep["polish"], preFailed=rep["preRepairGates"]["failed"], snap=rep["lengthSnap"], widthSnap=rep["widthSnap"], passed=rep["gates"]["passed"], failed=rep["gates"]["failed"])))
    elif cmd == "gates":
        g = gates(load(sys.argv[2]), load_spec(sys.argv[3]), sys.argv[4])
        if len(sys.argv) > 5:
            save_json(sys.argv[5], g)
        print(json.dumps(g, indent=1))
    elif cmd == "selftest":
        r = selftest(load_spec(sys.argv[2]))
        if len(sys.argv) > 3:
            save_json(sys.argv[3], r)
        print(json.dumps(r, indent=1))
        sys.exit(0 if r["allOk"] else 1)
