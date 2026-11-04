# Atlas Animator five-anims refine P5 (2026-10-19, REFINE-PLAN item 4): fists and feet lose their flat pale highlight
# "stickers" and the crumb-like ink specks. Deterministic, no drawing, colour only: alpha is never touched, so the
# silhouette XOR is 0 by construction (checked anyway).
#
#   python scripts/views/polish_extremities.py <rig.anim.json>      (in place on its atlas page; run before turnfront.py)
#
# Per target (the two fist regions; the foot rows of the leg-skin region):
#   1. Highlight = opaque texels lighter than the base skin (median L) by more than HL_DL. The base under it is
#      inpainted from the nearest non-highlight texels, then smoothed (gaussian, sigma INPAINT_SIGMA) inside the mask.
#   2. The highlight lift (texel - base) is blurred (sigma BLUR_SIGMA) and scaled to LIFT_KEEP, then added back only
#      inside the form's inner part (fists: alpha distance >= INNER x the form's max inner distance, feathered), so
#      it reads as a soft sheen instead of a hard-edged pale ellipse.
#   3. Ink specks: texels darker than their 9 px median by more than SPECK_DL, in connected components under
#      SPECK_AREA px, take the median colour (the broken 1 px ring / notch crumbs). Larger strokes stay.
# A report (max highlight lift before/after, specks removed, silhouette XOR) prints as JSON and lands next to the rig
# as <stem>.extremities.json.
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

HL_DL, LIFT_KEEP, BLUR_SIGMA, INPAINT_SIGMA = 10.0, 0.4, 3.0, 4.0
INNER = 0.3  # lift kept only where alpha distance >= 30 % of the max (the inner 70 % of the form)
SPECK_DL, SPECK_AREA = 6.0, 12
FIST_REGIONS = ("canonical/template7-fist", "canonical/template7-fist_r")
LEG_REGION, FOOT_ROW0 = "canonical/template7-leg-skin", 229  # leg-skin rows below this hold the two feet


def lum(a):
    return 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]


def polish(rgb, alpha, inner_mask):
    """rgb float HxWx3, alpha HxW uint8. Returns new rgb and stats."""
    op = alpha > 0
    L = lum(rgb)
    base_l = float(np.median(L[op]))
    hl = (L > base_l + HL_DL) & op
    hl = ndimage.binary_dilation(hl, iterations=2) & op
    lift_before = float((L - base_l)[hl].max()) if hl.any() else 0.0
    # inpaint the base under the highlight
    _, (iy, ix) = ndimage.distance_transform_edt(hl | ~op, return_indices=True)  # sources: opaque, non-highlight
    base = rgb[iy, ix]
    for c in range(3):
        sm = ndimage.gaussian_filter(base[..., c], INPAINT_SIGMA)
        base[..., c] = np.where(hl, sm, rgb[..., c])
    diff = np.where(hl[..., None], rgb - base, 0.0)
    soft = np.stack([ndimage.gaussian_filter(diff[..., c], BLUR_SIGMA) for c in range(3)], -1)
    out = base + LIFT_KEEP * soft * inner_mask[..., None]
    out = np.where(op[..., None], out, rgb)
    # ink specks
    Lo = lum(out)
    med = np.stack([ndimage.median_filter(out[..., c], 9) for c in range(3)], -1)
    dark = (Lo < lum(med) - SPECK_DL) & op
    lab, n = ndimage.label(dark, structure=np.ones((3, 3)))
    areas = ndimage.sum(dark, lab, range(1, n + 1)) if n else np.array([])
    small = np.isin(lab, 1 + np.flatnonzero(areas < SPECK_AREA)) & dark
    out = np.where(small[..., None], med, out)
    lift_after = float((lum(out) - base_l)[op].max())
    left = int((areas >= SPECK_AREA).sum())
    return np.clip(out, 0, 255), {"baseL": round(base_l, 2), "highlightPx": int(hl.sum()),
                                  "liftBefore": round(lift_before, 2), "liftAfter": round(lift_after, 2),
                                  "liftRatio": round(lift_after / lift_before, 3) if lift_before else None,
                                  "specksRemoved": int(n - left), "specksRemovedPx": int(small.sum()),
                                  "inkComponentsKept": left}


def fist_inner(alpha):
    d = ndimage.distance_transform_edt(alpha > 0)
    t = INNER * d.max()
    return np.clip((d - t) / 4.0 + 0.5, 0.0, 1.0)  # ~4 px feather around the inner boundary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rig")
    a = ap.parse_args()
    rig = Path(a.rig)
    atlas_p = rig.with_name(rig.name.replace(".anim.json", ".atlas.json"))
    atlas = json.loads(atlas_p.read_text(encoding="utf-8"))
    page = atlas["pages"][0]
    png = atlas_p.parent / page["file"]
    im = np.array(Image.open(png).convert("RGBA"))
    before_alpha = im[..., 3].copy()
    report = {}
    for name in FIST_REGIONS + (LEG_REGION,):
        r = page["regions"][name]
        x, y, w, h = r["x"], r["y"], r["width"], r["height"]
        if name == LEG_REGION:
            y, h = y + FOOT_ROW0, h - FOOT_ROW0
        sub = im[y:y + h, x:x + w]
        alpha = sub[..., 3]
        if name == LEG_REGION:
            # the leg skin is an opaque sheet; the feet's inner part = away from the highlight's own rim is enough,
            # so the lift is kept everywhere the blurred highlight reaches (the feet are far from the sheet edges)
            inner = np.ones(alpha.shape)
        else:
            inner = fist_inner(alpha)
        new, st = polish(sub[..., :3].astype(float), alpha, inner)
        sub[..., :3] = np.round(new).astype(np.uint8)
        report[name if name != LEG_REGION else "feet (" + name + ")"] = st
    xor = int(((before_alpha > 0) != (im[..., 3] > 0)).sum())
    assert xor == 0
    report["silhouetteXor"] = xor
    Image.fromarray(im).save(png)
    rig.with_name(rig.name.replace(".anim.json", ".extremities.json")).write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
