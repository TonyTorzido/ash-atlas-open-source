# Ash Atlas backup and recovery

## Recovery layers

Ash Atlas uses separate recovery layers because each protects against a
different failure:

| Data | VPS copy | Home copies | Schedule | Why |
| --- | --- | --- | --- | --- |
| PostgreSQL gameplay database | OVH additional disk | Internal intake, then Seagate mirror | Hourly | Limits ordinary data loss to about one hour. |
| Daily PostgreSQL checkpoint | OVH additional disk | Verified pull | 03:20 UTC daily | Keeps a wider recovery history without retaining every hourly dump forever. |
| Weekly PostgreSQL checkpoint | OVH additional disk | Verified pull | Sunday 04:20 UTC | Covers problems discovered weeks later. |
| Monthly PostgreSQL checkpoint | OVH additional disk | Verified pull | First day 05:20 UTC | Long-horizon recovery point. |
| Pre-migration dump | OVH additional disk through the canonical publication protocol | Verified pull and Seagate deep proof | Before a database migration | Captures the exact state immediately before a risky change; the newest three copies are retained by default. |
| Gameplay reset dump | Reset handoff on the VPS | Verified home intake, then Seagate mirror | Before an authorized gameplay reset | Preserves the exact pre-reset database through the existing verified reset-backup handoff. |
| Closed-test telemetry | Short VPS spool | Separately bounded verified archive | Exported by segment; home checks every two minutes | Preserves diagnostic history without making the game database the permanent archive; the portable telemetry cap is 10,000,000,000 decimal bytes. |
| Source, migrations, service definitions, and recovery tooling | Git and deployed release | Git clone | Every accepted change | Git provides immutable history and exact release identity; generated dumps do not belong in Git. |
| Secrets and host identity | Root-only live configuration | No plaintext automated copy | On intentional rotation | Database passwords and signing keys must not be copied to a portable disk in plaintext. Use a separately designed encrypted recovery bundle. |

The OVH disk protects the database from failure or exhaustion of the VPS
system disk. The Seagate protects against loss of the VPS or OVH account and
is the copy used for end-to-end restore drills. Neither is a substitute for
the other.

## PostgreSQL publication protocol

`create-database-backup.sh` refuses to run unless `/mnt/ash-atlas-backups` is
the configured read/write filesystem UUID on the configured physical-device
serial. It writes a custom-format dump into `.partial`, validates the restore
catalog with `pg_restore --list`, records byte count, SHA-256, class, database,
release SHA, and UTC time in a manifest, syncs both files, then atomically
renames the containing directory into `ready`.

The home SSH key is restricted to list/fetch/ack commands. The home pull first
validates the internal ext4 filesystem by mount, UUID, serial, and read/write
mode. It downloads into a same-filesystem partial file, rechecks size,
SHA-256, and restore catalog, syncs and atomically publishes it, writes a
receipt, and only then sends the acknowledgment to the VPS. A separate
additive-only job mirrors immutable published files to the identity-checked
Seagate. It never deletes or overwrites an existing destination file. A
successful mirror queues bounded PostgreSQL proof. A new physical destination
earns its SHA-256/catalog result once, after sync and final placement. A protected
HOME sidecar binds that result to the exact path, drive UUID/serial, inode,
size, full-resolution mtime/ctime, and small immutable metadata hashes.
Routine replay checks those bindings and reads zero dump bytes. Missing or
changed bindings defer verification; a copied removable-media receipt alone
never makes a new physical copy green. Original source ACK bytes and earned
verification timestamps remain unchanged on replay.

The nightly scrub rotates oldest-checked protected copies for at most 600
seconds, with 20 seconds reserved for state. Existing lifecycle locks cover
selection and final publication, and are released during payload reads.
Changed/replaced/retired copies discard the read result. Deadline exhaustion
is `partial`, never a completed cycle; cursor and timeout attempts persist.
Two timeouts for a copy or a rotation older than seven days warn visibly.
Weekly `ash-atlas-backup-restore-check --latest` restores one newest green
Portable copy in the existing isolated `ash_atlas_stability*` cluster, with a
60-minute timeout and separate successful restore record. Catalog readability
and an actual restore are distinct evidence.

