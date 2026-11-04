# Five stock-body animations: gates G1-G8 (docs/plans/atlas-animator-demos/views/turned-front/five-anims/five-anims-PLAN.md).
# Run from packages/animator after five-anims-rigs.sh and five-anims-evidence.ts (which writes gates-render.json):
#   python scripts/views/five_anims_gates.py
# Writes five-anims/gates.json. Rig-side gates are measured here (rigs, face.json, the back hair layers rebuilt with
# turnback_hair.build, `animator validate`); render-side ones (G2 framing, G3 idle vs round 2, G6 flip(flip), G7 loops,
# G8 swim) come from gates-render.json.
# `--set jacketb` (2026-10-20): the front clips 01-03 from five-anims/jacketb/rig (Jacket B on the refined stock,
# five-anims-jacketb-rigs.sh), gates written to five-anims/jacketb/gates.json; the back gates (parked) still read the
# base five-anims/rig; the jacket gates J1-J5 (five_anims_jacketb_gates.py) are added.
import hashlib
import json
import math
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
import turnback_hair as tb
import back_drawn as bd  # noqa: E402
from turnfront import (ALPHA_PER_SIN, ARM_R, D_CHEST, D_HIPS, W_CHEST, W_HIPS, cyl, far_shade,  # noqa: E402
                       mesh_world_x, setup_world)
from turnfront_face import Live, mirror, place_hair  # noqa: E402

D = Path("../../docs/plans/atlas-animator-demos")
SET = sys.argv[sys.argv.index("--set") + 1] if "--set" in sys.argv else ""
BASE = D / "views/turned-front/five-anims"
OUT = BASE / SET if SET else BASE
R = OUT / "rig"  # the front rigs (stock or the set's)
RB = BASE / "rig"  # the back rigs (parked; never rebuilt per set)
STOCK = "stock-front-jacketb" if SET == "jacketb" else "stock-front"
SRC = {"front": D / "phase-4d4m/body/rig/template7-shoulder-legs.anim.json", "back": D / "views/body-back/rig/template7-shoulder-legs-back.anim.json"}
CLIPS = [  # (tag, rig, view, flipped)
    ("01-idle-front", "front-turn00-faceA", "front", False),
    ("02-walk-downright-frontR15", "front-turn15-faceA-mirin", "front", True),
    ("03-walk-downleft-frontL15", "front-turn15-faceA", "front", False),
    ("04-walk-upright-backR15", "back-turn15-hair-mirin", "back", True),
    ("05-walk-upleft-backL15", "back-turn15-hair", "back", False),
]
LUM = np.array([0.299, 0.587, 0.114], np.float32)


def load(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def anim_hash(p: Path) -> str:
    """Hash of the animations; refine P3: the face slot's blink attachment timeline (added by turnfront_face.py --blink,
    the face slot only exists on the face rigs) is left out, so the face rigs still match rig/stock-front."""
    anims = json.loads(json.dumps(load(p)["animations"]))
    for a in anims.values():
        sl = a.get("slots", {})
        sl.pop("face", None)
        sl.pop("eyes", None)  # refine P7: the blink swaps the eyes slot
        if not sl:
            a.pop("slots", None)
    return hashlib.sha256(json.dumps(anims, sort_keys=True).encode()).hexdigest()[:16]


SHIPPED = ("walk_in_place", "idle_weight_shift")  # the clips the five-anims GIFs play
LOCKED = [c for c in CLIPS if c[2] == "front"]  # refine: 01-03 are locked, 04-05 (back) are parked
STRESS_BASELINE = 241  # round 2c front L15 (round2/rig/body-turn15-face2c-shift) total validate errors


def validate_counts(paths):
    """`animator validate` error / warning counts and the clip-tear issues of the shipped clips, run in parallel."""
    procs = {}
    for p in paths:
        cmd = ["npx", "tsx", "src/cli/animator.ts", "validate", str(p), "--atlas", str(p).replace(".anim.json", ".atlas.json")]
        procs[p] = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, shell=sys.platform == "win32", encoding="utf-8")
    out = {}
    for p, pr in procs.items():
        text = pr.communicate()[0]
        last = [ln for ln in text.splitlines() if "error(s)" in ln or "warning(s)" in ln or ln.strip().startswith(("OK", "VALID", "INVALID"))]
        line = last[-1] if last else (text.strip().splitlines() or [""])[-1]
        m = re.search(r"(\d+) error", line)
        errs = int(m.group(1)) if m else 0
        w = re.search(r"(\d+) warning", line)
        tears = {c: [ln.split(": ", 2)[-1] for ln in text.splitlines() if ln.startswith(f"error [tears] animations.{c}:")] for c in SHIPPED}
        out[str(p)] = {"errors": errs, "warnings": int(w.group(1)) if w else 0, "summary": line.strip(), "clipTears": tears}
    return out


