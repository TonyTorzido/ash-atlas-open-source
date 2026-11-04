import {
  CHALLENGERS_LANTERN_CHARGES,
  CHALLENGERS_LANTERN_ITEM_ID,
  CHALLENGERS_LANTERN_LUMEN_COST,
  LAMP_SHEATH_ITEM_ID,
  LUMEN_ITEM_ID,
  CINDER_LANTERN_CHARGES,
  CINDER_LANTERN_CRYSTAL_COST,
  CINDER_LANTERN_ITEM_ID,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import type { InventoryService } from "./inventory.js";

export class CinderLanternError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CinderLanternError";
  }
}

type Queryable = Pick<pg.PoolClient, "query">;
type LanternInventory = Pick<InventoryService, "grantItemsForOperationInTransaction" | "debitItemsForOperationInTransaction">;
type Transaction = <T>(work: (client: pg.PoolClient) => Promise<T>) => Promise<T>;

export type CinderLanternDeps = Readonly<{
  pool: Pick<pg.Pool, "query">;
  inventory: LanternInventory;
  transaction: Transaction;
}>;

export type CinderLanternCraftResult = Readonly<{
  replayed: boolean;
  charges: number;
  inventory: PlayerInventorySnapshot;
}>;

export type LanternKind = "cinder" | "challenger";
const LANTERN_KINDS: readonly LanternKind[] = ["cinder", "challenger"];
const LANTERN_ITEM_ID = {
  cinder: CINDER_LANTERN_ITEM_ID,
  challenger: CHALLENGERS_LANTERN_ITEM_ID
} as const;

const CARRIED_LANTERN_SQL = `SELECT 1 FROM player_inventory
  WHERE player_id=$1 AND resource_type=$2 AND variant='default' AND quantity>0`;

/** Whether the player is inside a dungeon run they entered on a lantern charge (monster drops tripled). */
export async function cinderLanternDoublesDrops(queryable: Queryable, playerId: string): Promise<boolean> {
  const result = await queryable.query(
    `SELECT 1 FROM dungeon_presence presence
       JOIN cinder_lantern_runs run
         ON run.player_id=presence.player_id AND run.run_id=presence.run_id::text
      WHERE presence.player_id=$1 AND run.kind='cinder'`,
    [playerId]
  );
  return (result.rowCount ?? 0) > 0;
}

const challengerRuns = new Map<string, string>();
const entryChoice = new Map<string, LanternKind>();

/**
 * Cinder Lantern (Lamp Sheath + 3,400 Crystal, 9 charges). Entering a dungeon whose entry
 * cost would be a torch spends one charge instead, and monster drops are tripled for the player for
 * that run. At 0 charges the item is destroyed. Charges live in `cinder_lanterns`; the item in
 * the pack is what makes the lantern "carried".
 */
export class CinderLanternService {
  constructor(private readonly deps: CinderLanternDeps) {}

