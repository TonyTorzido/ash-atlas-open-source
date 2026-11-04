# Atlas Animator multi-view swag, step 2 (packages/animator/README.md): the BACK body.
#   python back_body.py            (run from packages/animator)
# The back reuses the front body's mesh, skeleton, weights and garment domain VERBATIM (the back silhouette equals
# the front; the domain binds to triangle ids, so every front garment domain is valid on the back). Only the body
# art changes, deterministically, in the atlas page:
#   - the chest line: the lighter sternum "U" and its light rim under the neck (front-only anatomy) -> base skin;
#     the darker crescent under the head stays (the head's cast shadow reads from behind too);
#   - the shorts fly: the waistband zigzag highlight and the front crotch "V" shading -> plain cloth, plus a simple
#     seat seam (one thin vertical shade line from the waistband to the crotch notch);
#   - the hands and feet (phase 2 step 0): the fists' knuckle highlight and knuckle crease shading and the feet's toe
#     highlights are front-facing art -> the local base skin (the region's median skin tone); the edge shading ring
#     (within EDGE_KEEP px of the region's alpha edge) stays, so the hands and feet keep their volume.
# Outputs: docs/plans/atlas-animator-demos/views/body-back/rig/template7-shoulder-legs-back.{anim,atlas}.json + .png,
# ART_DROPS/views-jacket-b/body/template7-clean-back.png (the canvas body art, --base for the importer: the front
# body art with exactly the pixels the back rig's rest render changes), and the silhouette gate (rest alpha of the
# back rig == the front rig) in body-back/body-back.report.json.
import json
import shutil
import subprocess
import sys
from pathlib import Path
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parents[2]  # packages/animator
DEMOS = HERE.parents[1] / "docs/plans/atlas-animator-demos"
FRONT = DEMOS / "phase-4d4m/body/rig/template7-shoulder-legs"
OUT = DEMOS / "views/body-back"
sys.path.insert(0, str(Path(__file__).parent))
from common import DROPS, lum  # noqa: E402

ART = DROPS / "views-jacket-b"
FRONT_BASE = DROPS / "player-smooth-01/final/bodies/template7-clean.png"
SKIN = "canonical/template7-shoulder-skin"
SHORTS = "canonical/template7-leg-shorts"
FISTS = ("canonical/template7-fist", "canonical/template7-fist_r")
LEG = "canonical/template7-leg-skin"
EDGE_KEEP = 9  # px of edge shading kept around a fist (texture px)
FOOT_ROWS = 0.68  # the feet are the leg-skin region's rows below this fraction of its height


def neutralise(reg, rows=None, dark=True):
    """Front-facing highlights (and, with dark, interior crease shading) -> the region's median skin tone."""
    from scipy.ndimage import distance_transform_edt
    al = reg[..., 3] > 200
    L = lum(reg[..., :3])
    base = np.median(reg[..., :3][al].reshape(-1, 3), 0)
    lb = lum(base[None])[0]
    sel = al & (L > lb + 3)
    if dark:
        sel |= al & (L < lb - 4) & (distance_transform_edt(al) > EDGE_KEEP)
    if rows is not None:
        keep = np.zeros(al.shape, bool)
        keep[rows] = True
        sel &= keep
    reg[..., :3][sel] = base.astype(np.uint8)
    return int(sel.sum())


