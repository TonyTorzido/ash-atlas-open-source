# Kingdom Foundation

This document defines the first Ash Atlas Kingdom foundation: a persistent social organization tied
to one independently persisted physical Kingdom Seat. It describes the authority boundaries,
storage model, public contracts, supported limits, and deliberately deferred systems. It is an
architecture and implementation reference, not a runtime-validation report.

## Scope and core boundary

A Kingdom is an organization. Its name, description, emblem metadata, founder, current leader,
memberships, permissions, private chat, treasury, contribution history, level, perks, and lifecycle
remain valid independently of its physical home.

A Kingdom Seat is that organization's physical home. The seat owns its authoritative WGS84
position, territory radius, World API snapshot, versioned environmental modifiers, construction
state, and lifecycle. A future relocation or archival operation can replace the active seat without
deleting the Kingdom or its financial and social history.

The foundation deliberately keeps these affiliations independent:

- A player may have at most one active Kingdom membership.
- A player may not simultaneously have an active Kingdom membership and an active City membership.
- A Kingdom Seat may be inside or outside an authoritative real-world settlement or Ash Atlas City.
- Kingdom territory does not annex flags, alter flag ownership, change City affiliation, or claim a
  canonical settlement identity.

## Authority model

The game server owns every durable decision. Authenticated session identity selects the actor, and
the connected `GameState` player record supplies the current position. Founding, cot placement, and
decoration placement requests do not carry latitude or longitude. Rotation and selection inputs are
advisory inputs that the server validates.

Durable mutations use request IDs, database transactions, row/advisory locks where shared state is
at risk, PostgreSQL uniqueness constraints, and stored replay results. Process-local state is not the
sole protection for membership, capacity, inventory, name, spacing, leadership, or ledger
invariants.

The client never supplies authoritative membership, role, permission, inventory balance, treasury
balance, XP, perk entitlement, environmental classification, placement result, or construction
policy.

## Founding and placement

An authenticated connected player may found a Kingdom when all of these conditions hold:

- The player has no active Kingdom membership.
- The normalized name is valid and not already used.
- The World API resolves the server-side player position to active coverage.
- The point has `is_land=true`, `is_saltwater=false`, and `inside_major_lake=false`.
- Its territory does not overlap another active Kingdom territory.
- Its seat satisfies `KINGDOM_MIN_SEAT_SPACING_M` relative to other active seats.
- The same request has not already completed with different input.

Founding requires a completed, personally controlled source flag and rejects an active City
membership. The source flag remains the territorial anchor; the validated current player position
may be used for the physical Seat. The organization, active seat, leader membership, source-flag
affiliation, and eligible overlapping founder-flag absorption are committed atomically.
Database uniqueness backs case-insensitive normalized names and founder/request replay protection.

Names are trimmed, normalized to lower case, limited to 3-40 characters, and restricted to
alphanumeric words separated by a single space, underscore, or hyphen. Display names, optional
descriptions (up to 500 characters), and optional emblem keys (up to 80 characters) are stored
separately from the normalized unique name.

## World and environment authority

Founding uses the existing World API `GET /api/lookup?lat=...&lon=...` through the server-side
`WorldLookupClient`. It does not infer terrain from the map, read raw GIS files, copy world polygons
or rasters into the gameplay database, or require the settlement endpoint.

The World lookup is fail-closed for founding. A timeout, transport error, non-healthy World service,
inactive/out-of-coverage package, malformed response, or unknown land classification rejects the
founding operation. Existing Kingdom records, membership, chat, treasury, progression, cots, and
decorations do not depend on a new World lookup and remain usable while the World service is
offline.

The seat stores a compact snapshot rather than duplicating geodata. Available fields include:

- terrain class, biome, ecoregion, elevation, and nullable slope;
- land, saltwater, and major-lake classification;
- World release ID/version, package ID, environment schema version, and source versions;
- the game-owned environment-rules version and lookup timestamp.

The current World contract does not provide slope at every point. Nullable slope/elevation-band
fields remain null when unavailable; the game does not invent GIS values. The server records its own
lookup timestamp. The World release/schema version describes source authority, while the separate
Kingdom environment-rules version describes gameplay interpretation.

