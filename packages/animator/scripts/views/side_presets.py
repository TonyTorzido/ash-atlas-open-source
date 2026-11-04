# Atlas Animator multi-view, phase 2b (docs/plans/atlas-animator-views.md): the TURNED-SIDE full-body presets.
#   python side_presets.py
# Writes fixtures/canonical/body-side/*.json (data only) from the front full-body test parts and landmarks measured
# on the approved side art (ART_DROPS/views-body-side/body-side.png, copied next to the presets):
#   near arm  = the front arm-layer part (template7-fullbody-test-arm), screen-right chain `_r`, placed by a rigid
#               motion (rotation about its shoulder + translation, no scale, no reflection) onto the side shoulder
#               and wrist direction; it carries the side torso sheet traced from the side art;
#   far arm   = the front far-arm test part, `_l`, placed the same way; its upper arm is hidden under the torso at
#               rest and keeps the built material there (the painter's hidden-material completion);
#   legs      = the front leg part placed twice (near `_r`, far `_l`), no garments (the shorts are painted on the
#               torso sheet from the art);
#   setup     = one shared skeleton (pelvis, chest, neck, head) measured on the side art.
# Every number below is a canvas pixel read on the side art (1086x1448 rig canvas); nothing else is hand placed.
import json
import math
import shutil
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parents[2]
CANON = HERE / "fixtures/canonical"
OUT = CANON / "body-side"
ART = Path("C:/Users/dev/Documents/art-drops/views-body-side/body-side.png")

# shared skeleton (side setup pose)
PELVIS = ([545, 960], [545, 1010])
CHEST = ([545, 960], [562, 660])
NECK = ([564, 700], [564, 650])
HEAD = ([564, 650], [564, 400])
# arms: shoulder joint and the wrist direction (lengths stay the front's)
# (shoulder / wrist rows read on the art; x on each traced limb's medial line, filled in main())
NEAR_ARM = {"clavicle": [578, 705], "rows": (732, 925), "fit": (760, 900)}
FAR_ARM = {"clavicle": [520, 705], "rows": (738, 872), "fit": (790, 860)}
# fists: art crop [x, y, w, h] and the keep polygon (the fist without the wrist)
NEAR_FIST = {"crop": [594, 912, 132, 102], "keep": [[594, 935], [612, 922], [640, 916], [700, 916], [726, 935], [726, 1014], [594, 1014]]}
FAR_FIST = {"crop": [366, 856, 100, 112], "keep": [[366, 868], [400, 856], [440, 860], [456, 872], [466, 968], [366, 968]]}
# legs: hip joint and the ankle direction (lengths stay the front's)
NEAR_LEG = {"rows": (1005, 1176), "fit": (1060, 1170)}
FAR_LEG = {"rows": (975, 1132), "fit": (1040, 1130)}
# the full torso sheet (neck to hips, shorts included: the art paints the tank and the shorts on it), clockwise from
# the neck's top left; the right edge under the near arm follows the tank's hidden flank down to the shorts
TORSO = [{"at": [514, 636], "corner": True}, [514, 676], [500, 688], [484, 702], [474, 724], [470, 760], [470, 800], [472, 840],
         [468, 880], [460, 912], [450, 950], [442, 990], {"at": [438, 1012], "corner": True}, [470, 1026], [510, 1034], [550, 1038],
         [600, 1036], {"at": [650, 1030], "corner": True}, [648, 990], [636, 950], [626, 900], [620, 850], [616, 800], [618, 750],
         [622, 710], [618, 690], {"at": [614, 678], "corner": True}, {"at": [614, 636], "corner": True}]
TORSO_OUTLINE = ([514, 641], [614, 641])  # from the far neck side's top round the torso to the near neck side's top
FIST_EDGE = 3  # px of the fist outline's anti-aliased edge below the fist crop
GARMENT_SAT = 30  # max - min RGB below this is garment (tank / shorts / trim), not skin or the brown outline
SIL_SIGN = -1  # traced limb silhouettes run in this orientation (signed shoelace area on the canvas)

# Traced shapes (phase 2b step 2): every part's silhouette is traced from its preservation-first layer
# (layers/<part>.full.png, scripts/views/side_layers.py: visible pixels + hidden completion), not copied from the front.
LAYERS = OUT / "layers"
INSET = 4  # the hull runs on the art line's centre: the art's outline is ~8-9 px wide at the alpha edge
SMOOTH = 5  # px: closing then opening radius on the mask (completion discs leave lumps on hidden edges)
SPACING = 6  # px between traced silhouette points (the presets' own spacing)
CAP_INSET = 12  # px: the torso's edge under the near arm's cap stays this far inside the arm's outer edge
CAP_BAND_BOTTOM = 760  # canvas row: the cap band ends above the near armpit (the arm's top rows start at ~732)
NECK_GAP = 0  # px: the cap's dome reaches up to the shoulder line this far right of the neck's near edge
STEEP_ENTRY = 9  # px: where the torso edge enters under the near arm's cap no hull point lies between depth 0 and this
CORNER_TURN = 55  # degrees: a traced point turning more than this is a corner (the neck's cut top)
# side-view joint limits (the elbow folds one way: forward = screen -x, the toes' side = positive elbow in this frame;
# the far arm swings within the range that keeps its hidden root under the torso join)
NEAR_ARM_LIMITS = {"upper_arm": [-70, 105], "forearm": [0, 70]}
FAR_ARM_LIMITS = {"upper_arm": [-35, 40], "forearm": [0, 70]}
# the far shoulder's root (phase 2b session 5): the far arm's upper-arm joint sits DEPTH px inside the torso's far flank
# on the shoulder row (the art's far shoulder bulge is drawn at the flank, so the joint read on the limb's medial line
# lies outside the torso), and the far arm's hidden material continues under the torso as a disc of RADIUS px round
# that joint, kept HIDDEN px inside the torso's mask (it never shows at rest): the root vertices are buried with margin
# and a swing turns them about a joint deep inside the body
FAR_ROOT = {"depth": 72, "radius": 40, "hidden": 8}


