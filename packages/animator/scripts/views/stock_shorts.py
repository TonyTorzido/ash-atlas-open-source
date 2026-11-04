# Atlas Animator five-anims (2026-10-19): the STOCK look's dark shorts stand-in. There is no black-pants garment on
# the rig yet, so every shorts texture is recoloured to charcoal with the proto-face-hair.ts rule (luminance
# l = 0.3 r + 0.59 g + 0.11 b, v = round(30 + l / 255 x 42), rgb = (v, v, v + 3), alpha kept). It reads as dark
# shorts, NOT knee-length pants. The rig JSON is copied unchanged (animations included).
#
#   python scripts/views/stock_shorts.py <rig.anim.json> <out dir> <out stem>   (run from packages/animator)
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


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
    page = atlas["pages"][0]
    img = np.asarray(Image.open(src.parent / page["file"]).convert("RGBA")).copy()
    paths = set()
    for skin in doc["skins"].values():
        for att in skin["attachments"].get("shorts", {}).values():
            paths.add(att.get("path"))
    for p in sorted(paths):
        r = page["regions"][p]
        sub = img[r["y"]:r["y"] + r["height"], r["x"]:r["x"] + r["width"]].astype(np.float32)
        lum = 0.3 * sub[..., 0] + 0.59 * sub[..., 1] + 0.11 * sub[..., 2]
        v = np.round(30 + lum / 255 * 42)
        sub[..., 0], sub[..., 1], sub[..., 2] = v, v, v + 3
        img[r["y"]:r["y"] + r["height"], r["x"]:r["x"] + r["width"]] = sub.astype(np.uint8)
    doc["name"] = a.stem
    (out / f"{a.stem}.anim.json").write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    page["file"] = f"{a.stem}.atlas.png"
    (out / f"{a.stem}.atlas.json").write_text(json.dumps(atlas, indent=1), encoding="utf-8")
    Image.fromarray(img).save(out / f"{a.stem}.atlas.png")
    print(a.stem, "charcoal shorts:", sorted(paths))


if __name__ == "__main__":
    main()
