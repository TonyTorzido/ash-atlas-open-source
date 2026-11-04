# Closed-test telemetry

## Purpose and boundary

This subsystem records operational and gameplay analytics for the private closed
test. It is backend-first and intentionally has no player-facing page, route,
download, console output, toast, debug overlay, or analytics endpoint.

The supported access path is:

1. the game and host sampler write to the private PostgreSQL `telemetry` schema;
2. an operator connects to the VPS over SSH;
3. the VPS-local exporter reads through the exporter role and writes a
   pseudonymized DuckDB file or Parquet bundle under
   `/var/lib/ash-atlas/telemetry-exports`;
4. a private home Linux computer lists and pulls only verified manifests over
   outbound SSH, archives them on a UUID-verified external drive, and
   acknowledges successful storage.

The VPS never connects to the home network. The design needs no home listener,
router port forwarding, webhook, HTTP export, or publicly reachable home
service.

PostgreSQL must remain bound to localhost or a private interface. Do not expose
port 5432 publicly and do not add a telemetry HTTP route.

## Kill switches and defaults

All collection and export paths default off.

| Variable | Default | Effect |
| --- | ---: | --- |
| `TELEMETRY_ENABLED` | `false` | Creates the isolated server writer pool and enables server/world/player/event collection. |
| `BUG_REPORTS_ENABLED` | `false` | Enables private authenticated player reports; requires telemetry. See [player-bug-reports.md](player-bug-reports.md). |
| `BUG_REPORT_EMAIL_API_KEY` | unset | Resend API key required when bug reports are enabled; keep it in the service environment, never Git. |
| `BUG_REPORT_EMAIL_FROM` | unset | Verified sender address required when bug reports are enabled. |
| `BUG_REPORT_EMAIL_TIMEOUT_MS` | `8000` | Maximum time to wait for the notification provider before returning a retryable submission failure. |
| `TELEMETRY_CLIENT_ENABLED` | `true` | Allows authenticated client frames only when server telemetry is enabled. |
| `VITE_CLOSED_TEST_TELEMETRY_ENABLED` | `false` | Compiles client sampling into an enabled closed-test client build. |
| `TELEMETRY_HOST_ENABLED` | `false` | Allows the rootless systemd host sampler to insert a sample. |
| `TELEMETRY_EXPORT_ENABLED` | `false` | Allows the CLI to invoke the VPS-local exporter. |

Operational settings:

| Variable | Default |
| --- | ---: |
| `TELEMETRY_SERVER_SAMPLE_INTERVAL_MS` | `10000` |
| `TELEMETRY_WORLD_SAMPLE_INTERVAL_MS` | `30000` |
| `TELEMETRY_WORLD_RECONCILIATION_INTERVAL_MS` | `600000` |
| `TELEMETRY_PLAYER_SAMPLE_INTERVAL_MS` | `300000` |
| `TELEMETRY_INVENTORY_CHECKPOINT_INTERVAL_MS` | `1800000` |
| `TELEMETRY_CLIENT_SAMPLE_INTERVAL_MS` | `30000` |
| `TELEMETRY_FLUSH_INTERVAL_MS` | `1000` |
| `TELEMETRY_MAX_BATCH_ROWS` | `500` |
| `TELEMETRY_QUEUE_MAX_ROWS` | `10000` |
| `TELEMETRY_DB_POOL_MAX` | `2` (hard maximum) |
| `TELEMETRY_WRITE_TIMEOUT_MS` | `500` |
| `TELEMETRY_SHUTDOWN_TIMEOUT_MS` | `2000` |
| `TELEMETRY_DEGRADE_QUEUE_PERCENT` | `80` |
| `TELEMETRY_DEGRADE_EVENT_LOOP_P99_MS` | `100` |
| `TELEMETRY_RECOVERY_HEALTHY_INTERVALS` | `3` |
| `TELEMETRY_SEGMENT_ROTATION_ENABLED` | `true` |
| `TELEMETRY_SEGMENT_DURATION_MS` | `3600000` |

