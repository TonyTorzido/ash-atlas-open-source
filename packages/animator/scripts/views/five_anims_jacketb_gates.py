# Five-anims Jacket B: jacket gates J1-J5 (2026-10-20), called by five_anims_gates.py --set jacketb.
#
# Every frame of clips 01-03 is rendered at 0.4712 (scripts/views/dump-frames.ts, the evidence framing) twice:
#   - as built ("normal");
#   - KEYED: a copy of the rig whose body skin texels (torso/arms/neck and hips/legs atlas regions) are pure magenta and
#     whose body contours (torso, upper_arm(_r), forearm(_r), hips) are magenta too; the jacket texels and every jacket
#     contour are pure green. Head, fists and pants keep their colours. So in a keyed frame, magenta = body skin or body
#     outline that shows; green = jacket.
# The R15 clip is measured on its mirrored-input rig before the image flip (the flip changes no pixel relations).
# Measured in the jacket band only: rows from the jacket's top row (first green row) to the hem (last green row in
# the centre columns).
#   J1 collar vs neck: per column, the first green row in the collar zone; "skin below collar" = magenta pixels in the
#      20 rows under it; "gap" = columns where, walking up from the collar top, background comes before the neck
#      (magenta within 6 px). Both 0 on every frame.
#   J2 sleeves vs arms: every magenta component in the jacket band below the collar zone must touch a fist (dilated
#      FIST_REACH px, the fist's own outline width): that is the wrist under the cuff. Any other component is skin or body outline poking through or out of
#      the jacket. Background cracks: the G10 sliver scan (a <= 2 px background run between two outlines, longest
#      vertical run) over the whole sleeve band, both sides, limit G10_MAX_ROWS; G9 (enclosed holes) covers holes.
#   J3 hem vs pants: in the leg columns (3 px inside the pants' edge at hem + 6), the 3 rows under the hem must be
#      pants (no background, no magenta); pants stay visible below the hem (>= 60 rows at 0.471 in each leg column).
#      Columns at the pants' outer edge where the hem corner flares past the hip are counted as a corner notch
#      (a silhouette detail, reported, not blocking).
#   J4 jacket silhouette ink: rig side, every jacket contour run on the outer silhouette is body brown 3a1001, width 10
#      (the body's), in every rig. Render side, the silhouette ring (2-3 px inside the outer edge) over the jacket:
#      the share of near-black (the interior jacket ink 181210) among ink pixels <= 5 %.
#   J5 placket / centre line follows the turn: setup positions of the jacket mesh's centre-line vertices (|x| <= 2 at
#      0 deg, chest to hem) at 15 deg move like the torso's own centre-line vertices (mean within 1 px) and toward
#      screen-left (< -10 px); the mirrored-input rig's jacket mesh equals the L15 rig's.
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

from turnfront import setup_world
from stock_pants import mesh_world

CLIPS = (("01-idle-front", "front-turn00-faceA", "idle_weight_shift", 96),
         ("02-walk-downright-frontR15", "front-turn15-faceA-mirin", "walk_in_place", 28),
         ("03-walk-downleft-frontL15", "front-turn15-faceA", "walk_in_place", 28))
BODY_REGIONS = ("canonical/template7-shoulder-skin", "canonical/template7-leg-skin")
BODY_CONTOUR_SLOTS = ("torso", "upper_arm", "upper_arm_r", "forearm", "forearm_r", "hips")
MAG, GRN = "ff00ffff", "00ff00ff"
BG = np.array([0x1e, 0x24, 0x30])
BROWN, BLACK = np.array([0x3a, 0x10, 0x01]), np.array([0x18, 0x12, 0x10])
COLLAR_ROWS, NECK_LOOK = 20, 6
HEM_ROWS, PANTS_MIN_ROWS = 3, 60
INK_BLACK_MAX = 0.05
FIST_REACH = 6  # the fist's own brown outline is 10 x 0.4712 = 4.7 px wide; a wrist component touches it
BG_TOL = 6  # the evidence script's background test; the jacket navy and the pants sit ~31 from the background