The four VPS backup timers are deliberately separate. Hourly is the practical
recovery-point objective; daily, weekly, and monthly classes make later
tiered retention unambiguous. `Persistent=true` catches up one missed run
after a reboot, and randomized delay avoids stacking backup I/O on the exact
hour. Verified retention is re-evaluated every five minutes so a newly
accepted Seagate proof is not stranded until the next day.

The home intake is a fixed aggregate budget of **50,000,000,000 decimal
bytes**, with a warning at **40,000,000,000 bytes**. The budget includes
published dumps, receipts, partials, retry spools, two newest emergency copies,
telemetry, and a reserved 34,359,738,368-byte restore workspace under the intake
root; it is not an automatic-expansion request. Every write checks projected
post-write usage, a root-filesystem reserve, the configured in-flight peak,
and the single-writer lock. A failed or ambiguous filesystem identity,
read-only/full portable disk, missing mount, or changed mount identity fails
closed. The portable archive has its own physical free-space margin (at least
10% of that filesystem or the configured minimum) and never falls back to a
mountpoint directory on the root filesystem.

Paused cutover saves an immutable root-owned metadata-only VPS baseline at
`/var/lib/ash-atlas/backup-cutover-baseline.json`. Selection precedes legacy
resolution or byte fetching: each routine invocation admits two pending new
IDs, then one baseline ID beyond the existing VPS tier policy. Green IDs
replay source ACKs without using payload slots. Historical missing copies
remain deferred and cannot block a new hourly arrival. An explicit
`ASH_ATLAS_DATABASE_BACKUP_ID=UUID` invocation admits one seed/expiry ID; the
finite initial expiry list is checkpointed by the operator. More than two
new IDs pending or a pending new ID older than one hour warns as backlog.

Authorized discard of obsolete test-server HOME backups uses existing
migration `--cutover-plan --plan PATH --keep-list PATH`, then
`--cutover-apply` with the same arguments. These modes inventory metadata,
keep two recovery copies/reset/current telemetry, and unlink only exact
allowlisted regular-file paths after stat recheck and durable deletion intent.
Unknown files remain pinned. They neither hash discarded history nor claim
a verified surviving twin. Existing full migration audit/apply remains
available for workflows that require that stronger proof. The operator logs
irreversible removals and reclaimed bytes immediately before installing and
activating bounded jobs; personal Portable files and Frigate storage are outside
all backup paths.

The transfer is transactional: a source receipt and staged dump are verified,
the portable ID/hash directory is flushed and read-verified, then the VPS
acknowledgment is sent. Only after that acknowledgment is the newly managed
source intake copy released; its immutable receipt and portable placement
mapping remain available for recovery. The two newest verified emergency
copies remain on the bounded intake. Legacy, unclassified, or archive-only
intake is never released by the normal pull and remains pinned for the exact
migration workflow. Retries reuse the immutable acknowledgment identity and
reject a same-ID/different-hash conflict. Existing legacy flat Seagate copies
are adopted in place when their receipt, byte count, SHA-256, and restore
catalog agree, so a namespace change does not redownload the VPS cohort.

A migration deployment uses this same producer with the `pre-migration`
class. Deployment captures the newly published manifest on the OVH mount and
revalidates its identity, release SHA, byte count, checksum, and restore
catalog before any service stop or database mutation. An empty producer result
(including lock contention) or an invalid manifest stops deployment; no
database dump is staged on the VPS system disk.

Before that, the candidate is rehearsed without copying Main's data. The
deploy clones `ash_atlas_preflight_template` (rebuilt only when Main's
migration ledger changes, by replaying exactly the migrations Main has applied:
schema plus migration-seeded rows, about 50 MB), applies the pending migrations
to the clone, boots the candidate and the previous binary against it, then
drops it. Its free-space check is sized from the template, not from Main.
The rehearsal cannot see live player data, so data-dependent failures are
caught by the live run instead: pending migrations and their ledger rows are
applied in one transaction (`MIGRATION_TRANSACTION=batch`). If that run fails
and the ledger is unchanged, nothing committed, the intent marker is cleared,
and the previous release restarts. A pending migration that needs to run
outside a transaction (`CREATE/DROP INDEX CONCURRENTLY`, `VACUUM`, explicit
`BEGIN`/`COMMIT`, ...) is refused unless it carries the line
`-- ash-atlas-migration: allow-non-transactional`, which switches that release
to one transaction per file (a mid-batch failure then keeps earlier files and
needs reconciliation). The runner still wraps each file in a transaction, so
`CONCURRENTLY` and `VACUUM` cannot run through it in either mode.

