# Wave 3B baseline

## Exact authority

Wave 3B starts from immutable `test/t093` at
`b7def168b0dc262c2ad3bcfac811fd1172c4e23d`. At capture time,
`origin/integration/test`, `origin/master`, deployed Integration Test, public
`release.json`, and the production release symlink all resolved to that SHA. Protected checkouts
were clean. The isolated branch is `chore/client-domain-decomp--from-t093`; runtime ID
`client-domain-decomp-t093-406eb5fecb` uses frontend 41723, backend 41724, disposable PostgreSQL
41725, and accepted shared World port 41941.

World identity is locked to
`main@8b8d1c1353cbae563b4c472cdc1d3b6e48ac792b`, `world-packages-v1`, profile
`36dc3eb8bd36e32f7dc92084f1520d3180e6ce1a6c4f06354f7c1b34d6014553`, and build contract
`db08e6eb96caa4755f58780f952588efc90c3e644f867d77c87b2955b51d38bd`.

No protected branch, Main data, migration, World artifact, tag, checkpoint, deployment, or
production state changed. Old unaccepted overlapping worktrees
`anchor-vision-preload__t076`, `phone-dock-final-repair__t078`, and `troll-dungeon` were
preserved and not imported.

## Source inventory

| Measure | Exact value |
| --- | ---: |
| App physical / nonblank lines / bytes | 7,465 / 7,255 / 313,886 |
| App imports | 115 |
| App useState / useReducer | 163 / 1 |
| App useRef | 86 |
| App useEffect / useLayoutEffect | 64 / 1 |
| App useCallback | 50 |
| App top-level helpers | 31 |
| JSX overlay/panel/shell heuristic | 27 |
| domain JSX component occurrences inventoried | 40 |
| clientRef.current occurrences / syntactic command calls | 158 / 143 |
| App message.type references | 29 |
| gameClient physical / nonblank lines / bytes | 1,460 / 1,318 / 45,507 |
| GameClient public / private methods | 125 / 11 |
| protocol physical / nonblank lines / bytes | 2,679 / 2,526 / 102,194 |
| ClientMessage / ServerMessage discriminants | 125 / 134 |
| runtime validators / valid fixtures | 134 / 134 |

Companion records contain every hook/ref/callback/effect, public method, message discriminant,
direct client call, major JSX block, frame check, and cross-domain update.

## Unique raw boundaries

| Concern | Site |
| --- | --- |
| WebSocket constructor | `apps/client/src/browserWebSocketTransport.ts:29` |
| raw WebSocket.send | `apps/client/src/browserWebSocketTransport.ts:87` |
| server-frame JSON.parse | `packages/shared/src/protocol.ts:2619` |
| client-frame JSON.parse | `packages/shared/src/protocol.ts:2671` |
| ping / reconnect / trace timers | `gameClient.ts:128` / `:1442` / `:374` |
| primary App frame switch | `App.tsx:2062` |
| DM special dispatch | `App.tsx:1905-2017` |
| market special dispatch | `App.tsx:2019-2024` |

Wave 3A send outcomes remain
`sent | socket-not-open | stale-socket | serialization-failed | send-failed |
intentionally-disconnected | protocol-incompatible`. No mutation queue or replay exists.

## Graph and bundles

Architecture reports 423 files, 1,472 imports, zero findings, and exactly two cycles:
`classes.ts -> combat.ts -> progression.ts` and
`equipment.ts -> equipmentBalance.ts`. Vite transformed 998 modules. No application dynamic
import exists, so application and map startup share the eager main graph.

| Artifact | Exact bytes | gzip |
| --- | ---: | ---: |
| server JavaScript / source map | 3,073,689 / 5,877,594 | n/a |
| client main JavaScript | 2,685,048 | 761.08 kB |
| client CSS | 366,854 | 63.28 kB |
| largest auxiliary JS chunk | 52,740 | 14.53 kB |
| largest observed startup frame | 10,962 | n/a |

## Accepted checks

| Gate | Result |
| --- | --- |
| frozen install | passed, no tracked change |
| unit | shared 289 + server 1,629 + client 1,014 = 2,932 passed |
| unit files | 35 + 196 + 162 = 393 passed |
| unit PostgreSQL skips | expected server 44 files / 321 tests |
| PostgreSQL aggregate | 43/44 files passed; one 20-caller duplicate-key timing failure |
| exact PostgreSQL retry | populationZonesV2Store 7/7 passed |
| typecheck / lint | passed / passed |
| architecture | 6 Node + 10 Vitest passed; 2 accepted cycles; 0 findings |
| policy | 124 assertions passed; known World-group 41941 ownership-safe refusal |
| build / verify / hygiene / diff | passed / passed / passed / passed |

The final database lane used the labeled repository stability container at fixture-required port
35439. The concurrency failure did not reproduce alone. Two `ash_atlas_stability_ci_*` databases
left by an earlier timed-out attempt in the Wave 3B disposable container were identity-checked and
removed. No retained database was touched. The policy fixture was not weakened and the healthy
World process was not killed.

## Runtime and performance

A development login reached the map with `Connection online`. The app exercised current
negotiation; the benchmark exercised accepted bare HELLO. Built-in startup milestones were:
WebSocket 93 ms, map load 258 ms, Pixi 270 ms, WELCOME 320 ms, player state 347 ms, flags state
409 ms, and map idle 573 ms. Therefore WELCOME→player was 27 ms, WELCOME→flags 89 ms, and
WELCOME→map-idle 253 ms.

Browser-control click-to-visible samples (including remote-control overhead) were Actions 402 ms,
Character 337 ms, Inventory 343 ms, Flags 341 ms, and Chat 343 ms. At capture, built-in counters
showed 965 map renders and the development root showed 1,077 GameApp renders.

| 100 authenticated reconnects | p50 | p95 |
| --- | ---: | ---: |
| construction→OPEN | 2.8190 ms | 3.3496 ms |
| HELLO→WELCOME | 88.5298 ms | 93.8229 ms |
| reconnect→usable player + flags | 117.6782 ms | 126.8596 ms |

The sample received 1,991 frames, max 10,962 bytes, active-handle delta −1, and heap delta
+1,196,080 bytes without forced collection; it sent no gameplay mutation. These branch values,
not the historical deployed t093 reference (2.7651/3.4082, 92.4312/99.6220,
122.8718/134.4224), are final comparison authority.

Browser heap and phone-only Inbox/DM first-open timing are blocked by the in-app browser's exposed
desktop controls. They remain final acceptance items. Accepted t091/t093 mobile/navigation/chat/DM,
lifecycle, no-replay, and browser coverage is preserved as contract rather than claimed as a new
manual observation.
