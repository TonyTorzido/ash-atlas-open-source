import {
  DROWNED_CITY_WORLD_ENTRANCE_RULE,
  PEARL_DIVE_COOLDOWN_MS,
  PEARL_DIVE_MIN_RANK,
  TIDECRAFT_SKILL_ID,
  WATER_SITE_INTERACTION_RADIUS_M,
  WATER_SITE_VISIBLE_RADIUS_M,
  WHIRLPOOL_MIN_RANK,
  WHIRLPOOL_PLATE_COST,
  distanceMeters,
  pearlDiveYield,
  worldDungeonEntranceVisibleAt,
  waterSiteBlockerText,
  type LatLon,
  type PlayerInventorySnapshot,
  type ResourceType,
  type SkillSystemV3Snapshot,
  type WaterSiteBlocker,
  type WaterSiteKind,
  type WaterSiteSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { DungeonSkillTurnInResult } from "./dungeonSkills.js";
import type { InventoryService } from "./inventory.js";
import type { GameState } from "./state.js";
import {
  classifyWaterSiteSurface,
  isEligibleWaterSiteSurface,
  isLegacyDrownedCitySiteId,
  waterSiteCandidateById,
  waterSiteCandidatesNear,
  type WaterSiteCandidate,
  type WaterSiteSurface
} from "./waterSitePlacement.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

const SURFACE_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const SURFACE_CACHE_MAX_ENTRIES = 20_000;
const LOOKUP_TIMEOUT_MS = 2_500;
const NOT_ENOUGH_ITEMS = "Inventory does not contain enough items";

export class WaterSiteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly blocker: WaterSiteBlocker | null = null
  ) {
    super(message);
    this.name = "WaterSiteError";
  }
}

export type PearlDiveResult = Readonly<{
  siteId: string;
  pearls: number;
  diveReadyAt: number;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
}>;

export type WhirlpoolPlan = Readonly<{
  siteId: string;
  partnerSiteId: string;
  destination: LatLon;
  distanceM: number;
}>;

export type TidecraftState = Readonly<{ rank: number; discovered: boolean }>;

/**
 * Pearl diving, whirlpools and the Tidecraft turn-in at Drowned City sites
 * (docs/design/WATER_GAME_PLAN.md, phases C and D). Site placement lives in
 * waterSitePlacement.ts; this service checks the authoritative World surface
 * (fail closed: an unknown surface is not a site) and owns the transactions.
 */
export class WaterSiteService {
  private readonly surfaceCache = new Map<string, { surface: WaterSiteSurface; expiresAt: number }>();

  constructor(private readonly deps: Readonly<{
    pool: pg.Pool;
    inventory: Pick<InventoryService, "debitItemsForOperationInTransaction" | "grantItemsForOperationInTransaction" | "snapshotInTransaction" | "getInventorySnapshot">;
    worldLookup: Pick<WorldLookupClient, "lookupGameplayEnvironments"> | undefined;
    gameState: Pick<GameState, "getPlayer" | "isAfloat" | "isWorldPresent">;
    turnIn?: ((playerId: string, skillId: "tidecraft", requestId: string) => Promise<DungeonSkillTurnInResult>) | undefined;
    logger: Pick<AppLogger, "warn">;
    random?: () => number;
    now?: () => number;
  }>) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async tidecraftState(playerId: string, queryable: Queryable = this.deps.pool): Promise<TidecraftState> {
    const result = await queryable.query<{ discovered: boolean; rank: number | null }>(
      `SELECT EXISTS (
                SELECT 1 FROM player_skill_world_unlocks WHERE player_id = $1 AND skill_id = $2
              ) AS discovered,
              (SELECT rank FROM player_skill_ranks WHERE player_id = $1 AND skill_id = $2) AS rank`,
      [playerId, TIDECRAFT_SKILL_ID]
    );
    const row = result.rows[0];
    return { discovered: row?.discovered === true, rank: Number(row?.rank ?? 0) };
  }