## Installation and activation gates

The installers validate identities and install units, but do not enable or
start them. The current authorized test-history cutover uses a root-private
metadata baseline, two checked recovery seeds, exact-path deletion journal,
bounded copy/proof replay, and a latest isolated restore before timer activation.
The paused cutover also discards only standard abandoned database partials
under `.partial/database.XXXXXXXX/` and trims the oldest UUID-dated telemetry
archive dumps until total telemetry is at most 8,000,000,000 bytes. Current,
index, unknown/nonarchive files, reset material and the two recovery seeds are
protected; every removal is stat-rechecked and journaled without payload reads.
The full audit/restore-proof migration route below is optional certified
historical migration, not a prerequisite to discarding unwanted test history.
Set `stage` to the exact
root-owned staged package directory printed by the staging step. The current
staging directory is shown here as a concrete example; do not substitute an
unreviewed directory:

```sh
stage=/home/user/backup-bounded-archive-stage.PmFs03GO
test -d "$stage" || { echo "reviewed backup stage is absent: $stage" >&2; exit 1; }

sudo tools/release/vps/install-database-backup.sh \
  /mnt/ash-atlas-backups FILESYSTEM-UUID DEVICE-SERIAL SEAGATE-UUID

sudo "$stage/tools/telemetry-home/install-home-pull.sh" \
  /var/lib/ash-atlas/home-backup-intake INTERNAL-UUID INTERNAL-SERIAL \
  /mnt/seagate-telemetry 0000AAAA1111BBBB SERIAL000
```

For the initial cutover, first record the enabled state of every existing
home backup timer, then stop all old home writers and leave them stopped:

```sh
sudo sh -c 'for unit in \
  ash-atlas-telemetry-pull.timer ash-atlas-backup-mirror.timer \
  ash-atlas-backup-scrub.timer ash-atlas-seagate-mount.timer \
  ash-atlas-backup-watchdog.timer \
  ash-atlas-seagate-mount.service \
  ash-atlas-backup-prove.service ash-atlas-telemetry-pull.service \
  ash-atlas-backup-mirror.service ash-atlas-backup-scrub.service \
  ash-atlas-backup-watchdog.service; do
    printf "%s " "$unit"
    systemctl is-enabled "$unit" 2>/dev/null || true
  done' | sudo tee /var/lib/ash-atlas/backup-cutover-timer-state.txt >/dev/null
sudo systemctl stop \
  ash-atlas-telemetry-pull.timer ash-atlas-backup-mirror.timer \
  ash-atlas-backup-scrub.timer ash-atlas-seagate-mount.timer \
  ash-atlas-backup-watchdog.timer \
  ash-atlas-seagate-mount.service \
  ash-atlas-backup-prove.service ash-atlas-telemetry-pull.service \
  ash-atlas-backup-mirror.service ash-atlas-backup-scrub.service \
  ash-atlas-backup-watchdog.service
```

The legacy installed scripts do not honor the new lifecycle lock, so do not
run the audit, restore, migration apply, or either installer while one of
those writers is active. Keep the writers stopped through identity validation,
installation, and the first proof; restore the recorded timer states only as
the final explicit activation step. At the actual cutover, also pause VPS
retention deletion. Resume it only after every current VPS ID has a verified
portable keeper and current-source acceptance evidence; this home-first
change does not require a VPS release or wire-schema change.

For the existing full intake, use the staged root-only migration entrypoint in
two explicit phases. The audit is read-only apart from its exact plan artifact and
fails on unreadable required roots, while reporting unknown files and pinning
them by default:

```sh
sudo "$stage/tools/telemetry-home/ash-atlas-backup-migration.sh" --audit \
  --plan /var/lib/ash-atlas/backup-migration-2026-09-23.json
```

The first audit does not require the new
`/mnt/seagate-telemetry/ash-atlas-backup-archive` directory to exist. It
validates the mounted UUID, serial, filesystem, and read/write state, then
audits the existing flat Seagate mirror in place without creating a path at
an absent mountpoint. A missing canonical directory is therefore not a
mount-fallback permission; an unsafe, symlinked, wrong-identity, or
read-only mount still fails closed.