## Environmental modifiers and versioning

Environmental modifiers belong to `kingdom_seats`, not `kingdoms`. The framework can classify
mountain/high-elevation, forest, plains, desert, and unknown/neutral profiles. Each stored modifier
has a stable key, label, value/unit, whether it is currently applied, and an optional future-system
label.

Only modifiers tied to a current construction quote may affect current results. Future defense,
fire vulnerability, natural-defense, water-upkeep, or similar traits are descriptive metadata and
must remain marked unapplied until those systems exist. Unknown environments are neutral.

Rules are versioned. A seat retains the modifier set and rules version used when it was created;
deploying new rules does not silently recalculate old seats. Recalculation requires an explicit
migration or future refresh policy.

## Free-construction testing policy

`KINGDOMS_FREE_CONSTRUCTION` is a server-owned policy. The Kingdoms launcher explicitly sets it to
`true` for isolated development. Development defaults to free construction when the variable is
omitted; production defaults to false and configuration validation rejects an explicit production
value of true.

The quote path still calculates and returns intended resource costs, construction time, adjusted
cost/time, and environmental modifiers. In free mode, supported founding and placement operations
consume no resources, finish immediately, and record
`completed_under_free_construction=true`. Clients can display the policy but cannot enable it.

Paid construction is deliberately fail-safe in this foundation: when free construction is off,
founding and construction mutations reject until an authoritative treasury-spend/material-consume
path is implemented. They never fall back to accidentally free production construction.

The current economy has no gold or general currency balance. Treasury donations support existing
stackable resource items from the authoritative inventory catalog. Advancement projects use only
their versioned canonical wood, stone, leather, and balsam-resin requirements; no fake gold item or
unsupported material identifier is introduced.

## Membership and invitations

Invitations and memberships have separate histories. Invitation states are `pending`, `accepted`,
`declined`, `cancelled`, `expired`, and `revoked`. Membership states are `active`, `left`, `removed`,
and `banned`; invitation is not a membership state.

Invitations expire after `KINGDOM_INVITATION_TTL_HOURS` (72 by default). Creation rejects a target
with an active City membership without exposing City details. Acceptance transactionally
revalidates City membership, target, ban state, Kingdom lifecycle, member capacity, and the target's
lack of another active Kingdom membership. City membership creation likewise rejects an active
Kingdom member. A partial unique index allows at most one active Kingdom membership per player, so
simultaneous acceptance in different Kingdoms can produce at most one winner.

Supported member actions are invite, accept, decline, cancel invitation, leave, remove, ban, unban,
promote, demote, and transfer leadership. The leader cannot leave, be removed, or be demoted until
leadership is transferred. Leadership transfer updates the organization and both membership roles
atomically; founder history never changes.

Leaving, removal, banning, and dissolution end active membership immediately. They also revoke
private chat/permissions and archive or pack dependent personal objects according to lifecycle
policy.

## Roles and permissions

Authorization is expressed through reusable permission categories rather than handler-specific role
name checks.

| Role | Permission shape |
| --- | --- |
| Leader | All Kingdom permissions, including leadership transfer, perks, and dissolution |
| Officer | Invite/cancel, remove/ban, manage roles, mute chat, manage identity/cots/decorations, and view detailed treasury history |
| Member | Normal membership access and permitted personal decoration placement |

Permission categories include invitations, removal/ban, role management, chat mute, identity,
cots, placement/movement/removal of personal and Kingdom-owned decorations, detailed treasury
history, perks, leadership transfer, and dissolution. Target hierarchy checks prevent officers from
acting on the leader or granting authority above their own.

## Private Kingdom chat

Durable Kingdom mutations use authenticated HTTP; live private chat and push notifications use the
existing gameplay WebSocket.

- Client send: `KINGDOM_CHAT_SEND`
- Client state refresh: `REQUEST_KINGDOM_STATE`
- Server delivery: `KINGDOM_CHAT_MESSAGE`
- Private snapshot: `KINGDOM_STATE`
- Invalidation notification: `KINGDOM_STATE_CHANGED`

