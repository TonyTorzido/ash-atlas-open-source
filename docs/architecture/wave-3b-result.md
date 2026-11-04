# Wave 3B result

## Decision

Wave 3B's remaining code-completion gates are closed on
`chore/client-domain-decomp--from-t093`. `App.tsx` no longer owns a broad
`ServerMessage` switch, every validated frame has one primary domain handler, `protocol.ts` is a
33-line compatibility boundary, and every public `GameClient` command has exact equivalence
coverage. The branch is pushed for owner review only. It has not been merged, tagged,
checkpointed, promoted, or deployed.

The desktop feature runtime, two authenticated identities, two real server-restart recoveries, a
session-replacement cycle, and a fresh-console reload passed. The in-app browser exposes only a
desktop viewport and explicitly rejected phone viewport emulation. Phone/iOS behavior therefore
has automated responsive/navigation coverage but no new live phone-sized browser or physical
Safari/PWA claim. That environmental limitation remains an owner-review item rather than being
reported as a pass.

## Exact authority and isolation

| Item | Exact value |
| --- | --- |
| immutable base | `test/t093` / `b7def168b0dc262c2ad3bcfac811fd1172c4e23d` |
| branch | `chore/client-domain-decomp--from-t093` |
| continuation starting tip | `6be0437d40db75f88283333f67a2406f1d7fa30f` |
| final implementation tip before this record | `aaaf45d23b0b0c836cd7949333c1ef247e2e059b` |
| result commit | the commit containing this document; it is the pushed branch tip |
| runtime ID | `client-domain-decomp-t093-406eb5fecb` |
| runtime endpoints | frontend 41723; backend 41724; disposable PostgreSQL 41725; shared World 41941 |
| final protected refs | `origin/integration/test`, `origin/master`, and `test/t093` all remain `b7def168b0dc262c2ad3bcfac811fd1172c4e23d` |
| deployed production | public `release.json` and `/srv/ash-atlas/game/current` remain the same t093 SHA |
| public frontend | `https://playashatlas.com/play/` returned HTTP 200 |

The runtime reported exact feature SHA `aaaf45d23b0b0c836cd7949333c1ef247e2e059b`
through both health and readiness. Database and World readiness were green. World remains locked
to pipeline `8b8d1c1353cbae563b4c472cdc1d3b6e48ac792b`, release
`world-packages-v1`, profile fingerprint
`36dc3eb8bd36e32f7dc92084f1520d3180e6ce1a6c4f06354f7c1b34d6014553`,
and build-contract fingerprint
`db08e6eb96caa4755f58780f952588efc90c3e644f867d77c87b2955b51d38bd`.

## Continuation commits

| Commit | Completion slice |
| --- | --- |
| `cf37173` | finish physical shared-protocol ownership |
| `ca0d40d` | normalize protocol domain sources |
| `09fe9bb` | extract world and settlement frame handling |
| `7a64916` | move all remaining frame handling to primary domain owners |
| `98d2020` | satisfy protocol compatibility-boundary lint rules |
| `f7b9f4f` | characterize every public `GameClient` command |
| `7ce1a7b` | update flag architecture characterization for its new owner |
| `aaaf45d` | generation-stabilize the App frame-handler lifecycle after live login exposed effect churn |
| result commit | record final verification, runtime, performance, and protected-state evidence |

The complete branch changes 117 files from t093. No replacement App, protocol, command, service,
context, or event-bus monolith was introduced.

## Physical source result

| Host | Baseline physical / nonblank / bytes | Final physical / nonblank / bytes |
| --- | ---: | ---: |
| `App.tsx` | 7,465 / 7,255 / 313,886 | 5,627 / 5,440 / 222,157 |
| `gameClient.ts` | 1,460 / 1,318 / 45,507 | 1,093 / 951 / 36,499 |
| `protocol.ts` | 2,679 / 2,526 / 102,194 | 33 / 30 / 1,516 |

| App measure | Baseline | Final |
| --- | ---: | ---: |
| imports | 115 | 115 |
| `useState` calls | 163 | 111 |
| `useReducer` calls | 1 | 1 |
| `useRef` calls | 86 | 63 |
| `useEffect` calls | 64 | 60 |
| `useLayoutEffect` calls | 1 | 1 |
| `useCallback` calls | 50 | 64 |
| broad `ServerMessage` switch cases | 110 | 0 |

The only remaining switch in `App.tsx` is a five-case lower-case display-status formatter
(`pending`, `generating`, `surveying`, `ready`, `failed`). It is not protocol handling.
`App.tsx` composes typed domain frame handlers and UI/map presentation; it does not parse frames,
construct raw WebSockets, construct raw client messages, or retain message-type case bodies.
Primary handlers publish state before explicitly ordered observers run.

## Protocol, command, and frame ownership

