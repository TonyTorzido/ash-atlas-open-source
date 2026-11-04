import { randomUUID } from "node:crypto";

import {
  DEVELOPER_DUNGEON_TEMPLATE_PREFIX,
  DUNGEON_CATALOG,
  destinationPoint,
  distanceMeters,
  effectiveDungeonMinimumLevel,
  fallenPrisonHuntHint,
  fallenPrisonLandingAnnouncement,
  type FallenPrisonHuntHint,
  type LatLon,
  type MobArchetypeKey
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppLogger } from "../logger.js";
import type { CombatEngine } from "./combat/combatEngine.js";
import type {
  DeveloperSpawnedDungeonEntrance,
  DeveloperSpawnedDungeonService
} from "./developerSpawnedDungeons.js";
import { packageIdForPosition, zoneIdForPosition } from "./spatialZones.js";

export const FALLEN_PRISON_EVENT_KIND = "fallen_prison_crash";
/** The template derived from the dungeon's own world portal (the prison has no placed library entrance). */
export const FALLEN_PRISON_TEMPLATE_ID = `${DEVELOPER_DUNGEON_TEMPLATE_PREFIX}fallen_prison`;
/** Without airships the prison simply lands: the crash site stays open this long. */
export const FALLEN_PRISON_CRASH_DURATION_MS = 20 * 60 * 60_000;
/** Crash-site guards come back this long after they fall. */
export const FALLEN_PRISON_GUARD_RESPAWN_MS = 5 * 60 * 60_000;
const TICK_MS = 30_000;

/**
 * Automatic crash cadence, the one place to tune it. Each check, every populated region (a region
 * with an online player who meets the entry level) that has fewer than `maxActivePerRegion` live
 * crashes gets a new one 15-30 km from a random eligible player (the hunt: it is found from the hint
 * and the smoke, docs/design/WORLD_DUNGEON_ENTRANCES.md); each lasts FALLEN_PRISON_CRASH_DURATION_MS.
 */
export const FALLEN_PRISON_AUTO_CRASH = Object.freeze({
  checkIntervalMs: 5 * 60_000,
  maxActivePerRegion: 1,
  /** The crash lands this far from the chosen player, on land World confirms (fail closed: retry next check). */
  minDistanceM: 15_000,
  maxDistanceM: 30_000,
  placementAttempts: 8
});

export type FallenPrisonHuntMessage = Readonly<{ type: "FALLEN_PRISON_HUNT"; hint: FallenPrisonHuntHint | null; announcement?: string }>;

/** What the automatic scheduler and the hunt hints need from the running world (online players outside interiors). */
export type FallenPrisonWorld = Readonly<{
  onlinePlayers(): readonly Readonly<{ playerId: string; position: LatLon }>[];
  /**
   * Whether each point is land (null = World did not say), through the throttled, backed-off World path.
   * Without it no automatic crash lands (fail closed).
   */
  landAt?(points: readonly LatLon[]): Promise<readonly (boolean | null)[]>;
  /** Sends one hunt message to a player (a no-op when offline). */
  send(playerId: string, message: FallenPrisonHuntMessage): void;
  /** The player's live connection, so a reconnect gets the hint again. */
  connectionKey?(playerId: string): string | null;
}>;

/** Crash-site guard roster: archetype and ring distance in metres from the entrance. */
const GUARD_SLOTS: readonly Readonly<{ archetype: MobArchetypeKey; distanceM: number }>[] = [
  { archetype: "sky_scout", distanceM: 45 }, { archetype: "sky_scout", distanceM: 60 },
  { archetype: "sky_scout", distanceM: 75 }, { archetype: "sky_scout", distanceM: 90 },
  { archetype: "cloud_sentry", distanceM: 55 }, { archetype: "cloud_sentry", distanceM: 80 },
  { archetype: "cloud_arbiter", distanceM: 65 }
];

export class FallenPrisonCrashError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: 404 | 409 | 429 = 409) {
    super(message);
    this.name = "FallenPrisonCrashError";
  }
}

type GuardSlot = { archetype: MobArchetypeKey; position: LatLon; entityId: string | null; generation: number; respawnAt: number | null };
type ActiveCrash = { placement: DeveloperSpawnedDungeonEntrance; slots: GuardSlot[] };

/**
 * The Fallen Prison world event. The crash is an expiring dungeon-entrance placement (the same table
 * and portal path as developer-spawned entrances, but with the dungeon's normal level, torch and
 * lockout rules), guarded by Spire Scouts, Cloud Sentries and a Cloud Arbiter that respawn 5 h after they fall.
 * Level 40 players are told when one lands in their region and get a rough live hint towards it.
 */
