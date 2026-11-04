# Ordinary flag radius contract

The ordinary flag geometry is one validated contract with distinct meanings:

| Classification | Setting | Resolved value | Authority and use |
|---|---|---:|---|
| Ordinary flag claim | `FLAG_CLAIM_RADIUS_M` | 500 m | Persisted per flag; territory resolution, placement, manor territory, and city/Kingdom flag-network calculations consume the stored value. |
| Ordinary movement leash | `MOVE_LEASH_RADIUS_M` | 600 m | Persisted per player and enforced around the active destination anchor. |
| Certified visible gameplay area | `FLAG_RESOURCE_VISION_RADIUS_M` | 650 m | Persisted per ordinary flag; authoritative final filter for population, collectibles, repeatable resources, combat, water highlights, and map projection. |
| Invisible preparation area | `FLAG_PREPARE_BUFFER_M` | 100 m | Difference between certified vision and the prepared boundary. It is preparation capacity, not visible padding. |
| Invisible preparation area | `FLAG_PREPARE_RADIUS_M` | 750 m | Population/resource work may be warm here, but entities outside 650 m are not projected. |

Startup requires `claim < leash < vision < prepared` and requires `vision + buffer = prepared`. The shared compatibility helper retains only the explicit 50 m leash-to-vision difference, so a 600 m leash resolves to a 650 m view. Ordinary flag persistence does not derive vision from the leash.

## Reviewed radius decisions

| System | Classification | Decision |
|---|---|---|
| Flag placement and territory | Ordinary flag claim | New rows default to 500 m. Existing/special rows remain per-flag. Placement uses each stored claim and the established edge tolerance; it does not prohibit two claim circles from overlapping when neither center is inside the other claim. |
| Player movement, reconnect, travel, manor exit, defeat respawn | Ordinary movement leash | New and reconnecting ordinary players receive 600 m. Destination transitions replace the anchor and retain the explicit leash. |
| Resource Vision, collectible snapshots, repeatable resources, water highlights | Certified visible gameplay area | All authoritative queries and final position checks use the active Resource Vision, 650 m for ordinary flags and default open areas. The legacy protocol field named `activationRadiusM` remains a compatibility mirror of visible radius, not preparation authority. |
| Population V2 runtime | Certified visible gameplay area plus invisible preparation area | P0 is every zone intersecting the active anchor's 650 m visible circle and blocks population-baseline readiness until those zones are authoritative. It never blocks a committed flag transition, `FLAG_VISITED`, flag scope, or movement release. P2 may compile habitat/templates in the additional prepared-only set through 750 m, but creates no generation or live entity. Exact great-circle filtering and authoritative per-zone replacement prevent prepared or stale entities from reaching the client. Population projection never moves the actor or replaces the anchor. |
| Exact future flag construction | Certified visible gameplay area | After an exact build coordinate is accepted, every zone intersecting the future flag's 650 m visible circle is P0 during the authoritative 10-second build timer. Once P0 is ready, background P1 may materialize at most eight unique additional zones for at most one directly connected neighboring flag; it starts no AI and never blocks construction, movement, or travel. |
| Combat interest | Intentionally independent broad phase, certified final filter | The 1,100 m spatial broad phase remains for efficient candidate reuse. Final snapshots/deltas are clamped to the active 650 m gameplay circle. Universal Taunt remains half the active view, 325 m. Attack ranges remain class/weapon rules. |
| Client flag, leash, and vision rings | Claim, leash, certified view | The map consumes separate persisted/server fields: `claimRadiusM`, `moveLeashRadiusM`, and `resourceVision.radiusM`; no single display circle aliases them. Server removals clear stale population projection state. |
| Item pickup | Intentionally independent | Collectibles use 50 m and dropped items use 20 m. |
| Water interaction | Intentionally independent | 50 m. Visible highlights are still clipped by the certified view. |
| Flag arrival allocation and founding-flag interaction | Intentionally independent | Approximately 75 m. This is inside 500/600/650 for ordinary flags. |
| City founding annex | Intentionally independent | 750 m; it is organization membership geography, not ordinary Resource Vision. |
| City snapshot/search | Intentionally independent | 50 km with its own result cap. |
| Kingdom snapshot/search | Intentionally independent | 25 km. |
| Kingdom Seat initial territory | Intentionally independent | Inherits the selected source flag's stored claim radius; the standalone configuration default remains 200 m for contexts that do not convert an ordinary source flag. Seats are not automatically rewritten to 500 m. |
| Kingdom minimum seat spacing | Intentionally independent | 650 m is a separate placement rule and is not the 600 m ordinary movement leash. Spacing uses actual territory radii plus the configured buffer/tolerance. |
| City and Kingdom connectivity/pruning | Stored per-flag territory | Uses `left.claim_radius_m + right.claim_radius_m + tolerance`; there is no assumed global diameter. |
| Manor interior and placement reach | Intentionally independent | Interior dimensions and the 1,500 m target-distance limit remain separate. Territory ownership checks consume the stored flag claim. |
| Population geometry cells and spawn cells | Intentionally independent | Population-zone geometry and 250 m resource spawn cells are indexing/layout units, not visibility radii. |
| Environment candidate generation | Intentionally independent | The 1,500 m environment candidate domain and its 1,250 m conflict halo are deterministic plan-generation inputs, not an active player or flag view. |
| Permanent mine allocation buckets | Intentionally independent layout | Bucket dimensions remain an allocation/indexing detail; returned candidates are finally clipped to the active Resource Vision. |
| Historical migrations and test fixtures | Intentionally retained history | Recorded migrations are immutable. Old 1,000/1,250/1,500 values in historical migrations document prior defaults and are not current authority. Scenario-specific tests may use other radii when explicitly testing special or independent geometry. |

The administrative reset is an offline-only command at `tools/admin/reset-public-test-world.mjs`. It is guarded by exact database, runtime label, deployed SHA, stopped Game service, active World service, destructive environment token, typed confirmation, exact schema classification, and foreign-key closure. It preserves authentication/account tables and stable player identity fields while resetting all classified gameplay tables. No HTTP reset endpoint exists.
