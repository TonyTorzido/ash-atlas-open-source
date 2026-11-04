import {
  WORLD_MAP_CAPITAL_ANCHOR,
  WORLD_MAP_CAPITAL_MATCH_RADIUS_M,
  WORLD_MAP_MAJOR_DESTINATION_LIMIT,
  type PlayerAppearanceSnapshot,
  type StrategicVisionLandmark,
  type WorldMapCityFeaturedReason,
  type WorldMapCaveLandmark,
  type WorldMapDestination,
  type WorldMapMarkerDestination,
  type WorldMapDestinationSnapshot,
  type WorldMapSocialAudience,
  type WorldMapSocialVisibility
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppConfig } from "../config.js";

type DiscoveredCityRow = {
  id: string;
  name: string;
  hall_lat: number;
  hall_lon: number;
  visible: boolean;
  member_count?: number | string;
  member?: boolean;
  discovered?: boolean;
};

type CurrentCityRow = DiscoveredCityRow;

type ManorRow = {
  id: string;
  world_lat: number;
  world_lon: number;
  visible: boolean;
};

type KingdomRow = {
  id: string;
  display_name: string;
  seat_id: string;
  lat: number;
  lon: number;
  visible: boolean;
};

type AtlasShrineRow = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  claim_radius_m: number;
  visible: boolean;
};

type MapMarkerRow = {
  id: string;
  name: string;
  lat: number;
  lon: number;
};

type SocialVisibilityRow = {
  audience: WorldMapSocialAudience;
  visible: boolean;
};

type SocialPlayerRow = {
  player_id: string;
  username: string;
  display_color?: string | null;
  lat: number;
  lon: number;
  published_at: Date | string;
};

export const WORLD_MAP_SOCIAL_PUBLICATION_INTERVAL_MS = 30_000;
export const WORLD_MAP_SOCIAL_POSITION_RETENTION_MS = 10 * 60_000;

const DEFAULT_WORLD_MAP_SOCIAL_VISIBILITY: WorldMapSocialVisibility = {
  friends: true,
  kingdom_members: true,
  city_members: true
};

export type WorldMapSocialPlayerState = Readonly<{
  appearance?: PlayerAppearanceSnapshot;
}>;

const FEATURED_CITY_CACHE_TTL_MS = 3 * 60_000;

export type WorldMapServiceOptions = Readonly<{
  /** Capital anchor override (tests); defaults to the shared Albuquerque anchor. */
  capitalAnchor?: Readonly<{ lat: number; lon: number }>;
  /** How many largest cities are featured for everyone; defaults to the shared limit. */
  topCityLimit?: number;
  featuredCacheTtlMs?: number;
  /** Extra destinations a player can see on the World Map (Hollin Huts for Hollin Lore rank 1+). */
  extraDestinations?: (playerId: string) => Promise<readonly WorldMapDestination[]>;
  /**
   * Whether the player may still jump to their Pathfinder Boot mark: the same flag access check a
   * visible-flag visit runs, and no toll (the mark must never skip one). Without it, marks are not
   * travel targets.
   */
  pathfinderMarkTravelAllowed?: (playerId: string, flagId: string) => Promise<boolean>;
  now?: () => Date;
  /** View-only cave landmarks for the player (Deepstone Lore rank 1+). */
  caveLandmarks?: (playerId: string) => Promise<readonly WorldMapCaveLandmark[]>;
  socialPlayerState?: (
    playerId: string
  ) => WorldMapSocialPlayerState | null | Promise<WorldMapSocialPlayerState | null>;
}>;

export class WorldMapError extends Error {
  constructor(
    readonly code: "WORLD_MAP_DESTINATION_UNAVAILABLE",
    message: string
  ) {
    super(message);
    this.name = "WorldMapError";
  }
}

