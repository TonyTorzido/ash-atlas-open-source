import {
  GOLEM_FORGE_PREFERRED_SLOT_LAYERS,
  distanceMeters,
  portalIds,
  worldDungeonEntranceLayersPass,
  worldZoneBiomeFromResolveIds,
  type DungeonCatalog,
  type DungeonEntranceDefinition,
  type DungeonEntranceSnapshot,
  type LatLon
} from "@ash-atlas/shared";
import type pg from "pg";

import type { WorldLookupClient } from "../world/worldLookupClient.js";
import { boundedPortalRevision } from "./locations/portalRevision.js";
import { packageIdForPosition } from "./spatialZones.js";
import { domainAt, domainsNear, domainSlot, type EqualAreaDomain } from "./waterSitePlacement.js";

/**
 * Golem Forge world sites (docs/design/GOLEM_FORGE_PLAN.md section 2), placed the way Drowned City sites
 * are (waterSitePlacement.ts): the sphere is cut into equal-area regions of GOLEM_FORGE_REGION_AREA_KM2
 * (5,000 km², so the median nearest Forge from a spot on land is about 30 km: the owner's distance
 * ladder, 2026-10-06), and each region
 * owns a deterministic list of candidate slots. One Forge is open per region: of the next GOLEM_FORGE_LAND_SEARCH_SLOTS slots from
 * the region's cycle, the first whose point is hill or mountain country in a dry or cold biome
 * (GOLEM_FORGE_PREFERRED_SLOT_LAYERS), else the first the authoritative World says is land. Nothing but the cycle and the collapse time is stored
 * (golem_forge_sites); a region with no row opens its first land slot from 0.
 *
 * Lifecycle: 24 h after its Forgemaster dies the Forge collapses (collapse_at); for the next hour the
 * entrance shows its collapsed art and admits nobody; then the region moves on to the next land slot,
 * which is a new entrance id and so a new instance with a fresh run. Every state is derived from the
 * persisted cycle and collapse_at against the clock, so a restart changes nothing.
 *
 * Region keys are `x<band>:<column>` (base 36). The first, 40,000 km² family (`<band>:<column>`,
 * before 2026-10-06) is retired: its entrance ids still resolve to their point (runs already inside
 * can leave, a recorded Forgemaster death still collapses and refunds) but it is never listed or
 * entered again, and its row goes inert (collapse_at cleared) once its collapsed hour is over. A
 * retired Forge that never collapsed is retired by the collapse sweep (retireLegacySite): its unused
 * paid admissions are refunded exactly like a collapse and its row records that the region moved on.
 */
export const GOLEM_FORGE_FAMILY = Object.freeze({ key: "forge2", targetAreaKm2: 5_000 });
/** The owner's ladder (2026-10-06): typical distance from a spot on land to the nearest Forge. */
export const GOLEM_FORGE_NEAREST_TARGET_M = 30_000;
/** The first (40,000 km²) family: resolvable by id only. */
export const LEGACY_GOLEM_FORGE_FAMILY = Object.freeze({ key: "forge", targetAreaKm2: 40_000 });
const REGION_KEY_PREFIX = "x";
export const GOLEM_FORGE_REGION_AREA_KM2 = GOLEM_FORGE_FAMILY.targetAreaKm2;
export const GOLEM_FORGE_COLLAPSE_DELAY_MS = 24 * 60 * 60 * 1_000;
export const GOLEM_FORGE_COLLAPSED_DISPLAY_MS = 60 * 60 * 1_000;
/** Slots searched per cycle; a region whose next this many slots are all water (open sea) has no Forge. */
export const GOLEM_FORGE_LAND_SEARCH_SLOTS = 16;

