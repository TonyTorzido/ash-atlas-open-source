# Atlas Animator multi-view swag, step 1 (docs/plans/atlas-animator-views.md): the design spec extractor.
#   python spec_extract.py <item.json> [<out design.json>]
# <item.json> (authored, fixtures/views/<item>.item.json): the approved front PNG, its domain and the design facts
# measurement cannot know (the per-view presence table, mirror policy). Writes <item>.design.json with:
#   palette   <= 8 Lab colours with roles (ink = the domain stroke colour; fabric x4, trim x3 by k-means),
#   bands     collar / cuff / hem / placket widths from the front's trim-mask runs,
#   landmarks per view (front measured; back = the front silhouette with the presence table applied; side = phase 2),
#   motif     brocade density and nearest-neighbour CV,
#   presence  per view, mirrorSafe, and the quantiser check (the palette pass must leave the front unchanged).
import sys
from pathlib import Path
import numpy as np
from common import (DROPS, FABRIC_ROLES, TRIM_ROLES, bands, kmeans_lab, load, masks, materials, motifs, outline_width,
                    palette_remap, role_medians, save_json, to_lab, underarm_apexes, from_lab, de00)

REPO = Path(__file__).resolve().parents[2]


def resolve(p):
    return Path(str(p).replace("ART_DROPS", str(DROPS))) if str(p).startswith("ART_DROPS") else (REPO / p)


def extract_palette(a, m, ink_hex):
    mat = materials(a, m)
    lab = to_lab(a[..., :3])
    deep = m["dt"] > 2  # skip the antialiased rim
    ink = np.array([int(ink_hex[i:i + 2], 16) for i in (0, 2, 4)])
    pal = [dict(role="ink", source="domain stroke", rgb=ink.tolist(), lab=to_lab(ink[None])[0].round(2).tolist())]
    for roles, sel in ((FABRIC_ROLES, mat["fabric"] & deep), (TRIM_ROLES, mat["trim"] & deep)):
        cen = kmeans_lab(lab[sel][::3], len(roles))
        for r, c in zip(roles, cen):
            pal.append(dict(role=r, rgb=from_lab(c[None])[0].tolist(), lab=c.round(2).tolist()))
    return pal


def landmarks_front(a, m, b):
    ap = underarm_apexes(m["A"])
    cuffs = {("l" if c["cx"] < b["mid"] else "r"): dict(top=c["y0"], bottom=c["y1"], cx=c["cx"], cy=c["cy"]) for c in b["cuff"]}
    return dict(collarCentre=[b["mid"], min([c["y0"] for c in b["collar"]], default=None)], collarBottom=b["collarBottom"],
                hemTop=b["hemTop"], hemBottom=max([c["y1"] for c in b["hem"]], default=None), cuff=cuffs, armpitApex=ap,
                placketX=b["placket"]["x"] if b["placket"] else None, frogs=b["frogs"])


def view_landmarks(front, presence):
    lm = dict(front)
    if not presence.get("placket"):
        lm["placketX"] = None
    if not presence.get("frogs"):
        lm["frogs"] = []
    return lm


def quantiser_check(a, pal, m):
    """The palette pass on the approved front must be a no-op, and must undo a deliberate colour drift."""
    same, offs = palette_remap(a, pal, m)
    A = m["A"]
    d0 = np.abs(same[..., :3].astype(int) - a[..., :3].astype(int))[A].max(1)
    # damaged control: the side view's warm drift from the first test (median (54,35,37) vs (49,41,49))
    warm = a.copy()
    warm[..., :3] = np.clip(a[..., :3].astype(int) + np.array([5, -6, -12]), 0, 255).astype(np.uint8)
    fixed, _ = palette_remap(warm, pal, masks(warm))
    lab0, lab1, lab2 = to_lab(a[..., :3])[A], to_lab(warm[..., :3])[A], to_lab(fixed[..., :3])[A]
    return dict(frontMaxChannelChange=int(d0.max()), frontMeanChannelChange=round(float(d0.mean()), 3),
                frontOffsetsDE=round(max(float(np.linalg.norm(v)) for v in offs.values()), 3),
                warmDriftMeanDE76=round(float(np.linalg.norm(lab1 - lab0, axis=1).mean()), 2),
                warmDriftAfterRemapMeanDE76=round(float(np.linalg.norm(lab2 - lab0, axis=1).mean()), 2),
                visuallyUnchanged=bool(d0.max() <= 2))


