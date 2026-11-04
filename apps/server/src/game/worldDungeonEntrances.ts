import {
  WORLD_DUNGEON_ENTRANCE_LIFETIME_MS,
  WORLD_DUNGEON_ENTRANCE_RULES,
  destinationPoint,
  distanceMeters,
  portalIds,
  worldDungeonEntranceLayersPass,
  worldDungeonEntranceMaxMultiplier,
  worldDungeonEntranceRule,
  worldDungeonEntranceSeasonMultiplier,
  worldDungeonEntranceVisibleAt,
  worldSeasonAt,
  worldZoneBiomeFromResolveIds,
  worldZoneElevationBandFromMeters,
  type DungeonCatalog,
  type DungeonEntranceDefinition,
  type DungeonEntranceSnapshot,
  type LatLon,
  type WorldDungeonEntranceEnvironment,
  type WorldDungeonEntranceRule,
  type WorldZoneBiome
} from "@ash-atlas/shared";

import type { WorldLookupClient } from "../world/worldLookupClient.js";
import { boundedPortalRevision } from "./locations/portalRevision.js";
import { deterministicUnit } from "./populationZonesV2Identity.js";
import { packageIdForPosition } from "./spatialZones.js";
import { domainAt, domainsNear, domainSlot, type EqualAreaDomain } from "./waterSitePlacement.js";

/**
 * Rolled world entrances of the ladder dungeons (docs/design/WORLD_DUNGEON_ENTRANCES.md). Stateless:
 * the sphere is cut into equal-area cells per dungeon (rate / max season multiplier km²); every cell
 * owns one deterministic slot per 7-day rotation. A slot is an entrance when its season roll is live,
 * its World environment passes the dungeon's layers (shared WORLD_DUNGEON_ENTRANCE_RULES) and no
 * qualifying slot of the same dungeon and rotation with a lower mark stands within the dungeon's
 * `spacingM`.
 *
 * All cells of one dungeon rotate together (each dungeon has its own phase, so the five dungeons
 * never move at once): with one shared rotation the spacing rule is a plain lower-mark-wins check
 * between same-rotation slots, which never chains and never lets two live entrances of a dungeon
 * stand closer than its spacing. Nothing is stored; unknown World answers fail closed.
 *
 * Ids are `wd2_<band>_<column>_<rotation>_<dungeon>` (the distance-ladder cells). The first cells
 * (`wde_`, before 2026-10-06) still resolve by id for runs already inside, but never stand again.
 */
export const WORLD_DUNGEON_ENTRANCE_PLACEMENT_VERSION = "world-dungeon-entrances-v1";

const LOOKUP_TIMEOUT_MS = 4_000;
const LOOKUP_BATCH = 256;
const CACHE_MAX_ENTRIES = 100_000;
const UNKNOWN_RETRY_MS = 10 * 60_000;
/**
 * World is shared with player-facing overlays and must never be crowded out by entrance rolls: lookups
 * are serialized, spend from a points-per-minute budget, and pause after any failed or refused chunk.
 * Slots not looked up yet stay unknown (hidden) and fill in over the following minutes.
 */
const LOOKUP_POINTS_PER_MINUTE = 512;
const LOOKUP_FAILURE_COOLDOWN_MS = 3 * 60_000;
/** The city-distance rings: this many points on each of the half- and full-distance circles. */
const CITY_RING_POINTS = 8;
const ENTRANCE_ID = /^(wde|wd2)_([0-9a-z]{1,8})_([0-9a-z]{1,8})_([0-9a-z]{1,8})_([a-z][a-z0-9_]{0,63})$/u;
const ENTRANCE_ID_PREFIX = "wd2";
/** The first (`wde_`) cell sizes by dungeon, before the distance ladder: resolvable by id only. */
const LEGACY_TARGET_AREA_KM2: Readonly<Record<string, number>> = Object.freeze({
  fangrock_cavern: 25, the_eyrie: 40, blightwood_grove: 60, still_hand_monastery: 120, wyrm_hollow: 200
});
const b36 = (value: number): string => value.toString(36);

