# Atlas Animator multi-view swag (packages/animator/README.md): shared measurement code for the design spec
# (spec_extract.py), the structure maps (structure_map.py) and the view polish + consistency gates (view_polish.py).
# Every measurement works on a garment PNG on the rig canvas (1086x1448 RGBA, alpha = the garment).
import json
import os
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage as nd

DROPS = Path(os.environ.get("ART_DROPS", r"C:\Users\dev\Documents\art-drops"))
CROP = (252, 614, 828, 998)  # the polish crop (canvas px): 576x384 -> 1536x1024 (x8/3), the front's draw scale
GEN = (1536, 1024)
INK_LUM = 20      # outline ink (domain stroke ~#181210 / painted #0a0a10, lum ~11) vs fabric shadow (lum ~29)
TRIM_LUM = 150    # cream trim (#e6dcc6 family incl. its #8f887c deep shade measured separately)
EDGE_IN = 12      # px from the alpha edge: the outline band; "interior" pixels lie deeper


def load(path):
    a = np.array(Image.open(path).convert("RGBA"))
    return a


def lum(rgb):
    f = rgb.astype(float)
    return 0.299 * f[..., 0] + 0.587 * f[..., 1] + 0.114 * f[..., 2]


# ---------------------------------------------------------------- colour (sRGB D65 -> CIELAB, deltaE 76 and 2000)
def to_lab(rgb):
    c = np.asarray(rgb, float) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    xyz = c @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def from_lab(lab):
    lab = np.asarray(lab, float)
    fy = (lab[..., 0] + 16) / 116
    fx, fz = fy + lab[..., 1] / 500, fy - lab[..., 2] / 200
    f = np.stack([fx, fy, fz], -1)
    xyz = np.where(f ** 3 > 216 / 24389, f ** 3, (116 * f - 16) / (24389 / 27)) * np.array([0.95047, 1.0, 1.08883])
    mi = np.array([[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]])
    c = np.clip(xyz @ mi.T, 0, 1)
    c = np.where(c <= 0.0031308, 12.92 * c, 1.055 * c ** (1 / 2.4) - 0.055)
    return np.clip(np.round(c * 255), 0, 255).astype(np.uint8)


def de76(a, b):
    return float(np.linalg.norm(np.asarray(a, float) - np.asarray(b, float)))


def de00(l1, l2):
    L1, a1, b1 = l1
    L2, a2, b2 = l2
    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2)
    Cm = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p, h2p = np.degrees(np.arctan2(b1, a1p)) % 360, np.degrees(np.arctan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, C2p - C1p
    dh = h2p - h1p
    if C1p * C2p == 0:
        dh = 0
    elif dh > 180:
        dh -= 360
    elif dh < -180:
        dh += 360
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh / 2))
    Lpm, Cpm = (L1 + L2) / 2, (C1p + C2p) / 2
    if C1p * C2p == 0:
        hpm = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        hpm = (h1p + h2p) / 2
    else:
        hpm = (h1p + h2p + 360) / 2 if h1p + h2p < 360 else (h1p + h2p - 360) / 2
    T = 1 - 0.17 * np.cos(np.radians(hpm - 30)) + 0.24 * np.cos(np.radians(2 * hpm)) + 0.32 * np.cos(np.radians(3 * hpm + 6)) - 0.20 * np.cos(np.radians(4 * hpm - 63))
    dth = 30 * np.exp(-(((hpm - 275) / 25) ** 2))
    Rc = 2 * np.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7))
    Sl = 1 + 0.015 * (Lpm - 50) ** 2 / np.sqrt(20 + (Lpm - 50) ** 2)
    Sc, Sh = 1 + 0.045 * Cpm, 1 + 0.015 * Cpm * T
    Rt = -np.sin(np.radians(2 * dth)) * Rc
    return float(np.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh)))