def g1():
    """Refine G1: (a) every rig's animations equal its REFINED stock rig's (front: stock-front after the refine
    steps; back: the parked back source); (b) 0 clip tears in the shipped clips on the locked clips' rigs (blocking);
    (c) the rest of the validate errors (stress-pose geometry / tears, not in these clips) recorded against the
    round-2c baseline, not blocking."""
    res = {"animationsHash": {}, "validate": {}}
    src_h = {"front": anim_hash(R / f"{STOCK}.anim.json"), "back": anim_hash(SRC["back"])}
    ok = True
    rigs = [STOCK, "stock-back", "stock-back-drawn", "front-turn00", "front-turn15", "back-turn00", "back-turn15"] + [c[1] for c in CLIPS]
    if SET:  # the set's front rigs must also equal the base refined stock's animations (the jacket never edits them)
        res["animationsHash"]["base stock-front"] = {"hash": anim_hash(RB / "stock-front.anim.json"), "source": src_h["front"],
                                                     "equal": anim_hash(RB / "stock-front.anim.json") == src_h["front"]}
        ok &= res["animationsHash"]["base stock-front"]["equal"]
    for r in rigs:
        h = anim_hash((RB if r.startswith(("back", "stock-back")) else R) / f"{r}.anim.json")
        want = src_h["back" if r.startswith(("back", "stock-back")) else "front"]
        res["animationsHash"][r] = {"hash": h, "source": want, "equal": h == want}
        ok &= h == want
    res["animationsHash"]["sourceRule"] = "front rigs vs the refined rig/stock-front; back rigs vs the back source (parked)"
    p = load(RB / "back-turn15.params.json")
    back = {"view": p["view"], "headDx": p["headDx"], "farArm": p["farArm"], "centreLineShiftChest": p["centreLineShiftChest"],
            "footShear": p["footShear"], "backFeet": p["backFeet"]}
    back_ok = (p["view"] == "back" and abs(p["headDx"] + 6.3) <= 0.2 and p["farArm"] == sorted(ARM_R)
               and 15 <= p["centreLineShiftChest"] <= 20 and p["footShear"] > 0 and p["backFeet"] == "toe")
    res["backParams"] = {**back, "pass": back_ok}
    ok &= back_ok
    vals = validate_counts([R / f"{STOCK}.anim.json"] + [R / f"{c[1]}.anim.json" for c in LOCKED])
    stock = vals[str(R / f"{STOCK}.anim.json")]
    for t, rig, view, _ in LOCKED:
        v = vals[str(R / f"{rig}.anim.json")]
        n_tears = sum(len(x) for x in v["clipTears"].values())
        stress = v["errors"] - n_tears
        res["validate"][t] = {"errors": v["errors"], "warnings": v["warnings"], "summary": v["summary"],
                              "clipTears": n_tears, "clipTearIssues": v["clipTears"],
                              "stressErrors (not blocking)": stress, "stressBaseline (round 2c front L15)": STRESS_BASELINE,
                              "stressAtOrBelowBaseline": stress <= STRESS_BASELINE, "pass": n_tears == 0}
        ok &= n_tears == 0
    res["validateStockFront"] = {k: v for k, v in stock.items() if k != "clipTears"} | {"clipTears": sum(len(x) for x in stock["clipTears"].values())}
    res["parked"] = "04/05 (back) are parked: not validated here"
    res["pass"] = bool(ok)
    return res