const SURFACE_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const SURFACE_CACHE_MAX_ENTRIES = 5_000;
const LOOKUP_TIMEOUT_MS = 2_500;
/** After World fails or refuses a slot lookup, no slot lookups for this long (World serves player overlays too). */
const LOOKUP_FAILURE_COOLDOWN_MS = 3 * 60_000;
/** Slot points this service may look up per minute (a region whose slots do not fit stays unknown, hidden, for now). */
const LOOKUP_POINTS_PER_MINUTE = 512;
const NEAR_CACHE_TTL_MS = 15_000;
const ENTRANCE_ID = /^golem_forge_([0-9a-z]{1,9})_([0-9a-z]{1,8})_([0-9a-z]{1,8})$/u;
const REGION_KEY = /^([0-9a-z]{1,9}):([0-9a-z]{1,8})$/u;
const b36 = (value: number): string => value.toString(36);

export type GolemForgeSiteState = "open" | "collapsed";
/** A candidate slot's surface: preferred hill/mountain land, other land, or water. */
export type GolemForgeSlotSurface = "preferred" | "land" | "water";
export type GolemForgeSite = Readonly<{
  regionKey: string;
  slot: number;
  entranceId: string;
  position: LatLon;
  state: GolemForgeSiteState;
  /** When the Forge collapses (24 h after its Forgemaster died), or null while it is untouched. */
  collapseAt: number | null;
}>;

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;
type SiteRow = { cycle: number; collapse_at: Date | string | null };

export function golemForgeRegionKey(domain: Pick<EqualAreaDomain, "band" | "column">): string {
  return `${REGION_KEY_PREFIX}${b36(domain.band)}:${b36(domain.column)}`;
}

/**
 * Whether a region key belongs to the retired 40,000 km² family. Its band part is plain base 36 below
 * 100 (at most "2r", and never "x" followed by more), so it can never be read as a current key.
 */
export function isLegacyGolemForgeRegionKey(regionKey: string): boolean {
  return regionDomainOf(regionKey)?.legacy === true;
}

export function golemForgeEntranceId(regionKey: string, slot: number): string {
  const [band, column] = regionKey.split(":");
  return `golem_forge_${band}_${column}_${b36(slot)}`;
}

export function parseGolemForgeEntranceId(entranceId: string): Readonly<{ regionKey: string; slot: number }> | null {
  const match = ENTRANCE_ID.exec(entranceId);
  if (!match) return null;
  const slot = Number.parseInt(match[3]!, 36);
  const regionKey = `${match[1]}:${match[2]}`;
  return Number.isSafeInteger(slot) && regionDomain(regionKey) ? { regionKey, slot } : null;
}

function regionDomainOf(regionKey: string): Readonly<{ domain: EqualAreaDomain; legacy: boolean }> | null {
  const match = REGION_KEY.exec(regionKey);
  if (!match) return null;
  const current = match[1]!.length > 1 && match[1]!.startsWith(REGION_KEY_PREFIX);
  const band = current ? match[1]!.slice(REGION_KEY_PREFIX.length) : match[1]!;
  if (!current && band.length > 8) return null;
  const domain = domainAt(current ? GOLEM_FORGE_FAMILY : LEGACY_GOLEM_FORGE_FAMILY, Number.parseInt(band, 36), Number.parseInt(match[2]!, 36));
  return domain && `${current ? REGION_KEY_PREFIX : ""}${b36(domain.band)}:${b36(domain.column)}` === regionKey
    ? { domain, legacy: !current } : null;
}

function regionDomain(regionKey: string): EqualAreaDomain | null {
  return regionDomainOf(regionKey)?.domain ?? null;
}

/** The deterministic point of one candidate slot of a region (land or not; retired regions too). */
export function golemForgeSlotPosition(regionKey: string, slot: number): LatLon | null {
  const region = regionDomainOf(regionKey);
  return region ? domainSlot(region.legacy ? LEGACY_GOLEM_FORGE_FAMILY : GOLEM_FORGE_FAMILY, region.domain, `slot:${slot}`) : null;
}

/**
 * The site lifecycle at `now` from the persisted row: open, collapsed (the hour after collapse_at), or
 * done (the region should move on to the slot after `slot`).
 */
export function golemForgeLifecycle(collapseAt: number | null, now: number): GolemForgeSiteState | "done" {
  if (collapseAt === null || now < collapseAt) return "open";
  return now < collapseAt + GOLEM_FORGE_COLLAPSED_DISPLAY_MS ? "collapsed" : "done";
}

