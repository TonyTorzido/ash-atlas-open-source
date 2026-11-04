from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import write as write_pmtiles_archive
from pyproj import Transformer
import pyogrio
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from shapely.ops import transform, unary_union


MERCATOR_EXTENT_M = 20_037_508.342789244
MERCATOR_BOUNDS = (
    -MERCATOR_EXTENT_M,
    -MERCATOR_EXTENT_M,
    MERCATOR_EXTENT_M,
    MERCATOR_EXTENT_M,
)
COUNTRY_CODES = ("CAN", "MEX", "USA")
EXPECTED_COUNTS = {"CAN": 13, "MEX": 32, "USA": 51}
EXPECTED_SOURCE_SHA256 = "efc59726337323058f9446210adc96673179cd344e053666ee3d28cb58ba2b05"
EXPECTED_SOURCE_SIZE = 14_909_524
OUTPUT_FILENAME = "north-america-administrative-subdivisions.pmtiles"
METADATA_FILENAME = "north-america-administrative-subdivisions.json"
WIDTH = 8192
HEIGHT = 8192
LINE_COLOR = "#756b59"
LINE_ALPHA = 190
TILE_SIZE = 256
MIN_ZOOM = 0
MAX_ZOOM = 5


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate fixed North American state/province World Map raster PMTiles."
    )
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument(
        "--repository-root", type=Path, default=Path(__file__).resolve().parents[2]
    )
    args = parser.parse_args()

    source = args.source.resolve()
    if not source.is_file():
        raise FileNotFoundError(f"Administrative subdivision source is missing: {source}")
    if source.stat().st_size != EXPECTED_SOURCE_SIZE or sha256(source) != EXPECTED_SOURCE_SHA256:
        raise ValueError(
            "Administrative subdivision source does not match the pinned Natural Earth archive"
        )

    rows = pyogrio.read_dataframe(
        source,
        columns=["adm0_a3", "name"],
        where="adm0_a3 IN ('CAN', 'MEX', 'USA') AND name IS NOT NULL",
    )
    counts = {
        country: int((rows["adm0_a3"] == country).sum())
        for country in COUNTRY_CODES
    }
    if counts != EXPECTED_COUNTS:
        raise ValueError(f"Unexpected administrative subdivision counts: {counts}")

    project = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True).transform
    internal_boundaries = []
    for country in COUNTRY_CODES:
        regions = [
            transform(project, geometry)
            for geometry in rows.loc[rows["adm0_a3"] == country, "geometry"]
        ]
        country_shape = unary_union(regions)
        all_region_lines = unary_union([region.boundary for region in regions])
        internal_boundaries.append(
            all_region_lines.difference(country_shape.boundary.buffer(250))
        )

    transform_matrix = from_bounds(*MERCATOR_BOUNDS, WIDTH, HEIGHT)
    mask = rasterize(
        ((geometry, 1) for geometry in internal_boundaries if not geometry.is_empty),
        out_shape=(HEIGHT, WIDTH),
        transform=transform_matrix,
        fill=0,
        dtype="uint8",
        all_touched=False,
    )
    pixel_count = int(np.count_nonzero(mask))
    if pixel_count < 500:
        raise ValueError(f"Administrative subdivision raster is unexpectedly sparse: {pixel_count}")

    output_root = (
        args.repository_root.resolve()
        / "apps/client/src/assets/world-environment-overlays"
    )
    output_root.mkdir(parents=True, exist_ok=True)
    output_path = output_root / OUTPUT_FILENAME
    write_raster_pmtiles(output_path, mask)
    metadata = {
        "source": "Natural Earth 1:10m admin-1 states and provinces",
        "sourceUrl": "https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_1_states_provinces.zip",
        "sourceSha256": EXPECTED_SOURCE_SHA256,
        "countries": list(COUNTRY_CODES),
        "featureCounts": counts,
        "projection": "EPSG:3857",
        "bounds": [
            [-180, 85.05112878],
            [180, 85.05112878],
            [180, -85.05112878],
            [-180, -85.05112878],
        ],
        "sourceWidth": WIDTH,
        "sourceHeight": HEIGHT,
        "tileSize": TILE_SIZE,
        "minZoom": MIN_ZOOM,
        "maxZoom": MAX_ZOOM,
        "format": "PMTiles raster PNG",
        "lineColor": LINE_COLOR,
        "lineAlpha": LINE_ALPHA,
        "pixelCount": pixel_count,
        "file": OUTPUT_FILENAME,
        "fileSizeBytes": output_path.stat().st_size,
        "sha256": sha256(output_path),
    }
    (output_root / METADATA_FILENAME).write_text(
        json.dumps(metadata, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(metadata, indent=2))


def write_raster_pmtiles(path: Path, mask: np.ndarray) -> None:
    red, green, blue = bytes.fromhex(LINE_COLOR.removeprefix("#"))
    image = Image.fromarray(mask.astype("uint8")).convert("P")
    palette = [0, 0, 0, red, green, blue] + [0] * (256 * 3 - 6)
    image.putpalette(palette)
    image.info["transparency"] = bytes([0, LINE_ALPHA])
    rgba = image.convert("RGBA")
    header = {
        "version": 3,
        "clustered": True,
        "internal_compression": Compression.GZIP,
        "tile_compression": Compression.NONE,
        "tile_type": TileType.PNG,
        "min_lon_e7": -1800000000,
        "min_lat_e7": -850511288,
        "max_lon_e7": 1800000000,
        "max_lat_e7": 850511288,
        "center_zoom": 1,
        "center_lon_e7": -1000000000,
        "center_lat_e7": 450000000,
    }
    metadata = {
        "name": "Ash Atlas North American administrative subdivisions",
        "format": "png",
        "minzoom": str(MIN_ZOOM),
        "maxzoom": str(MAX_ZOOM),
        "bounds": "-180,-85.0511288,180,85.0511288",
    }
    original_gzip_compress = gzip.compress
    gzip.compress = lambda data, compresslevel=9, *, mtime=None: original_gzip_compress(
        data, compresslevel=compresslevel, mtime=0
    )
    try:
        with write_pmtiles_archive(str(path)) as archive:
            for zoom in range(MIN_ZOOM, MAX_ZOOM + 1):
                width = TILE_SIZE * (1 << zoom)
                level = rgba if width == WIDTH else rgba.resize(
                    (width, width), Image.Resampling.LANCZOS
                )
                for tile_y in range(1 << zoom):
                    for tile_x in range(1 << zoom):
                        tile = level.crop((
                            tile_x * TILE_SIZE,
                            tile_y * TILE_SIZE,
                            (tile_x + 1) * TILE_SIZE,
                            (tile_y + 1) * TILE_SIZE,
                        ))
                        if tile.getbbox() is None:
                            continue
                        encoded = io.BytesIO()
                        tile.save(encoded, format="PNG", optimize=True, compress_level=9)
                        archive.write_tile(
                            zxy_to_tileid(zoom, tile_x, tile_y), encoded.getvalue()
                        )
            archive.finalize(header, metadata)
    finally:
        gzip.compress = original_gzip_compress


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


if __name__ == "__main__":
    main()
