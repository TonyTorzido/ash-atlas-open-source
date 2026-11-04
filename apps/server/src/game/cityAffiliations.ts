import type { ProfileAffiliation } from "@ash-atlas/shared";
import type pg from "pg";

import type { ProfileAffiliations, ProfileAffiliationsResolver } from "./profiles.js";

type MembershipRow = {
  city_id: string;
  city_name: string;
  role: string;
  joined_at: Date | string;
};

type KingdomMembershipRow = {
  kingdom_id: string;
  kingdom_name: string;
  emblem_key: string | null;
  role: string;
};

export class CityProfileAffiliationsResolver implements ProfileAffiliationsResolver {
  constructor(private readonly pool: pg.Pool) {}

  async resolve(playerId: string): Promise<ProfileAffiliations> {
    const [result, kingdomResult] = await Promise.all([
      this.pool.query<MembershipRow>(
      `SELECT c.id AS city_id, c.name AS city_name, membership.joined_at,
              CASE WHEN c.mayor_player_id = membership.player_id
                         AND c.mayor_confirmed_at IS NOT NULL
                THEN 'mayor' ELSE 'member' END AS role
       FROM city_memberships membership
       JOIN cities c ON c.id = membership.city_id
       WHERE membership.player_id = $1
         AND membership.left_at IS NULL
         AND c.active
       ORDER BY membership.joined_at DESC, c.id
       LIMIT 1`,
      [playerId]
      ),
      this.pool.query<KingdomMembershipRow>(
        `SELECT k.id AS kingdom_id, k.display_name AS kingdom_name, k.emblem_key, membership.role
         FROM kingdom_memberships membership
         JOIN kingdoms k ON k.id = membership.kingdom_id
         WHERE membership.player_id = $1
           AND membership.status = 'active'
           AND k.status = 'active'
         ORDER BY membership.joined_at DESC, k.id
         LIMIT 1`,
        [playerId]
      )
    ]);
    const row = result.rows[0];
    const settlement: ProfileAffiliation | null = row
      ? {
          id: row.city_id,
          name: row.city_name,
          tier: "city",
          memberRole: row.role,
          joinedAt: new Date(row.joined_at).toISOString()
        }
      : null;
    const kingdomRow = kingdomResult.rows[0];
    const kingdom: ProfileAffiliation | null =
      kingdomRow && typeof kingdomRow.kingdom_id === "string" &&
      typeof kingdomRow.kingdom_name === "string"
      ? {
          id: kingdomRow.kingdom_id,
          name: kingdomRow.kingdom_name,
          emblemKey: kingdomRow.emblem_key,
          memberRole: kingdomRow.role
        }
      : null;
    return { class: null, kingdom, settlement };
  }
}
