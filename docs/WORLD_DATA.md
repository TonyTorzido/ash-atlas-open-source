# World data and the World API

Ash Atlas is a location-based game. Every spatial question the server asks (is this point land or
water, which biome, which settlement, is it inside a river or lake) is answered by an external
HTTP service called the **World API**. The World API and the pipeline that built its data are
**not part of this repository**. This document gives the contract the server calls, the source
datasets the original service was built from, and a minimal path for local development, so that
someone can rebuild or replace it.

Nothing here is a hosted service. You must run your own.

## 1. What the server needs from the World API

The client lives in `apps/server/src/world/worldLookupClient.ts` (types in `worldTypes.ts`). The
base URL comes from `WORLD_API_BASE` (default `http://127.0.0.1:8765`). All coordinates are WGS84
latitude/longitude in decimal degrees. Responses are JSON with `snake_case` keys.

| Endpoint | Method | Request | Purpose |
| --- | --- | --- | --- |
| `/api/health` | GET | none | Release identity and capability check, called at startup and by readiness probes |
| `/api/gameplay-environment` | GET | `lat`, `lon` | Compact per-point facts used for movement, flags and spawns |
| `/api/gameplay-environment-batch` | POST | `{"points":[{"latitude":..,"longitude":..}]}`, up to 512 points | Batch form of the above |
| `/api/resource-environment-batch` | POST | same body | Richer per-point record used by resource and population logic |
| `/api/lookup` | GET | `lat`, `lon` | Full environment profile for one point |
| `/api/lookup-batch` | POST | same body | Batch form of `/api/lookup`; must return one result per input point, in order |
| `/api/settlement-at` | GET | `lat`, `lon` | Which settlement polygon (if any) contains the point, else the nearest municipality |
| `/api/collectible-water-sources.geojson` | GET | `lat`, `lon`, `radius_m` | GeoJSON `FeatureCollection` of nearby water sources for the map highlight |

The original service also exposed an overlay endpoint (`/api/overlays.geojson`) and debug-viewer
routes. The server code in this repository does not require them.

### Response envelope

Single and batch lookups return `{"ok": true, "contract_version": "...", "release": {...}, ...}`:

- `/api/gameplay-environment` and its batch form: `contract_version` is
  `"gameplay-environment-v1"` and a `runtime` object `{ "sha", "branch" }` is mandatory. The batch
  form returns `results[]`.
- `/api/resource-environment-batch`: `contract_version` is `"resource-environment-v1"`, with `results[]`.
- `/api/lookup-batch`: `ok: true`, `release`, `results[]`.

The `release` object must contain `release_id`, `profile_set_fingerprint`,
`build_contract_fingerprint`, `boundary_release_id` and a numeric `package_count`. The server
compares these against `WORLD_REQUIRED_*` settings and rejects any mismatch (`WORLD_RELEASE_MISMATCH`).

### Per-point fields

Each result carries the fields listed in `WorldLookupResult` / `WorldGameplayEnvironmentResult`
(`apps/server/src/world/worldTypes.ts`), in `snake_case`. The important ones:

- Surface: `is_land`, `is_saltwater`, `is_coastal_land`, `is_riverbank`, `is_lakeshore`, plus
  `river_surface`, `lake_surface` and `ocean_coast_surface` membership objects (`cell_size_m`,
  `row_id`, `column_id`, `source_release_id`, `source_manifest_sha256`).
- Place: country, region and city ids, names and codes.
- Ecology: `elevation_m`, `terrain_class`, `land_cover_class`, `biome` / `biome_id`,
  `ecoregion` / `ecoregion_id`, `elevation_band`.
- Water facts: nearest/major lake, named river, supporting river (flow order, discharge, drainage
  area), nearest water source and its distance, and a `flag_placement_water` decision.
- Identity: optional `waterbody_identity` and `water_name_fallback` blocks.

A failed or uncovered point should return `ok: false` with a coded failure; the client maps
HTTP 429/503 to "overloaded", other 5xx to "unavailable", and treats bad JSON as an invalid
response. Unknown fields are ignored, so a rebuilt service can return only what it can compute, but
fields the gameplay code reads (land/water, surface membership, biome, settlement) must be present.

### `/api/settlement-at`

Returns `{ "found": bool, "authority": {...}, ... }`. `authority` carries `release_id`,
`release_fingerprint`, `founding_policy_id`, `founding_policy_fingerprint`,
`resolution_policy_id`, `resolution_policy_fingerprint` (64-character SHA-256 values). When
`found` is true a `settlement` object follows (id, name, country/region code, subtype, class,
population, founding eligibility and the policy fields in `WorldSettlement`); when false, a
`nearest` municipality (name, distance in metres, bearing) may be returned. The expected authority
identity is hard-coded in `apps/server/src/runtime/authorityIdentity.ts` (`APPROVED_SETTLEMENT_AUTHORITY`).
The same identity is also pinned in `config/world-runtime.lock.json` under `settlement_authority`, so the
lock and these constants must agree.

