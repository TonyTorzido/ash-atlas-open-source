# Atlas Animator five-anims: Jacket B on the refined stock (2026-10-20). No new art.
#
# The certified Jacket B rig (docs/plans/atlas-animator-demos/jacket-b/jacket/rig, garmentImport on the phase-4d4m
# body) and the refined stock rig (five-anims/rig/stock-front: black pants, brown silhouette ink, polished fists/feet,
# template walk, idle breath) share the skeleton, the torso/hips/head/fist attachments, driven deforms, drivenGrids,
# pose limits, contact bands and IK byte for byte (checked here; the script stops otherwise). The jacket is ONE mesh
# (`jacketb`, embedded in the torso skin, so it follows every torso deform) plus contour-only slots for the sleeves.
# This script does what `garmentSurface.dressGarment` does, onto the refined stock instead of the bare body:
#   - jacket slots inserted after the same slots as in the jacket rig (jacketb over tank and pants, so the hem covers
#     the waistband; sleeve contour slots after upper_arm / hand);
#   - the jacketb attachment and every jacket contour (incl. the collar tucks the jacket rig files under `head`);
#   - tank, tank_armhole, tank_armhole_r hidden (the jacket rig's --hides);
#   - the garment/jacketb atlas region appended below the stock atlas page (stock texels untouched).
# Ink (design review, as stock_pants.py): jacket contour runs on the OUTER silhouette (setup pose, jacket on, tank off) take
# the body brown 3a1001; interior runs keep the jacket ink 181210. Animations are not touched.
#
#   python scripts/views/stock_jacketb.py <stock rig.anim.json> <jacket rig.anim.json> <out dir> <out stem>
import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image

from stock_pants import BODY_INK, SIL_PX, mesh_points, runs, silhouette
from turnfront import setup_world

HIDES = ("tank", "tank_armhole", "tank_armhole_r")
SHARED = ("bones", "driven", "drivenGrids", "poseLimits", "contactBands", "ik")
GAP = 4


