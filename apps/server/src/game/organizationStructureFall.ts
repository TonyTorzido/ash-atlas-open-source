import type pg from "pg";

import { clearAndPruneCityFlags, lockCityFlagNetwork } from "./cities.js";
import { lockFlagControlGeometry } from "./flagControlGeometry.js";
import { clearAndPruneKingdomFlags, lockKingdomFlagNetwork } from "./kingdoms.js";
import { ruinFallenCastle } from "./kingdomCastleRubble.js";
import { breakTerritoryFlagsInTransaction, type TerritoryCollapseBegun } from "./territoryCollapse.js";

export type OrganizationFallCollapser = Readonly<{
  begin(input: Readonly<{
    kind: "city" | "kingdom";
    id: string;
    reason: string;
    actorPlayerId?: string | null;
  }>): Promise<TerritoryCollapseBegun | null>;
}>;

export type OrganizationFallResult = Readonly<{
  /** Ordinary city / kingdom flags broken (target plus the flags it alone connected). */
  brokenFlagIds: string[];
  /** Territory collapses started because a City Center fell (or a stray seat of an ended kingdom). */
  collapses: TerritoryCollapseBegun[];
  /** Castles that fell to rubble this pass, with the members to notify. */
  ruinedCastles: Array<Readonly<{ kingdomId: string; flagId: string; notifyPlayerIds: string[] }>>;
  /** Rows that threw this pass; the caller logs them and the next tick retries. */
  failures: Array<Readonly<{ flagId: string; error: unknown }>>;
}>;

type FallenRow = {
  id: string;
  control_type: "city" | "city_seat" | "kingdom" | "kingdom_seat";
  city_id: string | null;
  kingdom_id: string | null;
};

/**
 * Settles city and kingdom structures that burned out or were destroyed.
 *
 * Damage and burn transactions only leave a durable zero-health marker on
 * these rows: breaking them needs the organization network advisory lock
 * before the flag-control geometry lock, which those transactions cannot take
 * in order. This sweep runs in its own transactions, in the canonical order
 * (network -> warfare operations -> geometry -> flag row), and is idempotent:
 *  - a City Center at zero health ends its city and starts the territory
 *    collapse wave (TerritoryCollapseService.begin);
 *  - a Castle at zero health becomes rubble (ruinFallenCastle): the kingdom
 *    keeps its territory until the leader rebuilds or disbands it. A seat
 *    already in rubble is not selected again;
 *  - an ordinary City Flag or Kingdom Flag at zero health breaks, along with
 *    every flag it alone connected to the seat network (the collapse branch's
 *    disconnect rule in clearAndPrune*Flags).
 */
export async function settleFallenOrganizationStructures(
  pool: pg.Pool,
  collapser: OrganizationFallCollapser,
  limit = 20
): Promise<OrganizationFallResult> {
  // A War Tower / Outpost also falls when the war it is tied to has ended.
  const fallen = await pool.query<FallenRow>(
    `SELECT id::text, control_type, city_id::text, kingdom_id::text
     FROM flags
     WHERE (health = 0 OR (war_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM organization_wars war WHERE war.war_id = flags.war_id AND war.status = 'ended'
       )))
       AND control_type IN ('city','city_seat','kingdom','kingdom_seat')
       AND territory_collapse_id IS NULL
       AND NOT system_controlled
       AND NOT (control_type = 'kingdom_seat' AND EXISTS (
         SELECT 1 FROM kingdoms kingdom
         WHERE kingdom.id = flags.kingdom_id AND kingdom.status = 'active' AND kingdom.castle_ruined_at IS NOT NULL
       ))
     ORDER BY (control_type IN ('city_seat','kingdom_seat')) DESC, id
     LIMIT $1`,
    [Math.max(1, Math.min(200, Math.trunc(limit)))]
  );
  const brokenFlagIds: string[] = [];
  const collapses: TerritoryCollapseBegun[] = [];
  const ruinedCastles: OrganizationFallResult["ruinedCastles"] = [];
  const failures: Array<Readonly<{ flagId: string; error: unknown }>> = [];
  const handledOrganizations = new Set<string>();
  for (const row of fallen.rows) {
    const kind = row.city_id ? "city" : "kingdom";
    const organizationId = (row.city_id ?? row.kingdom_id)!;
    const key = `${kind}:${organizationId}`;
    if (handledOrganizations.has(key)) continue;
    // One row that cannot settle right now (e.g. its city is mid-lifecycle
    // change) must not stall every other fallen structure behind it.
    try {
      if (row.control_type === "kingdom_seat") {
        handledOrganizations.add(key);
        const ruin = await ruinFallenCastle(pool, { kingdomId: organizationId, seatFlagId: row.id });
        if (ruin.status === "ruined") {
          ruinedCastles.push({ kingdomId: organizationId, flagId: row.id, notifyPlayerIds: ruin.notifyPlayerIds });
        }
        // Only a seat whose kingdom already ended falls through to the stray-seat cleanup below.
        if (ruin.status !== "inactive") continue;
      }
      if (row.control_type === "city_seat" || row.control_type === "kingdom_seat") {
        handledOrganizations.add(key);
        const begun = await collapser.begin({
          kind,
          id: organizationId,
          reason: kind === "city" ? "city_center_destroyed" : "castle_destroyed",
          actorPlayerId: null
        });
        if (begun) {
          collapses.push(begun);
        } else {
          // The organization already ended without marking this seat (legacy
          // row): break the stray seat directly so the sweep cannot spin on it.
          brokenFlagIds.push(...await breakStrayFallenFlag(pool, row.id));
        }
        continue;
      }
      brokenFlagIds.push(...await breakFallenOrganizationFlag(pool, row));
    } catch (error) {
      failures.push({ flagId: row.id, error });
    }
  }
  return { brokenFlagIds, collapses, ruinedCastles, failures };
}