def tank_strip():
    """Garment fill the watershed gave to the far arm: along the far flank (rows ~730-800) the art's far arm is wholly
    behind the torso, the outline there is the torso's own and the pixels inside it are the tank's (unsaturated, light),
    but the far-arm layer owns them. They belong to the torso (the torso's hull reaches the art's flank line, so the far
    arm owns no tank texel at rest and a swing never carries a strip of tank): the far arm's tank-coloured pixels
    connected to the torso, plus the outline ink beside them (within the line width, not beside the arm's skin)."""
    art = cv2.imread(str(OUT / "body-side.png"), cv2.IMREAD_UNCHANGED)
    rgb = art[..., 2::-1].astype(int)
    lum = 0.3 * rgb[..., 0] + 0.59 * rgb[..., 1] + 0.11 * rgb[..., 2]
    sat = rgb.max(axis=2) - rgb.min(axis=2)
    opaque = art[..., 3] >= 250
    arm = cv2.imread(str(LAYERS / "far_arm.full.png"), cv2.IMREAD_GRAYSCALE) >= 128
    torso = cv2.imread(str(LAYERS / "torso.full.png"), cv2.IMREAD_GRAYSCALE) >= 128
    cloth = arm & opaque & (lum >= 200) & (sat < 28)
    n, lab = cv2.connectedComponents(cloth.astype(np.uint8))
    touch = cv2.dilate(torso.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    keep = np.isin(lab, [k for k in range(1, n) if (touch & (lab == k)).any()])
    skin = arm & opaque & (lum >= 120) & (sat >= 40)
    ink = opaque & (lum < 90)
    near = lambda m, r: cv2.dilate(m.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))) > 0
    line = ink & near(keep, 12) & ~near(skin, 4)
    return keep | line


def full_mask(part, neck=True):
    """The part's whole shape (layers/<part>.full.png); the torso with the far flank's tank strip, the far arm with
    its hidden root under the torso."""
    m = (cv2.imread(str(LAYERS / f"{part}.full.png"), cv2.IMREAD_GRAYSCALE) >= 128).astype(np.uint8)
    if part == "torso":
        m = m | tank_strip().astype(np.uint8)
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k)
        h, w = m.shape
        ff = m.copy()
        cv2.floodFill(ff, np.zeros((h + 2, w + 2), np.uint8), (0, 0), 1)
        m = m | (1 - ff)
        # Under the near arm's cap the torso stops CAP_INSET px inside the arm's outer (background-facing) edge: the
        # traced torso reached the arm's outer outline there, so its stroke ran beside the arm's cap stroke (a doubled,
        # notched shoulder line) and its hull vertices sat ~1 px inside the arm (a raise with a shrug exposed them:
        # cap coverage). The shoulder's outer line above the armpit is the arm's own; the torso is the material under it.
        arm = full_mask("near_arm", neck=False) > 0
        bg = (cv2.imread(str(OUT / "body-side.png"), cv2.IMREAD_UNCHANGED)[..., 3] < 128) & ~(m > 0) & ~arm
        near_bg = cv2.distanceTransform((~bg).astype(np.uint8), cv2.DIST_L2, 5) < CAP_INSET
        band = arm & near_bg & (m > 0)
        band[CAP_BAND_BOTTOM:] = False
        m = (m & ~band.astype(np.uint8)).astype(np.uint8)
    if part in ("near_arm", "far_arm"):
        # An arm ends at its fist: the hidden completion ran on under the shorts below the fist art (the far arm's
        # tongue to row ~995), flat unlined skin that showed as a jagged edge and a hairline tear once the arm moved.
        m[arm_bottom(part) + 1:] = 0
    if part == "near_arm":
        # The cap's top is one dome: the layer split left a spur at the cap top (a notch in the hull and a pointed apex
        # under the stroke) and the arm's edge ran along the trim's lower edge. Above the armpit the arm is the convex
        # hull of its own top rows, inside the figure (the rest bake paints whatever the arm covers from the art).
        fig = cv2.imread(str(OUT / "body-side.png"), cv2.IMREAD_UNCHANGED)[..., 3] >= 128
        # The dome rises to the shoulder's outer line next to the neck: the layer's top starts ~10 px below that line
        # (the layer split gave the line's first stretch to the torso), so the dome's stroke met the torso's neck stroke
        # in a dip. The figure right of the neck's near edge (NECK_GAP px clear of it) above the band joins the cap.
        neck_x = int(np.nonzero(fig[NECK_FIXED_BOTTOM - 10])[0].max())
        rows, cols = np.indices(m.shape)
        m = m | neck * (fig & (cols > neck_x + NECK_GAP) & (rows >= NECK_FIXED_BOTTOM - 10) & (rows < CAP_BAND_BOTTOM)).astype(np.uint8)
        top = m.copy()
        top[CAP_BAND_BOTTOM:] = 0
        pts = cv2.findNonZero(top)
        if pts is not None:
            dome = np.zeros_like(m)
            cv2.fillConvexPoly(dome, cv2.convexHull(pts), 1)
            dome[CAP_BAND_BOTTOM:] = 0
            m = m | (dome & fig.astype(np.uint8))
    if part == "far_arm" and "pivot" in FAR_ROOT:
        torso = full_mask("torso")
        k = FAR_ROOT["hidden"]
        inner = cv2.erode(torso, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1)))
        disc = np.zeros_like(m)
        cv2.circle(disc, tuple(int(round(v)) for v in FAR_ROOT["pivot"]), FAR_ROOT["radius"], 1, -1)
        m = m | (disc & inner)
    return m