`TELEMETRY_DATABASE_URL` is the writer login. Release generation, population
plan/spawn-rule versions, and balance version use
`TELEMETRY_RELEASE_GENERATION`, `TELEMETRY_POPULATION_PLAN_VERSION`,
`TELEMETRY_POPULATION_SPAWN_RULES_VERSION`, and
`TELEMETRY_BALANCE_VERSION`. The lifecycle CLI uses
`TELEMETRY_OPERATOR_DATABASE_URL`; export additionally requires
`TELEMETRY_EXPORT_DATABASE_URL` and `TELEMETRY_EXPORT_PSEUDONYM_SALT`.
`TELEMETRY_EXPORT_ROOT`, `TELEMETRY_EXPORT_MINIMUM_FREE_BYTES`, and
`TELEMETRY_EXPORT_SCRIPT` are optional restricted-path/tool overrides.

Feature-disabled server cost is one constructor branch and no timers, pool,
observer, queue writes, or database calls. Client-disabled cost is a constant
check and no timer.

## Data not collected

The telemetry protocol and metadata sanitizer reject or strip:

- chat and direct-message bodies;
- email, Google/OAuth identifiers, credentials, tokens, cookies, CSRF values,
  authorization headers, and raw IP addresses;
- raw user-agent strings;
- search text and arbitrary request bodies;
- client-supplied player, account, or session identity;
- player names and display names in metadata or JSON snapshots.

The authenticated WebSocket supplies `player_id`, `session_id`, and connection
generation on the server. The telemetry service creates a separate logical
play-session UUID, keeps it across retryable reconnects, and rotates it after a
completed session. Clients cannot impersonate another player in a telemetry
frame. Social telemetry records only request type/count; it never copies the
message or channel content.

## Schema and field groups

Migrations `0681_closed_test_telemetry.sql`,
`0682_closed_test_telemetry_health.sql`, and
`0683_hourly_telemetry_segments.sql` create and complete the private
`telemetry` schema. Every collected row includes schema version and, where
applicable:

- run ID;
- exact game release SHA and optional immutable test generation;
- authoritative world release ID;
- population plan, spawn-rule, and balance version;
- server instance ID.

### `telemetry.test_runs`

One row per test segment. Hourly rows have a segment ID, parent campaign ID,
sequence, and exact UTC start/end boundary. It owns run name, start/end times, immutable release
identity, population candidate/stone versions, capacity configuration, export
state, retention protection, and an explicit reset/wipe marker. A partial
unique index permits only one active run.

### `telemetry.server_samples`

Ten-second game-server and host samples. Fields cover:

- active/link-dead players and WebSocket connections;
- process PID, CPU percentage/deltas, RSS, V8 heap/external memory, available
  host memory, host CPU/load, and swap;
- event-loop mean/p50/p95/p99/max and GC counts/pause time by type;
- tick count, mean/p50/p95/p99/max, and 25/50/100 ms threshold counts;
- world-command queue depth/peak and accepted/processed/rejected/duplicate/
  stale/overflow totals;
- world/combat delta totals;
- WebSocket frame/byte totals and inbound broad-family counts;
- replaceable skips/coalesces and backpressure closures;
- gameplay pool connections, waits, acquisition timing, and idle errors;
- population/resource preparation pressure;
- telemetry queue, flush, drop, failure, and pool health;
- VPS load averages, disk, network, boot identity, and uptime from the host
  sampler.

Metrics are cumulative where the source system is cumulative. Time-window
metrics such as CPU deltas, tick histograms, event-loop histograms, frame
histograms, and redraw deltas are recorded per sample window.

### `telemetry.world_samples`

Thirty-second runtime-only samples iterate the already-cached active/warm zones;
they never walk the whole world in the tick loop. Rows are grouped by gameplay
zone and entity category:

- tree, deer, wolf, ogre, and permanent-stone-mine;
- archetype;
- unique wolf pack and distinct two-, three-, and four-member pack counts;
- resin-capable, resin-available, and resin-harvested tree;
- ready/alive, active-runtime, sleeping, and visible count.

A separate ten-minute PostgreSQL reconciliation computes planned, persisted,
ready/alive, dead/harvested, respawn-pending, and suppressed counts for current
V2 generations. Its source is explicitly
`postgres_reconciliation`. That slower pass also counts durable players,
personal/city/kingdom flags, cities, kingdoms, manors, dropped items, open
market orders, and pending market collections. Thirty-second runtime rows
separately record loaded players, PvE/PvP encounters, and
active/sleeping/preparing population zones.

### `telemetry.gameplay_events`

