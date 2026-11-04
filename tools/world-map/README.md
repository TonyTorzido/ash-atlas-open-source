# World Map environmental overlays

Generate the V1 transparent full-world masks from the exact world-pipeline checkout pinned by
`config/world-runtime.lock.json`:

```powershell
python tools/world-map/generate-environment-overlays.py `
  --source-root C:\Users\dev\Documents\world-pipeline
```

The generator reads the shared category contract from
`packages/shared/src/data/world-environment-overlay-v1.json`, rejects an unexpected pipeline SHA or
source category, verifies the locked `river-surface-v1` and `lake-surface-v1` releases under
`data/intermediate/global-packages/`, and writes deterministic indexed PNGs, a default Biomes
composite, and `manifest.json` under
`apps/client/src/assets/world-environment-overlays/`.

For projection QA, add `--alignment-output <temporary-path.png>`. The temporary image contains
source-grounded land boundaries, the equator, 30-degree latitude/longitude lines, and both
antimeridian edges in the same full-world Web Mercator frame. It is not a production asset.

Required generation-only Python packages are `numpy`, `Pillow`, `pyarrow`, `pyogrio`, `pyproj`,
`rasterio`, and `shapely`. They are not client runtime dependencies.

The `Biomes` (`BIO`, group id `environment`) group holds the 13 land biomes of
`packages/shared/src/worldZones.ts` (Jungle, Pinewild, Greenwood, Frostwood, Plains, Savanna, Marsh,
Highmeadow, Scrubland, Badlands, Steppe, Tundra, Frozen Waste). Each category lists the RESOLVE
`sourceBiomeIds` it merges plus optional `includeEcoregionNames` / `excludeEcoregionNames`
(Frozen Waste is the "Rock and Ice" ecoregion) and Badlands/Steppe split desert biome 13 at
35 degrees absolute latitude through `maxAbsLatitudeExclusive` / `minAbsLatitude`. A test keeps this
mapping equal to `RESOLVE_BIOME_CLASSES`. Water biomes stay in the Water / Ocean Depth groups.

The `Water` (`HYD`) group contains exactly `Rivers` and `Lakes`. The generator reads only the
locked sparse canonical `river-surface-v1` and `lake-surface-v1` row-span authorities (125 m
Web Mercator cells), streams package batches directly into the output canvas, and never performs
global geometry unions, proximity buffers, per-pan queries, or tile-service requests. It does not
read HydroRIVERS, HydroLAKES, bathymetry, or any gameplay riverbank/lakeshore release for these
assets. `water--rivers.png` and `water--lakes.png` are broad visual travel guides; gameplay
classification and distance remain World-authoritative and independent.

Both water assets are fixed 2048×2048 transparent indexed PNGs in EPSG:3857 with full-world
longitude bounds ±180° and latitude bounds ±85.05112878°. At the equator one output pixel is about
19,567.9 m wide; a canonical source cell is marked in every output pixel it intersects. The
manifest records each exact relative path, dimensions, compressed byte size, SHA-256, locked
surface release identity, source span/cell counts, and generation timing. Decoding one image as
RGBA consumes 16 MiB; keeping both water images decoded consumes 32 MiB (when the image presenter
allows both to be active). The existing ELE/TER/SEA groups retain their current semantics.

Generate the fixed, non-selectable US, Canadian, and Mexican state/province boundary raster tiles from the
pinned Natural Earth 1:10m admin-1 archive with:

```powershell
python tools/world-map/generate-administrative-subdivisions.py `
  --source C:\path\to\ne_10m_admin_1_states_provinces.zip
```

The generator verifies the pinned source archive and expected 51 US, 13 Canadian, and 32 Mexican
first-level divisions. It reads only those rows and writes a
transparent Web Mercator PNG tiles in one range-loaded PMTiles archive plus its provenance record under
`apps/client/src/assets/world-environment-overlays/`. This one-time development tool is not called
by normal builds, releases, deployments, gameplay, or the World API. It additionally requires
`pyogrio` and `pyproj`.

Regenerate the player-facing zone lookup (`world-zone-lookup-v1.bin`, used by the biome banner)
after any biome, elevation, ocean-depth, or lake overlay changes:

```powershell
python tools/world-map/generate-world-zone-lookup.py `
  --source-root C:\Users\dev\Documents\world-pipeline
```

It rasterizes the individual RESOLVE biome numbers from the pipeline's ecoregion archive (the Biomes
overlay merges several of them), takes elevation, ocean depth, and lakes from the
committed overlay PNGs, needs `numpy`, `Pillow`, `pyogrio`, `rasterio`, and `shapely`, and writes a run-length encoded 2048×2048 Web Mercator grid of zone codes (format and code table in
the script and `packages/shared/src/worldZones.ts`). It is presentation only.