async function breakFallenOrganizationFlag(pool: pg.Pool, row: FallenRow): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (row.city_id) await lockCityFlagNetwork(client, row.city_id);
    else await lockKingdomFlagNetwork(client, row.kingdom_id!);
    for (const table of ["flag_repair_disrupt_operations", "flag_repair_operations", "flag_burn_operations"]) {
      await client.query(
        `SELECT operation_id FROM ${table}
         WHERE flag_id=$1::uuid AND status='active'
         ORDER BY operation_id
         FOR UPDATE`,
        [row.id]
      );
    }
    await lockFlagControlGeometry(client);
    const locked = await client.query<{
      health: number | null; city_id: string | null; kingdom_id: string | null; war_ended: boolean;
    }>(
      `SELECT health, city_id::text, kingdom_id::text,
              EXISTS (SELECT 1 FROM organization_wars war
                      WHERE war.war_id = flags.war_id AND war.status = 'ended') AS war_ended
       FROM flags
       WHERE id=$1::uuid AND territory_collapse_id IS NULL
       FOR UPDATE`,
      [row.id]
    );
    const current = locked.rows[0];
    if (!current || (Number(current.health) !== 0 && !current.war_ended) ||
        current.city_id !== row.city_id || current.kingdom_id !== row.kingdom_id) {
      await client.query("ROLLBACK");
      return [];
    }
    await client.query("SET CONSTRAINTS flags_mixed_control_geometry DEFERRED");
    const reason = Number(current.health) !== 0 && current.war_ended ? "war_ended" : "structure_destroyed";
    const pruned = row.city_id
      ? await clearAndPruneCityFlags(client, row.city_id, [row.id], null, reason, "flag_deleted")
      : await clearAndPruneKingdomFlags(
        client, row.kingdom_id!, [row.id], null, reason, null, "flag_deleted"
      );
    const broken = await breakTerritoryFlagsInTransaction(client, [row.id]);
    await client.query("COMMIT");
    return [...new Set([...broken.map(({ id }) => id), ...pruned.affectedFlagIds])];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function breakStrayFallenFlag(pool: pg.Pool, flagId: string): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockFlagControlGeometry(client);
    const locked = await client.query(
      "SELECT 1 FROM flags WHERE id=$1::uuid AND health=0 AND territory_collapse_id IS NULL FOR UPDATE",
      [flagId]
    );
    if (locked.rowCount !== 1) {
      await client.query("ROLLBACK");
      return [];
    }
    await client.query("SET CONSTRAINTS flags_mixed_control_geometry DEFERRED");
    const broken = await breakTerritoryFlagsInTransaction(client, [flagId]);
    await client.query("COMMIT");
    return broken.map(({ id }) => id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