Typed selected events with indexed common columns and bounded sanitized JSON:

- login, reconnect, suspend, clean/retryable/terminal disconnect, and run
  freeze;
- travel transition start/success/failure with rejection code and duration;
- harvest start/completion/rejection, target, item, quantity, and replay state;
- combat summaries with class IDs, encounter size, damage, defeats, death, end
  reason, and duration, plus authoritative PvP damage/mitigation, kill, and
  death events for both participants;
- selected settlement, social, market, party, and combat request counts.

Durable economy/progression truth is not duplicated synchronously.
`authoritative_progression_events`, `authoritative_inventory_events`,
`authoritative_wallet_events`, and `authoritative_market_trades` are read-only
analytical views over the existing idempotent ledgers.
`authoritative_combat_summaries` exposes the existing bounded, replay-safe
combat balance summary and action trace without duplicating player identity
inside JSON.

### Player and inventory snapshots

`player_snapshots` records login, five-minute interval, logout, terminal
disconnect, and run-freeze state. It includes progression, class/subclass and
loadout, profession mastery, gold, equipment revision and active items, HP/life
and combat state, personal flag count, city/kingdom/manor/party affiliations,
coarse zone/current flag, and bounded cumulative revisions.

`player_inventory_snapshots` stores full item state on login/logout/freeze,
when the authoritative inventory event revision changes, and as a 30-minute
consistency checkpoint. Unchanged five-minute inventory state is not copied.
Nested identity fields are stripped before enqueue.

### `telemetry.client_samples`

Client sampling begins only after authenticated authoritative bootstrap, runs
at most once per 30 seconds while visible, and is discarded while offline.
The pending batch is capped at four. Fields include:

- normalized device, OS family, browser family/major version, installed-PWA
  flag, viewport, and screen-size class;
- FPS and frame p50/p95/p99/max plus 50/100 ms long-frame counts;
- RTT mean/p95 and authoritative snapshot age;
- reconnect, send-failure, and stale-socket counts;
- visible flag/collectible/combat entity and retained display-object counts;
- collectible/static-overlay redraw counts and duration;
- client build identifier.

Diagnostic reasons are `reconnect_success`, `reconnect_failure`, `protocol_failure`,
`severe_frame_stall`, `world_resync`, and `repeated_send_failure`. Frames are
strict, rate limited, server-attributed, one-way, and produce no response.

### Session summaries and health

`session_summaries` is one compact aggregate at terminal session end or run
freeze: duration, device, reconnect/disconnect counts, travel distance,
encounters, kills/deaths, damage, rejection histograms, transition failures,
features used, errors, and bounded client RTT/frame aggregates. Economy fields
contain only server-authoritative events observed in the session accumulator;
run-wide authoritative economy analysis should use the ledger views.

`telemetry_health` exposes only through PostgreSQL/SSH: enabled/degraded state,
queue depths, last successful flush, flushed/dropped rows by priority and event
type, last database error, writer pool counts, failure streak, host-sampler
freshness, and disk headroom.
`export_receipts`, `segment_acknowledgments`,
`segment_retention_receipts`, and `cleanup_receipts` make export, receipt, and
deletion auditable.

## Resource budgets and degradation

Defaults:

- writer pool: maximum two connections, independent of the gameplay pool;
- write/query/statement timeout: 500 ms;
- queue: 10,000 rows;
- flush: one second or 500 rows;
- shutdown drain deadline: two seconds;
- important/critical retry: one bounded retry with jittered backoff;
- routine coalescing for repeated server/world/player/client samples.

Priority order is critical, important, routine. A full queue evicts routine
rows first. Only critical data may displace important data. Routine data is
stopped when:

- the queue reaches 80%;
- three consecutive writes fail; or
- server event-loop p99 reaches 100 ms.

Recovery requires three healthy observations. Database outages never block a
gameplay request or retry forever. Warnings are rate-limited. Shutdown stops
accepting, makes one strict bounded drain attempt, and closes its own pool.

## Database roles

Apply as the database administrator after the migration:

```sh
psql "$DATABASE_URL" -v DBNAME=ash_atlas_game -f db/admin/telemetry_roles.sql
psql "$DATABASE_URL" -v DBNAME=ash_atlas_game -f db/admin/telemetry_operator_role.sql
```

Then create three distinct LOGIN roles outside Git:

- ingest login in `ash_atlas_telemetry_writer`;
- export login in `ash_atlas_telemetry_exporter`;
- lifecycle login in `ash_atlas_telemetry_operator`.

Put only `TELEMETRY_DATABASE_URL` and the host kill switch in
`/etc/ash-atlas/telemetry-writer.env`, owned by root, mode `0600`; that is the
only file loaded by the game/host sampler. Keep the read-only exporter URL,
operator URL, and pseudonym salt in a separate root-only
`/etc/ash-atlas/telemetry-export.env` used by the SSH/sudo workflow. No password
or connection URL belongs in Git, logs, a DuckDB artifact, or a command line.

The writer has no public-schema privileges. It can read only run identity and
health bookkeeping, insert telemetry rows, update health, and set only the
run-ingestion closure timestamp. It can execute only the narrow
security-definer segment-rotation function, which locks and validates the
scheduled boundary before closing/creating rows. The exporter is read-only. The operator
can manage run metadata, receipts, and bounded retention deletion but cannot
read gameplay tables in `public`.

## Run lifecycle

From the deployed release root on the VPS:

```sh
export TELEMETRY_OPERATOR_DATABASE_URL='postgresql://...'
export RUNTIME_SHA='<exact deployed 40-character master SHA>'
export TELEMETRY_RELEASE_GENERATION='test/t183'
export WORLD_REQUIRED_RELEASE_ID='<verified world release>'

pnpm --filter @ash-atlas/server telemetry start \
  --name 'Closed test 2026-07-24' \
  --capacity '{"expectedPlayers":10,"serverTickHz":30}'

pnpm --filter @ash-atlas/server telemetry status
pnpm --filter @ash-atlas/server telemetry freeze
```

Start creates a segmented campaign by default and refuses a second active run.
Use `--unsegmented` only for a deliberate legacy/manual run. The initial
segment ends at the next configured UTC duration boundary. At every boundary,
the server immediately closes attribution to the expired segment, captures
final state, drains its bounded queue, atomically freezes it, and creates the
next child run. Connected gameplay sessions continue under new
segment-scoped logical session IDs. Gameplay does not await the drain or any
export/transfer work. Rotation errors close only telemetry attribution and
retry every 15 seconds; gameplay continues.

Manual freeze stamps the end time. The server sees
the boundary, stops accepting new run rows, emits run-freeze events, captures
active players, writes session summaries, performs a bounded flush, and only
then stamps `ingestion_closed_at`. Export refuses a run without that closure
acknowledgement. Do not export a still-active or still-draining run.
The writer also ignores an active run unless its release SHA/generation, World
release, population plan/spawn rules, and balance version exactly match the
running server. Correct the operator manifest; never attach mismatched data.

For a destructive game reset, freeze/export/verify the old run first. Start a
new run with `--reset-wipe` to store `reset_wipe_marker=true`. Never silently
combine pre-wipe and post-wipe data.

## Host sampler

Create the non-login `ash-atlas-telemetry` service user and grant it
read/execute access to the deployed helper. Keep
`/etc/ash-atlas/telemetry-writer.env` root-owned and mode 0600; the service
manager loads it before dropping privileges. Then install
`ash-atlas-telemetry-host.service` and `.timer` from `tools/release/vps`.
Adjust the deployed release path if needed:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now ash-atlas-telemetry-host.timer
systemctl list-timers ash-atlas-telemetry-host.timer
```

The resource-limited oneshot checks `TELEMETRY_HOST_ENABLED=true`, runs as the
unprivileged `ash-atlas-telemetry` account every ten seconds, samples `/proc`,
`df`, and the game service PID, and writes only host fields. It does not inspect
sockets, request data, or player data.

## Export and download

Install DuckDB, PostgreSQL client tools, and `jq` on the VPS. Set a strong,
stable export salt in the root-only environment file. The salt is used for
consistent SHA-256 pseudonyms and is not stored in the artifact.

```sh
export TELEMETRY_EXPORT_ENABLED=true
export TELEMETRY_EXPORT_DATABASE_URL='postgresql://readonly-exporter...'
export TELEMETRY_OPERATOR_DATABASE_URL='postgresql://operator...'
export TELEMETRY_EXPORT_PSEUDONYM_SALT='<secret>'