export class GolemForgeSiteService {
  private readonly landCache = new Map<string, { surface: GolemForgeSlotSurface; expiresAt: number }>();
  /** No World slot lookups before this time. */
  private lookupBlockedUntil = 0;
  /** Slot lookup budget (points), refilled continuously up to one minute's worth. */
  private lookupBudget = Number.POSITIVE_INFINITY;
  private lookupBudgetAt = 0;
  /** Nearby-entrance listings only (entry and collapse always read the row). */
  private readonly nearCache = new Map<string, { site: GolemForgeSite | null; expiresAt: number }>();

  constructor(private readonly deps: Readonly<{
    pool: Queryable;
    worldLookup: Pick<WorldLookupClient, "lookupGameplayEnvironments"> | undefined;
    now?: () => number;
    /** Tests: decides land without World (true = land, not preferred). */
    isLand?: (position: LatLon) => boolean | null;
    /** Tests: decides the slot surface without World (wins over `isLand`). */
    slotSurface?: (position: LatLon) => GolemForgeSlotSurface | null;
    /** World slot points per minute (defaults to LOOKUP_POINTS_PER_MINUTE). */
    lookupPointsPerMinute?: number;
  }>) {}

  /** Spends `points` from the per-minute budget when it can cover them. */
  private takeLookupBudget(points: number): boolean {
    const now = this.now();
    const rate = this.deps.lookupPointsPerMinute ?? LOOKUP_POINTS_PER_MINUTE;
    if (rate === Number.POSITIVE_INFINITY) return true;
    this.lookupBudget = Math.min(rate, this.lookupBudget + Math.max(0, now - this.lookupBudgetAt) * rate / 60_000);
    this.lookupBudgetAt = now;
    if (this.lookupBudget < points) return false;
    this.lookupBudget -= points;
    return true;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * The region's current site, moving the region on first when its collapsed hour is over (a CAS on the
   * stored cycle, so concurrent readers move it once). Null when World cannot say where land is (fail
   * closed) or the region is open sea.
   */
  async site(regionKey: string, prefetched?: SiteRow | null): Promise<GolemForgeSite | null> {
    const region = regionDomainOf(regionKey);
    if (!region) return null;
    if (region.legacy) {
      // Retired family: never a site again. Once its collapsed hour is over the row goes inert.
      await this.deps.pool.query(
        `UPDATE golem_forge_sites SET collapse_at=NULL, updated_at=now()
          WHERE region_key=$1 AND collapse_at IS NOT NULL AND collapse_at <= $2`,
        [regionKey, new Date(this.now() - GOLEM_FORGE_COLLAPSED_DISPLAY_MS)]
      );
      return null;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = attempt === 0 && prefetched !== undefined ? prefetched ?? undefined : (await this.deps.pool.query<SiteRow>(
        "SELECT cycle,collapse_at FROM golem_forge_sites WHERE region_key=$1", [regionKey]
      )).rows[0];
      const cycle = Number(row?.cycle ?? 0);
      const collapseAt = row?.collapse_at ? new Date(row.collapse_at).getTime() : null;
      // A dying or collapsed Forge stays at the slot whose Forgemaster died (recorded as the cycle).
      const slot = collapseAt !== null ? cycle : await this.firstLandSlot(regionKey, cycle);
      if (slot === null) return null;
      const lifecycle = golemForgeLifecycle(collapseAt, this.now());
      if (lifecycle !== "done") {
        return { regionKey, slot, entranceId: golemForgeEntranceId(regionKey, slot),
          position: golemForgeSlotPosition(regionKey, slot)!, state: lifecycle, collapseAt };
      }
      await this.deps.pool.query(
        `UPDATE golem_forge_sites SET cycle=$3, collapse_at=NULL, updated_at=now()
          WHERE region_key=$1 AND cycle=$2 AND collapse_at IS NOT NULL`,
        [regionKey, cycle, slot + 1]
      );
    }
    return null;
  }

