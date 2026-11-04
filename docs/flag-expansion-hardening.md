# Flag expansion and movement hardening

The main Ash Atlas runtime includes the completed flag expansion and movement hardening architecture. The main launcher uses the retained `ash_atlas_game` database and treats the World API at `http://127.0.0.1:8765` as an optional separate service.

The implementation corrects jump-overlay anchoring and expands the authoritative world-space radii while preserving server authority, map performance, and multiplayer isolation.

The former expansion values in this historical hardening note were superseded by the ordinary flag radius contract. Ordinary flags now use a 500 m claim, 600 m movement leash, 650 m certified Resource Vision, and a separate 750 m preparation area. These server-owned meter values do not change the flag marker's pixel size or click hitbox. See [ordinary-flag-radius-contract.md](ordinary-flag-radius-contract.md).

The owning client uses immediate bounded anticipation while the server remains authoritative. The local lead ceiling is `playerSpeedMps * 2 / serverTickHz`, which is 12.5m at the default 125 m/s and 20 Hz tuning. Remote players use independent 150ms buffered interpolation, so remote jitter cannot pause local movement. Request IDs, generations, movement revisions, and replication sequences make stale acknowledgements harmless. Explicit flag visits, city visits, respawns, dev teleports, anchor changes, region changes, and zone changes snap immediately.

Client-side leash validation rejects non-finite or definitely outside-leash targets before sending or anticipating them. That rejection does not cancel an existing valid move. The server independently validates every request, and rejecting a new outside-leash target does not mutate position, target, moving state, or movement revision.

The server advances the world with a monotonic, drift-compensated fixed-step scheduler at 20 Hz. Catch-up is bounded to four steps, excessively old backlog is dropped, callbacks do not overlap, and shutdown stops the scheduler before persistence and service cleanup.

Migration `0602_expand_flag_claim_and_movement_radii.sql` updates existing flag claims and player leashes and invalidates stale Resource Vision status radii. It follows the current main migration sequence and is safe through the idempotent migration runner.

Default development tuning is `PLAYER_SPEED_MPS=125`, `SERVER_TICK_HZ=20`, `WORLD_DELTA_HZ=20`, and `COMBAT_DELTA_HZ=10`.