def g3(render):
    res = {"pieces": {}}
    ok = True
    for rig in ("front-turn15-faceA", "front-turn15-faceA-mirin", "front-turn00-faceA"):
        f = load(R / f"{rig}.face.json")
        pieces = {p["piece"]: p["kx"] for p in f["pieces"]}
        far = pieces.get("eye-far")
        widen = max(pieces.values())
        dot = "dot" in f["combo"]["eyes"]
        lim = 1.03 if dot else 1.00
        p_ok = widen <= lim and (far is None or f["degrees"] == 0 or far < 1)
        res["pieces"][rig] = {"kx": pieces, "maxKx": widen, "limit": lim, "farEyeKx": far, "pass": p_ok}
        ok &= p_ok
    idle = render.get("g3IdleVsRound2", {})
    # refine P4: the fringe is clipped clear of the eyelids (REFINE-PLAN item 5), so the idle head now differs from
    # round 2 by design; recorded, not blocking. The eyes never widen: kx above; the face layers are not edited.
    res["idleVsRound2Front0 (informational since P4 fringe clear)"] = {**idle, "limitBeforeP4": "max <= 4/255 and mean <= 0.01"}
    fr = {rig: load(R / f"{rig}.face.json").get("fringeClear", {}) for rig in ("front-turn00-faceA", "front-turn15-faceA", "front-turn15-faceA-mirin")}
    res["fringeClear"] = {**fr, "pass": all(v.get("gapPx", 0) >= 3 for v in fr.values())}
    ok &= res["fringeClear"]["pass"]
    # refine P3: deterministic blink. Each blink face's projected eyes stay inside the open eyes' boxes (0 px growth),
    # every face rig carries both blink regions, and the idle has exactly one blink (half, closed, half, open) per loop.
    bl = {}
    for rig in ("front-turn00-faceA", "front-turn15-faceA", "front-turn15-faceA-mirin"):
        b = load(R / f"{rig}.face.json").get("blink", {})
        doc = load(R / f"{rig}.anim.json")
        # refine P7: the face is split into eyes / brows / nose / mouth slots; the blink swaps the eyes slot only
        skin = doc["skins"][next(iter(doc["skins"]))]["attachments"]
        atts = skin.get("eyes", {})
        sl = doc["animations"]["idle_weight_shift"].get("slots", {})
        keys = sl.get("eyes", {}).get("attachment", [])
        names = [k["name"] for k in keys]
        closes = sum(1 for i, n in enumerate(names) if n == "eyes_blink_closed" and (i == 0 or names[i - 1] != n))
        split = load(R / f"{rig}.face.json").get("faceParts (P7)", {})
        r_ok = (b.get("maxGrowthPx") == 0 and {"eyes_blink_half", "eyes_blink_closed"} <= set(atts)
                and closes == 1 and names[-1:] == ["eyes"] and set(sl) == {"eyes"} and "face" not in skin
                # no nose by default (owner 2026-10-19): a part left out of the combo has no slot and is not required
                and all(k in skin for k in ("eyes", "brows", "nose", "mouth", "hair")
                        if not (k == "nose" and load(R / f"{rig}.face.json")["combo"].get("nose") == "none"))
                and split.get("maxDiffVsBaked255", 99) <= 1)
        bl[rig] = {"maxGrowthPx": b.get("maxGrowthPx"), "regions": sorted(atts), "splitVsBaked255": split.get("maxDiffVsBaked255"), "idleKeys": keys, "blinksPerLoop": closes, "pass": r_ok}
        ok &= r_ok
    res["blink (P3)"] = bl
    res["pass"] = bool(ok)
    return res


def extents(alpha, thr=0.5):
    e = {}
    for y in np.where(alpha.max(axis=1) > thr)[0]:
        c = np.where(alpha[y] > thr)[0]
        e[int(y)] = (int(c[0]), int(c[-1]))
    return e


