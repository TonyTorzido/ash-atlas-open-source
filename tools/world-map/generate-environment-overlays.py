from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pyogrio
import rasterio
from PIL import Image, ImageDraw
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from rasterio.warp import reproject
from shapely.geometry import box


MERCATOR_LATITUDE = 85.05112878
MERCATOR_EXTENT_M = 20_037_508.342789244
MERCATOR_BOUNDS = (
    -MERCATOR_EXTENT_M,
    -MERCATOR_EXTENT_M,
    MERCATOR_EXTENT_M,
    MERCATOR_EXTENT_M,
)
SOURCE_PATHS = {
    "resolve_ecoregions_2017": Path("data/raw/ecoregions/Ecoregions2017.zip"),
    "gmted2010_mean_elevation_30s": Path("data/raw/elevation/mn30_grd.zip"),
    "natural_earth_bathymetry_4_1_0": Path(
        "data/raw/bathymetry/ne_10m_bathymetry_all.zip"
    ),
}
OCEAN_SOURCE_CLASSES = {
    0: "coastal_or_shallow",
    200: "coastal_or_shallow",
    1000: "shelf_or_slope",
    2000: "shelf_or_slope",
    3000: "shelf_or_slope",
    4000: "deep_ocean",
    5000: "deep_ocean",
    6000: "abyssal",
    7000: "abyssal",
    8000: "abyssal",
    9000: "abyssal",
    10000: "abyssal",
}
BATHYMETRY_MEMBER = re.compile(r"ne_10m_bathymetry_[A-L]_(\d+)\.shp$", re.IGNORECASE)
WATER_GRID_CELL_SIZE_M = 125.0
WATER_SURFACE_RELEASES = {
    "rivers": {
        "lockKey": "river_surface",
        "releaseId": "river-surface-v1",
        "schema": "river-surface-v1",
        "artifact": "river_surface.parquet",
    },
    "lakes": {
        "lockKey": "lake_surface",
        "releaseId": "lake-surface-v1",
        "schema": "lake-surface-row-spans-v1",
        "artifact": "lake_surface.parquet",
    },
}


