# Atlas Animator five-anims refine (2026-10-19, REFINE-PLAN items 2 + 7): the STOCK look = the certified black pants
# (docs/plans/atlas-animator-demos/pants/black/rig, from feature/atlas-animator-pants--from-t1511 e558f2a22; same
# skeleton, torso/hips/tank meshes and walk/idle clips as the phase-4d4m body). It replaces stock_shorts.py's charcoal
# shorts stand-in for the front clips; the pants slot already hides `shorts`. No art change.
#
# Ink: garment contour runs that sit on the OUTER silhouette take the body brown 3a1001; interior
# runs keep their garment ink (tank 45403d, pants 1a1614). Classification is geometric, in the setup pose: every
# visible mesh triangle and region (head, fists, by their opaque polygons) is rasterised in skeleton space; a contour
# point is "silhouette" when it lies within SIL_PX of the background. Each garment contour is split into runs of equal
# class (adjacent runs share their end point, so the stroke stays continuous); a run of one point joins its neighbour.
# Body contours (already 3a1001) are untouched. The rig JSON is otherwise copied unchanged (animations included).
#
#   python scripts/views/stock_pants.py <pants rig.anim.json> <out dir> <out stem>   (run from packages/animator)
import argparse
import json
import math
import shutil
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from turnfront import apply, setup_world

BODY_INK = "3a1001ff"
GARMENT_SLOTS = ("tank", "tank_armhole", "tank_armhole_r", "pants")  # shorts: hidden by the pants slot
SIL_PX = 7.0  # contour width 10: a point within ~half a stroke + 2 px of the background is on the silhouette
PAD = 400
# refine P5 waist step: the pants' boundary offset (7 px outward of the hips skin) put the waistband's top outer corners
# at x +-117 while the tank flank there is at +-110, so the silhouette stepped out where tank meets pants. The offset
# entries anchored at those two corners (setup y above WAIST_Y, |x| above WAIST_X) take WAIST_CORNER_OFFSET instead;
# the side edge then runs straight from the tank flank down to the full 7 px offset at the hip (next anchor, y ~ +16).
# With the corner pulled in, the grey tank hem trim (width 14, butt caps, ending on the tank's corner) poked a tab out
# over the pants' brown edge just below the corner; each hem end is moved HEM_TRIM px inward along the hem.
WAIST_Y, WAIST_X, WAIST_CORNER_OFFSET, HEM_TRIM = -30.0, 100.0, 0.5, 5.0


def mesh_world(a, w0):
    names, v, out, i = a["bones"], a["vertices"], [], 0
    while i < len(v):
        n = int(v[i])
        i += 1
        x = y = 0.0
        for _ in range(n):
            bi, lx, ly, wt = int(v[i]), v[i + 1], v[i + 2], v[i + 3]
            px, py = apply(w0[names[bi]], lx, ly)
            x, y = x + wt * px, y + wt * py
            i += 4
        out.append((x, y))
    return np.array(out)


def region_poly(a, m):
    """Skeleton-space polygon of a region attachment (its opaque outline, else its rectangle)."""
    w, h = a["width"], a["height"]
    sx, sy = a.get("scaleX", 1.0), a.get("scaleY", 1.0)
    r = math.radians(a.get("rotation", 0.0))
    op = a.get("opaque")
    uv = np.array(op).reshape(-1, 2) if op else np.array([[0, 0], [1, 0], [1, 1], [0, 1]], float)
    pts = []
    for u, v in uv:
        lx, ly = (u - 0.5) * w * sx, (v - 0.5) * h * sy  # engine: uv (0, 0) = corner (-hw, -hh)
        bx = a.get("x", 0.0) + lx * math.cos(r) - ly * math.sin(r)
        by = a.get("y", 0.0) + lx * math.sin(r) + ly * math.cos(r)
        pts.append(apply(m, bx, by))
    return pts


def silhouette(doc, w0):
    skin = doc["skins"]["body"]["attachments"]
    worlds = {}
    shapes = []
    for s in doc["slots"]:
        att = s.get("attachment")
        if not att:
            continue
        a = skin[s["name"]][att]
        if a["type"] == "mesh" and "bones" in a:
            xy = mesh_world(a, w0)
            worlds[(s["name"], att)] = xy
            for t in np.array(a["triangles"]).reshape(-1, 3):
                shapes.append([tuple(p) for p in xy[t]])
        elif a["type"] == "region":
            shapes.append(region_poly(a, w0[s["bone"]]))
    allp = np.array([p for sh in shapes for p in sh])
    x0, y0 = allp.min(0) - PAD / 4
    x1, y1 = allp.max(0) + PAD / 4
    im = Image.new("L", (int(x1 - x0) + 1, int(y1 - y0) + 1), 0)
    dr = ImageDraw.Draw(im)
    for sh in shapes:
        dr.polygon([(px - x0, py - y0) for px, py in sh], fill=255)
    mask = np.asarray(im) > 0
    mask = ndimage.binary_fill_holes(ndimage.binary_closing(mask, iterations=1))
    dist = ndimage.distance_transform_edt(mask)
    return dist, (x0, y0), worlds


def mesh_points(doc, w0, worlds, ref):
    key = (ref["slot"], ref["attachment"])
    if key not in worlds:
        worlds[key] = mesh_world(doc["skins"]["body"]["attachments"][ref["slot"]][ref["attachment"]], w0)
    return worlds[key]