| Contract | Exact final result |
| --- | ---: |
| public `GameClient` methods | 125 |
| lifecycle methods excluded from command matrix | 3: `connect`, `disconnect`, `recoverIfNeeded` |
| public command methods | 122 |
| command-equivalence matrix rows | 122, exactly one per public command method |
| command-equivalence tests | 123: one inventory test plus 122 method rows |
| `ClientMessage` discriminants / owners / schemas | 125 / 125 / 125 |
| `ServerMessage` discriminants / primary routes | 134 / 134 |
| non-terminal guarded routes / terminal fenced routes | 132 / 2 |
| runtime validation routes | 134 |
| valid discriminant fixtures | 134 |

The command matrix asserts exact message type, payload keys and values, omitted versus present
optionals, defaults, UUID call count, public return value, disconnected behavior, intentional
disconnect behavior, protocol-incompatible behavior, serialization containment, send-failure
containment, and absence of reconnect replay. Stale-generation behavior belongs to the transport
lifecycle rather than a public command method and remains covered by `GameClient` and
`BrowserWebSocketTransport` lifecycle tests.

`protocol.ts` contains only compatibility re-exports and narrow aggregate imports. Message unions,
schema bodies, validation ownership, fixtures, and ownership registries are physically located in
domain protocol modules. Existing import paths and package exports still compile. The send-outcome
union remains:

`sent | socket-not-open | stale-socket | serialization-failed | send-failed |
intentionally-disconnected | protocol-incompatible`

Every command makes one immediate send attempt. There is no mutation queue and no automatic replay
for movement, flags, travel/tolls, market, equipment, class, pets, manor, chat, or direct messages.

## Architecture

The final scan covers 503 production files and 1,776 imports with zero dependency cycles and zero
boundary findings. Eight Node architecture fixtures and ten server architecture tests pass.

Enforcement proves:

- one browser `WebSocket` constructor and one raw `WebSocket.send` owner;
- one raw server-frame `JSON.parse` and validation boundary;
- no unchecked production `ServerMessage` cast;
- exhaustive and unique client command, frame, schema, validator, fixture, and protocol ownership;
- no broad App frame switch or compatibility-host implementation body;
- no raw transport import from feature domains and no domain-client cross-import;
- one reconnect-policy owner;
- Wave 2B server/HTTP ownership and Wave 3A lifecycle/protocol/no-replay ownership remain green;
- both accepted shared cycles remain removed and no new cycle exists.

## Complete verification after `aaaf45d`

| Gate | Exact result |
| --- | --- |
| frozen install | passed; already up to date in 228 ms |
| aggregate unit suites | 408 files; 3,079 tests passed |
| shared unit | 38 files; 295 tests |
| server unit | 196 files; 1,629 tests; PostgreSQL lane correctly skipped here |
| client unit | 174 files; 1,155 tests |
| PostgreSQL | 44/44 files; 321/321 tests; 114 migrations |
| migration 0665 | unchanged SHA-256 `efd21cda6ab83a8e6e3a97147258d83043e5bab5446550e18a52f9196fbe818d` |
| migration 0666 | unchanged SHA-256 `8f32c1748b023c17f0802564c92866b23703a1ea459a623cf7799fb26694da92` |
| typecheck / lint | passed / passed |
| architecture | passed; 0 cycles, 0 findings |
| policy | 224 assertions passed; final World-group fixture refused shared port 41941 |
| production build / verify | passed / passed |
| hygiene / diff check | passed / passed |

The PostgreSQL runner used only the dedicated `ash_atlas_stability` service on port 35439 and
created/dropped its own `ash_atlas_stability_ci_*` databases. The final policy fixture reported
`REFUSED: World API group port 41941 is not owned only by recorded PID 54364.` This is the
documented ownership-safe collision with the healthy shared World process. The fixture was not
weakened, its timeout was not increased, and the shared World process was not killed.

## Build comparison

| Artifact | Wave 3B baseline | Final | Change |
| --- | ---: | ---: | ---: |
| server JavaScript | 3,073,689 B | 3,078,707 B | +5,018 B (+0.16%) |
| server source map | 5,877,594 B | 5,872,080 B | -5,514 B |
| client main JavaScript | 2,685,048 B | 2,724,370 B | +39,322 B (+1.46%) |
| client main gzip | 761.08 kB | 770.92 kB | +9.84 kB |
| client CSS | 366,854 B / 63.28 kB gzip | 366,854 B / 63.24 kB gzip | unchanged source |

Vite transformed 1,077 modules. The only build warning is the existing greater-than-500-kB main
chunk. Measured decomposition did not justify a new lazy boundary, so no code splitting or loading
behavior changed.

## Performance

### Network and validation

One hundred sequential authenticated current-protocol connections sent a bare `HELLO`, waited for
`WELCOME`, `PLAYER_SNAPSHOT`, and `FLAGS_SNAPSHOT`, then closed normally. The run received 1,979
frames, observed a 10,962-byte maximum frame, and sent no gameplay mutation.

| Metric | Wave 3B baseline p50 / p95 | Final p50 / p95 | p95 change |
| --- | ---: | ---: | ---: |
| construction to OPEN | 2.8190 / 3.3496 ms | 2.5888 / 3.1175 ms | -6.9% |
| `HELLO` to `WELCOME` | 88.5298 / 93.8229 ms | 84.1556 / 88.5953 ms | -5.6% |
| reconnect to usable player + flags | 117.6782 / 126.8596 ms | 111.7051 / 118.8380 ms | -6.3% |