pnpm --filter @ash-atlas/server telemetry export --run-id '<uuid>'
pnpm --filter @ash-atlas/server telemetry export --run-id '<uuid>' --parquet
```

The exporter:

- uses a nonblocking `flock`, so only one export runs;
- refuses active runs and low disk headroom;
- writes a mode-0600 partial artifact;
- pseudonymizes all direct player/session/actor identifiers consistently;
- filters authoritative ledger views to the exact run time window;
- verifies every run-scoped source/artifact row count;
- records table counts and time ranges;
- creates an in-artifact export manifest with versions, export time,
  pseudonymization state, row counts, and time ranges;
- computes a SHA-256 checksum;
- atomically renames the artifact and checksum;
- inserts a verified receipt and marks the run exported;
- atomically publishes a versioned `.ready.json` manifest last.

On any failure, the exporter removes partial and final-looking artifacts,
creates only a mode-0600 `.failed` marker, and records a failed receipt without
downgrading an existing verified receipt. A retry writes a new timestamped
artifact and receipt.

The ready manifest contains segment/campaign/run identity, UTC bounds, release,
World/population/balance identity, filename/format/bytes/SHA-256, every table
count, timestamps, exporter version, pseudonymization key ID (never its salt),
and acknowledgment state. A failed export removes any final-looking artifact
and never publishes a ready manifest.

Install the export and retention service/timer pairs from
`tools/release/vps`. Copy `telemetry-export.env.example` to the root-readable
`/etc/ash-atlas/telemetry-export.env`, provide real secrets, and install the
restricted account with a dedicated public key:

```sh
sudo tools/release/vps/install-telemetry-pull-account.sh \
  /root/home-telemetry-pull.pub
sudo install -d -o root -g root -m 0700 /var/lib/ash-atlas/duckdb
sudo install -m 0644 tools/release/vps/ash-atlas-telemetry-{export,retention}.{service,timer} \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now \
  ash-atlas-telemetry-export.timer \
  ash-atlas-telemetry-retention.timer
```

The key receives `restrict` plus a forced command. It cannot obtain an
interactive or arbitrary shell, sudo, forwarding, database credentials,
gameplay files, salts, partial files, or unverified exports. Its entire
protocol is `list`, `fetch SAFE_NAME`, and `ack MANIFEST SHA256 1`. The server
revalidates manifest/run/segment/SHA/version/timestamp and uniqueness before
an acknowledgment enters PostgreSQL. Never expose this directory through
Caddy or another HTTP server.

## Hourly segment retention

`retain-telemetry-segments.sh` is serialized by `flock`, ingests validated
acknowledgment markers, and removes only exact non-active segmented run IDs
from the seven telemetry-owned row tables and corresponding verified spool
paths. It records row counts, artifact bytes, reason, acknowledgment state,
archival-loss state, and cleanup time. A later invocation finishes spool
cleanup after an interruption.

Defaults are the current active segment plus five completed segments, a
seven-day maximum measured from segment start, a ten-minute
post-acknowledgment grace, a five-minute timer, and no emergency byte cap:

| Variable | Default |
| --- | ---: |
| `TELEMETRY_COMPLETED_SEGMENT_LIMIT` | `5` |
| `TELEMETRY_HARD_MAX_AGE_SECONDS` | `604800` |
| `TELEMETRY_ACK_GRACE_SECONDS` | `600` |
| `TELEMETRY_EMERGENCY_BYTE_CAP` | `0` |
| `TELEMETRY_EXPORT_ROOT` | `/var/lib/ash-atlas/telemetry-exports` |
| `TELEMETRY_ACK_ROOT` | `/var/lib/ash-atlas/telemetry-acknowledgments` |

The shipped retention timer runs every five minutes. Change the schedule with
a systemd drop-in for
`ash-atlas-telemetry-retention.timer` (`OnUnitActiveSec=` and
`AccuracySec=`); keep it comfortably below the one-hour segment duration.

An unacknowledged segment is retained beyond the five-completed target until
the hard age is reached (unless an explicitly configured emergency byte cap
is exceeded). At the hard limit PostgreSQL rows and spool files are deleted
even without a home acknowledgment. The receipt sets
`archival_data_lost=true`; this is the explicit cost of bounded VPS storage.
The seven-day ceiling is an outage buffer, not a normal retention target. At
the measured closed-test export rate it consumes well under the verified free
space on the VPS system disk, while allowing multi-day home power or Internet
failures to recover without losing unacknowledged telemetry.
An open Linux download survives unlinking through its file descriptor; a
download that has not opened the artifact fails and retries without
acknowledgment. The active run and all non-telemetry gameplay data are outside
the deletion query.

## Legacy day-based retention and protected runs

Preview is the default:

```sh
pnpm --filter @ash-atlas/server telemetry retention
pnpm --filter @ash-atlas/server telemetry retention --apply --batch-size 1000
```

Deletion is bounded and applies only to frozen/exported/failed runs whose
export receipt is verified and which are not protected:

- server/world samples: 60 days;
- client samples: 30 days;
- inventory snapshots: 90 days;
- gameplay events and player snapshots: 90 days;
- session summaries: indefinite.

Override the finite defaults with `TELEMETRY_RETENTION_SERVER_DAYS`,
`TELEMETRY_RETENTION_WORLD_DAYS`, `TELEMETRY_RETENTION_CLIENT_DAYS`,
`TELEMETRY_RETENTION_GAMEPLAY_DAYS`, `TELEMETRY_RETENTION_PLAYER_DAYS`, and
`TELEMETRY_RETENTION_INVENTORY_DAYS`. Run metadata and receipts are retained. Set
`protected_from_retention=true` for milestone/baseline runs. Cleanup writes a
receipt in the same transaction as every bounded deletion batch, containing
policy, per-table deleted counts, and protected runs skipped.

## Private home Linux archive

Install DuckDB, OpenSSH client, `jq`, and standard GNU utilities. Generate a
dedicated Ed25519 key without reusing a personal key. Put only its public half
on the VPS. Pin the VPS host key out of band by comparing its fingerprint with
the hosting console/provider value; do not trust an unauthenticated first
connection or use `StrictHostKeyChecking=no`.

Identify the portable filesystem with `lsblk -f` or `blkid`, mount that UUID
persistently, then:

```sh
sudo tools/telemetry-home/install-home-pull.sh \
  /var/lib/ash-atlas/home-backup-intake INTERNAL-UUID INTERNAL-SERIAL \
  /mnt/seagate-telemetry SEAGATE-UUID SEAGATE-SERIAL
