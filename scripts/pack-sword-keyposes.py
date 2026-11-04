"""Packs the drawn sword key poses (docs/plans/player-sword-keyposes/cutouts, rig scale 0.6) into the client sheet.

  python scripts/pack-sword-keyposes.py [--set <armour>]

Writes apps/client/src/assets/player-rig/jacketb-sword/keyposes-<page>.png (8-bit palette, like the body sheets) and
the `keyposes` entry of jacketb-sword.json (the sword walk entry written by `copy-jacket-gather.mjs --set sword` is
kept):
  keyposes.view   SheetView of the L sheet (the R side is the same frames image-flipped, like the R clips)
  keyposes.poses  per pose: cell (frame index), grip (rig units from the root, y down), deg (canvas direction grip ->
                  tip), len (blade foreshortening), bladeFront (the drawn blade crossed in front of the body: the client
                  draws the equipped blade, guard to tip, over the body too; the fist stays over the handle)
Scale 0.42, as the body sheets. Root = the rig root (cutouts: canvas centre column, 1500 rig units from the top).

--set <armour> (a stock armour id, e.g. breastplate): the same 10 poses redrawn in that armour
(docs/plans/player-sword-keyposes/<armour>/, built by `build_preview.py --set <armour>`) -> apps/client/src/assets/
player-rig/stock-armour-sword/<armour>/keyposes-<page>.png + <armour>-sword.json ({scale, fps, keyposes}), a drop-in
for the Jacket B set (jacketSword.ts picks it while that armour is worn). A pose whose drawn grip and blade match the
Jacket B pose (within GRIP_TOL rig units and DEG_TOL degrees) keeps the Jacket B grip / deg / len, so the sword and
the slash trail are identical; any other pose uses its own measured values and is flagged.

--set class-<style>[-<armour>] (2026-10-21 class combos, docs/plans/player-sword-keyposes/class-combos.md): a sword
style's poses in the tank top (class-generic, class-ronin) or redrawn in a stock armour (class-ronin-leather, ...) ->
apps/client/src/assets/player-rig/sword-poses/<style>-<look>/keyposes-<page>.png + <style>-<look>-sword.json
({style, look, scale, fps, keyposes}; look = "tank" or the armour). An armour pose whose drawn grip and blade match
the style's tank-top pose (GRIP_TOL / DEG_TOL / LEN_TOL) keeps the tank-top grip data (identical sword and trail);
any other pose, and every tank-top pose, uses its own measured data.

--weapon axe --set class-<style> [--src <dir>] (2026-10-21 axe combos, docs/plans/player-axe-keyposes/axe-combos.md): an
axe style's tank-top poses (class-generic, class-warrior; same cutout / keyposes.json format, grip = the fist on the axe
wrap, deg = grip -> head) -> apps/client/src/assets/player-rig/axe-poses/axe-<style>-tank/keyposes-<page>.png +
axe-<style>-tank-axe.json ({format, weapon, style: "axe-<style>", look, scale, fps, combo, keyposes}); `combo` is the
art drop's combo.json timing (swings, sweep, flat) so the client test catches a timing change in a re-drawn drop.
Each pose carries the art drop's `butt` (rig units of haft past the grip; the client clips the held axe there).
--src is the folder holding class-<style>/ (default docs/plans/player-axe-keyposes); re-run with the fixed art to swap it.
"""
import argparse
import json
import math
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "docs/plans/player-sword-keyposes"
OUT = REPO / "apps/client/src/assets/player-rig/jacketb-sword"
JACKETB_SRC = SRC
GRIP_TOL, DEG_TOL, LEN_TOL = 20.0, 5.0, 0.05
SRC_SCALE, SCALE = 0.6, 0.42
CW, CR = 1700, 1500  # cutout canvas width / root row in rig units (build_preview.py)
PAGE_MAX = 2048
POSES = ["00-ready", "11-swing1-windup", "12-swing1-hit", "13-swing1-follow", "21-swing2-windup", "22-swing2-hit",
         "23-swing2-follow", "31-swing3-windup", "32-swing3-hit", "33-swing3-follow"]
# The drawn blade counts as in front of the body when this many rig-unit^2 of it, past the fist, covered the body.
FRONT_MIN_AREA = 500
FIST_R = 110  # rig units around the grip that belong to the fist / handle


