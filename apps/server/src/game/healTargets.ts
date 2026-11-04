import {
  DEFAULT_HEAL_TARGET_SETTINGS,
  healTargetSettingsUpdateSchema,
  type HealTargetSettings,
  type HealTargetSettingsUpdate
} from "@ash-atlas/shared";
import type pg from "pg";

import type { HolyArcPlayerRelations } from "./combat/combatEngine.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/*
 * The Cleric's holy arc (docs/plans/class-roster-v2.md 5): per-player heal-target settings, and the relations the
 * combat engine needs to decide who the arc may heal. The engine is synchronous and in memory, so a periodic sync
 * loads kingdom, city, friends and wars for every connected player in a few batched queries and pushes plain sets
 * into it; the engine never queries the database per shot (the Kingdom combat perk sync pattern).
 */

type SettingsRow = {
  player_id: string;
  heal_party: boolean;
  heal_friends: boolean;
  heal_kingdom: boolean;
  heal_city: boolean;
  heal_neutral: boolean;
};

export class HealTargetError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message);
    this.name = "HealTargetError";
  }
}

function settingsFromRow(row: SettingsRow | undefined): HealTargetSettings {
  if (!row) return DEFAULT_HEAL_TARGET_SETTINGS;
  return {
    party: row.heal_party,
    friends: row.heal_friends,
    kingdom: row.heal_kingdom,
    city: row.heal_city,
    neutral: row.heal_neutral
  };
}

export class HealTargetService {
  constructor(private readonly pool: Queryable) {}

  async get(playerId: string): Promise<HealTargetSettings> {
    const result = await this.pool.query<SettingsRow>(
      `SELECT player_id, heal_party, heal_friends, heal_kingdom, heal_city, heal_neutral
       FROM player_heal_target_settings WHERE player_id = $1`,
      [playerId]
    );
    return settingsFromRow(result.rows[0]);
  }

  /** Applies a partial change on top of the stored (or default) settings in one upsert. */
  async update(playerId: string, input: HealTargetSettingsUpdate): Promise<HealTargetSettings> {
    const parsed = healTargetSettingsUpdateSchema.safeParse(input);
    if (!parsed.success) throw new HealTargetError("HEAL_TARGETS_INVALID", "Heal-target settings are invalid.", 400);
    const update = parsed.data;
    const value = (group: keyof HealTargetSettings): boolean | null => update[group] ?? null;
    const defaults = DEFAULT_HEAL_TARGET_SETTINGS;
    const result = await this.pool.query<SettingsRow>(
      `INSERT INTO player_heal_target_settings AS current (
         player_id, heal_party, heal_friends, heal_kingdom, heal_city, heal_neutral
       ) VALUES (
         $1, COALESCE($2::boolean, $7::boolean), COALESCE($3::boolean, $8::boolean), COALESCE($4::boolean, $9::boolean),
         COALESCE($5::boolean, $10::boolean), COALESCE($6::boolean, $11::boolean)
       )
       ON CONFLICT (player_id) DO UPDATE SET
         heal_party = COALESCE($2::boolean, current.heal_party),
         heal_friends = COALESCE($3::boolean, current.heal_friends),
         heal_kingdom = COALESCE($4::boolean, current.heal_kingdom),
         heal_city = COALESCE($5::boolean, current.heal_city),
         heal_neutral = COALESCE($6::boolean, current.heal_neutral)
       RETURNING player_id, heal_party, heal_friends, heal_kingdom, heal_city, heal_neutral`,
      [
        playerId, value("party"), value("friends"), value("kingdom"), value("city"), value("neutral"),
        defaults.party, defaults.friends, defaults.kingdom, defaults.city, defaults.neutral
      ]
    );
    return settingsFromRow(result.rows[0]);
  }
}

/**
 * Holy arc relations for many players in four queries: their kingdom and city, friends, the kingdoms and cities at
 * war with their own, and their heal-target settings. Players with no row anywhere still get an entry (defaults).
 */
