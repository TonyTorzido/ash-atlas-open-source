# Bounded world water-highlight cache

The game server caches successful, structurally valid responses from the World API
collectible-water GeoJSON endpoint. The cache is process-local acceleration only; the
World API remains authoritative.

## Safety properties

- Entries are keyed by the complete verified World release identity, coordinates
  rounded to six decimal places, and radius rounded to millimetres.
- A successful authority verification that changes the effective release identity
  clears all cached entries.
- The cache is bounded by both entry count and approximate serialized byte size.
- Least-recently-used entries are evicted first and every entry has a finite TTL.
- Failed HTTP requests, transport failures, malformed GeoJSON, and responses larger
  than the cache byte budget are never retained.
- Values are copied on insertion and retrieval so callers cannot mutate shared cache
  state.

## Configuration

| Variable | Default | Meaning |
| --- | ---: | --- |
| `WORLD_WATER_CACHE_MAX_ENTRIES` | `256` | Maximum retained query results |
| `WORLD_WATER_CACHE_MAX_BYTES` | `4194304` | Approximate total serialized bytes |
| `WORLD_WATER_CACHE_TTL_MS` | `300000` | Per-entry lifetime |

All three settings must be positive integers. Cache counters and current occupancy are
reported under `waterHighlightCache` on `/health`. Evictions, stale expirations,
authority invalidations, and oversized responses are cumulative for the process
lifetime.