def far_root_pivot():
    """The far upper-arm joint: DEPTH px inside the torso mask's far (screen-left) edge on the shoulder row."""
    y = int(round(FAR_ARM["shoulder"][1]))
    torso = full_mask("torso") > 0
    return [float(np.nonzero(torso[y])[0].min() + FAR_ROOT["depth"]), float(y)]


def move_root(d, suffix, pivot):
    """Moves the chain's root joint (upper arm) to `pivot`, the elbow and everything below it staying put: the upper
    arm lengthens by delta and every chain-length coordinate s past the root shifts by delta (rows, joints, patches,
    cores, groups, contour rows), so each still names the same place on the limb."""
    up = next(b for b in d["bones"] if b["name"] == f"upper_arm{suffix}")
    cl = next(b for b in d["bones"] if b["name"] == f"clavicle{suffix}")
    old = math.dist(up["at"], up["toward"])
    up["at"] = [round(pivot[0], 2), round(pivot[1], 2)]
    cl["toward"] = list(up["at"])
    d["girdle"]["center"] = list(up["at"])
    delta = math.dist(up["at"], up["toward"]) - old
    sh = lambda v: round(v + delta, 2) if v > 0 else v
    t = d["skin"]["topology"]
    t["to"] = sh(t["to"])
    for j in t["joints"]:
        j["s"] = sh(j["s"])
    t["extraRows"] = [sh(v) for v in t.get("extraRows", [])]
    rg = d["skin"]["regions"]
    for pt in rg.get("patches", []):
        pt["s"] = sh(pt["s"])
        if "push" in pt:
            pt["push"]["s"] = [sh(v) for v in pt["push"]["s"]]
    for c in rg.get("cores", []):
        c["sMin"], c["sMax"] = sh(c["sMin"]), sh(c["sMax"])
    for g in d["skin"].get("groups", []):
        if "s" in g:
            g["s"] = [sh(g["s"][0]), g["s"][1]]
    for c in d["skin"]["contours"]:
        for k in ("from", "to"):
            if isinstance(c[k], dict) and "row" in c[k]:
                c[k]["row"] = sh(c[k]["row"])
    return delta


def trace(part, inset=INSET):
    m = full_mask(part)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * SMOOTH + 1, 2 * SMOOTH + 1))
    m = cv2.morphologyEx(cv2.morphologyEx(m, cv2.MORPH_CLOSE, k), cv2.MORPH_OPEN, k)
    m = cv2.erode(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * inset + 1, 2 * inset + 1)))
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cs, key=cv2.contourArea)[:, 0, :].astype(float)
    # resample at SPACING along the boundary (light smoothing of the pixel staircase first)
    n = len(c)
    sm = np.array([c[[(i + j) % n for j in range(-3, 4)]].mean(axis=0) for i in range(n)])
    seg = np.r_[0, np.cumsum(np.hypot(*np.diff(np.vstack([sm, sm[:1]]), axis=0).T))]
    total = seg[-1]
    out = []
    for t in np.arange(0, total, total / max(8, round(total / SPACING))):
        i = int(np.searchsorted(seg, t, side="right") - 1)
        a, b = sm[i], sm[(i + 1) % n]
        f = (t - seg[i]) / max(1e-9, seg[i + 1] - seg[i])
        out.append([round(float(a[0] + f * (b[0] - a[0])), 1), round(float(a[1] + f * (b[1] - a[1])), 1)])
    return out


def axis(part, y0, y1):
    """The limb's medial line x = a*y + b, fitted to the midpoints of its traced mask's rows y0..y1."""
    m = cv2.imread(str(LAYERS / f"{part}.full.png"), cv2.IMREAD_GRAYSCALE) >= 128
    ys, xs = [], []
    for y in range(y0, y1):
        r = np.nonzero(m[y])[0]
        if len(r):
            ys.append(y)
            xs.append((r.min() + r.max()) / 2)
    a, b = np.polyfit(ys, xs, 1)
    return lambda y: [round(float(a * y + b), 1), float(y)]


