# Release tooling (historical)

The scripts here, together with `tools/release/vps/`, `tools/mobile-release/`, `tools/telemetry-home/`
and the docs under `docs/release/` and `docs/backup-and-recovery.md`, describe the original author's
hosting: a single VPS, a staged test/production deploy lane, store-release automation and an
off-site backup host. They assume infrastructure, SSH aliases, runners and credentials that are not
part of this repository (placeholders such as `example.invalid` and `example-org/...` stand in for
the real values).

They are kept for reference and are **not runnable as-is**. To deploy your own copy, treat them as
examples and write your own pipeline.