def g4():
    rig0, rig15 = RB / "back-turn00.anim.json", RB / "back-turn15.anim.json"
    *_, l0, i0 = tb.build(rig0, 0, "soldier-crop-hair", "drawn")
    *_, l15, i15 = tb.build(rig15, 15, "soldier-crop-hair", "drawn")
    *_, l15m, _ = tb.build(rig15, 15, "soldier-crop-hair", "drawn", mirror_inputs=True)
    si = i0["styleInfo"]
    axis = i0["axis"]
    res = {}
    # holes: the opaque mask equals its hole-filled self (0 and 15, and the mirrored-input 15)
    holes = {}
    for k, lay in (("0", l0), ("15", l15), ("15mirin", l15m)):
        m = lay[..., 3] > 0.5
        holes[k] = int((ndimage.binary_fill_holes(m) & ~m).sum())
    res["holes"] = {**holes, "pass": all(v == 0 for v in holes.values())}
    # nape skin (round 2, drawn hair): on the egg's lower half, the widest run of uncovered egg SKIN (the egg inset by
    # its outline) is at most the neck width (+2): only a neck-wide strip of skin shows
    rows_, _ = bd.head_geom(rig0)
    skin = bd.egg_fill(rows_, inset=bd.egg_ink(rows_))
    frames = load(bd.FINAL / "register.report.json")["hair"]
    nape = {k: bd.skin_strip_width(lay[..., 3], skin, rows_) for k, lay in (("0", l0), ("15", l15))}
    res["napeSkin"] = {**{f"widestSkinRunPx{k}": v for k, v in nape.items()}, "neckWidthPx": 2 * frames["neckHalf"],
                       "pass": all(v <= 2 * frames["neckHalf"] + 2 for v in nape.values())}
    # interior ink (round 1's generated fill only): the drawn hair separates its locks with ink by design
    if si.get("style") == "drawn":
        res["interiorInk"] = {"skipped": "drawn hair: locks are separated by ink (owner: like the front)", "pass": True}
    ink = {}
    for k, lay in (() if si.get("style") == "drawn" else (("0", l0), ("15", l15))):
        m = lay[..., 3] > 0.5
        d = ndimage.distance_transform_edt(m)
        yy = np.arange(lay.shape[0])[:, None]
        lum = lay[..., :3] @ LUM
        nape = si["napeRowAxis"]
        interior = m & (d > tb.SIL_KEEP * si["inkWidthPx"] + 3) & (yy > si["crownRow"] + tb.CROWN_FEATHER / 2) & (yy < nape - si["inkWidthPx"] - 3)
        ink[k] = {"interiorPx": int(interior.sum()), "inkPx": int((interior & (lum < tb.INK_LUM)).sum()), "minLum": round(float(lum[interior].min()), 3)}
    if si.get("style") != "drawn":
        res["interiorInk"] = {**ink, "pass": all(v["inkPx"] == 0 for v in ink.values())}
    # silhouette ends: on the SIDE rows (each side's raw row extent >= 60 % of that side's widest; the crown tip and the
    # nape arc are narrow caps whose ends are interior to the warp's dilated extents and legitimately turn with the
    # head) the 15 deg layer's row extents = the 0 deg layer's (+-1); the 0 deg layer = the mirrored front hair where the
    # hair is wider than the egg fill
    e0, e15 = extents(l0[..., 3]), extents(l15[..., 3])
    common = sorted(set(e0) & set(e15))
    wl = max(axis - e0[y][0] for y in common)
    wr = max(e0[y][1] + 1 - axis for y in common)
    side_l = [y for y in common if axis - e0[y][0] >= 0.6 * wl]
    side_r = [y for y in common if e0[y][1] + 1 - axis >= 0.6 * wr]
    dl = max(abs(e0[y][0] - e15[y][0]) for y in side_l)
    dr = max(abs(e0[y][1] - e15[y][1]) for y in side_r)
    cap_rows = [y for y in common if y not in side_l and y not in side_r]
    cap_move = max([max(abs(e0[y][0] - e15[y][0]), abs(e0[y][1] - e15[y][1])) for y in cap_rows] or [0])
    front = mirror(place_hair(Live(), "soldier-crop-hair"), axis)
    ef = extents(front[..., 3])
    dfront = [max(abs(ef[y][0] - e0[y][0]), abs(ef[y][1] - e0[y][1])) for y in ef if y in e0 and y < si["napeRowAxis"] - 60]
    res["silhouetteEnds"] = {"sideRowsL": len(side_l), "sideRowsR": len(side_r), "max15vs0L": dl, "max15vs0R": dr,
                             "capRows": len(cap_rows), "capRowsMaxMovePx (crown tip / nape arc)": cap_move,
                             "rowsMissing": len(set(e0) ^ set(e15)), "maxVsFrontHair": int(max(dfront)),
                             "pass": dl <= 1 and dr <= 1 and max(dfront) <= 1}
    # shift at the nape centre: a 2 px marker column on the axis (rows nape-60..nape-20) put through the same warp
    ny = int(round(si["napeRowAxis"]))
    ax = int(round(axis))
    probe = l0.copy()
    probe[ny - 60:ny - 20, ax - 1:ax + 1, :3] = [1.0, 0.0, 0.0]
    probe[ny - 60:ny - 20, ax - 1:ax + 1, 3] = 1.0
    warped = tb.back_warp(probe, axis, i15["hairShiftPx"], i15["alpha"], "2c", i15["eggHalfWidth"])
    red = (warped[..., 0] > 0.6) & (warped[..., 1] < 0.3) & (warped[..., 2] < 0.3)
    best = round(float(np.where(red)[1].mean() + 0.5 - axis), 2)
    want = i15["hairShiftPx"]
    res["shift"] = {"measuredPx": best, "method": "axis marker column through back_warp", "expectedPx": want,
                    "expectedRule": "R sin 15, R = egg half-width at the nape centre row", "frontFringeShiftPx": load(R / "front-turn15-faceA.face.json")["hairShiftPx"],
                    "pass": bool(abs(best - want) <= 2)}
    # far (screen-right) quarter darker at 15 than at 0 (same rows, each layer's own extent)
    def quarter(lay, side):
        lum = lay[..., :3] @ LUM
        vals = []
        for y, (x0, x1) in extents(lay[..., 3]).items():
            if not (si["crownRow"] < y < si["napeRowAxis"] - 20):
                continue
            q = (x1 - x0) // 4
            sl = slice(x1 - q, x1) if side == "R" else slice(x0, x0 + q)
            a = lay[y, sl, 3] > 0.9
            vals.extend(lum[y, sl][a].tolist())
        return float(np.mean(vals))
    r0, r15, l15q, l0q = quarter(l0, "R"), quarter(l15, "R"), quarter(l15, "L"), quarter(l0, "L")
    res["farQuarter"] = {"right0": round(r0, 4), "right15": round(r15, 4), "ratio": round(r15 / r0, 4), "left0": round(l0q, 4), "left15": round(l15q, 4),
                         "pass": r15 / r0 < 0.99}
    res["pass"] = all(v["pass"] for v in res.values() if isinstance(v, dict))
    return res, (l0, front, axis)


