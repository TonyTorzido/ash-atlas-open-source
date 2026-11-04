# Ash Atlas development environments

Ash Atlas uses `integration/test` as its active development trunk, one isolated worktree per task,
one permanent Main launcher, and optional generated launchers for work that needs an interactive
runtime.

Feature launchers live outside Git at:

```text
C:\Users\dev\Documents\Ash Atlas Feature Launchers\Active
C:\Users\dev\Documents\Ash Atlas Feature Launchers\Merged
```

Existing legacy launchers at the parent folder remain in place and functional.

Runtime defaults are tracked in `config/dev-runtime.defaults.json`. Feature leases live at
`%LOCALAPPDATA%\AshAtlas\dev-runtimes.json`; World group leases, exact-commit source, membership,
process state, and logs live under `%LOCALAPPDATA%\AshAtlas\world-runtimes\<group-id>\`.

## Integration Test generations

Immutable Git tags `test/t000`, `test/t001`, and onward identify accepted
`origin/integration/test` checkpoints. The SHA is the technical identity and the zero-padded
generation is its readable label. Existing labels remain three digits through `test/t999`; labels
use four digits beginning with `test/t1000`. Tags are never moved, reused, rewritten, or deleted.

Inspect the current checkpoint without changing it:

```powershell
.\tools\dev\test-generation.ps1 status
```

`status` reads the remote Integration Test tip and complete generation namespace in one remote
snapshot, then reports its exact SHA, generation, next generation, and snapshot ID. Its remote
round-trip count is constant as generation history grows. Local-only stale tags are ignored.
Feature creation refuses an untagged current tip.

The one-time bootstrap command, run only after this workflow feature is merged and accepted, is:

```powershell
.\tools\dev\test-generation.ps1 initialize -ConfirmGenerationCheckpoint
```

It is allowed only when no generation tags exist and creates `test/t000` at the unchanged exact
remote tip. Routine integrations use the canonical orchestrator. Its internal `advance` call
supplies both the approved original tip and exact local candidate:

```powershell
.\tools\dev\test-generation.ps1 advance `
  -IntegrationTestSha <40-character-local-candidate-sha> `
  -ExpectedIntegrationTestSha <40-character-approved-original-tip> `
  -ConfirmGenerationCheckpoint
```

The helper proves candidate ancestry and uses one atomic push for the `integration/test` branch and
next immutable tag. A retry reconciles an already-completed exact publication and refuses partial
or mismatched state. Failed integrations, local testing, restarts, cleanup, and promotion to
`master` do not advance the generation.

## Lean feature flow

Use the `atree` skill:

1. Before creating anything, check for a related active unmerged feature and continue it when one
   exists.
2. Fetch origin and generation tags, then require the exact `origin/integration/test` tip to have
   one generation checkpoint.
3. Record its generation and exact SHA and create one focused branch and worktree from that SHA.
4. Register a runtime only when interactive verification requires it.
5. Implement the smallest correct solution using the existing architecture.
6. Perform only the relevant proportional verification.
7. Commit and push the feature branch.
8. Report no more than eight concise bullets and stop.

### Continue active work

A feature remains one active task until it is accepted into `integration/test` or explicitly
abandoned. Review feedback, bugs found while testing, refinements, and added requirements for an
unmerged feature continue as commits in its existing branch, worktree, runtime, disposable
database, and launcher.

Reuse the existing feature when the user names or tests its launcher, reports a bug found while
testing it, asks for an adjustment or additional requirement before integration, or a related
active worktree exists without a merged or abandoned marker. Words such as "fix", "small issue",
or "additionally" do not by themselves create a separate task.

Create a new feature only when the request is genuinely independent, the related feature was
already accepted into `integration/test`, the prior feature was explicitly abandoned, or the user
explicitly requests separate work. If duplicate active features already exist, stop creating more,
choose one canonical feature, preserve all required behavior there, and classify the others as
superseded. Do not merge an older branch tip merely to retain its history, and do not give a
superseded feature a MERGED receipt unless its exact tip was independently accepted.

Do not begin with broad repository audits, architecture maps, permanent safety branches, or
speculative plans. Do not inspect or modify unrelated worktrees. Do not merge the trunk into every
feature as it advances; update only for a dependency, heavy same-subsystem overlap, conflict work,
combined runtime verification, or continued feature development. Never rewrite published history.

For an accepted `t004` checkpoint, the skill automatically creates names such as:

