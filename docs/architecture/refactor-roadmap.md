# Historical architecture refactor roadmap

This roadmap records the original wave plan and branch status at those checkpoints. Its deferred
items are historical, not a current task list. Use the [current application map](current-application-map.md)
for the implemented architecture; retain the wave reports as evidence of their original changes.

## Wave 1: foundation (accepted at `test/t087`)

Wave 1 established importable application composition, typed transport dependencies, lifecycle and
periodic-task supervision, the Population V2 realtime adapter, fail-closed authority identities,
bounded PostgreSQL metrics, architecture checks, canonical CI, and the isolated PostgreSQL matrix.

## Wave 2: transport ownership (this branch)

Wave 2 adds the thin WebSocket and HTTP compatibility entries, exhaustive typed realtime-family
and route-family ownership, one publisher/delivery-policy path, connection-generation and bootstrap
lifecycle components, a shared authoritative relocation coordinator, cancellation-aware HTTP
admission, authenticated transport metrics, neutral Population/Resource Vision ports, and stronger
architecture enforcement.

Acceptance evidence is recorded in `wave-2-result.md`. Public frames, route paths, payloads,
authentication, errors, probe semantics, World/Settlement/Population identities, migrations, and
gameplay values remain unchanged.

Owner-review follow-up should decide whether physically moving the stable connection-local switch
bodies out of `realtimeApplication.ts`, and the stable route handler bodies out of
`registerRoutes.ts`, provides enough reviewability to justify a second high-churn move. The current
branch establishes enforced typed family seams first and deliberately avoids rewriting those
already-characterized bodies while changing authority, publication, and cancellation boundaries.

## Wave 3: protocol and client boundaries

Add protocol-version negotiation and runtime validation for server frames, then split `GameClient`
by domain. Extract `App.tsx` feature state and view sections without redesigning the UI or adopting
Redux. Split the shared protocol only after both sides consume stable domain seams and remove the
two remaining shared-package cycles:

- classes/combat/progression;
- equipment/equipment-balance.

Acceptance requires old/new client compatibility for the supported window, bounded parsing
failure, no duplicated wire schema, and no gameplay-state divergence.

The Wave 3B feature branch completed command-domain extraction, exhaustive ownership registries,
typed domain frame handling, feature hooks, map-runtime isolation, physical protocol ownership,
per-command equivalence coverage, and both shared-cycle removals. `App.tsx` has no broad
server-frame switch and the central protocol host is a thin compatibility boundary.
`wave-3b-result.md` records the exact review result and the disclosed live phone-viewport
limitation. The work remains unaccepted until owner-authorized integration.

## Wave 4: durable subsystem simplification

Use Resource Vision production measurements to retain, simplify, or replace it with bounded Water
Vision. The separately authorized V2-only lifecycle correction subsequently removed Population V1
source and schema through the explicit population-only reset migration
`0671_population_v2_generation_lifecycle.sql`. Classify PostgreSQL statement-timeout profiles using
measured queries before adopting any broad timeout. Any other schema deletion, production
reconciliation, or retained-data change remains separately authorized.

## Still deferred

- owner acceptance and integration of the completed Wave 3B client/shared-protocol branch;
- protocol-version negotiation;
- `/live` deployment-probe migration;
- Resource Vision behavior change or removal;
- settlement redesign, production reconciliation, or World repository changes.