sudoedit /etc/ash-atlas/telemetry-home.env
sudo install -m 0600 dedicated-pull-key /etc/ash-atlas/telemetry-pull-ed25519
sudo install -m 0644 pinned-known-hosts /etc/ash-atlas/telemetry-known-hosts
sudo ash-atlas-backup-recover
```

The pull service lands data on the internal ext4 intake and does not depend on
the removable Seagate. The scripts independently check exact filesystem UUID,
physical-device serial, read/write mode, owner, and free space before writing.
The pull locks locally, downloads into a
same-filesystem partial directory, validates syntax and names, verifies
bytes/checksum, opens DuckDB (or validates a Parquet bundle), compares identity
and every table count, syncs the files, atomically renames the segment into
`archive/YYYY/MM/DD/`, and only then acknowledges it. Interrupted downloads,
duplicates, and lost acknowledgments retry safely. Invalid material moves to
`rejected/`; ordinary output is in the system journal and the archive reserves
`logs/`. A separate five-minute job additively mirrors published data to the
normally mounted Seagate, then queues bounded per-backup PostgreSQL proof.
The daily checksum/catalog scrub remains an independent defense-in-depth pass.
A udev trigger plus retry timer mounts only through the existing fstab entry;
no component force-mounts NTFS. If the Seagate is dirty or absent, the
internal pull continues and the mirror catches up when it becomes healthy.

Status, troubleshooting, and uninstall:

```sh
systemctl status ash-atlas-telemetry-pull.timer
journalctl -u ash-atlas-backup-mirror.service
journalctl -u ash-atlas-backup-prove.service
journalctl -u ash-atlas-backup-scrub.service
journalctl -u ash-atlas-telemetry-pull.service
sudo ash-atlas-backup-recover
findmnt -T /var/lib/ash-atlas/home-backup-intake -o TARGET,UUID,OPTIONS
findmnt -T /mnt/seagate-telemetry -o TARGET,UUID,OPTIONS