```text
Worktree: C:\Users\dev\Documents\worktrees\wolf-behavior__t004
Branch: feature/wolf-behavior--from-t004
Launcher: Active\Run Wolf Behavior [t004].cmd
Runtime ID includes: wolf-behavior-t004
Disposable database includes: wolf_behavior_t004
```

The runtime lease stores `base_test_generation: t004` and the full immutable
`base_test_sha`. Parallel features retain their original labels when later generations advance.
Nobody types a generation during feature creation.

## When to register a feature runtime

Level 0 policy, documentation, text, simple CSS, and other statically inspectable changes do not
need registration. Register only when the requested behavior benefits from interactive client,
server, WebSocket, database, map, responsive-browser, launcher, or runtime verification:

```powershell
cd C:\Users\dev\Documents\game
.\tools\dev\feature-runtime.ps1 create `
  -WorktreePath 'C:\Users\dev\Documents\worktrees\kingdom-update__t004' `
  -DisplayName 'Kingdom Update 1.0'
```

This creates:

```text
C:\Users\dev\Documents\Ash Atlas Feature Launchers\Active\Run Kingdom Update 1.0 [t004].cmd
```

The launcher contains the registered worktree, runtime identity, frontend port, and diagnostic
location—never database credentials. Repeated clicks reuse an exact healthy runtime or replace only
stale/unhealthy resources after PID, start-time, command-line, path, port, and ownership checks.
Different feature launchers remain independent.
At most four feature runtimes run at once by default. Starting another parks the oldest running
feature (stopping its processes and PostgreSQL container while preserving its data and launcher).
Set `feature.lifecycle.max_running_features` to `0` to disable the cap; a parked launcher restarts it.

After authorized focused admission against the exact local candidate, the branch and generation
tag are published atomically. `feature-runtime.ps1 mark-merged` then validates only the exact
feature branch, requested tag, current Integration Test ancestry, and base generation before it
records the accepted identity. It creates
`__MERGED_TO_TEST__.md` in the feature worktree and creates:

```text
C:\Users\dev\Documents\Ash Atlas Feature Launchers\Merged\
  [MERGED] Kingdom Update 1.0 [t004 to t005].cmd
```

The filename uses ASCII `to` because Windows forbids `>` as well as `*` in filenames.
The archived launcher displays the feature title, source branch, exact feature tip, base generation
and SHA, and merged generation and SHA, then pauses. It cannot launch or control a runtime. For a
registered feature, `mark-merged` also records the merged lease fields and removes the Active
launcher. A never-registered feature needs no lease or launcher and receives the same marker and
receipt without acquiring fake runtime resources. Failed, conflicted, unpushed, unvalidated,
ancestry-invalid, or untagged integrations remain Active and receive no marker, merged lease
fields, or archived launcher.

Every accepted feature or fix receives one archived MERGED receipt. Runtime registration changes
how runtime resources are cleaned up, not whether the accepted integration is visibly recorded.
The `Merged` folder is the complete human-readable receipt list for accepted `feature/*`, `fix/*`,
and explicitly authorized feature-like `chore/*` integrations going forward. It excludes
Integration Test publication, deployment, generation-only, cleanup-only, promotion-only, and
unaccepted audit work. Git ancestry and immutable generation tags remain authoritative.

Every registered feature receives stable isolated ports, Compose identity, disposable volume, and a
database beginning with `ash_atlas_stability`. It may never use the retained Main database,
container, volume, project, network, permanent checkout, or World listener. Inherited
`DATABASE_URL` is cleared and reconstructed from the registered lease.

Service ports come from `41000-41899`; World group ports come from `41900-42199`. Selection rejects
listeners, excluded ranges, Docker-published ports, other leases, and duplicates. No occupying
process is killed.

Do not start World for work that does not use World behavior. When World is used, the complete
`config/world-runtime.lock.json` identity is serialized into the group identity. Matching locks may
share an exact process; differing locks use separate ports, source materializations, processes,
leases, and logs. Cleanup removes group membership and stops a group only after exact ownership is
proven and no other feature needs it. Port `8765` is never eligible.

On a cold launch, World startup/reuse and PostgreSQL startup/reuse overlap. PostgreSQL is ready only
after the exact feature container is healthy, repeated SQL against its disposable database
succeeds over a stability window, container identity remains unchanged, and a final probe passes.
Migrations then gate backend startup. Backend and frontend start together; backend health, backend
readiness, and frontend readiness are probed concurrently. Phase timings are stored with runtime
state. Migration retries remain bounded to recognized startup connection failures.