def g5():
    th = math.radians(15)
    seam = {"chest": round(cyl(0, -th, W_CHEST, D_CHEST), 2), "hips": round(cyl(0, -th, W_HIPS, D_HIPS), 2)}
    seam_ok = all(15 <= v <= 20 for v in seam.values())
    # wrist: the far forearm texels at the wrist (setup x of hand_r, far side) vs the far fist (whole-region factor)
    d15 = load(RB / "back-turn15.anim.json")
    p = load(RB / "back-turn15.params.json")
    alpha = p["alpha"]
    w0 = setup_world(load(RB / "stock-back.anim.json")["bones"])
    xh = w0["hand_r"][0, 2]
    f_arm = far_shade(-xh, W_CHEST, alpha)
    f_fist = 1 - alpha * 0.9
    step = abs(f_fist / f_arm - 1)
    # feet: setup world x of every below-ankle foot vertex, 15 vs 0 (minus the leg's own move): > 0 = screen-right
    def foot_dx(rig15):
        d0 = load(RB / "back-turn00.anim.json")
        d1 = load(rig15)
        wa, wb = setup_world(d0["bones"]), setup_world(d1["bones"])
        dx = []
        for slot in ("hips", "shorts"):
            for name, a0 in d0["skins"]["body"]["attachments"].get(slot, {}).items():
                a1 = d1["skins"]["body"]["attachments"][slot][name]
                if a0["type"] != "mesh" or "bones" not in a0:
                    continue
                x0, x1 = mesh_world_x(a0, wa), mesh_world_x(a1, wb)
                # vertex y and dominant bone, from the source
                v, i, k = a0["vertices"], 0, 0
                while i < len(v):
                    n = int(v[i])
                    i += 1
                    best = max(range(n), key=lambda j: v[i + 4 * j + 3])
                    bn = a0["bones"][int(v[i + 4 * best])]
                    y = sum(v[i + 4 * j + 3] * (wa[a0["bones"][int(v[i + 4 * j])]] @ np.array([v[i + 4 * j + 1], v[i + 4 * j + 2], 1]))[1] for j in range(n))
                    if bn in ("foot_l", "foot_r") and y > wa[bn][1, 2] + 20:
                        move = 2.59 * (1 if bn == "foot_l" else -1)  # thigh_l / thigh_r x cos 15 - x (params moves)
                        dx.append(x1[k] - x0[k] - move)
                    i += 4 * n
                    k += 1
        return round(float(np.mean(dx)), 2), len(dx)
    heel, n = foot_dx(RB / "feet" / "back-heel-turn15.anim.json")
    toe, _ = foot_dx(RB / "back-turn15.anim.json")
    drawn = load(RB / "stock-back-drawn.report.json")
    res = {"seam": {**seam, "pass": seam_ok}, "wrist": {"armFactor": round(f_arm, 4), "fistFactor": round(f_fist, 4), "step": round(step, 4), "pass": step <= 0.04},
           "feet": {"heelMeanDxPx": heel, "toeMeanDxPx (clips)": toe, "vertices": n, "footShear": p["footShear"], "pass": heel > 0 and toe < 0},
           "drawnBody (stock-back-drawn.report.json)": {**drawn["gates"], "silhouetteXorPx": drawn["silhouetteXorPx"], "neckline": drawn["neckline"],
                                                        "pass": all(drawn["gates"].values())}}
    res["pass"] = all(v["pass"] for v in res.values())
    return res