def half_width(d, part):
    """Largest distance from the chain to the part's inset hull, plus margin: topology rows must reach the hull."""
    sil = np.array(trace(part))
    ch = [np.array(b["at"]) for b in d["bones"] if b["name"] in d["chain"]["bones"]]
    tip = np.array(next(b["toward"] for b in d["bones"] if b["name"] == d["chain"]["bones"][-1]))
    pts = ch + [tip]
    best = 0.0
    for p in sil:
        dmin = 1e9
        for a, b in zip(pts, pts[1:]):
            t = np.clip(np.dot(p - a, b - a) / np.dot(b - a, b - a), 0, 1)
            dmin = min(dmin, float(np.linalg.norm(p - (a + t * (b - a)))))
        best = max(best, dmin)
    return math.ceil(best) + 6


def snap_apexes(d, sil):
    """Topology apexes (armpit, groin) move to the nearest traced point, which becomes a silhouette corner."""
    out = list(sil)
    for ap in d["skin"]["topology"].get("apexes", []):
        i = min(range(len(sil)), key=lambda k: (sil[k][0] - ap["at"][0]) ** 2 + (sil[k][1] - ap["at"][1]) ** 2)
        ap["at"] = list(sil[i])
        out[i] = {"at": list(sil[i]), "corner": True}
    return out


def with_corners(pts):
    res = []
    n = len(pts)
    for i, p in enumerate(pts):
        a, b = np.subtract(p, pts[i - 1]), np.subtract(pts[(i + 1) % n], p)
        turn = abs(math.degrees(math.atan2(a[0] * b[1] - a[1] * b[0], a @ b)))
        res.append({"at": p, "corner": True} if turn > CORNER_TURN else p)
    return res


def area(pts):
    return 0.5 * sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(pts, pts[1:] + pts[:1]))


def orient(pts, sign):
    return pts if (area(pts) > 0) == (sign > 0) else pts[::-1]