The server derives sender identity and rechecks active membership on every send. Blank content is
rejected, messages are limited to 500 characters, IDs are stable UUIDs, and request IDs prevent
duplicate insertion. The default rate limit is eight messages per ten seconds, configured by
`KINGDOM_CHAT_RATE_MAX` and `KINGDOM_CHAT_RATE_WINDOW_SECONDS`. Officer/leader mutes are persisted.

Initial history is newest-first in storage and returned as a bounded recent window. Delivery is
limited to active members of that Kingdom. Membership changes invalidate affected private state so
removed, banned, departed, or switched players cannot continue sending or receiving the old
channel. Message content is carried as text and must be rendered as text by the client; no session,
authentication, block-list, or private location data belongs in chat payloads.

## Treasury, donations, and XP ledger

The treasury stores per-Kingdom totals by existing item definition and variant. Donations are
member-to-Kingdom transfers; there is no direct member withdrawal operation in this foundation.

Donation handling locks the active membership, player inventory row, Kingdom, and treasury balance
inside one transaction. It validates a positive integer quantity and available inventory, then
atomically decrements the player balance, increments the treasury balance, and appends a donation
entry with `kingdom_xp_granted=0`. The ledger stores donor, resource/variant, quantity, player and
treasury before/after balances, XP granted, timestamp, and request ID. Unique request constraints
make replays non-duplicating and row locks prevent concurrent overspend.

Members receive aggregate treasury totals. Detailed donation history is available only with
`view_treasury_ledger`. The same permission gates bounded project expenditure/refund history with
immutable before/after balances. Public Kingdom DTOs contain no balances or financial history.

Kingdom XP is append-only in `kingdom_xp_ledger`, with source, actor, request ID, before/after XP,
before/after level, definition version, and metadata. Advancement-project completion is the current
XP source. Donations, chat, reconnect, and client-claimed activity do not grant XP.

## Levels and perks

Level definitions are centralized and versioned (`KINGDOM_LEVEL_DEFINITION_VERSION=1`).

| Level | Lifetime XP | Members | Cots | Decoration capacity | Perk unlock |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 0 | 10 | 10 | 25 | None |
| 2 | 250 | 15 | 15 | 35 | +1 defense |
| 3 | 750 | 20 | 20 | 50 | +1 defense |
| 4 | 1,500 | 30 | 30 | 70 | +1 defense, +1 attack |
| 5 | 3,000 | 40 | 40 | 100 | +1 defense, +1 attack |

Only the next-level advancement project may be active. Project costs and base durations are:

| Target | Project | Cost | Base duration |
| ---: | --- | --- | ---: |
| 2 | Raise the Standard | 150 wood, 100 stone, 50 leather | 10 minutes |
| 3 | Fortify the Seat | 300 wood, 250 stone, 100 leather, 50 balsam resin | 20 minutes |
| 4 | Build the Great Hall | 600 wood, 500 stone, 200 leather, 100 balsam resin | 30 minutes |
| 5 | Crown the Realm | 1,000 wood, 800 stone, 350 leather, 200 balsam resin | 60 minutes |

Starting atomically debits the fixed treasury cost and records immutable project and expenditure
snapshots. Completion grants only the XP needed to reach the target threshold and updates the
authoritative Kingdom row. Builder speed may shorten duration, but environment discounts do not
alter project cost. Leader-authorized cancellation refunds the full snapshotted cost exactly once.
Higher retained legacy levels and XP remain valid and require no retroactive project.

Future building unlock strings are metadata, not implemented building trees. Perk resolution derives
from one active membership, current Kingdom level, and `perk_qualified_at`; the client cannot submit
bonuses. Qualification defaults to 60 seconds in development and 86,400 seconds in production via
`KINGDOM_PERK_QUALIFICATION_SECONDS`. Leaving, removal, banning, or dissolution removes entitlement,
and reconnect cannot stack it.