def g6(render, back0, front, axis):
    """Handedness in head space: the crown band of each clip's pre-turn hair, in its final (possibly flipped)
    orientation, mirrored once more for the back views (seen from behind), correlates better with the front hair than
    with its mirror (+1) or not (-1)."""
    live = Live()
    fh = place_hair(live, "soldier-crop-hair")
    band = slice(110, 330)

    def score(lay):
        a, f = lay[band, :, :3] @ LUM * lay[band, :, 3], fh[band, :, :3] @ LUM * fh[band, :, 3]
        fm = mirror(fh, axis)
        m = fm[band, :, :3] @ LUM * fm[band, :, 3]
        c1 = float(np.corrcoef(a.ravel(), f.ravel())[0, 1])
        c2 = float(np.corrcoef(a.ravel(), m.ravel())[0, 1])
        return (1 if c1 > c2 else -1), round(c1, 3), round(c2, 3)
    signs = {}
    for t, rig, view, flipped in CLIPS:
        mirin = rig.endswith("mirin")
        if view == "front":
            lay = mirror(fh, axis) if mirin else fh
        else:
            lay = mirror(back0, axis) if mirin else back0
        if flipped:
            lay = mirror(lay, axis)
        if view == "back":
            lay = mirror(lay, axis)  # seen from behind -> head space
        s, c1, c2 = score(lay)
        signs[t] = {"sign": s, "corrFront": c1, "corrMirror": c2}
    flips = {k: v for k, v in render.get("g6", {}).items()}
    ok = len({v["sign"] for v in signs.values()}) == 1 and all(flips.values()) and len(flips) == 2 * render.get("flippedClips", 2)
    return {"handedness": signs, "flipFlip": flips, "pass": bool(ok)}


BG_RGB = np.array([0x1e, 0x24, 0x30])
G10_MAX_ROWS = 4  # the P5 crack scored 6 (L15 f7-f9, near arm); a narrow open V under the tucked far arm scores up to 4


def sliver_rows(im: np.ndarray, y0: int, y1: int, x0: int, x1: int, tol: int = 40) -> int:
    """Refine P6 (G10, owner 2026-10-19: "some detachment here"): the longest vertical run of rows in which a background
    run at most 2 px wide sits between two non-background pixels (the crack where an outswung arm's inner outline and
    the tank flank part) inside the armpit band. The open V below a hanging arm widens at >= 1 px a row and so
    scores 1-3 rows; a crack running up between the two outlines scores more."""
    bg = np.abs(im[..., :3].astype(int) - BG_RGB).sum(-1) <= tol
    best, run, prev = 0, 0, None
    for y in range(y0, y1):
        xs = []
        x = x0
        while x < x1:
            if not bg[y, x]:
                x += 1
                continue
            s = x
            while x < x1 and bg[y, x]:
                x += 1
            if x - s <= 2 and s > x0 and x < x1 and not bg[y, s - 1] and not bg[y, x]:
                xs.append(s)
        hit = next((v for v in xs if prev is None or abs(v - prev) <= 2), None) if xs else None
        if hit is not None and (prev is None or run == 0 or abs(hit - prev) <= 2):
            run, prev = run + 1, hit
        else:
            run, prev = (1, xs[0]) if xs else (0, None)
        best = max(best, run)
    return best


