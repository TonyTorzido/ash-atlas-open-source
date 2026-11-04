# Wave 3A protocol and client-network baseline

Captured on 2026-07-22 before implementation changes.

## Accepted identity

| Item | Verified value |
| --- | --- |
| base | immutable `test/t090` / `7b782c858bb631a00befc36a5b347c38273d55ad` |
| branch | `chore/protocol-network-hardening--from-t090` |
| feature runtime | `protocol-network-hardening-t090-a039a0f071` |
| runtime endpoints | frontend 41216; backend 41217; PostgreSQL 41218; World 41941 |
| `origin/integration/test` | `7b782c858bb631a00befc36a5b347c38273d55ad` |
| `origin/master` | `7b782c858bb631a00befc36a5b347c38273d55ad` |
| public `release.json` | `7b782c858bb631a00befc36a5b347c38273d55ad` |
| deployed release symlink | `/srv/ash-atlas/game/releases/7b782c858bb631a00befc36a5b347c38273d55ad` |
| Wave 2B tip | `dd9d15a2bfcc441391139c48e14bbacef63d811b` is an ancestor |
| accepted iOS/mobile tip | `7b782c858bb631a00befc36a5b347c38273d55ad` contains `64d388a` |

There is no intervening commit after t090. Production `/health` and `/ready` returned 200 from the
host-local game endpoint, the service was active, and an authenticated public browser session
reached the live map with `Connection online`. No protected branch, deployment, retained data, or
World repository was changed.

The World runtime is `main@8b8d1c1353cbae563b4c472cdc1d3b6e48ac792b` with
`world-packages-v1`. The checked-in lock and live health agree on Settlement Authority
`world-settlements-v2` / `462688b612b6929be93955f3e2976d19bd22d703fea24db1c5f4fa74e663ee26`,
founding policy `settlement-founding-v2` /
`cbc6f31242142c2a04059ca39a29a8a4f84b752edd84dfd516830c11458255b1`, and resolution policy
`primary-settlement-resolution-v1` /
`6e422725266126827aab6c10cdd52ca0391c2aeb05243b076b9156ffadc6d371`.
Production reports 114 applied migrations. The repository has 114 migration files; 0665 is
`efd21cda6ab83a8e6e3a97147258d83043e5bab5446550e18a52f9196fbe818d` and 0666 is
`8f32c1748b023c17f0802564c92866b23703a1ea459a623cf7799fb26694da92`.

## Current protocol and physical ownership

| Measure | Baseline |
| --- | --- |
| shared protocol | `packages/shared/src/protocol.ts`, 2,200 lines / 68,170 bytes |
| client messages | 125 variants; strict discriminated Zod union |
| server messages | 134 variants; TypeScript union without a complete runtime parser |
| `HELLO` | strict `{ type: "HELLO" }`; additional fields are rejected |
| `WELCOME` | required gameplay/session fields; no protocol metadata |
| `GameClient` | 1,344 lines / 41,010 bytes |
| `App.tsx` | 7,410 lines / 310,884 bytes |
| raw browser WebSocket constructors | one, in `apps/client/src/gameClient.ts` |
| client server-frame `JSON.parse` sites | one, in `GameClient` |
| client gameplay-frame `JSON.stringify` sites | one private `GameClient.send` path |
| reconnect timer owner | `GameClient` |
| ping timer owner | `GameClient` |

The server parses client frames once with `parseClientMessage`. Its separate best-effort direct-
message parse only recovers a request ID for an existing error response. The client parses server
JSON once, validates only market candidates with the focused market validator, casts every other
value to `ServerMessage`, and dispatches it. Unknown frames and many malformed known frames can
therefore cross the application boundary.

The raw socket, event listeners, retry counter, reconnect timer, ping timer, traffic trace, and all
public send methods are co-located in `GameClient`. Every socket listener compares its captured
socket to `this.socket`, which fences ordinary stale events. Stale-open recovery clears the active
reference before closing and creates a replacement. The private send returns `true` only for OPEN,
returns `false` otherwise, and does not catch a throwing browser send.

Reconnect delay is deterministic exponential backoff: 500, 1,000, 2,000, 4,000, 8,000, then
10,000 ms capped. The counter resets on the socket `open` event, before `WELCOME`; repeated
open-then-close failures therefore repeat 500 ms. Only one reconnect timer is retained. The
startup owner may stop retries after its four-failure budget, but a post-startup caller returning
`true` from `onClose` permits indefinite transient retries. No gameplay mutation is queued or
automatically replayed while offline.