def h(o):
    return hashlib.sha256(json.dumps(o, sort_keys=True).encode()).hexdigest()[:16]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stock")
    ap.add_argument("jacket")
    ap.add_argument("out")
    ap.add_argument("stem")
    a = ap.parse_args()
    sp, jp, out = Path(a.stock), Path(a.jacket), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    doc = json.loads(sp.read_text(encoding="utf-8"))
    jac = json.loads(jp.read_text(encoding="utf-8"))
    report = {"stock": sp.as_posix(), "jacket": jp.as_posix(), "shared": {}}
    for k in SHARED:
        assert h(doc[k]) == h(jac[k]), f"{k} differs between stock and jacket rig"
        report["shared"][k] = h(doc[k])
    sa, ja = doc["skins"]["body"]["attachments"], jac["skins"]["body"]["attachments"]
    for slot in ("torso", "hips", "head", "hand", "hand_r"):
        for nm in sa[slot]:
            assert h(sa[slot][nm]) == h(ja[slot][nm]), f"attachment {slot}/{nm} differs"
    # slots
    jnames = [s["name"] for s in jac["slots"]]
    added = []
    for i, s in enumerate(jac["slots"]):
        if not s["name"].startswith("jacketb"):
            continue
        after = jnames[i - 1]
        at = next(k for k, x in enumerate(doc["slots"]) if x["name"] == after)
        if after == "tank":  # the jacket goes over the pants too (stock order: shorts, pants, tank)
            at = max(at, next(k for k, x in enumerate(doc["slots"]) if x["name"] == "pants"))
        doc["slots"].insert(at + 1, dict(s))
        added.append({"slot": s["name"], "after": doc["slots"][at]["name"]})
    for s in doc["slots"]:
        if s["name"] in HIDES:
            s.pop("attachment", None)
    report["slotsAdded"], report["hidden"] = added, list(HIDES)
    sa["jacketb"] = json.loads(json.dumps(ja["jacketb"]))
    # contours: every jacket contour (the jacket slots' and the jacket entries under `head`)
    cs, jc = doc["skins"]["body"]["contours"], jac["skins"]["body"]["contours"]
    jslots = []
    for slot, by in jc.items():
        mine = {n: c for n, c in by.items() if n.startswith("jacketb")}
        if mine:
            cs.setdefault(slot, {}).update(json.loads(json.dumps(mine)))
            jslots.append(slot)
    # ink split (design review)
    w0 = setup_world(doc["bones"])
    dist, (ox, oy), worlds = silhouette(doc, w0)
    report["ink"] = {"silhouettePx": SIL_PX, "bodyInk": BODY_INK, "contours": {}}
    for slot in jslots:
        new = {}
        for name, c in cs[slot].items():
            if not name.startswith("jacketb") or "mesh" not in c:
                new[name] = c
                continue
            xy = mesh_points(doc, w0, worlds, c["mesh"])
            pts, flags = c["points"], []
            for p in pts:
                if isinstance(p, int):
                    x, y = xy[p]
                else:
                    x, y = p[3] * xy[p[0]] + p[4] * xy[p[1]] + (1 - p[3] - p[4]) * xy[p[2]]
                ix, iy = int(round(x - ox)), int(round(y - oy))
                d = dist[iy, ix] if 0 <= iy < dist.shape[0] and 0 <= ix < dist.shape[1] else 0.0
                flags.append(bool(d <= SIL_PX))
            rs = runs(flags)
            info = []
            for k, (s0, s1, sil) in enumerate(rs):
                lo, hi = max(0, s0 - (1 if k else 0)), s1
                piece = dict(c, points=pts[lo:hi + 1])
                if sil:
                    piece["color"] = BODY_INK
                if len(rs) > 1:
                    piece["caps"] = "round"
                nm = name if len(rs) == 1 else f"{name}_{'sil' if sil else 'in'}{k}"
                new[nm] = piece
                info.append({"name": nm, "points": hi + 1 - lo, "silhouette": sil, "color": piece["color"], "width": piece.get("width")})
            report["ink"]["contours"][f"{slot}.{name}"] = info
        cs[slot] = new
    # atlas: the jacket region appended below the stock page
    sat = json.loads(sp.with_name(sp.name.replace(".anim.json", ".atlas.json")).read_text(encoding="utf-8"))
    jat = json.loads(jp.with_name(jp.name.replace(".anim.json", ".atlas.json")).read_text(encoding="utf-8"))
    spg, jpg = sat["pages"][0], jat["pages"][0]
    rg = jpg["regions"]["garment/jacketb"]
    simg = Image.open(sp.parent / spg["file"]).convert("RGBA")
    jimg = Image.open(jp.parent / jpg["file"]).convert("RGBA")
    W = max(simg.width, rg["width"] + 2 * GAP)
    H = simg.height + rg["height"] + GAP
    page = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    page.paste(simg, (0, 0))
    piece = jimg.crop((rg["x"], rg["y"], rg["x"] + rg["width"], rg["y"] + rg["height"]))
    nx, ny = 2, simg.height + GAP - 2
    page.paste(piece, (nx, ny))
    spg["regions"]["garment/jacketb"] = {**rg, "x": nx, "y": ny}
    spg["file"], spg["width"], spg["height"] = f"{a.stem}.atlas.png", W, H
    page.save(out / f"{a.stem}.atlas.png")
    (out / f"{a.stem}.atlas.json").write_text(json.dumps(sat, indent=1), encoding="utf-8")
    report["atlasRegion"] = spg["regions"]["garment/jacketb"]
    report["animationsHash"] = h(doc["animations"])
    doc["name"] = a.stem
    (out / f"{a.stem}.anim.json").write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    (out / f"{a.stem}.jacket.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    for k, v in report["ink"]["contours"].items():
        print(k, " ".join(f"{p['name']}:{p['points']}{'S' if p['silhouette'] else 'i'}" for p in v))


if __name__ == "__main__":
    main()