export type WorldDungeonEntranceCandidate = Readonly<{
  entranceId: string;
  dungeonId: string;
  domain: EqualAreaDomain;
  rotation: number;
  position: LatLon;
  spawnAt: number;
  expiresAt: number;
  /** The slot's season roll: live when below multiplier(season) / max multiplier. */
  seasonUnit: number;
  /** The spacing tie-break: within the dungeon's spacing the qualifying slot with the lowest mark stands. */
  mark: number;
  /** A first-family (`wde_`) id: resolves for runs already inside but never stands. */
  legacy: boolean;
}>;

export type WorldDungeonEntranceSite = Readonly<{
  entranceId: string;
  dungeonId: string;
  position: LatLon;
  spawnAt: number;
  expiresAt: number;
  /** Shown at this instant (its day phases); a hidden entrance still exists and still blocks others. */
  visible: boolean;
}>;

/** World facts for many points (null where World did not answer). */
export type WorldDungeonEntranceLookup = Readonly<{
  environments(points: readonly LatLon[]): Promise<readonly (WorldDungeonEntranceEnvironment | null)[]>;
  insideCity(points: readonly LatLon[]): Promise<readonly (boolean | null)[]>;
}>;

export function worldDungeonEntranceFamily(rule: WorldDungeonEntranceRule, legacy = false) {
  return Object.freeze({
    key: legacy ? `wde-${rule.dungeonId}` : `wd2-${rule.dungeonId}`,
    targetAreaKm2: (legacy ? LEGACY_TARGET_AREA_KM2[rule.dungeonId] ?? rule.targetAreaKm2 : rule.targetAreaKm2) /
      worldDungeonEntranceMaxMultiplier(rule)
  });
}

/** The dungeon's rotation phase: every cell of a dungeon moves at the same instant. */
export function worldDungeonEntrancePhaseMs(rule: Pick<WorldDungeonEntranceRule, "dungeonId">): number {
  return Math.floor(WORLD_DUNGEON_ENTRANCE_LIFETIME_MS *
    deterministicUnit(WORLD_DUNGEON_ENTRANCE_PLACEMENT_VERSION, rule.dungeonId, "phase"));
}

/** The dungeon's rotation standing at `instant`. */
export function worldDungeonEntranceRotationAt(rule: Pick<WorldDungeonEntranceRule, "dungeonId">, instant: number): number {
  return Math.max(0, Math.floor((instant - worldDungeonEntrancePhaseMs(rule)) / WORLD_DUNGEON_ENTRANCE_LIFETIME_MS));
}

export function worldDungeonEntranceCandidate(
  rule: WorldDungeonEntranceRule,
  domain: EqualAreaDomain,
  rotation: number,
  legacy = false
): WorldDungeonEntranceCandidate {
  const spawnAt = rotation * WORLD_DUNGEON_ENTRANCE_LIFETIME_MS + worldDungeonEntrancePhaseMs(rule);
  const prefix = legacy ? "wde" : ENTRANCE_ID_PREFIX;
  return {
    entranceId: `${prefix}_${b36(domain.band)}_${b36(domain.column)}_${b36(rotation)}_${rule.dungeonId}`,
    dungeonId: rule.dungeonId,
    domain,
    rotation,
    position: domainSlot(worldDungeonEntranceFamily(rule, legacy), domain, `rotation:${rotation}`),
    spawnAt,
    expiresAt: spawnAt + WORLD_DUNGEON_ENTRANCE_LIFETIME_MS,
    seasonUnit: deterministicUnit(WORLD_DUNGEON_ENTRANCE_PLACEMENT_VERSION, rule.dungeonId, domain.band, domain.column, rotation, "season"),
    mark: deterministicUnit(WORLD_DUNGEON_ENTRANCE_PLACEMENT_VERSION, rule.dungeonId, domain.band, domain.column, rotation, "mark"),
    legacy
  };
}


export function parseWorldDungeonEntranceId(entranceId: string): WorldDungeonEntranceCandidate | null {
  const match = ENTRANCE_ID.exec(entranceId);
  if (!match) return null;
  const rule = worldDungeonEntranceRule(match[5]!);
  if (!rule) return null;
  const legacy = match[1] === "wde";
  const [band, column, rotation] = [match[2]!, match[3]!, match[4]!].map((value) => Number.parseInt(value, 36));
  const domain = domainAt(worldDungeonEntranceFamily(rule, legacy), band!, column!);
  if (!domain || !Number.isSafeInteger(rotation)) return null;
  const candidate = worldDungeonEntranceCandidate(rule, domain, rotation!, legacy);
  return candidate.entranceId === entranceId ? candidate : null;
}

