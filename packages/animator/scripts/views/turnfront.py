# Atlas Animator turned-front PREVIEW (owner decision 2026-10-19: two slightly turned fronts, looking left and
# mirrored for right; docs/plans/atlas-animator-demos/views/turned-front/README.md). Deterministic.
#
#   python scripts/views/turnfront.py <front.anim.json> <out dir> <stem> [--angles 0,10,15,20]
#   (run from packages/animator)
#
# Reprojects an approved FRONT rig (body, and any garment meshes in it, e.g. Jacket B) to a body turned by theta
# toward screen-left, by editing the rig's setup data only (same skeleton, same clips, same atlas regions):
#   - torso (chest/clavicle influences) and hips (pelvis influences): an elliptic cylinder about the body axis
#     (skeleton x = 0) with half-width W and depth D, front surface depth z(u) = D (1 - (u/W)^2) (parabolic, so the
#     map stays monotone up to ~35 deg; the owner range is 10-20 deg), rotated: x' = u cos(theta) - z sin(theta), plus an edge term so the
#     silhouette ends on the rotated ellipse's real extent E = sqrt(W^2 cos^2 + D^2 sin^2). The centre line moves
#     toward the facing side by D sin(theta); the far half (screen-left) narrows, the near half widens.
#   - joints (shoulders, hips) sit on the axis plane (z = 0): their bones move to x cos(theta); the arms and legs
#     move with them rigidly. The far arm (_l) is narrowed about its own bone axis (local y x KFAR), the near arm
#     widened slightly (KNEAR). IK foot targets move with their legs.
#   - neck influences: a small cylinder (neck radius); the head (a region) moves toward the facing side by HEAD_FWD x
#     D sin(theta) (the head sits in front of the spine axis). The template head is a bald egg with no face or ears,
#     so its own turn only shows as the far-side shading.
#   - shading: every texel of the body, garment, head and far fist on the far side is darkened by up to ALPHA(theta)
#     (smoothstep across the far half, the whole far arm/hand), in a copy of the atlas page.
# Each influence (bone, local x, y, weight) of every weighted mesh vertex is moved to the transformed position of its
# own setup world point and re-expressed in its (possibly moved) bone's frame, so contours (which ride mesh vertices),
# driven deforms (bone-local offsets) and clips keep working unchanged.
# Writes <out>/<stem>-turn<deg>.anim.json + .atlas.json + .atlas.png and <out>/<stem>-turn<deg>.params.json.
#
# --back (lineup test, 2026-10-19): the same turn applied to a BACK rig (views/body-back, Jacket B back; same skeleton,
# screen x unchanged). The body still turns toward screen-left (walking up-left), but the camera sees its back
# surface, which faces the camera: with the camera at +z, a point (u, z) turns to x' = u cos(theta) + z sin(theta).
# So the spine line (u = 0, z = D) shifts AWAY from the facing side, toward screen-right, by D sin(theta) (the cylinder
# is evaluated at -theta), and the screen-right half is the one rotating away from the camera: it compresses, its arm
# (_r) narrows and it darkens (far side mirrored). The joints on the axis plane move to x cos(theta) as in the front.
# The head centre sits in front of the spine, i.e. AWAY from the camera (z = -HEAD_FWD D), so it still moves toward
# the facing side (screen-left) by HEAD_FWD D sin(theta). The feet still toe toward the facing side (the toes point
# into the screen and turn left with the body).
import argparse
import json
import math
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

