#!/usr/bin/env python3
"""Downscale the one-handed-sword art to the small PNGs the player's held / sheathed sword draws from.

The 1024 px weapon art is drawn about 26 css px tall (~13-19x smaller) and rotated at runtime, so bilinear sampling of the
full-size art skips most texels and near-vertical blade edges come out jagged. These copies are shrunk once, offline, with
a Lanczos filter in linear light on premultiplied alpha (no dark fringe, no gamma shift), to 192 px (blade ~157 px, about
2x its largest on-screen device-pixel length at DPR 3). The whole canvas is scaled uniformly, so the grip anchor and the
blade fractions (apps/client/src/players/jacketSword.ts SWORD_ART) are unchanged; the 16 px of transparent margin above the
tip stays.

Axes (2026-10-21): the one-handed-axe art gets the same treatment into axe-held/ (the held / back axe, jacketSword.ts
AXE_ART); the grip anchor (0.496, 0.648) is unchanged by the uniform scale.

Usage: python scripts/make-held-sword-art.py [--size 192]
Output: apps/client/src/assets/player-rig/{sword,axe}-held/<asset key with "/" as "__", no "weapons/">.png
Sources: every one-handed-sword / one-handed-axe appearance with its own assetKey in
packages/shared/src/data/player-appearance-catalog.json.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "packages/player-renderer/src/assets/player-appearance"
CATALOG = ROOT / "packages/shared/src/data/player-appearance-catalog.json"
OUTS = {"one_handed_sword": ROOT / "apps/client/src/assets/player-rig/sword-held",
        "one_handed_axe": ROOT / "apps/client/src/assets/player-rig/axe-held"}


def to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def shrink(im: Image.Image, size: int) -> Image.Image:
    a = np.asarray(im.convert("RGBA"), dtype=np.float64) / 255.0
    alpha = a[..., 3]
    lin = to_linear(a[..., :3]) * alpha[..., None]  # premultiplied, linear light
    planes = [lin[..., 0], lin[..., 1], lin[..., 2], alpha]
    out = [np.asarray(Image.fromarray(p.astype(np.float32)).resize((size, size), Image.LANCZOS), dtype=np.float64) for p in planes]
    oa = np.clip(out[3], 0.0, 1.0)
    rgb = np.stack(out[:3], axis=-1)
    with np.errstate(divide="ignore", invalid="ignore"):
        rgb = np.where(oa[..., None] > 1e-5, rgb / np.maximum(oa[..., None], 1e-5), 0.0)
    rgb = to_srgb(np.clip(rgb, 0.0, 1.0))
    rgb = np.where(oa[..., None] > 1e-5, rgb, 0.0)
    res = np.dstack([rgb, oa])
    return Image.fromarray(np.round(res * 255.0).astype(np.uint8))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", type=int, default=192)
    size = ap.parse_args().size
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    for family, out_dir in OUTS.items():
        keys = sorted({a["assetKey"] for a in catalog["appearances"] if a.get("familyId") == family and a.get("assetKey")})
        out_dir.mkdir(parents=True, exist_ok=True)
        for key in keys:
            out = shrink(Image.open(ART / key), size)
            name = key.removeprefix("weapons/").replace("/", "__")
            out.save(out_dir / name, optimize=True)
            print(f"{key} -> {out_dir.name}/{name} {out.size} bbox={out.getchannel('A').getbbox()}")


if __name__ == "__main__":
    main()
