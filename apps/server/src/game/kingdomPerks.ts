import {
  BRICKS_ITEM_ID,
  GLIMMER_OIL_ITEM_ID,
  KINGDOM_PERK_ACTIVATION_COOLDOWN_MS,
  KINGDOM_PERK_BUFF_DURATION_MS,
  KINGDOM_PERK_CHANGE_COST,
  KINGDOM_PERK_SKYWARD_STONEWORK_RADIUS_M,
  KINGDOM_PERK_CHOOSE_COST,
  KINGDOM_PERK_FORWARD_SAPPERS_ATTACK_BONUS,
  KINGDOM_PERK_GILDED_TRIM_BONUS_PER_OBELISK_LEVEL,
  KINGDOM_OBELISK_RADIUS_M,
  KINGDOM_PERK_RESERVED_GAME_GOLD_BONUS,
  KINGDOM_PERK_CARAVAN_GUILD_DROP_CHANCE_MULTIPLIER,
  KINGDOM_PERK_WARDED_MONUMENTS_RADIUS_M,
  KINGDOM_PERK_WARDED_MONUMENTS_REDUCTION_PER_OBELISK_LEVEL,
  KINGDOM_PERK_BRACED_FOUNDATIONS_REDUCTION,
  KINGDOM_PERKS,
  isKingdomPerkId,
  type KingdomPerkActivateInput,
  type KingdomPerkChooseInput,
  type KingdomPerkId,
  type KingdomPerkLevel,
  type KingdomPerkSelectionSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import { KingdomBrickEconomyError } from "./kingdomBrickEconomy.js";
import {
  insertKingdomAuditEvent,
  lockKingdomTreasuryBalance,
  moveKingdomTreasuryInTransaction
} from "./kingdomTreasuryLedger.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/** The leader inside a kingdom mutation: player, kingdom and membership rows already locked. */
export type KingdomPerkActor = Readonly<{ playerId: string; kingdomId: string; kingdomLevel: number }>;

type SelectionRow = {
  perk_level: number;
  perk_id: string;
  selected_at: Date | string;
  activated_at: Date | string | null;
  active_until: Date | string | null;
};

/**
 * The perks in effect for a kingdom's chosen selections: every chosen
 * passive perk, plus an activated (level 6) perk only while its 24 h buff
 * runs.
 */
export function effectiveKingdomPerkIds(
  rows: ReadonlyArray<Pick<SelectionRow, "perk_id" | "active_until">>,
  now: Date
): Set<KingdomPerkId> {
  const ids = new Set<KingdomPerkId>();
  for (const row of rows) {
    if (!isKingdomPerkId(row.perk_id)) continue;
    if (KINGDOM_PERKS[row.perk_id].activated) {
      if (row.active_until === null || new Date(row.active_until).getTime() <= now.getTime()) continue;
    }
    ids.add(row.perk_id);
  }
  return ids;
}

/**
 * The perks a member enjoys right now: none until the membership passed its
 * qualification period (the same gate the attack / defense bonus always had).
 * Read-only; safe inside any transaction.
 */
export async function kingdomPerksForPlayer(
  queryable: Queryable,
  playerId: string,
  now: Date = new Date()
): Promise<{ kingdomId: string; perkIds: Set<KingdomPerkId> } | null> {
  const result = await queryable.query<{
    kingdom_id: string;
    qualified: boolean;
    perk_id: string | null;
    active_until: Date | string | null;
  }>(
    `SELECT m.kingdom_id::text, m.perk_qualified_at <= $2::timestamptz AS qualified,
            s.perk_id, s.active_until
     FROM kingdom_memberships m
     JOIN kingdoms k ON k.id = m.kingdom_id AND k.status = 'active'
     LEFT JOIN kingdom_perk_selections_in_effect s ON s.kingdom_id = m.kingdom_id
     WHERE m.player_id = $1 AND m.status = 'active'`,
    [playerId, now]
  );
  const first = result.rows[0];
  if (!first) return null;
  if (!first.qualified) return { kingdomId: first.kingdom_id, perkIds: new Set() };
  return {
    kingdomId: first.kingdom_id,
    perkIds: effectiveKingdomPerkIds(
      result.rows.filter((row): row is typeof row & { perk_id: string } => row.perk_id !== null),
      now
    )
  };
}

/** True when the player's kingdom currently grants `perkId` to them. */
export async function playerHasKingdomPerk(
  queryable: Queryable,
  playerId: string | null | undefined,
  perkId: KingdomPerkId,
  now?: Date
): Promise<boolean> {
  if (!playerId) return false;
  return (await kingdomPerksForPlayer(queryable, playerId, now))?.perkIds.has(perkId) ?? false;
}

/**
 * True when the kingdom has `perkId` in effect (an activated perk only while
 * its buff runs). Structure hooks use it: e.g. a War Tower volley adds
 * KINGDOM_PERK_FORWARD_SAPPERS_ATTACK_BONUS when its kingdom has
 * "forward_sappers".
 */
export async function kingdomHasPerk(
  queryable: Queryable,
  kingdomId: string | null | undefined,
  perkId: KingdomPerkId,
  now: Date = new Date()
): Promise<boolean> {
  if (!kingdomId) return false;
  const result = await queryable.query<{ perk_id: string; active_until: Date | string | null }>(
    "SELECT perk_id, active_until FROM kingdom_perk_selections_in_effect WHERE kingdom_id = $1::uuid AND perk_id = $2",
    [kingdomId, perkId]
  );
  return effectiveKingdomPerkIds(result.rows, now).has(perkId);
}

/**
 * The Watchfires: true when the attacker's kingdom has its buff running and
 * is at war with the kingdom of the unit's owner. Read-only.
 */
export async function watchfiresDelayRecovery(
  queryable: Queryable,
  attackerPlayerId: string,
  unitOwnerPlayerId: string,
  now: Date = new Date()
): Promise<boolean> {
  if (!(await playerHasKingdomPerk(queryable, attackerPlayerId, "the_watchfires", now))) return false;
  const result = await queryable.query<{ at_war: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM kingdom_memberships attacker
       JOIN kingdom_memberships owner ON owner.player_id = $2 AND owner.status = 'active'
       JOIN organization_wars war ON war.status = 'active'
        AND ((war.side_a_kind = 'kingdom' AND war.side_a_id = attacker.kingdom_id
              AND war.side_b_kind = 'kingdom' AND war.side_b_id = owner.kingdom_id)
          OR (war.side_b_kind = 'kingdom' AND war.side_b_id = attacker.kingdom_id
              AND war.side_a_kind = 'kingdom' AND war.side_a_id = owner.kingdom_id))
       WHERE attacker.player_id = $1 AND attacker.status = 'active'
     ) AS at_war`,
    [attackerPlayerId, unitOwnerPlayerId]
  );
  return result.rows[0]?.at_war === true;
}

/**
 * TowerVolleyHooks.warTowerAttackBonus: each kingdom's War Tower attack bonus,
 * KINGDOM_PERK_FORWARD_SAPPERS_ATTACK_BONUS with Forward Sappers, else 0.
 */
export async function forwardSappersWarTowerBonus(
  queryable: Queryable,
  kingdomIds: readonly string[],
  now: Date = new Date()
): Promise<Map<string, number>> {
  const entries = await Promise.all(kingdomIds.map(async (kingdomId) => [
    kingdomId,
    (await kingdomHasPerk(queryable, kingdomId, "forward_sappers", now))
      ? KINGDOM_PERK_FORWARD_SAPPERS_ATTACK_BONUS
      : 0
  ] as const));
  return new Map(entries);
}

export async function loadKingdomPerkSelections(
  queryable: Queryable,
  kingdomId: string,
  now: Date
): Promise<KingdomPerkSelectionSnapshot[]> {
  const result = await queryable.query<SelectionRow>(
    `SELECT perk_level, perk_id, selected_at, activated_at, active_until
     FROM kingdom_perk_selections WHERE kingdom_id = $1 ORDER BY perk_level`,
    [kingdomId]
  );
  return result.rows.filter((row) => isKingdomPerkId(row.perk_id)).map((row) => {
    const activeUntil = row.active_until === null ? null : new Date(row.active_until);
    const nextActivation = row.activated_at === null
      ? null
      : new Date(new Date(row.activated_at).getTime() + KINGDOM_PERK_ACTIVATION_COOLDOWN_MS);
    return {
      level: Number(row.perk_level) as KingdomPerkLevel,
      perkId: row.perk_id as KingdomPerkId,
      selectedAt: new Date(row.selected_at).toISOString(),
      activeUntil: activeUntil && activeUntil.getTime() > now.getTime() ? activeUntil.toISOString() : null,
      nextActivationAt: nextActivation && nextActivation.getTime() > now.getTime() ? nextActivation.toISOString() : null
    };
  });
}

/**
 * Flat per-hit damage reduction a kingdom's perks give one of its
 * structures: Braced Foundations (-8 on a Kingdom Tower) plus Warded Monuments
 * (-4 per level of the kingdom's strongest standing obelisk
 * within 550 m, the obelisk itself included). 0 for any other structure.
 */
export async function kingdomStructureDamageReduction(queryable: Queryable, flagId: string): Promise<number> {
  const result = await queryable.query<{ reinforced: boolean; obelisk_level: number | null }>(
    `SELECT
       (f.tower_level IS NOT NULL AND f.control_type = 'kingdom' AND EXISTS (
         SELECT 1 FROM kingdom_perk_selections_in_effect perk
         WHERE perk.kingdom_id = f.kingdom_id AND perk.perk_id = 'braced_foundations'
       )) AS reinforced,
       CASE WHEN EXISTS (
         SELECT 1 FROM kingdom_perk_selections_in_effect perk
         WHERE perk.kingdom_id = f.kingdom_id AND perk.perk_id = 'warded_monuments'
       ) THEN (
         SELECT max(obelisk.obelisk_level) FROM flags obelisk
         WHERE obelisk.kingdom_id = f.kingdom_id
           AND obelisk.obelisk_level IS NOT NULL
           AND obelisk.health > 0
           AND obelisk.territory_collapse_id IS NULL
           AND ST_DWithin(obelisk.geom::geography, f.geom::geography, $2)
       ) END AS obelisk_level
     FROM flags f
     WHERE f.id = $1::uuid AND f.kingdom_id IS NOT NULL AND f.control_type IN ('kingdom', 'kingdom_seat')`,
    [flagId, KINGDOM_PERK_WARDED_MONUMENTS_RADIUS_M]
  );
  const row = result.rows[0];
  if (!row) return 0;
  return (row.reinforced ? KINGDOM_PERK_BRACED_FOUNDATIONS_REDUCTION : 0) +
    Number(row.obelisk_level ?? 0) * KINGDOM_PERK_WARDED_MONUMENTS_REDUCTION_PER_OBELISK_LEVEL;
}

/** A reduced hit still lands for at least 1, so no structure becomes immune. */
export function reducedStructureHit(damage: number, reduction: number): number {
  if (damage <= 0) return 0;
  return Math.max(1, Math.round(damage) - Math.max(0, reduction));
}

export type KingdomHuntingPerks = Readonly<{ goldMultiplier: number; dropChanceMultiplier: number }>;
export const NO_KINGDOM_HUNTING_PERKS: KingdomHuntingPerks = Object.freeze({ goldMultiplier: 1, dropChanceMultiplier: 1 });

/**
 * Kill-reward perks of the hunter's kingdom (qualified members only):
 *  - Reserved Game: +6% gold on the kingdom's own connected land (the claim
 *    of one of its standing Kingdom Flags or its Castle);
 *  - Gilded Trim: +0.6% gold per level of the kingdom's strongest standing
 *    obelisk whose radius covers the kill;
 *  - Caravan Guild (while its 24 h buff runs): item drop chances x1.2.
 * The land lookups run only for a kingdom holding a gold perk. Read-only.
 */
export async function kingdomHuntingPerksAt(
  queryable: Queryable,
  playerId: string,
  position: Readonly<{ lat: number; lon: number }> | null,
  now: Date = new Date()
): Promise<KingdomHuntingPerks> {
  const perks = await kingdomPerksForPlayer(queryable, playerId, now);
  if (!perks || perks.perkIds.size === 0) return NO_KINGDOM_HUNTING_PERKS;
  const dropChanceMultiplier = perks.perkIds.has("caravan_guild") ? KINGDOM_PERK_CARAVAN_GUILD_DROP_CHANCE_MULTIPLIER : 1;
  const hunting = perks.perkIds.has("reserved_game");
  const trim = perks.perkIds.has("gilded_trim");
  if ((!hunting && !trim) || !position || !Number.isFinite(position.lat) || !Number.isFinite(position.lon)) {
    return { goldMultiplier: 1, dropChanceMultiplier };
  }
  const result = await queryable.query<{ on_land: boolean; obelisk_level: number | null }>(
    `WITH point AS (SELECT ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography AS g)
     SELECT
       ($4::boolean AND EXISTS (
         SELECT 1 FROM flags f
         LEFT JOIN kingdom_seats seat
           ON f.control_type = 'kingdom_seat' AND seat.source_flag_id = f.id AND seat.status = 'active'
         WHERE f.kingdom_id = $1::uuid
           AND f.control_type IN ('kingdom', 'kingdom_seat')
           AND f.territory_collapse_id IS NULL
           AND ST_DWithin(COALESCE(seat.geom, f.geom)::geography, point.g,
                          COALESCE(seat.territory_radius_m, f.claim_radius_m))
       )) AS on_land,
       CASE WHEN $5::boolean THEN (
         SELECT max(obelisk.obelisk_level) FROM flags obelisk
         WHERE obelisk.kingdom_id = $1::uuid
           AND obelisk.obelisk_level IS NOT NULL
           AND obelisk.health > 0
           AND obelisk.territory_collapse_id IS NULL
           AND ST_DWithin(obelisk.geom::geography, point.g, $6)
       ) END AS obelisk_level
     FROM point`,
    [perks.kingdomId, position.lat, position.lon, hunting, trim,
      perks.perkIds.has("skyward_stonework") ? KINGDOM_PERK_SKYWARD_STONEWORK_RADIUS_M : KINGDOM_OBELISK_RADIUS_M]
  );
  const row = result.rows[0];
  const goldMultiplier = 1 +
    (row?.on_land ? KINGDOM_PERK_RESERVED_GAME_GOLD_BONUS : 0) +
    Number(row?.obelisk_level ?? 0) * KINGDOM_PERK_GILDED_TRIM_BONUS_PER_OBELISK_LEVEL;
  return { goldMultiplier, dropChanceMultiplier };
}

async function lockSelection(client: Queryable, kingdomId: string, level: number): Promise<SelectionRow | null> {
  const result = await client.query<SelectionRow>(
    `SELECT perk_level, perk_id, selected_at, activated_at, active_until
     FROM kingdom_perk_selections WHERE kingdom_id = $1 AND perk_level = $2 FOR UPDATE`,
    [kingdomId, level]
  );
  return result.rows[0] ?? null;
}

/**
 * Chooses (empty level) or changes (another perk chosen) the perk of one
 * level, paying from the treasury. Runs inside the kingdom mutation, whose
 * request row makes a replay return the first answer; the operation row and
 * the treasury ledger are keyed by the same request as a second guard.
 */
export async function chooseKingdomPerkInTransaction(
  client: Queryable,
  actor: KingdomPerkActor,
  input: KingdomPerkChooseInput
): Promise<{ perkId: KingdomPerkId; level: number; action: "choose" | "change"; bricks: number; glimmerOil: number }> {
  const definition = KINGDOM_PERKS[input.perkId];
  if (actor.kingdomLevel < definition.level) {
    throw new KingdomBrickEconomyError(
      "KINGDOM_PERK_LOCKED",
      `${definition.displayName} unlocks at kingdom level ${definition.level}`
    );
  }
  const current = await lockSelection(client, actor.kingdomId, definition.level);
  const currentPerkId = current && isKingdomPerkId(current.perk_id) ? current.perk_id : null;
  if (currentPerkId === input.perkId) {
    throw new KingdomBrickEconomyError("KINGDOM_PERK_ALREADY_CHOSEN", `${definition.displayName} is already chosen`);
  }
  if (currentPerkId !== input.expectedCurrentPerkId) {
    throw new KingdomBrickEconomyError(
      "KINGDOM_PERK_STATE_CHANGED",
      "This level's perk changed; check the new choice and its price",
      { currentPerkId }
    );
  }
  const action = currentPerkId === null ? "choose" : "change";
  const cost = action === "choose" ? KINGDOM_PERK_CHOOSE_COST : KINGDOM_PERK_CHANGE_COST;
  const bricks = await lockKingdomTreasuryBalance(client, actor.kingdomId, BRICKS_ITEM_ID);
  const glimmerOil = await lockKingdomTreasuryBalance(client, actor.kingdomId, GLIMMER_OIL_ITEM_ID);
  if (bricks < cost.bricks || glimmerOil < cost.glimmerOil) {
    throw new KingdomBrickEconomyError(
      "KINGDOM_PERK_INSUFFICIENT_TREASURY",
      `The treasury needs ${cost.bricks.toLocaleString("en-US")} Bricks and ${cost.glimmerOil.toLocaleString("en-US")} Glimmer Oil`,
      { bricks, glimmerOil, requiredBricks: cost.bricks, requiredGlimmerOil: cost.glimmerOil }
    );
  }
  const operationKey = `kingdom-perk:${actor.playerId}:${input.requestId}`;
  const sourceType = action === "choose" ? "kingdom_perk_choose" : "kingdom_perk_change";
  const metadata = { perkId: input.perkId, level: definition.level, previousPerkId: currentPerkId };
  for (const [resourceType, quantity] of [[BRICKS_ITEM_ID, cost.bricks], [GLIMMER_OIL_ITEM_ID, cost.glimmerOil]] as const) {
    const moved = await moveKingdomTreasuryInTransaction(client, {
      kingdomId: actor.kingdomId,
      actorPlayerId: actor.playerId,
      resourceType,
      direction: "debit",
      quantity,
      sourceType,
      operationKey,
      metadata
    });
    if (!moved) throw new Error("Kingdom perk debit failed after the balance check");
  }
  // A change ends a running buff but keeps the activation cooldown.
  await client.query(
    `INSERT INTO kingdom_perk_selections (kingdom_id, perk_level, perk_id, selected_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (kingdom_id, perk_level) DO UPDATE
       SET perk_id = EXCLUDED.perk_id, selected_at = now(), updated_at = now(), active_until = NULL`,
    [actor.kingdomId, definition.level, input.perkId]
  );
  await client.query(
    `INSERT INTO kingdom_perk_operations (
       operation_key, kingdom_id, player_id, action, perk_level, perk_id, previous_perk_id,
       bricks_quantity, glimmer_oil_quantity
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [operationKey, actor.kingdomId, actor.playerId, action, definition.level, input.perkId, currentPerkId,
      cost.bricks, cost.glimmerOil]
  );
  await insertKingdomAuditEvent(client, {
    kingdomId: actor.kingdomId,
    actorPlayerId: actor.playerId,
    eventType: action === "choose" ? "kingdom_perk_chosen" : "kingdom_perk_changed",
    entityType: "kingdom_perk",
    metadata: { ...metadata, bricks: cost.bricks, glimmerOil: cost.glimmerOil }
  });
  return { perkId: input.perkId, level: definition.level, action, bricks: cost.bricks, glimmerOil: cost.glimmerOil };
}

/** Starts the chosen level 6 perk's 24 h member buff; once per 24 h per kingdom. */
export async function activateKingdomPerkInTransaction(
  client: Queryable,
  actor: KingdomPerkActor,
  input: KingdomPerkActivateInput,
  now: Date
): Promise<{ perkId: KingdomPerkId; activeUntil: string }> {
  const definition = KINGDOM_PERKS[input.perkId];
  if (!definition.activated) {
    throw new KingdomBrickEconomyError("KINGDOM_PERK_NOT_ACTIVATED", `${definition.displayName} is always on`);
  }
  const current = await lockSelection(client, actor.kingdomId, definition.level);
  if (!current || current.perk_id !== input.perkId) {
    throw new KingdomBrickEconomyError(
      "KINGDOM_PERK_STATE_CHANGED",
      `Choose ${definition.displayName} before activating it`
    );
  }
  if (current.activated_at !== null) {
    const readyAt = new Date(current.activated_at).getTime() + KINGDOM_PERK_ACTIVATION_COOLDOWN_MS;
    if (now.getTime() < readyAt) {
      throw new KingdomBrickEconomyError(
        "KINGDOM_PERK_ACTIVATION_COOLDOWN",
        "The kingdom buff can be activated once every 24 hours",
        { nextActivationAt: new Date(readyAt).toISOString() }
      );
    }
  }
  const activeUntil = new Date(now.getTime() + KINGDOM_PERK_BUFF_DURATION_MS);
  await client.query(
    `UPDATE kingdom_perk_selections SET activated_at = $3, active_until = $4, updated_at = now()
     WHERE kingdom_id = $1 AND perk_level = $2`,
    [actor.kingdomId, definition.level, now, activeUntil]
  );
  await client.query(
    `INSERT INTO kingdom_perk_operations (
       operation_key, kingdom_id, player_id, action, perk_level, perk_id, bricks_quantity, glimmer_oil_quantity
     ) VALUES ($1,$2,$3,'activate',$4,$5,0,0)`,
    [`kingdom-perk:${actor.playerId}:${input.requestId}`, actor.kingdomId, actor.playerId, definition.level, input.perkId]
  );
  await insertKingdomAuditEvent(client, {
    kingdomId: actor.kingdomId,
    actorPlayerId: actor.playerId,
    eventType: "kingdom_perk_activated",
    entityType: "kingdom_perk",
    metadata: { perkId: input.perkId, activeUntil: activeUntil.toISOString() }
  });
  return { perkId: input.perkId, activeUntil: activeUntil.toISOString() };
}