W_CHEST, D_CHEST = 112.0, 0.62 * 112.0  # torso half-width at the chest (skeleton px) and front depth
W_HIPS, D_HIPS = 118.0, 0.55 * 118.0
W_NECK, D_NECK = 40.0, 0.9 * 40.0
HEAD_FWD = 0.35  # head centre in front of the axis, as a fraction of the chest depth
KFAR_PER_SIN, KNEAR_PER_SIN = 0.30, 0.08  # far arm width x (1 - 0.30 sin), near arm x (1 + 0.08 sin)
# refine P5 item 8 (turn read, front only): the far shoulder joint (upper_arm_l) moves a further ARM_TUCK x D_CHEST
# sin(theta) toward the body axis (15 deg: 2.7 skeleton px), so its inner edge slides under the tank flank and the far
# arm sits closer to the chest, which has itself moved toward it by D sin(theta); the near shoulder (upper_arm_r) moves
# out by ARM_SPREAD x D_CHEST sin(theta) (0.7 px; 0.08 = 1.4 px opened a 3x hairline tear in idle_weight_shift on
# the turned rigs). The arms ride their moved bones rigidly as before.
# refine P6 (owner: "some detachment here"): the near shoulder no longer spreads; it moves 0.06 D sin(theta) (1 px)
# toward the chest so its root overlaps the tank flank at the outswing (the +0.04 spread let a 1-2 px background crack
# run 6 rows up between the arm's inner outline and the tank flank, L15 f7-f9; gate G10)
ARM_TUCK_PER_SIN, ARM_SPREAD_PER_SIN = 0.15, -0.06
ALPHA_PER_SIN = 0.35  # far-side darkening at full far: 0.35 sin(theta) (10: 6%, 15: 9%, 20: 12%)
# round 2: both feet toe toward the facing side. Every foot-bone influence below the ankle (the foot bone's setup
# origin) is sheared toward screen-left by FOOT_SHEAR_PER_SIN sin(theta) px per px below the ankle (15 deg: 0.31,
# the toe tip ~22 canvas px; 20 deg: 0.41, ~30 px). Influences of the shin on the same vertices stay, so the ankle
# blends. 0 = round 1 (feet at the camera); --feet 0 reproduces round 1.
FOOT_SHEAR_PER_SIN = 1.2
# refine P4 (neck seam): the neck sides are ~97% chest-weighted, so the chest cylinder moved the far neck edge ~12.6
# skeleton px toward screen-left at 15 deg while the head (a region) only moves HEAD_FWD D sin = 6.3; the far neck
# contour's top then poked out from under the chin and opened a 3x hairline (validate clip tears near canvas
# (478, 650)). Front only: every torso/neck influence above NECK_FOLLOW_Y0 (skeleton y, up = negative) blends its x
# displacement toward the head's, smoothstep from 0 at Y0 (the trapezius, just above the tank straps) to 1 at Y1 (just
# under the chin), so the neck top rides with the head and the neck tapers into the chin.
NECK_FOLLOW_Y0, NECK_FOLLOW_Y1 = -288.0, -312.0  # (-292, -318) left a 3-4 px join wedge; wider ramps re-open the crack

TORSO_BONES = {"chest", "clavicle_l", "clavicle_r"}
HIPS_BONES = {"pelvis"}
NECK_BONES = {"neck"}
ARM_L = {"upper_arm_l", "forearm_l", "hand_l"}
ARM_R = {"upper_arm_r", "forearm_r", "hand_r"}
LEGS = {"thigh_l", "shin_l", "foot_l", "thigh_r", "shin_r", "foot_r"}


def setup_world(bones):
    """Setup world 2x3 matrices (skeleton space) per bone: [[a, b, x], [c, d, y]]."""
    out = {}
    for b in bones:
        r = math.radians(b.get("rotation", 0.0))
        sx, sy = b.get("scaleX", 1.0), b.get("scaleY", 1.0)
        assert not b.get("shearX") and not b.get("shearY"), b["name"]
        loc = np.array([[math.cos(r) * sx, -math.sin(r) * sy, b.get("x", 0.0)], [math.sin(r) * sx, math.cos(r) * sy, b.get("y", 0.0)], [0, 0, 1]])
        p = b.get("parent")
        out[b["name"]] = (out[p] @ loc) if p else loc
    return out


def apply(m, x, y):
    return m[0, 0] * x + m[0, 1] * y + m[0, 2], m[1, 0] * x + m[1, 1] * y + m[1, 2]


def inv_apply(m, x, y):
    return tuple(np.linalg.inv(m) @ np.array([x, y, 1.0]))[:2]


def cyl(u, theta, w, d):
    """Front-surface point at offset u from the axis -> its x after turning by theta toward screen-left."""
    c, s = math.cos(theta), math.sin(theta)
    e = math.sqrt(w * w * c * c + d * d * s * s)
    if abs(u) >= w:
        return u * c + math.copysign(e - w * c, u)
    z = d * (1 - (u / w) ** 2)
    return u * c - z * s + (e - w * c) * math.copysign(abs(u / w) ** 3, u)


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def far_shade(u, w, alpha):
    """Darkening multiplier on the far (screen-left, u < 0) half."""
    return 1.0 - alpha * smooth((-u / w + 0.1) / 0.9)


