# Wave 3A completion-audit result

Completed on 2026-07-22 as a focused follow-up to feature commit
`cd8534018807ce0ca688123a478fda358c5045fa`. The work remains on
`chore/protocol-network-hardening--from-t090`, based on immutable `test/t090` /
`7b782c858bb631a00befc36a5b347c38273d55ad`. This audit did not redesign Wave 3A,
change existing public `GameClient` return types, add a mutation queue, or modify protocol payload
meanings, gameplay, UI, migrations, retained data, World source, or protected history.

## Compatibility result

The legacy-safe mechanism remains bounded `/ws` query metadata plus the unchanged strict bare
`HELLO`. Optional `WELCOME` metadata is returned only to an advertising client. Absent metadata is
the accepted legacy path. Protocol version, game release SHA, and World pipeline SHA remain
separate, connection-local concepts.

| Client / server pairing | Final result and evidence |
| --- | --- |
| legacy client / new server | live bare `HELLO` accepted; `WELCOME` has no protocol metadata; normal code 1000 close |
| new client / legacy server | automated legacy-host coverage accepts ignored query metadata and missing `WELCOME` metadata |
| new client / new server | live negotiation returned protocol `ash-atlas`, version/range 1, and `welcome-protocol-metadata` |
| unsupported future client / current server | live range 2 advertisement received no application frames and one terminal close: code 4003, fixed reason `protocol incompatible` |
| current client / unsupported future server | unit coverage enters terminal protocol-incompatible/update-required state and schedules no reconnect |
| absent metadata / current implementation | shared and session coverage selects accepted legacy version with no negotiated capabilities |

Existing 4001 session-invalid and 4002 session-replacement behavior is unchanged. Confirmed
protocol incompatibility is terminal, sanitized, counted, and never enters the retry scheduler.

## Parser and send boundaries

`ServerMessage` has 134 discriminants. `SERVER_MESSAGE_VALIDATION_ROUTES` is an exhaustive
`Record<ServerMessage["type"], z.ZodTypeAny>` with exactly 134 keys. The exhaustive fixture registry
has the same statically required keys, materializes one schema-valid fixture for every discriminant,
and sends every fixture through `parseServerMessage`. A new discriminant without both route and
fixture ownership fails typecheck; route/fixture key or count drift fails the test. Existing schemas
were not relaxed.

The parser still rejects malformed JSON, a malformed envelope, unknown types, and malformed known
market frames. It now also rejects a server frame above 1 MiB before JSON parsing. One shared parser
remains the only client raw-frame `JSON.parse` boundary, and validated data is the only data passed
to application dispatch.

The internal transport send result is exactly:

```ts
"sent"
| "socket-not-open"
| "stale-socket"
| "serialization-failed"
| "send-failed"
| "intentionally-disconnected"
| "protocol-incompatible"
```

`JSON.stringify` is inside the transport's guarded serialization/send boundary. Serialization and
native `WebSocket.send` exceptions become typed outcomes and cannot escape into UI handlers.
Generation mismatch is reported before serialization or send. All existing public `GameClient`
methods retain their previous boolean, request-ID, or void return contracts.

## Lifecycle, retry, and no-replay result

`GameClient` remains the single reconnect-policy, reconnect-timer, ping-timer, and compatibility
owner. Retryable closes are limited to 1001, 1006, 1011, 1012, and 1013. At most three attempts are
scheduled without a compatible `WELCOME`; delay is exponential from 500 ms, capped at 10 seconds,
with 0.75-1.25 jitter. `WELCOME`, not socket OPEN, resets the attempt count. Intentional disconnect,
session invalidation/replacement, and protocol incompatibility remain terminal.

The resume subscription covers visible `visibilitychange`, `pageshow`, and `online`, and removes all
three listeners on cleanup. Tests cover hidden/background suppression, foreground/online recovery,
stale socket callbacks, stale reconnect callbacks, stale ping callbacks, close during handshake,
intentional disconnect, session replacement, and protocol incompatibility. A 100-cycle fake-socket
stress test proves exactly one live socket at a time and zero retained socket listeners, reconnect
timers, or ping timers after disconnect.

Disconnected sends followed by connect produce only the handshake and never queue or replay
movement, flags, travel, market, equipment, class, pets, manor, chat, or direct-message mutations.
Market mutation timers now only mark an unconfirmed result; only the existing explicit user retry
resends the same idempotency key. A disconnected optimistic DM send becomes failed; only explicit
retry makes it eligible again. Opening a DM conversation may still deliver a current, in-session
pending intent after its required `DM_OPEN_RESULT`; reconnect and sync paths do not drain sends.

## Architecture enforcement

The final scan covers 421 production files and 1,468 static imports with zero boundary findings. It
enforces one `new WebSocket`, one raw `WebSocket.send`, one raw-frame parser, no unchecked client
`ServerMessage`/DM cast, exhaustive parser ownership, and one reconnect-policy owner. Wave 2B
realtime/HTTP ownership checks remain green. The only dependency cycles are the two accepted
baseline cycles:

