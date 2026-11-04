import {
  CITY_MARKET_INTERACTION_RADIUS_M,
  distanceMeters,
  type CityDistrictType
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppConfig } from "../config.js";
import type { GameState } from "./state.js";
import { MarketError, type MarketActor } from "./marketRules.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export type AuthorizedMarketVenue = Readonly<{
  sessionId: string;
  venueId: string;
  venueKey: string;
  displayName: string;
  cityId: string;
  cityName: string;
  marketStructureId: string;
  activeMonumentTypes: readonly CityDistrictType[];
  taxRevision: string;
  relocationRevision: number;
}>;

type MarketAuthorityRow = {
  venue_id: string;
  venue_key: string;
  display_name: string;
  city_id: string;
  city_name: string;
  market_structure_id: string;
  lat: number;
  lon: number;
  active_monument_types: CityDistrictType[];
  tax_revision: string;
  placement_revision: string;
};

type MarketSessionRow = MarketAuthorityRow & {
  session_id: string;
  connection_id: string;
  relocation_revision: string;
};

/**
 * Resolves City Market authority from an active physical structure. The legacy
 * global-access flag is intentionally ignored by fresh session-based traffic.
 */
export class MarketAccessPolicy {
  constructor(
    _config: AppConfig,
    private readonly gameState?: Pick<GameState, "getPlayer" | "isWorldPresent">
  ) {}

  async openSession(
    queryable: Queryable,
    actor: MarketActor,
    connectionId: string,
    marketStructureId: string,
    expectedPlacementRevision: string
  ): Promise<AuthorizedMarketVenue> {
    const authority = await this.requireStructureAuthority(
      queryable,
      actor,
      marketStructureId,
      expectedPlacementRevision,
      connectionId
    );
    const player = this.requireRuntimePlayer(actor.playerId);
    await queryable.query(
      `UPDATE market_sessions
       SET invalidated_at = clock_timestamp(),
           invalidated_reason = 'replaced'
       WHERE (connection_id = $1 OR player_id = $2)
         AND invalidated_at IS NULL`,
      [connectionId, actor.playerId]
    );
    const sessionId = crypto.randomUUID();
    const inserted = await queryable.query<{ opened_at: Date | string }>(
      `INSERT INTO market_sessions (
         session_id, player_id, connection_id, venue_id, city_id,
         market_structure_id, relocation_revision
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING opened_at`,
      [
        sessionId,
        actor.playerId,
        connectionId,
        authority.venue_id,
        authority.city_id,
        authority.market_structure_id,
        player.relocationRevision ?? 0
      ]
    );
    if (!inserted.rows[0]) throw new Error("Market session insert returned no row");
    return venueSnapshot(
      authority,
      sessionId,
      player.relocationRevision ?? 0
    );
  }