def runs(flags):
    out, start = [], 0
    for i in range(1, len(flags) + 1):
        if i == len(flags) or flags[i] != flags[start]:
            out.append([start, i - 1, flags[start]])
            start = i
    # single-point runs join a neighbour (a stroke needs two points)
    merged = []
    for r in out:
        if r[1] == r[0] and merged:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    if len(merged) > 1 and merged[0][1] == merged[0][0]:
        merged[1][0] = merged[0][0]
        merged.pop(0)
    return merged


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rig")
    ap.add_argument("out")
    ap.add_argument("stem")
    a = ap.parse_args()
    src = Path(a.rig)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    doc = json.loads(src.read_text(encoding="utf-8"))
    atlas = json.loads(src.with_name(src.name.replace(".anim.json", ".atlas.json")).read_text(encoding="utf-8"))
    w0 = setup_world(doc["bones"])
    dist, (ox, oy), worlds = silhouette(doc, w0)
    contours = doc["skins"]["body"]["contours"]
    report = {"silhouettePx": SIL_PX, "contours": {}}
    for slot in GARMENT_SLOTS:
        cs = contours.get(slot)
        if not cs:
            continue
        new = {}
        for name, c in cs.items():
            if "mesh" not in c:
                new[name] = c
                continue
            xy = mesh_points(doc, w0, worlds, c["mesh"])
            pts = c["points"]
            flags = []
            for p in pts:
                if isinstance(p, int):
                    x, y = xy[p]
                else:  # [a, b, c, wa, wb] = wa a + wb b + (1 - wa - wb) c
                    x, y = p[3] * xy[p[0]] + p[4] * xy[p[1]] + (1 - p[3] - p[4]) * xy[p[2]]
                ix, iy = int(round(x - ox)), int(round(y - oy))
                d = dist[iy, ix] if 0 <= iy < dist.shape[0] and 0 <= ix < dist.shape[1] else 0.0
                flags.append(bool(d <= SIL_PX))
            rs = runs(flags)
            info = []
            for k, (s0, s1, sil) in enumerate(rs):
                lo, hi = max(0, s0 - (1 if k else 0)), s1  # share the previous run's end point
                piece = dict(c, points=pts[lo:hi + 1])
                if sil:
                    piece["color"] = BODY_INK
                if len(rs) > 1:
                    piece["caps"] = "round"
                nm = name if len(rs) == 1 else f"{name}_{'sil' if sil else 'in'}{k}"
                new[nm] = piece
                info.append({"name": nm, "points": hi + 1 - lo, "silhouette": sil, "color": piece["color"]})
            report["contours"][f"{slot}.{name}"] = info
        contours[slot] = new
    pants = doc["skins"]["body"]["attachments"]["pants"]["pants"]
    pxy = mesh_world(pants, w0)
    off = pants["embed"]["offsets"]["points"]
    corners = [k for k, p in enumerate(off) if pxy[p[0], 1] < WAIST_Y and abs(pxy[p[0], 0]) > WAIST_X]
    assert len(corners) == 2, corners
    names, v = pants["bones"], pants["vertices"]
    starts, i = [], 0  # flat offset of each vertex record in the weighted vertex list
    while i < len(v):
        starts.append(i)
        i += 1 + 4 * int(v[i])
    for k in corners:
        # the stored setup position follows too (the runtime re-poses offsets from embed; turnfront reads the stored)
        vi, anchor = pants["embed"]["offsets"]["vertices"][k], off[k][0]
        dx, dy = (pxy[anchor] - pxy[vi]) * (1 - WAIST_CORNER_OFFSET / off[k][3])
        off[k][3] = WAIST_CORNER_OFFSET
        j = starts[vi]
        for q in range(int(v[j])):
            b = j + 1 + 4 * q
            m = w0[names[int(v[b])]][:2, :2]
            lx, ly = np.linalg.solve(m, [dx, dy])
            v[b + 1], v[b + 2] = round(v[b + 1] + lx, 4), round(v[b + 2] + ly, 4)
    hem = contours["tank"]["hem"]
    txy = mesh_world(doc["skins"]["body"]["attachments"]["tank"]["tank"], w0)
    for end in (0, -1):
        pts = hem["points"] if end == 0 else hem["points"][::-1]
        assert isinstance(pts[0], int) and isinstance(pts[1], int)
        walked, k = 0.0, 0
        while walked + np.hypot(*(txy[pts[k + 1]] - txy[pts[k]])) < HEM_TRIM:
            walked += np.hypot(*(txy[pts[k + 1]] - txy[pts[k]]))
            k += 1
        seg = np.hypot(*(txy[pts[k + 1]] - txy[pts[k]]))
        t = (HEM_TRIM - walked) / seg
        new = [[pts[k], pts[k + 1], pts[k + 1], round(1 - t, 6), round(t, 6)]] + pts[k + 1:]
        hem["points"] = new if end == 0 else new[::-1]
    report["waistCorners"] = {"entries": corners, "offset": WAIST_CORNER_OFFSET, "hemTrim": HEM_TRIM}
    doc["name"] = a.stem
    (out / f"{a.stem}.anim.json").write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    page = atlas["pages"][0]
    shutil.copyfile(src.parent / page["file"], out / f"{a.stem}.atlas.png")
    page["file"] = f"{a.stem}.atlas.png"
    (out / f"{a.stem}.atlas.json").write_text(json.dumps(atlas, indent=1), encoding="utf-8")
    report["source"] = src.as_posix()
    (out / f"{a.stem}.ink.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    for k, v in report["contours"].items():
        print(k, " ".join(f"{p['name']}:{p['points']}{'S' if p['silhouette'] else 'i'}" for p in v))


if __name__ == "__main__":
    main()
