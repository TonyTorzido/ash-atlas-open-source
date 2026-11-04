# Durable resource-vision jobs

Resource preparation is owned by PostgreSQL rows in `resource_vision_jobs`, not by a process-local
array. The job identity includes the flag, layout version, requested radius, world release, profile
fingerprint, build-contract fingerprint, and boundary release. A completed job from an older release
or layout therefore cannot satisfy a newer request.

Admission takes a database advisory transaction lock, deduplicates before counting capacity, and
enforces `RESOURCE_JOB_PENDING_MAX`. Workers claim with `FOR UPDATE SKIP LOCKED`, an immutable worker
id, a monotonically increasing owner generation, and a renewable lease. Startup and ordinary claim
passes recover expired leases. Completion and failure updates are generation-fenced, and eight
automatic attempts are allowed by default; a terminal failure has no retry timestamp and is visible
in readiness and metrics. An explicit later request may reset a terminal job for a new finite retry
cycle.

The process retains only bounded best-effort completion callbacks. Defaults allow 128 subscribers
per logical job and 4,096 total. Losing a socket or restarting a process loses callbacks, never the
job. Callers can observe completion from the durable resource-vision status. Preparation remains
read-only until the existing atomic commit, so a crash after planning is harmless; a crash after
commit safely replays deterministic inserts without updating harvested nodes.
