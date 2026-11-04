# Flag travel and arrival

This standard covers every world relocation whose destination is a flag: direct Quick Jump,
World Map flag travel, party travel and Auto-Follow, and travel-invite arrival at a flag. City,
Kingdom, administrative, and other world relocations continue to use their destination adapters
and the shared coordinator. Interior entry, exit, and room travel use the universal portal system.

The implementation source of truth is `apps/server/src/realtime/travelRealtimeOperations.ts`,
`apps/server/src/game/travel/authoritativeRelocationCoordinator.ts`, and the client travel
presentation in `apps/client/src/App.tsx`.

## Authoritative arrival contract

1. Preparation may validate access, warm Population V2, and reserve an exact arrival position. A
   prepared or reserved position is not an arrival and must not move or present the player.
2. The server performs authorization, toll and reservation work, durable relocation, spatial and
   revision updates, and persistence before reporting success.
3. Once a flag relocation commits, Population V2 visible readiness is observed in the background;
   it is not a barrier to releasing the committed transition.
4. The server starts destination publication immediately after release. `FLAG_VISITED` is the
   authoritative local-player placement and carries the committed player snapshot and revisions.
5. The client places the player and movement circle exactly once from that authoritative arrival.
   It must not create a speculative player presentation from prepare, click, reservation, or retry
   data.
6. Flag scope begins independently of Population V2 readiness. Combat, mobs, collectibles, and
   other population-backed baselines may stream afterward when ready.
7. Every late baseline must match the current connection and world-view authority revisions. A
   stale population result is ignored and may never move the actor, replace the anchor, or reopen
   a completed travel presentation.
8. Reconnect restores the committed canonical location. It is recovery, not the normal completion
   mechanism for a successful travel request.

## World Map route presentation

World Map route presentation starts destination preparation on Travel and requests the existing
authoritative relocation only after the dotted-route animation completes. The local map marker
is a journey illustration, never a speculative world actor placement. Duration is proportional
to shortest globe distance: zero at the same point and 15 seconds at the antipode, with no minimum
floor. Preparation and the route do not authorize arrival; the existing authoritative success
frame remains required before revealing the destination. Cancellation before route completion
cancels preparation without sending a relocation request. Direct Quick Jump and companion arrival
retain their existing timing.

## Party behavior

The leader's committed flag arrival follows the same immediate release and single-placement
contract. The leader's authoritative arrival publishes before Auto-Follow starts, so the leader
remains first. Auto-Follow then begins immediately through the same authoritative flag-travel path
and shared arrival plan. Neither the leader's nor a follower's Population V2 readiness may delay
the follower's authoritative commit or arrival publication. Each follower establishes its own
connection-scoped Population V2 relocation after commit and streams its baselines when ready.

Each follower revalidates party membership, Auto-Follow opt-in, active connection, and relocation
revision before committing. Leaving the party, disconnecting, or making a newer manual jump before
commit must supersede the follower arrival; a newer action after commit wins through the normal
relocation revision ordering.

## Companion arrival authority

Travel Invite acceptance, manual Travel to Leader, and Auto-Follow are hosted companion arrivals,
not direct flag jumps. A valid hosted arrival uses the host's authoritative layer anchor and the
shared arrival reservation, pays no Public or Normal flag toll, and creates no durable flag passage
grant. A flag owner may host a one-use arrival at their Normal or Private flag; a non-owner host
cannot grant access the traveler does not otherwise have. Existing enemy restrictions remain in
force for non-owner hosts. Direct flag travel continues to use the configured access mode, toll
quote, and atomic wallet transaction.

## Required focused verification

- Hold `visibleReady` unresolved and prove the transition releases, `FLAG_VISITED` arrives, and the
  flag snapshot publishes.
- Prove the client does not place the player from preparation and uses the coordinates in the
  authoritative arrival frame exactly once.
- Resolve population later and prove current-authority entity baselines publish without another
  player placement.
- Replace authority while readiness is pending and prove the stale baseline is discarded.
- Hold both leader and follower `visibleReady` unresolved and prove leader relocation occurs first
  while every eligible Auto-Follow member still arrives and receives flag scope.
- Cover pre-commit follower authority rejection and supersession by a newer manual jump.
- Cover retry without retaining or rewriting a speculative presentation.