def premul_resize(im, size):
    a = np.asarray(im.convert("RGBA")).astype(np.float32) / 255
    pm = np.dstack([a[..., :3] * a[..., 3:4], a[..., 3:4]])
    chans = [Image.fromarray(pm[..., i]).resize(size, Image.LANCZOS) for i in range(4)]
    r = np.dstack([np.asarray(c) for c in chans]).clip(0, 1)
    al = r[..., 3:4]
    rgb = np.where(al > 1e-4, r[..., :3] / np.maximum(al, 1e-4), 0)
    return np.dstack([rgb, al]).clip(0, 1) * 255


def main():
    global SRC, OUT, POSES
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default="jacketb")
    ap.add_argument("--weapon", choices=["sword", "axe"], default="sword")
    ap.add_argument("--src", default=None, help="axe only: the folder holding class-<style>/")
    args = ap.parse_args()
    item = args.set
    style = look = None
    base_name = "Jacket B"
    combo = None
    if args.weapon == "axe":
        if not item.startswith("class-") or "-" in item[len("class-"):]:
            raise SystemExit("--weapon axe packs a tank-top style set: --set class-<style> (armour variants come later)")
        style, look = "axe-" + item[len("class-"):], "tank"
        SRC = (Path(args.src) if args.src else REPO / "docs/plans/player-axe-keyposes") / item
        OUT = REPO / "apps/client/src/assets/player-rig/axe-poses" / f"{style}-{look}"
        OUT.mkdir(parents=True, exist_ok=True)
        base = None
        c = json.loads((SRC / "combo.json").read_text())
        combo = dict(swings=c["swings"], sweep=c["sweep"], flat=c["flat"])
    elif item.startswith("class-"):
        style, _, look = item[len("class-"):].partition("-")
        look = look or "tank"
        SRC = JACKETB_SRC / item
        OUT = REPO / "apps/client/src/assets/player-rig/sword-poses" / f"{style}-{look}"
        OUT.mkdir(parents=True, exist_ok=True)
        base = None if look == "tank" else JACKETB_SRC / f"class-{style}"
        base_name = f"the {style} tank top"
    elif item != "jacketb":
        SRC = JACKETB_SRC / item
        OUT = REPO / "apps/client/src/assets/player-rig/stock-armour-sword" / item
        OUT.mkdir(parents=True, exist_ok=True)
        base = JACKETB_SRC
    else:
        base = None
    data = json.loads((SRC / "keyposes.json").read_text())["poses"]
    if "90-raise" in data and "90-raise" not in POSES:
        POSES = POSES + ["90-raise"]  # the Ronin flow's in-between raise, where the set has it
    # the Ronin guard walk's drawn frames, where the set has them
    POSES = POSES + sorted((k for k in data if k.startswith("walk-") and k not in POSES), key=lambda n: int(n.split("-")[1]))
    jb = json.loads((base / "keyposes.json").read_text())["poses"] if base else None
    k = SCALE / SRC_SCALE
    cells, poses = [], {}
    for i, name in enumerate(POSES):
        cut = Image.open(SRC / f"cutouts/pose-{name}.png")
        front = np.asarray(Image.open(SRC / f"cutouts/pose-{name}-front.png")) > 128
        body = np.asarray(cut)[..., 3] > 128
        d = data[name]
        if jb is not None:
            j = jb[name]
            dgrip = math.hypot(d["grip"][0] - j["grip"][0], d["grip"][1] - j["grip"][1])
            ddeg = abs((d["deg"] - j["deg"] + 180) % 360 - 180)
            same = dgrip <= GRIP_TOL and ddeg <= DEG_TOL and abs(d["len"] - j["len"]) <= LEN_TOL
            print(f"{name}: grip off {base_name} by {dgrip:.1f} u, blade {ddeg:.1f} deg, len {d['len'] - j['len']:+.3f} -> "
                  f"{base_name + ' grip data' if same else 'OWN grip data (FLAG: the pose moved the sword)'}")
            if same:
                d = dict(d, grip=j["grip"], deg=j["deg"], len=j["len"])
        gx, gy = cut.width / 2 + d["grip"][0] * SRC_SCALE, CR * SRC_SCALE + d["grip"][1] * SRC_SCALE
        ys, xs = np.nonzero(front & body)
        far = np.hypot(xs - gx, ys - gy) > FIST_R * SRC_SCALE
        area = float(far.sum()) / SRC_SCALE ** 2
        size = (round(cut.width * k), round(cut.height * k))
        cells.append(premul_resize(cut, size))
        poses[name] = dict(cell=i, grip=d["grip"], deg=d["deg"], len=d["len"], bladeFront=bool(area >= FRONT_MIN_AREA))
        if combo is not None and "butt" in d:
            poses[name]["butt"] = round(float(d["butt"]), 1)  # axe: rig units of haft drawn past the grip (the client clips there)
        print(f"{name}: blade-over-body {area:.0f} u^2 -> bladeFront {poses[name]['bladeFront']}")
    h0, w0 = cells[0].shape[:2]
    rx, ry = w0 / 2, CR * SCALE
    alpha = np.max([c[..., 3] for c in cells], axis=0) > 0
    ys, xs = np.nonzero(alpha)
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max(), ys.max()
    w, h = x1 - x0 + 2, y1 - y0 + 2
    cols = max(1, PAGE_MAX // w)
    per_page = cols * max(1, PAGE_MAX // h)
    for f in OUT.glob("keyposes-*.png"):
        f.unlink()
    pages, frames = [], []
    for p in range(math.ceil(len(cells) / per_page)):
        chunk = cells[p * per_page:(p + 1) * per_page]
        pw, ph = min(cols, len(chunk)) * w, math.ceil(len(chunk) / cols) * h
        page = np.zeros((ph, pw, 4), np.float32)
        for j, c in enumerate(chunk):
            cx, cy = (j % cols) * w, (j // cols) * h
            page[cy:cy + h - 1, cx:cx + w - 1] = c[y0:y1 + 1, x0:x1 + 1]
            frames.append([int(p), int(cx), int(cy)])
        file = f"keyposes-{p}.png"
        Image.fromarray(page.round().astype(np.uint8)).save(OUT / file)
        pages.append(file)
    # 8-bit palette, the same libimagequant settings as the body sheets (copy-jacket-gather.mjs).
    js = ("const sharp=require('sharp');(async()=>{for(const f of process.argv.slice(1)){const b=await sharp(f).png({palette:true,"
          "colours:256,quality:100,dither:1,effort:10,compressionLevel:9}).toBuffer();require('fs').writeFileSync(f,b);}})()")
    subprocess.run(["node", "-e", js, *[str(OUT / f) for f in pages]], check=True, cwd=REPO / "apps/client")
    view = dict(flip=False, frameWidth=int(w), frameHeight=int(h), rootX=round(rx - x0, 2), rootY=round(ry - y0, 2),
                pages=pages, frames=frames)
    if combo is not None:
        mpath = OUT / f"{style}-{look}-axe.json"
        jbm = json.loads((REPO / "apps/client/src/assets/player-rig/jacketb-sword/jacketb-sword.json").read_text())
        manifest = dict(format="axe-keyposes@1", weapon="axe", style=style, look=look, scale=jbm["scale"], fps=jbm["fps"],
                        combo=combo)
    elif item == "jacketb":
        mpath = OUT / "jacketb-sword.json"
        manifest = json.loads(mpath.read_text())
    elif style:
        mpath = OUT / f"{style}-{look}-sword.json"
        jbm = json.loads((REPO / "apps/client/src/assets/player-rig/jacketb-sword/jacketb-sword.json").read_text())
        manifest = dict(format="sword-keyposes@2", style=style, look=look, scale=jbm["scale"], fps=jbm["fps"])
    else:
        mpath = OUT / f"{item}-sword.json"
        jbm = json.loads((REPO / "apps/client/src/assets/player-rig/jacketb-sword/jacketb-sword.json").read_text())
        manifest = dict(format="sword-keyposes@1", armour=item, scale=jbm["scale"], fps=jbm["fps"])
    manifest["keyposes"] = dict(view=view, poses=poses)
    mpath.write_text(json.dumps(manifest, separators=(",", ":")) + "\n")
    size = sum((OUT / f).stat().st_size for f in pages)
    texels = sum(Image.open(OUT / f).width * Image.open(OUT / f).height for f in pages)
    print(f"keyposes: {len(cells)} poses, cell {w}x{h}, {len(pages)} page(s), {size / 1048576:.2f} MB PNG, "
          f"{texels * 4 / 1048576:.1f} MB RGBA (+1/3 mipmaps)")


if __name__ == "__main__":
    main()