# ---------------------------------------------------------------- segmentation
def masks(a):
    """alpha, distance from the edge, ink, cream trim, dark fabric and interior masks of a garment PNG."""
    A = a[..., 3] > 127
    L = lum(a[..., :3])
    dt = nd.distance_transform_edt(A)
    ink = A & (L < INK_LUM)
    trim = A & (L >= TRIM_LUM)
    fabric = A & ~ink & (L < 110)
    interior = A & (dt > EDGE_IN)
    return dict(A=A, L=L, dt=dt, ink=ink, trim=trim, fabric=fabric, interior=interior)


def outline_width(a, m=None):
    """Mean outline ink run measured along the garment contour: sum over depth k of the share of the pixels at
    depth k (distance from the alpha edge) that are ink, until the run breaks. Perimeter-normalised, so views with
    different contour lengths compare directly (not total black pixels)."""
    m = m or masks(a)
    w = 0.0
    for k in range(1, 25):
        s = (m["dt"] > k - 1) & (m["dt"] <= k)
        if not s.any():
            break
        f = float((m["ink"] & s).sum()) / float(s.sum())
        w += f
        if f < 0.15:
            break
    return w


def underarm_apexes(A):
    """Top points (x, y) of the two underarm gaps: the background inside the garment's convex hull, left and right."""
    ys, xs = np.nonzero(A)
    from scipy.spatial import ConvexHull
    from matplotlib.path import Path as MPath
    pts = np.stack([xs, ys], 1)
    h = pts[ConvexHull(pts).vertices]
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    gy, gx = np.mgrid[y0:y1 + 1, x0:x1 + 1]
    inside = MPath(h).contains_points(np.stack([gx.ravel(), gy.ravel()], 1)).reshape(gy.shape)
    gap = inside & ~A[y0:y1 + 1, x0:x1 + 1]
    lab, n = nd.label(gap)
    cx = (x0 + x1) / 2
    best = {}
    for i in range(1, n + 1):
        yy, xx = np.nonzero(lab == i)
        if len(yy) < 200:
            continue
        side = "l" if xx.mean() + x0 < cx else "r"
        top = yy.argmin()
        cand = (int(xx[top] + x0), int(yy[top] + y0), len(yy))
        # the underarm gap is the tallest hull hole on its side
        if side not in best or (yy.max() - yy.min()) > best[side][3]:
            best[side] = (*cand, yy.max() - yy.min())
    return {s: [v[0], v[1]] for s, v in best.items()}


def components(mask, min_area=1):
    lab, n = nd.label(mask)
    out = []
    for i, sl in enumerate(nd.find_objects(lab), 1):
        yy, xx = np.nonzero(lab[sl] == i)
        if len(yy) < min_area:
            continue
        out.append(dict(id=i, area=len(yy), cx=float(xx.mean() + sl[1].start), cy=float(yy.mean() + sl[0].start),
                        x0=sl[1].start, x1=sl[1].stop - 1, y0=sl[0].start, y1=sl[0].stop - 1, lab=lab))
    return out


def motifs(a, m=None):
    """Tonal brocade roundels: small, low-contrast light blobs on the dark fabric (band-pass of the fabric luminance,
    sigma 2.5 minus sigma 12). Sheen shapes are much larger or streak-shaped and drop out by size and aspect; trim
    and ink are excluded. A screening statistic (tuned on the approved Jacket B front: finds the torso roundels,
    misses some inside sleeve sheens), always compared view against view with the same detector."""
    m = m or masks(a)
    fab = m["fabric"] & (m["dt"] > 10)
    L = np.where(fab, m["L"], 0.0)

    def blur(x, s):
        return nd.gaussian_filter(x, s) / (nd.gaussian_filter(fab.astype(float), s) + 1e-6)
    hi = fab & (blur(L, 2.5) - blur(L, 12) > 2.0)
    blobs = []
    for c in components(hi, 1):
        bw, bh = c["x1"] - c["x0"] + 1, c["y1"] - c["y0"] + 1
        if 120 <= c["area"] <= 1200 and 14 <= max(bw, bh) <= 50 and max(bw, bh) / max(1, min(bw, bh)) <= 2.5:
            blobs.append((c["cx"], c["cy"]))
    pts = np.array(blobs) if blobs else np.zeros((0, 2))
    area = float(fab.sum())
    density = len(pts) / area * 1e4 if area else 0.0
    cv = None
    if len(pts) >= 3:
        d = np.sqrt(((pts[:, None, :] - pts[None, :, :]) ** 2).sum(-1))
        np.fill_diagonal(d, np.inf)
        nn = d.min(1)
        cv = float(nn.std() / nn.mean())
    # grid alignment: share of roundels with a neighbour (within 100 px) on the same row or column (+-4 px). The
    # NN-distance CV alone cannot separate a grid from a front that is itself an even repeat; rows and columns can.
    align = None
    if len(pts) >= 3:
        dd = np.abs(pts[:, None, :] - pts[None, :, :])
        near = (np.sqrt((dd ** 2).sum(-1)) < 100) & ~np.eye(len(pts), dtype=bool)
        aligned = near & ((dd[..., 0] <= 4) | (dd[..., 1] <= 4))
        align = float(aligned.any(1).mean())
    return dict(count=len(pts), fabricArea=area, densityPer10k=density, nnCV=cv, gridAlign=align, centres=pts.round(1).tolist())