def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))


def keyed(rig: Path, out: Path) -> Path:
    doc = load(rig)
    at = load(rig.with_name(rig.name.replace(".anim.json", ".atlas.json")))
    page = at["pages"][0]
    im = np.array(Image.open(rig.parent / page["file"]).convert("RGBA"))
    for name, col in [(n, (255, 0, 255)) for n in BODY_REGIONS] + [("garment/jacketb", (0, 255, 0))]:
        r = page["regions"][name]
        sl = im[r["y"]:r["y"] + r["height"], r["x"]:r["x"] + r["width"]]
        sl[..., :3] = np.where(sl[..., 3:4] > 0, np.array(col, np.uint8), sl[..., :3])
    cs = doc["skins"]["body"]["contours"]
    for slot, by in cs.items():
        for n, c in by.items():
            if n.startswith("jacketb"):
                c["color"] = GRN
            elif slot in BODY_CONTOUR_SLOTS:
                c["color"] = MAG
    stem = rig.name.replace(".anim.json", "") + "-keyed"
    page["file"] = f"{stem}.atlas.png"
    Image.fromarray(im).save(out / page["file"])
    (out / f"{stem}.atlas.json").write_text(json.dumps(at), encoding="utf-8")
    p = out / f"{stem}.anim.json"
    p.write_text(json.dumps(doc), encoding="utf-8")
    return p


def dump(rig: Path, clip: str, n: int, td: Path):
    subprocess.run(["npx", "tsx", "scripts/views/dump-frames.ts", str(rig), clip, str(n), str(td)], check=True, shell=sys.platform == "win32")
    return [np.asarray(Image.open(td / f"f{i:03d}.png").convert("RGB")).astype(int) for i in range(n)]


def masks(k):
    r, g, b = k[..., 0], k[..., 1], k[..., 2]
    mag = (r > 110) & (b > 110) & (g < np.minimum(r, b) - 70)
    grn = (g > 110) & (g - np.maximum(r, b) > 70)
    bg = np.abs(k - BG).sum(-1) <= BG_TOL
    fist = (r > 170) & (g > 110) & (r > g) & (g > b) & ~mag & ~grn
    return mag, grn, bg, fist