  /** Water sites around the player that stand on eligible water, with this player's dive timers. */
  async sitesFor(playerId: string): Promise<Readonly<{ sites: WaterSiteSnapshot[]; tidecraft: TidecraftState }>> {
    const player = this.deps.gameState.getPlayer(playerId);
    const tidecraft = await this.tidecraftState(playerId);
    if (!player || !this.deps.gameState.isWorldPresent(playerId)) return { sites: [], tidecraft };
    // Drowned City sites show only in their day phases (dusk and night), like their entrances.
    const drownedVisible = this.drownedCityVisible();
    const candidates = waterSiteCandidatesNear(player.position, WATER_SITE_VISIBLE_RADIUS_M)
      .filter((site) => drownedVisible || site.kind !== "drowned_city_site");
    const eligible = await this.eligibleSites(candidates);
    const bedIds = eligible.filter((site) => site.kind === "pearl_bed").map((site) => site.siteId);
    const readyAt = new Map<string, number>();
    if (bedIds.length > 0) {
      const dives = await this.deps.pool.query<{ bed_id: string; ready_ms: string }>(
        `SELECT bed_id, FLOOR(EXTRACT(EPOCH FROM last_dived_at) * 1000)::bigint + $3::bigint AS ready_ms
         FROM player_pearl_dives
         WHERE player_id = $1 AND bed_id = ANY($2::text[])`,
        [playerId, bedIds, PEARL_DIVE_COOLDOWN_MS]
      );
      for (const row of dives.rows) readyAt.set(row.bed_id, Number(row.ready_ms));
    }
    const now = this.now();
    return {
      tidecraft,
      sites: eligible.map((site) => {
        const ready = readyAt.get(site.siteId);
        return {
          siteId: site.siteId,
          kind: site.kind,
          lat: site.position.lat,
          lon: site.position.lon,
          ...(site.partner
            ? { destination: { ...site.partner.position, distanceM: Math.round(distanceMeters(site.position, site.partner.position)) } }
            : {}),
          ...(ready !== undefined && ready > now ? { diveReadyAt: ready } : {})
        };
      })
    };
  }