Review every `inventory` and `removals` entry. Historical deployment archives,
telemetry, emergency/partial trees, unknown classes, and anything without a
trusted source receipt plus an independently verified portable keeper remain
pinned. Before apply, run the real disposable restore checker against the
newest and an older removal keeper (both must be present in the plan):

```sh
sudo "$stage/tools/telemetry-home/ash-atlas-backup-restore-check.sh" \
  --plan /var/lib/ash-atlas/backup-migration-2026-09-23.json \
  --newest-dump /mnt/seagate-telemetry/ash-atlas-backup-archive/postgresql/backup-UUID/newest.dump \
  --older-dump /mnt/seagate-telemetry/ash-atlas-backup-archive/postgresql/backup-UUID/older.dump \
  --proof /var/lib/ash-atlas/backup-migration-2026-09-23.restore-proof.json
```

This checker uses two sequential restores in one fully preallocated, exact
32 GiB (34,359,738,368 bytes) loop-backed ext4 workspace, private Unix
sockets, no TCP, and disposable `ash_atlas_stability_*` databases. It keeps
WAL, tablespaces, logs, and temp files inside that image, refuses to
auto-expand or mutate a live database, and requires the configured 100 GiB
(107,374,182,400-byte) root reserve before allocation. `ENOSPC` is
inconclusive: all copies remain protected. Only after reviewing the proof and
plan may the exact source removals be applied:

```sh
sudo "$stage/tools/telemetry-home/ash-atlas-backup-migration.sh" --apply \
  --plan /var/lib/ash-atlas/backup-migration-2026-09-23.json \
  --restore-proof /var/lib/ash-atlas/backup-migration-2026-09-23.restore-proof.json \
  --legacy-behavior-adapted
```

Apply records a durable per-file deletion intent before each exact unlink and
reconciles only that recorded path after a crash. It never uses wildcard
deletion or treats a missing unrecorded source as already complete. It does
not install or enable services. During this reviewed apply phase, if the
canonical archive directory is still absent, the script creates only the
configured child below the already validated Seagate mount while its process
working directory is pinned to that mount, then revalidates identity before
keeper verification. It never recursively creates an absent mountpoint or
falls back to the root filesystem. After the plan and privileged
hardware/identity audit have been accepted, run the installer command above
while writers remain stopped. Do not seed the complete Seagate tree into the capped intake: adopt
existing portable history in place, repair only plan-selected missing keepers,
and retain the exact source/portable mapping. Then run one manual backup and
mirror it to the Seagate. Compare manifest/receipt size and SHA-256, run
`pg_restore --list` on both copies, restore the Seagate copy into a disposable
`ash_atlas_stability*` database, and check representative schema and row
counts. Only after that proof may the recorded database and home timers be
restored and explicitly enabled. A legacy archive
or telemetry inventory that cannot be classified and checksum-verified keeps
the cap blocked rather than being silently removed.

## Retention gate

No new routine-backup pruning is enabled automatically during installation.
Keep the existing deployment dumps unchanged until the VPS-to-OVH-to-Seagate
restore proof succeeds. Run the retention command in dry-run mode, review the
exact backup IDs and projected free bytes, then explicitly authorize the first
apply. The sustainable defaults are 6 hourly, 14 daily, 8 weekly, 6 monthly,
and 3 pre-migration verified recovery points. Recalculate them against actual
dump growth, the next-backup reserve, and free-space alarms before activation.
Installation propagates missing defaults (and replaces the earlier stock hourly
values 24/48 with 6) but deliberately does not enable the pruning timer;
activation remains a separate operator decision after proof.

Daily, weekly, monthly, and pre-migration points beyond their limit are removed
only after both the home source acknowledgment and the Seagate acknowledgment
validate. Hourly points are the exception: an hourly beyond its limit is
removed even without home acknowledgments, so a stalled home host cannot fill
the backup disk and stop all later backups. Its retention receipt records
`homeAcknowledged: false` and reason `beyond_hourly_limit_without_home_ack`.

