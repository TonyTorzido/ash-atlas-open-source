"""Build the compact world zone lookup used by the player-facing biome banner.

Land biomes are rasterized from the RESOLVE Ecoregions 2017 archive in the World pipeline checkout,
keeping the individual BIOME_NUM values that the V1 environment overlay merges into broader
categories (for example Mediterranean woodland vs desert). Elevation, ocean depth, and lakes come
from the committed V1 overlay masks in apps/client/src/assets/world-environment-overlays/:

    python tools/world-map/generate-world-zone-lookup.py --source-root <world-pipeline>

Each 2048 x 2048 Web Mercator pixel gets one zone code (see packages/shared/src/worldZones.ts):

    0            unknown
    1..75        land: 1 + (biomeClass - 1) * 5 + elevationBandIndex, where biomeClass is the
                 RESOLVE BIOME_NUM 1..14, or 15 for the "Rock and Ice" ecoregion, and the band is
                 low, moderate, high, extreme (Peaks), or summit
    97..100      ocean: 96 + depth band (nearshore, shallow, deep, abyssal)
    112          large lake (lake mask where no land biome and no ocean depth exists)

Rows are run-length encoded so the client can answer a point query without decoding an image.
Binary layout (little endian):

    "AAZL"  u16 version (2)  u16 width  u16 height  u16 reserved
    u32 rowStart[height + 1]   index of each row's first run
    u16 runEnd[runCount]       exclusive end x of each run
    u8  runCode[runCount]

The lookup is the presentation source and the land-biome source. Water (lake, coast, open ocean,
river) and shore tags are World-authoritative; the server resolves them from World and uses this
grid for water only when World is unavailable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import struct
from pathlib import Path

import numpy as np
import pyogrio
from PIL import Image
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from shapely.geometry import box

ROOT = Path(__file__).resolve().parents[2]
OVERLAYS = ROOT / "apps" / "client" / "src" / "assets" / "world-environment-overlays"
OUTPUT = OVERLAYS / "world-zone-lookup-v1.bin"
# Provenance sidecar: ties the lookup to the pinned World pipeline so drift fails a test.
PROVENANCE = OVERLAYS / "world-zone-lookup-v1.provenance.json"
RUNTIME_LOCK = ROOT / "config" / "world-runtime.lock.json"
ECOREGIONS = Path("data/raw/ecoregions/Ecoregions2017.zip")

MERCATOR_EXTENT_M = 20_037_508.342789244
MERCATOR_BOUNDS = (-MERCATOR_EXTENT_M, -MERCATOR_EXTENT_M, MERCATOR_EXTENT_M, MERCATOR_EXTENT_M)
SIZE = 2048
ROCK_AND_ICE_CLASS = 15
ELEVATION_BANDS = ("low", "moderate", "high", "extreme", "summit")
OCEAN_DEPTHS = ("nearshore", "shallow", "deep", "abyssal")
LAND_BASE = 1
OCEAN_BASE = 96
LAKE_CODE = 112
FILL_PASSES = 3


def mask(name: str) -> np.ndarray:
    pixels = np.array(Image.open(OVERLAYS / name)) > 0
    if pixels.shape != (SIZE, SIZE):
        raise SystemExit(f"{name} is not {SIZE}x{SIZE}")
    return pixels


def biome_classes(source_root: Path) -> np.ndarray:
    frame = pyogrio.read_dataframe(
        f"/vsizip/{(source_root / ECOREGIONS).as_posix()}/Ecoregions2017.shp",
        columns=["BIOME_NUM", "ECO_NAME"],
    ).to_crs("EPSG:3857")
    frame = frame.loc[frame["BIOME_NUM"].notna()]
    world = box(*MERCATOR_BOUNDS)
    shapes = []
    for geometry, biome, name in zip(frame.geometry, frame["BIOME_NUM"], frame["ECO_NAME"]):
        if geometry is None or geometry.is_empty:
            continue
        clipped = geometry.intersection(world)
        if clipped.is_empty:
            continue
        value = ROCK_AND_ICE_CLASS if name == "Rock and Ice" else int(biome)
        if not 1 <= value <= ROCK_AND_ICE_CLASS:
            raise SystemExit(f"unexpected RESOLVE biome {biome} for {name}")
        shapes.append((clipped, value))
    return rasterize(
        shapes,
        out_shape=(SIZE, SIZE),
        transform=from_bounds(*MERCATOR_BOUNDS, SIZE, SIZE),
        fill=0,
        dtype="uint8",
    )


def fill_gaps(code: np.ndarray) -> np.ndarray:
    """Give thin coastline gaps the nearest classified neighbour, preferring land."""
    code = code.copy()
    for _ in range(FILL_PASSES):
        empty = code == 0
        if not empty.any():
            break
        neighbours = [
            np.roll(code, 1, axis=1),
            np.roll(code, -1, axis=1),
            np.vstack([code[:1], code[:-1]]),
            np.vstack([code[1:], code[-1:]]),
        ]
        chosen = np.zeros_like(code)
        for neighbour in neighbours:
            land = (neighbour >= LAND_BASE) & (neighbour < LAND_BASE + 15 * len(ELEVATION_BANDS))
            chosen = np.where((chosen == 0) & land, neighbour, chosen)
        for neighbour in neighbours:
            chosen = np.where(chosen == 0, neighbour, chosen)
        code = np.where(empty, chosen, code)
    return code


def build_codes(source_root: Path) -> np.ndarray:
    biome = biome_classes(source_root)
    elevation = np.zeros_like(biome)
    for index, band in enumerate(ELEVATION_BANDS):
        elevation[mask(f"elevation--{band}.png")] = index
    ocean = np.zeros_like(biome)
    for index, depth in enumerate(OCEAN_DEPTHS, start=1):
        ocean[mask(f"ocean_depth--{depth}.png")] = index
    lake = mask("water--lakes.png")

    code = np.zeros(biome.shape, dtype=np.uint8)
    land = biome > 0
    code[land] = LAND_BASE + (biome[land].astype(np.int32) - 1) * len(ELEVATION_BANDS) + elevation[land]
    sea = ~land & (ocean > 0)
    code[sea] = OCEAN_BASE + ocean[sea]
    code[~land & (ocean == 0) & lake] = LAKE_CODE
    return fill_gaps(code)


def encode(code: np.ndarray) -> bytes:
    height, width = code.shape
    row_start = [0]
    run_end: list[int] = []
    run_code: list[int] = []
    for row in code:
        changes = np.flatnonzero(np.diff(row.astype(np.int16))) + 1
        ends = np.append(changes, width)
        run_end.extend(int(end) for end in ends)
        run_code.extend(int(row[end - 1]) for end in ends)
        row_start.append(len(run_end))
    header = b"AAZL" + struct.pack("<HHHH", 2, width, height, 0)
    return (
        header
        + np.asarray(row_start, dtype="<u4").tobytes()
        + np.asarray(run_end, dtype="<u2").tobytes()
        + np.asarray(run_code, dtype=np.uint8).tobytes()
    )


def pinned_pipeline_sha(source_root: Path) -> str:
    """Refuse to cook from a pipeline checkout other than the one config/world-runtime.lock.json pins."""
    expected = json.loads(RUNTIME_LOCK.read_text(encoding="utf-8"))["pipeline"]["sha"]
    actual = subprocess.run(
        ["git", "-C", str(source_root), "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    if actual != expected:
        raise SystemExit(f"pipeline checkout is {actual}, but the runtime lock pins {expected}")
    return actual


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the world zone lookup for the biome banner.")
    parser.add_argument("--source-root", type=Path, required=True, help="World pipeline checkout")
    source_root = parser.parse_args().source_root.resolve()
    pipeline_sha = pinned_pipeline_sha(source_root)
    code = build_codes(source_root)
    payload = encode(code)
    OUTPUT.write_bytes(payload)
    PROVENANCE.write_text(json.dumps({
        "file": OUTPUT.name,
        "formatVersion": 2,
        "sha256": hashlib.sha256(payload).hexdigest(),
        "fileSizeBytes": len(payload),
        "pipelineSha": pipeline_sha,
    }, indent=2) + "\n", encoding="utf-8")
    unknown = int((code == 0).sum())
    print(f"wrote {OUTPUT.relative_to(ROOT)} ({len(payload):,} bytes, {unknown:,} unknown pixels)")


if __name__ == "__main__":
    main()