1. `classes.ts -> combat.ts -> progression.ts`
2. `equipment.ts -> equipmentBalance.ts`

Any additional cycle is now an architecture violation; Wave 3A introduced none.

## Performance comparison

The final live sample used 100 authenticated loopback reconnects and 1,999 received frames. Values
are nearest-rank observations using the same local runtime method as the baseline.

| Metric | Baseline p50 / p95 | Final p50 / p95 | Change |
| --- | ---: | ---: | ---: |
| socket construction to OPEN | 2.853 / 3.626 ms | 3.3732 / 4.1087 ms | +18.2% / +13.3% |
| `HELLO` to `WELCOME` | 77.692 / 81.819 ms | 95.3540 / 101.6293 ms | +22.7% / +24.2% |
| reconnect to usable player + flag state | 103.850 / 110.299 ms | 126.7267 / 139.0998 ms | +22.0% / +26.1% |
| `JSON.parse` | 0.0064 / 0.0300 ms | 0.0022 / 0.0212 ms | -65.6% / -29.3% |
| complete validated `parseServerMessage` | not present | 0.0125 / 0.1452 ms | new validation cost |

The loopback connection timings were slower in this final local sample; a second warm 100-cycle
sample measured OPEN 3.2258/3.6804 ms, `HELLO` to `WELCOME` 93.5071/98.2099 ms, and usable
124.1875/130.3543 ms. No production threshold was changed or suppressed. Largest observed frame
remained `EQUIPMENT_SNAPSHOT` at 10,962 bytes; observed `WELCOME`, `PLAYER_SNAPSHOT`,
`PLAYER_DELTA`, `COMBAT_SNAPSHOT`, `COMBAT_DELTA`, and `POPULATION_ZONE_DELTA` maxima were 565,
519, 563, 943, 940, and 340 bytes respectively.

The live 100-cycle process ended with active-handle delta -1 and heap delta +4,584,168 bytes without
forced collection; the deterministic lifecycle test independently proves no timer/listener/socket
retention. Bundle comparison is:

| Artifact | Baseline | Final | Change |
| --- | ---: | ---: | ---: |
| server JavaScript | 3,028,848 | 3,073,689 bytes | +1.5% |
| server source map | 5,796,794 | 5,875,628 bytes | +1.4% |
| client main JavaScript | 2,647,255 | 2,672,026 bytes | +0.9% |
| client CSS | 358,179 | 358,179 bytes | 0.0% |

## Verification and acceptance

| Gate | Final result |
| --- | --- |
| frozen install | passed |
| focused parser/send/lifecycle/no-replay | 77 tests passed across the focused shared/client runs |
| full package unit suites | shared 289; server 1,629 passed / 321 expected PostgreSQL skips; client 1,001; total 2,919 passed |
| PostgreSQL matrix | required stability lab on port 35439: 44/44 files, 321 tests passed; zero `ash_atlas_stability_ci_*` databases remained |
| typecheck / lint | all packages passed / passed |
| architecture | six Node tests plus 10 server Vitest checks passed; 421 files, 1,468 imports, zero findings |
| policy | runtime 113, generation 13, admission 58, launcher 40: 224 assertions passed |
| production build / verify / hygiene | passed / passed / passed |
| diff check | passed before commit |

Two aggregate/environmental checks remain explicitly blocked rather than hidden:

- `pnpm test:unit` hit the unchanged 5-second timeout in the client MarketOverlay 1,000-change
  performance test when package suites ran concurrently. It failed twice under aggregate load; the
  complete client suite passed sequentially and that exact test completed in 2.648 seconds. No
  timeout was increased.
- `world-runtime-groups.tests.ps1` cannot acquire port 41941 because a healthy, identity-checked
  shared World process for the locked `main@8b8d1c1353cbae563b4c472cdc1d3b6e48ac792b` pipeline is
  still owned by another registered group member. The process was left untouched. This is the same
  baseline environmental refusal; the other 224 policy assertions passed.

Initial PostgreSQL attempts against the feature port 41218 were rejected by seven suites' explicit
stability-lab guard and are not product failures. The authoritative port-35439 rerun above passed.
No migration changed.

The isolated feature runtime passed `/health`, `/ready`, authenticated login to the map, an empty
browser warning/error console, live compatibility probes, and the reconnect sample. Final runtime
identity is rechecked after the completion commit.

At the last pre-commit fetch, `origin/integration/test` and `origin/master` had independently
advanced together to immutable `test/t091` /
`e2347b70ace963ca5aa4bb7baaa258f8c91527f3`. This feature and its remote branch still pointed to the
preserved `cd8534018807ce0ca688123a478fda358c5045fa` t090 tip before the audit commit. The protected
checkout was clean. This task did not merge, rebase, tag, checkpoint, promote, deploy, clean another
runtime, or mutate Main/retained state.