def main() -> None:
    started = time.perf_counter()
    parser = argparse.ArgumentParser(
        description="Generate deterministic Ash Atlas World Map environmental overlay masks."
    )
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--repository-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--alignment-output", type=Path)
    args = parser.parse_args()

    repository_root = args.repository_root.resolve()
    source_root = args.source_root.resolve()
    definition_path = (
        repository_root
        / "packages/shared/src/data/world-environment-overlay-v1.json"
    )
    output_root = repository_root / "apps/client/src/assets/world-environment-overlays"
    runtime_lock_path = repository_root / "config/world-runtime.lock.json"
    definition = read_json(definition_path)
    runtime_lock = read_json(runtime_lock_path)
    validate_water_overlay_contract(definition)
    width = int(definition["dimensions"]["width"])
    height = int(definition["dimensions"]["height"])
    if width != height:
        raise ValueError("World overlay V1 requires a square canvas")
    verify_pipeline_identity(source_root, runtime_lock)
    sources = require_sources(source_root)
    water_surfaces = require_canonical_water_surface_releases(source_root, runtime_lock)

    output_root.mkdir(parents=True, exist_ok=True)
    transform = from_bounds(*MERCATOR_BOUNDS, width, height)
    ecoregions = load_ecoregions(sources["resolve_ecoregions_2017"])
    land_mask = burn_geometries(ecoregions.geometry, width, height, transform)

    masks: dict[tuple[str, str], np.ndarray] = {}
    observed_biome_ids = sorted({int(value) for value in ecoregions["BIOME_NUM"].dropna()})
    if observed_biome_ids != list(range(1, 15)):
        raise ValueError(f"Unexpected RESOLVE biome IDs: {observed_biome_ids}")
    for category in group(definition, "environment")["categories"]:
        selected = ecoregions["BIOME_NUM"].isin(category["sourceBiomeIds"])
        included = category.get("includeEcoregionNames")
        excluded = category.get("excludeEcoregionNames")
        if included:
            selected &= ecoregions["ECO_NAME"].isin(included)
        if excluded:
            selected &= ~ecoregions["ECO_NAME"].isin(excluded)
        category_mask = burn_geometries(
            ecoregions.loc[selected].geometry, width, height, transform
        )
        min_abs_latitude = category.get("minAbsLatitude")
        max_abs_latitude = category.get("maxAbsLatitudeExclusive")
        if min_abs_latitude is not None or max_abs_latitude is not None:
            row_abs_latitude = np.abs(row_center_latitudes(height))[:, None]
            if min_abs_latitude is not None:
                category_mask &= row_abs_latitude >= float(min_abs_latitude)
            if max_abs_latitude is not None:
                category_mask &= row_abs_latitude < float(max_abs_latitude)
        masks[("environment", category["id"])] = category_mask

    elevation = reproject_elevation(
        sources["gmted2010_mean_elevation_30s"], width, height, transform
    )
    valid_land_elevation = land_mask & np.isfinite(elevation)
    elevation_thresholds = definition["elevationThresholdsM"]
    moderate = float(elevation_thresholds["moderate"])
    high = float(elevation_thresholds["high"])
    extreme = float(elevation_thresholds["extreme"])
    summit = float(elevation_thresholds["summit"])
    masks[("elevation", "low")] = valid_land_elevation & (elevation < moderate)
    masks[("elevation", "moderate")] = (
        valid_land_elevation & (elevation >= moderate) & (elevation < high)
    )
    masks[("elevation", "high")] = (
        valid_land_elevation & (elevation >= high) & (elevation < extreme)
    )
    masks[("elevation", "extreme")] = valid_land_elevation & (elevation >= extreme) & (elevation < summit)
    masks[("elevation", "summit")] = valid_land_elevation & (elevation >= summit)

    terrain_masks, terrain_audit = generate_terrain_masks(
        sources["gmted2010_mean_elevation_30s"],
        ecoregions.geometry,
        width,
        height,
        definition["terrainThresholds"],
    )
    masks.update({("terrain", key): value for key, value in terrain_masks.items()})

    ocean_depth, observed_ocean_classes = rasterize_ocean_depth(
        sources["natural_earth_bathymetry_4_1_0"], width, height, transform
    )
    expected_ocean_classes = {
        value
        for category in group(definition, "ocean_depth")["categories"]
        for value in category["sourceOceanDepthClasses"]
    }
    if observed_ocean_classes != expected_ocean_classes:
        raise ValueError(
            "Ocean depth normalization is incomplete: "
            f"observed={sorted(observed_ocean_classes)}, "
            f"expected={sorted(expected_ocean_classes)}"
        )
    for category in group(definition, "ocean_depth")["categories"]:
        source_depths = {
            depth
            for depth, source_class in OCEAN_SOURCE_CLASSES.items()
            if source_class in category["sourceOceanDepthClasses"]
        }
        masks[("ocean_depth", category["id"])] = np.isin(
            ocean_depth, list(source_depths)
        )

    water_masks, water_audit = generate_water_surface_masks(
        water_surfaces, width, height
    )
    masks.update({("water", key): value for key, value in water_masks.items()})

    file_hashes = {name: sha256(path) for name, path in sources.items()}
    source_fingerprint = sha256_bytes(
        json.dumps(file_hashes, sort_keys=True, separators=(",", ":")).encode("utf-8")
    )
    assets: list[dict[str, Any]] = []
    total_bytes = 0
    for overlay_group in sorted(definition["groups"], key=lambda value: value["order"]):
        for category in sorted(overlay_group["categories"], key=lambda value: value["order"]):
            key = (overlay_group["id"], category["id"])
            mask = masks.get(key)
            if mask is None:
                raise ValueError(f"Generator omitted overlay category {key}")
            filename = f"{overlay_group['id']}--{category['id']}.png"
            path = output_root / filename
            write_indexed_mask(path, mask, category["color"])
            size = path.stat().st_size
            total_bytes += size
            assets.append(
                {
                    "groupId": overlay_group["id"],
                    "categoryId": category["id"],
                    "label": category["label"],
                    "file": filename,
                    "color": category["color"],
                    "defaultEnabled": category["defaultEnabled"],
                    "order": category["order"],
                    "bounds": definition["bounds"],
                    "width": width,
                    "height": height,
                    "pixelCount": int(np.count_nonzero(mask)),
                    "sha256": sha256(path),
                    "fileSizeBytes": size,
                }
            )

    environment_group = group(definition, "environment")
    environment_composite_path = output_root / "environment--all.png"
    write_indexed_group(
        environment_composite_path,
        [
            (masks[("environment", category["id"])], category["color"])
            for category in sorted(environment_group["categories"], key=lambda value: value["order"])
        ],
    )
    environment_composite = {
        "groupId": "environment",
        "categoryIds": [category["id"] for category in environment_group["categories"]],
        "file": environment_composite_path.name,
        "bounds": definition["bounds"],
        "width": width,
        "height": height,
        "sha256": sha256(environment_composite_path),
        "fileSizeBytes": environment_composite_path.stat().st_size,
    }
    total_bytes += environment_composite["fileSizeBytes"]

    elevation_values = elevation[valid_land_elevation]
    manifest = {
        "worldEnvironmentOverlayVersion": definition["worldEnvironmentOverlayVersion"],
        "projection": "EPSG:3857",
        "bounds": definition["bounds"],
        "width": width,
        "height": height,
        "defaultOpacity": definition["defaultOpacity"],
        "approximateSourceResolution": {
            "environment": "RESOLVE Ecoregions 2017 polygons rasterized to the output canvas",
            "elevation": "GMTED2010 30 arc-second mean elevation resampled to the output canvas",
            "terrain": terrain_audit["approximation"],
            "oceanDepth": "Natural Earth 10m nested bathymetry polygons",
            "water": water_audit["approximation"],
        },
        "sourceIdentity": {
            "pipelineSha": runtime_lock["pipeline"]["sha"],
            "worldReleaseId": runtime_lock["release"]["release_id"],
            "profileSetFingerprint": runtime_lock["release"]["profile_set_fingerprint"],
            "buildContractFingerprint": runtime_lock["release"]["build_contract_fingerprint"],
            "sourceFiles": file_hashes,
            "waterSurfaceReleases": {
                key: {
                    "releaseId": source["releaseId"],
                    "manifestSha256": source["manifestSha256"],
                }
                for key, source in water_surfaces.items()
            },
            "overlaySourceFingerprint": source_fingerprint,
        },
        "normalization": {
            "elevationThresholdsM": definition["elevationThresholdsM"],
            "terrainThresholds": definition["terrainThresholds"],
            "observedBiomeIds": observed_biome_ids,
            "observedTerrainClasses": ["flat", "hilly", "mountainous"],
            "observedOceanDepthClasses": sorted(observed_ocean_classes),
            "waterSurfaceSourcePolicy": {
                "rivers": "canonical river-surface-v1 row spans",
                "lakes": "canonical lake-surface-v1 row spans",
            },
            "rockAndIceRule": 'BIOME_NUM=11 and ECO_NAME="Rock and Ice"',
        },
        "audit": {
            "landElevationSampleCount": int(elevation_values.size),
            "landElevationMinM": round(float(np.min(elevation_values)), 3),
            "landElevationMaxM": round(float(np.max(elevation_values)), 3),
            "landElevationPercentilesM": {
                str(percentile): round(float(np.percentile(elevation_values, percentile)), 3)
                for percentile in (25, 50, 75, 90, 95)
            },
            "terrain": terrain_audit,
            "water": water_audit,
        },
        "assets": assets,
        "defaultEnvironmentComposite": environment_composite,
        "totalFileSizeBytes": total_bytes,
        "textureMemoryEstimateBytes": width * height * 4 * len(assets),
        "largestActiveGroupTextureMemoryEstimateBytes": width * height * 4 * max(
            len(value["categories"]) for value in definition["groups"]
        ),
        "defaultEnvironmentTextureMemoryEstimateBytes": width * height * 4,
        "waterGuideTextureMemoryEstimateBytesPerAsset": width * height * 4,
        "waterGuidePairTextureMemoryEstimateBytes": width * height * 4 * 2,
        "generationSeconds": round(time.perf_counter() - started, 3),
    }
    (output_root / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )
    if args.alignment_output:
        write_alignment_image(args.alignment_output.resolve(), ecoregions.geometry, width, height)
    print(json.dumps({
        "assetCount": len(assets),
        "totalFileSizeBytes": total_bytes,
        "manifest": str(output_root / "manifest.json"),
        "generationSeconds": manifest["generationSeconds"],
        "waterGuideAssets": [
            {
                "path": str(output_root / asset["file"]),
                "width": asset["width"],
                "height": asset["height"],
                "fileSizeBytes": asset["fileSizeBytes"],
                "sha256": asset["sha256"],
            }
            for asset in assets
            if asset["groupId"] == "water"
        ],
        "waterGuideTextureMemoryEstimateBytesPerAsset": width * height * 4,
        "waterGuidePairTextureMemoryEstimateBytes": width * height * 4 * 2,
    }, indent=2))


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def group(definition: dict[str, Any], group_id: str) -> dict[str, Any]:
    return next(value for value in definition["groups"] if value["id"] == group_id)


