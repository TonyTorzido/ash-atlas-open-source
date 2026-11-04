# Resource Vision after Population V2

Resource Vision now carries water highlights and readiness metadata only. Population V2 is the
sole owner of live tree, mob, and permanent-mine placement.

## Responsibilities and active entry points

`ResourceVisionJobQueue` is a two-worker durable preparation queue backed by
`PostgresResourceVisionJobStore`. Its active transport call sites are:

| Trigger | Call site | Durable reason | Admission behavior |
| --- | --- | --- | --- |
| HTTP flag creation | `POST /api/flags` in `http/routes.ts` | `flag-created` | fire-and-report-error; one contract can be admitted |
| realtime flag build completion | build coordinator completion in `realtime/websocket.ts` | `flag-build` | adopts the already prepared plan under an exact build/session fence; falls back to `ensureQueued` |
| successful flag travel | flag resource stream in `realtime/websocket.ts` | `flag-visit` | only when status is not already ready; completion is fenced to the current connection/view |
| reconnect at a flag | reconnect bootstrap in `realtime/websocket.ts` | `flag-visit` | deduplicates against the same durable contract and fences completion to the current view |

`dev-prewarm` remains a valid durable reason and is covered by store tests, but no live production
route submits it. A job key contains flag, layout, radius, World release, profile fingerprint,
build-contract fingerprint, and boundary release; different reasons for the same contract collapse
to one row, with an active visit able to promote priority.

## Durable and in-memory state

- `resource_vision_jobs` owns admission, priority, owner/generation, lease, attempts, retry time,
  error, and requested/started/completed timestamps. Rows cascade when their flag is deleted and
  otherwise have no age-based cleanup.
- `flag_resource_visions` owns the client-facing `pending`, `generating`, `ready`, or `failed`
  status, radius, node/water counts, and timestamps. It also cascades with the flag.
- `completionListeners` is the only process-local queue. It is best-effort, capped at 128 per job
  and 4,096 total, removed on completion or terminal failure, and lost safely on restart.
- `activeJobKeys`, `activeCount`, and the last durable metrics snapshot are bounded worker state.
- `spawn_cells` are retained historical scaffolding only. Resource Vision has no population
  generator and never writes population rows.
- Population V2 now owns deterministic tree, mob, and repeatable-resource plan contents and their
  projections. Resource Vision reads projected collectible rows for the completion snapshot but
  does not create the V2 plan or entities.

## What a V2-only job produces

The production `CollectibleService.prepareResourceVision` performs the bounded World water lookup
and produces:

- water-source highlights for the 650 m Resource Vision;
- `flag_resource_visions` readiness metadata with zero legacy-generated nodes;
- `RESOURCE_VISION_LOADING` then `RESOURCE_VISION_READY` transport state when a visiting client
  observes an unfinished vision;
- the ordinary collectibles/repeatable/inventory snapshot after readiness, whose V2 entities come
  from Population V2 projections rather than this job.

The flag-build completion callback adopts prepared Resource Vision state before publishing
`FLAG_CREATED`.
Flag travel itself is not held open by Resource Vision: the resource stream runs as independent
phase-two work after authoritative travel, while the separate Population V2 visible gate remains
closed until every P0 zone is authoritative. Resource Vision therefore contributes to visible water/readiness state,
but not to travel authorization, payment, relocation durability, or Population V2 terminal state.

## Rate and duration measurements

A read-only production snapshot on 2026-07-22 contained 34 flags, 34 status rows, and 42 durable
jobs. All 42 were completed: 34 were last labeled `flag-build`, eight `flag-visit`, none were
pending/processing/failed, and the maximum attempt count was one. There were 1.235 retained jobs
per flag with jobs, a maximum of two, and eight flags had two historical contract rows. The extra
rows reflect contract identity changes, not duplicate admission for one identity.

For the 42 completed samples, `completed_at - started_at` averaged **579.11 ms** and the maximum was
**5,031.98 ms**. The current table cannot supply “visits attempted,” so a durable-job-per-visit
denominator is not recoverable. Code-path accounting is precise: a new build admits at most one
logical contract, and a visit performs one `ensureQueued` call only when status is not ready; that
call creates zero or one durable row because submission is transactionally deduplicated.

The nominal current-path SQL counts are:

- prepared flag-build adoption: 14 Resource Vision completion statements, plus the job insert
  already performed in the flag transaction (15 total);
- a fresh not-ready flag visit: nine admission/status statements and eleven successful worker
  statements (20 total);
- a duplicate ready visit: status checks only and no worker;
- monitoring adds asynchronous aggregate-metrics queries, while empty worker polls are amortized
  supervisor overhead rather than job work.

Those counts come from the concrete store/service statements and exclude connection acquisition,
World HTTP calls, optional heartbeats, retry statements, and unrelated flag/inventory transaction
work. There is no per-job SQL-statement counter today; adding one behind authenticated diagnostics
would be the clean way to validate these structural counts continuously.

## Lease, retry, failure, and cleanup behavior

- The default lease is 60 seconds. Both ordinary and prepared claims heartbeat every 20 seconds
  (`max(1s, lease/3)`) and generation-fence every heartbeat, ownership check, completion, and
  failure update.
- The measured maximum duration was below the first heartbeat, so the sampled completed jobs
  required no heartbeat. Heartbeat counts are not persisted.
- Startup and claim passes recover expired leases. Failed jobs retry with bounded exponential
  delays of 2–60 seconds and terminate after eight attempts. A later explicit request may reset a
  terminal row for one new bounded cycle.
- The production snapshot showed no retry or terminal-failure rows and a maximum of one attempt.
- Completed job/status rows persist for audit/deduplication and cascade with flag deletion. There
  is no completed-row retention policy, so table growth is bounded by flag contracts over time,
  not by a configured age.
- Completion subscribers are deleted before callbacks run; callback failure is logged and does not
  change durable completion. Shutdown stops admission polling and waits for active workers.

## Client dependencies

The shared protocol exposes `RESOURCE_VISION_LOADING`, `RESOURCE_VISION_READY`, and the
`COLLECTIBLES_SNAPSHOT` fields `resourceVision`, `resourceVisionStatus`, and `waterHighlights`.
The client uses them for loading state, active-vision matching, map water overlays, diagnostics,
and performance counters. Removing the subsystem without a replacement would therefore change
public frame timing/meaning even though Population V2 owns the entities.

## Recommendation

**Replace with a bounded Water Vision service in a later wave.** Preserve the existing Resource
Vision frames/status transition during migration, add authenticated per-job rate/duration/statement
telemetry first, prove V2 projected entities are ready independently, then retire the generic job
name and historical legacy-generation branches under separate rollback and schema-retention review.