def turn(doc, theta, foot_shear_per_sin=FOOT_SHEAR_PER_SIN, back=False, back_feet="heel"):
    c = math.cos(theta)
    s = math.sin(theta)
    bones = doc["bones"]
    by = {b["name"]: b for b in bones}
    w0 = setup_world(bones)
    # moved bones: shoulders and hips to x cos(theta) on the axis plane, head forward, IK targets with their legs
    moves = {}
    for name in ("upper_arm_l", "upper_arm_r", "thigh_l", "thigh_r"):
        x, y = w0[name][0, 2], w0[name][1, 2]
        moves[name] = (x * c - x, 0.0)
    if not back:  # refine P5 item 8: the far shoulder tucks toward the chest, the near one spreads (front only)
        for name, k in (("upper_arm_l", -ARM_TUCK_PER_SIN), ("upper_arm_r", ARM_SPREAD_PER_SIN)):
            x = w0[name][0, 2]
            moves[name] = (moves[name][0] + math.copysign(1.0, x) * k * D_CHEST * s, 0.0)
    head_dx = -HEAD_FWD * D_CHEST * s
    moves["head"] = (head_dx, 0.0)
    for name, dx_dy in moves.items():
        b = by[name]
        pm = w0[b["parent"]]
        x, y = w0[name][0, 2] + dx_dy[0], w0[name][1, 2] + dx_dy[1]
        b["x"], b["y"] = (round(v, 4) for v in inv_apply(pm, x, y))
    for side in ("l", "r"):
        t = by[f"foot_{side}_target"]
        t["x"] = round(t.get("x", 0.0) + moves[f"thigh_{side}"][0], 4)
    w1 = setup_world(bones)
    kfar, knear = 1 - KFAR_PER_SIN * s, 1 + KNEAR_PER_SIN * s
    # front: toes toward screen-left (+shear moves below-ankle texels left); back heel: the other way
    shear = foot_shear_per_sin * s * (-1.0 if back and back_feet == "heel" else 1.0)
    surf = -theta if back else theta  # back: the visible (back) surface faces the camera, so it turns the other way
    arm_far, arm_near = (ARM_R, ARM_L) if back else (ARM_L, ARM_R)

    def neck_follow(x, y, tx):
        if back:
            return tx
        t = smooth((NECK_FOLLOW_Y0 - y) / (NECK_FOLLOW_Y0 - NECK_FOLLOW_Y1))
        return tx + t * ((x + head_dx) - tx)

    def target(bone, x, y, slot):
        if bone in ("foot_l", "foot_r") and shear:
            ay = w0[bone][1, 2]
            return x + moves[f"thigh_{bone[-1]}"][0] - shear * max(0.0, y - ay), y
        if bone in TORSO_BONES:
            return neck_follow(x, y, cyl(x, surf, W_CHEST, D_CHEST)), y
        if bone in HIPS_BONES or (slot == "shorts" and bone in LEGS):  # the shorts are a pelvis garment
            return cyl(x, surf, W_HIPS, D_HIPS), y
        if bone in NECK_BONES:
            return neck_follow(x, y, cyl(x, surf, W_NECK, D_NECK)), y
        return None  # rides its moved bone

    nverts = 0
    for skin in doc["skins"].values():
        for slot, atts in skin["attachments"].items():
            for name, a in atts.items():
                if a["type"] != "mesh" or "bones" not in a:
                    continue
                names = a["bones"]
                v = a["vertices"]
                out, i = [], 0
                while i < len(v):
                    n = int(v[i])
                    out.append(n)
                    i += 1
                    for _ in range(n):
                        bi, lx, ly, wt = int(v[i]), v[i + 1], v[i + 2], v[i + 3]
                        bn = names[bi]
                        px, py = apply(w0[bn], lx, ly)
                        tg = target(bn, px, py, slot)
                        if tg is None:
                            nx, ny = lx, ly
                            # limbs stay rigid on their moved bones (a per-limb cylinder about the bone axis was
                            # tried: the bone axes are not the limbs' centre lines, mixed influences tore the inner
                            # arm/leg shading into ragged edges at 1x); only the far arm narrows, the near widens
                            if bn in arm_far:
                                ny *= kfar
                            elif bn in arm_near:
                                ny *= knear
                        else:
                            nx, ny = inv_apply(w1[bn], *tg)
                        out += [bi, round(nx, 4), round(ny, 4), wt]
                        i += 4
                    nverts += 1
                a["vertices"] = out
    return {"moves": moves, "armTuckSpread": None if back else [ARM_TUCK_PER_SIN, ARM_SPREAD_PER_SIN], "kfar": kfar, "knear": knear, "headDx": head_dx, "footShear": shear,
            "backFeet": back_feet if back else None,
            "neckFollowY": None if back else [NECK_FOLLOW_Y0, NECK_FOLLOW_Y1], "weightedVertices": nverts,
            "farArm": sorted(arm_far)}, w0