The portable policy is 24 hourly, 14 daily, 8 weekly, and 12 monthly, but it
is the union of those tiers with every currently VPS-retained ID and the two
newest proven safety pins. Thus the portable hourly footprint normally remains
at least the VPS's hourly cohort. Because the restricted inventory
protocol has no separate completion marker, a successful current listing is
unioned with the previous successful listing; an ID remains pinned for one
extra scrub and is released only after it is absent twice. Malformed or empty
inventories without an explicit completion marker block pruning. The scrub verifies all
portable receipts and legacy flat copies, preserves milestone/pre-migration
and unknown classes, and removes only exact known portable directories through
a durable retirement intent. Current-source IDs require fresh proof/acceptance
evidence before they can leave the live pin set. A trusted legacy hash without
captured remote acceptance is explicitly
`ARCHIVE_ONLY / LOCALLY_VERIFIED / REMOTE_ACCEPTANCE_UNKNOWN`: it stays pinned
under normal tier and safety policy, and may leave only through an exact,
reviewed retirement journal; the system never invents a remote proof. No
portable retirement tombstone can invalidate a still-live VPS acknowledgment.

Deletion remains fail-closed: an OVH backup is eligible only after the home
deep scrub has checked its exact Seagate bytes and restore catalog and the VPS
has accepted the resulting per-backup proof. Only pre-migration copies beyond
their configured count become eligible, and milestone backups are permanently
ineligible. Retention produces a dry-run plan before apply. Never prune merely
because a transfer was attempted.

The scrub captures the exact VPS retained manifest cohort before starting its
long checksum pass. A backup published after that capture is deferred to a
later scrub; a missing receipt or damaged artifact from the captured cohort
still fails closed. A successful canonical pull queues the existing mirror,
and a successful mirror queues the bounded proof service, so a transient
missing receipt is retried promptly without replaying the full scrub. The
daily scrub is not launched by pull, mirror, or mount, and its timer does not
replay a stale missed run after reboot. Its failure or incompletion therefore
does not block ordinary mirroring or deployment. The deployment backup gate
also runs verified retention before creating a new pre-migration dump when
proven candidates are available.

The existing `database-health` response reports free bytes, required
headroom, headroom margin, beyond-limit count/bytes, currently eligible count,
latest proof age, latest scrub result, offsite reachability, and projected
backups/hours to exhaustion with an `ok`, `warning`, or `critical` capacity
alert.

When a backlog needs bounded recovery without waiting for the full scrub, run
`sudo ash-atlas-backup-prove --oldest N`, or name specific retained backups
with `sudo ash-atlas-backup-prove --backup-id UUID`. The installed mirror
follow-up uses `--unproved 1` to prove one oldest unproved retained backup per
successful mirror, keeping the normal path bounded while draining a backlog.
The command captures its retained cohort first, checks each selected local
receipt and exact Seagate dump against its protected earned sidecar, then
publishes the existing accepted Seagate proof. Arrivals after cohort capture
are deferred to a later run, and an already accepted immutable proof is
reported as skipped without a second dump read.

## Crash and outage behavior

ext4 journaling protects the OVH and internal-home filesystem metadata. NTFS
remains vulnerable to its dirty-volume flag after an abrupt power loss, so it
is a mirror rather than the first landing zone. Keep the Seagate attached to
the Linux home host, use UUID plus serial checks rather than `/dev/sdX`, and
never force-mount it. A udev-triggered service and five-minute timer retry only
the normal configured mount. If NTFS cannot mount, pull admits no payload to
the internal intake and withholds acknowledgments; it never creates a backup
directory on the underlying root mount. Once it mounts normally, bounded pull resumes
automatically. The pull reserves 100 GiB internally
and the mirror reserves at least 10 GiB or 10% of the Seagate filesystem,
whichever is larger. Telemetry is a separately bounded archive at
10,000,000,000 decimal bytes, with an 8,000,000,000-byte warning. It is not
automatically deleted or expanded; when a telemetry transfer would exceed the
cap, the mirror leaves that source untouched, reports an actionable
`portable telemetry archive cap would be exceeded` failure, and still finishes
database/reset sources that fit before evaluating telemetry. An operator must
classify or offload telemetry before retrying; no external offsite provider is
configured by this change. The scrub performs portable tier pruning only
after the independent proof and VPS-live pin checks. The pull releases only
the exact newly managed database/reset source after the portable commit and
VPS acknowledgment; legacy and unclassified source data remain pinned, and
the mirror never propagates deletes.

