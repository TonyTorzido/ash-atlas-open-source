# Release stabilization evidence (test/t095)

## Scope and immutable baseline

- Branch: `fix/release-stability-fixes--from-t095`
- Base checkpoint: `test/t095`
- Base SHA: `2cd943ccf681142e1275a5a5655e08ed4a2c6c5e`
- The baseline contained Wave 3B and the sprite replacement merge. At task start,
  `origin/integration/test`, `origin/master`, `test/t095`, `release.json`, and both
  deployed release identities resolved to the base SHA.
- Production was inspected read-only. This branch does not merge, tag, checkpoint,
  deploy, reconcile, or reset retained data.

## Population V2

The production cutovers selected 75 immutable plans. Their durable selected slots
contained 206 trees, 128 deer, 7 stone, no wolf packs, and no ogres. The failure was
deterministic generation, not a client rendering or combat activation failure:

1. Compact synthetic wolf anchor/member sites had different `sourceCellId` values,
   so the cluster admission code never assembled a complete pack.
2. Specialized wolf, stone, and ogre sites also carried the `general` tag. Tree and
   deer candidates could occupy the identical point first and eliminate the rare
   candidate during global conflict ranking.
3. The pack-size hash threshold was 50/50 rather than the requested 75/25.
4. The accepted rates were too sparse for the certified 650 m visible-area geometry.

The selected-plan audit found trees in 74 plans, deer in 70, stone in 7, and wolves
and ogres in none. Durable canonical states were 189 ready / 17 harvested trees,
114 ready / 14 dead deer, and 5 ready / 2 harvested stone; the client projection
reported 6 ready / 1 depleted stone. One deer projection was locally suppressed.
There were no hostile slots to suppress, lease, activate, publish, or render; the
runtime query therefore had zero actors and leases and no last activation error.
Geographically, 63 zones contained deer and trees, 7 added stone, and 4 contained
only trees. Two plans had terminal admission errors and one remained pending, but
those did not account for the systematic absence across accepted plans.

The fix uses spawn rules `population-spawn-rules-v2-launch-3` and candidate layout
`compact-owner-samples-global-rank-v4`. Specialized sites are reserved, packs group
by their deterministic cluster tag, and accepted pack anchors expand atomically to
three or four wolves sharing one pack and encounter identity. Launch rates are one
pack per 4 km², stone per 5 km², and ogre per 20 km².

Read-only baseline sampling over 75 selected production-zone centers showed wolf
packs in 0%, stone in 8%, and ogres in 0% of normal visible areas. Mean/median were
0/0 packs and 0/0 wolves. The isolated post-change runtime sampled 59 selected
zone centers: wolf packs 15.3%, stone 27.1%, ogres 3.4%, mean/median packs 0.15/0,
and mean/median wolves 0.49/0. A sequential 20-hop sample was 20% packs, 30% stone,
10% ogres, 0.20 mean packs, 0.75 mean wolves, and a longest wolf-empty run of 12.

A larger deterministic 1,261-zone sample produced 217 complete packs and 699
wolves: 169 three-member and 48 four-member packs (77.88% / 22.12%). The isolated
runtime produced seven three-member and two four-member packs (77.8% / 22.2%).
No partial or duplicate packs were observed. Flag suppression remained local and
atomic at the encounter anchor.

Deployment requires a separately authorized Population V2 reconciliation/cutover
to generate and select new immutable plans. No production reconciliation was run.

## Harvest removal

Snapshots updated both React collectible state and the synchronous render ref, but
`HARVEST_COMPLETED`, `COLLECTIBLE_REMOVED`, and `COLLECTIBLE_PICKED_UP` only updated
React state. A Population V2 merge could therefore preserve or resurrect the stale
tree from the render ref or projection.

All authoritative removal frames now use one harvesting-owned transition. It
synchronously updates React state, the render ref, selection, active task,
Population V2 projection, overlay state, and hitboxes. A bounded 512-entry,
revision-aware tombstone set rejects reordered snapshots/deltas at the same or an
older revision and permits a legitimate newer respawn. Repeatable depleted stone
remains rendered. Runtime verification confirmed immediate tree and hitbox removal,
one reward, and no resurrection after reload/reconnect.

For a successful non-repeatable harvest, the server commits first, sends
`HARVEST_COMPLETED` to the harvester, sends progression/resource frames, broadcasts
`COLLECTIBLE_REMOVED` to scoped players, and finally sends the post-commit
collectible snapshot. Every removal frame and every tested reordering now converges
on that same committed absence.

## Travel and immediate actions

The client cleared its pending travel request when the arrival frame rendered,
before the committed world transition released. The first move could therefore
arrive unbound and be rejected. Server transition state also did not distinguish
acquired/uncommitted from committed/waiting-for-visible-readiness.

Transitions now record the committed relocation revision. Pre-commit movement is
still rejected. The first current-connection/current-revision post-commit move is
accepted into one bounded slot whether explicitly bound or safely late-unbound,
then replayed exactly once on release. The client retains the post-arrival binding
through the first `MOVE_ACCEPTED` handshake.

Nearby collectible refresh and `START_HARVEST` use a narrow 750 ms committed-window
wait, then revalidate the live connection, relocation revision, position,
visibility, and range before executing once. Replacement, reconnect, superseding
travel, failure, and deadline paths discard the intent; this is not a generic or
offline retry queue.

Across 20 isolated flag travels, measured transition release duration was p50
13.57 ms, p95 17.54 ms, and max 20.94 ms. The baseline did not expose equivalent
percentile instrumentation; its intended fallback was approximately 500 ms and the
reported symptom could last seconds. Runtime travel attempts produced no raw
transition warning or multi-second immobilization. Deterministic tests exercise the
buffer and deferred-harvest paths because the ready runtime normally released
before a browser click could enter the committed window.

## Tree hit geometry

Collectible hit geometry is now an explicit circle/rectangle union. Trees derive a
rectangle from the rendered texture aspect ratio, zoom-scaled target height, sprite
anchor, and 6 px padding. The square tree texture yields approximately 68 × 68 px
at minimum zoom, 102 × 102 px at base zoom, and 138 × 138 px at maximum zoom.
Other collectibles retain circular picking, reverse draw priority is preserved,
and removal prunes the hitbox synchronously.

## Verification and limitations

- Baseline and final PostgreSQL suites passed 44 files / 321 tests.
- Final package results: shared 38 files / 295 tests, server 197 / 1,633, and
  client 177 / 1,173. The monolithic parallel `pnpm test:unit` invocation twice
  exceeded the unchanged 5 s timeout in one unrelated MarketOverlay stress test;
  that focused test and the complete client package both passed without changing
  the timeout.
- Typecheck, lint, architecture (504 files, 1,778 imports, zero cycles/findings),
  production build, build verification, hygiene, and diff checks passed.
- Policy completed all 224 assertions. Its final World runtime group fixture
  refused ownership of the healthy shared port 41941; the unrelated World process
  was deliberately not killed or replaced.
- Isolated runtime acceptance covered desktop and a 390 × 844 phone profile with
  clean browser console/server logs, all five species, complete packs, combat,
  stone depletion, flag suppression, tree bounds, removal, reconnect, and 20
  travel cycles. Physical Safari/PWA and a second simultaneous player were not
  available; broadcast/reconnect behavior is covered by focused tests.
