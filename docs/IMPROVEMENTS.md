# Where work is needed (for forks)

Ash Atlas is archived and not maintained. This is an honest inventory of the gaps in this
snapshot, ordered by how much they block someone who wants to run or continue the project. It is
guidance for forks, not a roadmap or a promise of future work.

## 1. Missing pieces (blockers)

1. **World API and data pipeline.** The server cannot move players on the real map without a
   service implementing the lookup contract. The service, its database schema, importers and the
   source data are not included. See [WORLD_DATA.md](WORLD_DATA.md) for the contract, the source
   datasets and a minimal path. Until it exists, development mode with
   `ALLOW_DEGRADED_WORLD_LOOKUPS_IN_DEV=true` boots the server for non-spatial work only.
2. **Pinned world identity.** `config/world-runtime.lock.json` and
   `apps/server/src/runtime/authorityIdentity.ts` pin content hashes of a build that is not
   distributed. A replacement service needs those values regenerated.
3. **Hosting and release tooling.** `tools/release`, `tools/release/vps`, `tools/stability-lab`,
   the fast-deploy and feature-runtime scripts, `Run Ash Atlas.cmd`, `fastlane` and the Capacitor
   `.env` files describe the original author's hosts, accounts and signing setup. They are
   examples, not runnable as shipped. A fork needs its own CI/CD, server hosting, store
   accounts, Firebase configuration and signing identities.
4. **Unpublished documents.** Some code comments cite plans and design notes that were not
   published (for example `docs/plans/class-roster-v2.md`). Treat the code as the source of
   truth.

## 2. Hard-coded Windows paths

The tooling assumes a Windows machine with PowerShell and a fixed layout under
`C:\Users\dev\Documents\...`. Affected files include:

- `config/dev-runtime.defaults.json` (checkout, worktree, launcher and map-repository roots)
- `tools/dev/*` (runtime policy, feature runtime, world-runtime groups and their tests)
- `tools/release/*` (isolated batch validator, promote scripts)
- `tools/stability-lab/stability-lab.ps1`
- `tools/world-map/README.md` and generators (`--source-root` examples)
- `scripts/advanced-flag-world-api.ps1` and tests

These should be parameterised or replaced with repository-relative paths, and the PowerShell
tooling ported to cross-platform Node scripts if Linux/macOS development matters.

## 3. Known failing tests

The following were observed in this snapshot. Server and client suites were run against a fresh
database; some failures predate the public release and are environmental or stale-test issues
rather than known gameplay regressions.

**Server unit/integration**

- `droppedItems` (21 failures) and `harvestingHandler` (8)
- `flagTravelIntegration` (1), `harvestedTreeGhostRegression` (1)
- `goblinMarketPricing` (2), `progressionService` (2)
- `populationRealtimeAdapter` "deduplicates overlapping connection sources" (expected counts differ)
- `worldRuntime` SWING cases (2)
- Integration files that need the full migration set or a catalog harness: the Wyrm Hollow (`wyrmHollow`) test
  and the tidecraft tests (missing `shop_item_copies` in the harness database); a few market,
  cities, kingdom-perk and metal-framework cases around merchant rank 5 and inventory-slot setup
  (market, cities, `militaryIndustry.service`, `playerPackages`).

**Client**

- The `App.runtimeLifecycle` suite (about 38 failing tests), plus `gameClient` HELLO,
  `gameClientCommandEquivalence` "contains every", `clientCommandOwnership`,
  `clientFrameDomainOwnership`, `devPngCatalog` "includes every PNG", `swingEffects`,
  `inventoryPanelModel`, `spritePresentation`, `DeveloperPngLab`, `groundItemGeometry`,
  `ItemArtwork`, `KingdomPanel`, `MobileFlagActionSheet`, `noGreenUi`, `PhoneHud`,
  `PhoneMenuDestinationShell`, `ProgressionHud`, `SkillTreeV3Panel`, `UiStandardsGallery`,
  `WarriorClassPanel`, `WorldMapOverlay`, mobile and dungeon architecture checks, and four suites
  that need `URL.createObjectURL`.
