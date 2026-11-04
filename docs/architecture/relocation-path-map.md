# Authoritative relocation path map (Wave 2 baseline)

Captured at `test/t087` before consolidation. Population V2 is a visibility/preparation adapter;
it does not authorize, charge, or persist travel.

## Existing paths

| Destination path | Current entry | Destination-specific authority | Shared orchestration currently duplicated |
| --- | --- | --- | --- |
| personal/public/private/custom/toll flag | `VISIT_FLAG` | flag access decision, enemy/custom rules, toll quote and atomic charge, arrival reservation | fence, transition, combat/movement stop, durable relocation, spatial reset, result, V2 readiness, phase two |
| Kingdom Seat | `VISIT_WORLD_MAP_KINGDOM` | Kingdom membership/seat resolution | same world-relocation sequence as flag travel |
| city | `VISIT_CITY` | nearby/current city rules | same sequence with city result/discovery |
| World Map city | `VISIT_WORLD_MAP_CITY` | durable discovery and current active city resolution | same sequence with World Map denial/result semantics |
| party manual | `TRAVEL_TO_PARTY_LEADER` | leader/member state and `travelAllowed` | same sequence plus party arrival spacing |
| party Auto-Follow | party relocation callback | current leader/follower state and opt-in | same sequence plus multi-member reservation/spacing |
| travel invite | `RESPOND_TRAVEL_INVITE` | durable single-use reservation and inviter state | same sequence after invite consumption |
| manor exit | `EXIT_MANOR`/`coordinateManorExit` | manor-session ownership and recorded world return | same world re-entry sequence; interior movement remains specialized |
| developer teleport | `DEV_TELEPORT` | developer capability and replay key | same durable relocation/V2/result sequence without player travel policy |

## Canonical ordering to preserve

1. Resolve the active player and active connection.
2. Fence account/player ownership and reject an existing world transition.
3. Evaluate common travel locks, then destination-specific authorization.
4. Perform toll/access transaction and arrival reservation where required.
5. Invalidate affected travel invites; cancel combat and stop movement where current behavior does.
6. Capture the current gameplay-view transition and apply authoritative relocation/revisions.
7. Persist the player snapshot; restore the captured view on pre-commit persistence failure.
8. Update spatial membership and reset world/combat replication as required.
9. Schedule one Population V2 relocation through `PopulationRealtimeAdapter`.
10. Read the committed relocation revision and arm the committed-transition watchdog.
11. Apply the destination release policy. A committed flag destination selects immediate release
    without waiting for visible readiness; its Population V2 readiness continues in the
    background. Other destination adapters retain their explicitly configured readiness behavior.
12. End the transition as committed and allow buffered/immediate movement.
13. Run independent phase-two publication. A flag destination publishes its one authoritative
    arrival and begins flag scope immediately; population-backed baselines publish later only when
    their connection and world-view authority remain current.
14. Release reservations and refresh placement quote state where applicable.

The coordinator may not broaden toll or persistence transactions. A committed relocation remains
committed if phase-two Resource Vision or other independent publication fails.

## Current shared owners and fences

- `PlayerAuthorityFence` serializes authoritative player mutations.
- `smoothTravelTransitions` records request, connection generation, relocation revision, commit
  state, and watchdog ownership.
- `FlagArrivalReservations` and party arrival allocation preserve exact geometry and release on all
  paths.
- `WorldRuntime` owns movement command ordering and transition buffering/replay.
- `GameState` owns in-memory position, area/view generation, spatial membership, and replication
  reset state.
- `PlayerService` owns durable player persistence.
- `PopulationRealtimeAdapter` owns V2 relocation scheduling, visible-ready outcome, completion, and
  connection lease release.

## Baseline failure semantics

- Pre-commit lookup/authorization/toll/persistence failure publishes no success and releases the
  transition/reservation.
- Persistence failure restores the prior gameplay view and authoritative snapshot.
- Disconnect or replacement during pre-commit work prevents stale publication.
- A replacement connected during a committed persistence window receives the committed result.
- Population V2 `ready`, `stale`, `failed`, or timeout never rolls back committed travel. For flag
  destinations it also cannot delay transition release, authoritative arrival, or flag scope.
- Optional Resource Vision failure is logged and isolated after commit.

Wave 2 should replace the duplicated shared column with one coordinator and retain narrow typed
destination adapters for the authority-specific column. Manor interiors and unlike mutations must
not be forced into the shared coordinator.
