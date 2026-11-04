import {
  distanceMeters,
  FLAG_UPGRADE_INTERACTION_RADIUS_M,
  PERSONAL_GUARD_TOWER_MAX_LEVEL,
  KINGDOM_OBELISK_MAX_LEVEL,
  KINGDOM_TOWER_MAX_LEVEL,
  type FlagReinforcementTarget,
  type FlagSnapshot
} from "@ash-atlas/shared";

import type { AppLogger } from "../logger.js";
import { BoundedReplayCache } from "./boundedReplayCache.js";
import {
  AtlasShrineError,
  type FlagService
} from "./flags.js";

export const FLAG_HARDENING_DURATION_MS = 15_000;
export const FLAG_TOWER_UPGRADE_DURATION_MS = 30_000;
const FLAG_HARDENING_REPLAY_MAX_ENTRIES = 2_048;
const FLAG_HARDENING_REPLAY_TTL_MS = 10 * 60_000;

export type FlagHardeningSession = Readonly<{
  playerId: string;
  requestId: string;
  flagId: string;
  flagName: string;
  position: Readonly<{ lat: number; lon: number }>;
  startedAt: number;
  completesAt: number;
  durationMs: number;
  targetTier: FlagReinforcementTarget;
  /** "tower_level" only: the Guard Tower level being built. */
  targetTowerLevel?: number;
}>;

type ReinforcementResult = Awaited<ReturnType<FlagService["upgradeFlagTier"]>>;

type RuntimeSession = FlagHardeningSession & {
  status: "hardening" | "completing" | "cancelled";
  timer: ReturnType<typeof setTimeout> | null;
};

type Hooks = Readonly<{
  sendStarted(session: FlagHardeningSession): void;
  sendCancelled(session: FlagHardeningSession, reason: string): void;
  completed(session: FlagHardeningSession, result: ReinforcementResult): void | Promise<void>;
  failed(session: FlagHardeningSession, error: unknown): void;
}>;

export class FlagHardeningCoordinator {
  private readonly active = new Map<string, RuntimeSession>();
  private readonly starting = new Set<string>();
  private readonly completed: BoundedReplayCache<string, FlagHardeningSession>;

  constructor(
    private readonly flags: Pick<FlagService, "getFlag" | "upgradeFlagTier"> &
      Partial<Pick<
        FlagService,
        | "upgradeGuardTowerLevel"
        | "upgradeCityTower"
        | "assertCityTowerUpgradeAllowed"
        | "upgradeKingdomStructure"
        | "assertKingdomStructureBuildAllowed"
      >>,
    private readonly logger: Pick<AppLogger, "info" | "warn">,
    private readonly hooks: Hooks,
    private readonly now: () => number = Date.now
  ) {
    this.completed = new BoundedReplayCache(
      FLAG_HARDENING_REPLAY_MAX_ENTRIES,
      FLAG_HARDENING_REPLAY_TTL_MS,
      now
    );
  }

  activeForPlayer(playerId: string): FlagHardeningSession | null {
    return this.active.get(playerId) ?? null;
  }