Maxima were 3.8272, 100.3289, and 138.0505 ms. Compared with accepted historical Wave 2 values,
the final `HELLO` p95 is 2.1 ms faster than 90.67 ms, while usable p95 is 5.46 ms slower than
113.38 ms and remains within the accepted reconnect threshold.

A 10,000-sample complete `parseServerMessage` benchmark using a valid `PONG` frame measured
0.0035 ms p50 and 0.0062 ms p95. This remains below Wave 3A's recorded complete-validation p95 of
0.1452 ms. Parser architecture and fixture tests additionally prove one parse, validation, and
dispatch route for every discriminant.

### Startup, panels, and renders

Five clean persisted-session desktop loads produced these built-in milestone distributions:

| Milestone | Baseline single sample | Final p50 / p95 |
| --- | ---: | ---: |
| WebSocket connected | 93 ms | 75 / 76 ms |
| `WELCOME` | 320 ms | 184 / 187 ms |
| first player state | 347 ms | 228 / 248 ms |
| first flags state | 409 ms | 245 / 271 ms |
| map load | 258 ms | 306 / 351 ms |
| Pixi initialized | 270 ms | 309 / 320 ms |
| map idle | 573 ms | 613 / 660 ms |

The final map-idle p50 is 40 ms (+7.0%) above the one-sample baseline; the baseline did not record a
p95 distribution. `WELCOME` to player p50 was 41 ms and `WELCOME` to flags p50 was 58 ms.
`WELCOME` to map-idle p50 was 429 ms versus the original single-sample 253 ms; this non-equivalent
single-versus-distribution comparison is recorded for owner review rather than hidden.

Browser-control click-to-visible samples include control-channel overhead:

| Panel | Baseline | Final |
| --- | ---: | ---: |
| Actions | 402 ms | 291 ms |
| Character | 337 ms | 282 ms |
| Inventory | 343 ms | 294 ms |
| Flags | 341 ms | 291 ms |
| public chat | 343 ms | 287 ms |
| Travel Inbox | not recorded | 283 ms |
| direct messages | not recorded | 295 ms |

The final clean sample settled at 54 map render events, zero map renders/second, one static redraw,
and zero reconnects after initialization. No update storm or repeated map reconstruction was
observed. Root-render and browser-heap baselines are not exposed by the in-app browser, so no
unsupported comparison is claimed.

## Runtime acceptance

The exact committed runtime passed:

- development login and persisted-session login;
- current `WELCOME` metadata, legacy bare `HELLO` without metadata, and incompatible-protocol close
  code 4003;
- two backend/frontend restart recoveries through visible offline/reconnecting/online states;
- session replacement and explicit `Reconnect Here` recovery;
- one live socket after restart and after 100 sequential benchmark connections;
- map initialization, teardown/reload, double-click movement, normal queued flag construction,
  owned-flag loading, and Quick Jump travel;
- Inventory, Character, classes, flags, World Map, Travel Inbox, Kingdom, and desktop panels;
- manor construction, entry, storage open, exit, and reconnect preservation;
- a disposable training-dummy spawn and authoritative attack result from 100 to 88 HP;
- market open/subscription presentation and wallet/items;
- disposable Echo creation plus the expedition dashboard;
- all four public chat channels and unique round-trip messages;
- a second authenticated identity for DM list/open/send/delivery/read in both directions;
- clean final persisted-login reload with zero browser errors, warnings, or unhandled rejections.

No-replay proof used database counts before and after the second real restart. Counts remained
exactly seven uniquely named chat/DM acceptance messages, one flag build, one flag travel command,
one manor, and one pet. Health reported exactly one connection lease. The 100-cycle benchmark sent
zero mutations.

Automated suites cover offline/online and foreground/background lifecycle, stale socket/timer
fencing, queued long-press flag building and cancellation, map listener teardown, harvesting and
collectibles, party/travel inbox, market/DM no replay, equipment/classes, mobile inbox, phone
keyboard docking, native phone back/swipe history, bottom dock, focus, and t093 responsive UI.
Those phone results are test simulation, not a new live phone browser or physical-device run.

## Protected-state confirmation

After the final fetch, `origin/integration/test`, `origin/master`, and the latest immutable
checkpoint `test/t093` still resolve exactly to
`b7def168b0dc262c2ad3bcfac811fd1172c4e23d`. Public `release.json` reports that same SHA,
`/srv/ash-atlas/game/current` resolves to its exact release directory, and both production game and
World services remain active.

No protected branch, tag, checkpoint, deployment, production service, Main database, retained
player/flag/city row, migration, World repository, World lock, Settlement Authority identity, or
Population V2 identity was changed. Disposable gameplay writes occurred only in the isolated
feature database. Nothing was merged, tagged, checkpointed, promoted, deployed, reconciled, reset,
or written to production.

Wave 4 remains unchanged: Resource/Water Vision measurement and any Population V1/schema,
statement-timeout, reconciliation, or retained-data decision require separate authorization.