/**
 * Whether the slot's season roll is live: the season at its place when it spawned (fixed for its
 * whole life). `elevationM`/`biome` refine the season; without them the latitude-only season is a
 * superset (highland and Frozen Waste only ever turn a season into winter).
 */
export function worldDungeonEntranceSeasonLive(
  rule: WorldDungeonEntranceRule,
  candidate: Pick<WorldDungeonEntranceCandidate, "position" | "spawnAt" | "seasonUnit">,
  elevationM?: number | null,
  biome?: WorldZoneBiome | null
): boolean {
  const { season } = worldSeasonAt({
    latitude: candidate.position.lat,
    date: new Date(candidate.spawnAt),
    ...(typeof elevationM === "number" && Number.isFinite(elevationM)
      ? { elevationBand: worldZoneElevationBandFromMeters(elevationM) } : {}),
    ...(biome ? { biome } : {})
  });
  return candidate.seasonUnit < worldDungeonEntranceSeasonMultiplier(rule, season) / worldDungeonEntranceMaxMultiplier(rule);
}

/** Two rings (half and full distance) of points around a slot for the city-distance test. */
export function worldDungeonEntranceCityRing(center: LatLon, distanceM: number): LatLon[] {
  const points: LatLon[] = [];
  for (const ring of [distanceM / 2, distanceM]) {
    for (let index = 0; index < CITY_RING_POINTS; index += 1) {
      points.push(destinationPoint(center, ring, (360 / CITY_RING_POINTS) * index + (ring === distanceM ? 0 : 22.5)));
    }
  }
  return points;
}

/** The library entrance placed at a rolled slot, or null when the id is not a rolled entrance. */
export function worldDungeonEntranceAt(catalog: DungeonCatalog, entranceId: string): DungeonEntranceDefinition | null {
  const candidate = parseWorldDungeonEntranceId(entranceId);
  const rule = candidate ? worldDungeonEntranceRule(candidate.dungeonId) : null;
  const template = rule ? catalog.entrances.find((entrance) => entrance.id === rule.templateEntranceId) : undefined;
  if (!candidate || !template || template.dungeonId !== candidate.dungeonId ||
      !catalog.dungeons.some((dungeon) => dungeon.id === template.dungeonId && !dungeon.retired)) return null;
  return { ...template, id: entranceId, retired: false, lat: candidate.position.lat, lon: candidate.position.lon };
}

export function worldDungeonEntrancePortalRevision(catalog: DungeonCatalog, entrance: DungeonEntranceDefinition): string {
  const dungeon = catalog.dungeons.find((candidate) => candidate.id === entrance.dungeonId);
  return boundedPortalRevision(
    `${WORLD_DUNGEON_ENTRANCE_PLACEMENT_VERSION}:${entrance.revision}:${entrance.portalRevision}:${dungeon?.revision ?? ""}`);
}

export function worldDungeonEntranceSnapshot(catalog: DungeonCatalog, entranceId: string): DungeonEntranceSnapshot | null {
  const entrance = worldDungeonEntranceAt(catalog, entranceId);
  const candidate = parseWorldDungeonEntranceId(entranceId);
  if (!entrance || !candidate) return null;
  const dungeon = catalog.dungeons.find((entry) => entry.id === entrance.dungeonId);
  const rule = worldDungeonEntranceRule(entrance.dungeonId)!;
  return {
    entranceId: entrance.id,
    dungeonId: entrance.dungeonId,
    portalId: portalIds.dungeon(entrance.id, entrance.portalId),
    portalRevision: worldDungeonEntrancePortalRevision(catalog, entrance),
    interactionLabel: entrance.interactionLabel,
    name: entrance.name,
    description: entrance.description,
    regionCode: packageIdForPosition(candidate.position),
    lat: entrance.lat,
    lon: entrance.lon,
    interactionRadiusM: entrance.interactionRadiusM,
    footprintRadiusM: entrance.footprintRadiusM,
    presentation: entrance.presentation,
    assetKey: entrance.assetKey,
    templateId: rule.templateEntranceId,
    createdAt: new Date(candidate.spawnAt).toISOString(),
    ...(dungeon?.access ? { access: structuredClone(dungeon.access) } : {})
  };
}