The resolver exposes one `KingdomStatModifiers` result containing Kingdom ID, attack/defense bonus,
unlocked perk IDs, and qualification state. The server feeds it into the existing authoritative PvE
stat resolver; it does not define a second combat-stat system. PvP remains standardized and does not
inherit Kingdom attack/defense perks.

## Seat territory and bounded visibility

The active seat is a WGS84/PostGIS point whose persisted anchor territory comes from the founding
source flag. Kingdom levels never resize that anchor or a personal flag claim. Territorial
expansion is the server-authoritative connected Kingdom Flag network.
`KINGDOM_MIN_SEAT_SPACING_M` defaults to 650 m.

Public nearby snapshots contain only public identity, level/member count, seat position, territory,
and environment summary. A separate bounded `nearbyObjects` DTO exposes only object ID, Kingdom ID,
kind/type, display name, position, and rotation for nearby active cots/decorations. It deliberately
omits personal owner, placer, completion-policy, and other member-only fields. Queries use PostGIS
distance predicates and hard limits:

- `KINGDOM_SNAPSHOT_RADIUS_M=25000`
- `KINGDOM_SNAPSHOT_LIMIT=100`
- `KINGDOM_OBJECT_SNAPSHOT_LIMIT=250`

The map client renders nearby seat markers, circular territory geometry, Kingdom name/level, and
nearby active cots/decorations. It does not receive every Kingdom object globally.

Spatial mutations return authoritative previous and final public entities from inside the mutation
transaction. Each affected row receives a durable monotonic revision from
`kingdom_spatial_revision_seq`. The server sends one bounded, critical
`KINGDOM_SPATIAL_CHANGES` batch per mutation and affected connection according to that recipient's
own interest radius. Moves remove the entity from old-only viewers and upsert it for new or
continuing viewers. The client tracks revisions and removal tombstones by stable entity identity,
rejects stale or duplicate changes, and uses newer player-centered snapshots to repair missed state.
Batches contain no roster, chat, treasury, ownership, request, moderation, or permission data and
never rebuild a recipient's private Kingdom state.

## Cots

Each active member may have one active personal cot. Placement uses the actor's server position,
must lie inside the current active territory after accounting for its footprint, and must not
overlap the seat, another cot, or an active decoration. Capacity comes from the current Kingdom
level. The database partial unique index and transactional capacity/collision checks protect
simultaneous placement.

Cots are personal social-space objects only. They do not grant respawn, healing, storage, banking,
rent, fast travel, or combat bonuses. `POST /api/kingdom/cot/action` supports authoritative `move`
and `pack` actions. Moving uses the actor's current server position and reruns territory/collision
validation; packing archives the active placement state. The cot owner or a member with
`manage_cots` may act, and both operations append an audit event. Leaving/removal packs the member's
active cot; dissolution archives active cots.

## Decorations

The starter catalog is data-driven and mirrored into `kingdom_decoration_definitions`:

| Type | Ownership | Level | Capacity | Placement |
| --- | --- | ---: | ---: | --- |
| Banner | Personal or Kingdom | 1 | 1 | Members |
| Campfire | Personal or Kingdom | 1 | 2 | Members |
| Table | Personal | 1 | 2 | Members |
| Supply Crate | Personal or Kingdom | 1 | 1 | Members |
| Training Post | Kingdom | 3 | 3 | Officers/leaders |

Definitions include footprint, future material metadata, intended construction time, role rules,
and catalog rules version. Placement/movement uses the actor's authoritative current position,
validates territory, seat/object collision, role, level, ownership mode, and capacity, and records
the free-construction flag. Personal and Kingdom-owned objects remain distinct. Move/remove checks
personal ownership or the corresponding management permission and records audit events. Lifecycle
operations pack/archive objects instead of transferring or hard-deleting ownership history.

## Public, member-only, and profile data

Public Kingdom data is limited to display name, description, emblem key, founder/current leader,
level, member count, lifecycle status, active seat/territory, and environment summary.
Founder and current-leader player IDs are intentionally public profile references so nearby clients
can open the same public player profiles exposed elsewhere; they are not authentication identifiers
and do not grant access to member-only data.

