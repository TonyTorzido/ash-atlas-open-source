# Wave 2B physical-extraction plan

## Goal and invariants

Move the stable implementation bodies behind the Wave 2 seams into their declared owners. This is
a physical ownership change only. Protocol schemas, messages, frames, delivery classes, HTTP
contracts, errors, authentication, admission/cancellation, durable authority, relocation ordering,
and gameplay behavior remain byte-for-byte or observably equivalent.

The compatibility exports remain stable. `realtimeApplication.ts` ends as transport/composition;
`registerRoutes.ts` ends as admission and route-family composition. No new generic service locator,
framework, dependency, one-file-per-message layout, or replacement god module is permitted.

## Completion status

Completed on `chore/physical-transport-extract--from-t088`. All 13 realtime families were moved in
the required order, focused mutable state and shared coordinators were extracted, all six HTTP
families own their schemas and handlers, and compatibility exports remain stable. The measured
result and final verification are recorded in [wave-2b-result.md](wave-2b-result.md).

The Population rollout route named in this historical plan was later removed. The current V2-only
runtime has no rollout, prepare, or cutover HTTP surface; its developer-authorized operational
snapshot is owned by `diagnosticRoutes.ts`.

## Realtime ownership table

| Behavior | Wave 2 source/range | Final owner |
| --- | --- | --- |
| HELLO/PING/resync/session | `realtimeApplication.ts` 2940-3553, 7754-7774 | `sessionHandler.ts` |
| movement/world commands | 4716-4804 | `worldGameplayHandler.ts` |
| flag construction/mutations | 6151-6247 | `flagHandler.ts` |
| flag/city/World Map/Kingdom relocation | 6508-6890 | `travelHandler.ts` |
| city/Kingdom reads and mutations | 6248-6507 | `settlementHandler.ts` |
| party/invites/Auto-Follow | 4878-5545 | `partyHandler.ts` |
| manor | 3977-4504 | `manorHandler.ts` |
| harvesting/resources/items | 6891-7334 | `harvestingHandler.ts` |
| combat/equipment/classes | 4805-4817, 4867-4877, 5742-6150, 7335-7428 | `combatEquipmentHandler.ts` |
| chat/DM/social | 3554-3559, 3952-3976, 4505-4591, 4818-4866 | `socialHandler.ts` |
| market | 4592-4715 | `marketHandler.ts` |
| pets | 3560-3951 | `petHandler.ts` |
| developer operations | 5546-5741, 7429-7753 | `developerHandler.ts` |

## Execution contracts

Each family gets a `create...Handler` factory and its own exported context type. Contexts expose
capabilities, not the complete application dependency object. Common values are grouped into small
ports rather than copied into a universal handler context:

- `RealtimeConnectionContext`: current authenticated account/player/connection identity and
  currentness checks; session owns the mutation methods.
- `RealtimePublicationPort`: the existing policy-aware direct/connection/player publication and
  common typed errors.
- `RealtimeWorldCommandPort`: movement/world-command admission only.
- `RealtimeRelocationPort`: destination adapters call the existing authoritative coordinator;
  transition, readiness, watchdog, and phase-two ordering remain centralized.
- focused scope-publication ports for bootstrap, travel completion, combat, resources, and manor.

The session context receives lifecycle/bootstrap/auth/player operations only. Travel receives
destination/access/reservation/relocation/Population capabilities only. Market receives market,
actor, limiter, publisher, and logger capabilities only. Equivalent least-capability contracts are
used for every other family.

## Mutable state owners

1. Keep connection generation and close ownership in `connectionLifecycle.ts`.
2. Move class rate windows and mutation tokens with combat-equipment state.
3. Move party mutation and completed-follow fences with party state.
4. Move pending manor entry/jump state with manor state.
5. Move transition watchdog/reservation bookkeeping with travel state.
6. Move developer teleport in-flight/replay state with developer state.
7. Move chat bootstrap flights/readiness and chat rate state with social state.
8. Move market edge windows with market state.

Every state owner has explicit operations for begin/wait/finish/cleanup and preserves the existing
size/age bounds. Cross-family player-authority and connection-currentness remain narrow shared
ports. No `sharedState.ts` module will be introduced.

## Ordered realtime extraction

The required order is session, world-gameplay, flag, travel, settlement, party, manor, harvesting,
combat-equipment, social, market, pet, developer.

For each family:

1. Add/refine its least-capability context and focused state owner.
2. Move its complete case bodies and family-only helpers without changing statement order.
3. Register the new factory directly with the exhaustive router.
4. Remove the old cases and duplicate state/helpers from the compatibility host.
5. Run typecheck plus the closest existing characterization tests.
6. Commit before crossing a high-risk authority boundary.

After the last family, the host retains WebSocket plugin/transport setup, publisher construction,
connection context creation, family factory composition, parser/router invocation, the common
unexpected-error boundary, close wiring, and lifecycle assembly only. An architecture test will
reject a client-message switch or family-specific state/logic returning to that host.

## HTTP extraction

| Family | Schemas/body/helper ownership after extraction |
| --- | --- |
| system | health/readiness response construction and bounded readiness helpers |
| world | lookup schema, cancellation signal usage, lookup handler/error mapping |
| flags | flag schemas, quote/list/environment/territory/create/delete/rename handlers and flag refresh helpers |
| collectibles | collectible/water schemas and resource handlers |
| players | player/inventory/color schemas, actor checks, and handlers |
| diagnostics | trace schemas, authorization/audit adapters, metrics/database/spawn handlers |
| Population V2 (historical) | unchanged in `populationZonesV2RolloutRoutes.ts` at Wave 2B; module subsequently removed |

Each route-family factory receives only its required services plus the already-created admission
aware Fastify façade. Common auth/origin/CSRF and `HttpAdmissionController` hooks are installed once
in `registerRoutes.ts`. Route methods/paths, registration order, policy keys, cancellation signals,
status codes, payloads, and messages remain unchanged. The compatibility host will contain only
dependency adaptation, admission installation, family registration, and Population V2 composition.

## Enforcement and verification

- Strengthen the architecture scan so the compatibility hosts cannot regain Zod schemas, domain
  switches, family state, or inline route bodies.
- Preserve exhaustive 125-client-family, 134-server-delivery, and 38-route-policy checks.
- Add focused state-owner tests only where mutable state physically moves and existing tests do not
  already exercise cleanup/bounds.
- Run family-focused tests and server typecheck after each extraction group.
- At completion run the accepted Wave 2 matrix: all unit and PostgreSQL suites, all package
  typechecks, lint, architecture/policy, production build/verify/hygiene, focused transport tests,
  exact migration hashes/count, bundle comparison, runtime health/readiness/reconnect smoke, and
  `git diff --check`.

Commits remain small and reviewable. The final branch is pushed and stops for review; no merge,
checkpoint, promotion, deployment, production mutation, or World repository change is authorized.