### `/api/health` in detail

Beyond the release identity above, the startup check asserts that the service reports:

- `runtime.sha` equal to the `pipeline.sha` in `config/world-runtime.lock.json`;
- `river_surface`, `lake_surface`, `ocean_coast_surface` blocks whose `mode` and `identity`
  (`release_id`, `manifest_sha256`, `policy`, `cell_size_m`) match the lock file, and capability
  flags `riverWaterAuthorityV1`, `lakeWaterAuthorityV1`, `oceanCoastWaterAuthorityV1` set to true;
- a waterbody identity overlay block matching `waterbody_identity_overlay` in the lock file.

If you build your own service you have two options: reproduce these identities exactly (they are
content hashes of the original build, so you cannot, unless you have the original data), or
**replace the pinned values**. The latter means editing `config/world-runtime.lock.json`, the
`WORLD_REQUIRED_*` variables in `.env`, and the approved settlement identity constants and `REQUIRED_WORLD_PIPELINE_SHA` in
`apps/server/src/runtime/authorityIdentity.ts`, then recomputing whatever fingerprints your service
reports. Startup rejects a lock whose `pipeline.sha` differs from `REQUIRED_WORLD_PIPELINE_SHA`, so
change that constant, the lock's `pipeline.sha` and the settlement constants together. See "Minimal
path" below.

## 2. The lock file

`config/world-runtime.lock.json` pins one specific World build:

- `pipeline`: repository name placeholder, protected branch and the exact commit `sha` the service
  must report in `runtime.sha`.
- `release`: `world-packages-v1`, 64,800 one-degree packages (360 x 180 tiles) and 648,000
  artifacts, with profile-set and build-contract fingerprints and a manifest hash.
- `river_surface`, `lake_surface`, `ocean_coast_surface`: sparse row-span rasters on a 125 m
  Web Mercator grid (roughly 100 M, 477 M and 99 M cells respectively).
- `riverbank_lakeshore`: land cells within 500 m of canonical water.
- `waterbody_identity_overlay`: per-cell canonical waterbody identity (17,109 packages).
- `water_name_index`: SQLite R-tree of 526,218 named waterbodies (about 2.3 GB).
- `settlement_authority`: `world-settlements-v2` release with 3,345,617 settlements and 3,350,348 aliases,
  pinned with its founding and resolution policy fingerprints.

These hashes describe data that is not in this repository. They are checked, not generated, by the
server.

## 3. Source datasets

The original pipeline (a separate Python project) produced the packages from public datasets. To
rebuild equivalent data you need the following. Sizes are the compressed downloads used.

| Role | Dataset | Format | Approx. size |
| --- | --- | --- | --- |
| Land / saltwater | OpenStreetMap-derived complete land polygons (WGS84) | Shapefile zip | 0.9 GB |
| Biome / ecoregion | RESOLVE Ecoregions 2017 | Shapefile zip | 140 MB |
| Elevation | GMTED2010 30 arc-second mean | ESRI grid zip, `int16`, 43200 x 20880 | 265 MB |
| Rivers | HydroRIVERS v1.0 | Shapefile zip | 520 MB |
| Lakes | HydroLAKES v1.0 | Shapefile zip | 780 MB |
| Land cover | ESA CCI Land Cover 300 m (2015) | GeoTIFF + legend CSV | 300 MB |
| Ocean depth | Natural Earth 10m bathymetry | Shapefile zip | 15 MB |
| Marine regions | Global Oceans and Seas, EEZ/IHO intersect | Shapefile zip | 200 MB |
| Countries and regions | Natural Earth admin-0 / admin-1 | Shapefile zip | under 20 MB |
| Collectible water sources | Natural Earth 10m rivers, lakes, playas (plus North America supplements) | Shapefile zip | under 10 MB |
| Settlements | Overture Maps Divisions `division_area` (locality, land, named) | GeoParquet | about 85 MB for the US locality subset; 2.1 GB for the world-wide boundaries file |
| Settlement fallback | GeoNames cities500 | zip | 13 MB |

Coordinate systems: sources are consumed in WGS84 (EPSG:4326); canonical water surfaces are
rasterised to a 125 m grid in Web Mercator (EPSG:3857); regional work used local UTM zones.
Licenses vary (CC BY 4.0, ODbL, public domain, HydroSHEDS license). Review them before
redistributing derived data; attribution is summarised in `LICENSE-ASSETS.md` and
`THIRD_PARTY_DATA.md`. The server itself also ships a small derived population grid (see
`THIRD_PARTY_DATA.md`), which is unrelated to the World API.

Expect a full global build to take hundreds of gigabytes of intermediate disk and many hours.
A single country or state is far smaller: the original project validated a 34-package New
Mexico build (about 350 MB of PostGIS data) and a three-region proof (about 40 MB).

## 4. What is in this repository

Present:

