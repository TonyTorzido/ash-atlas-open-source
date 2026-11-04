# Population v2 lifecycle

Population v2 is the only population authority. Legacy v1 generation, serving,
cutover, rollback, projection, and operator controls are removed rather than
kept as a fallback.

## Durable ownership

Each physical population zone has one immutable habitat template. The template
records the World/environment identity, deterministic candidate field, density
inputs, and selected homes needed to create generations. Preparing a template
does not itself expose entities or start AI.

Every zone may have at most one current non-stone generation. Creating that
generation is protected by the zone's database lock and uniqueness constraint.
Its `generated_at` is fixed when it is admitted and its expiry is exactly
`generated_at + 48 hours`; visits, reconnects, activation, and preparation never
extend it.

Tree, deer, wolf, and ogre identities and positions are deterministic within
the generation. They are created together and are never individually replaced
or respawned. Death or harvest changes durable state for that generation only.
After expiry, the old generation remains authoritative while any player or
runtime lease references it. It can be retired after the zero-reference safety
grace, then one replacement generation may be created from the same template.
This keeps expiry safe without allowing overlapping generations or visit-driven
population multiplication.

Stone is independent of the non-stone generation. A stone home and ID are
permanent for its template, and harvest readiness resets on its own 350-minute
(5 hour 50 minute) cadence. Stone is the only population kind that returns at
the same permanent identity.

## Preparation priorities

| Priority | Scope | Completion contract |
| --- | --- | --- |
| P0 | Every zone intersecting the current flag's authoritative 650 m visible circle | Required before the population baseline reports ready. It creates or loads the current generation and activates referenced runtime actors. Flag construction starts this work during the authoritative 10-second build timer. |
| P1 | Zones for at most one directly connected neighboring flag, capped at eight unique additional zones | Background only. The selected destination wins, followed by movement direction, distance, and least-recently-prepared order. One bounded worker deduplicates work and yields under database pressure. It materializes durable state but starts no AI and never blocks movement, travel, or flag construction. |
| P2 | Habitat/template planning outside the immediate path | Template only. It creates no generation, runtime actor, or player-visible population. |

All three paths share the same per-zone locks and deterministic template inputs,
so concurrent flags or players converge on one template and one current
generation. Queue pressure may defer P1/P2; it must not weaken the P0 population
baseline readiness gate. P0 readiness never gates a committed flag transition,
`FLAG_VISITED`, flag-scope publication, or movement release.

## Runtime and replication

Runtime references are keyed by zone and generation. Acquisition is
single-flight and fenced; sleeping releases actors only after the zero-reference
grace. A generation is never cleaned up merely because its wall-clock expiry
passed.

Population replication is authoritative per zone. Each update carries:

- `zoneId`;
- the current `generationId` (or `null` for permanent/template-owned content);
- the complete entity-ID set for that zone snapshot; and
- explicit removed IDs.

The client replaces its prior entity set for that zone and generation instead
of appending arrivals. P0 progress is reported as authoritative ready-visible
zones over total-visible zones. P1 and P2 have no normal gameplay UI.

## Reset and diagnostics

The v2 lifecycle migration intentionally clears obsolete population plans,
generations, state, projections, and v1/cutover control data on the test server.
It preserves unrelated accounts, players, flags, inventory, currency, and
economy data. Recorded migrations remain immutable; subsequent changes fix
forward.

Developer diagnostics expose current generation age/expiry, reference state,
P0 completion timing, P1 queue depth/dedup/pressure deferrals, and invariant
cleanup. These diagnostics are operational evidence, not player-facing status
messages.