  /** True when the player carries a lantern with a charge left (read-only preview of the entry). */
  async hasCharge(playerId: string): Promise<boolean> {
    const result = await this.deps.pool.query(
      `SELECT 1 FROM cinder_lanterns lantern
         JOIN player_inventory item
           ON item.player_id=lantern.player_id AND item.variant='default' AND item.quantity>0
          AND item.resource_type=CASE lantern.kind WHEN 'challenger' THEN $3 ELSE $2 END
        WHERE lantern.player_id=$1 AND lantern.charges>0`,
      [playerId, CINDER_LANTERN_ITEM_ID, CHALLENGERS_LANTERN_ITEM_ID]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async charges(playerId: string, kind: LanternKind = "cinder"): Promise<number> {
    const result = await this.deps.pool.query<{ charges: number }>(
      "SELECT charges FROM cinder_lanterns WHERE player_id=$1 AND kind=$2", [playerId, kind]
    );
    return Number(result.rows[0]?.charges ?? 0);
  }

  /** Kinds the player carries with a charge left. */
  async usableKinds(queryable: Pick<pg.Pool, "query">, playerId: string): Promise<LanternKind[]> {
    const result = await queryable.query<{ kind: LanternKind }>(
      `SELECT lantern.kind FROM cinder_lanterns lantern
         JOIN player_inventory item
           ON item.player_id=lantern.player_id AND item.variant='default' AND item.quantity>0
          AND item.resource_type=CASE lantern.kind WHEN 'challenger' THEN $3 ELSE $2 END
        WHERE lantern.player_id=$1 AND lantern.charges>0`,
      [playerId, CINDER_LANTERN_ITEM_ID, CHALLENGERS_LANTERN_ITEM_ID]
    );
    return LANTERN_KINDS.filter((kind) => result.rows.some((row) => row.kind === kind));
  }

  /** Validates and records the lantern the player picked for their next dungeon entry (null clears it). */
  async chooseEntryLantern(playerId: string, kind: LanternKind | null): Promise<void> {
    if (kind === null) { entryChoice.delete(playerId); return; }
    if (!(await this.usableKinds(this.deps.pool, playerId)).includes(kind)) {
      throw new CinderLanternError("LANTERN_UNAVAILABLE", "That lantern has no charges to spend.");
    }
    entryChoice.set(playerId, kind);
  }

  /**
   * Inside the dungeon entry transaction: spends one charge from exactly one lantern in place of the
   * entry cost. The only carried kind is used automatically; with both, the kind chosen on the portal
   * request is used (the Cinder's when none was chosen). Returns false (nothing changed) when no
   * lantern can pay, so the caller charges the torch. Replaying the same run never spends a second charge.
   */
  async useChargeForEntryInTransaction(client: Queryable, playerId: string, runId: string): Promise<boolean> {
    const already = await client.query(
      "SELECT 1 FROM cinder_lantern_runs WHERE player_id=$1 AND run_id=$2", [playerId, runId]
    );
    if ((already.rowCount ?? 0) > 0) return true;
    const usable = await this.usableKinds(client, playerId);
    if (usable.length === 0) return false;
    const chosen = entryChoice.get(playerId);
    const kind = usable.length === 1 ? usable[0]! : chosen && usable.includes(chosen) ? chosen : usable[0]!;
    const itemId = LANTERN_ITEM_ID[kind];
    const spent = await client.query<{ charges: number }>(
      `UPDATE cinder_lanterns SET charges=charges-1, updated_at=now()
        WHERE player_id=$1 AND kind=$2 AND charges>0 RETURNING charges`,
      [playerId, kind]
    );
    if (!spent.rows[0]) return false;
    entryChoice.delete(playerId);
    await client.query(
      "INSERT INTO cinder_lantern_runs (player_id, run_id, kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [playerId, runId, kind]
    );
    if (kind === "challenger") this.noteChallengerRun(playerId, runId);
    if (Number(spent.rows[0].charges) === 0) {
      await client.query("DELETE FROM cinder_lanterns WHERE player_id=$1 AND kind=$2", [playerId, kind]);
      await this.deps.inventory.debitItemsForOperationInTransaction(client as pg.PoolClient, {
        operationKey: `${kind === "challenger" ? "challengers" : "cinders"}-lantern-spent:${playerId}:${runId}`,
        playerId,
        source: kind === "challenger" ? "challengers_lantern_spent" : "cinder_lantern_spent",
        sourceEntityType: "dungeon_run",
        sourceEntityId: runId,
        debits: [{ itemId, variant: null, quantity: 1 }]
      });
    }
    return true;
  }

  /**
   * Synchronous read for the combat engine (no database access): whether the player's current
   * dungeon run was entered on a Challenger's Lantern. Filled at entry and by warmChallengerRun on restore.
   */
  challengerRunActive(playerId: string, runId: string | null): boolean {
    return runId !== null && challengerRuns.get(playerId) === runId;
  }

  /** Called after a charge is spent so the engine sees the run immediately. */
  noteChallengerRun(playerId: string, runId: string): void {
    challengerRuns.set(playerId, runId);
  }

  /** Loads the lantern kind of the player's persisted dungeon run (login, restart restore). */
  async warmChallengerRun(playerId: string): Promise<void> {
    const result = await this.deps.pool.query<{ run_id: string }>(
      `SELECT presence.run_id::text AS run_id FROM dungeon_presence presence
         JOIN cinder_lantern_runs run
           ON run.player_id=presence.player_id AND run.run_id=presence.run_id::text AND run.kind='challenger'
        WHERE presence.player_id=$1`,
      [playerId]
    );
    const runId = result.rows[0]?.run_id;
    if (runId) challengerRuns.set(playerId, runId); else challengerRuns.delete(playerId);
  }

  /**
   * Crafts a lantern from 1 Lamp Sheath plus 3,400 Crystal (Cinder's) or 24 Lumen (Challenger's).
   * One of each kind per player; the debit, the charge row and the item commit in one transaction
   * and replay-safe by request id.
   */
  async craft(playerId: string, requestId: string, kind: LanternKind = "cinder"): Promise<CinderLanternCraftResult> {
    if (!requestId) throw new CinderLanternError("LANTERN_BAD_REQUEST", "A request id is required");
    const challenger = kind === "challenger";
    const operation = `${challenger ? "challengers" : "cinders"}-lantern-craft:${playerId}:${requestId}`;
    const source = challenger ? "challengers_lantern_craft" : "cinder_lantern_craft";
    const itemId = LANTERN_ITEM_ID[kind];
    const charges = challenger ? CHALLENGERS_LANTERN_CHARGES : CINDER_LANTERN_CHARGES;
    return this.deps.transaction(async (client) => {
      const debited = await this.deps.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: operation,
        playerId,
        source,
        sourceEntityType: "cinder_lantern",
        sourceEntityId: playerId,
        debits: [
          { itemId: LAMP_SHEATH_ITEM_ID, variant: null, quantity: 1 },
          challenger
            ? { itemId: LUMEN_ITEM_ID, variant: null, quantity: CHALLENGERS_LANTERN_LUMEN_COST }
            : { itemId: "crystal", variant: null, quantity: CINDER_LANTERN_CRYSTAL_COST }
        ]
      });
      if (!debited.applied) {
        const existing = await client.query<{ charges: number }>(
          "SELECT charges FROM cinder_lanterns WHERE player_id=$1 AND kind=$2", [playerId, kind]
        );
        return { replayed: true, charges: Number(existing.rows[0]?.charges ?? 0), inventory: debited.inventory };
      }
      const created = await client.query(
        `INSERT INTO cinder_lanterns (player_id, kind, charges) VALUES ($1,$2,$3)
         ON CONFLICT (player_id, kind) DO NOTHING RETURNING player_id`,
        [playerId, kind, charges]
      );
      if ((created.rowCount ?? 0) === 0) {
        throw new CinderLanternError(
          "LANTERN_ALREADY_OWNED",
          challenger ? "You already carry a Challenger's Lantern." : "You already carry a Cinder Lantern."
        );
      }
      const granted = await this.deps.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `${operation}:item`,
        playerId,
        source,
        sourceEntityType: "cinder_lantern",
        sourceEntityId: playerId,
        grants: [{ itemId, variant: null, quantity: 1 }]
      });
      return { replayed: false, charges, inventory: granted.inventory };
    });
  }
}