  async siteForEntrance(entranceId: string): Promise<GolemForgeSite | null> {
    const parsed = parseGolemForgeEntranceId(entranceId);
    if (!parsed) return null;
    const site = await this.site(parsed.regionKey);
    return site && site.slot === parsed.slot ? site : null;
  }

  /** Open or collapsed Forge sites within `radiusM` of `position`. */
  async sitesNear(position: LatLon, radiusM: number): Promise<GolemForgeSite[]> {
    const sites: GolemForgeSite[] = [];
    const regionKeys = domainsNear(GOLEM_FORGE_FAMILY, position, radiusM).map((domain) => golemForgeRegionKey(domain));
    // One read for every region the cache does not cover (900 km² regions: a dozen or more per listing).
    const stale = regionKeys.filter((regionKey) => !((this.nearCache.get(regionKey)?.expiresAt ?? 0) > this.now()));
    const rows = new Map<string, SiteRow>();
    if (stale.length > 0) {
      const result = await this.deps.pool.query<SiteRow & { region_key: string }>(
        "SELECT region_key,cycle,collapse_at FROM golem_forge_sites WHERE region_key = ANY($1::text[])", [stale]
      );
      for (const row of result.rows ?? []) rows.set(row.region_key, row);
    }
    for (const regionKey of regionKeys) {
      const cached = this.nearCache.get(regionKey);
      const site = cached && cached.expiresAt > this.now() ? cached.site : await this.site(regionKey, rows.get(regionKey) ?? null);
      if (!cached || cached.expiresAt <= this.now()) {
        if (this.nearCache.size >= SURFACE_CACHE_MAX_ENTRIES) this.nearCache.clear();
        this.nearCache.set(regionKey, { site, expiresAt: this.now() + NEAR_CACHE_TTL_MS });
      }
      if (site && distanceMeters(site.position, position) <= radiusM) sites.push(site);
    }
    return sites;
  }

  /**
   * The Forgemaster of this site died at `diedAt`: the Forge collapses 24 h later. Idempotent (an existing
   * collapse time is kept) and ignored for a site that is no longer the region's current one.
   */
  async recordForgemasterDeath(entranceId: string, diedAt: number): Promise<void> {
    const parsed = parseGolemForgeEntranceId(entranceId);
    if (!parsed) return;
    await this.deps.pool.query(
      `INSERT INTO golem_forge_sites (region_key,cycle,collapse_at) VALUES ($1,$2,$3)
       ON CONFLICT (region_key) DO UPDATE SET cycle=EXCLUDED.cycle, collapse_at=EXCLUDED.collapse_at, updated_at=now()
        WHERE golem_forge_sites.collapse_at IS NULL AND golem_forge_sites.cycle <= EXCLUDED.cycle`,
      [parsed.regionKey, parsed.slot, new Date(diedAt + GOLEM_FORGE_COLLAPSE_DELAY_MS)]
    );
  }

  /**
   * Retires a retired-family (40,000 km²) Forge that never collapsed: records the region as moved on
   * past this slot (an upsert, never a delete) and returns it as a collapsed site whose hour is over,
   * for collapseGolemForge to refund unused admissions, eject anyone inside to the gate and drop it.
   * Null for a current-family id, or when the row is mid-collapse (the normal collapse path owns it).
   * Safe to repeat: the row write is idempotent and refunds are marked per admission.
   */
  async retireLegacySite(entranceId: string): Promise<GolemForgeSite | null> {
    const parsed = parseGolemForgeEntranceId(entranceId);
    if (!parsed || !isLegacyGolemForgeRegionKey(parsed.regionKey)) return null;
    const result = await this.deps.pool.query<{ region_key: string }>(
      `INSERT INTO golem_forge_sites (region_key,cycle,collapse_at) VALUES ($1,$2,NULL)
       ON CONFLICT (region_key) DO UPDATE SET cycle=GREATEST(golem_forge_sites.cycle, EXCLUDED.cycle), updated_at=now()
        WHERE golem_forge_sites.collapse_at IS NULL
       RETURNING region_key`,
      [parsed.regionKey, parsed.slot + 1]
    );
    if (!result.rows?.[0]) return null;
    return { regionKey: parsed.regionKey, slot: parsed.slot, entranceId: golemForgeEntranceId(parsed.regionKey, parsed.slot),
      position: golemForgeSlotPosition(parsed.regionKey, parsed.slot)!, state: "collapsed",
      collapseAt: this.now() - GOLEM_FORGE_COLLAPSED_DISPLAY_MS };
  }

