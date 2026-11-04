# Ash Atlas stability lab

The stability lab is the only supported environment for the production-stability hardening work. It
wraps the game feature worktree, the pipeline feature worktree, a disposable PostGIS container, and
the immutable real world release with explicit ownership and mutation guards.

## Fixed isolated defaults

| Resource | Value |
|---|---|
| Frontend | `127.0.0.1:5370` |
| Game API | `127.0.0.1:3100` |
| World API | `127.0.0.1:8865` |
| PostgreSQL | `127.0.0.1:55439` |
| Container | `ash-atlas-stability-postgis` |
| Database | `ash_atlas_stability` |
| Test root | `%TEMP%\ash-atlas-stability-lab` |

It refuses database `ash_atlas_game`, port 35432, protected runtime ports 5270/3000/8765, an
unrelated owner of any lab port, a container without the stability ownership label, a noncanonical
release root, or either worktree on the wrong branch.

The PostgreSQL default remains `55439`. If Windows reserves that port, choose an available isolated
port before starting the lab:

```powershell
$env:ASH_ATLAS_STABILITY_DATABASE_PORT = 55839
```

For a persistent machine-local selection, copy `stability-lab.local.example.psd1` to the ignored
file `tools\stability-lab\stability-lab.local.psd1` and set a port available on that machine:

```powershell
@{
    DatabasePort = 55839
}
```

The environment variable takes precedence over the local file, and the local file takes precedence
over the default. The integration process installs this ignored local setting on machines where the
default is reserved; no tracked source edit is required.

The override must be an integer from 1 through 65535. Protected ports 5270, 3000, 8765 and 35432,
Windows excluded TCP ranges, and ports owned by unrelated processes are rejected before Docker can
create or start the disposable database container. The selected port is recorded in `identity.json`.

## Commands

Run from the game stability worktree:

```powershell
$lab = '.\tools\stability-lab\stability-lab.ps1'
& $lab start
& $lab status
& $lab migrate
& $lab seed
& $lab test
& $lab fault queue-saturation
& $lab fault database-outage
& $lab fault world-api-outage
& $lab fault slow-request
& $lab fault crash-restart
& $lab fault two-writer
& $lab stop
& $lab reset
& $lab cleanup
& $lab cleanup -PurgeArtifacts
```

`start` prints and records both Git SHAs/branches, the release identity and manifest hash, runtime
identity policy, ports, database and test root before creating resources. `test` proves port-owner
refusal, two idempotent migration runs, isolated seed/reset/removal, feature-branch runtime identity,
retained-container stability, release-manifest immutability and empty cleanup.

## Ownership and cleanup guarantees

- Every launched process is recorded with PID, command and an exact command marker. Shutdown checks
  that marker before terminating the process tree.
- The Docker container has `com.ash-atlas.stability-lab=true`; a same-name unlabelled container is
  never touched.
- Normal integration reads `world-packages-v1`; it never writes there. Pipeline fixture tools copy
  bytes below the lab root and require a marker before corruption.
- Failures retain stdout/stderr logs and copied fixtures. Ordinary cleanup removes owned processes,
  the disposable container and generated run scripts. `-PurgeArtifacts` explicitly removes copied
  release fixtures but still preserves logs.
- No command discovers and kills arbitrary port owners. A collision is a hard refusal.

Override paths only when intentionally testing another isolated worktree/release:

```powershell
$env:ASH_ATLAS_STABILITY_PIPELINE_ROOT = 'C:\isolated\pipeline-worktree'
$env:ASH_ATLAS_STABILITY_RELEASE_ROOT = 'C:\immutable\world-packages-v1'
```

Both overrides are subjected to the same branch/release guards.