- `jacketSword` reads a plan document that is not in this repository.

**Shared**

- `clientMessageSchemaDomainOwnership` (counts 412 vs 407).

Several suites hard-code numbers that were later re-tuned (see Balance); update the expected
values rather than the code when you confirm the new numbers are intended.

## 4. Known bugs and sharp edges

- **Permanent mine yield.** Inserting a stone permanent mine with yield quantity 3 violates the
  trigger in migration `0735_permanent_mine_resource_kinds.sql`, which requires 1. The
  `populationLifecycleAcceptance` test passes or fails depending on which row is generated.
- **`apps/server/tools/run-postgres-tests.mjs`.** The per-file runner builds its `--filter`/path
  arguments in a way that breaks on Windows paths in some shells, throws if any of the many
  `*_TEST_DATABASE_URL` variables are missing (its environment-coverage check is out of date), and
  its blank-database list needs maintenance. Requires `POSTGRES_TEST_ADMIN_URL` pointing at a
  local disposable server.
- **Telemetry role.** Migrations assume the PostgreSQL role `ash_atlas_telemetry_exporter` (and
  `ash_atlas_telemetry_writer`) exist. Create them first with `db/admin/telemetry_roles.sql`, or
  `pnpm db:migrate` on a fresh server fails.
- **Typecheck baseline.** `pnpm typecheck` has 0 errors in shared, 33 in server and 2 in client in
  this snapshot. They should be fixed or tracked before adding new work.
- **Dev-only defaults.** `.env.example` enables developer login and tools for local use; review
  every `DEV_*`, `AUTH_DEV_*` and `TEST_ACCESS_GATE_*` setting before exposing a server.

## 5. Balance

Gameplay numbers (damage matrix, rings, kingdom and war structure costs and durations, market
taxes, dungeon rewards and others) have **not been playtested**. Expect imbalances, and expect some
SQL `CHECK` constraints and TypeScript constants to disagree in places not covered by tests. When changing
a number, search both `packages/shared` and `db/migrations` for the old value.

## 6. Unfinished or gated features

- **Disabled by default in `.env.example`:** real-money purchases and the Atlas Pass
  (`PURCHASES_*`, `ATLAS_PASS_ENABLED`), email sign-in, Apple sign-in, device attestation
  (`TRUST_*`), telemetry export, bug-report email, population v2 mob rollout and several
  population travel optimisations. The code paths exist but have had little or no production use.
- **Classes:** the catalog holds many class definitions, but only five are launch-selectable
  (`LAUNCH_CLASS_IDS` in `packages/shared/src/classes.ts`: warrior, ranger, ninja, knight, druid);
  the rest are hidden or historical and partially wired.
- **Art backlog:** `docs/wiki-art-backlog.md` lists art that was never produced; the game shows
  empty slots rather than placeholders.
- **Native builds:** need your own Firebase config, bundle identifiers and signing; store
  submission material is not included.

## 7. Good first contributions

1. Write a small stub World API (one region, constant biome) and a script that generates a matching
   lock file; add it under `tools/` with a contract test against `worldLookupClient.ts`.
2. Fix the 33 server and 2 client typecheck errors.
3. Replace the hard-coded `C:\Users\dev` paths with repo-relative or environment-driven paths.
4. Repair `run-postgres-tests.mjs` (path handling, env-variable coverage) and document the test
   database setup.
5. Triage the failing suites above: update stale expected numbers, then root-cause the genuine
   failures (`droppedItems`, `harvestingHandler`, `App.runtimeLifecycle`).
6. Fix or document the permanent-mine yield mismatch with a migration and a test.
7. Add an end-to-end smoke test (server, database, stub World API, one client login).
8. Playtest and rebalance, recording intended values in a single table that both TypeScript and
   SQL read from.