Member state may add the roster, invitations relevant to the actor, recent chat, treasury totals,
permission-gated donation and expenditure history, progression/perks, the active advancement
project, safe bounded activity summaries, cots, decorations, catalog, free-construction status, and
qualification period. It never includes sessions, authentication data, raw replay records, block
relationships, internal moderation notes, request IDs, or unrelated player coordinates.

Profile affiliation is derived from the authoritative active `kingdom_memberships` row and returned
independently of City affiliation. The public profile shape contains Kingdom ID/name, emblem, and
appropriate member role only; no chat or treasury data is joined into a profile.

## Lifecycle

Kingdom lifecycle states are active, dissolved, and archived. Seat states are active, archived, and
relocating; construction is separately under construction or complete.

Dissolution requires the leader permission and explicit request. In one transaction it cancels and
fully refunds any pending advancement project, marks the organization dissolved, ends active
memberships, revokes pending invitations, clears active chat access, archives the active seat, cots,
and decorations, and retains audit, project, financial, XP, and chat history. It does not
hard-delete the organization or simulate enemy destruction.

## Persistence and migration allocation

Kingdom migrations own the `0400-0499` range. The initial schema is
`db/migrations/0400_kingdom_foundation.sql` and creates:

- `kingdoms` and `kingdom_seats`;
- `kingdom_memberships` and `kingdom_invitations`;
- `kingdom_chat_messages` and `kingdom_chat_mutes`;
- `kingdom_treasury_balances`, `kingdom_donations`, and `kingdom_xp_ledger`;
- `kingdom_cots`, `kingdom_decoration_definitions`, and `kingdom_decorations`;
- `kingdom_requests` for durable replay records;
- `kingdom_audit_events` for lifecycle and moderation history.

Foreign keys retain social and financial history. Partial unique indexes enforce one active
membership per player, one active leader and seat per Kingdom, one active cot per player, and one
pending invitation per Kingdom/player pair. GiST indexes bound active seat/cot/decoration spatial
queries. Ledger, history, membership, and lifecycle indexes support bounded reads.

`db/migrations/0401_kingdom_ledger_immutability.sql` hardens financial and moderation history at the
database boundary. `BEFORE UPDATE OR DELETE` triggers reject mutation of `kingdom_donations`,
`kingdom_xp_ledger`, and `kingdom_audit_events`, making their append-only contract independent of
application code.

`db/migrations/0699_kingdom_advancement_projects.sql` adds advancement project lifecycle storage
and the append-only treasury expenditure/refund ledger. It preserves all existing Kingdom levels,
XP, donations, treasury balances, Seats, Flags, and memberships.

## HTTP and WebSocket surface

Authenticated, CSRF-protected HTTP endpoints own durable state reads and mutations:

- `GET /api/kingdom/state`
- `POST /api/kingdom/found`
- `POST /api/kingdom/invite`
- `POST /api/kingdom/invitation/respond`
- `POST /api/kingdom/invitation/cancel`
- `POST /api/kingdom/member/action`
- `POST /api/kingdom/leave`
- `POST /api/kingdom/identity`
- `POST /api/kingdom/mute`
- `POST /api/kingdom/donate`
- `POST /api/kingdom/project/start`
- `POST /api/kingdom/project/cancel`
- `POST /api/kingdom/cot`
- `POST /api/kingdom/cot/action`
- `POST /api/kingdom/decoration`
- `POST /api/kingdom/decoration/action`
- `POST /api/kingdom/dissolve`

The WebSocket carries private chat plus state snapshots/invalidation. HTTP placement bodies omit
coordinates; state is reloaded after server confirmation instead of permanently applying optimistic
mutations.

## Local launcher and configuration

The feature-specific Kingdoms launcher was retired after integration. Use `Run Ash Atlas.cmd` from
the permanent protected checkout for the integrated behavior. New isolated feature work must use a
purpose-named disposable database and repository-local tooling without adding a root launcher.

Kingdom configuration:

| Variable | Development default | Purpose |
| --- | ---: | --- |
| `KINGDOMS_FREE_CONSTRUCTION` | `true` | Central construction/testing policy; forbidden in production |
| `KINGDOM_INITIAL_TERRITORY_RADIUS_M` | `200` | Legacy parsed setting; the founding source-flag radius is authoritative |
| `KINGDOM_MIN_SEAT_SPACING_M` | `650` | Minimum active-seat spacing |
| `KINGDOM_SNAPSHOT_RADIUS_M` | `25000` | Nearby public query radius |
| `KINGDOM_SNAPSHOT_LIMIT` | `100` | Maximum nearby Kingdoms |
| `KINGDOM_OBJECT_SNAPSHOT_LIMIT` | `250` | Maximum nearby seat objects |
| `KINGDOM_INVITATION_TTL_HOURS` | `72` | Invitation lifetime |
| `KINGDOM_PERK_QUALIFICATION_SECONDS` | `60` | Development membership-age gate; production default is 86400 |
| `KINGDOM_CHAT_HISTORY_LIMIT` | `100` | Messages returned in a private state snapshot |
| `KINGDOM_CHAT_RETENTION_LIMIT` | `500` | Durable messages retained per Kingdom |
| `KINGDOM_DONATION_HISTORY_LIMIT` | `100` | Ledger entries returned to authorized viewers |
| `KINGDOM_CHAT_RATE_MAX` | `8` | Messages allowed per rate window |
| `KINGDOM_CHAT_RATE_WINDOW_SECONDS` | `10` | Chat rate window |
| `KINGDOM_MUTATION_RATE_MAX` | `30` | Expensive HTTP mutations allowed per window |
| `KINGDOM_MUTATION_RATE_WINDOW_SECONDS` | `10` | HTTP mutation rate window |
| `KINGDOM_FOUNDING_QUOTE_RATE_MAX` | `10` | Founding quotes allowed per mutation window |
| `KINGDOM_SEAT_SPACING_BUFFER_M` | `50` | Extra authoritative seat-spacing buffer |
| `KINGDOM_SEAT_FOOTPRINT_RADIUS_M` | `10` | Seat collision footprint |
| `KINGDOM_COT_FOOTPRINT_RADIUS_M` | `2.5` | Cot collision footprint |
| `KINGDOM_REPLAY_RETENTION_DAYS` | `30` | Durable idempotency receipt retention |

Chat request replay rows retain only `kingdomId` and the stable `messageId`; message content and
recipient lists exist only in the bounded chat table. Other replay receipts are pruned lazily after
the configured retention period when that actor next performs a mutation. The actor-and-created-at
retention index keeps this cleanup bounded to the current actor.

Committed mutations return `state: null` with `stateRefreshRequired: true` if post-commit state
reconstruction fails. The client retains its current snapshot, reports that the action completed,
and requests an authoritative WebSocket refresh. Private state reads compare membership ID,
Kingdom ID, and role at emission; one bounded retry rebuilds role-gated data after a transition.

## Integration expectations

Kingdoms is based on `feature/progression-foundation`. It must not merge or cherry-pick the isolated
Classes branch. If Classes lands in the integration foundation first, refresh Kingdoms from that
updated integration history and resolve the generic stat-modifier boundary there. Perform final
integration through a temporary audited branch; do not merge this feature directly into `master` or
renumber its `0400-0499` migrations.

The World pipeline remains a separate repository and authority. Kingdom implementation must not
modify it merely to accommodate gameplay, and must not add world polygons/rasters to the game
database.

## Explicitly deferred

The following are outside this foundation:

- wars;
- sieges;
- tower attacks;
- flag burning;
- Kingdom destruction by enemies;
- diplomacy;
- alliances;
- vassals;
- Kingdom trading;
- taxes;
- full building trees;
- respawn at cots;
- fast travel;
- territory conquest;
- Kingdom-versus-Kingdom ranking;
- seasonal Kingdom competition.

Also deferred are enemy-caused abandonment, direct treasury withdrawal, a general gold/currency
system, voice/global/alliance/war chat, cot healing/storage/rent, and full construction or siege
defense simulation. Future features must build on the durable organization/seat separation rather
than collapsing it.