export class WorldMapService {
  private featuredCache: {
    expiresAt: number;
    reasons: ReadonlyMap<string, WorldMapCityFeaturedReason>;
  } | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Pick<AppConfig, "WORLD_ID">,
    private readonly options: WorldMapServiceOptions = {}
  ) {}

  async publishSocialPosition(
    playerId: string,
    position: { lat: number; lon: number }
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO player_world_map_social_positions (
         player_id, lat, lon, published_at
       ) VALUES (
         $1,
         round($2::numeric, 2)::double precision,
         round($3::numeric, 2)::double precision,
         now()
       )
       ON CONFLICT (player_id) DO UPDATE
       SET lat = EXCLUDED.lat,
           lon = EXCLUDED.lon,
           published_at = EXCLUDED.published_at
       WHERE player_world_map_social_positions.published_at <=
             now() - make_interval(secs => 30)`,
      [playerId, position.lat, position.lon]
    );
  }

  async discoverAtAuthoritativePosition(
    playerId: string,
    position: { lat: number; lon: number }
  ): Promise<{ cityId: string; discovered: boolean } | null> {
    const result = await this.pool.query<{ city_id: string; inserted: boolean }>(
      `WITH city_here AS (
         SELECT c.id
         FROM flags f
         JOIN cities c
           ON c.id = f.city_id
          AND c.world_id = $4
          AND c.active
         WHERE f.control_type IN ('city', 'city_seat')
           AND ST_DWithin(
             f.geom::geography,
             ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
             f.claim_radius_m
           )
         ORDER BY ST_Distance(
           f.geom::geography,
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
         ), c.id
         LIMIT 1
       ),
       inserted AS (
         INSERT INTO player_discovered_cities (
           player_id, city_id, first_visited_at, last_visited_at
         )
         SELECT $3, id, now(), now()
         FROM city_here
         ON CONFLICT (player_id, city_id) DO NOTHING
         RETURNING city_id
       )
       SELECT city_here.id AS city_id, inserted.city_id IS NOT NULL AS inserted
       FROM city_here
       LEFT JOIN inserted ON inserted.city_id = city_here.id`,
      [position.lon, position.lat, playerId, this.config.WORLD_ID]
    );
    const row = result.rows[0];
    return row ? { cityId: row.city_id, discovered: row.inserted } : null;
  }

  async hasDiscoveredCity(playerId: string, cityId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
       FROM player_discovered_cities discovery
       JOIN cities city ON city.id = discovery.city_id
       WHERE discovery.player_id = $1
         AND discovery.city_id = $2
         AND city.world_id = $3
         AND city.active
         AND city.jumpable
       LIMIT 1`,
      [playerId, cityId, this.config.WORLD_ID]
    );
    return result.rowCount === 1;
  }

  /**
   * Cities shown to every player regardless of discovery: the capital (active
   * jumpable city whose hall is nearest the capital anchor) and the largest
   * cities by active membership. Cached in-process to keep snapshots cheap.
   */
  /** Drops the cached capital/top-city selection, e.g. after a capital is founded. */
  invalidateFeaturedCities(): void {
    this.featuredCache = null;
  }

  private async featuredCities(): Promise<ReadonlyMap<string, WorldMapCityFeaturedReason>> {
    const now = Date.now();
    if (this.featuredCache && this.featuredCache.expiresAt > now) {
      return this.featuredCache.reasons;
    }
    const anchor = this.options.capitalAnchor ?? WORLD_MAP_CAPITAL_ANCHOR;
    const topLimit = this.options.topCityLimit ?? WORLD_MAP_MAJOR_DESTINATION_LIMIT;
    const capital = await this.pool.query<{ id: string }>(
        `SELECT city.id
         FROM cities city
         WHERE city.world_id = $1
           AND city.active
           AND city.jumpable
           AND ST_DWithin(
             city.hall_geom::geography,
             ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography,
             $4
           )
         ORDER BY ST_Distance(
           city.hall_geom::geography,
           ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography
         ), city.id
         LIMIT 1`,
        [this.config.WORLD_ID, anchor.lat, anchor.lon, WORLD_MAP_CAPITAL_MATCH_RADIUS_M]
    );
    const capitalRow = capital.rows[0];
    const topSlots = topLimit - (capitalRow ? 1 : 0);
    const top = topSlots > 0
        ? await this.pool.query<{ id: string }>(
          `SELECT city.id
           FROM cities city
           JOIN city_memberships membership
             ON membership.city_id = city.id
            AND membership.left_at IS NULL
           WHERE city.world_id = $1
             AND city.active
             AND city.jumpable
             AND ($3::uuid IS NULL OR city.id <> $3::uuid)
           GROUP BY city.id, city.name
           ORDER BY count(*) DESC, city.name, city.id
           LIMIT $2`,
          [this.config.WORLD_ID, topSlots, capitalRow?.id ?? null]
        )
        : { rows: [] as { id: string }[] };
    const reasons = new Map<string, WorldMapCityFeaturedReason>();
    if (capitalRow) reasons.set(capitalRow.id, "capital");
    for (const row of top.rows) reasons.set(row.id, "top");
    this.featuredCache = {
      expiresAt: now + (this.options.featuredCacheTtlMs ?? FEATURED_CITY_CACHE_TTL_MS),
      reasons
    };
    return reasons;
  }

  /** Discovered cities plus globally featured cities may be travelled to. */
  async canTravelToCity(playerId: string, cityId: string): Promise<boolean> {
    if (await this.hasDiscoveredCity(playerId, cityId)) return true;
    if (!(await this.featuredCities()).has(cityId)) return false;
    const result = await this.pool.query(
      `SELECT 1 FROM cities
       WHERE id = $1 AND world_id = $2 AND active AND jumpable
       LIMIT 1`,
      [cityId, this.config.WORLD_ID]
    );
    return result.rowCount === 1;
  }

  async snapshot(playerId: string): Promise<WorldMapDestinationSnapshot> {
    const featured = await this.featuredCities();
    const featuredIds = [...featured.keys()];
    const [cities, manor, kingdom, atlasShrines, visibility, socialPlayers, markers] = await Promise.all([
      this.pool.query<DiscoveredCityRow>(
        `SELECT city.id, city.name, city.hall_lat, city.hall_lon,
                COALESCE(
                  preference.visible,
                  city.id = ANY($3::uuid[]) OR EXISTS (
                    SELECT 1
                    FROM city_memberships membership
                    WHERE membership.player_id = $1
                      AND membership.city_id = city.id
                      AND membership.left_at IS NULL
                  )
                ) AS visible,
                (
                  SELECT count(*)::int
                  FROM city_memberships counted
                  WHERE counted.city_id = city.id
                    AND counted.left_at IS NULL
                ) AS member_count,
                EXISTS (
                  SELECT 1
                  FROM city_memberships own
                  WHERE own.player_id = $1
                    AND own.city_id = city.id
                    AND own.left_at IS NULL
                ) AS member,
                discovery.player_id IS NOT NULL AS discovered
         FROM cities city
         LEFT JOIN player_discovered_cities discovery
           ON discovery.city_id = city.id
          AND discovery.player_id = $1
         LEFT JOIN player_world_map_destination_preferences preference
           ON preference.player_id = $1
          AND preference.destination_kind = 'city'
          AND preference.destination_id = city.id::text
         WHERE (discovery.player_id IS NOT NULL OR city.id = ANY($3::uuid[]))
           AND city.world_id = $2
           AND city.active
           AND city.jumpable
         ORDER BY city.name, city.id`,
        [playerId, this.config.WORLD_ID, featuredIds]
      ),
      this.pool.query<ManorRow>(
        `SELECT manor.id, manor.world_lat, manor.world_lon,
                COALESCE(preference.visible, true) AS visible
         FROM player_manors manor
         LEFT JOIN player_world_map_destination_preferences preference
           ON preference.player_id = manor.owner_player_id
          AND preference.destination_kind = 'manor'
          AND preference.destination_id = manor.id::text
         WHERE manor.owner_player_id = $1
           AND manor.built_at IS NOT NULL
         LIMIT 1`,
        [playerId]
      ),
      this.pool.query<KingdomRow>(
        `SELECT kingdom.id, kingdom.display_name, seat.id AS seat_id, seat.lat, seat.lon,
                COALESCE(preference.visible, true) AS visible
         FROM kingdom_memberships membership
         JOIN kingdoms kingdom
           ON kingdom.id = membership.kingdom_id
          AND kingdom.status = 'active'
         JOIN kingdom_seats seat
           ON seat.kingdom_id = kingdom.id
          AND seat.status = 'active'
          AND seat.construction_state = 'complete'
         LEFT JOIN player_world_map_destination_preferences preference
           ON preference.player_id = membership.player_id
          AND preference.destination_kind = 'kingdom'
          AND preference.destination_id = kingdom.id::text
         WHERE membership.player_id = $1
           AND membership.status = 'active'
         LIMIT 1`,
        [playerId]
      ),
      this.pool.query<AtlasShrineRow>(
        `SELECT flag.id, COALESCE(
                  NULLIF(btrim(flag.name), ''),
                  'Atlas Shrine ' || flag.atlas_shrine_slot_number::text
                ) AS name,
                flag.lat, flag.lon, flag.claim_radius_m,
                COALESCE(preference.visible, true) AS visible
         FROM flags flag
         LEFT JOIN player_world_map_destination_preferences preference
           ON preference.player_id = flag.owner_id
          AND preference.destination_kind = 'atlas_shrine'
          AND preference.destination_id = flag.id::text
         WHERE flag.owner_id = $1
           AND flag.control_type = 'personal'
           AND flag.city_id IS NULL
           AND flag.kingdom_id IS NULL
           AND flag.reinforcement_level = 2
           AND flag.atlas_shrine_slot_number IS NOT NULL
         ORDER BY name, flag.id`,
        [playerId]
      ),
      this.pool.query<SocialVisibilityRow>(
        `SELECT audience, visible
         FROM player_world_map_social_preferences
         WHERE player_id = $1`,
        [playerId]
      ),
      this.pool.query<SocialPlayerRow>(
        `SELECT DISTINCT ON (other.id)
                other.id AS player_id,
                other.username,
                other.display_color,
                published.lat,
                published.lon,
                published.published_at
         FROM player_world_map_social_positions published
         JOIN players other ON other.id = published.player_id
         WHERE other.id <> $1
           AND published.published_at >= now() - make_interval(secs => 600)
           AND NOT EXISTS (
             SELECT 1
             FROM player_blocks blocked
             WHERE (blocked.blocker_id = $1 AND blocked.blocked_id = other.id)
                OR (blocked.blocker_id = other.id AND blocked.blocked_id = $1)
           )
           AND (
             (
               EXISTS (
                 SELECT 1
                 FROM friendships friendship
                 WHERE (friendship.player_low_id = $1 AND friendship.player_high_id = other.id)
                    OR (friendship.player_high_id = $1 AND friendship.player_low_id = other.id)
               )
               AND COALESCE((
                 SELECT preference.visible
                 FROM player_world_map_social_preferences preference
                 WHERE preference.player_id = other.id
                   AND preference.audience = 'friends'
                 LIMIT 1
               ), true)
             )
             OR (
               EXISTS (
                 SELECT 1
                 FROM kingdom_memberships viewer_membership
                 JOIN kingdom_memberships other_membership
                   ON other_membership.kingdom_id = viewer_membership.kingdom_id
                  AND other_membership.player_id = other.id
                  AND other_membership.status = 'active'
                 WHERE viewer_membership.player_id = $1
                   AND viewer_membership.status = 'active'
               )
               AND COALESCE((
                 SELECT preference.visible
                 FROM player_world_map_social_preferences preference
                 WHERE preference.player_id = other.id
                   AND preference.audience = 'kingdom_members'
                 LIMIT 1
               ), true)
             )
             OR (
               EXISTS (
                 SELECT 1
                 FROM city_memberships viewer_membership
                 JOIN city_memberships other_membership
                   ON other_membership.city_id = viewer_membership.city_id
                  AND other_membership.player_id = other.id
                  AND other_membership.left_at IS NULL
                  AND other_membership.world_id = $2
                 WHERE viewer_membership.player_id = $1
                   AND viewer_membership.left_at IS NULL
                   AND viewer_membership.world_id = $2
               )
               AND COALESCE((
                 SELECT preference.visible
                 FROM player_world_map_social_preferences preference
                 WHERE preference.player_id = other.id
                   AND preference.audience = 'city_members'
                 LIMIT 1
               ), true)
             )
           )
         ORDER BY other.id, published.published_at DESC`,
        [playerId, this.config.WORLD_ID]
      ),
      // Markers are private: only the owner ever receives their own rows.
      this.pool.query<MapMarkerRow>(
        `SELECT id::text, name, lat, lon
         FROM player_map_markers
         WHERE player_id = $1
         ORDER BY created_at, id`,
        [playerId]
      )
    ]);

    const socialPlayerStates = await Promise.all(
      socialPlayers.rows.map((row) => Promise.resolve()
        .then(() => this.options.socialPlayerState?.(row.player_id) ?? null)
        .catch(() => null))
    );
    const destinations: WorldMapDestination[] = cities.rows.map((city) => ({
      kind: "city",
      id: city.id,
      name: city.name,
      lat: Number(city.hall_lat),
      lon: Number(city.hall_lon),
      visible: city.visible,
      ...(featured.has(city.id) ? { featured: featured.get(city.id)! } : {}),
      memberCount: Number(city.member_count ?? 0),
      member: city.member === true,
      discovered: city.discovered === true
    }));
    const ownManor = manor.rows[0];
    if (ownManor) {
      destinations.push({
        kind: "manor",
        id: ownManor.id,
        name: "Your Manor",
        lat: Number(ownManor.world_lat),
        lon: Number(ownManor.world_lon),
        visible: ownManor.visible
      });
    }
    const currentKingdom = kingdom.rows[0];
    if (currentKingdom) {
      destinations.push({
        kind: "kingdom",
        id: currentKingdom.id,
        seatId: currentKingdom.seat_id,
        name: currentKingdom.display_name,
        lat: Number(currentKingdom.lat),
        lon: Number(currentKingdom.lon),
        visible: currentKingdom.visible
      });
    }
    for (const shrine of atlasShrines.rows) {
      destinations.push({
        kind: "atlas_shrine",
        id: shrine.id,
        name: shrine.name,
        lat: Number(shrine.lat),
        lon: Number(shrine.lon),
        visible: shrine.visible
      });
    }
    const markerDestinations: WorldMapMarkerDestination[] = [];
    for (const marker of markers.rows) {
      markerDestinations.push({
        kind: "map_marker",
        id: marker.id,
        name: marker.name,
        lat: Number(marker.lat),
        lon: Number(marker.lon),
        visible: true
      });
    }
    destinations.push(...(await this.options.extraDestinations?.(playerId) ?? []));
    const mark = await this.activePathfinderMark(playerId);
    if (mark) {
      destinations.push({
        kind: "pathfinder_mark",
        id: mark.id,
        name: mark.name,
        lat: Number(mark.lat),
        lon: Number(mark.lon),
        visible: true,
        expiresAt: mark.expires_at.toISOString()
      });
    }
    const socialVisibility: Record<WorldMapSocialAudience, boolean> = {
      ...DEFAULT_WORLD_MAP_SOCIAL_VISIBILITY
    };
    for (const row of visibility.rows) socialVisibility[row.audience] = row.visible;
    const caves = [...(await this.options.caveLandmarks?.(playerId) ?? [])];
    return {
      destinations,
      markers: markerDestinations,
      ...(caves.length > 0 ? { caves } : {}),
      serverTime: Date.now(),
      socialVisibility,
      socialPlayers: socialPlayers.rows.map((row, index) => {
        const playerState = socialPlayerStates[index];
        return {
          playerId: row.player_id,
          username: row.username,
          lat: Number(row.lat),
          lon: Number(row.lon),
          publishedAt: row.published_at instanceof Date
            ? row.published_at.toISOString()
            : new Date(row.published_at).toISOString(),
          ...(row.display_color === undefined ? {} : { displayColor: row.display_color }),
          ...(playerState?.appearance
            ? { appearance: structuredClone(playerState.appearance) }
            : {})
        };
      })
    };
  }

  async setSocialVisibility(
    playerId: string,
    audience: WorldMapSocialAudience,
    visible: boolean
  ): Promise<WorldMapDestinationSnapshot> {
    await this.pool.query(
      `INSERT INTO player_world_map_social_preferences (
         player_id, audience, visible
       ) VALUES ($1, $2, $3)
       ON CONFLICT (player_id, audience) DO UPDATE
       SET visible = EXCLUDED.visible,
           updated_at = now()
       WHERE player_world_map_social_preferences.visible IS DISTINCT FROM EXCLUDED.visible`,
      [playerId, audience, visible]
    );
    return this.snapshot(playerId);
  }

  async setDestinationVisibility(
    playerId: string,
    destination: Pick<WorldMapDestination, "kind" | "id">,
    visible: boolean
  ): Promise<WorldMapDestinationSnapshot> {
    const current = await this.snapshot(playerId);
    if (!current.destinations.some((candidate) =>
      candidate.kind === destination.kind && candidate.id === destination.id
    )) {
      throw new WorldMapError(
        "WORLD_MAP_DESTINATION_UNAVAILABLE",
        "That destination is not available on your World Map."
      );
    }
    await this.pool.query(
      `INSERT INTO player_world_map_destination_preferences (
         player_id, destination_kind, destination_id, visible
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (player_id, destination_kind, destination_id) DO UPDATE
       SET visible = EXCLUDED.visible,
           updated_at = now()
       WHERE player_world_map_destination_preferences.visible IS DISTINCT FROM EXCLUDED.visible`,
      [playerId, destination.kind, destination.id, visible]
    );
    return this.snapshot(playerId);
  }

  async strategicLandmarks(playerId: string): Promise<StrategicVisionLandmark[]> {
    const [city, manor, kingdom] = await Promise.all([
      this.pool.query<CurrentCityRow>(
        `SELECT city.id, city.name, city.hall_lat, city.hall_lon, true AS visible
         FROM city_memberships membership
         JOIN cities city
           ON city.id = membership.city_id
          AND city.world_id = $2
          AND city.active
         WHERE membership.player_id = $1
           AND membership.left_at IS NULL
         ORDER BY membership.joined_at DESC
         LIMIT 1`,
        [playerId, this.config.WORLD_ID]
      ),
      this.pool.query<ManorRow>(
        `SELECT manor.id, manor.world_lat, manor.world_lon, true AS visible
         FROM player_manors manor
         WHERE manor.owner_player_id = $1
           AND manor.built_at IS NOT NULL
         LIMIT 1`,
        [playerId]
      ),
      this.pool.query<KingdomRow>(
        `SELECT kingdom.id, kingdom.display_name, seat.id AS seat_id, seat.lat, seat.lon,
                true AS visible
         FROM kingdom_memberships membership
         JOIN kingdoms kingdom
           ON kingdom.id = membership.kingdom_id
          AND kingdom.status = 'active'
         JOIN kingdom_seats seat
           ON seat.kingdom_id = kingdom.id
          AND seat.status = 'active'
          AND seat.construction_state = 'complete'
         WHERE membership.player_id = $1
           AND membership.status = 'active'
         LIMIT 1`,
        [playerId]
      )
    ]);

    const landmarks: StrategicVisionLandmark[] = [];
    const ownCity = city.rows[0];
    if (ownCity) {
      landmarks.push({
        kind: "city",
        id: ownCity.id,
        name: ownCity.name,
        lat: Number(ownCity.hall_lat),
        lon: Number(ownCity.hall_lon)
      });
    }
    const ownManor = manor.rows[0];
    if (ownManor) {
      landmarks.push({
        kind: "manor",
        id: ownManor.id,
        name: "Your Manor",
        lat: Number(ownManor.world_lat),
        lon: Number(ownManor.world_lon)
      });
    }
    const currentKingdom = kingdom.rows[0];
    if (currentKingdom) {
      landmarks.push({
        kind: "kingdom",
        id: currentKingdom.id,
        name: currentKingdom.display_name,
        lat: Number(currentKingdom.lat),
        lon: Number(currentKingdom.lon)
      });
    }
    return landmarks;
  }

  async getOwnedAtlasShrine(
    playerId: string,
    flagId: string,
    queryable: Pick<pg.Pool, "query"> | pg.PoolClient = this.pool
  ): Promise<AtlasShrineRow | null> {
    const marked = await this.activePathfinderMark(playerId, flagId, queryable);
    if (marked) {
      // An owner ban or a toll added after the mark was made closes the mark too.
      if (!(await this.options.pathfinderMarkTravelAllowed?.(playerId, marked.id))) return null;
      return {
        id: marked.id, name: marked.name, lat: marked.lat, lon: marked.lon,
        claim_radius_m: marked.claim_radius_m, visible: true
      };
    }
    const result = await queryable.query<AtlasShrineRow>(
      `SELECT id, COALESCE(
                NULLIF(btrim(name), ''),
                'Atlas Shrine ' || atlas_shrine_slot_number::text
              ) AS name,
              lat, lon, claim_radius_m, true AS visible
       FROM flags
       WHERE id = $1
         AND owner_id = $2
         AND control_type = 'personal'
         AND city_id IS NULL
         AND kingdom_id IS NULL
         AND reinforcement_level = 2
         AND atlas_shrine_slot_number IS NOT NULL
       LIMIT 1`,
      [flagId, playerId]
    );
    return result.rows[0] ?? null;
  }

  /** The player's Pathfinder Boot mark while it has not expired and its building still stands. */
  private async activePathfinderMark(
    playerId: string,
    flagId: string | null = null,
    queryable: Pick<pg.Pool, "query"> | pg.PoolClient = this.pool
  ): Promise<{ id: string; name: string; lat: number; lon: number; claim_radius_m: number; expires_at: Date } | null> {
    const result = await queryable.query<{
      id: string; name: string; lat: number; lon: number; claim_radius_m: number; expires_at: Date;
    }>(
      `SELECT mark.flag_id::text AS id, mark.name, flag.lat, flag.lon, flag.claim_radius_m, mark.expires_at
         FROM player_pathfinder_marks mark
         JOIN flags flag ON flag.id = mark.flag_id
        WHERE mark.player_id = $1
          AND mark.expires_at > $2
          AND ($3::text IS NULL OR mark.flag_id::text = $3)`,
      [playerId, (this.options.now?.() ?? new Date()), flagId]
    );
    return result.rows[0] ?? null;
  }
}
