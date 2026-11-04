# Production readiness

`GET /health` is a diagnostic liveness endpoint. It remains HTTP 200 while the process can answer
and reports runtime identity plus current admission, WebSocket, Market, combat-reward, and resource
job metrics. It must not be used to admit authoritative gameplay traffic.

`GET /ready` is the traffic-admission boundary. It returns HTTP 200 only when all mandatory checks
are healthy and HTTP 503 with `status: "not_ready"` otherwise. The checks are:

- the PostgreSQL connection;
- a live World API health verification matching the required release and fingerprints;
- immutable game runtime label, branch, and SHA (test mode alone may be explicitly unpinned);
- Market reconciliation freshness and protection state;
- the durable combat-reward queue and its periodic retry supervisor;
- durable resource-vision status plus the local worker snapshot.

Development degraded-world mode permits startup for diagnosis, but `/ready` remains HTTP 503 until
world authority verifies. Production launchers should set `RUNTIME_LABEL`, `RUNTIME_BRANCH`, and
`RUNTIME_SHA`; missing runtime identity also keeps readiness closed. Combat reward retries run every
`COMBAT_REWARD_RETRY_INTERVAL_MS` (1,000 ms by default), coalesce with an in-flight pass, and stop and
drain before the database pool closes.