The two accepted shared cycles remain:

1. `classes.ts -> combat.ts -> progression.ts`
2. `equipment.ts -> equipmentBalance.ts`

The architecture scan found 419 files, 1,466 imports, two cycles, and zero boundary findings.

## Network behavior characterization

The registered t090 runtime was healthy and ready with exact branch, game, World, database, and
Population V2 identity. An explicit local development login created a normal disposable session.
One hundred sequential authenticated loopback sockets sent only the legacy bare `HELLO`, observed
`WELCOME`, player state, and flag state, then closed with code 1000. No gameplay mutation was sent.

| Case | Current result |
| --- | --- |
| initial connection | authenticated upgrade succeeds; bare `HELLO` starts bootstrap |
| `HELLO` to `WELCOME` | normal accepted flow; replicated frames may interleave |
| `WELCOME` to usable | player and flag state complete the measured usable condition |
| server/network/mobile close | `onClose` decides whether one reconnect timer is scheduled |
| browser offline/online | lifecycle recovery calls `recoverIfNeeded`; stale OPEN is replaced |
| stale OPEN socket | 20-second activity threshold; replacement starts immediately |
| connection replacement | old socket receives frame or close code 4002; client stops retrying |
| session expiration/suspension | `AUTH_SESSION_INVALID` stops the client; existing 4001 semantics |
| malformed JSON | caught and reported through `onError`; socket remains open |
| unknown type | cast to `ServerMessage` and dispatched; unsafe baseline |
| malformed known frame | market frames reject; other variants may dispatch or fail incidentally |
| send while closed | returns `false`; no queue or replay |
| browser `send` throws | exception escapes the private send path; no typed outcome |
| close during handshake | normal close callback/retry policy; retry count was reset at OPEN |
| stale event after replacement | socket-identity checks ignore it |

Existing unit coverage also preserves Strict Mode's single active socket/listener/ping set, mobile
close recovery, stale socket recovery, replacement fencing, startup retry exhaustion, market wire
validation, and the absence of outbound mutation replay.

## Performance and frame sizes

The loopback sample used the actual t090 server and normal authenticated bootstrap. Quantiles are
nearest-rank observations over 100 complete reconnects. JSON parsing covers 1,984 observed server
frames. Dispatch uses 10,500 invocations through the actual baseline `GameClient` message callback
with 21 captured representative frames and a no-op application handler.

| Metric | p50 | p95 |
| --- | ---: | ---: |
| socket construction to OPEN | 2.853 ms | 3.626 ms |
| bare `HELLO` send to `WELCOME` | 77.692 ms | 81.819 ms |
| reconnect to usable player + flag state | 103.850 ms | 110.299 ms |
| `JSON.parse` | 0.0064 ms | 0.0300 ms |
| current `GameClient` parse/dispatch callback | 0.0012 ms | 0.0082 ms |

| Representative frame | Maximum observed bytes |
| --- | ---: |
| `WELCOME` | 440 |
| `PLAYER_SNAPSHOT` | 519 |
| `PLAYER_DELTA` | 563 |
| `COMBAT_SNAPSHOT` | 942 |
| `COMBAT_DELTA` | 977 |
| `POPULATION_ZONE_DELTA` | 340 |
| largest: `EQUIPMENT_SNAPSHOT` | 10,962 |

The 100-cycle measurement ended with active-handle delta -1 and heap delta +1,210,864 bytes without
forced collection; this is not evidence of timer/handle growth. Production bundles are server
3,028,848 bytes (source map 5,796,794), client main JavaScript 2,647,255 bytes, and client CSS
358,179 bytes.

## Accepted baseline gates

| Gate | Result |
| --- | --- |
| frozen install | passed |
| unit | shared 277; server 1,626 passed / 321 expected PostgreSQL skips; client 987 |
| PostgreSQL | all 44 isolated integration files passed; no disposable database remained |
| typecheck / lint | passed / passed |
| architecture | four Node checks plus 10 Vitest checks; zero findings |
| policy | runtime 113, generation 13, admission 58, launcher 40 passed |
| World-group fixture | environmental refusal: stale recorded PID versus healthy shared owner on 41941 |
| production build / verify / hygiene | passed / passed / passed |
| diff check | passed |

The World fixture condition is the same class of deterministic shared-port collision recorded by
Waves 2 and 2B. The live owner was identity-checked as the exact locked pipeline/release and left
untouched.
