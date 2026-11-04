# Atlas Legends journal

Open **Progression → Achievements** to browse Atlas Legends. The journal contains
139 achievements, including the original Bitter Blood, and 30 quest chapters
across ten journeys. It covers Hunting, Legends, Discovery, Gathering,
Crafting, Mastery, and Dungeons.

The catalogue lives in `packages/shared/src/legendCatalog.ts`. Requirements are
visible before a goal is earned. Journeys have three ordered chapters; retained
history can satisfy several chapters on the same refresh. Every objective and the
preceding chapter must qualify. There are no daily resets or expiring chapters.
Every achievement and chapter is a one-time permanent unlock. Many pursuits have
separate higher-tier goals; each journey ends at chapter three. Goals do not reset
or generate increasingly large targets after completion.

## Progress and recognition

The catalogue offers 8,800 prestige points and 43 collectible journal honors.
Prestige ranks run from Wayfarer to Living Legend. Points and honors are records
inside the journal; they do not grant items, gold, XP, combat bonuses, or equippable
character titles. Bitter Blood adds 25 prestige to the journal while keeping its
existing 250 poison-damage requirement, Venom Core application unlock, and
Venomsteel equipment eligibility. It uses the same journal row, search, filters,
pins, and completion counts as other achievements.

Players can search, filter by category/difficulty/status, inspect objectives and
hints, and pin up to three goals. Pins are browser preferences scoped to a
character. The journal refreshes when opened, when the visible page reconnects,
on demand, and every 30 seconds while visible. Failed refreshes retain the last
confirmed snapshot with an explicit stale status.

## Authority

`GET /api/legends` uses the authenticated session's character and rejects supplied
query fields. `LegendJournalService` reads committed gameplay receipts and inserts
eligible IDs into the existing `player_achievements` table inside a transaction.
The primary key prevents duplicate awards. No client counter or inventory balance
can claim completion. Completion timestamps remain permanent after spending an
item or a later reduction in a current progression metric.

Bitter Blood keeps its original `bitter_blood` identity and completion timestamp.
Its `completionAuthority: "gameplay"` catalogue entry can only be completed by
the existing `AchievementService`, which also updates the equipment eligibility
cache. The journal reads that award; it never grants it from the damage total.
The UI merges same-character live poison snapshots with persisted journal data,
retains confirmed completion across stale refreshes, and leaves the existing
gameplay unlock notification in charge of announcing Bitter Blood.

| Objective | Source and unit |
| --- | --- |
| Creature defeats | Encyclopedia credited kill occurrences, including legendary event credit |
| Creature discovery | Durable Encyclopedia sightings, one per species |
| Habitat records | Current Encyclopedia defeat thresholds for natural species |
| Drop collections | Distinct credited drop item IDs; Xoral rings require Xoral event drops |
| Gathering | Distinct completed ordinary and repeatable harvest operation keys; actions, not item quantity |
| Furnace | Collected successful outputs; failed Iron units/Slag and cores do not count as bars; recovered Iron does |
| Furnace recipe collection | Recipes with successfully collected output, including Slag recovery |
| Loom / Kitchen / Tannery | Output units actually collected from personal jobs, including work at shared facilities |
| Professions | Current authoritative profession ranks; Breeder's internal rank 4 is displayed as Breeder V |
| Character level | Current authoritative character level |
| Bitter Blood | Existing poison-damage counter and original gameplay-owned achievement row |
| Rat Warden encounters | Completed boss reward receipts with positive personal contribution and validated dungeon/Rat Warden ownership |

Reading the journal reconciles earlier recorded activity. It does not reconstruct
history that predates a source ledger, award a Warden encounter for merely entering or
leaving a sewer, count purchased items as creature drops, or count uncollected workshop
output. Rare hide tanning and full legendary collections are optional stretch
paths; everyday supply-chain journeys use ordinary gathering and crafting.

Sewer objectives count distinct credited Rat Warden encounters. Seek other city
sewers after an encounter is already credited; replaying its settlement cannot
advance a goal. This journal does not activate the dormant dungeon completion
ledger's entry lockouts or change dungeon reset behavior.

## Focused checks

Catalogue tests cover valid unique IDs, reachable finite collections, prerequisite
cycles, every required objective, ordered retroactive completion, and empty history.
HTTP tests cover session identity, denial, supplied-ID rejection, and retryable
errors. PostgreSQL tests use a private schema on an explicitly disposable database
to exercise aggregation, concurrent duplicate suppression, restart persistence,
and transaction rollback. Client tests cover journal filters, pins, chapter locks,
refresh/abort behavior, and phone/desktop shell layout.

## Initial expansion verification

- Shared catalogue: 8 tests passed; every finite collection and profession target is reachable.
- Journal HTTP routes: 4 tests passed.
- Journal PostgreSQL integration: 4 tests passed, including concurrent awards, rollback/retry, retained timestamps, and populated/repeated index migration.
- Journal client: 10 tests passed; existing progression panel: 13 tests passed.
- Journal gallery regression: 1 focused test passed. The existing full gallery suite has an unrelated world-label text assertion that predates this change.
- Browser component checks: desktop and 360-pixel phone passed with the real progression shell.
- Shared, server, and client typechecks and both production builds passed.
- Full feature database migration succeeded; repeat migration returned no pending files. The authenticated live journal returned HTTP 200, private/no-store caching, the correct character, and no duplicate awards on refresh.
- The required launcher repair passed 83 assertions and resolves the unchanged World lock to the preserved artifact with its exact full manifest hash.

## Bitter Blood integration verification

The shared catalogue now passes 9 tests, including the original Bitter Blood ID,
25 prestige, and gameplay-owned completion. All 5 private-schema PostgreSQL tests
pass: a journal refresh cannot grant Bitter Blood, the actual achievement service
can grant it and update its eligibility cache, and the journal retains the
original award timestamp after restart. Shared, server, and client typechecks
pass. All 16 focused client tests and both phone/desktop browser checks pass,
including live progress, stale responses, character isolation, reward search,
filters, and pinning the unified Bitter Blood row.
