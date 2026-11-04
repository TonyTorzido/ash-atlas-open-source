# Gameplay geography architecture

Gameplay geography is compiled once for each stable `spawnCellForPoint()` cell. The World service
owns GIS authority; the game owns durable profiles, deterministic placement, and content rules.

```text
immutable World release
  -> gameplay-environment-v1 batch
  -> world_environment_cells
  -> persisted candidate slots
  -> versioned spawn profile
  -> collectible_nodes / generated_world_mobs
```

## Runtime contract

The lookup order is bounded in-memory LRU, PostgreSQL, then a durable asynchronous profile job. A
cache miss must not delay travel, world entry, reconnect, relocation, or flag publication. Those
paths only request work and continue. The leased worker makes one compact, package-grouped World
batch for the cell center and its deterministic candidate slots. Concurrent requests share the
unique job. Lease recovery, abort-on-ownership-loss, and fenced completion prevent duplicate
accepted profiles even when a stale worker briefly overlaps its replacement.

Profile identity is based on the immutable World release ID, profile-set fingerprint, build-contract
fingerprint, boundary-release ID, profile version, candidate-slot version, and cell ID. World runtime
Git SHA is provenance only: changing runtime code without changing the immutable data identity does
not invalidate a profile.

Candidate slots are seeded by cell ID, candidate-slot version, and slot index. Population generations
choose different deterministic subsets using cell ID, generation, spawn-rules version, and purpose.
After a profile is ready, ordinary generation and PostgreSQL rehydration make no World requests.

## Density ownership

The current 250 m spawn cell remains the geography and population identity. Flags, players,
reconnects, and repeated travel in the same cell therefore share one profile and one population
claim; no profile is keyed by flag. The 650 m certified vision radius affects visibility queries,
not ownership.

The population radius is much larger than the current cell and neighboring cells can still create
overlapping density budgets. A later migration should group existing cell identities beneath a
roughly 1 km population-budget key while retaining the 250 m geography profiles. That migration
needs an explicit compatibility and entity-ownership plan and is intentionally not part of this
change.

## Content and future settlements

Geography selects a versioned spawn-profile key. Game data maps that key to the currently available
trees, deer, wolf packs, and ogres. Adding future biome-specific assets changes game content rules,
not World GIS code.

Cell profiles retain only stable country, region, and settlement references. Future rich settlement
facts should live once in a normalized table with identity
`(world_identity_key, settlement_id)`, for example:

```text
world_settlement_profiles
  world_identity_key
  settlement_id
  canonical_name
  settlement_type
  population_band
  administrative_hierarchy
  source_metadata
  gameplay_tags
```

The full World `/api/lookup` remains available for diagnostics and rich information panels. Gameplay
critical paths use the compact contract or a previously bound placement quote.
