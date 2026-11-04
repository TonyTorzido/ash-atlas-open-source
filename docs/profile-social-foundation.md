# Profile and social foundation

Player profiles use the immutable authenticated `players.id`; they do not create another account or
identity layer. Public profile DTOs contain the display name, progression level, current player-sprite
representation, optional title and biography, online state, nullable class/kingdom/settlement slots,
and viewer-relative relationship state. They never contain account identities, email, session/device
data, coordinates, precise last-seen time, another player's enemy marks, or who blocked the viewer.

`ProfileAffiliationsResolver` is the integration boundary for the class, kingdom, and settlement
systems. The default resolver returns null for all three. Those future systems remain authoritative;
`player_profiles` stores only profile-owned text.

Friendships use one low/high row per unordered player pair. Pending requests remain directional.
Enemy marks and blocks are private, one-sided rows. Every two-player mutation takes the same
transaction-scoped advisory pair lock before reading or changing state. Unique keys, no-self checks,
canonical database ordering, row locks on pending requests, and idempotent inserts/deletes provide a
second line of protection against retries and cross-tab/concurrent races. Blocking atomically removes
friendship and requests. Marking a friend as an enemy atomically removes the friendship and pending
requests before inserting the private mark.

The server exposes authenticated HTTP endpoints under `/api/profile` and `/api/social`. Request
bodies are strict shared schemas and never accept an acting player ID. Lists are bounded to 50 rows
per request (25 by default). The service also exposes `canDirectlyInteract` so messaging, trade,
party, kingdom, and settlement invitations can consult the same block policy later.

Server limits use authenticated player IDs as their primary key. Defaults are:

- Profile lookup: 120/minute
- Profile edit: 10/10 minutes
- Aggregate relationship mutations: 120/10 minutes
- Friend request send: 20/10 minutes
- Other friend-request/friend state changes: 60/10 minutes
- Enemy mark changes: 30/10 minutes
- Block changes: 30/10 minutes
- Social lists: 60/minute

These are configurable with the `PROFILE_*`, `SOCIAL_*`, `FRIEND_*`, `ENEMY_MARK_RATE_MAX`, and
`BLOCK_RATE_MAX` variables in `.env.example`.

Profile/social route limits run in Fastify's `preHandler` phase, after the authentication guard has
resolved the immutable session-owned player. They do not use body, query, or header identity. The
Fastify local rate store and the action-specific gate are process-local; the action gate removes
expired buckets during traffic and caps retained keys at 50,000. A multi-instance deployment must
replace both stores with a shared bounded limiter (for example Redis) to enforce a global quota.

Online status comes from the in-process authoritative WebSocket connection registry. It is accurate
for this server instance. A multi-instance deployment will need a shared presence adapter before
claiming distributed online/offline accuracy. No last-seen timestamp is exposed or added by this
feature. The player-facing online roster is delivered only through the authenticated gameplay
WebSocket, uses that same five-minute authoritative gameplay activity definition, and exposes only
player ID and display name. It remains single-instance, keeps one player per account, and orders
players by their most recent gameplay connection rather than ordinary activity; it exposes no
connection or activity timestamps.