Recovery is `sudo ash-atlas-backup-recover`. It starts the internal pull first,
then attempts the normal Seagate mount and mirror. The bounded proof follow-up
is the routine strong checksum proof; the daily scrub is an independent
defense-in-depth pass, and the five-minute mirror check is the faster
size/mtime proof.

## Backup health alert (VPS)

The home watchdog records problems but delivers no notification, and it cannot
report anything while the home machine is off. `ash-atlas-backup-health-alert.timer`
runs hourly on the always-on VPS, reads the existing `database-health` report, and
also treats a home (2 TB) copy older than 24 hours as a problem. It posts to a
private Discord webhook on a change of state or reasons, repeats at most every 12
hours while a problem lasts, and posts once when backups are healthy again.

`install-database-backup.sh` installs the service and timer; enable the timer
separately. The webhook lives only in root-owned `/etc/ash-atlas/backup-alert.env`
as `ASH_ATLAS_BACKUP_ALERT_WEBHOOK_URL=...` (mode 0600). Use a private channel,
never the public patch-notes webhook. Without it the alert only logs to the
journal.

The weekly home restore check restores into a disposable cluster. Its dump is
passed to `pg_restore` as a root-opened stdin (not a `cat |` pipe, which failed
on a harmless broken pipe), and its cleanup trap preserves the real exit status
so a failed restore is never recorded as a pass.

## Backup watchdog (staged, operator activation required)

`install-home-pull.sh` also installs `ash-atlas-backup-watchdog.service` and
its fifteen-minute timer, without enabling or starting either. Dependencies
are Python 3.9+, smartmontools (`smartctl`), `ntfs-3g.probe`, and the existing
backup commands. No host configuration, store/release setting, notification
recipient, or notification delivery is changed by this feature. Activating
the timer is a separate operator action after installation and fixture review.
The watchdog has no mount condition: a missing Seagate must be reported.

Each poll reuses the canonical mount validation (mount, filesystem UUID,
physical serial, filesystem type, and read/write flags), checks both disks'
existing space reserves, reads SMART overall health and raw sectors 5/197/198
(reallocated, pending, uncorrectable), and collects kernel storage/USB/UAS
errors. Unsupported SMART, absent tools, unreadable evidence, wrong identity,
and truncated kernel evidence are problems, never successful checks. Kernel
queries filter storage/USB error messages before applying the bounded sample,
so unrelated high-volume Docker interface events cannot hide an earlier fault.
No-match results are checked against journal access before being accepted.
Kernel errors are conservatively retained for 24 hours across boots, including errors whose
device name changed on reconnect; unrelated host disk/USB faults may therefore
also inhibit retries. The mount snapshot, systemd results and recent logs,
mirror completion marker, scrub marker, and the pull's existing
`.ash-atlas-ovh-database-health.json` supply liveness evidence. The latter
includes VPS headroom, newest backup time, and the newest accepted Seagate
proof age. Accepted proof time is derived from that observation and has
one-minute precision; a successful systemd exit alone is never proof.

On the first poll in each UTC hour, the watchdog acquires the existing
pull/mirror/scrub locks without blocking and compares all canonical roots with
the mirror's size/mtime dry-run rules. The rsync `--delete` flag is used only
with `--dry-run` to detect extra destination files; it cannot remove data.
It also checks local PostgreSQL receipts, artifact sizes, and newest local
backup age. Busy jobs defer inspection until the next poll; a two-hour
validation delay escalates. A healthy hourly pass queues the existing
`ash-atlas-backup-prove.service` (`--unproved 1`), preserving bounded strong
checksum/catalog validation and the independent daily full scrub. Hourly
parity/receipt failures persist through light polls until revalidated.
An unsafe hourly preflight records a blocked attempt, never a success; the
following ticks stay light until the next hour. Status distinguishes blocked,
busy, failed, and successful deep attempts.

