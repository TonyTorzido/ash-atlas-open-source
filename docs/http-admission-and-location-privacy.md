# HTTP admission and player-location privacy

Authenticated gameplay HTTP uses two explicit admission classes. Standard player and inventory reads
have independent identity and network rate windows plus bounded concurrency. World API proxies,
PostGIS-backed flag and territory reads, collectible visibility, water interaction, and flag placement
use the stricter expensive class. Fastify's configured trusted-proxy policy determines `request.ip`;
forwarding headers are not interpreted by this layer directly.

Each class has a fixed active-worker limit, bounded pending queue, and queue timeout. Rate or capacity
rejections return HTTP 429, a stable error code, and `Retry-After`. `/health` exposes accepted,
rejected, active, queued, current queue depth, timed-out, and completed request metrics. Development
routes are deliberately outside this production policy and retain their existing production-forbidden
gates.

`GET /api/players/:id` returns an exact runtime or durable snapshot only for the authenticated player
whose ID was requested. Explicitly enabled non-production developer tooling retains exact access.
Other authenticated players receive public identity, display color, region, coarse zone, and update
time only. `GET /api/players/online` returns only the aggregate count, revision, and
observation time; it has no per-player results and cannot be used as a global coordinate,
movement-anchor, target, or leash-radius feed. Interest-managed WebSocket replication remains the
authority for legitimate nearby player visibility.