sudo systemctl disable --now ash-atlas-telemetry-pull.timer \
  ash-atlas-backup-mirror.timer ash-atlas-backup-scrub.timer \
  ash-atlas-seagate-mount.timer
sudo systemctl daemon-reload
```

Do not remove the archive unless its permanent local retention is separately
and explicitly decided.

## Health checks and expected rates

`telemetry status` reports recent runs and ingestion closure, relation sizes,
server-sample rate, health rows, drop counts by event type, and the latest
export. For one server at defaults, expect approximately:

- six game-server rows/minute;
- six host rows/minute;
- two world-runtime sampling passes/minute;
- one player row per online player/five minutes;
- one client row per visible ready client/30 seconds;
- one reconciliation pass/ten minutes.

Useful SSH-only SQL:

```sql
SELECT run_id, status, started_at, ended_at, release_sha, export_status
FROM telemetry.test_runs ORDER BY started_at DESC;

SELECT server_instance_id, recorded_at, degraded,
       queue_depth_critical + queue_depth_important + queue_depth_routine AS queue_depth,
       last_successful_flush_at, rows_dropped, rows_dropped_by_event_type,
       last_database_error
FROM telemetry.telemetry_health;

SELECT date_trunc('minute', recorded_at) AS minute, sample_source, count(*)
FROM telemetry.server_samples
WHERE run_id = '<uuid>'
GROUP BY 1,2 ORDER BY 1 DESC;

SELECT entity_category, sum(ready_alive_count), sum(dead_harvested_count),
       sum(respawn_pending_count), sum(suppressed_count)
FROM telemetry.world_samples
WHERE run_id = '<uuid>' AND reconciliation_source='postgres_reconciliation'
GROUP BY entity_category ORDER BY entity_category;

SELECT rejection_code, count(*)
FROM telemetry.gameplay_events
WHERE run_id='<uuid>' AND rejection_code IS NOT NULL
GROUP BY rejection_code ORDER BY count(*) DESC;

SELECT device_category,
       approx_quantile(frame_time_p95_ms, 0.5) AS median_client_p95_ms,
       approx_quantile(rtt_p95_ms, 0.5) AS median_rtt_p95_ms
FROM client_samples
GROUP BY device_category;
```

The last query is intended for DuckDB after export.

## Reading an export

SQL with the DuckDB CLI:

```sh
duckdb /secure/path/ash-atlas-run.duckdb \
  "SELECT * FROM export_manifest; SELECT event_type,count(*) FROM gameplay_events GROUP BY 1;"
```

Python:

```python
import duckdb
connection = duckdb.connect("ash-atlas-run.duckdb", read_only=True)
print(connection.sql("select * from export_manifest").fetchall())
```

R:

```r
library(DBI)
library(duckdb)
connection <- dbConnect(duckdb(), "ash-atlas-run.duckdb", read_only = TRUE)
dbGetQuery(connection, "SELECT * FROM export_manifest")
```

## Failure recovery and disclosure

If the telemetry database is unavailable, leave gameplay running. Check
`telemetry status` and backend warnings, restore only the private PostgreSQL
service/credentials, and wait for health to recover. Do not enlarge the queue,
raise timeouts, point telemetry at the gameplay pool, or bypass
`ingestion_closed_at`. Important/critical rows receive one bounded retry;
drops remain visible by priority and event type.

Closed-test agreements or privacy notices must plainly state that gameplay,
social-feature counts, and technical-performance analytics are collected for
debugging, capacity planning, and balance analysis. Do not describe collection
as absent merely because there is no in-game analytics UI or recording badge.

## Operator QA

Before enabling a closed test:

1. confirm exact release SHA/world identity and migrations `0678`/`0679`/`0680`;
2. confirm PostgreSQL listens only on localhost/private socket, no firewall or
   container rule publishes 5432, and no Caddy route serves the export path;
3. verify writer/exporter/operator grants using separate logins;
4. start a test run and confirm one active row;
5. verify game/host samples and health freshness;
6. disconnect/reconnect a test client and confirm no UI/console disclosure;
7. intentionally stop the telemetry database and confirm gameplay remains
   responsive while health degrades and routine rows drop;
8. freeze, export, verify checksum/counts/time ranges, and inspect pseudonyms;
9. preview retention before any `--apply`;
10. verify no telemetry artifact, environment file, or database URL is tracked
    by Git.