Automatic recovery is limited to requeuing an idle, previously successful
mirror or proof service when its durable evidence is stale or missing proof
is reported, and all other observations are healthy. Mirror/VPS observation
freshness is 30 minutes; newest backup and accepted proof limits are three
hours; the daily scrub limit is 48 hours. Failed or unknown service results,
divergence, low space, device problems, and unsupported inspection escalate
without repair. A queued recovery is confirmed on a later poll only by newer
durable mirror/proof evidence; lock skips and successful dispatch are not
recovery. An unconfirmed or failed retry latches further automatic attempts
until a fully healthy observation. Running jobs are observed for up to two
hours and never interrupted. Operators retain control of failed jobs.

There is no automatic filesystem recovery, remount, writer stop, `ntfsfix`,
`fsck`, force-mount, format, repartition, backup overwrite, or pruning. An
unverified Seagate receives only the non-mutating `ntfs-3g.probe --readwrite`
inspection after UUID/serial resolution; dirty, hibernated, already-mounted,
or otherwise unmountable volumes remain escalated. On a mounted NTFS volume,
the watchdog relies on read/write state and kernel error evidence rather than
forcing raw filesystem inspection. Any operator filesystem repair must first
preserve this evidence, stop writers, reverify UUID/serial, and inspect the
unmounted filesystem read-only. The existing normal-mount service/timer is
unchanged; the watchdog adds no mount attempts.

Root-only `/var/lib/ash-atlas/backup-watchdog/` contains atomic `status.json`,
concise `alert.json`, and daily JSONL history retained for 30 days. Alerts
include exact reasons, UUID/serial, mount and space observations, SMART,
kernel errors, service states, latest backup/mirror/proof/scrub times, and
recovery actions. `running.json` remains after an interrupted or timed-out
probe, and systemd also retains the failed invocation. These are diagnostic
artifacts, not delivery channels or deployment/retention authorizations.
Existing deployment manifest/checksum/catalog and retention proof gates are
unchanged. Never approve a deployment or delete backups from watchdog status.

Read current protection health without running probes or changing state:

```sh
sudo ash-atlas-backup-watchdog --status
```

The JSON reports Seagate availability, mirror/proof times, hourly inspection,
active incident, recovery actions/latch, and escalation state. Evidence older
than thirty minutes is reported as stale with a nonzero exit. The full report
and service journals remain the source for diagnosis. To request the same
hourly production checks immediately (including its existing safety gates):

```sh
sudo bash -c 'set -a; source /etc/ash-atlas/telemetry-home.env; exec /usr/local/sbin/ash-atlas-backup-watchdog --deep'
```

After the existing installer and operational review, activation is
`sudo systemctl enable --now ash-atlas-backup-watchdog.timer`. The persistent
calendar timer runs every fifteen minutes and two minutes after boot; the
first eligible poll in each UTC hour performs deep validation. Unit validation
and enablement alone are not reboot proof: record boot ID, timer invocation,
and post-boot report on the real host. Do not reboot a shared host until its
unrelated service risk and maintenance procedure have been reviewed.

### Staged operator handoff

No unattended diagnosis mechanism has been established for this backup host. The watchdog stages a root-only `incident.json` package for an operator to review; it does not launch automated tooling, use credentials, send notifications, or call external services.

An outage retains one incident identity even if its reason codes change.
Each observation increments its repeat count. An active bounded recovery
suppresses handoff packaging until success or failure is observed. A failed
recovery stages diagnosis and retains the retry latch. Repeated failures
refresh the single package after one hour, then two, four, eight, sixteen,
and at most once per twenty-four hours; they never create parallel incidents
or unattended invocations. Healthy evidence resolves the incident. Latest
status/history preserve observations between package refreshes; an older
package must always be compared with current status before use.

The package includes timestamp/codes, disk UUID/serial, mount and filesystem,
SMART and kernel evidence, mirror/proof service states, durable success times,
backup age and divergence, internal/Seagate/VPS space, attempted recovery,
and diagnostic paths. Its instructions require diagnosis before mutation and
preserve all independent backup gates. Logs are untrusted data. Formatting,
repartitioning, force-mounting, destructive filesystem repair, deletion of
unverified backups, gate changes, protected-branch changes, game changes,
notifications, and store/release changes are outside the handoff's authority.
Destructive hardware/filesystem work requires explicit human approval.

Run the disposable Linux fixtures with:

```sh
python3 -B tools/telemetry-home/backup-watchdog.tests.py
bash tools/telemetry-home/database-backup-pipeline.tests.sh
```
