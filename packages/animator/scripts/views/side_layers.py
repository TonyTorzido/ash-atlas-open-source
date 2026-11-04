# Atlas Animator multi-view, phase 2b (packages/animator/README.md): the turned-side body separated into
# preservation-first part layers, the front layered-parts pipeline's way (step A).
#
#   npx tsx src/cli/animator.ts layers plan fixtures/canonical/body-side/body-side.png \
#       --rig <side rig.anim.json> --parts fixtures/canonical/body-side/layers/side-layers.parts.json --out <plan dir>
#   python scripts/views/side_layers.py <plan dir>
#
# The plan (seeded watershed on the side art, each drawn line owned by the part in front, completion masks for the
# part behind at every joint) gives per part a visible mask and a completion mask. This script, deterministic, no AI:
#   <part>.full.png   the part's whole shape: visible + its uncertain border + completion, holes filled, one component;
#   <part>.layer.png  full-canvas RGBA layer: the art's own bytes on the visible pixels; the completion (hidden at rest:
#                     the far arm's upper arm and the legs' tops under the torso, the torso under the near arm) filled
#                     by hidden-texel fill = the colour of the nearest visible fill texel of the same part (no ink, no
#                     anti-aliased rim; a limb only its skin), so tank continues as tank, skin as skin, shorts as shorts.
# Written next to the parts spec (fixtures/canonical/body-side/layers/); side_presets.py traces the presets from them.
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = Path(__file__).resolve().parents[2]
OUT = HERE / "fixtures/canonical/body-side/layers"
ART = HERE / "fixtures/canonical/body-side/body-side.png"
INK = 90  # luminance below this is line ink (paintFromArt's own test)
RIM = 4  # px around ink that are anti-aliased rim, not fill
GREY_REACH = 14  # trim ink is taken only this close to the torso's own pixels (not the limbs' far outline rims)
GREY_LUM, GREY_SAT = 150, 28  # garment trim ink: dark and unsaturated (the brown body outline is saturated)
SKIN_TOL = 60  # L1 RGB distance from a limb's median fill colour (its skin, shading included)


def load_mask(p):
    return np.array(Image.open(p).convert("L")) >= 128


def comp_extra(vis, vis_of):
    """A limb behind the torso continues under the garment ink taken from it (the hidden strip is completed as skin)."""
    grown = ndimage.binary_dilation(vis, iterations=6)
    return grown & vis_of["torso"] & ~vis & ndimage.binary_fill_holes(grown)


def main():
    plan_dir = Path(sys.argv[1])
    plan = json.loads((plan_dir / "plan.json").read_text())
    art = np.array(Image.open(ART).convert("RGBA"))
    lum = 0.3 * art[..., 0] + 0.59 * art[..., 1] + 0.11 * art[..., 2]
    report = {}
    m = plan_dir / "masks"
    # garment ink belongs to the garment (paintFromArt's ownership rule): the tank's armhole trim and the shorts' hem
    # band are grey (unsaturated) ink; where the watershed gave them to a limb they move to the torso (the limb keeps
    # its own brown outline), so raising the arm or lifting a leg never carries a piece of the tank or the hem.
    rgb = art[..., :3].astype(int)
    grey = (art[..., 3] > 0) & (lum < GREY_LUM) & (rgb.max(axis=2) - rgb.min(axis=2) < GREY_SAT)
    grey = ndimage.binary_dilation(grey, iterations=1) & (art[..., 3] > 0) & (lum < GREY_LUM + 40)
    moved = {}
    vis_of = {}
    for part in plan["drawOrder"]:
        vis_of[part] = load_mask(m / f"{part}.visible.png") | (load_mask(m / f"{part}.uncertain.png") & (art[..., 3] > 0))
    near_torso = ndimage.binary_dilation(vis_of["torso"], iterations=GREY_REACH)
    for part in plan["drawOrder"]:
        if part != "torso":
            g = vis_of[part] & grey & near_torso & ~ndimage.binary_erosion(art[..., 3] > 0, iterations=0) | (vis_of[part] & grey & near_torso & (art[..., 3] >= 250))
            g = ndimage.binary_opening(g, iterations=1) | (g & ndimage.binary_dilation(ndimage.binary_opening(g, iterations=1), iterations=2))
            moved[part] = int(g.sum())
            vis_of[part] &= ~g
            vis_of["torso"] |= g
    for part in plan["drawOrder"]:
        vis = vis_of[part]
        behind = plan["drawOrder"].index(part) < plan["drawOrder"].index("torso")
        comp = load_mask(m / f"{part}.completion.png") | (comp_extra(vis, vis_of) if behind else False)
        full = ndimage.binary_fill_holes(vis | comp)
        lab, n = ndimage.label(full)
        if n > 1:
            sizes = ndimage.sum(full, lab, range(1, n + 1))
            full = lab == (1 + int(np.argmax(sizes)))
        hidden = full & ~vis
        # fill sources: the part's own fill texels (not line ink, not the anti-aliased rim within RIM px of ink, not
        # the shared border); a limb takes only texels near its dominant skin colour (no tank or shorts crumbs)
        ink = (lum < INK) & (art[..., 3] > 0)
        rim = ndimage.distance_transform_edt(~ink) < RIM
        src = ndimage.binary_erosion(vis, iterations=3) & ~rim & (art[..., 3] >= 250)
        if part != "torso":
            med = np.median(art[src][:, :3].astype(float), axis=0)
            src &= np.abs(art[..., :3].astype(float) - med).sum(axis=2) <= SKIN_TOL
        _, (iy, ix) = ndimage.distance_transform_edt(~src, return_indices=True)
        layer = np.zeros_like(art)
        layer[vis] = art[vis]
        layer[hidden, :3] = art[iy[hidden], ix[hidden], :3]
        layer[hidden, 3] = 255
        Image.fromarray((full * 255).astype(np.uint8)).save(OUT / f"{part}.full.png")
        Image.fromarray(layer).save(OUT / f"{part}.layer.png")
        report[part] = {"visible": int(vis.sum()), "hidden": int(hidden.sum()), "full": int(full.sum()), "greyInkToTorso": moved.get(part, 0)}
    (OUT / "layers.report.json").write_text(json.dumps({"plan": "animator layers plan (side-layers.parts.json)", "parts": report}, indent=1) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