def bands(a, m=None):
    """Cream trim bands: the placket (the columns near the centre that are trim on most torso rows), then, with the
    placket columns removed, collar (top), hem (bottom) and cuffs (far from the centre) from the trim mask closed
    over the stitch dashes, and frogs (trim across the placket rows, clustered by row). Band width = the band's
    largest inscribed width (2 x max distance inside it), robust to slanted cuffs."""
    m = m or masks(a)
    A = m["A"]
    ys, xs = np.nonzero(A)
    top, bot = int(ys.min()), int(ys.max())
    mid = int(round((xs.min() + xs.max()) / 2))
    trim = nd.binary_closing(m["trim"], iterations=1) & A
    r0, r1 = top + 70, bot - 60
    cols = [x for x in range(mid - 30, mid + 31) if trim[r0:r1, x].mean() > 0.5]
    placket = None
    if cols:
        runs = np.split(np.array(cols), np.nonzero(np.diff(cols) > 1)[0] + 1)
        run = max(runs, key=len)
        placket = dict(x0=int(run[0]), x1=int(run[-1]), x=float(run.mean()), width=float(len(run)), coverage=round(float(trim[r0:r1, run[0]:run[-1] + 1].mean()), 3))
    rest = trim.copy()
    if placket:
        rest[:, placket["x0"]:placket["x1"] + 1] = False
    out = dict(collar=[], hem=[], cuff=[], other=[])
    for c in components(rest, 150):
        comp = c["lab"] == c["id"]
        w = 2.0 * float(nd.distance_transform_edt(comp).max())
        rec = dict(x0=c["x0"], x1=c["x1"], y0=c["y0"], y1=c["y1"], cx=round(c["cx"], 1), cy=round(c["cy"], 1), area=c["area"], width=round(w, 1))
        if c["y0"] < top + 40 and abs(c["cx"] - mid) < 120:
            out["collar"].append(rec)
        elif abs(c["cx"] - mid) > 130:
            out["cuff"].append(rec)
        elif c["y1"] >= bot - 25:
            out["hem"].append(rec)
        else:
            out["other"].append(rec)
    for k in out:
        out[k].sort(key=lambda r: (r["x0"], r["y0"]))
    collar_bot = max([r["y1"] for r in out["collar"]], default=top + 40)
    hem_top = min([r["y0"] for r in out["hem"]], default=bot - 40)
    # frogs: rows (between collar and hem) with a wide cream run across the centre beyond the placket
    zone = trim[:, mid - 75:mid + 76].copy()
    if placket:
        zone[:, placket["x0"] - (mid - 75):placket["x1"] - (mid - 75) + 1] = False
    prof = zone.sum(1)
    rows = [y for y in range(collar_bot + 4, hem_top - 4) if prof[y] >= 10]
    frogs = []
    if rows:
        for grp in np.split(np.array(rows), np.nonzero(np.diff(rows) > 6)[0] + 1):
            if len(grp) >= 8:
                frogs.append([float(mid), float(grp.mean())])
    out.update(placket=placket, frogs=frogs, mid=float(mid), top=top, bottom=bot, collarBottom=int(collar_bot), hemTop=int(hem_top))
    return out