def frame_gates(k, im, sliver_rows, g10max):
    h, w = k.shape[:2]
    mag, grn, bg, fist = masks(k)
    bgn = np.abs(im - BG).sum(-1) <= BG_TOL  # background in the normal render
    cx = (w - 1) // 2
    rows = np.where(grn.any(1))[0]
    top = int(rows[0])
    centre = grn[:, cx - 40:cx + 41].any(1)
    hem = int(np.where(centre)[0][-1])
    # J1 collar
    below, gaps = 0, 0
    for x in range(w):
        col = np.where(grn[top:top + 40, x])[0]
        if not len(col):
            continue
        g = top + int(col[0])
        up = [y for y in range(g - 1, max(g - 1 - NECK_LOOK, -1), -1)]
        if not any(mag[y, x] for y in up):
            continue  # not a neck column (shoulder line, open sky above)
        below += int(mag[g + 1:g + 1 + COLLAR_ROWS, x].sum())
        first = next((y for y in up if bg[y, x] or mag[y, x]), None)
        if first is not None and bg[first, x]:
            gaps += 1
    # J2 pokes: magenta components in the band below the collar zone that do not touch a fist
    band = np.zeros_like(mag)
    band[top + COLLAR_ROWS:hem + 1] = True
    lab, n = ndimage.label(mag & band)
    fd = ndimage.binary_dilation(fist, iterations=FIST_REACH)
    poke, wrist, pokes = 0, 0, []
    for i in range(1, n + 1):
        c = lab == i
        if (c & fd).any():
            wrist = max(wrist, int(c.sum()))
        else:
            poke += int(c.sum())
            ys, xs = np.where(c)
            pokes.append([int(xs.mean()), int(ys.mean()), int(c.sum())])
    # on the keyed render (green / magenta are far from the background, so the stock tolerance 40 is safe there)
    crack = max(sliver_rows(k, top + COLLAR_ROWS, hem, 0, cx), sliver_rows(k, top + COLLAR_ROWS, hem, cx + 1, w))
    # J3 hem: leg columns (pants at hem + 6, i.e. not bg / magenta / green there)
    pants = ~bg & ~mag & ~grn
    legs = [x for x in range(cx - 70, cx + 71) if pants[min(hem + 6, h - 1), x]]
    bad = [x for x in legs if (bg[hem + 1:hem + 1 + HEM_ROWS, x] | mag[hem + 1:hem + 1 + HEM_ROWS, x]).any()]
    inner = set(x for x in legs if all(pants[min(hem + 6, h - 1), x + d] for d in range(-3, 4)))
    hemgap = sum(1 for x in bad if x in inner)  # inside the pants (3 px in from their edge at hem + 6): a real gap
    notch = len(bad) - hemgap  # at the pants' outer edge: the hem corner flares past the hip (silhouette notch)
    vis = []
    for x in (cx - 30, cx + 30):
        y = hem + 1
        while y < h and pants[y, x]:
            y += 1
        vis.append(y - hem - 1)
    # J4 ring: 2-3 px inside the outer silhouette, over the jacket (green dilated 3), jacket rows
    solid = ndimage.binary_fill_holes(~bgn)
    d = ndimage.distance_transform_edt(solid)
    ring = (d >= 2) & (d <= 3) & ndimage.binary_dilation(grn, iterations=3)
    ring[:top] = False
    ring[hem + 1:] = False
    px = im[ring]
    db, dk = np.linalg.norm(px - BROWN, axis=1), np.linalg.norm(px - BLACK, axis=1)
    brown = int(((db < 45) & (db <= dk)).sum())
    black = int(((dk < 25) & (dk < db)).sum())
    return {"top": top, "hem": hem, "skinBelowCollarPx": below, "collarGapCols": gaps, "pokePx": poke, "pokes": pokes[:4], "wristPxMax": wrist,
            "crackRows": crack, "hemGapCols": hemgap, "hemCornerNotchCols": notch, "legCols": len(legs), "pantsRowsBelowHem": vis, "ringBrown": brown, "ringBlack": black}


def j5(R: Path, stock: str):
    d0, d15, dm = load(R / "front-turn00.anim.json"), load(R / "front-turn15.anim.json"), load(R / "front-turn15-faceA-mirin.anim.json")
    out = {}

    def xy(doc, slot, att):
        return mesh_world(doc["skins"]["body"]["attachments"][slot][att], setup_world(doc["bones"]))
    for slot, att, key in (("jacketb", "jacketb", "jacket"), ("torso", "skin", "torso")):
        a, b = xy(d0, slot, att), xy(d15, slot, att)
        sel = (np.abs(a[:, 0]) <= 2) & (a[:, 1] > -280) & (a[:, 1] < 0)
        dx = b[sel, 0] - a[sel, 0]
        out[key] = {"vertices": int(sel.sum()), "meanDxPx": round(float(dx.mean()), 2), "minDxPx": round(float(dx.min()), 2), "maxDxPx": round(float(dx.max()), 2)}
    # the jacket attachment in L15 vs the mirrored-input L15 rig (the R15 clip): identical
    same = json.dumps(d15["skins"]["body"]["attachments"]["jacketb"]) == json.dumps(dm["skins"]["body"]["attachments"]["jacketb"])
    out["mirinJacketEqualsL15"] = same
    dj, dt = out["jacket"]["meanDxPx"], out["torso"]["meanDxPx"]
    out["pass"] = bool(out["jacket"]["vertices"] >= 5 and abs(dj - dt) <= 1.0 and dj < -10 and same)
    return out