def validate_water_overlay_contract(definition: dict[str, Any]) -> None:
    water_categories = group(definition, "water")["categories"]
    expected_ids = list(WATER_SURFACE_RELEASES)
    actual_ids = [category["id"] for category in sorted(water_categories, key=lambda value: value["order"])]
    if actual_ids != expected_ids:
        raise ValueError(f"Water guide categories must be exactly {expected_ids}, got {actual_ids}")
    for category in water_categories:
        expected_source = WATER_SURFACE_RELEASES[category["id"]]["lockKey"]
        if category.get("sourceSurface") != expected_source:
            raise ValueError(
                f"Water guide category {category['id']!r} must use sourceSurface {expected_source!r}"
            )


def verify_pipeline_identity(source_root: Path, runtime_lock: dict[str, Any]) -> None:
    expected = runtime_lock["pipeline"]["sha"]
    actual = subprocess.run(
        ["git", "-C", str(source_root), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if actual != expected:
        raise ValueError(f"World source checkout SHA {actual} does not match lock {expected}")


def require_sources(source_root: Path) -> dict[str, Path]:
    sources = {name: source_root / relative for name, relative in SOURCE_PATHS.items()}
    missing = [str(path) for path in sources.values() if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Missing world overlay source files: {', '.join(missing)}")
    return sources


def require_canonical_water_surface_releases(
    source_root: Path, runtime_lock: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    """Resolve only the locked sparse river/lake surface releases.

    The release manifests are hashed by the runtime lock.  Package files are consumed as bounded
    row-span streams below; the large root manifests are intentionally not loaded into memory.
    """
    releases_root = source_root / "data/intermediate/global-packages"
    resolved: dict[str, dict[str, Any]] = {}
    for category_id, expected in WATER_SURFACE_RELEASES.items():
        lock_entry = runtime_lock.get(expected["lockKey"])
        if not isinstance(lock_entry, dict):
            raise ValueError(f"Runtime lock is missing {expected['lockKey']} water authority")
        if lock_entry.get("release_id") != expected["releaseId"]:
            raise ValueError(
                f"Runtime lock {expected['lockKey']} is not {expected['releaseId']}"
            )
        if lock_entry.get("cell_size_m") != WATER_GRID_CELL_SIZE_M:
            raise ValueError(
                f"Runtime lock {expected['lockKey']} does not use the 125 m water grid"
            )
        release_root = releases_root / expected["releaseId"]
        manifest_path = release_root / "manifest.json"
        if not manifest_path.is_file():
            raise FileNotFoundError(f"Missing {expected['releaseId']} manifest: {manifest_path}")
        expected_manifest_sha = str(lock_entry.get("manifest_sha256", "")).lower()
        actual_manifest_sha = sha256(manifest_path)
        if actual_manifest_sha != expected_manifest_sha:
            raise ValueError(
                f"{expected['releaseId']} manifest does not match the runtime lock: "
                f"actual={actual_manifest_sha} expected={expected_manifest_sha}"
            )
        packages_root = release_root / "packages"
        if not packages_root.is_dir():
            raise FileNotFoundError(f"Missing {expected['releaseId']} package directory: {packages_root}")
        package_paths = tuple(sorted(path for path in packages_root.iterdir() if path.is_dir()))
        expected_package_count = int(lock_entry.get("package_count", -1))
        if len(package_paths) != expected_package_count:
            raise ValueError(
                f"{expected['releaseId']} package count differs from the runtime lock: "
                f"actual={len(package_paths)} expected={expected_package_count}"
            )
        first_manifest = package_paths[0] / "manifest.json" if package_paths else None
        if first_manifest is None or not first_manifest.is_file():
            raise FileNotFoundError(f"{expected['releaseId']} has no package manifest")
        package_contract = read_json(first_manifest)
        if package_contract.get("schema") != expected["schema"]:
            raise ValueError(
                f"{expected['releaseId']} package schema is {package_contract.get('schema')!r}, "
                f"expected {expected['schema']!r}"
            )
        resolved[category_id] = {
            "releaseId": expected["releaseId"],
            "schema": expected["schema"],
            "manifestSha256": actual_manifest_sha,
            "packageRoot": packages_root,
            "packagePaths": package_paths,
            "artifact": expected["artifact"],
            "policy": package_contract.get("policy"),
        }
    return resolved


def row_center_latitudes(height: int) -> np.ndarray:
    """Latitude in degrees at the centre of each Web Mercator output row."""
    rows = np.arange(height, dtype="float64") + 0.5
    mercator_y = MERCATOR_EXTENT_M - rows * (2 * MERCATOR_EXTENT_M / height)
    return np.degrees(2 * np.arctan(np.exp(mercator_y / 6_378_137.0)) - math.pi / 2)


def load_ecoregions(archive_path: Path):
    path = f"/vsizip/{archive_path.as_posix()}/Ecoregions2017.shp"
    frame = pyogrio.read_dataframe(
        path, columns=["BIOME_NUM", "BIOME_NAME", "ECO_NAME"]
    ).to_crs("EPSG:3857")
    frame["BIOME_NUM"] = frame["BIOME_NUM"].astype("Int64")
    world = box(*MERCATOR_BOUNDS)
    frame["geometry"] = frame.geometry.map(lambda geometry: geometry.intersection(world))
    return frame.loc[~frame.geometry.is_empty].reset_index(drop=True)


def burn_geometries(
    geometries: Iterable[Any], width: int, height: int, transform: Any
) -> np.ndarray:
    return rasterize(
        ((geometry, 1) for geometry in geometries if geometry is not None and not geometry.is_empty),
        out_shape=(height, width),
        transform=transform,
        fill=0,
        dtype="uint8",
        all_touched=False,
    ).astype(bool)


def generate_water_surface_masks(
    water_surfaces: dict[str, dict[str, Any]], width: int, height: int
) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
    """Rasterize canonical 125 m row spans directly into the coarse image canvas.

    Each package is opened and batched independently.  No source geometry is unioned and no
    proximity/dilation operation is performed: a destination pixel is marked when it intersects
    at least one canonical water-surface cell.
    """
    started = time.perf_counter()
    world_span_m = MERCATOR_EXTENT_M * 2
    output_pixel_size_m = world_span_m / width
    source_cells_per_pixel = WATER_GRID_CELL_SIZE_M / output_pixel_size_m
    masks: dict[str, np.ndarray] = {}
    authority_audit: dict[str, dict[str, Any]] = {}
    for category_id in ("rivers", "lakes"):
        source = water_surfaces[category_id]
        mask = np.zeros((height, width), dtype=bool)
        span_count = 0
        source_cell_count = 0
        for row_id, start_column, end_column in iter_canonical_surface_spans(source):
            row_first, row_last = output_pixel_bounds(
                row_id, row_id, source_cells_per_pixel, height
            )
            column_first, column_last = output_pixel_bounds(
                start_column, end_column, source_cells_per_pixel, width
            )
            mask[row_first:row_last + 1, column_first:column_last + 1] = True
            span_count += 1
            source_cell_count += end_column - start_column + 1
        masks[category_id] = mask
        authority_audit[category_id] = {
            "releaseId": source["releaseId"],
            "schema": source["schema"],
            "policy": source["policy"],
            "manifestSha256": source["manifestSha256"],
            "packageCount": len(source["packagePaths"]),
            "spanCount": span_count,
            "sourceCellCount": source_cell_count,
            "outputPixelCount": int(np.count_nonzero(mask)),
        }
    return masks, {
        "outputCanvas": {"width": width, "height": height, "projection": "EPSG:3857"},
        "outputPixelSizeAtEquatorM": round(output_pixel_size_m, 6),
        "sourceCellSizeM": WATER_GRID_CELL_SIZE_M,
        "approximation": (
            "Canonical river-surface-v1 and lake-surface-v1 125 m row spans rasterized directly "
            "to a 2048 x 2048 Web Mercator image; broad visual travel guides only, with no "
            "proximity buffers or gameplay authority"
        ),
        "generationSeconds": round(time.perf_counter() - started, 3),
        "authorities": authority_audit,
    }


def iter_canonical_surface_spans(
    source: dict[str, Any], batch_size: int = 65_536
) -> Iterable[tuple[int, int, int]]:
    """Yield `(row, start_column, end_column)` from one sparse release in bounded batches."""
    import pyarrow.parquet as parquet

    required_columns = ("row_id", "start_column", "end_column")
    for package_path in source["packagePaths"]:
        artifact_path = package_path / source["artifact"]
        if not artifact_path.is_file():
            raise FileNotFoundError(f"Missing water surface artifact: {artifact_path}")
        parquet_file = parquet.ParquetFile(artifact_path)
        if any(column not in parquet_file.schema.names for column in required_columns):
            raise ValueError(f"Water surface artifact has an incomplete span schema: {artifact_path}")
        for batch in parquet_file.iter_batches(
            columns=list(required_columns), batch_size=batch_size
        ):
            values = batch.to_pydict()
            for row_id, start_column, end_column in zip(
                values["row_id"], values["start_column"], values["end_column"]
            ):
                row = int(row_id)
                start = int(start_column)
                end = int(end_column)
                if row < 0 or row >= 320_601 or start < 0 or end < start or end >= 320_601:
                    raise ValueError(
                        f"Water surface span is outside the canonical grid: "
                        f"row={row} start={start} end={end}"
                    )
                yield row, start, end


def output_pixel_bounds(
    start: int, end: int, source_cells_per_pixel: float, output_size: int
) -> tuple[int, int]:
    """Return output pixels intersected by an inclusive canonical cell interval."""
    first = max(0, min(output_size - 1, math.floor(start * source_cells_per_pixel)))
    last = max(0, min(output_size - 1, math.ceil((end + 1) * source_cells_per_pixel) - 1))
    if last < first:
        raise ValueError(f"Invalid output pixel interval: start={start} end={end}")
    return int(first), int(last)


def reproject_elevation(
    archive_path: Path, width: int, height: int, transform: Any
) -> np.ndarray:
    destination = np.full((height, width), np.nan, dtype="float32")
    source_path = f"/vsizip/{archive_path.as_posix()}/mn30_grd"
    with rasterio.open(source_path) as source:
        reproject(
            source=rasterio.band(source, 1),
            destination=destination,
            src_transform=source.transform,
            src_crs=source.crs,
            src_nodata=source.nodata,
            dst_transform=transform,
            dst_crs="EPSG:3857",
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
    return destination


def generate_terrain_masks(
    elevation_archive: Path,
    land_geometries: Iterable[Any],
    width: int,
    height: int,
    thresholds: dict[str, Any],
) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
    sample_width = width * 2
    sample_height = height * 2
    transform = from_bounds(*MERCATOR_BOUNDS, sample_width, sample_height)
    elevation = reproject_elevation(
        elevation_archive, sample_width, sample_height, transform
    )
    land = burn_geometries(land_geometries, sample_width, sample_height, transform)
    valid = land & np.isfinite(elevation)
    low = np.where(valid, elevation, np.inf)
    high = np.where(valid, elevation, -np.inf)
    local_min = low.copy()
    local_max = high.copy()
    for row_offset in (-1, 0, 1):
        for column_offset in (-1, 0, 1):
            if row_offset == 0 and column_offset == 0:
                continue
            source_rows, target_rows = shifted_slices(sample_height, row_offset)
            source_columns, target_columns = shifted_slices(sample_width, column_offset)
            np.minimum(
                local_min[target_rows, target_columns],
                low[source_rows, source_columns],
                out=local_min[target_rows, target_columns],
            )
            np.maximum(
                local_max[target_rows, target_columns],
                high[source_rows, source_columns],
                out=local_max[target_rows, target_columns],
            )
    relief = local_max - local_min
    mountainous = valid & (
        (elevation >= float(thresholds["mountainousMinElevationM"]))
        | (relief >= float(thresholds["mountainousMinLocalReliefM"]))
    )
    hilly = valid & ~mountainous & (
        (elevation >= float(thresholds["hillyMinElevationM"]))
        | (relief > float(thresholds["flatMaxLocalReliefM"]))
    )
    flat = valid & ~mountainous & ~hilly
    downsample = lambda value: value[::2, ::2][:height, :width]
    masks = {
        "flat": downsample(flat),
        "hilly": downsample(hilly),
        "mountainous": downsample(mountainous),
    }
    pixel_size_m = (MERCATOR_EXTENT_M * 2) / sample_width
    return masks, {
        "sampleCanvasWidth": sample_width,
        "sampleCanvasHeight": sample_height,
        "samplePixelSizeAtEquatorM": round(pixel_size_m, 3),
        "approximation": (
            "GMTED2010 elevation plus adjacent cells on a 4096 Web Mercator sampling canvas; "
            "broad ruggedness only, while exact World lookups retain native-source local relief"
        ),
        "categoryPixelCounts": {
            category: int(np.count_nonzero(mask)) for category, mask in masks.items()
        },
    }


def shifted_slices(length: int, offset: int) -> tuple[slice, slice]:
    if offset < 0:
        return slice(0, length + offset), slice(-offset, length)
    if offset > 0:
        return slice(offset, length), slice(0, length - offset)
    return slice(0, length), slice(0, length)


def rasterize_ocean_depth(
    archive_path: Path, width: int, height: int, transform: Any
) -> tuple[np.ndarray, set[str]]:
    import zipfile

    with zipfile.ZipFile(archive_path) as archive:
        members = [member.replace("\\", "/") for member in archive.namelist()]
    layers: list[tuple[int, str]] = []
    for member in members:
        match = BATHYMETRY_MEMBER.search(member)
        if match:
            layers.append((int(match.group(1)), member))
    observed_depths = {depth for depth, _ in layers}
    if observed_depths != set(OCEAN_SOURCE_CLASSES):
        raise ValueError(f"Unexpected Natural Earth depth bands: {sorted(observed_depths)}")
    output = np.full((height, width), -1, dtype="int16")
    for depth, member in sorted(layers):
        path = f"/vsizip/{archive_path.as_posix()}/{member}"
        frame = pyogrio.read_dataframe(path).to_crs("EPSG:3857")
        mask = burn_geometries(frame.geometry, width, height, transform)
        output[mask] = depth
    return output, {OCEAN_SOURCE_CLASSES[depth] for depth in observed_depths}


def write_indexed_mask(path: Path, mask: np.ndarray, color: str) -> None:
    red, green, blue = bytes.fromhex(color.removeprefix("#"))
    image = Image.fromarray(mask.astype("uint8")).convert("P")
    palette = [0, 0, 0, red, green, blue] + [0] * (256 * 3 - 6)
    image.putpalette(palette)
    image.info["transparency"] = bytes([0, 255])
    image.save(path, format="PNG", optimize=True, compress_level=9)


def write_indexed_group(path: Path, categories: list[tuple[np.ndarray, str]]) -> None:
    if len(categories) > 255:
        raise ValueError("Indexed overlay group exceeds the PNG palette limit")
    indices = np.zeros(categories[0][0].shape, dtype="uint8")
    palette = [0, 0, 0]
    transparency = [0]
    for index, (mask, color) in enumerate(categories, start=1):
        indices[mask] = index
        palette.extend(bytes.fromhex(color.removeprefix("#")))
        transparency.append(255)
    palette.extend([0] * (256 * 3 - len(palette)))
    image = Image.fromarray(indices, mode="P")
    image.putpalette(palette)
    image.info["transparency"] = bytes(transparency)
    image.save(path, format="PNG", optimize=True, compress_level=9)


def write_alignment_image(
    path: Path, geometries: Iterable[Any], width: int, height: int
) -> None:
    transform = from_bounds(*MERCATOR_BOUNDS, width, height)
    boundaries = burn_geometries(
        (geometry.boundary for geometry in geometries), width, height, transform
    )
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    pixels = np.asarray(image).copy()
    pixels[boundaries] = (35, 35, 35, 220)
    image = Image.fromarray(pixels)
    draw = ImageDraw.Draw(image)
    for longitude in range(-180, 181, 30):
        x = round((longitude + 180) / 360 * (width - 1))
        draw.line((x, 0, x, height - 1), fill=(210, 70, 40, 190), width=2 if abs(longitude) == 180 else 1)
    for latitude in range(-60, 61, 30):
        y = mercator_y(latitude, height)
        draw.line((0, y, width - 1, y), fill=(35, 95, 180, 210), width=2 if latitude == 0 else 1)
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True, compress_level=9)


def mercator_y(latitude: float, height: int) -> int:
    latitude = max(-MERCATOR_LATITUDE, min(MERCATOR_LATITUDE, latitude))
    radians = math.radians(latitude)
    normalized = (1 - math.asinh(math.tan(radians)) / math.pi) / 2
    return round(normalized * (height - 1))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


if __name__ == "__main__":
    main()
