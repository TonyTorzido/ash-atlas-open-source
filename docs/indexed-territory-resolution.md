# Indexed territory resolution

Territory coverage now starts with `ST_DWithin` against the maximum valid stored claim
radius, using `flags_geography_gix` on `(geom::geography)`. A second exact predicate
applies each candidate row's own radius plus the established 5 cm boundary tolerance.
The result therefore cannot omit a legal covering flag merely because another flag is
closer.

The stored and configured claim-radius ceiling is 10,000 m. This is ten times the
current canonical 1,000 m design radius and provides operational headroom without
allowing an unbounded row value to invalidate the candidate proof. Migration `0613`
preflights existing rows and fails with the first offending flag ID rather than changing
game data.

At most 1,000 covering flags are returned. The SQL asks for 1,001 and the service fails
closed if that corruption/safety threshold is crossed, so the limit cannot silently
truncate ownership resolution. A geography K-nearest-neighbor lookup retains nearest
flag diagnostics for unclaimed points without returning to a full-table distance sort.
Distance and owner ties remain resolved by exact application distance followed by flag
ID.

## Isolated PostGIS benchmark

The stability lab seeded globally distributed, legal 1,000 m flags and ran 20 measured
`EXPLAIN (ANALYZE, BUFFERS)` executions after two warmups at each scale. Times below
are PostgreSQL execution time on this development machine; the disposable benchmark
database was removed afterward.

| Flags | Previous p50 | Previous p95 | Indexed p50 | Indexed p95 |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 6.098 ms | 6.657 ms | 5.103 ms | 5.621 ms |
| 10,000 | 32.332 ms | 34.378 ms | 5.033 ms | 5.213 ms |
| 100,000 | 88.853 ms | 90.781 ms | 4.761 ms | 5.179 ms |

The old plan used a full candidate scan plus distance sort/top-N. At 100,000 rows the
initial version of the new plan revealed that a secondary ID key inside the KNN lookup
also forced a sequential top-N sort; the final lateral form uses `flags_geography_gix`
for both the bounded coverage scan and one-row KNN diagnostic lookup. Exact ID tie
resolution remains on the full covering set, where authority is decided.