  async requireSession(
    queryable: Queryable,
    actor: MarketActor,
    connectionId: string,
    sessionId: string
  ): Promise<AuthorizedMarketVenue> {
    const result = await queryable.query<MarketSessionRow>(
      `SELECT session.session_id::text,
              session.connection_id,
              session.relocation_revision::text,
              venue.venue_id::text,
              venue.venue_key,
              venue.display_name,
              city.id::text AS city_id,
              city.name AS city_name,
              structure.structure_id::text AS market_structure_id,
              structure.lat,
              structure.lon,
              structure.placement_revision::text,
              ARRAY(
                SELECT monument.district_type
                FROM city_structures monument
                WHERE monument.city_id = city.id
                  AND monument.structure_type = 'monument'
                  AND monument.state = 'active'
                  AND monument.district_type IN ('mining', 'forestry', 'hunting')
                ORDER BY monument.district_type
              ) AS active_monument_types,
              venue.tax_revision::text
       FROM market_sessions session
       JOIN market_venues venue
         ON venue.venue_id = session.venue_id
        AND venue.active
        AND venue.state = 'active'
       JOIN cities city
         ON city.id = session.city_id
        AND city.active
        AND city.controller_kind = 'player'
       JOIN city_structures structure
         ON structure.structure_id = session.market_structure_id
        AND structure.city_id = city.id
        AND structure.structure_type = 'market'
        AND structure.state = 'active'
       WHERE session.session_id = $1
         AND session.player_id = $2
         AND session.connection_id = $3
         AND session.invalidated_at IS NULL`,
      [sessionId, actor.playerId, connectionId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new MarketError(
        "MARKET_ACCESS_DENIED",
        "This Market session expired after movement or travel. Open it again.",
        false,
        {
          playerId: actor.playerId,
          connectionId,
          sessionId,
          invalidationReason: "missing_stale_or_replaced"
        }
      );
    }
    const player = this.requireRuntimePlayer(actor.playerId);
    if (
      Number(row.relocation_revision) !== (player.relocationRevision ?? 0) ||
      distanceMeters(player.position, {
        lat: Number(row.lat),
        lon: Number(row.lon)
      }) > CITY_MARKET_INTERACTION_RADIUS_M
    ) {
      await queryable.query(
        `UPDATE market_sessions
         SET invalidated_at = clock_timestamp(),
             invalidated_reason = 'authority_changed'
         WHERE session_id = $1 AND invalidated_at IS NULL`,
        [sessionId]
      );
      throw new MarketError(
        "MARKET_ACCESS_DENIED",
        "This Market session expired after movement or travel. Open it again.",
        false,
        {
          playerId: actor.playerId,
          structureId: row.market_structure_id,
          cityId: row.city_id,
          playerPosition: player.position,
          marketCoordinates: { lat: Number(row.lat), lon: Number(row.lon) },
          calculatedDistanceM: distanceMeters(player.position, {
            lat: Number(row.lat),
            lon: Number(row.lon)
          }),
          interactionRadiusM: CITY_MARKET_INTERACTION_RADIUS_M,
          connectionId,
          relocationRevision: player.relocationRevision ?? 0,
          sessionId,
          invalidationReason: "authority_changed"
        }
      );
    }
    return venueSnapshot(row, row.session_id, Number(row.relocation_revision));
  }

  async isAccessAllowed(
    _queryable: Queryable,
    actor: MarketActor
  ): Promise<boolean> {
    if (!actor.playerId || !actor.accountId || !this.gameState) return false;
    return Boolean(
      this.gameState.getPlayer(actor.playerId)?.online &&
      this.gameState.isWorldPresent(actor.playerId)
    );
  }

  async assertAccess(queryable: Queryable, actor: MarketActor): Promise<void> {
    if (!await this.isAccessAllowed(queryable, actor)) {
      throw new MarketError("MARKET_ACCESS_DENIED", "Market access is not available here");
    }
  }

  private async requireStructureAuthority(
    queryable: Queryable,
    actor: MarketActor,
    marketStructureId: string,
    expectedPlacementRevision: string,
    connectionId: string
  ): Promise<MarketAuthorityRow> {
    await this.assertAccess(queryable, actor);
    const result = await queryable.query<MarketAuthorityRow>(
      `SELECT venue.venue_id::text,
              venue.venue_key,
              venue.display_name,
              city.id::text AS city_id,
              city.name AS city_name,
              structure.structure_id::text AS market_structure_id,
              structure.lat,
              structure.lon,
              structure.placement_revision::text,
              ARRAY(
                SELECT monument.district_type
                FROM city_structures monument
                WHERE monument.city_id = city.id
                  AND monument.structure_type = 'monument'
                  AND monument.state = 'active'
                  AND monument.district_type IN ('mining', 'forestry', 'hunting')
                ORDER BY monument.district_type
              ) AS active_monument_types,
              venue.tax_revision::text
       FROM city_structures structure
       JOIN cities city ON city.id = structure.city_id
        AND city.active
        AND city.controller_kind = 'player'
       JOIN market_venues venue
         ON venue.city_id = city.id
        AND venue.market_structure_id = structure.structure_id
        AND venue.scope_type = 'regional'
        AND venue.active
        AND venue.state = 'active'
       WHERE structure.structure_id = $1
         AND structure.structure_type = 'market'
         AND structure.state = 'active'`,
      [marketStructureId]
    );
    const row = result.rows[0];
    const player = this.requireRuntimePlayer(actor.playerId);
    if (!row || row.placement_revision !== expectedPlacementRevision) {
      throw new MarketError(
        "MARKET_ACCESS_DENIED",
        "This Market is not active.",
        false,
        {
          playerId: actor.playerId,
          structureId: marketStructureId,
          playerPosition: player.position,
          connectionId,
          relocationRevision: player.relocationRevision ?? 0,
          invalidationReason: row ? "placement_revision_changed" : "market_inactive"
        }
      );
    }
    const calculatedDistanceM = distanceMeters(player.position, {
        lat: Number(row.lat),
        lon: Number(row.lon)
      });
    if (calculatedDistanceM > CITY_MARKET_INTERACTION_RADIUS_M) {
      throw new MarketError(
        "MARKET_ACCESS_DENIED",
        `Move within ${CITY_MARKET_INTERACTION_RADIUS_M} meters of the City Market.`,
        false,
        {
          playerId: actor.playerId,
          structureId: row.market_structure_id,
          cityId: row.city_id,
          playerPosition: player.position,
          marketCoordinates: { lat: Number(row.lat), lon: Number(row.lon) },
          calculatedDistanceM,
          interactionRadiusM: CITY_MARKET_INTERACTION_RADIUS_M,
          connectionId,
          relocationRevision: player.relocationRevision ?? 0,
          invalidationReason: "outside_interaction_radius"
        }
      );
    }
    return row;
  }

  private requireRuntimePlayer(playerId: string) {
    const player = this.gameState?.getPlayer(playerId);
    if (
      !player?.online ||
      !this.gameState?.isWorldPresent(playerId)
    ) {
      throw new MarketError(
        "MARKET_ACCESS_DENIED",
        "Market access requires an active world connection."
      );
    }
    return player;
  }
}

function venueSnapshot(
  row: MarketAuthorityRow,
  sessionId: string,
  relocationRevision: number
): AuthorizedMarketVenue {
  return {
    sessionId,
    venueId: row.venue_id,
    venueKey: row.venue_key,
    displayName: row.display_name,
    cityId: row.city_id,
    cityName: row.city_name,
    marketStructureId: row.market_structure_id,
    activeMonumentTypes: row.active_monument_types,
    taxRevision: row.tax_revision,
    relocationRevision
  };
}
