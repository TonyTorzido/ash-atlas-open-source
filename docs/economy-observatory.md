# Economy Observatory V1

Economy Observatory is a private, read-only Developer App for inspecting
authoritative economy state. It uses the existing `developer:observe`
capability; no player-facing economy data is exposed.

## What is measured

`economy_events` is an immutable typed projection of authoritative inventory,
wallet, city, kingdom, and market boundaries. Market inventory/wallet movements
are projected from the market's balanced ledger only; their lower-level rows
are deliberately not duplicated as SOURCE/SINK events. Every event is one of:

- `SOURCE`: external supply entering custody.
- `SINK`: supply leaving custody.
- `TRANSFER`: a debit and credit leg in one transfer group. Transfer groups are
  checked at commit and must be globally net zero for each asset identity.
- `TRANSFORM`: input and output legs for a recipe or processing operation.
- `ADMIN`: an explicit administrative credit or debit.
- `UNKNOWN`: observed activity whose economic boundary is not yet classified.

Fungible assets carry an item or currency identity, variant, and quantity.
Unique assets carry an immutable instance identity and quantity one. The
observatory never converts unrelated currencies or items into a universal Gold
value.

## Supply scopes

- `existing_world_supply`: all current non-future custody, including players,
  organizations, active ground drops, and existing market escrow/collections.
- `player_controlled_existing_supply`: current player inventory, wallets,
  equipment, backpacks, and manor custody.
- `organization_existing_supply`: current City and Kingdom custody.
- `world_available_supply`: active ground-drop custody available in the world.
- `committed_or_future_supply`: market escrow/collections, pending packages, and
  uncollected production outputs. Pending packages and production are not added
  to existing supply.

Scopes are explicit analytical lenses rather than one additive total: an asset
that already exists in market escrow/collection is present in existing supply
and is also marked committed, while package/job promises appear only in the
committed/future scope. Player and organization scopes remain mutually
exclusive for current custody.

The live projection is read in one PostgreSQL `REPEATABLE READ` transaction.
Responses include snapshot time, source watermarks, transfer reconciliation,
coverage, and observed staleness. Snapshot runs can be persisted through
`EconomyObservatoryService.captureSnapshot` without changing authoritative game
state. The server runs that capture immediately at startup and then as a
bounded, skip-overlap daily `PeriodicTask`; the first successful run establishes
the historical baseline used by confidence-gated health labels.

Inventory rows for market, Kingdom donation, City Warehouse donation, world-item
movement, and manor storage movement are not counted again as
creation/destruction: their authoritative market, donation, ground-drop,
warehouse, or manor event is projected as a conserved transfer group. Expired
world drops and City Warehouse consumption remain final sinks. Historical
world-item/equipment movement rows remain partial until a future backfill is
approved.

## Flow and health definitions

Gross inflow includes `SOURCE` credits and `TRANSFORM` outputs. Gross outflow
includes `SINK` debits and `TRANSFORM` inputs. `ADMIN` credits/debits remain
separate adjustments to net change; transfers are reported separately and are
not treated as creation or destruction. Unknown flow stays visible and is
excluded from confidence claims.

Holder HHI is the sum of squared holder shares. Normalized HHI uses the actual
holder count (`(HHI - 1/N) / (1 - 1/N)`), with a single holder reported as one.
Top-player statistics include top 1, 3, 5, and 10 players. Top-percent
statistics include 1%, 5%, and 10%; every percentage result includes the
actual holder count selected, not just the requested label.

Health is confidence-gated: stale data, incomplete coverage, insufficient event
volume, too few active players or holders, no captured historical baseline, or
an observation window shorter than one day produces `stale` or
`insufficient-data`; a reconciliation failure is `critical`. Concentration can
produce `watch` once the minimum confidence gate is met. Coverage is downgraded
to partial when the requested window predates a domain's reliable-from time.

The dedicated report endpoint (`/api/dev/economy/report`) is the primary
balancing dataset. It records explicit window and snapshot bounds, release
identity, coverage/reconciliation status, active-player denominators, current
scope quantities, flow/source breakdowns, acquisition evidence, holder
concentration, player-by-item movement, and level/activity/account-age/social
cohorts. Active-player means and medians include zero holders/acquirers;
holder statistics include only positive current holders. Attempt denominators
are emitted only for instrumented harvest sessions; unsupported source
denominators remain null and are marked in data quality.

Sessions persist connected time separately from gameplay activity. Gameplay
messages update active time; PING/keepalive, telemetry batches, startup
telemetry, application suspend, and bug-report submission do not count as
active gameplay. Connected sessions whose last gameplay is older than five
minutes are AFK.

## Private API and export

The API is under `/api/dev/economy/*` and is authorized and audited through the
existing Developer App HTTP path. `overview`, `items`, `items/:assetId`,
`players`, `players/:playerId`, `item-holders`, `cohorts`, `flow`, `report`,
and `export.xlsx` are read-only routes protected by `developer:observe`.
Items, players, and holders support server-side search, filters, sorting, and
pagination; catalog items with zero current supply remain visible. The
bounded XLSX export allows up to 100,000 rows per sheet (and Excel's column
limit), escapes XML, prefixes formula-looking text (`=`, `+`, `-`, `@`), and
writes quantities as exact text when they exceed safe JavaScript numeric
precision. Raw-data sheets have stable snake_case headers and preserve null
versus zero values. It contains README, 24h Summary, Overview, Item
Statistics, Acquisition Difficulty, Source Sink Flow, Source Breakdown,
Players, Player Holdings Wide/Long, Player 24h Flow, Item Holders, Unique
Assets, Organization Holdings, Cohort Statistics, Concentration, Coverage,
and Data Quality sheets. Wide item columns are discovered from the catalog at
export time; the README documents definitions, denominators, and gaps.

## Read-only database role

`db/roles/economy_observatory.sql` contains optional deployment guidance for a
separate `ash_atlas_economy_observer` NOLOGIN role. Grant it only SELECT access
to the observatory projection, snapshots, sessions, and the authoritative
tables needed for reconciliation; the application writer role remains the
owner of authoritative mutations.