def g10():
    """No background gap between arm and torso: every frame of 01-03 rendered at 0.4712 (scripts/views/dump-frames.ts),
    both armpits (band 0.471 rows 440-505, x 55-115 and 185-245 of the 303 px frame) score <= G10_MAX_ROWS."""
    from PIL import Image
    import tempfile
    # --set jacketb: the jacket navy (|rgb - bg| ~ 31) would pass for background at the stock tolerance 40, so the set
    # uses 6 (the evidence script's background test); J2 repeats the scan on key-coloured renders
    tol = 6 if SET == "jacketb" else 40
    out = {"maxRows": G10_MAX_ROWS, "bgTolerance": tol}
    for tag, rig, clip, n in (("01-idle-front", "front-turn00-faceA", "idle_weight_shift", 96),
                              ("02-walk-downright-frontR15", "front-turn15-faceA-mirin", "walk_in_place", 28),
                              ("03-walk-downleft-frontL15", "front-turn15-faceA", "walk_in_place", 28)):
        with tempfile.TemporaryDirectory() as td:
            subprocess.run(["npx", "tsx", "scripts/views/dump-frames.ts", str(R / f"{rig}.anim.json"), clip, str(n), td],
                           check=True, shell=sys.platform == "win32")
            rows = []
            for i in range(n):
                im = np.asarray(Image.open(Path(td) / f"f{i:03d}.png").convert("RGB"))
                rows.append([sliver_rows(im, 440, 505, 55, 115, tol), sliver_rows(im, 440, 505, 185, 245, tol)])
        worst = max(max(r) for r in rows)
        out[tag] = {"worstRows": worst, "worstFrame": int(np.argmax([max(r) for r in rows])), "pass": worst <= G10_MAX_ROWS}
    out["pass"] = all(v["pass"] for v in out.values() if isinstance(v, dict))
    return out


def g11():
    """Refine P6 (owner 2026-10-19): on the turned face rigs each eye's outer-corner gap to the head silhouette is
    >= EYE_CLEAR_MIN x its straight-front gap (measured by turnfront_face.edge_clearance, recorded in face.json)."""
    from turnfront_face import EYE_CLEAR_MIN
    out = {"min": EYE_CLEAR_MIN}
    for stem in ("front-turn15-faceA", "front-turn15-faceA-mirin"):
        f = load(R / f"{stem}.face.json")
        eyes = {p["piece"]: p.get("clearance") for p in f["pieces"] if p["piece"].startswith("eye-")}
        out[stem] = {"eyeWidth": f.get("eyeWidth (P6)"), "eyes": eyes,
                     "pass": all(c is not None and c["ratio"] is not None and c["ratio"] >= EYE_CLEAR_MIN for c in eyes.values())}
    out["pass"] = all(v["pass"] for v in out.values() if isinstance(v, dict))
    return out


def main():
    render = load(OUT / "gates-render.json")
    gates = {}
    gates["G1 rig integrity"] = g1()
    gates["G2 framing"] = {**render["g2"], "pass": all(v["pass"] for v in render["g2"].values())}
    gates["G3 face"] = g3(render)
    g4r, (back0, front, axis) = g4()
    gates["G4 back hair"] = g4r
    gates["G5 back body"] = g5()
    gates["G6 mirror and handedness"] = g6(render, back0, front, axis)
    gates["G7 loops"] = {**render["g7"], "pass": all(v["pass"] for v in render["g7"].values())}
    gates["G8 no swim"] = {**render["g8"], "pass": all(v["pass"] for v in render["g8"].values())}
    gates["G9 enclosed holes (body blocking; head = REFINE-PLAN item 6, P4)"] = {**render["g9"], "pass": all(v["pass"] for v in render["g9"].values())}
    gates["G10 no arm-to-torso gap (all frames, 0.471)"] = g10()
    gates["G11 turned eye edge clearance"] = g11()
    if SET == "jacketb":
        import five_anims_jacketb_gates as jg
        gates.update(jg.gates(R, STOCK))
    gates["motion table @0.471 (head top, lowest row, hand-slot centroids per frame)"] = render.get("motion0471", {})
    gates["gifBytes"] = {k: v for k, v in render.items() if "GifBytes" in k}
    gates["summary"] = {k: v["pass"] for k, v in gates.items() if isinstance(v, dict) and "pass" in v}
    (OUT / "gates.json").write_text(json.dumps(gates, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o)), encoding="utf-8")
    print(json.dumps(gates["summary"], indent=1))


if __name__ == "__main__":
    main()