## Main

Run the retained environment only from the protected checkout:

```powershell
cd C:\Users\dev\Documents\game
.\Run Ash Atlas.cmd
```

| Service | Main identity |
| --- | --- |
| Frontend | `127.0.0.1:5270` |
| Backend | `127.0.0.1:3000` |
| Protected Main World API | `127.0.0.1:8765` |
| Retained PostgreSQL | `127.0.0.1:35432` |
| Database | `ash_atlas_game` |
| External retained volume | `ash-atlas_ash_atlas_game_postgres` |

Main refuses another path or branch, refuses to recreate a missing retained database or volume, and
never runs `docker compose down -v`.

## Integration Test combined checkpoint

The local combined-game checkpoint is:

```text
C:\Users\dev\Documents\Ash Atlas Feature Launchers\Run Integration Test.cmd
```

Use it only when the user explicitly asks for a manual combined check or a concrete combined
interaction risk remains uncovered, and state that risk before launching. Reuse an already healthy
exact-SHA runtime.

```text
feature worktree
→ focused verification
→ merge into integration/test
→ optional quick combined smoke through Run Integration Test.cmd
→ Fast Test-Server Publish into master
→ exact-SHA deployment
```

After a conflict-free merge, successful checks from the exact feature commit remain valid. Repeat
only checks made necessary by conflict resolution, overlapping integrated behavior, or a genuinely
new combined risk.

Deploy a finished feature (web + server + OTA bundles) with one command from this permanent
checkout, which is the trusted tooling copy:

```powershell
.\tools\release\accept-and-publish-test-server.ps1 Deploy -FeatureWorktree <path>
```

Careful-lane changes (migrations, release tooling, native shell, protocol) stop for approval and
are rerun with `-CarefulLane`. Granular modes remain available:

```powershell
.\tools\release\accept-and-publish-test-server.ps1 <Integrate|Publish|IntegrateAndPublish>
```

After a command-runner timeout, use `Inspect -OperationId <id>` and then an authorized
`Resume -OperationId <id>`. Do not manually repeat a push, tag, receipt, migration, deployment, or
activation based only on a generic timeout.

## Discover and inspect registered worktrees

From the permanent checkout:

```powershell
.\tools\dev\feature-runtime.ps1 sync
.\tools\dev\feature-runtime.ps1 status
```

`sync` creates or refreshes launchers for valid registered worktrees while preserving ports,
databases, containers, volumes, projects, World identities, display names, and membership. It
ignores malformed, missing, detached, locked, prunable, or cleanup-in-progress records and deletes
nothing. Existing leases without generation fields remain readable, runnable, and cleanable.

Focused diagnostics:

```powershell
.\tools\dev\run-main.ps1 -RuntimeMode Main -Doctor

.\tools\dev\run-main.ps1 -RuntimeMode Feature `
  -WorktreePath 'C:\Users\dev\Documents\worktrees\kingdom-update-1-0' `
  -Doctor
```

## Fast phone test (opt-in)

A running feature runtime serves the dev Vite frontend (about 30 fps on a phone). For a packed
60 fps build on a secure https link (so phone GPS works), run the opt-in tool. It does not change
the launchers or `feature-runtime.ps1`; the runtime's normal frontend keeps running untouched.

```powershell
.\tools\dev\feature-fast.ps1 start   -WorktreePath <worktree>   # build, preview, tailscale serve, prints the phone URL
.\tools\dev\feature-fast.ps1 rebuild -WorktreePath <worktree>   # rebuild after code changes (~13 s), then reload the phone
.\tools\dev\feature-fast.ps1 watch   -WorktreePath <worktree>   # foreground: debounced rebuild on file changes
.\tools\dev\feature-fast.ps1 status  -WorktreePath <worktree>
.\tools\dev\feature-fast.ps1 stop    -WorktreePath <worktree>   # stops the preview, removes the serve mapping
```