def calibrate_palette(a, pal, m):
    """Within-front spread of the role medians (left half vs right half, torso vs sleeves): the gate threshold must
    pass the approved front with margin."""
    A = m["A"]
    ys, xs = np.nonzero(A)
    mid = (xs.min() + xs.max()) / 2
    X = np.arange(a.shape[1])[None, :].repeat(a.shape[0], 0)
    left, right = A & (X < mid), A & (X >= mid)
    torso, sleeves = A & (np.abs(X - mid) < 110), A & (np.abs(X - mid) >= 110)
    worst = 0.0
    for r1, r2 in ((left, right), (torso, sleeves)):
        m1, m2 = role_medians(a, pal, m, r1), role_medians(a, pal, m, r2)
        for k in m1:
            if m1[k]["lab"] and m2[k]["lab"] and m1[k]["n"] > 500 and m2[k]["n"] > 500:
                worst = max(worst, de00(m1[k]["lab"], m2[k]["lab"]))
    # dE00 3 when the front passes it with >= 1.5x margin, otherwise the front's own spread x 1.5
    thr = 3.0 if worst * 1.5 <= 3.0 else round(worst * 1.5, 1)
    return dict(frontSpreadDE00=round(worst, 2), thresholdDE00=thr, rule="dE00 3 if the front's own half/half and torso/sleeve role spread x1.5 fits under it, else spread x1.5; dE76 6 reported alongside")


def extract(item_path):
    item = __import__("json").load(open(item_path, encoding="utf-8"))
    front = resolve(item["front"])
    domain = __import__("json").load(open(resolve(item["domain"]), encoding="utf-8"))
    a = load(front)
    m = masks(a)
    b = bands(a, m)
    pal = extract_palette(a, m, domain["stroke"]["color"][:6])
    mo = motifs(a, m)
    lmf = landmarks_front(a, m, b)
    # mirror symmetry of the trim layout about the placket / centre column (asymmetric designs leave the mirrored catalogue)
    t = nd_mirror_iou(m["trim"], int(round(b["mid"])))
    spec = dict(
        format="atlas-design-spec/1", item=item["item"], front=item["front"], domain=item["domain"], canvas=[a.shape[1], a.shape[0]],
        palette=pal,
        bands=dict(collar=max([c["width"] for c in b["collar"]], default=None), cuff=max([c["width"] for c in b["cuff"]], default=None),
                   hem=max([c["width"] for c in b["hem"]], default=None), placket=b["placket"]["width"] if b["placket"] else None),
        outlineWidth=round(outline_width(a, m), 2),
        motif=dict(count=mo["count"], densityPer10k=round(mo["densityPer10k"], 3), nnCV=round(mo["nnCV"], 3) if mo["nnCV"] else None, gridAlign=round(mo["gridAlign"], 3) if mo["gridAlign"] is not None else None,
                   centres=mo["centres"], rule=item.get("motif")),
        presence=item["presence"],
        landmarks={v: (view_landmarks(lmf, item["presence"][v]) if v in ("front", "back") else None) for v in item["presence"]},
        mirrorSafe=dict(authored=item["mirrorSafe"], trimMirrorIoU=round(t, 3)),
        quantiser=quantiser_check(a, pal, m),
        paletteGate=calibrate_palette(a, pal, m),
    )
    return spec


def nd_mirror_iou(mask, cx):
    w = min(cx, mask.shape[1] - cx - 1)
    l = mask[:, cx - w:cx + 1]
    r = mask[:, cx:cx + w + 1][:, ::-1]
    return float((l & r).sum() / max(1, (l | r).sum()))


if __name__ == "__main__":
    item = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else str(Path(item).with_name(Path(item).name.replace(".item.json", ".design.json")))
    spec = extract(item)
    save_json(out, spec)
    print("wrote", out)
    print("palette", [(p["role"], p["rgb"]) for p in spec["palette"]])
    print("bands", spec["bands"], "outline", spec["outlineWidth"], "motif", {k: v for k, v in spec["motif"].items() if k != "centres"})
    print("quantiser", spec["quantiser"])
    print("paletteGate", spec["paletteGate"])