# ---------------------------------------------------------------- palette roles (<= 8: ink + 4 fabric + 3 trim)
FABRIC_ROLES = ["fabric_shadow", "fabric_base", "fabric_light", "fabric_sheen"]
TRIM_ROLES = ["trim_deep", "trim_shadow", "trim_cream"]


def materials(a, m=None):
    """ink / fabric / trim pixel sets for the palette (trim = the cream bands and its darker stitch and shadow tones
    next to it; fabric = the rest of the non-ink garment)."""
    m = m or masks(a)
    A, L = m["A"], m["L"]
    near_trim = nd.binary_dilation(nd.binary_closing(m["trim"], iterations=2), iterations=2)
    trim = A & ~m["ink"] & near_trim & (L >= 90)
    fabric = A & ~m["ink"] & ~trim
    return dict(ink=m["ink"], fabric=fabric, trim=trim)


def kmeans_lab(lab, k, iters=25):
    """Deterministic 1-D-seeded k-means in Lab (seeds at lightness quantiles), centres sorted dark -> light."""
    seeds = np.quantile(lab[:, 0], (np.arange(k) + 0.5) / k)
    cen = np.array([lab[np.argmin(np.abs(lab[:, 0] - s))] for s in seeds], float)
    for _ in range(iters):
        lbl = np.argmin(((lab[:, None, :] - cen[None]) ** 2).sum(-1), 1)
        new = np.array([np.median(lab[lbl == i], 0) if (lbl == i).any() else cen[i] for i in range(k)])
        if np.allclose(new, cen, atol=0.05):
            break
        cen = new
    return cen[np.argsort(cen[:, 0])]


def assign_roles(a, palette, m=None):
    """Per-pixel role index map (-1 = transparent) by material and nearest palette role in Lab."""
    m = m or masks(a)
    mat = materials(a, m)
    lab = to_lab(a[..., :3])
    names = [p["role"] for p in palette]
    cen = np.array([p["lab"] for p in palette])
    out = np.full(a.shape[:2], -1, int)
    out[mat["ink"]] = names.index("ink")
    for group in (FABRIC_ROLES, TRIM_ROLES):
        idx = [names.index(r) for r in group]
        sel = mat["fabric"] if group is FABRIC_ROLES else mat["trim"]
        d = ((lab[sel][:, None, :] - cen[idx][None]) ** 2).sum(-1)
        out[sel] = np.array(idx)[np.argmin(d, 1)]
    return out


def role_medians(a, palette, m=None, region=None):
    roles = assign_roles(a, palette, m)
    lab = to_lab(a[..., :3])
    res = {}
    for i, p in enumerate(palette):
        sel = roles == i
        if region is not None:
            sel &= region
        res[p["role"]] = dict(n=int(sel.sum()), lab=np.median(lab[sel], 0).round(2).tolist() if sel.sum() >= 30 else None)
    return res


def palette_remap(a, palette, m=None, skip_ink=True):
    """Shifts every non-ink garment pixel by its role's Lab offset (front role median - this art's role median):
    a per-role ramp shift that keeps shading order, antialiasing and painted detail. Returns (new art, offsets)."""
    m = m or masks(a)
    roles = assign_roles(a, palette, m)
    lab = to_lab(a[..., :3])
    out = a.copy()
    offsets = {}
    for i, p in enumerate(palette):
        if skip_ink and p["role"] == "ink":
            continue
        sel = roles == i
        if sel.sum() < 30:
            continue
        off = np.array(p["lab"]) - np.median(lab[sel], 0)
        offsets[p["role"]] = off.round(2).tolist()
        out[..., :3][sel] = from_lab(lab[sel] + off)
    return out, offsets


def save_json(path, obj):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(obj, indent=1) + "\n", encoding="utf-8")