def mesh_world_x(a, w0):
    """Setup skeleton x of each vertex of a weighted mesh (original rig)."""
    names, v, xs, i = a["bones"], a["vertices"], [], 0
    while i < len(v):
        n = int(v[i])
        i += 1
        x = 0.0
        for _ in range(n):
            bi, lx, ly, wt = int(v[i]), v[i + 1], v[i + 2], v[i + 3]
            x += wt * apply(w0[names[bi]], lx, ly)[0]
            i += 4
        xs.append(x)
    return np.array(xs)


def shade_atlas(doc, w0, page_img, regions, alpha, back=False):  # noqa: C901
    """Darken the far side in a copy of the page: meshes by texel -> setup x (barycentric over the UV triangles),
    the head region by its own centre, the far fist region whole. back: the far side is screen-right (x > 0)."""
    sgn = -1.0 if back else 1.0
    far_hand = "hand_r" if back else "hand"
    img = np.asarray(page_img).astype(np.float32)
    done = set()
    for skin in doc["skins"].values():
        for slot, atts in skin["attachments"].items():
            for name, a in atts.items():
                path = a.get("path", name)
                if path not in regions or path in done:
                    continue
                rg = regions[path]
                rx, ry, rw, rh = rg["x"], rg["y"], rg["width"], rg["height"]
                fac = np.ones((rh, rw), np.float32)
                if a["type"] == "mesh" and "bones" in a:
                    xs = mesh_world_x(a, w0)
                    uv = np.array(a["uvs"]).reshape(-1, 2) * [rw, rh]
                    tris = np.array(a["triangles"]).reshape(-1, 3)
                    gx, gy = np.meshgrid(np.arange(rw) + 0.5, np.arange(rh) + 0.5)
                    xmap = np.full((rh, rw), np.nan, np.float32)
                    for t in tris:
                        (x0, y0), (x1, y1), (x2, y2) = uv[t]
                        bx0, bx1 = int(max(0, math.floor(min(x0, x1, x2)) - 1)), int(min(rw, math.ceil(max(x0, x1, x2)) + 1))
                        by0, by1 = int(max(0, math.floor(min(y0, y1, y2)) - 1)), int(min(rh, math.ceil(max(y0, y1, y2)) + 1))
                        if bx1 <= bx0 or by1 <= by0:
                            continue
                        det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
                        if abs(det) < 1e-9:
                            continue
                        px, py = gx[by0:by1, bx0:bx1], gy[by0:by1, bx0:bx1]
                        l0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / det
                        l1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / det
                        l2 = 1 - l0 - l1
                        inside = (l0 >= -0.02) & (l1 >= -0.02) & (l2 >= -0.02)
                        val = l0 * xs[t[0]] + l1 * xs[t[1]] + l2 * xs[t[2]]
                        sub = xmap[by0:by1, bx0:bx1]
                        sub[inside & np.isnan(sub)] = val[inside & np.isnan(sub)]
                    # texels outside every triangle (padding): nearest filled column value per row
                    for yy in range(rh):
                        row = xmap[yy]
                        ok = ~np.isnan(row)
                        if ok.any():
                            idx = np.where(ok)[0]
                            row[~ok] = np.interp(np.where(~ok)[0], idx, row[idx])
                    xmap = np.nan_to_num(xmap, nan=0.0)
                    w = W_HIPS if slot in ("hips", "shorts", "pants") else W_CHEST
                    fac = np.vectorize(lambda x: far_shade(sgn * x, w, alpha))(xmap).astype(np.float32)
                elif a["type"] == "region" and slot == "head":
                    # region centre/axes in skeleton space (head bone x region transform)
                    r = math.radians(a.get("rotation", 0.0))
                    bone = next(s["bone"] for s in doc["slots"] if s["name"] == slot)
                    m = w0[bone]
                    ax = (m[0, 0] * math.cos(r) + m[0, 1] * math.sin(r))  # region +x along skeleton x (+-1 here)
                    assert abs(abs(ax) - 1) < 1e-3, ax
                    # per texture row, the egg's own opaque extent: the shade follows the outline (a crescent on the
                    # far side), not a flat vertical band
                    alpha_ch = np.asarray(page_img)[ry:ry + rh, rx:rx + rw, 3]
                    fac = np.ones((rh, rw), np.float32)
                    for yy in range(rh):
                        cols = np.where(alpha_ch[yy] > 8)[0]
                        if len(cols) < 4:
                            continue
                        mid, half = (cols[0] + cols[-1] + 1) / 2, (cols[-1] + 1 - cols[0]) / 2
                        un = (np.arange(rw) + 0.5 - mid) / half * math.copysign(1, ax) * sgn
                        fac[yy] = [far_shade(u, 1.0, alpha) for u in un]
                elif a["type"] == "region" and slot == far_hand:
                    fac[:] = 1.0 - alpha * 0.9
                else:
                    continue
                img[ry:ry + rh, rx:rx + rw, :3] *= fac[..., None]
                done.add(path)
    return Image.fromarray(np.clip(img + 0.5, 0, 255).astype(np.uint8)), sorted(done)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("stem")
    ap.add_argument("--angles", default="0,10,15,20")
    ap.add_argument("--feet", type=float, default=FOOT_SHEAR_PER_SIN, help="foot shear per sin(theta); 0 = round 1")
    ap.add_argument("--back", action="store_true", help="the source is a BACK rig: the back surface turns the other way")
    ap.add_argument("--back-feet", choices=("heel", "toe"), default="heel",
                    help="--back only: heel (default) = below the ankle is the heel, sheared toward screen-right; toe = the front sign")
    a = ap.parse_args()
    src = Path(a.src)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    atlas_src = src.with_name(src.name.replace(".anim.json", ".atlas.json"))
    atlas = json.loads(atlas_src.read_text(encoding="utf-8"))
    assert len(atlas["pages"]) == 1
    page = atlas["pages"][0]
    page_img = Image.open(atlas_src.parent / page["file"]).convert("RGBA")
    for deg in [int(x) for x in a.angles.split(",")]:
        doc = json.loads(src.read_text(encoding="utf-8"))
        stem = f"{a.stem}-turn{deg:02d}"
        if deg == 0:
            info, w0 = {"moves": {}}, setup_world(doc["bones"])
            shaded, done = page_img, []
        else:
            theta = math.radians(deg)
            info, w0 = turn(doc, theta, a.feet, a.back, a.back_feet)
            shaded, done = shade_atlas(json.loads(src.read_text(encoding="utf-8")), w0, page_img, page["regions"], ALPHA_PER_SIN * math.sin(theta), a.back)
        doc["name"] = stem
        (out / f"{stem}.anim.json").write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
        at = json.loads(json.dumps(atlas))
        at["pages"][0]["file"] = f"{stem}.atlas.png"
        (out / f"{stem}.atlas.json").write_text(json.dumps(at, indent=1), encoding="utf-8")
        shaded.save(out / f"{stem}.atlas.png")
        params = {
            "source": src.as_posix(), "degrees": deg, "view": "back" if a.back else "front",
            "facing": "screen-left (mirror the render for screen-right)",
            "chest": [W_CHEST, D_CHEST], "hips": [W_HIPS, D_HIPS], "neck": [W_NECK, D_NECK], "headFwd": HEAD_FWD,
            "centreLineShiftChest": round((1 if a.back else -1) * D_CHEST * math.sin(math.radians(deg)), 2),
            "alpha": round(ALPHA_PER_SIN * math.sin(math.radians(deg)), 4), "shadedRegions": done,
            **{k: (v if not isinstance(v, dict) else {n: [round(q, 2) for q in d] for n, d in v.items()}) for k, v in info.items()},
        }
        (out / f"{stem}.params.json").write_text(json.dumps(params, indent=1), encoding="utf-8")
        print(stem, json.dumps(params["moves"]))


if __name__ == "__main__":
    main()