def j4_rig(R: Path, stock: str):
    rep = load(R / f"{stock}.jacket.json")["ink"]
    runs = [p for v in rep["contours"].values() for p in v]
    sil = [p for p in runs if p["silhouette"]]
    bad = [p["name"] for p in sil if p["color"] != "3a1001ff" or p["width"] != 10]
    # the turned / face rigs keep the same jacket contours (turnfront moves points, never colours)
    ref = {(s, n): (c["color"], c["width"]) for s, by in load(R / f"{stock}.anim.json")["skins"]["body"]["contours"].items() for n, c in by.items() if n.startswith("jacketb")}
    drift = {}
    for _, rig, _, _ in CLIPS:
        cur = {(s, n): (c["color"], c["width"]) for s, by in load(R / f"{rig}.anim.json")["skins"]["body"]["contours"].items() for n, c in by.items() if n.startswith("jacketb")}
        drift[rig] = cur == ref
    return {"silhouetteRuns": len(sil), "interiorRuns": len(runs) - len(sil), "silhouetteNotBrown10": bad, "rigsKeepJacketInk": drift,
            "pass": not bad and all(drift.values())}


def gates(R: Path, stock: str):
    from five_anims_gates import G10_MAX_ROWS, sliver_rows
    per = {}
    with tempfile.TemporaryDirectory() as tdn:
        td = Path(tdn)
        for tag, rig, clip, n in CLIPS:
            kr = keyed(R / f"{rig}.anim.json", R)
            try:
                kf = dump(kr, clip, n, td / f"{tag}-k")
            finally:
                for suf in (".anim.json", ".atlas.json", ".atlas.png"):
                    (R / kr.name.replace(".anim.json", suf)).unlink(missing_ok=True)
            nf = dump(R / f"{rig}.anim.json", clip, n, td / f"{tag}-n")
            per[tag] = [frame_gates(k, im, sliver_rows, G10_MAX_ROWS) for k, im in zip(kf, nf)]
    res = {}

    def worst(key, f=max):
        return {t: {"worst": f(r[key] for r in v), "frame": int(np.argmax([r[key] for r in v]))} for t, v in per.items()}
    j1b, j1g = worst("skinBelowCollarPx"), worst("collarGapCols")
    res["J1 collar vs neck"] = {"skinBelowCollarPx": j1b, "collarGapCols": j1g,
                                "pass": all(v["worst"] == 0 for v in j1b.values()) and all(v["worst"] == 0 for v in j1g.values())}
    j2p, j2c, j2w = worst("pokePx"), worst("crackRows"), worst("wristPxMax")
    res["J2 sleeves vs arms"] = {"pokePx (skin/outline not touching a fist)": j2p, "crackRows (limit %d)" % G10_MAX_ROWS: j2c,
                                 "wristSkinPxMax (informational)": j2w,
                                 "pass": all(v["worst"] == 0 for v in j2p.values()) and all(v["worst"] <= G10_MAX_ROWS for v in j2c.values())}
    j3g = worst("hemGapCols")
    pv = {t: min(min(r["pantsRowsBelowHem"]) for r in v) for t, v in per.items()}
    lc = {t: min(r["legCols"] for r in v) for t, v in per.items()}
    res["J3 hem vs pants"] = {"hemGapCols (inside the pants)": j3g, "hemCornerNotchCols (outer edge, reported, not blocking)": worst("hemCornerNotchCols"), "minLegCols": lc, "minPantsRowsBelowHem": pv, "pantsMinRows": PANTS_MIN_ROWS,
                              "pass": all(v["worst"] == 0 for v in j3g.values()) and all(v >= PANTS_MIN_ROWS for v in pv.values()) and all(v > 20 for v in lc.values())}
    ring = {t: {"brown": sum(r["ringBrown"] for r in v), "black": sum(r["ringBlack"] for r in v)} for t, v in per.items()}
    for v in ring.values():
        v["blackShare"] = round(v["black"] / max(1, v["brown"] + v["black"]), 4)
    rig = j4_rig(R, stock)
    res["J4 jacket silhouette ink"] = {"rig": rig, "renderRing": ring, "blackShareMax": INK_BLACK_MAX,
                                      "pass": rig["pass"] and all(v["blackShare"] <= INK_BLACK_MAX for v in ring.values())}
    res["J5 placket and centre line follow the turn"] = j5(R, stock)
    res["jacket per-frame (0.4712)"] = per
    return res