def edit_atlas(page, regions):
    a = np.array(page.convert("RGBA"))
    # chest line: region box (x 197..325, y 67..136) below the neck block; lighter-than-skin pixels -> base skin
    r = regions[SKIN]
    x0, y0 = r["x"], r["y"]
    box = a[y0 + 67:y0 + 137, x0 + 190:x0 + 335]
    skin = np.median(a[y0 + 160:y0 + 200, x0 + 200:x0 + 320, :3].reshape(-1, 3), 0)
    L = lum(box[..., :3])
    sel = L > lum(skin[None])[0] + 2.5
    box[..., :3][sel] = skin.astype(np.uint8)
    chest_px = int(sel.sum())
    # shorts fly: the central zone (region x 75..200) -> plain cloth, then a thin seat seam down the centre
    r = regions[SHORTS]
    x0, y0, w, h = r["x"], r["y"], r["width"], r["height"]
    reg = a[y0:y0 + h, x0:x0 + w]
    Lr = lum(reg[..., :3])
    cloth = np.median(reg[20:60, 40:75, :3].reshape(-1, 3), 0)
    shade = np.percentile(reg[40:110, 80:200, :3].reshape(-1, 3), 8, axis=0)  # the front's crotch shading tone: reused for the seam
    zone = np.zeros(Lr.shape, bool)
    zone[8:h, 75:201] = True
    changed = zone & (np.abs(Lr - lum(cloth[None])[0]) > 3)
    reg[..., :3][zone] = cloth.astype(np.uint8)
    cx = w // 2 + 1
    seam_rows = range(14, 96)
    for y in seam_rows:
        reg[y, cx - 1:cx + 1, :3] = shade.astype(np.uint8)
        reg[y, cx + 1, :3] = ((shade + cloth) / 2).astype(np.uint8)
    # hands and feet: front-facing knuckles and toe highlights -> local skin
    hands = 0
    for name in FISTS:
        r = regions[name]
        hands += neutralise(a[r["y"]:r["y"] + r["height"], r["x"]:r["x"] + r["width"]])
    r = regions[LEG]
    feet = neutralise(a[r["y"]:r["y"] + r["height"], r["x"]:r["x"] + r["width"]], rows=slice(int(r["height"] * FOOT_ROWS), None), dark=False)
    return Image.fromarray(a), dict(chestPx=chest_px, handPx=hands, footPx=feet, flyPx=int(changed.sum()), cloth=cloth.tolist(), seamColour=shade.tolist(), seamRows=[14, 95], seamX=cx)


def render(out_dir, scale, clip, frame, pairs):
    subprocess.run(["npx", "tsx", "scripts/swag/render-rest.ts", str(out_dir), str(scale), clip, str(frame), *[f"{k}={v}" for k, v in pairs.items()]],
                   cwd=HERE, check=True, shell=True)


def main():
    rig = OUT / "rig"
    rig.mkdir(parents=True, exist_ok=True)
    ART.joinpath("body").mkdir(parents=True, exist_ok=True)
    stem = "template7-shoulder-legs-back"
    anim = json.loads(FRONT.with_suffix(".anim.json").read_text(encoding="utf-8"))
    (rig / f"{stem}.anim.json").write_text(json.dumps(anim, separators=(",", ":")), encoding="utf-8")
    atlas = json.loads(Path(str(FRONT) + ".atlas.json").read_text(encoding="utf-8"))
    page = atlas["pages"][0]
    img, info = edit_atlas(Image.open(FRONT.parent / page["file"]), page["regions"])
    page["file"] = f"{stem}.atlas.png"
    img.save(rig / page["file"])
    (rig / f"{stem}.atlas.json").write_text(json.dumps(atlas, indent=1) + "\n", encoding="utf-8")
    # rest renders at 1x (the renderer's own canvas framing) -> silhouette gate + the canvas body art diff
    tmp = ART / "body/_render"
    render(tmp, 1, "rest", 0, {"front": FRONT.with_suffix(".anim.json"), "back": rig / f"{stem}.anim.json"})
    fr = np.array(Image.open(tmp / "front.png").convert("RGBA"))
    bk = np.array(Image.open(tmp / "back.png").convert("RGBA"))
    bgc = np.array([0xb4, 0xb9, 0xc2])
    fsil = np.abs(fr[..., :3].astype(int) - bgc).sum(-1) > 0
    bsil = np.abs(bk[..., :3].astype(int) - bgc).sum(-1) > 0
    diff = np.abs(fr.astype(int) - bk.astype(int)).sum(-1) > 0
    base = np.array(Image.open(FRONT_BASE).convert("RGBA"))
    same_frame = base.shape[:2] == fr.shape[:2]
    if same_frame:
        base[diff, :3] = bk[diff, :3]
    Image.fromarray(base).save(ART / "body/template7-clean-back.png")
    shutil.copy(tmp / "back.png", OUT / "body-back-rest-1x.png")
    shutil.copy(tmp / "front.png", OUT / "body-front-rest-1x.png")
    rep = dict(edits=info, renderSize=list(fr.shape[:2][::-1]), baseSameFrame=same_frame, changedPx=int(diff.sum()),
               silhouetteXorPx=int((fsil ^ bsil).sum()), gates=dict(silhouetteIdentical=bool((fsil ^ bsil).sum() == 0), meshSkeletonVerbatim=True,
                                                                     artChangedOnlyInside=bool((diff & ~fsil).sum() == 0)))
    (OUT / "body-back.report.json").write_text(json.dumps(rep, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(rep))


if __name__ == "__main__":
    main()
