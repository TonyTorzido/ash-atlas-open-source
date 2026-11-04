# Authoritative relocation

`coordinateAuthoritativeRelocation` is the shared committed-transition coordinator used by the
existing world-to-world flag, city, World Map, Kingdom, party, invite, and authorized developer
paths. Destination adapters remain responsible for unlike authorization and transaction rules.

Interior entry, exit, and room transitions—including Manor exit—are governed by
`UNIVERSAL_PORTAL_AND_LOCATION_SYSTEM.md`. They use the universal portal transition coordinator,
not `coordinateAuthoritativeRelocation`, because the two coordinators own distinct transition
lifecycles.

Player-facing flag-destination presentation must also follow
`docs/build-bible/FLAG_TRAVEL_AND_ARRIVAL.md`.

## Before and after

| Concern | Before Wave 2 | After Wave 2 |
| --- | --- | --- |
| destination authorization | separate per destination | unchanged, separate per destination |
| toll/access transaction | flag-specific atomic path | unchanged flag adapter |
| arrival reservation/spacing | flag/party-specific | unchanged destination adapter |
| transition acquisition | repeated in travel paths | coordinator |
| player authority fence | repeated wrapper | coordinator `runExclusive` port |
| phase-one relocation/persistence | repeated body | typed phase-one adapter |
| revision/watchdog | repeated | coordinator |
| Population V2 visible readiness | repeated | coordinator; background for flag destinations |
| committed transition release | repeated | coordinator; flag destinations release after commit |
| independent phase two | repeated fire-and-isolate | coordinator starts returned phase-two operation |
| rollback | path-local | returned typed rollback state; existing phase-one restoration retained |

## Ordering contract

1. Verify availability and acquire the existing world-transition token.
2. Run destination phase one under the player authority fence.
3. Phase one performs current locks, authorization, toll/access transaction, reservation, invite
   invalidation, combat/movement stop, durable relocation, persistence/rollback, spatial update,
   replication reset, one Population V2 scheduling operation, and construction of the independent
   destination-publication callback.
4. Read the committed relocation revision and arm the unchanged 500 ms watchdog.
5. Select the destination release policy. Flag destinations observe Population V2 visible readiness
   in the background; it is not a post-commit release barrier. Other adapters may retain their
   existing readiness gate.
6. End the transition as committed and release immediate/buffered movement.
7. Start the existing independent phase-two task. For a flag destination this immediately
   publishes the authoritative arrival and begins flag scope without waiting for population.
8. Publish current-authority combat, collectible, and other population-backed baselines when
   visibility settles. Phase-two or background failure cannot roll back a commit.

The typed result records committed/rejected status, player snapshot, destination identity,
relocation revision, publication state, Population handle, phase-two state, and rollback state.

## Preserved special cases

- direct flag toll price, stale quote, payment transaction, and private/enemy access;
- fee-free one-use Travel Invite and party-hosted arrivals without durable passage grants;
- city and World Map discovery requirements;
- Kingdom authorization;
- party leader/member policy, Auto-Follow, and exact spacing;
- travel-invite single-use behavior;
- developer capability and replay key;
- reservation release on all failure paths;
- pre-commit persistence view restoration;
- replacement/stale-connection fencing;
- one Population V2 relocation and immediate post-arrival movement.
- one authoritative flag-arrival placement; preparation and retry state never place the actor.

Focused websocket, flag, city, Kingdom, party, Population V2, and coordinator tests preserve
the required success/denial/rollback/watchdog matrix. No transaction was broadened and no arrival
geometry, idempotency key, or public error changed.