/** Production World facts: gameplay environments (cached, admitted) and the city test from lookup-batch. */
export function worldDungeonEntranceLookupFromWorld(
  worldLookup: Pick<WorldLookupClient, "lookupGameplayEnvironments" | "lookupMany">
): WorldDungeonEntranceLookup {
  return {
    async environments(points) {
      const results = await worldLookup.lookupGameplayEnvironments(points,
        { caller: "other", priority: 1, cacheClass: "probationary", signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
      return points.map((point, index) => {
        const result = results[index];
        if (!result || result.ok === false) return null;
        return {
          isLand: result.surfaceKind === "land" ? true : result.surfaceKind === "water" ? false : result.isLand ?? null,
          terrainClass: result.terrainClass,
          landCoverClass: result.landCoverClass ?? null,
          elevationM: result.elevationM,
          biome: worldZoneBiomeFromResolveIds(result.biomeId, result.ecoregionId, point.lat),
          isCoastal: result.isCoastal ?? null
        };
      });
    },
    async insideCity(points) {
      const results = await worldLookup.lookupMany(points, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
      return results.map((result) => result.ok ? result.insideCity ?? null : null);
    }
  };
}

export class WorldDungeonEntranceService {
  /** Whether each slot qualifies (season, layers, city distance). */
  private readonly qualified = new Map<string, { value: boolean; expiresAt: number }>();
  /** Slots World could not answer for, and when to ask again. */
  private readonly unknownUntil = new Map<string, number>();
  /** Lookup budget (points), refilled continuously up to one minute's worth. */
  private lookupBudget = Number.POSITIVE_INFINITY;
  private lookupBudgetAt = 0;
  /** No World lookups before this time (set after a failed or refused chunk). */
  private lookupBlockedUntil = 0;
  /** Serializes World lookups across concurrent callers. */
  private lookupQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: Readonly<{
    lookup: WorldDungeonEntranceLookup | undefined;
    now?: () => number;
    rules?: readonly WorldDungeonEntranceRule[];
    /** World points this service may look up per minute (defaults to LOOKUP_POINTS_PER_MINUTE). */
    lookupPointsPerMinute?: number;
  }>) {}

  private lookupRate(): number {
    return this.deps.lookupPointsPerMinute ?? LOOKUP_POINTS_PER_MINUTE;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private rules(): readonly WorldDungeonEntranceRule[] {
    return this.deps.rules ?? WORLD_DUNGEON_ENTRANCE_RULES;
  }

  /**
   * Every rolled entrance standing within `radiusM` of `position` now, hidden ones included (marked
   * `visible: false`): the nearby list shows only visible ones, the developer readout shows both.
   */
  async sitesNear(position: LatLon, radiusM: number): Promise<WorldDungeonEntranceSite[]> {
    const now = this.now();
    const sites: WorldDungeonEntranceSite[] = [];
    for (const rule of this.rules()) {
      const family = worldDungeonEntranceFamily(rule);
      const domains = domainsNear(family, position, radiusM + rule.spacingM);
      const rotation = worldDungeonEntranceRotationAt(rule, now);
      const targets = domains
        .map((domain) => worldDungeonEntranceCandidate(rule, domain, rotation))
        .filter((candidate) => now >= candidate.spawnAt && distanceMeters(candidate.position, position) <= radiusM);
      for (const candidate of await this.survivors(rule, targets, domains)) sites.push(this.site(rule, candidate, now));
    }
    return sites.sort((left, right) => left.entranceId.localeCompare(right.entranceId));
  }

  /**
   * World environments for a few points through this service's budget and failure pause (null where
   * World did not answer or the budget is spent). The Fallen Prison landing check uses it.
   */
  async environmentsAt(points: readonly LatLon[]): Promise<(WorldDungeonEntranceEnvironment | null)[]> {
    if (!this.deps.lookup || points.length === 0) return points.map(() => null);
    return this.lookupChunks(points, (chunk) => this.deps.lookup!.environments(chunk));
  }

  /** The rolled entrance with this id when it stands now (visible or hidden), else null. */
  async siteForEntrance(entranceId: string): Promise<WorldDungeonEntranceSite | null> {
    const candidate = parseWorldDungeonEntranceId(entranceId);
    const rule = candidate ? this.rules().find((entry) => entry.dungeonId === candidate.dungeonId) : undefined;
    const now = this.now();
    if (!candidate || candidate.legacy || !rule || now < candidate.spawnAt || now >= candidate.expiresAt) return null;
    const domains = domainsNear(worldDungeonEntranceFamily(rule), candidate.position, rule.spacingM);
    const [survivor] = await this.survivors(rule, [candidate], domains);
    return survivor ? this.site(rule, survivor, now) : null;
  }

  private site(rule: WorldDungeonEntranceRule, candidate: WorldDungeonEntranceCandidate, now: number): WorldDungeonEntranceSite {
    return {
      entranceId: candidate.entranceId,
      dungeonId: candidate.dungeonId,
      position: candidate.position,
      spawnAt: candidate.spawnAt,
      expiresAt: candidate.expiresAt,
      visible: worldDungeonEntranceVisibleAt(rule.visiblePhases, now)
    };
  }

  /**
   * The targets that qualify and are not suppressed: a target falls to any qualifying slot of the
   * same dungeon and rotation with a lower mark within the dungeon's spacing (a suppressed slot still
   * counts, so the check never chains). `domains` must cover the spacing around every target.
   */
  private async survivors(
    rule: WorldDungeonEntranceRule,
    targets: readonly WorldDungeonEntranceCandidate[],
    domains: readonly EqualAreaDomain[]
  ): Promise<WorldDungeonEntranceCandidate[]> {
    if (targets.length === 0) return [];
    const targetQualified = await this.qualify(rule, targets);
    const qualifying = targets.filter((target) => targetQualified.get(target.entranceId) === true);
    const blockersByTarget = new Map<string, WorldDungeonEntranceCandidate[]>();
    const allBlockers = new Map<string, WorldDungeonEntranceCandidate>();
    // Every target shares one rotation per call (sitesNear) or is alone (siteForEntrance): hash each cell once.
    const neighboursByRotation = new Map<number, WorldDungeonEntranceCandidate[]>();
    const neighboursAt = (rotation: number) => {
      let list = neighboursByRotation.get(rotation);
      if (!list) {
        list = domains.map((domain) => worldDungeonEntranceCandidate(rule, domain, rotation));
        neighboursByRotation.set(rotation, list);
      }
      return list;
    };
    for (const target of qualifying) {
      const blockers: WorldDungeonEntranceCandidate[] = [];
      for (const neighbour of neighboursAt(target.rotation)) {
        if (neighbour.entranceId === target.entranceId) continue;
        const lower = neighbour.mark < target.mark ||
          (neighbour.mark === target.mark && neighbour.entranceId < target.entranceId);
        if (!lower || distanceMeters(neighbour.position, target.position) > rule.spacingM) continue;
        blockers.push(neighbour);
        allBlockers.set(neighbour.entranceId, neighbour);
      }
      blockersByTarget.set(target.entranceId, blockers);
    }
    const blockerQualified = await this.qualify(rule, [...allBlockers.values()]);
    return qualifying.filter((target) => (blockersByTarget.get(target.entranceId) ?? []).every((blocker) => {
      const value = blockerQualified.get(blocker.entranceId);
      // An unknown neighbour might be the one that stands: fail closed.
      return value === false;
    }));
  }

  /** Qualification per slot: true, false, or null (World did not answer; retried after a short backoff). */
  private async qualify(
    rule: WorldDungeonEntranceRule,
    candidates: readonly WorldDungeonEntranceCandidate[]
  ): Promise<Map<string, boolean | null>> {
    const now = this.now();
    const values = new Map<string, boolean | null>();
    const missing: WorldDungeonEntranceCandidate[] = [];
    for (const candidate of candidates) {
      const cached = this.qualified.get(candidate.entranceId);
      if (cached && cached.expiresAt > now) values.set(candidate.entranceId, cached.value);
      else if ((this.unknownUntil.get(candidate.entranceId) ?? 0) > now) values.set(candidate.entranceId, null);
      else if (!worldDungeonEntranceSeasonLive(rule, candidate)) values.set(candidate.entranceId, false);
      else if (!values.has(candidate.entranceId)) { values.set(candidate.entranceId, null); missing.push(candidate); }
    }
    if (missing.length === 0 || !this.deps.lookup) return values;
    const environments = await this.lookupChunks(missing.map((candidate) => candidate.position),
      (points) => this.deps.lookup!.environments(points));
    const needCity: WorldDungeonEntranceCandidate[] = [];
    missing.forEach((candidate, index) => {
      const environment = environments[index];
      if (!environment) return;
      const passes = worldDungeonEntranceSeasonLive(rule, candidate, environment.elevationM, environment.biome) &&
        worldDungeonEntranceLayersPass(rule.layers, environment);
      if (passes && rule.layers.minCityDistanceM !== undefined) needCity.push(candidate);
      else this.remember(values, candidate, passes);
    });
    if (needCity.length > 0) {
      const distanceM = rule.layers.minCityDistanceM!;
      const pointsPer = 1 + CITY_RING_POINTS * 2;
      const points = needCity.flatMap((candidate) => [candidate.position, ...worldDungeonEntranceCityRing(candidate.position, distanceM)]);
      const inside = await this.lookupChunks(points, (chunk) => this.deps.lookup!.insideCity(chunk), pointsPer);
      needCity.forEach((candidate, index) => {
        const answers = inside.slice(index * pointsPer, (index + 1) * pointsPer);
        if (answers.some((answer) => answer === true)) this.remember(values, candidate, false);
        else if (answers.every((answer) => answer === false)) this.remember(values, candidate, true);
      });
    }
    // World did not answer: stay unknown (fail closed) without asking again on every nearby refresh.
    if (this.unknownUntil.size >= CACHE_MAX_ENTRIES) this.unknownUntil.clear();
    for (const candidate of missing) {
      if (values.get(candidate.entranceId) === null) this.unknownUntil.set(candidate.entranceId, now + UNKNOWN_RETRY_MS);
    }
    return values;
  }

  private remember(values: Map<string, boolean | null>, candidate: WorldDungeonEntranceCandidate, value: boolean): void {
    values.set(candidate.entranceId, value);
    if (this.qualified.size >= CACHE_MAX_ENTRIES) this.qualified.clear();
    this.qualified.set(candidate.entranceId, { value, expiresAt: candidate.expiresAt });
  }

  /** Spends `points` from the per-minute budget when it can cover them. */
  private takeLookupBudget(points: number): boolean {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lookupBudgetAt);
    const rate = this.lookupRate();
    if (now < this.lookupBlockedUntil) return false;
    if (rate === Number.POSITIVE_INFINITY) return true;
    this.lookupBudget = Math.min(rate, this.lookupBudget + elapsed * rate / 60_000);
    this.lookupBudgetAt = now;
    if (now < this.lookupBlockedUntil || this.lookupBudget < points) return false;
    this.lookupBudget -= points;
    return true;
  }

  /**
   * Looks points up in chunks, one caller at a time, within the lookup budget. A chunk that fails,
   * is refused or is over budget answers null for its points (and every later chunk of the call);
   * a failure also pauses all lookups for LOOKUP_FAILURE_COOLDOWN_MS.
   */
  private lookupChunks<T>(
    points: readonly LatLon[],
    lookup: (chunk: readonly LatLon[]) => Promise<readonly (T | null)[]>,
    groupSize = 1
  ): Promise<(T | null)[]> {
    const run = async (): Promise<(T | null)[]> => {
      const size = Math.max(groupSize, Math.floor(LOOKUP_BATCH / groupSize) * groupSize);
      const results: (T | null)[] = [];
      let stopped = false;
      for (let offset = 0; offset < points.length; offset += size) {
        const chunk = points.slice(offset, offset + size);
        if (!stopped && !this.takeLookupBudget(chunk.length)) stopped = true;
        if (stopped) {
          for (let index = 0; index < chunk.length; index += 1) results.push(null);
          continue;
        }
        try {
          const answers = await lookup(chunk);
          let answered = 0;
          for (let index = 0; index < chunk.length; index += 1) {
            const answer = answers[index] ?? null;
            if (answer !== null) answered += 1;
            results.push(answer);
          }
          if (answered === 0) throw new Error("World answered no points");
        } catch {
          for (let index = results.length; index < offset + chunk.length; index += 1) results.push(null);
          this.lookupBlockedUntil = this.now() + LOOKUP_FAILURE_COOLDOWN_MS;
          stopped = true;
        }
      }
      return results;
    };
    const next = this.lookupQueue.then(run, run);
    this.lookupQueue = next.catch(() => undefined);
    return next;
  }
}