  async start(
    playerId: string,
    flagId: string,
    requestId: string,
    targetTier: FlagReinforcementTarget,
    getPlayer: () => Readonly<{
      position: Readonly<{ lat: number; lon: number }>;
      target: unknown;
    }> | null,
    targetTowerLevel?: number
  ): Promise<FlagHardeningSession | null> {
    if (targetTier === "tower_level") {
      if (
        targetTowerLevel === undefined || !Number.isSafeInteger(targetTowerLevel) ||
        targetTowerLevel < 2 || targetTowerLevel > PERSONAL_GUARD_TOWER_MAX_LEVEL
      ) {
        throw new AtlasShrineError("FLAG_TOWER_LEVEL_INVALID", "Choose the next Guard Tower level");
      }
    } else if (targetTier === "kingdom_tower" || targetTier === "obelisk") {
      const maxLevel = targetTier === "obelisk" ? KINGDOM_OBELISK_MAX_LEVEL : KINGDOM_TOWER_MAX_LEVEL;
      if (
        targetTowerLevel === undefined || !Number.isSafeInteger(targetTowerLevel) ||
        targetTowerLevel < 1 || targetTowerLevel > maxLevel
      ) {
        throw new AtlasShrineError("FLAG_KINGDOM_STRUCTURE_LEVEL_INVALID", "Choose the next structure level");
      }
    } else {
      targetTowerLevel = undefined;
    }
    const current = this.active.get(playerId);
    if (
      current?.requestId === requestId && current.flagId === flagId && current.targetTier === targetTier &&
      current.targetTowerLevel === targetTowerLevel
    ) {
      this.hooks.sendStarted(current);
      return current;
    }
    if (current) throw new Error("A flag is already being hardened");
    if (this.starting.has(playerId)) throw new Error("A flag is already being hardened");

    const completed = this.completed.get(this.replayKey(playerId, requestId));
    if (completed) {
      if (
        completed.flagId !== flagId || completed.targetTier !== targetTier ||
        completed.targetTowerLevel !== targetTowerLevel
      ) {
        throw new Error("Flag upgrade request id was already used for different intent");
      }
      const result = await this.runUpgrade(completed);
      await this.publishCompleted(completed, { ...result, replayed: true });
      return null;
    }

    this.starting.add(playerId);
    try {
      const flag = await this.flags.getFlag(flagId);
      const player = getPlayer();
      if (!player) throw new Error("player is not connected");
      this.assertPreflightEligible(playerId, flag, targetTier, player, targetTowerLevel);
      if (targetTier === "city_tower") {
        if (!this.flags.assertCityTowerUpgradeAllowed) throw new Error("City Tower upgrades are unavailable");
        await this.flags.assertCityTowerUpgradeAllowed(playerId, flagId);
      }
      if (targetTier === "kingdom_tower" || targetTier === "obelisk") {
        if (!this.flags.assertKingdomStructureBuildAllowed) throw new Error("Kingdom structures are unavailable");
        await this.flags.assertKingdomStructureBuildAllowed(playerId, flagId, targetTier, targetTowerLevel ?? 0);
      }
      const startedAt = this.now();
      const durationMs = targetTier === "stone"
        ? FLAG_HARDENING_DURATION_MS
        : FLAG_TOWER_UPGRADE_DURATION_MS;
      const session: RuntimeSession = {
        playerId,
        requestId,
        flagId,
        flagName: flag!.name,
        position: { lat: flag!.lat, lon: flag!.lon },
        startedAt,
        completesAt: startedAt + durationMs,
        durationMs,
        targetTier,
        ...(targetTowerLevel === undefined ? {} : { targetTowerLevel }),
        status: "hardening",
        timer: null
      };
      this.active.set(playerId, session);
      this.schedule(session);
      this.hooks.sendStarted(session);
      this.logger.info({ playerId, flagId, requestId, targetTier }, "flag upgrade started");
      return session;
    } finally {
      this.starting.delete(playerId);
    }
  }

  cancelPlayer(playerId: string, reason: string): boolean {
    const session = this.active.get(playerId);
    if (!session || session.status !== "hardening") return false;
    session.status = "cancelled";
    if (session.timer) clearTimeout(session.timer);
    this.active.delete(playerId);
    this.hooks.sendCancelled(session, reason);
    this.logger.info({ playerId, flagId: session.flagId, requestId: session.requestId, reason }, "flag hardening cancelled");
    return true;
  }

  disconnectPlayer(playerId: string): void {
    this.cancelPlayer(playerId, "disconnect");
  }

  private schedule(session: RuntimeSession): void {
    const remainingMs = Math.max(0, session.completesAt - this.now());
    session.timer = setTimeout(() => void this.complete(session), remainingMs);
  }

  private async complete(session: RuntimeSession): Promise<void> {
    if (this.active.get(session.playerId) !== session || session.status !== "hardening") return;
    if (this.now() < session.completesAt) {
      this.schedule(session);
      return;
    }
    session.status = "completing";
    let result: ReinforcementResult;
    try {
      result = await this.runUpgrade(session);
    } catch (error) {
      this.active.delete(session.playerId);
      this.hooks.sendCancelled(session, "revalidation-failed");
      this.hooks.failed(session, error);
      this.logger.warn({ err: error, playerId: session.playerId, flagId: session.flagId, requestId: session.requestId }, "flag hardening failed");
      return;
    }
    this.active.delete(session.playerId);
    this.completed.set(this.replayKey(session.playerId, session.requestId), session);
    this.logger.info({ playerId: session.playerId, flagId: session.flagId, requestId: session.requestId }, "flag hardening completed");
    await this.publishCompleted(session, result);
  }

  private runUpgrade(session: FlagHardeningSession): Promise<ReinforcementResult> {
    switch (session.targetTier) {
      case "stone":
      case "tower":
        return this.flags.upgradeFlagTier(session.playerId, session.flagId, session.targetTier, session.requestId);
      case "tower_level":
        if (!this.flags.upgradeGuardTowerLevel) throw new Error("Guard Tower levels are unavailable");
        return this.flags.upgradeGuardTowerLevel(
          session.playerId,
          session.flagId,
          session.targetTowerLevel ?? 0,
          session.requestId
        );
      case "city_tower":
        if (!this.flags.upgradeCityTower) throw new Error("City Tower upgrades are unavailable");
        return this.flags.upgradeCityTower(session.playerId, session.flagId, session.requestId);
      case "kingdom_tower":
      case "obelisk":
        if (!this.flags.upgradeKingdomStructure) throw new Error("Kingdom structures are unavailable");
        return this.flags.upgradeKingdomStructure(
          session.playerId,
          session.flagId,
          session.targetTier,
          session.targetTowerLevel ?? 0,
          session.requestId
        );
    }
  }