export class FallenPrisonCrashService {
  private readonly active = new Map<string, ActiveCrash>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextAutoCrashAt = 0;
  /** The hunt hint each player was last sent (connection + hint), so only changes are sent. */
  private huntSent = new Map<string, string>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly placements: DeveloperSpawnedDungeonService,
    private readonly combat: CombatEngine,
    private readonly logger?: AppLogger,
    private readonly now: () => number = Date.now,
    private readonly world?: FallenPrisonWorld,
    private readonly random: () => number = Math.random
  ) {}

  async recover(): Promise<void> {
    for (const placement of await this.placements.listActive()) {
      if (placement.eventKind === FALLEN_PRISON_EVENT_KIND) this.track(placement);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Lands the prison at `position`. One live crash per region; replays by (creator, requestId) are idempotent. */
  async trigger(input: Readonly<{ creatorPlayerId: string; requestId: string; regionCode: string; position: LatLon }>):
    Promise<Readonly<{ placement: DeveloperSpawnedDungeonEntrance; replayed: boolean }>> {
    const existing = [...this.active.values()].find((crash) =>
      crash.placement.requestId !== input.requestId && crash.placement.regionCode === input.regionCode && this.isLive(crash.placement));
    if (existing) {
      throw new FallenPrisonCrashError("FALLEN_PRISON_ALREADY_LANDED", "The Fallen Prison is already down here; it must expire first.");
    }
    const spawned = await this.placements.spawn({
      creatorPlayerId: input.creatorPlayerId,
      requestId: input.requestId,
      templateId: FALLEN_PRISON_TEMPLATE_ID,
      regionCode: input.regionCode,
      position: input.position,
      expiresAt: new Date(this.now() + FALLEN_PRISON_CRASH_DURATION_MS),
      eventKind: FALLEN_PRISON_EVENT_KIND
    });
    this.track(spawned.entrance);
    return { placement: spawned.entrance, replayed: spawned.replayed };
  }

  /** The live crash nearest `near` (any live crash when `near` is omitted). */
  currentCrash(near?: LatLon): DeveloperSpawnedDungeonEntrance | null {
    let best: DeveloperSpawnedDungeonEntrance | null = null;
    for (const { placement } of this.active.values()) {
      if (!this.isLive(placement)) continue;
      if (!near) return placement;
      if (!best || distanceMeters(near, placement.position) < distanceMeters(near, best.position)) best = placement;
    }
    return best;
  }

  /** Expires finished crashes, respawns fallen guards and lands new crashes. Exposed for tests; the timer calls it. */
  async tick(): Promise<void> {
    const now = this.now();
    if (this.world && now >= this.nextAutoCrashAt) {
      this.nextAutoCrashAt = now + FALLEN_PRISON_AUTO_CRASH.checkIntervalMs;
      try { await this.landAutomaticCrashes(); } catch (error) {
        this.logger?.warn({ err: error }, "fallen prison automatic crash failed");
      }
    }
    for (const [entranceId, crash] of [...this.active]) {
      if (!this.isLive(crash.placement)) {
        for (const slot of crash.slots) if (slot.entityId) this.combat.despawnMob(slot.entityId);
        this.active.delete(entranceId);
        continue;
      }
      for (const slot of crash.slots) {
        const entity = slot.entityId ? this.combat.entity(slot.entityId) : null;
        if (entity && entity.lifeState === "alive") continue;
        if (slot.entityId) {
          if (entity) this.combat.despawnMob(slot.entityId);
          slot.entityId = null;
          slot.respawnAt = now + FALLEN_PRISON_GUARD_RESPAWN_MS;
        }
        if (slot.respawnAt !== null && slot.respawnAt <= now) this.spawnGuard(crash.placement, slot);
      }
    }
    try { await this.refreshHunt(); } catch (error) {
      this.logger?.warn({ err: error }, "fallen prison hunt hints failed");
    }
  }

  /** Of these players, the ones who meet the prison's entry level. */
  private async eligiblePlayerIds(playerIds: readonly string[]): Promise<Set<string>> {
    if (playerIds.length === 0) return new Set();
    const dungeon = DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "fallen_prison");
    const minimumLevel = effectiveDungeonMinimumLevel(dungeon?.access) ?? 1;
    const eligible = await this.pool.query<{ player_id: string }>(
      "SELECT player_id FROM player_progression_profiles WHERE player_id = ANY($1::text[]) AND level >= $2",
      [[...playerIds], minimumLevel]
    );
    return new Set(eligible.rows.map((row) => row.player_id));
  }

  /**
   * The live hunt hint: every level 40 player within the hint radius of a live crash gets an 8-point
   * direction and a coarse band towards the nearest one, sent only when it (or their connection)
   * changes; a player who loses the hint is sent a clear once.
   */
  private async refreshHunt(): Promise<void> {
    if (!this.world) return;
    const crashes = [...this.active.values()].filter((crash) => this.isLive(crash.placement)).map((crash) => crash.placement.position);
    const hints = new Map<string, FallenPrisonHuntHint>();
    if (crashes.length > 0) {
      for (const player of this.world.onlinePlayers()) {
        const nearest = crashes.reduce((best, crash) =>
          distanceMeters(player.position, crash) < distanceMeters(player.position, best) ? crash : best);
        const hint = fallenPrisonHuntHint(player.position, nearest);
        if (hint) hints.set(player.playerId, hint);
      }
    }
    const eligible = await this.eligiblePlayerIds([...hints.keys()]);
    const sent = new Map<string, string>();
    for (const [playerId, hint] of hints) {
      if (!eligible.has(playerId)) continue;
      const key = `${this.world.connectionKey?.(playerId) ?? ""}|${hint.direction}|${hint.band}|${hint.smokeInSight}`;
      if (this.huntSent.get(playerId) !== key) this.world.send(playerId, { type: "FALLEN_PRISON_HUNT", hint });
      sent.set(playerId, key);
    }
    for (const playerId of this.huntSent.keys()) {
      if (!sent.has(playerId)) this.world.send(playerId, { type: "FALLEN_PRISON_HUNT", hint: null });
    }
    this.huntSent = sent;
  }

  /**
   * One crash per populated region: land 15-30 km from a random player who meets the entry level, on
   * land World confirms; then tell every eligible player in the region roughly which way it fell.
   */
  private async landAutomaticCrashes(): Promise<void> {
    const players = this.world!.onlinePlayers();
    if (players.length === 0) return;
    const eligibleIds = await this.eligiblePlayerIds(players.map((player) => player.playerId));
    const byRegion = new Map<string, { playerId: string; position: LatLon }[]>();
    for (const player of players) {
      if (!eligibleIds.has(player.playerId)) continue;
      const region = packageIdForPosition(player.position);
      byRegion.set(region, [...(byRegion.get(region) ?? []), player]);
    }
    for (const [regionCode, candidates] of byRegion) {
      const live = [...this.active.values()].filter((crash) => crash.placement.regionCode === regionCode && this.isLive(crash.placement)).length;
      if (live >= FALLEN_PRISON_AUTO_CRASH.maxActivePerRegion) continue;
      const anchor = candidates[Math.min(candidates.length - 1, Math.floor(this.random() * candidates.length))]!;
      const position = await this.pickLandingSpot(anchor.position);
      if (!position) continue;
      const placed = await this.trigger({ creatorPlayerId: anchor.playerId, requestId: randomUUID(), regionCode, position });
      if (placed.replayed) continue;
      for (const player of candidates) {
        const hint = fallenPrisonHuntHint(player.position, position);
        this.world!.send(player.playerId, {
          type: "FALLEN_PRISON_HUNT", hint, announcement: fallenPrisonLandingAnnouncement(player.position, position)
        });
        if (hint) {
          this.huntSent.set(player.playerId,
            `${this.world!.connectionKey?.(player.playerId) ?? ""}|${hint.direction}|${hint.band}|${hint.smokeInSight}`);
        }
      }
    }
  }

  /**
   * A spot 15-30 km from `from` in the same region that the mob rules allow and World says is land
   * (one batched, throttled lookup). Null when none qualifies or World does not answer: no crash
   * this check, the next check tries again.
   */
  private async pickLandingSpot(from: LatLon): Promise<LatLon | null> {
    const { minDistanceM, maxDistanceM, placementAttempts } = FALLEN_PRISON_AUTO_CRASH;
    if (!this.world?.landAt) return null;
    const spots: LatLon[] = [];
    for (let attempt = 0; attempt < placementAttempts; attempt += 1) {
      const spot = destinationPoint(from, minDistanceM + this.random() * (maxDistanceM - minDistanceM), this.random() * 360);
      if (this.combat.isCompanionPositionTraversable(spot) && packageIdForPosition(spot) === packageIdForPosition(from)) spots.push(spot);
    }
    if (spots.length === 0) return null;
    const land = await this.world.landAt(spots).catch(() => spots.map(() => null));
    return spots.find((_, index) => land[index] === true) ?? null;
  }

  private isLive(placement: DeveloperSpawnedDungeonEntrance): boolean {
    return placement.deletedAt === null && (placement.expiresAt === null || Date.parse(placement.expiresAt) > this.now());
  }

  private track(placement: DeveloperSpawnedDungeonEntrance): void {
    if (this.active.has(placement.entranceId)) return;
    const slots = GUARD_SLOTS.map((guard, index): GuardSlot => ({
      archetype: guard.archetype,
      position: destinationPoint(placement.position, guard.distanceM, (360 / GUARD_SLOTS.length) * index),
      entityId: null,
      generation: 0,
      respawnAt: null
    }));
    const crash = { placement, slots };
    this.active.set(placement.entranceId, crash);
    for (const slot of slots) this.spawnGuard(placement, slot);
  }

  private spawnGuard(placement: DeveloperSpawnedDungeonEntrance, slot: GuardSlot): void {
    slot.generation += 1;
    const entityId = `fallen-prison-guard:${placement.entranceId}:${slot.archetype}:${Math.round(slot.position.lat * 1e5)}:${Math.round(slot.position.lon * 1e5)}:${slot.generation}`;
    try {
      this.combat.spawnMob({
        entityId,
        archetype: slot.archetype,
        position: slot.position,
        homePosition: slot.position,
        regionCode: placement.regionCode,
        zoneId: zoneIdForPosition(slot.position),
        worldAi: true
      });
      slot.entityId = entityId;
      slot.respawnAt = null;
    } catch (error) {
      this.logger?.warn({ err: error, entranceId: placement.entranceId }, "fallen prison guard spawn failed");
      slot.respawnAt = this.now() + TICK_MS;
    }
  }
}
