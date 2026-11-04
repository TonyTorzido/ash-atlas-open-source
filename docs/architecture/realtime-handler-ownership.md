# Realtime handler ownership

Wave 2B physically owns every one of the 125 existing `ClientMessage` variants in exactly one typed
family module.
`CLIENT_MESSAGE_FAMILIES` is exhaustive over the shared discriminated union; duplicate family
registration fails; startup fails if any family is absent; malformed or unknown input still fails
at the single existing parser boundary.

| Family | Count | Owned messages / concern |
| --- | ---: | --- |
| session | 3 | `HELLO`, `PING`, `REQUEST_WORLD_RESYNC`; lifecycle and bootstrap |
| world-gameplay | 1 | `MOVE_TO`; authoritative world-command admission |
| flag | 3 | place, cancel build, reinforce |
| travel | 4 | flag, city, World Map city, Kingdom Seat travel |
| settlement | 10 | city founding/membership/mayor/flag conversion and World Map/Kingdom reads |
| party | 14 | party membership, travel policy, Auto-Follow, travel inbox/invites |
| manor | 14 | build/destroy/entry/exit/guest/storage/interior movement |
| harvesting | 8 | survey, nearby resources, harvest, water, drop and pickup |
| combat-equipment | 18 | attack, abilities, class, progression, equipment, combat kits |
| social | 17 | public/local/Kingdom chat and all direct-message operations |
| market | 8 | open, book, quote, order, cancel, claim, subscriptions, simple buy |
| pet | 18 | pet lifecycle, memories, expeditions, and authorized debug operations |
| developer | 7 | authorized mob, mine, teleport, progression, assets, subclass tools |

Each registrar takes `RealtimeFamilyHandler<its-family>` rather than a generic message callback, so
cross-family wiring is a compile-time error. Each family factory now owns its characterized message
bodies and receives narrow state and operation ports. This preserves request IDs, rate windows,
fences, in-flight maps, transactions, error mapping, and frame order while making implementation
ownership exhaustive and reviewable.

## Connection context and failure boundary

The connection-local scope owns socket identity, authenticated account/player, connection ID and
generation, live-session validation, request logger context, rate windows, and narrow publisher/
domain operations. It does not perform a second parse or authentication. Top-level dispatch catches
unexpected handler failures once and publishes the existing `WEBSOCKET_ERROR`; expected validation,
authorization, stale-connection, duplicate, queue, persistence, and Population failures retain
their existing domain errors.

## Enforced boundaries

- handler modules cannot send raw frames or call serialization;
- handler modules cannot construct stores/services/runtimes/backends;
- transport composition cannot construct Population authority;
- `websocket.ts` cannot contain parsing, switches, send calls, or registration;
- `realtimeApplication.ts` cannot contain client-message switches or known family implementations;
- application-frame publication must use the publisher path.

`realtimeApplication.ts` is now transport and composition: plugin setup, parser/router invocation,
publisher construction, family factory wiring, the common unexpected-error boundary, connection
close/revalidation, and final lifecycle assembly. Focused state modules own class, party, manor,
travel, social, and developer mutable state; focused operation modules own shared snapshot,
Population, flag, travel, manor, combat/equipment, connection-world, and admission coordination.
