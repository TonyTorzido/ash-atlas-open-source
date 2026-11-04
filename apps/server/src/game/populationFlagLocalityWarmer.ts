import type pg from "pg";

import type { AppLogger } from "../logger.js";
import {
  populationZonesV2IntersectingCircle,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";
import type { PopulationZonesV2Planner } from "./populationZonesV2Planner.js";

type LocalityCandidate = Readonly<{
  id: string;
  lat: number;
  lon: number;
  resource_vision_radius_m: number;
}>;

type LocalityToken = {
  key: string;
  playerId: string;
  generation: number;
  controller: AbortController;
  zoneIds: Set<PopulationZoneV2Id>;
  expiration: ReturnType<typeof setTimeout>;
};

export class PopulationFlagLocalityWarmer {
  private readonly tokensByPlayer = new Map<string, LocalityToken>();
  private readonly ownersByZone = new Map<PopulationZoneV2Id, Set<string>>();
  private closed = false;
  private readonly metrics = {
    refreshes: 0,
    staleRefreshes: 0,
    flagsSelected: 0,
    zonesDiscovered: 0,
    zonesAlreadyReady: 0,
    zonesEnqueued: 0,
    zonesExpiredBeforeAdmission: 0,
    preparationFailures: 0
  };

  constructor(
    private readonly pool: pg.Pool,
    private readonly planner: Pick<
      PopulationZonesV2Planner,
      | "prefetchEnvironmentForZones"
      | "scheduleZones"
      | "cancelQueuedZones"
    >,
    private readonly logger: Pick<AppLogger, "warn">,
    private readonly options: Readonly<{
      maximumFlags?: number;
      maximumDistinctZones?: number;
      interestTtlMs?: number;
      fallbackFlagRadiusM: number;
    }>
  ) {}

  refresh(input: Readonly<{
    playerId: string;
    generation: number;
    center: Readonly<{ lat: number; lon: number }>;
  }>): void {
    if (this.closed) return;
    this.releasePlayer(input.playerId);
    const controller = new AbortController();
    const key = `${input.playerId}:${input.generation}`;
    const token: LocalityToken = {
      key,
      playerId: input.playerId,
      generation: input.generation,
      controller,
      zoneIds: new Set(),
      expiration: setTimeout(
        () => this.releasePlayer(input.playerId, input.generation),
        this.options.interestTtlMs ?? 30_000
      )
    };
    token.expiration.unref?.();
    this.tokensByPlayer.set(input.playerId, token);
    this.metrics.refreshes += 1;
    void this.prepareToken(token, input).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      this.metrics.preparationFailures += 1;
      this.logger.warn(
        { err: error, playerId: input.playerId, generation: input.generation },
        "population flag locality warming failed"
      );
    });
  }

  releasePlayer(playerId: string, generation?: number): boolean {
    const token = this.tokensByPlayer.get(playerId);
    if (!token || (generation !== undefined && token.generation !== generation)) {
      return false;
    }
    this.tokensByPlayer.delete(playerId);
    clearTimeout(token.expiration);
    token.controller.abort(new DOMException(
      "Population locality interest expired",
      "AbortError"
    ));
    const unowned: PopulationZoneV2Id[] = [];
    for (const zoneId of token.zoneIds) {
      const owners = this.ownersByZone.get(zoneId);
      owners?.delete(token.key);
      if (owners && owners.size > 0) continue;
      this.ownersByZone.delete(zoneId);
      unowned.push(zoneId);
    }
    this.metrics.zonesExpiredBeforeAdmission += this.planner.cancelQueuedZones({
      zoneIds: unowned,
      workClass: "locality"
    });
    return true;
  }

  close(): void {
    this.closed = true;
    for (const playerId of [...this.tokensByPlayer.keys()]) {
      this.releasePlayer(playerId);
    }
  }

  metricsSnapshot(): Readonly<typeof this.metrics & {
    activePlayers: number;
    interestedZones: number;
  }> {
    return {
      ...this.metrics,
      activePlayers: this.tokensByPlayer.size,
      interestedZones: this.ownersByZone.size
    };
  }

  private async prepareToken(
    token: LocalityToken,
    input: Readonly<{
      playerId: string;
      generation: number;
      center: Readonly<{ lat: number; lon: number }>;
    }>
  ): Promise<void> {
    const maximumFlags = this.options.maximumFlags ?? 12;
    const candidates = await this.pool.query<LocalityCandidate>(
      `WITH query_point AS (
         SELECT ST_SetSRID(ST_MakePoint($2, $1), 4326) AS geom
       )
       SELECT f.id, f.lat, f.lon,
              COALESCE(f.resource_vision_radius_m, $5)::float8
                AS resource_vision_radius_m
       FROM flags f
       CROSS JOIN query_point
       WHERE (
           f.control_type IN ('city', 'city_seat')
           OR f.owner_id = $3
           OR (
             f.control_type = 'personal'
             AND f.access_mode = 'public'
             AND NOT EXISTS (
               SELECT 1 FROM player_enemy_marks enemy
               WHERE (enemy.owner_id = f.owner_id AND enemy.target_id = $3)
                  OR (enemy.owner_id = $3 AND enemy.target_id = f.owner_id)
             )
           )
           OR (
             f.control_type = 'personal'
             AND f.access_mode = 'normal'
             AND EXISTS (
               SELECT 1 FROM normal_flag_passage_grants passage
               WHERE passage.owner_player_id = f.owner_id
                 AND passage.grantee_player_id = $3
             )
           )
         )
       ORDER BY f.geom <-> query_point.geom, f.id
       LIMIT $4`,
      [
        input.center.lat,
        input.center.lon,
        input.playerId,
        maximumFlags,
        this.options.fallbackFlagRadiusM
      ]
    );
    if (!this.isCurrent(token)) {
      this.metrics.staleRefreshes += 1;
      return;
    }
    const maximumZones = this.options.maximumDistinctZones ?? 16;
    const discovered = new Set<PopulationZoneV2Id>();
    const batches: PopulationZoneV2Id[][] = [];
    for (const flag of candidates.rows) {
      const flagZoneIds = populationZonesV2IntersectingCircle(
        { lat: flag.lat, lon: flag.lon },
        flag.resource_vision_radius_m
      );
      const nextDistinct = new Set([...discovered, ...flagZoneIds]);
      if (batches.length > 0 && nextDistinct.size > maximumZones) break;
      batches.push([...flagZoneIds].sort());
      for (const zoneId of flagZoneIds) discovered.add(zoneId);
    }
    this.metrics.flagsSelected += batches.length;
    this.metrics.zonesDiscovered += discovered.size;
    for (const zoneId of discovered) {
      token.zoneIds.add(zoneId);
      const owners = this.ownersByZone.get(zoneId) ?? new Set<string>();
      owners.add(token.key);
      this.ownersByZone.set(zoneId, owners);
    }
    for (const zoneIds of batches) {
      const prefetch = await this.planner.prefetchEnvironmentForZones({
        zoneIds,
        regionCode: "locality",
        reason: "flag-locality-warming",
        priority: 2,
        workClass: "locality",
        signal: token.controller.signal
      });
      this.metrics.zonesAlreadyReady += prefetch.readyPlanZoneIds.length;
      if (!this.isCurrent(token)) return;
      const result = await this.planner.scheduleZones({
        zoneIds: prefetch.unresolvedPlanZoneIds,
        regionCode: "locality",
        reason: "flag-locality-warming",
        priority: 2,
        workClass: "locality",
        signal: token.controller.signal
      });
      this.metrics.zonesEnqueued += result.pendingZoneIds.length;
    }
  }

  private isCurrent(token: LocalityToken): boolean {
    return !this.closed
      && !token.controller.signal.aborted
      && this.tokensByPlayer.get(token.playerId) === token;
  }
}
