# Player bug reports

## Player workflow

When `BUG_REPORTS_ENABLED=true`, the authenticated `WELCOME` frame makes
**Report a Bug** available in the phone Game Menu. Opening it immediately
records `reportMarkerAt` from the synchronized game clock and clones the
current diagnostic rings. Typing and minimizing do not move that marker.
Back cancels and destroys the draft; Return to Game preserves it. Submission
keeps the game visible, suppresses duplicate taps, preserves the form on
failure, and returns a non-sequential code such as `AA-7F3C21` after the
private transaction commits.

The diagnostic window is always
`reportMarkerAt - 5 minutes .. reportMarkerAt`. `availableWindowStartAt`
records a shorter actual history when the connection is newer. `submittedAt`
is the later server persistence time.

## Bounded diagnostics and privacy

The client maintains only in-memory overwrite rings:

| Data | Limit |
| --- | ---: |
| semantic player actions | 800 |
| sanitized/deduplicated client errors | 200 |
| WebSocket metadata entries | 400 |
| reused performance samples | 200 |
| history | 5 minutes |
| uncompressed submission wire frame | 2 MB |

Normal action recording performs no PostgreSQL writes. The rings contain
message type, approximate size, result, operation/target identifiers, and
connection generation—not packet bodies. They do not record pointer/touch
movement, raw coordinates, keystrokes, chat or DM contents, browser storage,
screenshots, video, user-agent strings, or physical GPS.

The strict shared schema has no client player/account/session/run/release or
authoritative-position field. The server supplies those values. Error and
human text is stripped of emails, URLs, credential-like values, control
characters, and forbidden metadata keys covering OAuth, authorization,
cookies, passwords, chat/DM, user agents, storage, raw IP, and geolocation.

## Server capture and storage

The authenticated WebSocket frame is handled outside the simulation tick.
The server validates connection generation and captures one current
authoritative player snapshot plus at most 200 entities from the existing
combat spatial authority, within the smaller of 750 metres and the canonical
combat-interest radius. Selected target, combat target, and recent operation
targets are ordered before nearest runtime entities. Missing selected targets
receive bounded tombstones. Compression and the dedicated telemetry-pool
transaction happen asynchronously after snapshot capture.

Migration `0688_private_bug_reports.sql` adds:

- `telemetry.bug_reports`: report fields, server-owned identity/release
  correlation, exact marker/window/submission times, every overlapping segment
  ID, lifecycle/export state, and `(player_id, request_id)` idempotency.
- `telemetry.bug_report_context`: one bounded durable context row with client
  state/history, authoritative state, nearby excerpt, operation/event
  references, byte counts, and SHA-256 checksum.

Database checks repeat the human-field, JSON-array, 2 MB uncompressed,
500 KB compressed, and 200-nearby limits. One connection may have one active
submission. A server and database-backed limit permits three reports per
account/player per ten minutes by default. Retrying the same request UUID
returns the original public code without creating another row.

Bug-report failure never closes the connection or changes gameplay authority.
Database or telemetry unavailability returns a themed retryable error.
`BUG_REPORTS_ENABLED=false` independently hides and rejects the feature; it
also fails configuration validation unless private telemetry is enabled.
When reports are enabled, `BUG_REPORT_EMAIL_API_KEY` and the verified
`BUG_REPORT_EMAIL_FROM` sender are also required. The server sends each
durably accepted report through the configured Resend account to
the address in `BUG_REPORT_NOTIFICATION_RECIPIENT` (delivery is disabled when empty) after the transaction commits. If delivery fails,
the report remains saved, the player receives a retryable notification error,
and retrying the same submission request retries the email without creating a
second report.

## Export, acknowledgment, and retention

The existing hourly exporter places pseudonymized `bug_reports` and its joined
`bug_report_context` in the same verified DuckDB/Parquet artifact. Both row
counts enter the manifest and are checked against PostgreSQL. Related segment
IDs preserve windows crossing rotation boundaries. Only after the artifact
receipt is verified does the report become `exported`; only the existing
restricted home-pull acknowledgment can make it `acknowledged`.

The external Linux pull still uses outbound SSH, checksum/manifest/table-count
verification, atomic Seagate finalization, and the existing acknowledgment.
After a verified DuckDB artifact is finalized, the optional
`index-bug-reports.sh` atomically updates
`ash-atlas-telemetry/bug-report-index/reports.duckdb`, `reports.csv`, and
`last-indexed-segment.txt`. The verified hourly artifacts remain canonical.
Set `TELEMETRY_BUG_REPORT_INDEX_ENABLED=false` to skip the convenience index.

Ordinary VPS segment retention deliberately does not delete either bug-report
table, including after acknowledgment, so report-only context survives removal
of older routine samples. Unacknowledged report data is therefore never
deleted by that path.

## Operator use

Use only a trusted shell with the least-privilege operator URL:

```sh
pnpm --filter @ash-atlas/server bug-reports -- list
pnpm --filter @ash-atlas/server bug-reports -- show AA-7F3C21
pnpm --filter @ash-atlas/server bug-reports -- export AA-7F3C21
pnpm --filter @ash-atlas/server bug-reports -- status AA-7F3C21 investigating
pnpm --filter @ash-atlas/server bug-reports -- duplicate AA-7F3C21 AA-CANON1
pnpm --filter @ash-atlas/server bug-reports -- resolve AA-7F3C21
```

`show` prints the description, authoritative state, nearby excerpt, correlation
IDs, and a chronological summarized action/error/network/performance timeline.
Developer-authorized accounts can also use the read-only **Bug Reports** tab in
the existing Developer App to see the latest durable report summaries. The
route is capability-gated and does not expose reports to ordinary players.
No public endpoint, dashboard, GitHub issue automation, or home-network
listener is added.