- The consumer: `apps/server/src/world/*` (client, types, batch admission) and its tests.
- The pinned identity: `config/world-runtime.lock.json`, `authorityIdentity.ts`, the `WORLD_*` env
  settings in `.env.example` and `apps/server/src/config.ts`.
- Presentation-asset generators in `tools/world-map/` (environment overlay PNGs, zone lookup,
  state/province boundary tiles). These read a checkout of the original pipeline and its
  intermediate packages (`--source-root`), so they cannot run without it. The generated outputs
  they produced are already committed under `apps/client/src/assets/world-environment-overlays/`.
- Release-promotion scripts (`tools/release/promote-world-runtime.*`, `tools/dev/world-runtime-groups.ps1`)
  that copy a built World runtime to a host. They assume the original hosting.

Not present:

- The World API service, its PostGIS schema and importers, the global package builder, the
  river/lake/ocean surface builders, the waterbody identity and name index builders, and the
  settlement importer.
- Any stub or fake World API.
- Any of the source or intermediate data.

## 5. Pointing the server at a World API

1. Run your service so that it listens on a reachable URL.
2. In `.env` set `WORLD_API_BASE` (default `http://127.0.0.1:8765`) and keep
   `WORLD_REQUIRED_RELEASE_ID`, `WORLD_REQUIRED_PROFILE_SET_FINGERPRINT`,
   `WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT` and `WORLD_REQUIRED_BOUNDARY_RELEASE_ID` equal to
   what your `/api/health` reports. Other knobs: `WORLD_LOOKUP_TIMEOUT_MS` (default 5000 in
   `.env.example`), `WORLD_WATER_CACHE_MAX_ENTRIES`, `WORLD_WATER_CACHE_MAX_BYTES`,
   `WORLD_WATER_CACHE_TTL_MS`. `WORLD_OVERLAY_MAX_FEATURES` and `WORLD_OVERLAY_MAX_PACKAGES` are
   optional, defaulting to 2000 and 64 in `apps/server/src/config.ts`.
3. Make `config/world-runtime.lock.json` and `authorityIdentity.ts` agree with your service (the
   lock file is imported at server start; a mismatch aborts startup). `authorityIdentity.ts` also hard-codes `REQUIRED_WORLD_PIPELINE_SHA`, and
   startup rejects a lock whose `pipeline.sha` differs, so update that constant, the lock's
   `pipeline.sha` and the settlement constants together.
4. Start the server (`pnpm dev`). On boot it calls `/api/health`; failure aborts startup.

The dev launcher scripts under `tools/dev` reference a World API port pool and checkout path in
`config/dev-runtime.defaults.json`; edit those paths if you use them.

## 6. Minimal path for local development

There is no stub, so choose one:

**A. Boot without a World API (non-spatial work only).** Set `NODE_ENV=development` and
`ALLOW_DEGRADED_WORLD_LOOKUPS_IN_DEV=true`. The server logs `DEGRADED WORLD AUTHORITY` and
continues when the health check fails. Authentication, inventory, combat, UI and database work
function; any lookup that needs land, water, biome or settlement data returns a coded failure,
so movement on the real map, flags, spawns and settlements will not work. This flag has no effect
outside development.

**B. Implement a small-region service.** A throwaway implementation needs to:

1. Serve `GET /api/health` with a release block and, to satisfy the startup assertions, the
   river/lake/ocean/waterbody identity blocks and capability flags described above.
2. Serve the lookup endpoints in section 1 for a bounded area. For a first version, answer from
   one polygon (land/water) plus a constant biome, return `release` and `runtime` on every
   response, return an empty `FeatureCollection` for water sources, and `found: false` with an
   `authority` block for settlements.
3. Update the lock file, `WORLD_REQUIRED_*` variables and `authorityIdentity.ts` to match what it
   reports. Use the existing tests in `apps/server/src/world/worldLookupClient.test.ts` as
   executable examples of valid and invalid payloads.

For anything beyond that, build real data from the sources in section 3 into a PostGIS database
(GiST indexes on polygons, point-in-polygon lookups) behind these endpoints.

## 7. Verifying it works

1. `curl http://127.0.0.1:8765/api/health` returns `ok: true` and a `release` block.
2. `curl "http://127.0.0.1:8765/api/gameplay-environment?lat=35.0844&lon=-106.6504"` returns
   `ok: true`, `contract_version: "gameplay-environment-v1"` and a `runtime` block (use any
   coordinate your data covers).
3. Start the server: the log line `verified authoritative global world release` confirms the health
   check passed. The readiness route (`/ready`, implemented in
   `apps/server/src/http/routes/systemRoutes.ts`) probes the same service and reports world
   authority status.
4. `pnpm --filter @ash-atlas/server exec vitest run src/world` runs the client contract tests
   (these use mocked responses and need no service).
5. Log in with a development account and move on the map; flags, settlements and water prompts only
   work when the lookups above succeed.
