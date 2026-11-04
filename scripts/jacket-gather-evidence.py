"""Evidence for the Jacket B gathering clips (called by scripts/copy-jacket-gather.mjs --evidence).

Composites the in-game item art onto the rendered body frames exactly the way the client does (jacketGather.ts:
grip point on the exported transform, rotated so the art's up axis follows the item direction, mirrored so the
blade leads, behind or in front of the body per frame), then writes per clip and view a GIF and a contact sheet.
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

REPO = Path(__file__).resolve().parent.parent
TOOLS = REPO / "packages/player-renderer/src/assets/player-appearance/tools"
WEAPONS = REPO / "packages/player-renderer/src/assets/player-appearance/weapons"
FLAGS = REPO / "apps/client/src/assets/flags"
# Same table as apps/client/src/players/jacketGather.ts ITEM_ART: grip (normalized art point), canvas px per art px,
# mirror x (the blade / pick tip leads the swing on the unflipped L rig).
ITEMS = {
    "axe": dict(files=[TOOLS / "stone-axe.png"], grip=(0.496, 0.648), k=0.8, mx=-1),
    "pick": dict(files=[TOOLS / "stone-pickaxe.png"], grip=(0.496, 0.648), k=0.8, mx=-1),
    "pole": dict(files=[TOOLS / "starter-fishing-pole.png"], grip=(0.4966, 0.5098), k=1.03, mx=-1),
    "flag": dict(files=[FLAGS / "default-hardware.png", FLAGS / "default-cloth.png"], grip=(0.1208, 0.62), k=3.0, mx=-1),
    # The starter sword (the swag swords share its layout); same table as apps/client/src/players/jacketSword.ts.
    "sword": dict(files=[WEAPONS / "sword2.png"], grip=(0.5, 0.735), k=0.8, mx=-1),
}
FOOT_Y = 285  # canvas px below the origin: the front idle foot line
BG = (143, 163, 122, 255)
CLOTH = (58, 111, 216)


def item_art(name):
    spec = ITEMS[name]
    layers = [Image.open(f).convert("RGBA") for f in spec["files"]]
    art = layers[0]
    for extra in layers[1:]:
        r, g, b, a = extra.split()
        tinted = Image.merge("RGBA", (r.point(lambda v: v * CLOTH[0] // 255), g.point(lambda v: v * CLOTH[1] // 255),
                                      b.point(lambda v: v * CLOTH[2] // 255), a))
        art = Image.alpha_composite(art, tinted)
    return art, spec


def place(size, art, spec, gx, gy, deg, s, length=1.0):
    """The art placed with its grip on (gx, gy) output px, its up axis along canvas direction deg (scaled by length)."""
    aw, ah = art.size
    gu, gv = spec["grip"][0] * aw, spec["grip"][1] * ah
    th = math.radians(deg + 90)
    k = spec["k"] * s
    c, si = math.cos(th), math.sin(th)
    mx = spec["mx"]
    # output = G + k R M (u - g)  ->  u = g + M R^-1 (output - G) / k
    a = mx * c / k
    b = mx * si / k
    d = -si / (k * length)
    e = c / (k * length)
    return art.transform(size, Image.AFFINE, (a, b, gu - a * gx - b * gy, d, e, gv - d * gx - e * gy), resample=Image.BICUBIC)


def main():
    cfg = json.loads(Path(sys.argv[1]).read_text())
    out = Path(cfg["outDir"])
    composed = {}
    for job in cfg["jobs"]:
        clip = cfg["clips"][job["id"]]
        s, ox, oy = job["view"], job["ox"], job["oy"]
        files = sorted(Path(job["dir"]).glob("*.png"))
        art = item_art(clip["item"]) if clip["item"] else None
        frames = []
        for i, f in enumerate(files):
            body = Image.open(f).convert("RGBA")
            canvas = Image.new("RGBA", body.size, BG)
            draw = ImageDraw.Draw(canvas)
            gy = oy + FOOT_Y * s
            draw.line([(0, gy), (body.size[0], gy)], fill=(110, 128, 92, 255), width=2)
            xf = clip["xf"][min(i, len(clip["xf"]) - 1)]
            length = xf[5] if len(xf) > 5 else 1.0
            tool = place(body.size, art[0], art[1], ox + xf[0] * s, oy + xf[1] * s, xf[2], s, length) if art else None
            if tool is not None and xf[3] == 0:
                canvas = Image.alpha_composite(canvas, tool)
            canvas = Image.alpha_composite(canvas, body)
            if tool is not None and xf[3] == 1:
                canvas = Image.alpha_composite(canvas, tool)
            frames.append(canvas)
        # Crop to the union of everything drawn that is not background.
        box = None
        for im in frames:
            dif = ImageChops.difference(im.convert("RGB"), Image.new("RGB", im.size, BG[:3]))
            gy = round(job["oy"] + FOOT_Y * s)
            ImageDraw.Draw(dif).rectangle([0, gy - 2, im.size[0], gy + 2], fill=(0, 0, 0))  # the ground line
            bb = dif.getbbox()
            if bb:
                box = bb if box is None else (min(box[0], bb[0]), min(box[1], bb[1]), max(box[2], bb[2]), max(box[3], bb[3]))
        composed[(job["id"], job["view"])] = (frames, box)
        write(out, f"{job['id']}-{job['view']}", frames, box, [clip["contact"]])
    # The whole combo as one loop (each step played to its end, then the next), with one crop for all steps.
    seq = cfg.get("sequence")
    if seq:
        for view in sorted({job["view"] for job in cfg["jobs"]}):
            parts = [composed[(cid, view)] for cid in seq["clips"]]
            frames, box, contacts, start = [], None, [], 0
            for cid, (fr, bb) in zip(seq["clips"], parts):
                frames += fr
                box = bb if box is None else (min(box[0], bb[0]), min(box[1], bb[1]), max(box[2], bb[2]), max(box[3], bb[3]))
                contacts.append(start + cfg["clips"][cid]["contact"])
                start += len(fr)
            write(out, f"{seq['id']}-{view}", frames, box, contacts)


def write(out, stem, frames, box, contacts):
    pad = 12
    box = (max(0, box[0] - pad), max(0, box[1] - pad), min(frames[0].size[0], box[2] + pad), min(frames[0].size[1], box[3] + pad))
    frames = [im.crop(box) for im in frames]
    rgb = [im.convert("RGB") for im in frames]
    rgb[0].save(out / f"{stem}.gif", save_all=True, append_images=rgb[1:], duration=1000 // 30 + 1, loop=0, optimize=True)
    # Contact sheet: every frame, numbered; the contact frame(s) outlined red.
    cols = 10
    w, h = frames[0].size
    rows = math.ceil(len(frames) / cols)
    sheet = Image.new("RGB", (cols * w, rows * (h + 16)), (40, 44, 52))
    dr = ImageDraw.Draw(sheet)
    for i, im in enumerate(rgb):
        x, y = (i % cols) * w, (i // cols) * (h + 16)
        sheet.paste(im, (x, y + 16))
        hit = i in contacts
        dr.text((x + 4, y + 2), f"f{i}{'  CONTACT' if hit else ''}", fill=(255, 90, 90) if hit else (230, 230, 230))
        if hit:
            dr.rectangle([x, y + 16, x + w - 1, y + 16 + h - 1], outline=(255, 60, 60), width=3)
    sheet.quantize(colors=256, method=Image.Quantize.MEDIANCUT).save(out / f"{stem}-sheet.png", optimize=True)
    print(f"evidence {stem}: {len(frames)} frames, {w}x{h}")


if __name__ == "__main__":
    main()
