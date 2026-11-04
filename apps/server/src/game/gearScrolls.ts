import {
  LOADOUT_SCROLL_ITEM_ID,
  GEAR_SCROLL_SLOTS,
  isEquipmentDefinitionId,
  requireEquipmentDefinition,
  type GearScrollRememberedItem,
  type GearScrollSlot,
  type GearScrollsSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

type Queryable = Pick<pg.PoolClient, "query">;

export type GearScrollMemory = Partial<Record<GearScrollSlot, string>>;

/**
 * Carried Loadout Scrolls. Positions 1..count are usable; memory of a scroll on a market listing,
 * or waiting in market collections after the listing expired or was cancelled, waits beyond the
 * count. A scroll that leaves the player for good takes its memory with it: a commit-time database
 * trigger (migrations 1174 and 1175) prunes positions above the owned total. The 1174 header still
 * names Manor storage, but those tables reject writes since 0854; 1175 stops counting them.
 */
export async function carriedGearScrollCount(queryable: Queryable, playerId: string): Promise<number> {
  const result = await queryable.query<{ quantity: string }>(
    `SELECT COALESCE(SUM(quantity), 0)::text AS quantity
       FROM player_inventory WHERE player_id = $1 AND resource_type = $2`,
    [playerId, LOADOUT_SCROLL_ITEM_ID]
  );
  return Number(result.rows[0]?.quantity ?? 0);
}

export async function loadGearScrollMemory(
  queryable: Queryable,
  playerId: string,
  position: number
): Promise<GearScrollMemory> {
  const result = await queryable.query<{ equipment_slot: GearScrollSlot; instance_id: string }>(
    `SELECT equipment_slot, instance_id::text FROM player_gear_scroll_memory
      WHERE player_id = $1 AND scroll_position = $2`,
    [playerId, position]
  );
  const memory: GearScrollMemory = {};
  for (const row of result.rows) memory[row.equipment_slot] = row.instance_id;
  return memory;
}

/** Replaces the memory of the given slots: worn items are remembered, empty slots are forgotten. */
export async function writeGearScrollMemory(
  queryable: Queryable,
  playerId: string,
  position: number,
  slots: readonly GearScrollSlot[],
  memory: GearScrollMemory
): Promise<void> {
  await queryable.query(
    `DELETE FROM player_gear_scroll_memory
      WHERE player_id = $1 AND scroll_position = $2 AND equipment_slot = ANY($3::text[])`,
    [playerId, position, [...slots]]
  );
  const remembered = slots.filter((slot) => memory[slot]);
  if (remembered.length === 0) return;
  await queryable.query(
    `INSERT INTO player_gear_scroll_memory (player_id, scroll_position, equipment_slot, instance_id)
     SELECT $1, $2, remembered.slot, remembered.instance_id
       FROM unnest($3::text[], $4::uuid[]) AS remembered(slot, instance_id)`,
    [playerId, position, remembered, remembered.map((slot) => memory[slot]!)]
  );
}

export async function loadGearScrollsSnapshot(
  queryable: Queryable,
  playerId: string,
  lastEquippedPosition: number | null
): Promise<GearScrollsSnapshot> {
  const count = await carriedGearScrollCount(queryable, playerId);
  const result = await queryable.query<{
    scroll_position: number;
    equipment_slot: GearScrollSlot;
    instance_id: string;
    definition_id: string | null;
    carried: boolean;
  }>(
    `SELECT memory.scroll_position, memory.equipment_slot, memory.instance_id::text,
            instance.definition_id,
            (instance.owner_player_id = memory.player_id
              AND instance.location IN ('inventory', 'equipped')) AS carried
       FROM player_gear_scroll_memory memory
       LEFT JOIN equipment_instances instance ON instance.instance_id = memory.instance_id
      WHERE memory.player_id = $1 AND memory.scroll_position <= $2
      ORDER BY memory.scroll_position`,
    [playerId, count]
  );
  const byPosition = new Map<number, GearScrollRememberedItem[]>();
  for (const row of result.rows) {
    const definitionId = row.definition_id;
    const items = byPosition.get(row.scroll_position) ?? [];
    items.push({
      slot: row.equipment_slot,
      instanceId: row.instance_id,
      // A carried item shows its name; one that left the player is not described.
      definitionId: row.carried ? definitionId : null,
      displayName: row.carried && definitionId && isEquipmentDefinitionId(definitionId)
        ? requireEquipmentDefinition(definitionId).displayName
        : null,
      carried: row.carried === true
    });
    byPosition.set(row.scroll_position, items);
  }
  const scrolls = [];
  for (let position = 1; position <= count; position += 1) {
    const items = (byPosition.get(position) ?? [])
      .sort((left, right) => GEAR_SCROLL_SLOTS.indexOf(left.slot) - GEAR_SCROLL_SLOTS.indexOf(right.slot));
    scrolls.push({ position, items });
  }
  return {
    count,
    scrolls,
    lastEquippedPosition: lastEquippedPosition !== null && lastEquippedPosition <= count ? lastEquippedPosition : null
  };
}

export type GearScrollEquipOutcome =
  | Readonly<{ kind: "superseded"; requestId: string; position: number }>
  | Readonly<{
      kind: "applied";
      requestId: string;
      position: number;
      changed: boolean;
      equipped: number;
      skipped: number;
    }>;

type SwapJob = {
  position: number;
  requestId: string;
  resolve(outcome: GearScrollEquipOutcome): void;
  reject(error: unknown): void;
};

/**
 * Latest-wins swap queue per player: at most one swap runs; a request that arrives while one is
 * running replaces any request still waiting, and the replaced one resolves as superseded.
 */
export class GearScrollSwapQueue {
  private readonly queues = new Map<string, { running: boolean; next: SwapJob | null }>();

  submit(
    playerId: string,
    position: number,
    requestId: string,
    run: (position: number, requestId: string) => Promise<GearScrollEquipOutcome>
  ): Promise<GearScrollEquipOutcome> {
    return new Promise((resolve, reject) => {
      let queue = this.queues.get(playerId);
      if (!queue) {
        queue = { running: false, next: null };
        this.queues.set(playerId, queue);
      }
      const superseded = queue.next;
      queue.next = { position, requestId, resolve, reject };
      superseded?.resolve({ kind: "superseded", requestId: superseded.requestId, position: superseded.position });
      if (!queue.running) void this.pump(playerId, queue, run);
    });
  }

  private async pump(
    playerId: string,
    queue: { running: boolean; next: SwapJob | null },
    run: (position: number, requestId: string) => Promise<GearScrollEquipOutcome>
  ): Promise<void> {
    queue.running = true;
    while (queue.next) {
      const job = queue.next;
      queue.next = null;
      try {
        job.resolve(await run(job.position, job.requestId));
      } catch (error) {
        job.reject(error);
      }
    }
    queue.running = false;
    if (this.queues.get(playerId) === queue) this.queues.delete(playerId);
  }
}