What `start` does, from the live runtime (its ports and env come from the runtime lease and the
launcher's Frontend and Backend wrapper command lines, so the runtime must already be running):

- `vite build` with the runtime's frontend env into `%LOCALAPPDATA%\AshAtlas\fast-phone\<runtime>\dist`.
- Starts `vite preview` detached (Win32_Process Create) on `127.0.0.1:47000 + (frontend port % 1000)`,
  reusing the dev `/api` and `/ws` proxy and the water PMTiles route (`apps/client/vite.config.ts`).
- Restarts the runtime backend once with `AUTH_ALLOWED_ORIGINS` extended by the preview and
  Tailscale https origins (CORS, the auth origin check and `/ws` all use that list; the server 403s
  any other origin), and with `AUTH_DEV_EXTRA_ORIGINS` set to the Tailscale https origin. The new
  backend is recorded in the runtime's `owned-processes.json`, so the normal runtime stop and
  cleanup still stop it. If the server still refuses to start with the https origin (for example a
  worktree whose server predates `AUTH_DEV_EXTRA_ORIGINS`), it falls back to the loopback preview
  origin only and prints where the boot error is. The extra origins last until the runtime restarts.
- `AUTH_DEV_EXTRA_ORIGINS` (server, `apps/server/src/config.ts`): development login normally boots
  only with loopback or private-LAN `http` origins. This comma-separated list names exact
  `https://<host>.ts.net[:port]` origins (https only, `.ts.net` host, no wildcard, path or
  trailing slash) that may also appear in `AUTH_ALLOWED_ORIGINS` while development login is on.
  Every entry must also be listed in `AUTH_ALLOWED_ORIGINS`. Setting it at all fails boot unless
  `NODE_ENV=development`, `AUTH_MODE=dev`, `AUTH_DEV_LOGIN_ENABLED=true` and `AUTH_RUNTIME_MODE` is
  not `public`, so it can never apply in production. `APP_PUBLIC_ORIGIN` stays loopback/LAN only.
- `tailscale serve --bg --https=<frontend port> http://127.0.0.1:<preview port>`. The https port is
  the runtime's frontend port, so each runtime has its own stable link:
  `https://<machine>.<tailnet>.ts.net:<frontend port>/`.

One-time tailnet setup: Tailscale admin console, enable Serve (the first `start` prints a
per-node link), and under DNS enable MagicDNS and HTTPS Certificates.

Run `stop` before removing or cleaning the feature if you started the preview. State, logs and the
build live in `%LOCALAPPDATA%\AshAtlas\fast-phone\<runtime>`.

## Remove or clean one feature

Remove only a disposable runtime while keeping its branch and worktree:

```powershell
.\tools\dev\feature-runtime.ps1 remove `
  -WorktreePath 'C:\Users\dev\Documents\worktrees\kingdom-update-1-0'
```

After the exact feature tip is contained by the remote integration trunk:

```powershell
cd C:\Users\dev\Documents\game
.\tools\dev\feature-runtime.ps1 cleanup `
  -WorktreePath 'C:\Users\dev\Documents\worktrees\kingdom-update-1-0' `
  -IntegratedRef origin/integration/test
```

Use `origin/master` only when it is the actual integrated target. Cleanup fetches with pruning and
must prove exact remote ancestry, clean and fully pushed work, no unique untracked files, exact
process and disposable Docker/database/launcher/World ownership, and no Main overlap before
removing anything. Never-registered Level 0 worktrees require the same absence proofs. Failed,
unrelated, dirty, detached, unmerged, or unpushed work is never removed.
Cleanup relies on the stored worktree, branch, runtime, launcher, database, Docker, process, and
World identities; a generation suffix by itself never establishes ownership.
For every successfully marked feature or fix, registered or not, cleanup verifies and removes the
exact worktree marker while retaining the small archived launcher in `Merged` as the visible
receipt.

## Retained database safety

Feature databases and rows never transfer to Main. Tests and feature environments use database
names beginning with `ash_atlas_stability` and never target `ash_atlas_game`.

Main repair may recreate only the container around the verified retained external volume:

```powershell
.\tools\dev\run-main.ps1 -RuntimeMode Main -RepairPostgres
```

It must preserve the exact volume and existing database and verify the resulting mount, port,
ownership, health, and SQL identity.

A Main gameplay reset is never part of a launcher, restart, integration, or publication. It requires
direct authorization for the exact reset and protected SHA:

```powershell
.\tools\dev\reset-main-gameplay-data.ps1 `
  -IntegratedMasterSha <exact-origin-master-sha> `
  -ConfirmAuthorizedMainGameplayReset
```

The guard must prove the clean protected checkout, exact SHA, retained identities, stopped Main
applications, audited table/foreign-key closure, transaction safety, preserved migration ledger,
and idempotent SHA receipt. Never reset data to simplify testing, edit recorded migrations, or use a
reset to conceal migration defects. Migration changes use expand-and-contract evolution and must
pass a representative populated upgrade followed by an empty second run.