def snap(p, pts):
    return list(min(pts, key=lambda q: (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2))


def snap_ends(o, pts):
    """Contour ends and junctions given as canvas points move onto the nearest traced silhouette point."""
    if isinstance(o, dict):
        return {k: (snap(v, pts) if k in ("from", "to", "at") and isinstance(v, list) and len(v) == 2 and all(isinstance(x, (int, float)) for x in v) else snap_ends(v, pts)) for k, v in o.items()}
    if isinstance(o, list):
        return [snap_ends(x, pts) for x in o]
    return o


POINT_KEYS = {"at", "toward", "center", "from", "to", "a", "b"}
LIST_KEYS = {"polygon", "keep", "silhouette", "path"}


def rigid(p0, q0, q_dir, p_dir):
    """Rotation about p0 taking direction p_dir to direction q_dir, then translation p0 -> q0."""
    a = math.atan2(p_dir[1] - p0[1], p_dir[0] - p0[0])
    b = math.atan2(q_dir[1] - q0[1], q_dir[0] - q0[0])
    th = b - a
    c, s = math.cos(th), math.sin(th)

    def f(p):
        x, y = p[0] - p0[0], p[1] - p0[1]
        return [round(q0[0] + c * x - s * y, 2), round(q0[1] + s * x + c * y, 2)]
    return f, math.degrees(th)


def walk(o, f, deg, key=None):
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            if k in ("poseLimits", "sweeps", "correctives", "grids", "limits"):  # angle space, not canvas
                out[k] = v
            elif k == "arc" and isinstance(v, dict):
                out[k] = {**v, "center": f(v["center"]) if "center" in v else v.get("center"), "from": round(v["from"] + deg, 2), "to": round(v["to"] + deg, 2)}
                if "center" not in v:
                    del out[k]["center"]
            elif k in POINT_KEYS and isinstance(v, list) and len(v) == 2 and all(isinstance(x, (int, float)) for x in v):
                out[k] = f(v)
            elif k in LIST_KEYS and isinstance(v, list):
                out[k] = [f(q) if isinstance(q, list) else walk(q, f, deg) for q in v]
            elif k == "frame":
                pts = [f([v["left"], v["top"]]), f([v["right"], v["top"]]), f([v["left"], v["bottom"]]), f([v["right"], v["bottom"]])]
                out[k] = {"left": min(p[0] for p in pts), "top": min(p[1] for p in pts), "right": max(p[0] for p in pts), "bottom": max(p[1] for p in pts)}
            else:
                out[k] = walk(v, f, deg, k)
        return out
    if isinstance(o, list):
        return [walk(x, f, deg) for x in o]
    return o


def rename(o, names):
    if isinstance(o, dict):
        return {names.get(k, k): rename(v, names) for k, v in o.items()}
    if isinstance(o, list):
        return [rename(x, names) for x in o]
    if isinstance(o, str):
        if o in names:
            return names[o]
        if "/" in o and o.split("/")[0] in names:
            return names[o.split("/")[0]] + "/" + o.split("/", 1)[1]
    return o


def shared(bones):
    fix = {"pelvis": PELVIS, "chest": CHEST, "neck": NECK, "head": HEAD}
    for b in bones:
        if b["name"] in fix:
            b["at"], b["toward"] = list(fix[b["name"]][0]), list(fix[b["name"]][1])
    return bones


def side_limits(d, suffix, lim):
    """Side-view joint limits on the arm chain; sweeps, correctives and front-only pose polygons follow them."""
    for b in d["bones"]:
        for k, v in lim.items():
            if b["name"] == f"{k}{suffix}":
                b["limits"] = list(v)
    rng = {f"{k}{suffix}": v for k, v in lim.items()}
    for sw in d.get("sweeps", []):
        for ph in sw["phases"]:
            if ph["bone"] in rng:
                lo, hi = rng[ph["bone"]]
                ph["from"], ph["to"] = (min(hi, max(lo, ph["from"])), min(hi, max(lo, ph["to"])))
        for b, v in list(sw.get("hold", {}).items()):
            if b in rng:
                sw["hold"][b] = min(rng[b][1], max(rng[b][0], v))
    d["sweeps"] = [sw for sw in d.get("sweeps", []) if all(ph["from"] != ph["to"] for ph in sw["phases"])]
    for c in d.get("correctives", []):
        if c["bone"] in rng and "at" in c:
            lo, hi = rng[c["bone"]]
            c["at"] = sorted({min(hi, max(lo, a)) for a in c["at"]})
    # the front's "elbow never outward" polygon is a front-view rule (the side elbow folds forward only, by limits)
    d["poseLimits"] = [p for p in d.get("poseLimits", []) if "polygon" not in p]
    if "assembly" in d:
        d["assembly"]["poses"] = [q for q in d["assembly"]["poses"] if all(rng.get(b, [-1e9, 1e9])[0] <= a <= rng.get(b, [-1e9, 1e9])[1] for b, a in q["pose"].items())]


def arm(src, suffix_from, suffix, slots, land, fist, texture, name, carrier, layer, limits):
    d = json.loads((CANON / src).read_text())
    bone = lambda n: next(b for b in d["bones"] if b["name"] == n)
    up = bone(f"upper_arm{suffix_from}")
    f, deg = rigid(up["at"], land["shoulder"], land["wrist_dir"], bone(f"hand{suffix_from}")["at"])
    names = {n: n[: -len(suffix_from)] + suffix for n in [b["name"] for b in d["bones"]] if n.endswith(suffix_from)}
    for c in d.get("correctives", []):
        names[c["name"]] = c["name"][: -len(suffix_from)] + suffix
    names.update(slots)
    clav = bone(f"clavicle{suffix_from}")
    front_head = next((r for r in d.get("regions", []) if r["name"] == "head"), None)
    front_head_at = list(bone("head")["at"])
    d = walk(d, f, deg)
    d = rename(d, names)
    d["name"], d["description"] = name, f"Turned-side {('near' if carrier else 'far')} arm (phase 2b), generated by scripts/views/side_presets.py from {src}."
    cb = next(b for b in d["bones"] if b["name"] == f"clavicle{suffix}")
    cb["at"], cb["toward"] = f(clav["at"]), f(clav["toward"])  # rigid with the arm: the local rest angles (limits, pose polygons) stay the front's
    d["girdle"]["center"] = f(clav["toward"])
    d["bones"] = shared(d["bones"])
    d["skin"]["texture"] = texture
    d["regions"] = [{"name": "fist", "slot": slots.get("hand", f"hand{suffix}") if "hand" in slots else names.get("hand_b", f"hand{suffix}"), "bone": f"hand{suffix}", "texture": f"{texture}-fist", "image": "body-side.png", "crop": fist["crop"], "keep": fist["keep"]}]
    if carrier and front_head:
        # the shared head (phase 2b session 7 decision): the front head stands in as a real head region of the side
        # rig, attached the way the front body attaches it (a region of the torso carrier on the head bone, drawn last),
        # at the same bone-local placement; it covers the neck's cut top in every gate and build until a turned head exists
        d["regions"].append(shared_head(front_head, front_head_at))
    else:
        d["drawOrder"] = [s for s in d["drawOrder"] if s != "head"]
    d["poseLimits"] = [p for p in d.get("poseLimits", []) if "head" not in json.dumps(p.get("auto", {}).get("collide", []))]
    sk = d["skin"].get("regions", {})
    for bnd in sk.get("bends", []):
        bnd["a"], bnd["b"] = ([545, 900], [545, 1000]) if bnd["name"] == "waist" else (list(NECK[0]), list(NECK[1]))
    sil = orient(trace(layer), SIL_SIGN)
    d["skin"]["silhouette"] = sil
    d["skin"]["contours"] = snap_ends(d["skin"]["contours"], sil)
    d["skin"]["silhouette"] = snap_apexes(d, sil)
    d["regions"][0]["keep"] = wrist_keep(fist["keep"], d["skin"]["silhouette"], land)
    d["regions"][0]["image"] = fist_image(layer, fist)
    d["skin"]["topology"]["halfWidth"] = max(d["skin"]["topology"]["halfWidth"], half_width(d, layer))
    side_limits(d, suffix, limits)
    if not carrier:
        move_root(d, suffix, FAR_ROOT["pivot"])
    if carrier:
        sheet = d["assembly"]["sheets"][0]
        sheet["texture"] = "side/torso"
        torso = orient(trace("torso"), area([p if isinstance(p, list) else p["at"] for p in TORSO]))
        sheet["silhouette"] = steep_entry(with_corners(torso), sil)
        # one stroke round the whole torso but the neck's cut top: far neck side, far flank, shorts hem, the near
        # flank under the near arm (hidden at rest, exposed when the arm swings) and the near neck side
        sheet["contours"] = [{**sheet["contours"][0], "from": snap(TORSO_OUTLINE[0], torso), "to": snap(TORSO_OUTLINE[1], torso)}]
        # the near arm's front and back edges (armhole to elbow) lie over the torso whenever the arm overlaps it in a
        # turned side, not only when the arm swings across the chest (or folds inward) as in the front view: their
        # in-front strokes draw always (no across-chest fade), so the under-sheet trim of `outline` / `underside`
        # (coverUnder torso) no longer leaves an edge bare over the tank (a forward raise put the back edge over the
        # tank unlined, and the forearm's back stroke ended open at the elbow)
        for c in d["skin"]["contours"]:
            if c["owner"] == f"upper_arm{suffix}" and c["name"] in ("outline_front", "underside_front"):
                c.pop("fade", None)
        # the neck column is the trunk's alone: in a turned side the near clavicle sits beside the neck, so the girdle's
        # radial share reached the neck's cut top and a shrug tilted it (the cut row read as exposed, un-inked
        # silhouette). A fixed region there fades the girdle share out (girdle feather) as the front's mirror rule does
        # at the centreline; it stops above the arm's own hull (its top is at row ~690).
        tx = [p[0] for p in torso if p[1] < NECK_FIXED_BOTTOM]
        d["skin"]["regions"]["fixed"] = [r for r in d["skin"]["regions"]["fixed"] if r["name"] != "neck"] + [
            {"name": "neck", "bone": d["base"], "polygon": [[min(tx) - 8, 560], [max(tx) + 8, 560], [max(tx) + 8, NECK_FIXED_BOTTOM], [min(tx) - 8, NECK_FIXED_BOTTOM]]}]
    return d


def steep_entry(pts, arm_sil):
    """Where the torso's edge enters under the near arm's cap (above CAP_BAND_BOTTOM) it goes in almost straight: the
    points lying 0..STEEP_ENTRY px inside the arm's traced hull are dropped and the edge across them is one straight,
    unsampled segment (`straight` on the point before the run), so no torso hull vertex sits just under the cap's edge
    (a raise with a shrug would uncover it: cap coverage)."""
    poly = np.array(arm_sil, np.float32).reshape(-1, 1, 2)
    at = lambda p: p if isinstance(p, list) else p["at"]
    shallow = [at(p)[1] < CAP_BAND_BOTTOM and 0 < cv2.pointPolygonTest(poly, tuple(map(float, at(p))), True) < STEEP_ENTRY for p in pts]
    out = []
    for i, p in enumerate(pts):
        if shallow[i]:
            continue
        if shallow[(i + 1) % len(pts)]:
            p = {"at": at(p), "corner": True, "straight": True}
        out.append(p)
    return out


def shared_head(region, front_at):
    """The front body's head region moved onto the side head bone (translation by the head joints' offset, no
    rotation: both head bones point straight up). Its art is written as `layers/head.shared.png` (canvas size)."""
    dx, dy = HEAD[0][0] - front_at[0], HEAD[0][1] - front_at[1]
    src = cv2.imread(str((CANON / region["image"]).resolve()), cv2.IMREAD_UNCHANGED)
    h, w = src.shape[:2]
    out = cv2.warpAffine(src, np.float32([[1, 0, dx], [0, 1, dy]]), (w, h), flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    cv2.imwrite(str(LAYERS / "head.shared.png"), out)
    # The front region is the head's source half (the mirrored front build rebuilds it full width about the mirror line,
    # its far half from its own art: `asymmetric`). The side build has no mirror step, so the region is written full
    # width here the same way: crop spanning both halves, keep = the source half plus its reflection about the head
    # joint. A half head left the side neck cut's front end bare whenever the chest leaned (torso outline gaps).
    mx, tol = front_at[0], 6
    x, y, cw, ch = region["crop"]
    x0, x1 = min(x, 2 * mx - (x + cw)), max(x + cw, 2 * mx - x)
    keep = [list(p) for p in region["keep"]]
    near = [abs(p[0] - mx) <= tol for p in keep]
    if all(near) or not any(near):
        raise SystemExit("shared head: the front head keep must touch its mirror line")
    k = next(i for i in range(len(keep)) if near[i] and not near[(i + 1) % len(keep)])
    half = []
    for i in range(1, len(keep) + 1):
        j = (k + i) % len(keep)
        if near[j]:
            break
        half.append(keep[j])
    full = half + [[2 * mx - p[0], p[1]] for p in reversed(half)]
    return {**region, "texture": "side/head", "image": "layers/head.shared.png", "crop": [round(x0 + dx), round(y + dy), round(x1 - x0), ch],
            "keep": [[round(px + dx, 2), round(py + dy, 2)] for px, py in full]}


def garment_px(img):
    """Pixels of the tank / shorts (light or dark, unsaturated): the body's skin and its brown outline are saturated."""
    rgb = img[..., 2::-1].astype(int)
    return (rgb.max(axis=2) - rgb.min(axis=2)) < GARMENT_SAT


def arm_bottom(part):
    """The arm's last canvas row: its fist art's bottom (the fist crop's bottom row) plus the outline's soft edge."""
    x, y, w, h = (NEAR_FIST if part == "near_arm" else FAR_FIST)["crop"]
    return y + h + FIST_EDGE


def fist_image(part, fist):
    """The fist's own art (layers/<part>.fist.png, canvas size): the part's layer (its visible art plus the hidden
    completion) inside the art keep box, its largest connected piece only. A crop of the whole art box carried the tank
    and the shorts round the fist, so the fist join traced the box as the fist's silhouette (a square fist)."""
    lay = cv2.imread(str(LAYERS / f"{part}.layer.png"), cv2.IMREAD_UNCHANGED)
    box = np.zeros(lay.shape[:2], np.uint8)
    cv2.fillPoly(box, [np.array(fist["keep"], np.int32)], 1)
    # the shorts and tank crumbs the layer split left on the fist are not the fist (the near fist's lower inner side
    # carried a shorts strip, so the fist join's outline went round shorts and the fist read open there)
    m = ((lay[..., 3] >= 128) & (box > 0) & ~garment_px(lay)).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
    big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    out = lay.copy()
    out[..., 3] = np.where((lab == big) | ((box > 0) & (lay[..., 3] < 128) & (cv2.dilate((lab == big).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)), lay[..., 3], 0)
    name = f"{part}.fist.png"
    cv2.imwrite(str(LAYERS / name), out)
    return f"layers/{name}"


def wrist_keep(keep, sil, land):
    """The fist's keep polygon re-cut at the wrist points of the traced arm: the art keep box joined with the traced
    silhouette's whole hand end (every point at or past the wrist along the arm axis, the wrist being the first
    silhouette point inside the box). The traced arm reaches past the fist art's bottom (its layer completes the hand
    under the fist), so the box alone left a third stroke piece round the hand end: 4 cut ends, no fist join."""
    pts = [p if isinstance(p, list) else p["at"] for p in sil]
    s, w = np.array(land["shoulder"], float), np.array(land["wrist_dir"], float)
    u = (w - s) / np.linalg.norm(w - s)
    t = lambda p: float(np.dot(np.array(p, float) - s, u))
    poly = np.array(keep, np.float32)
    inside = [cv2.pointPolygonTest(poly, (float(p[0]), float(p[1])), False) >= 0 for p in pts]
    if not any(inside):
        return keep
    wrist = min(t(p) for p, i in zip(pts, inside) if i)
    hand = [p for p in pts if t(p) >= wrist]
    x0 = int(min(min(p[0] for p in keep), min(p[0] for p in hand))) - 8
    y0 = int(min(min(p[1] for p in keep), min(p[1] for p in hand))) - 8
    x1 = int(max(max(p[0] for p in keep), max(p[0] for p in hand))) + 8
    y1 = int(max(max(p[1] for p in keep), max(p[1] for p in hand))) + 8
    m = np.zeros((y1 - y0 + 1, x1 - x0 + 1), np.uint8)
    off = lambda q: np.round(np.array(q, float) - [x0, y0]).astype(np.int32)
    cv2.fillPoly(m, [off(keep)], 1)
    h = np.zeros_like(m)
    cv2.fillPoly(h, [cv2.convexHull(off(hand))], 1)
    m |= cv2.dilate(h, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))  # 4 px: hull vertices sit on the traced line
    c = max(cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0], key=cv2.contourArea)
    c = cv2.approxPolyDP(c, 1.0, True)[:, 0, :]
    return [[int(x + x0), int(y + y0)] for x, y in c]


def leg(suffix, land, name, slot, layer):
    d = json.loads((CANON / "template7-fullbody-test-leg.part.json").read_text())
    bone = lambda n: next(b for b in d["bones"] if b["name"] == n)
    f, deg = rigid(bone("thigh_l")["at"], land["hip"], land["ankle_dir"], bone("foot_l")["at"])
    names = {n: n[:-2] + suffix for n in ["thigh_l", "shin_l", "foot_l"]}
    for c in d.get("correctives", []) + d.get("grids", []):
        names[c["name"]] = c["name"][:-2] + suffix
    names["hips"] = slot
    d["garments"] = []
    d["skin"]["junctions"] = [j for j in d["skin"].get("junctions", []) if j.get("on") != "shorts"]
    d = walk(d, f, deg)
    d = rename(d, names)
    d["name"], d["description"] = name, "Turned-side leg (phase 2b), generated by scripts/views/side_presets.py from template7-fullbody-test-leg."
    d["bones"] = shared(d["bones"])
    d["skin"]["texture"] = f"side/{slot}"
    sil = orient(trace(layer), SIL_SIGN)
    d["skin"]["silhouette"] = sil
    d["skin"]["contours"] = snap_ends(d["skin"]["contours"], sil)
    d["skin"]["junctions"] = snap_ends(d["skin"].get("junctions", []), sil)
    d["skin"]["silhouette"] = snap_apexes(d, sil)
    d["skin"]["topology"]["halfWidth"] = max(d["skin"]["topology"]["halfWidth"], half_width(d, layer))
    d["drawOrder"] = [slot]
    hem_under(d, sil)
    return d


NECK_FIXED_BOTTOM = 682  # canvas row: the neck column above the shoulders' top (the near arm's hull starts at ~690)
HEM_BURY = 8 # px: a leg stroke's end sits this far inside the torso sheet (the round cap, half the 10 px width, hidden)


def hem_under(d, sil):
    """The legs' outline ends (and their hem junctions) move up along the leg silhouette to just under the torso sheet's
    hem. The front template's ends sit on the front shorts hem; the side shorts hem is higher and slanted, so the copied
    ends left the leg edge bare between the side hem and the stroke's start (an inked gap at the near leg's front)."""
    pts = [p if isinstance(p, list) else p["at"] for p in sil]
    k = 2 * HEM_BURY + 1
    inner = cv2.erode(full_mask("torso"), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))) > 0
    inside = lambda p: inner[min(inner.shape[0] - 1, int(round(p[1]))), min(inner.shape[1] - 1, int(round(p[0])))]
    n = len(pts)
    idx = lambda q: min(range(n), key=lambda i: (pts[i][0] - q[0]) ** 2 + (pts[i][1] - q[1]) ** 2)
    moved = {}
    for c in d["skin"]["contours"]:
        for key, step in (("from", -1), ("to", 1)):
            i = idx(c[key])
            for _ in range(n // 2):
                if inside(pts[i]):
                    break
                i = (i + step) % n
            moved[tuple(c[key])] = list(pts[i])
            c[key] = list(pts[i])
    for j in d["skin"].get("junctions", []):
        if tuple(j["at"]) in moved:
            j["at"] = moved[tuple(j["at"])]


def landmarks():
    for part, land, (j0, j1) in [("near_arm", NEAR_ARM, ("shoulder", "wrist_dir")), ("far_arm", FAR_ARM, ("shoulder", "wrist_dir")),
                                 ("near_leg", NEAR_LEG, ("hip", "ankle_dir")), ("far_leg", FAR_LEG, ("hip", "ankle_dir"))]:
        f = axis(part, *land["fit"])
        land[j0], land[j1] = f(land["rows"][0]), f(land["rows"][1])


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    landmarks()
    FAR_ROOT["pivot"] = far_root_pivot()
    shutil.copyfile(ART, OUT / "body-side.png")
    parts = {
        "near_arm": arm("template7-fullbody-test-arm.part.json", "_l", "_r", {"upper_arm": "upper_arm_r", "forearm": "forearm_r", "hand": "hand_r"}, NEAR_ARM, NEAR_FIST, "side/arm-r", "side-near-arm", True, "near_arm", NEAR_ARM_LIMITS),
        "far_arm": arm("template7-fullbody-test-fararm.part.json", "_b", "_l", {}, FAR_ARM, FAR_FIST, "side/arm-l", "side-far-arm", False, "far_arm", FAR_ARM_LIMITS),
        "near_leg": leg("_r", NEAR_LEG, "side-near-leg", "hips_r", "near_leg"),
        "far_leg": leg("_l", FAR_LEG, "side-far-leg", "hips_l", "far_leg"),
    }
    files = {"near_arm": "side-near-arm.part.json", "far_arm": "side-far-arm.part.json", "near_leg": "side-near-leg.part.json", "far_leg": "side-far-leg.part.json"}
    for k, d in parts.items():
        (OUT / files[k]).write_text(json.dumps(d, indent=1) + "\n")
    body = {
        "name": "body-side",
        "description": "Turned-side body (phase 2b): near arm over the full torso sheet, far arm under it, two independent legs; generated by scripts/views/side_presets.py.",
        "canvas": {"width": 1086, "height": 1448, "originX": 542, "originY": 960},
        "figureHeight": 1074,
        "gamePixels": 140,
        "art": "body-side.png",
        "parts": [
            {"name": "near_arm", "file": files["near_arm"], "depth": "near", "kind": "arm", "partner": "far_arm"},
            {"name": "far_arm", "file": files["far_arm"], "depth": "far", "kind": "arm", "partner": "near_arm"},
            {"name": "far_leg", "file": files["far_leg"], "depth": "far", "kind": "leg", "partner": "near_leg"},
            {"name": "near_leg", "file": files["near_leg"], "depth": "near", "kind": "leg", "partner": "far_leg"},
        ],
    }
    (OUT / "body-side.body.json").write_text(json.dumps(body, indent=1) + "\n")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
