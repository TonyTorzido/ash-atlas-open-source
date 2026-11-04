import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  biomeDiscoveryCelebration,
  isWorldZoneDiscoverableBiome,
  type BiomeDiscoveryCelebration,
  parseWorldZoneLookup,
  resolveWorldZone,
  type WorldZoneBiome,
  type LatLon,
  type WorldZoneDiscoverableBiome,
  type WorldZoneEnvironmentFacts,
  type WorldZoneLookup,
  type WorldZoneResolution
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppLogger } from "../logger.js";

const LOOKUP_ASSET_PATH = "src/assets/world-environment-overlays/world-zone-lookup-v1.bin";
/** Within this window a player's request repeats the last result instead of resolving again. */
export const BIOME_DISCOVERY_MIN_INTERVAL_MS = 2_000;
const RATE_LIMIT_PRUNE_SIZE = 4_096;
const WATER_BIOMES = new Set<string>(["lake", "coast", "open_ocean"]);

export type BiomeDiscoveryResult = Readonly<{
  biomes: WorldZoneDiscoverableBiome[];
  newlyDiscovered: WorldZoneDiscoverableBiome | null;
  /** Set with `newlyDiscovered`: the Legends this first discovery completed. */
  celebration: BiomeDiscoveryCelebration | null;
  current: WorldZoneResolution | null;
}>;

/** The part of WorldLookupClient discovery needs (one cached gameplay-environment point). */
export type BiomeDiscoveryWorld = Readonly<{
  lookupGameplayEnvironment(lat: number, lon: number): Promise<WorldZoneEnvironmentFacts>;
}>;

/** The part of LegendJournalService a first discovery needs to award its Legends. */
export type BiomeDiscoveryLegends = Readonly<{
  snapshot(playerId: string): Promise<{ newlyCompletedIds: readonly string[] }>;
}>;

/** Production runs from the repository root; development runs from apps/server. */
export function worldZoneLookupCandidates(workingDirectory = process.cwd()): string[] {
  return [
    resolve(workingDirectory, "apps/client", LOOKUP_ASSET_PATH),
    resolve(workingDirectory, "../client", LOOKUP_ASSET_PATH)
  ];
}

/** Reads the bundled client lookup once. Null disables discovery; nothing else depends on it. */
export function loadWorldZoneLookupFromDisk(
  logger: Pick<AppLogger, "warn">,
  candidates = worldZoneLookupCandidates()
): WorldZoneLookup | null {
  for (const candidate of candidates) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(candidate);
    } catch {
      continue;
    }
    try {
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return parseWorldZoneLookup(buffer);
    } catch (error) {
      logger.warn({ err: error, path: candidate }, "world zone lookup is unreadable; biome discovery disabled");
      return null;
    }
  }
  logger.warn({ candidates }, "world zone lookup not found; biome discovery disabled");
  return null;
}

export class BiomeDiscoveryService {
  private readonly lastRequests = new Map<string, { at: number; result: Promise<BiomeDiscoveryResult> }>();

  constructor(
    private readonly pool: Pick<pg.Pool, "query">,
    private readonly lookup: WorldZoneLookup | null,
    private readonly world: BiomeDiscoveryWorld | null = null,
    private readonly now: () => number = Date.now,
    private readonly legends: BiomeDiscoveryLegends | null = null
  ) {}

  /**
   * Resolves the zone at the player's authoritative open-world position (null outside the open
   * world), records a first discovery, and returns the player's discoveries. Requests within
   * BIOME_DISCOVERY_MIN_INTERVAL_MS share the previous result without touching the database.
   * Returns null only when the lookup is unavailable.
   */
  discover(playerId: string, openWorldPosition: LatLon | null): Promise<BiomeDiscoveryResult | null> {
    if (!this.lookup) return Promise.resolve(null);
    const now = this.now();
    const last = this.lastRequests.get(playerId);
    if (last && now - last.at < BIOME_DISCOVERY_MIN_INTERVAL_MS) return last.result;
    const result = this.resolve(this.lookup, playerId, openWorldPosition);
    this.rememberRequest(playerId, now, result);
    return result;
  }

  private async resolve(
    lookup: WorldZoneLookup,
    playerId: string,
    position: LatLon | null
  ): Promise<BiomeDiscoveryResult> {
    const current = position
      ? resolveWorldZone(lookup, position, await this.environmentAt(position))
      : null;
    let newlyDiscovered: WorldZoneDiscoverableBiome | null = null;
    const biome = current?.biome;
    // Water discoveries need World authority; the cooked grid's coarse water is never recorded.
    const recordable = biome !== undefined
      && isWorldZoneDiscoverableBiome(biome)
      && (current!.authority === "world" || !WATER_BIOMES.has(biome));
    if (recordable) {
      const inserted = await this.pool.query(
        `INSERT INTO player_biome_discoveries (player_id,biome_id) VALUES ($1,$2)
         ON CONFLICT DO NOTHING RETURNING biome_id`,
        [playerId, biome]
      );
      if ((inserted.rowCount ?? 0) > 0) newlyDiscovered = biome;
    }
    // Only the request whose INSERT won evaluates Legends; the common no-discovery path stays cheap.
    const celebration = newlyDiscovered ? await this.celebrate(playerId, newlyDiscovered) : null;
    const rows = await this.pool.query<{ biome_id: string }>(
      `SELECT biome_id FROM player_biome_discoveries WHERE player_id=$1
       ORDER BY discovered_at,biome_id`,
      [playerId]
    );
    return {
      biomes: rows.rows.map((row) => row.biome_id).filter(isWorldZoneDiscoverableBiome),
      newlyDiscovered,
      celebration,
      current
    };
  }

  /** Awards and lists Legends completed by a fresh discovery. A failure still celebrates the region. */
  private async celebrate(
    playerId: string,
    biome: WorldZoneDiscoverableBiome
  ): Promise<BiomeDiscoveryCelebration> {
    try {
      const snapshot = this.legends ? await this.legends.snapshot(playerId) : null;
      return biomeDiscoveryCelebration(biome, snapshot?.newlyCompletedIds ?? []);
    } catch {
      return biomeDiscoveryCelebration(biome, []);
    }
  }

  /**
   * The biome at a point without recording a discovery. "wilds" (the unknown fallback) when the zone
   * lookup is unavailable or cannot classify the point.
   */
  async biomeAt(position: LatLon): Promise<WorldZoneBiome> {
    if (!this.lookup) return "wilds";
    return resolveWorldZone(this.lookup, position, await this.environmentAt(position)).biome;
  }

  /** One World point lookup (normally cached by MOVE_TO); any failure reads as unavailable. */
  private async environmentAt(position: LatLon): Promise<WorldZoneEnvironmentFacts | null> {
    if (!this.world) return null;
    try {
      return await this.world.lookupGameplayEnvironment(position.lat, position.lon);
    } catch {
      return null;
    }
  }

  private rememberRequest(playerId: string, now: number, result: Promise<BiomeDiscoveryResult>): void {
    if (this.lastRequests.size >= RATE_LIMIT_PRUNE_SIZE) {
      for (const [id, entry] of this.lastRequests) {
        if (now - entry.at >= BIOME_DISCOVERY_MIN_INTERVAL_MS) this.lastRequests.delete(id);
      }
    }
    this.lastRequests.set(playerId, { at: now, result });
    // A failed resolve must not be replayed to later requests.
    result.catch(() => {
      if (this.lastRequests.get(playerId)?.result === result) this.lastRequests.delete(playerId);
    });
  }
}