  /** Sites whose collapse time has passed (collapsed now, or due to move on): the collapse sweep's work. */
  async collapsedSites(): Promise<GolemForgeSite[]> {
    const rows = await this.deps.pool.query<{ region_key: string; cycle: number; collapse_at: Date | string }>(
      "SELECT region_key,cycle,collapse_at FROM golem_forge_sites WHERE collapse_at IS NOT NULL AND collapse_at <= $1",
      [new Date(this.now())]
    );
    return rows.rows.map((row) => {
      const slot = Number(row.cycle);
      return { regionKey: row.region_key, slot, entranceId: golemForgeEntranceId(row.region_key, slot),
        position: golemForgeSlotPosition(row.region_key, slot) ?? { lat: 0, lon: 0 },
        state: "collapsed" as const, collapseAt: new Date(row.collapse_at).getTime() };
    });
  }

  /** The first preferred slot of the search window, else its first land slot; null when World cannot say. */
  private async firstLandSlot(regionKey: string, from: number): Promise<number | null> {
    const slots = Array.from({ length: GOLEM_FORGE_LAND_SEARCH_SLOTS }, (_, index) => from + index);
    const surfaces = await this.slotSurfaces(regionKey, slots);
    let firstLand: number | null = null;
    for (const [index, surface] of surfaces.entries()) {
      // Fail closed: an unknown slot before the choice might have been the chosen one.
      if (surface === null) return null;
      if (surface === "preferred") return slots[index]!;
      if (surface === "land" && firstLand === null) firstLand = slots[index]!;
    }
    return firstLand;
  }