  private async publishCompleted(
    session: FlagHardeningSession,
    result: ReinforcementResult
  ): Promise<void> {
    try {
      await this.hooks.completed(session, result);
    } catch (error) {
      this.logger.warn(
        { err: error, playerId: session.playerId, flagId: session.flagId, requestId: session.requestId },
        "flag hardening completed but publication failed"
      );
    }
  }

  private assertPreflightEligible(
    playerId: string,
    flag: FlagSnapshot | null,
    targetTier: FlagReinforcementTarget,
    player: Readonly<{ position: Readonly<{ lat: number; lon: number }>; target: unknown }>,
    targetTowerLevel?: number
  ): void {
    if (!flag) throw new AtlasShrineError("FLAG_NOT_FOUND", "Flag does not exist");
    if (flag.anchorKind === "buoy") {
      throw new AtlasShrineError("FLAG_TIER_UNSUPPORTED", "Buoys cannot be reinforced or converted");
    }
    if (targetTier === "kingdom_tower" || targetTier === "obelisk") {
      if (flag.controlType !== "kingdom") {
        throw new AtlasShrineError(
          "FLAG_KINGDOM_STRUCTURE_FLAG_REQUIRED",
          "Only a Kingdom Flag can become an Obelisk or Kingdom Tower"
        );
      }
      if (flag.burning) {
        throw new AtlasShrineError("FLAG_UPGRADE_BURNING", "Finish the burn or repair before upgrading");
      }
      this.assertPlayerReady(flag, player);
      return;
    }
    if (targetTier === "tower_level" || targetTier === "city_tower") {
      if (targetTier === "tower_level") {
        if (flag.controlType !== "personal" || flag.ownerId !== playerId) {
          throw new AtlasShrineError("FLAG_UPGRADE_FORBIDDEN", "Only the Tower owner can build its next level");
        }
        if ((flag.reinforcementLevel ?? 0) !== 3 || (flag.towerLevel ?? 1) !== (targetTowerLevel ?? 0) - 1) {
          throw new AtlasShrineError("FLAG_TOWER_LEVEL_CHANGED", "This Tower is not ready for that level");
        }
      } else if (flag.controlType !== "city" || (flag.towerLevel ?? null) !== null) {
        throw new AtlasShrineError("FLAG_CITY_TOWER_CITY_FLAG_REQUIRED", "Only a City Flag can become a City Tower");
      }
      if (flag.burning) {
        throw new AtlasShrineError("FLAG_UPGRADE_BURNING", "Finish the burn or repair before upgrading");
      }
      this.assertPlayerReady(flag, player);
      return;
    }
    const requiredLevel = targetTier === "stone" ? 0 : 1;
    if ((flag.reinforcementLevel ?? 0) !== requiredLevel) {
      throw new AtlasShrineError(
        "FLAG_ALREADY_UPGRADED",
        targetTier === "stone"
          ? "Only a base flag can be upgraded to stone"
          : "Only a stone flag can be upgraded to a Tower"
      );
    }
    if (flag.controlType !== "personal" || flag.ownerId !== playerId) {
      throw new AtlasShrineError("FLAG_UPGRADE_FORBIDDEN", "Only the personal flag owner can upgrade this flag");
    }
    this.assertPlayerReady(flag, player);
  }

  private assertPlayerReady(
    flag: FlagSnapshot,
    player: Readonly<{ position: Readonly<{ lat: number; lon: number }>; target: unknown }>
  ): void {
    if (player.target) {
      throw new AtlasShrineError("FLAG_UPGRADE_MOVING", "Stop moving before upgrading this flag");
    }
    if (distanceMeters(player.position, { lat: flag.lat, lon: flag.lon }) > FLAG_UPGRADE_INTERACTION_RADIUS_M) {
      throw new AtlasShrineError(
        "FLAG_UPGRADE_OUT_OF_RANGE",
        `Move within ${FLAG_UPGRADE_INTERACTION_RADIUS_M}m of the flag before upgrading it`
      );
    }
  }

  private replayKey(playerId: string, requestId: string): string {
    return `${playerId}:${requestId}`;
  }
}