export async function loadHolyArcRelations(
  queryable: Queryable,
  playerIds: readonly string[]
): Promise<Map<string, HolyArcPlayerRelations>> {
  const relations = new Map<string, HolyArcPlayerRelations>();
  if (playerIds.length === 0) return relations;
  const ids = [...new Set(playerIds)];
  const [memberships, friendships, settings] = await Promise.all([
    queryable.query<{ player_id: string; kingdom_id: string | null; city_id: string | null }>(
      `SELECT p.player_id,
              (SELECT m.kingdom_id::text FROM kingdom_memberships m
                 JOIN kingdoms k ON k.id = m.kingdom_id AND k.status = 'active'
                WHERE m.player_id = p.player_id AND m.status = 'active' LIMIT 1) AS kingdom_id,
              (SELECT c.city_id::text FROM city_memberships c
                WHERE c.player_id = p.player_id AND c.left_at IS NULL
                ORDER BY c.joined_at DESC LIMIT 1) AS city_id
       FROM unnest($1::text[]) AS p(player_id)`,
      [ids]
    ),
    queryable.query<{ player_id: string; friend_id: string }>(
      `SELECT player_low_id AS player_id, player_high_id AS friend_id FROM friendships WHERE player_low_id = ANY($1::text[])
       UNION ALL
       SELECT player_high_id AS player_id, player_low_id AS friend_id FROM friendships WHERE player_high_id = ANY($1::text[])`,
      [ids]
    ),
    queryable.query<SettingsRow>(
      `SELECT player_id, heal_party, heal_friends, heal_kingdom, heal_city, heal_neutral
       FROM player_heal_target_settings WHERE player_id = ANY($1::text[])`,
      [ids]
    )
  ]);
  const organizationIds = new Set<string>();
  for (const row of memberships.rows) {
    if (row.kingdom_id) organizationIds.add(row.kingdom_id);
    if (row.city_id) organizationIds.add(row.city_id);
  }
  const wars = organizationIds.size === 0 ? { rows: [] } : await queryable.query<{
    side_a_kind: "city" | "kingdom"; side_a_id: string; side_b_kind: "city" | "kingdom"; side_b_id: string;
  }>(
    `SELECT side_a_kind, side_a_id::text, side_b_kind, side_b_id::text
     FROM organization_wars
     WHERE status = 'active' AND (side_a_id::text = ANY($1::text[]) OR side_b_id::text = ANY($1::text[]))`,
    [[...organizationIds]]
  );
  const friendsByPlayer = new Map<string, Set<string>>();
  for (const row of friendships.rows) {
    const friends = friendsByPlayer.get(row.player_id) ?? new Set<string>();
    friends.add(row.friend_id);
    friendsByPlayer.set(row.player_id, friends);
  }
  const settingsByPlayer = new Map(settings.rows.map((row) => [row.player_id, settingsFromRow(row)]));
  for (const row of memberships.rows) {
    const enemyKingdomIds = new Set<string>();
    const enemyCityIds = new Set<string>();
    const own = (kind: "city" | "kingdom", id: string) =>
      (kind === "kingdom" && id === row.kingdom_id) || (kind === "city" && id === row.city_id);
    for (const war of wars.rows) {
      const enemy = own(war.side_a_kind, war.side_a_id) ? { kind: war.side_b_kind, id: war.side_b_id }
        : own(war.side_b_kind, war.side_b_id) ? { kind: war.side_a_kind, id: war.side_a_id }
          : null;
      if (enemy) (enemy.kind === "kingdom" ? enemyKingdomIds : enemyCityIds).add(enemy.id);
    }
    relations.set(row.player_id, {
      kingdomId: row.kingdom_id,
      cityId: row.city_id,
      friendIds: friendsByPlayer.get(row.player_id) ?? new Set(),
      enemyKingdomIds,
      enemyCityIds,
      settings: settingsByPlayer.get(row.player_id) ?? DEFAULT_HEAL_TARGET_SETTINGS
    });
  }
  return relations;
}