  private async slotSurfaces(regionKey: string, slots: readonly number[]): Promise<(GolemForgeSlotSurface | null)[]> {
    const positions = slots.map((slot) => golemForgeSlotPosition(regionKey, slot));
    if (positions.some((position) => position === null)) return slots.map(() => null);
    const test = this.deps.slotSurface ?? (this.deps.isLand
      ? (position: LatLon) => { const land = this.deps.isLand!(position); return land === null ? null : land ? "land" as const : "water" as const; }
      : null);
    if (test) return positions.map((position) => test(position!));
    const now = this.now();
    const surfaces = slots.map((slot) => {
      const cached = this.landCache.get(`${regionKey}:${slot}`);
      return cached && cached.expiresAt > now ? cached.surface : null;
    });
    const missing = surfaces.flatMap((surface, index) => surface === null ? [index] : []);
    if (missing.length === 0 || !this.deps.worldLookup || now < this.lookupBlockedUntil) return surfaces;
    // Over budget: stay unknown (fail closed, hidden) and try again on a later listing.
    if (!this.takeLookupBudget(missing.length)) return surfaces;
    let answered = 0;
    try {
      const results = await this.deps.worldLookup.lookupGameplayEnvironments(missing.map((index) => positions[index]!),
        { caller: "other", priority: 1, cacheClass: "probationary", signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
      missing.forEach((slotIndex, resultIndex) => {
        const result = results[resultIndex];
        if (!result || result.ok === false || (result.surfaceKind !== "land" && result.surfaceKind !== "water")) return;
        const position = positions[slotIndex]!;
        const surface: GolemForgeSlotSurface = result.surfaceKind === "water" ? "water"
          : worldDungeonEntranceLayersPass(GOLEM_FORGE_PREFERRED_SLOT_LAYERS, {
            isLand: true,
            terrainClass: result.terrainClass,
            landCoverClass: result.landCoverClass ?? null,
            elevationM: result.elevationM,
            biome: worldZoneBiomeFromResolveIds(result.biomeId, result.ecoregionId, position.lat),
            isCoastal: result.isCoastal ?? null
          }) ? "preferred" : "land";
        surfaces[slotIndex] = surface;
        answered += 1;
        if (this.landCache.size >= SURFACE_CACHE_MAX_ENTRIES) this.landCache.clear();
        this.landCache.set(`${regionKey}:${slots[slotIndex]}`, { surface, expiresAt: now + SURFACE_CACHE_TTL_MS });
      });
    } catch {
      // Unknown slots stay null (fail closed).
    }
    if (answered === 0) this.lookupBlockedUntil = now + LOOKUP_FAILURE_COOLDOWN_MS;
    return surfaces;
  }
}

/** The library entrance every site uses (retired, so never placed by itself). */
export const GOLEM_FORGE_ENTRANCE_TEMPLATE_ID = "golem_forge_world_entrance";
export const GOLEM_FORGE_COLLAPSED_ASSET_KEY = "apps/client/public/assets/dungeons/golem_forge/entrance-collapsed.png";
const GOLEM_FORGE_SITE_PLACEMENT_VERSION = "golem-forge-sites-v1";

/** The template entrance placed at a site's slot, or null when the id is not a Golem Forge site. */
export function golemForgeSiteEntrance(catalog: DungeonCatalog, entranceId: string): DungeonEntranceDefinition | null {
  const parsed = parseGolemForgeEntranceId(entranceId);
  const position = parsed ? golemForgeSlotPosition(parsed.regionKey, parsed.slot) : null;
  const template = catalog.entrances.find((candidate) => candidate.id === GOLEM_FORGE_ENTRANCE_TEMPLATE_ID);
  if (!position || !template || !catalog.dungeons.some((dungeon) => dungeon.id === template.dungeonId && !dungeon.retired)) return null;
  return { ...template, id: entranceId, retired: false, lat: position.lat, lon: position.lon };
}

export function golemForgeSitePortalRevision(catalog: DungeonCatalog, entrance: DungeonEntranceDefinition): string {
  const dungeon = catalog.dungeons.find((candidate) => candidate.id === entrance.dungeonId);
  return boundedPortalRevision(`${GOLEM_FORGE_SITE_PLACEMENT_VERSION}:${entrance.revision}:${entrance.portalRevision}:${dungeon?.revision ?? ""}`);
}

/** A site's world entrance; a collapsed site shows its rubble art and says it cannot be entered. */
export function golemForgeEntranceSnapshot(
  catalog: DungeonCatalog,
  entranceId: string,
  state: GolemForgeSiteState = "open"
): DungeonEntranceSnapshot | null {
  const entrance = golemForgeSiteEntrance(catalog, entranceId);
  if (!entrance) return null;
  const dungeon = catalog.dungeons.find((candidate) => candidate.id === entrance.dungeonId);
  const collapsed = state === "collapsed";
  return {
    entranceId: entrance.id,
    dungeonId: entrance.dungeonId,
    portalId: portalIds.dungeon(entrance.id, entrance.portalId),
    portalRevision: golemForgeSitePortalRevision(catalog, entrance),
    interactionLabel: collapsed ? "Collapsed" : entrance.interactionLabel,
    name: collapsed ? `${entrance.name} (collapsed)` : entrance.name,
    description: collapsed
      ? "The Golem Forge has collapsed into rubble. A new one opens elsewhere in the region within the hour."
      : entrance.description,
    regionCode: packageIdForPosition({ lat: entrance.lat, lon: entrance.lon }),
    lat: entrance.lat,
    lon: entrance.lon,
    interactionRadiusM: entrance.interactionRadiusM,
    footprintRadiusM: entrance.footprintRadiusM,
    presentation: entrance.presentation,
    assetKey: collapsed ? GOLEM_FORGE_COLLAPSED_ASSET_KEY : entrance.assetKey,
    templateId: GOLEM_FORGE_ENTRANCE_TEMPLATE_ID,
    ...(dungeon?.access ? { access: structuredClone(dungeon.access) } : {})
  };
}