  /**
   * One dive: rank, afloat and range are checked, then the 6 h cooldown row and
   * the pearl grant commit in one transaction. A replayed request id returns
   * the first dive's result and never grants again.
   */
  async dive(playerId: string, siteId: string, requestId: string): Promise<PearlDiveResult> {
    const site = await this.requireSite(siteId, "pearl_bed");
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM players WHERE id = $1 FOR UPDATE", [playerId]);
      const previous = await client.query<{ last_request_id: string; last_pearls: number; dived_ms: string; cooling: boolean }>(
        `SELECT last_request_id, last_pearls,
                FLOOR(EXTRACT(EPOCH FROM last_dived_at) * 1000)::bigint AS dived_ms,
                last_dived_at > now() - ($3::bigint * interval '1 millisecond') AS cooling
         FROM player_pearl_dives WHERE player_id = $1 AND bed_id = $2 FOR UPDATE`,
        [playerId, siteId, PEARL_DIVE_COOLDOWN_MS]
      );
      const row = previous.rows[0];
      if (row && row.last_request_id === requestId) {
        const inventory = await this.deps.inventory.snapshotInTransaction(client, playerId);
        await client.query("COMMIT");
        return { siteId, pearls: Number(row.last_pearls), diveReadyAt: Number(row.dived_ms) + PEARL_DIVE_COOLDOWN_MS, inventory, replayed: true };
      }
      const { rank } = await this.tidecraftState(playerId, client);
      this.requireActionPosition(playerId, site, rank, PEARL_DIVE_MIN_RANK);
      if (row?.cooling) {
        const readyInMs = Number(row.dived_ms) + PEARL_DIVE_COOLDOWN_MS - this.now();
        throw new WaterSiteError("PEARL_DIVE_COOLDOWN", waterSiteBlockerText("cooldown", { readyInMs }), "cooldown");
      }
      const pearls = pearlDiveYield(rank, (this.deps.random ?? Math.random)());
      const written = await client.query<{ dived_ms: string }>(
        `INSERT INTO player_pearl_dives (player_id, bed_id, last_request_id, last_dived_at, last_pearls, dive_count)
         VALUES ($1, $2, $3, now(), $4, 1)
         ON CONFLICT (player_id, bed_id) DO UPDATE SET
           last_request_id = EXCLUDED.last_request_id,
           last_dived_at = EXCLUDED.last_dived_at,
           last_pearls = EXCLUDED.last_pearls,
           dive_count = player_pearl_dives.dive_count + 1
         RETURNING FLOOR(EXTRACT(EPOCH FROM last_dived_at) * 1000)::bigint AS dived_ms`,
        [playerId, siteId, requestId, pearls]
      );
      const granted = await this.deps.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: pearlDiveOperationKey(playerId, requestId),
        playerId,
        source: "pearl_dive",
        sourceEntityType: "pearl_bed",
        sourceEntityId: siteId,
        metadata: { requestId, rank },
        grants: [{ itemId: "pearl", variant: null, quantity: pearls }]
      });
      if (!granted.applied) {
        // This request id already paid out at another bed: never grant twice.
        throw new WaterSiteError("WATER_SITE_REQUEST_REUSED", "That dive request was already used.");
      }
      await client.query("COMMIT");
      return {
        siteId,
        pearls,
        diveReadyAt: Number(written.rows[0]!.dived_ms) + PEARL_DIVE_COOLDOWN_MS,
        inventory: granted.inventory,
        replayed: false
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Everything a whirlpool trip needs before the travel transaction (rank, afloat, range, plates). */
  async planWhirlpool(playerId: string, siteId: string, requestId: string): Promise<WhirlpoolPlan> {
    const site = await this.requireSite(siteId, "whirlpool");
    const partner = site.partner;
    if (!partner) throw new WaterSiteError("WATER_SITE_UNKNOWN", "That whirlpool leads nowhere.");
    const [partnerSurface] = await this.surfacesFor([{ siteId: partner.siteId, kind: "whirlpool", position: partner.position }]);
    if (!partnerSurface || !isEligibleWaterSiteSurface("whirlpool", partnerSurface)) {
      throw new WaterSiteError("WATER_SITE_UNAVAILABLE", "That whirlpool is calm right now.");
    }
    if (await this.operationApplied(whirlpoolOperationKey(playerId, requestId))) {
      throw new WaterSiteError("WHIRLPOOL_ALREADY_USED", "That whirlpool trip was already taken.");
    }
    const { rank } = await this.tidecraftState(playerId);
    this.requireActionPosition(playerId, site, rank, WHIRLPOOL_MIN_RANK);
    const plates = await this.itemTotal(playerId, "shellback_plate");
    if (plates < WHIRLPOOL_PLATE_COST) {
      throw new WaterSiteError(
        "WHIRLPOOL_PLATES_REQUIRED",
        waterSiteBlockerText("not_enough_plates", { have: plates, need: WHIRLPOOL_PLATE_COST }),
        "not_enough_plates"
      );
    }
    return {
      siteId,
      partnerSiteId: partner.siteId,
      destination: { ...partner.position },
      distanceM: distanceMeters(site.position, partner.position)
    };
  }

  /**
   * Pays one whirlpool trip inside the travel persistence transaction. Throws when
   * this request id already paid (the relocation must not run twice for free) or
   * when the plates ran out, which rolls the relocation back.
   */
  async chargeWhirlpoolInTransaction(client: pg.PoolClient, playerId: string, requestId: string, siteId: string): Promise<void> {
    try {
      const debit = await this.deps.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: whirlpoolOperationKey(playerId, requestId),
        playerId,
        source: "whirlpool_travel",
        sourceEntityType: "whirlpool",
        sourceEntityId: siteId,
        metadata: { requestId },
        debits: [{ itemId: "shellback_plate" as ResourceType, variant: null, quantity: WHIRLPOOL_PLATE_COST }]
      });
      if (!debit.applied) throw new WaterSiteError("WHIRLPOOL_ALREADY_USED", "That whirlpool trip was already taken.");
    } catch (error) {
      if (error instanceof Error && error.message === NOT_ENOUGH_ITEMS) {
        throw new WaterSiteError(
          "WHIRLPOOL_PLATES_REQUIRED",
          waterSiteBlockerText("not_enough_plates", { need: WHIRLPOOL_PLATE_COST }),
          "not_enough_plates"
        );
      }
      throw error;
    }
  }

  /** Presents 20 Abyssal Orbs at a Drowned City site: discovers Tidecraft (orbs and discovery in one transaction). */
  async presentOrbs(playerId: string, siteId: string, requestId: string): Promise<Readonly<{
    message: string;
    inventory: PlayerInventorySnapshot;
    snapshot: SkillSystemV3Snapshot;
  }>> {
    const site = await this.requireSite(siteId, "drowned_city_site");
    this.requireInRange(playerId, site);
    if (!this.deps.turnIn) throw new WaterSiteError("WATER_SITE_UNAVAILABLE", "The Drowned City site is silent right now.");
    const result = await this.deps.turnIn(playerId, TIDECRAFT_SKILL_ID, requestId);
    if (result.status === "already_discovered") {
      throw new WaterSiteError("TIDECRAFT_ALREADY_KNOWN", waterSiteBlockerText("already_known"), "already_known");
    }
    if (result.status === "insufficient") {
      throw new WaterSiteError(
        "TIDECRAFT_ORBS_REQUIRED",
        waterSiteBlockerText("not_enough_orbs", { have: result.have, need: result.need }),
        "not_enough_orbs"
      );
    }
    return { message: result.message, inventory: result.inventory, snapshot: result.snapshot };
  }

  /** A Drowned City site's position when it stands on coastal ocean; null otherwise or when unknown (fail closed). */
  async drownedCitySite(siteId: string): Promise<LatLon | null> {
    const site = waterSiteCandidateById(siteId);
    if (!site || site.kind !== "drowned_city_site" || isLegacyDrownedCitySiteId(siteId) || !this.drownedCityVisible()) return null;
    const [surface] = await this.surfacesFor([site]);
    return surface && isEligibleWaterSiteSurface(site.kind, surface) ? { ...site.position } : null;
  }

  /** Drowned City site ids on coastal ocean within `radiusM` of `position` (the raid's entrances). */
  async drownedCitySitesNear(position: LatLon, radiusM: number): Promise<string[]> {
    if (!this.drownedCityVisible()) return [];
    const candidates = waterSiteCandidatesNear(position, radiusM)
      .filter((site) => site.kind === "drowned_city_site" && distanceMeters(site.position, position) <= radiusM);
    if (candidates.length === 0) return [];
    return (await this.eligibleSites(candidates)).map((site) => site.siteId);
  }

  /** Whether Drowned City sites and entrances show at this time of day (shared tuning table). */
  drownedCityVisible(): boolean {
    return worldDungeonEntranceVisibleAt(DROWNED_CITY_WORLD_ENTRANCE_RULE.visiblePhases, this.now());
  }

  private requireInRange(playerId: string, site: WaterSiteCandidate): void {
    const player = this.deps.gameState.getPlayer(playerId);
    if (!player || !this.deps.gameState.isWorldPresent(playerId)) {
      throw new WaterSiteError("WATER_SITE_PLAYER_UNAVAILABLE", "You cannot do that right now.");
    }
    if (distanceMeters(player.position, site.position) > WATER_SITE_INTERACTION_RADIUS_M) {
      throw new WaterSiteError("WATER_SITE_TOO_FAR", waterSiteBlockerText("too_far"), "too_far");
    }
  }

  private requireActionPosition(playerId: string, site: WaterSiteCandidate, rank: number, minimumRank: number): void {
    if (rank < minimumRank) {
      throw new WaterSiteError("TIDECRAFT_RANK_REQUIRED", waterSiteBlockerText("no_rank"), "no_rank");
    }
    if (!this.deps.gameState.isAfloat(playerId)) {
      throw new WaterSiteError("WATER_SITE_NOT_AFLOAT", waterSiteBlockerText("not_afloat"), "not_afloat");
    }
    this.requireInRange(playerId, site);
  }

  private async requireSite(siteId: string, kind: WaterSiteKind): Promise<WaterSiteCandidate> {
    const site = waterSiteCandidateById(siteId);
    if (!site || site.kind !== kind) throw new WaterSiteError("WATER_SITE_UNKNOWN", "That place does not exist.");
    const [surface] = await this.surfacesFor([site]);
    if (!surface || !isEligibleWaterSiteSurface(kind, surface)) {
      throw new WaterSiteError("WATER_SITE_UNAVAILABLE", "That place cannot be reached right now.");
    }
    return site;
  }

  private async eligibleSites(candidates: readonly WaterSiteCandidate[]): Promise<WaterSiteCandidate[]> {
    const partners = candidates.flatMap((site) => site.partner
      ? [{ siteId: site.partner.siteId, kind: site.kind, position: site.partner.position } satisfies WaterSiteCandidate]
      : []);
    const surfaces = await this.surfacesFor([...candidates, ...partners]);
    const surfaceById = new Map<string, WaterSiteSurface>();
    [...candidates, ...partners].forEach((site, index) => surfaceById.set(site.siteId, surfaces[index] ?? "other"));
    return candidates.filter((site) =>
      isEligibleWaterSiteSurface(site.kind, surfaceById.get(site.siteId) ?? "other") &&
      (!site.partner || isEligibleWaterSiteSurface(site.kind, surfaceById.get(site.partner.siteId) ?? "other"))
    );
  }

  private async surfacesFor(sites: readonly WaterSiteCandidate[]): Promise<WaterSiteSurface[]> {
    const now = this.now();
    const surfaces = new Array<WaterSiteSurface>(sites.length).fill("other");
    const missing: number[] = [];
    sites.forEach((site, index) => {
      const cached = this.surfaceCache.get(site.siteId);
      if (cached && cached.expiresAt > now) surfaces[index] = cached.surface;
      else missing.push(index);
    });
    if (missing.length === 0 || !this.deps.worldLookup) return surfaces;
    try {
      const results = await this.deps.worldLookup.lookupGameplayEnvironments(
        missing.map((index) => sites[index]!.position),
        { caller: "other", priority: 1, cacheClass: "probationary", signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) }
      );
      missing.forEach((siteIndex, resultIndex) => {
        const result = results[resultIndex];
        const surface = classifyWaterSiteSurface(result);
        surfaces[siteIndex] = surface;
        if (result?.ok) this.remember(sites[siteIndex]!.siteId, surface, now);
      });
    } catch (error) {
      this.deps.logger.warn({ err: error, points: missing.length }, "water site lookup failed; sites hidden");
    }
    return surfaces;
  }

  private remember(siteId: string, surface: WaterSiteSurface, now: number): void {
    this.surfaceCache.delete(siteId);
    while (this.surfaceCache.size >= SURFACE_CACHE_MAX_ENTRIES) {
      const oldest = this.surfaceCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.surfaceCache.delete(oldest);
    }
    this.surfaceCache.set(siteId, { surface, expiresAt: now + SURFACE_CACHE_TTL_MS });
  }

  private async operationApplied(operationKey: string): Promise<boolean> {
    const result = await this.deps.pool.query("SELECT 1 FROM inventory_operations WHERE operation_key = $1", [operationKey]);
    return (result.rowCount ?? 0) > 0;
  }

  private async itemTotal(playerId: string, itemId: ResourceType): Promise<number> {
    const snapshot = await this.deps.inventory.getInventorySnapshot(playerId);
    return Number((snapshot.totals as Record<string, number | undefined>)[itemId] ?? 0);
  }
}

export function pearlDiveOperationKey(playerId: string, requestId: string): string {
  return `pearl-dive:${playerId}:${requestId}`;
}

export function whirlpoolOperationKey(playerId: string, requestId: string): string {
  return `whirlpool:${playerId}:${requestId}`;
}
