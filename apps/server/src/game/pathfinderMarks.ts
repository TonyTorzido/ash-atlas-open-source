import { PATHFINDER_MARK_DURATION_MS, UTILITY_GEAR, type WorldMapDestination } from "@ash-atlas/shared";
import type pg from "pg";

import type { FlagAccessService } from "./flagAccess.js";
import { spendUtilityGearUseInTransaction } from "./utilityGear.js";

/** A building this close to an existing travel destination is that destination. */
const SAME_DESTINATION_RADIUS_M = 3;

export class PathfinderMarkError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PathfinderMarkError";
  }
}

export type PathfinderMarkResult = Readonly<{
  replayed: boolean;
  flagId: string;
  name: string;
  expiresAt: string;
  usesRemaining: number;
}>;

type FlagRow = { id: string; owner_id: string; name: string | null; lat: number; lon: number; anchor_kind: string };

function metersBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * Pathfinder Boot: one marked building at a time, added to the player's travel destinations for
 * 31 hours. The mark is server state; the World Map list and the jump both read it, and neither
 * accepts it once expires_at has passed.
 */
export class PathfinderMarkService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly access: Pick<FlagAccessService, "authorize">,
    /** The player's current travel destinations, without any pathfinder mark. */
    private readonly destinations: (playerId: string) => Promise<readonly Pick<WorldMapDestination, "lat" | "lon">[]>,
    private readonly afterUse: (playerId: string) => Promise<void>,
    private readonly now: () => Date = () => new Date()
  ) {}

  async mark(playerId: string, requestId: string, flagId: string): Promise<PathfinderMarkResult> {
    if (!playerId || !requestId || requestId.length > 128) {
      throw new PathfinderMarkError("PATHFINDER_MARK_INVALID", "Invalid mark request.");
    }
    const flagRows = await this.pool.query<FlagRow>(
      "SELECT id::text, owner_id, name, lat, lon, anchor_kind FROM flags WHERE id = $1",
      [flagId]
    );
    const flag = flagRows.rows[0];
    if (!flag || flag.anchor_kind === "buoy") {
      throw new PathfinderMarkError("PATHFINDER_MARK_NOT_FOUND", "That building cannot be marked.");
    }
    const place = { lat: Number(flag.lat), lon: Number(flag.lon) };
    const authorization = await this.access.authorize(flagId, playerId);
    if (!authorization.decision.allowed) {
      throw new PathfinderMarkError("PATHFINDER_MARK_NOT_ALLOWED", "You cannot visit that building.");
    }
    if (authorization.decision.tollGold !== "0") {
      throw new PathfinderMarkError("PATHFINDER_MARK_TOLL", "A building that charges a toll cannot be marked.");
    }
    const known = await this.destinations(playerId);
    if (flag.owner_id === playerId || known.some((entry) => metersBetween(place, entry) <= SAME_DESTINATION_RADIUS_M)) {
      throw new PathfinderMarkError("PATHFINDER_MARK_ALREADY_DESTINATION", "That building is already a travel destination.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`pathfinder-mark:${playerId}`]);
      const ledger = await client.query(
        `INSERT INTO player_pathfinder_mark_requests (player_id, request_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING request_id`,
        [playerId, requestId]
      );
      if (ledger.rowCount === 0) {
        const current = await client.query<{ flag_id: string; name: string; expires_at: Date; uses: number | null }>(
          `SELECT mark.flag_id::text, mark.name, mark.expires_at,
                  (SELECT uses_remaining FROM equipment_instances
                    WHERE owner_player_id = $1 AND location = 'equipped' AND definition_id = 'pathfinder_boot' LIMIT 1) AS uses
             FROM player_pathfinder_marks mark WHERE mark.player_id = $1`,
          [playerId]
        );
        await client.query("COMMIT");
        const row = current.rows[0];
        if (!row) throw new PathfinderMarkError("PATHFINDER_MARK_NOT_FOUND", "That mark was replaced.");
        return { replayed: true, flagId: row.flag_id, name: row.name, expiresAt: row.expires_at.toISOString(), usesRemaining: Number(row.uses ?? 0) };
      }
      const spent = await spendUtilityGearUseInTransaction(client, playerId, "pathfinder_boot");
      if (!spent) {
        throw new PathfinderMarkError("PATHFINDER_MARK_NO_BOOT", `Wear an ${UTILITY_GEAR.pathfinder_boot.displayName} with uses left.`);
      }
      const name = flag.name?.trim() || "Marked building";
      const expiresAt = new Date(this.now().getTime() + PATHFINDER_MARK_DURATION_MS);
      await client.query(
        `INSERT INTO player_pathfinder_marks (player_id, flag_id, name, lat, lon, request_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (player_id) DO UPDATE SET flag_id = EXCLUDED.flag_id, name = EXCLUDED.name,
           lat = EXCLUDED.lat, lon = EXCLUDED.lon, request_id = EXCLUDED.request_id,
           expires_at = EXCLUDED.expires_at, created_at = now()`,
        [playerId, flagId, name, place.lat, place.lon, requestId, expiresAt]
      );
      await client.query("COMMIT");
      await this.afterUse(playerId).catch(() => undefined);
      return { replayed: false, flagId, name, expiresAt: expiresAt.toISOString(), usesRemaining: spent.remaining };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
