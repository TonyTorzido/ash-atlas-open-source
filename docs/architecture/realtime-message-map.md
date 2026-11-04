# Realtime message map (Wave 2 baseline)

Captured at `test/t087` before transport extraction. The public schemas remain in
`packages/shared/src/protocol.ts`, `marketProtocol.ts`, and `directMessages.ts`; this map groups
those existing discriminated unions by current server ownership. It is an ownership map, not a
protocol redesign.

This remains the historical pre-extraction map. Wave 2B completed physical ownership; see
[realtime-handler-ownership.md](realtime-handler-ownership.md) and
[wave-2b-result.md](wave-2b-result.md).

## Current transport boundary

`apps/server/src/realtime/websocket.ts` is 9,137 lines. It performs one `parseClientMessage` call,
then one switch beginning at line 2,935. The same module owns authentication, HELLO/bootstrap,
connection replacement, handler state, domain mutations, relocation, publication, and cleanup.
`ConnectionRegistry` owns socket indexes and the existing four send modes, but callers choose a
mode ad hoc and most sends rely on the default critical mode.

| Family | Existing client messages | Current switch area | Required Wave 2 owner |
| --- | --- | --- | --- |
| Session/bootstrap | `HELLO`, `REQUEST_CHAT_BOOTSTRAP`, `REQUEST_WORLD_RESYNC`, `PING` | 2935-3554, 3555, 7799-7812 | lifecycle/session handler |
| Movement/world admission | `MOVE_TO` | 4717-4805 | world-gameplay handler |
| Flag construction | `PLACE_FLAG`, `CANCEL_FLAG_BUILD`, `REINFORCE_FLAG` | 6152-6248 | flag handler |
| Flag/Kingdom travel | `VISIT_FLAG`, `VISIT_WORLD_MAP_KINGDOM` | 6707-6891 | travel handler plus destination adapters |
| City/World Map | `PREVIEW_CITY_FOUNDING`, `FOUND_CITY`, `REQUEST_CITY_INFO`, `REQUEST_WORLD_MAP_DESTINATIONS`, `JOIN_CITY`, `LEAVE_CITY`, `CLAIM_CITY_MAYOR`, `RELINQUISH_CITY_MAYOR`, `CONVERT_CITY_FLAG`, `VISIT_CITY`, `VISIT_WORLD_MAP_CITY` | 6249-6706 | settlement handler |
| Party/travel invites | `CREATE_PARTY`, `ADD_PARTY_MEMBER`, `ACCEPT_PARTY_INVITE`, `DECLINE_PARTY_INVITE`, `REMOVE_PARTY_MEMBER`, `LEAVE_PARTY`, `CHANGE_PARTY_LEADER`, `SET_PARTY_TRAVEL_ALLOWED`, `SET_PARTY_AUTO_FOLLOW`, `TRAVEL_TO_PARTY_LEADER`, `REQUEST_TRAVEL_INBOX`, `SEND_TRAVEL_INVITE`, `RESPOND_TRAVEL_INVITE`, `CANCEL_TRAVEL_INVITE` | 4879-5535 | party/travel handler |
| Manor | build/destroy/jump/enter/cancel/guest management/exit/move/storage messages | 3978-4505 | manor handler; interior authority remains specialized |
| Resources/inventory | nearby/survey/harvest/drop/pickup/water messages | 6892-7379 | harvesting/resources handler |
| Combat/equipment/class | attack, ability, class, progression, equipment, and combat-kit messages | 4806-4878, 5547-6151, 7380-7473 | combat/equipment handler |
| Public/local chat | channel select/send/history/read and `KINGDOM_CHAT_SEND` | 4506-4592, 4836-4867 | social handler |
| Direct messages | all `DM_*` client messages | 3953-3977 | social handler delegating to the existing coordinator |
| Market | all `MARKET_*` client messages | 4593-4716 | market handler |
| Pets/expeditions | pet and expedition request/mutation/debug messages | 3561-3952 | pet handler |
| Developer relocation/mutation | `DEV_SPAWN_MOB`, `DEV_CLEAR_MOBS`, `DEV_VISIT_MINE`, `DEV_TELEPORT`, development progression/assets | 5547-5742, 7474-7798 | developer handler |

Every message above is already a member of the shared `ClientMessage` discriminated union. Unknown
or malformed input is rejected by that single parser before dispatch. Direct-message malformed
input has the existing privacy-safe `DM_ERROR` compatibility path.

## Current lifecycle and ordering contracts

- Upgrade authentication precedes message handling. HELLO is single-use per socket.
- HELLO loads the durable player, restores manor/party/social state, assigns a monotonically
  increasing connection generation, installs the active registry record, replaces the old active
  account connection, publishes `WELCOME`, then runs independently fault-isolated bootstrap work.
- Every message rechecks session validity on the existing interval and rejects a connection that is
  no longer active for the account.
- Request IDs are copied to mutation results and errors where the public schema currently carries
  one. No second parse or authentication path exists.
- Close cleanup is generation/current-connection fenced so a stale close cannot remove newer
  authority. Population leases, pending manor entry, transitions, chat/DM state, and world
  authority are released by that cleanup path.

## Existing outbound delivery behavior

| Effective class at t087 | Current examples | Backpressure behavior |
| --- | --- | --- |
| `critical` (default) | session invalidation, WELCOME, errors, travel and mutation results, inventory/economy, equipment/class, toll/build results | sent unless socket is unavailable; hard-buffer breach closes the socket |
| `replaceable` | player snapshot/delta, combat snapshot/delta, selected chat preview/read state, Population V2 delta publication | skipped/coalesced above the soft buffer; repeated skips or hard-buffer breach close |
| `recoverable-social` | durable DM events/results recoverable by cursor | may skip under backpressure; history/cursor recovery remains authoritative |
| `transient-social` | transient chat/presence-style delivery | may skip under backpressure |

The classification is currently expressed at individual call sites. There are direct raw-socket
sends and registry sends throughout `websocket.ts`, plus legitimate domain publishers in
`WorldRuntime`, chat, direct messages, HTTP mutations, and Kingdom routing. Wave 2 must preserve the
effective table while moving application-frame publication behind one policy-aware publisher.

## Baseline characterization coverage

The t087 unit and PostgreSQL suites exercise unauthenticated upgrade rejection; HELLO/WELCOME;
parallel and repeated HELLO; bootstrap subsystem failure; PING/PONG; replacement and reconnect;
stale cleanup; graceful shutdown; accepted/rejected movement; immediate movement after travel;
combat and abilities; flag quote/build/cancel/complete/travel/toll/private/aggression cases; city,
World Map, Kingdom, party, Auto-Follow, invite, manor, and developer relocation; cold/warm/empty/
retryable Population V2 results; harvesting, water, drops, inventory, equipment, class, market,
public/local chat, DMs, and pets. Extraction must keep these tests running against the compatibility
entry point so ordering and public errors remain observable.
