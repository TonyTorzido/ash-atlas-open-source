import {
  STRUCTURE_WARFARE_INTERACTION_RADIUS_M,
  STRUCTURE_WARFARE_REPAIR_TICK_MS,
  distanceMeters,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";

import type { AppLogger } from "../logger.js";
import {
  PERSONAL_FLAG_WARFARE_KIND,
  StructureWarfareError,
  type StructureWarfareDisruptCompletion,
  type StructureWarfareDisruptOperation,
  type StructureWarfarePlayer,
  type StructureWarfareRepairCompletion,
  type StructureWarfareRepairOperation,
  type StructureWarfareService
} from "./structureWarfare.js";

export type FlagRepairSession = StructureWarfareRepairOperation & Readonly<{
  playerId: string;
}>;

export type FlagDisruptSession = StructureWarfareDisruptOperation & Readonly<{
  playerId: string;
}>;

type RuntimeRepairSession = Omit<FlagRepairSession, "completesAt" | "durationMs"> & {
  completesAt: number;
  durationMs: number;
  status: "repairing" | "completing" | "cancelled";
  timer: ReturnType<typeof setTimeout> | null;
  validationTimer: ReturnType<typeof setTimeout> | null;
};

type RuntimeDisruptSession = FlagDisruptSession & {
  status: "disrupting" | "completing" | "cancelled";
  timer: ReturnType<typeof setTimeout> | null;
  validationTimer: ReturnType<typeof setTimeout> | null;
};

type RepairHooks = Readonly<{
  sendStarted(session: FlagRepairSession, inventory?: PlayerInventorySnapshot): void;
  sendCancelled(session: FlagRepairSession, reason: string): void;
  completed(session: FlagRepairSession, result: StructureWarfareRepairCompletion): void | Promise<void>;
  /** A repair tick restored health or moved the projected finish time. */
  progressed?(session: FlagRepairSession, structure: unknown | null, projectionChanged: boolean): void | Promise<void>;
  failed(session: FlagRepairSession, error: unknown): void;
  sendDisruptStarted(session: FlagDisruptSession): void;
  sendDisruptCancelled(session: FlagDisruptSession, reason: string): void;
  disrupted(session: FlagDisruptSession, result: StructureWarfareDisruptCompletion): void | Promise<void>;
  disruptFailed(session: FlagDisruptSession, error: unknown): void;
}>;

/**
 * Process-local timers for durable personal Flag repair channels. The adapter
 * remains authoritative: every completion, cancellation, restart recovery,
 * and concurrent disruption is settled in PostgreSQL.
 */
export class FlagRepairCoordinator {
  private readonly repairsByPlayer = new Map<string, RuntimeRepairSession>();
  private readonly repairsByOperation = new Map<string, RuntimeRepairSession>();
  private readonly disruptsByPlayer = new Map<string, RuntimeDisruptSession>();
  private readonly disruptsByOperation = new Map<string, RuntimeDisruptSession>();
  private readonly startingRepairs = new Set<string>();
  private readonly startingDisrupts = new Set<string>();
  private readonly pendingRepairCancellations = new Map<string, Promise<void>>();
  private readonly pendingDisruptCancellations = new Map<string, Promise<void>>();

  constructor(
    private readonly warfare: Pick<StructureWarfareService,
      | "reserveRepair"
      | "advanceRepair"
      | "cancelRepair"
      | "recoverRepairsForServerShutdown"
      | "reconcileRepairs"
      | "reserveDisrupt"
      | "completeDisrupt"
      | "cancelDisrupt"
      | "reconcileDisrupts"
    >,
    private readonly logger: Pick<AppLogger, "info" | "warn">,
    private readonly hooks: RepairHooks,
    private readonly now: () => number = Date.now,
    private readonly currentPlayer: ((playerId: string) => StructureWarfarePlayer | null) | undefined = undefined,
    private readonly isPlayerAlive: ((playerId: string) => boolean) | undefined = undefined,
    private readonly isPlayerFree: ((playerId: string) => boolean) | undefined = undefined
  ) {}

  activeRepairForPlayer(playerId: string): FlagRepairSession | null {
    return this.repairsByPlayer.get(playerId) ?? null;
  }

  activeDisruptForPlayer(playerId: string): FlagDisruptSession | null {
    return this.disruptsByPlayer.get(playerId) ?? null;
  }

  async startRepair(
    playerId: string,
    flagId: string,
    requestId: string,
    player: StructureWarfarePlayer
  ): Promise<FlagRepairSession | null> {
    const existing = this.repairsByPlayer.get(playerId);
    if (existing?.requestId === requestId && existing.structureId === flagId) {
      this.hooks.sendStarted(existing);
      return existing;
    }
    if (existing) throw repairError("FLAG_REPAIR_ACTIVE", "You already have a Flag repair in progress.");
    if (this.startingRepairs.has(playerId)) throw repairError("FLAG_REPAIR_ACTIVE", "You already have a Flag repair in progress.");
    const pendingCancellation = this.pendingRepairCancellations.get(flagId);
    if (pendingCancellation) await pendingCancellation;
    this.assertPlayerAvailable(playerId);
    this.startingRepairs.add(playerId);
    try {
      const result = await this.warfare.reserveRepair({
        kind: PERSONAL_FLAG_WARFARE_KIND,
        playerId,
        structureId: flagId,
        requestId,
        player
      });
      const session: RuntimeRepairSession = {
        ...result.operation,
        playerId,
        status: result.status === "active" ? "repairing" : "cancelled",
        timer: null,
        validationTimer: null
      };
      if (result.status !== "active") return null;
      this.repairsByPlayer.set(playerId, session);
      this.repairsByOperation.set(session.operationId, session);
      this.scheduleRepair(session);
      this.hooks.sendStarted(session, result.inventory);
      this.logger.info({ playerId, flagId, requestId, operationId: session.operationId }, "flag repair started");
      return session;
    } finally {
      this.startingRepairs.delete(playerId);
    }
  }

  async startDisrupt(
    playerId: string,
    flagId: string,
    repairOperationId: string,
    requestId: string,
    player: StructureWarfarePlayer
  ): Promise<FlagDisruptSession | null> {
    const existing = this.disruptsByPlayer.get(playerId);
    if (existing?.requestId === requestId && existing.structureId === flagId) {
      this.hooks.sendDisruptStarted(existing);
      return existing;
    }
    if (existing) throw repairError("FLAG_DISRUPT_ACTIVE", "You already have a repair disruption in progress.");
    if (this.startingDisrupts.has(playerId)) throw repairError("FLAG_DISRUPT_ACTIVE", "You already have a repair disruption in progress.");
    const pendingCancellation = this.pendingDisruptCancellations.get(playerId);
    if (pendingCancellation) await pendingCancellation;
    this.assertPlayerAvailable(playerId);
    this.startingDisrupts.add(playerId);
    try {
      const result = await this.warfare.reserveDisrupt({
        kind: PERSONAL_FLAG_WARFARE_KIND,
        playerId,
        structureId: flagId,
        repairOperationId,
        requestId,
        player
      });
      const session: RuntimeDisruptSession = {
        ...result.operation,
        playerId,
        status: result.status === "active" ? "disrupting" : "cancelled",
        timer: null,
        validationTimer: null
      };
      if (result.status !== "active") return null;
      this.disruptsByPlayer.set(playerId, session);
      this.disruptsByOperation.set(session.operationId, session);
      this.scheduleDisrupt(session);
      this.hooks.sendDisruptStarted(session);
      this.logger.info({ playerId, flagId, requestId, operationId: session.operationId }, "flag repair disruption started");
      return session;
    } finally {
      this.startingDisrupts.delete(playerId);
    }
  }

  cancelPlayer(playerId: string, reason: string): boolean {
    let cancelled = false;
    const repair = this.repairsByPlayer.get(playerId);
    if (repair?.status === "repairing") {
      cancelled = true;
      repair.status = "cancelled";
      this.clearTimers(repair);
      this.removeRepair(repair);
      this.hooks.sendCancelled(repair, reason);
      const cancellation = this.warfare.cancelRepair({
        kind: PERSONAL_FLAG_WARFARE_KIND,
        operationId: repair.operationId,
        playerId,
        structureId: repair.structureId,
        reason
      });
      this.pendingRepairCancellations.set(repair.structureId, cancellation);
      void cancellation.catch((error: unknown) => this.logger.warn({ err: error, playerId, operationId: repair.operationId }, "failed to cancel Flag repair"))
        .finally(() => {
          if (this.pendingRepairCancellations.get(repair.structureId) === cancellation) {
            this.pendingRepairCancellations.delete(repair.structureId);
          }
        });
    }
    const disrupt = this.disruptsByPlayer.get(playerId);
    if (disrupt?.status === "disrupting") {
      cancelled = true;
      disrupt.status = "cancelled";
      this.clearTimers(disrupt);
      this.removeDisrupt(disrupt);
      this.hooks.sendDisruptCancelled(disrupt, reason);
      const cancellation = this.warfare.cancelDisrupt({
        kind: PERSONAL_FLAG_WARFARE_KIND,
        operationId: disrupt.operationId,
        playerId,
        structureId: disrupt.structureId,
        reason
      });
      this.pendingDisruptCancellations.set(playerId, cancellation);
      void cancellation.catch((error: unknown) => this.logger.warn({ err: error, playerId, operationId: disrupt.operationId }, "failed to cancel Flag repair disruption"))
        .finally(() => {
          if (this.pendingDisruptCancellations.get(playerId) === cancellation) {
            this.pendingDisruptCancellations.delete(playerId);
          }
        });
    }
    return cancelled;
  }

  disconnectPlayer(playerId: string): void {
    this.cancelPlayer(playerId, "disconnect");
  }

  async shutdown(): Promise<void> {
    for (const session of this.repairsByPlayer.values()) {
      this.clearTimers(session);
      session.status = "cancelled";
    }
    for (const session of this.disruptsByPlayer.values()) {
      this.clearTimers(session);
      session.status = "cancelled";
    }
    this.repairsByPlayer.clear();
    this.repairsByOperation.clear();
    this.disruptsByPlayer.clear();
    this.disruptsByOperation.clear();
    await Promise.allSettled(this.pendingRepairCancellations.values());
    await Promise.allSettled(this.pendingDisruptCancellations.values());
    await this.warfare.recoverRepairsForServerShutdown(PERSONAL_FLAG_WARFARE_KIND);
  }

  async reconcile(): Promise<void> {
    // A process restart is a controlled server interruption from the durable
    // operation's perspective: refund once, resume the exact paused burn.
    await this.warfare.recoverRepairsForServerShutdown(PERSONAL_FLAG_WARFARE_KIND);
    const sessions = await this.warfare.reconcileRepairs(PERSONAL_FLAG_WARFARE_KIND);
    for (const operation of sessions) {
      const session: RuntimeRepairSession = {
        ...operation,
        playerId: operation.ownerId,
        status: "repairing",
        timer: null,
        validationTimer: null
      };
      this.repairsByPlayer.set(session.playerId, session);
      this.repairsByOperation.set(session.operationId, session);
      this.scheduleRepair(session);
    }
  }

  private scheduleRepair(session: RuntimeRepairSession): void {
    // Progressive channel: tick on a fixed cadence (or sooner when the
    // projected finish is near); the adapter applies earned health and bills
    // chunks on every tick.
    const remaining = Math.max(0, Math.min(STRUCTURE_WARFARE_REPAIR_TICK_MS, session.completesAt - this.now()));
    session.timer = setTimeout(() => void this.completeRepair(session), remaining);
    session.timer.unref?.();
    this.scheduleRepairValidation(session);
  }

  private async completeRepair(session: RuntimeRepairSession): Promise<void> {
    if (this.repairsByOperation.get(session.operationId) !== session || session.status !== "repairing") return;
    session.status = "completing";
    try {
      const progress = await this.warfare.advanceRepair({
        kind: PERSONAL_FLAG_WARFARE_KIND,
        operationId: session.operationId,
        playerId: session.playerId,
        structureId: session.structureId
      });
      if (this.repairsByOperation.get(session.operationId) !== session) return;
      if (!progress) {
        if (await this.reconcileRepair(session)) return;
        this.removeRepair(session);
        this.hooks.sendCancelled(session, "revalidation-failed");
        return;
      }
      if (progress.status === "completed") {
        this.removeRepair(session);
        await this.hooks.completed(session, {
          structure: progress.structure,
          inventory: progress.inventory,
          replayed: progress.replayed
        });
        return;
      }
      if (progress.status === "stopped") {
        this.removeRepair(session);
        this.hooks.sendCancelled(session, progress.reason);
        return;
      }
      const projectionChanged = Math.abs(progress.operation.completesAt - session.completesAt) > 2_000;
      session.completesAt = progress.operation.completesAt;
      session.durationMs = progress.operation.durationMs;
      session.status = "repairing";
      if (progress.healthRestored > 0 || projectionChanged) {
        await this.hooks.progressed?.(session, progress.structure ?? null, projectionChanged);
      }
      if (session.timer) clearTimeout(session.timer);
      this.scheduleRepair(session);
    } catch (error) {
      this.removeRepair(session);
      this.hooks.sendCancelled(session, "revalidation-failed");
      this.hooks.failed(session, error);
      this.logger.warn({ err: error, playerId: session.playerId, operationId: session.operationId }, "Flag repair tick failed");
    }
  }

  private scheduleDisrupt(session: RuntimeDisruptSession): void {
    const remaining = Math.max(0, session.completesAt - this.now());
    session.timer = setTimeout(() => void this.completeDisrupt(session), remaining);
    session.timer.unref?.();
    this.scheduleDisruptValidation(session);
  }

  private async completeDisrupt(session: RuntimeDisruptSession): Promise<void> {
    if (this.disruptsByOperation.get(session.operationId) !== session || session.status !== "disrupting") return;
    if (this.now() < session.completesAt) {
      this.scheduleDisrupt(session);
      return;
    }
    session.status = "completing";
    try {
      const result = await this.warfare.completeDisrupt({
        kind: PERSONAL_FLAG_WARFARE_KIND,
        operationId: session.operationId,
        playerId: session.playerId,
        structureId: session.structureId,
        now: this.now()
      });
      if (!result) {
        if (await this.reconcileDisrupt(session)) return;
        this.removeDisrupt(session);
        this.hooks.sendDisruptCancelled(session, "revalidation-failed");
        return;
      }
      this.removeDisrupt(session);
      await this.hooks.disrupted(session, result);
      const repair = [...this.repairsByOperation.values()].find((candidate) => candidate.operationId === result.repairOperationId);
      if (repair) {
        if (repair.timer) clearTimeout(repair.timer);
        this.removeRepair(repair);
        repair.status = "cancelled";
        this.hooks.sendCancelled(repair, "disrupted");
      }
    } catch (error) {
      this.removeDisrupt(session);
      this.hooks.sendDisruptCancelled(session, "revalidation-failed");
      this.hooks.disruptFailed(session, error);
      this.logger.warn({ err: error, playerId: session.playerId, operationId: session.operationId }, "Flag repair disruption completion failed");
    }
  }

  private removeRepair(session: RuntimeRepairSession): void {
    this.clearTimers(session);
    this.repairsByPlayer.delete(session.playerId);
    this.repairsByOperation.delete(session.operationId);
  }

  private removeDisrupt(session: RuntimeDisruptSession): void {
    this.clearTimers(session);
    this.disruptsByPlayer.delete(session.playerId);
    this.disruptsByOperation.delete(session.operationId);
  }

  private async reconcileRepair(session: RuntimeRepairSession): Promise<boolean> {
    const operation = (await this.warfare.reconcileRepairs(PERSONAL_FLAG_WARFARE_KIND))
      .find((candidate) => candidate.operationId === session.operationId);
    if (!operation) return false;
    this.removeRepair(session);
    const resumed: RuntimeRepairSession = {
      ...operation,
      playerId: session.playerId,
      status: "repairing",
      timer: null,
      validationTimer: null
    };
    this.repairsByPlayer.set(resumed.playerId, resumed);
    this.repairsByOperation.set(resumed.operationId, resumed);
    this.scheduleRepair(resumed);
    return true;
  }

  private async reconcileDisrupt(session: RuntimeDisruptSession): Promise<boolean> {
    const operation = (await this.warfare.reconcileDisrupts(PERSONAL_FLAG_WARFARE_KIND))
      .find((candidate) => candidate.operationId === session.operationId);
    if (!operation) return false;
    this.removeDisrupt(session);
    const resumed: RuntimeDisruptSession = {
      ...operation,
      playerId: session.playerId,
      status: "disrupting",
      timer: null,
      validationTimer: null
    };
    this.disruptsByPlayer.set(resumed.playerId, resumed);
    this.disruptsByOperation.set(resumed.operationId, resumed);
    this.scheduleDisrupt(resumed);
    return true;
  }

  private scheduleRepairValidation(session: RuntimeRepairSession): void {
    if (!this.currentPlayer || session.status !== "repairing") return;
    if (session.validationTimer) clearTimeout(session.validationTimer);
    session.validationTimer = setTimeout(() => {
      if (this.repairsByOperation.get(session.operationId) !== session || session.status !== "repairing") return;
      const player = this.currentPlayer?.(session.playerId);
      const valid = player !== null && player !== undefined && player.online && !player.target &&
        (this.isPlayerAlive?.(session.playerId) ?? true) &&
        (this.isPlayerFree?.(session.playerId) ?? true) &&
        distanceMeters(player.position, session.position) <= STRUCTURE_WARFARE_INTERACTION_RADIUS_M;
      if (!valid) {
        const reason = !player || !player.online
          ? "disconnect"
          : this.isPlayerAlive && !this.isPlayerAlive(session.playerId)
            ? "death"
            : player.target
              ? "movement"
              : this.isPlayerFree && !this.isPlayerFree(session.playerId)
                ? "combat"
              : "out-of-range";
        this.cancelPlayer(session.playerId, reason);
        return;
      }
      this.scheduleRepairValidation(session);
    }, 250);
    session.validationTimer.unref?.();
  }

  private scheduleDisruptValidation(session: RuntimeDisruptSession): void {
    if (!this.currentPlayer || session.status !== "disrupting") return;
    if (session.validationTimer) clearTimeout(session.validationTimer);
    session.validationTimer = setTimeout(() => {
      if (this.disruptsByOperation.get(session.operationId) !== session || session.status !== "disrupting") return;
      const player = this.currentPlayer?.(session.playerId);
      const valid = player !== null && player !== undefined && player.online && !player.target &&
        (this.isPlayerAlive?.(session.playerId) ?? true) &&
        (this.isPlayerFree?.(session.playerId) ?? true) &&
        distanceMeters(player.position, session.position) <= STRUCTURE_WARFARE_INTERACTION_RADIUS_M;
      if (!valid) {
        const reason = !player || !player.online
          ? "disconnect"
          : this.isPlayerAlive && !this.isPlayerAlive(session.playerId)
            ? "death"
            : player.target
              ? "movement"
              : this.isPlayerFree && !this.isPlayerFree(session.playerId)
                ? "combat"
              : "out-of-range";
        this.cancelPlayer(session.playerId, reason);
        return;
      }
      this.scheduleDisruptValidation(session);
    }, 250);
    session.validationTimer.unref?.();
  }

  private clearTimers(session: RuntimeRepairSession | RuntimeDisruptSession): void {
    if (session.timer) clearTimeout(session.timer);
    if (session.validationTimer) clearTimeout(session.validationTimer);
    session.timer = null;
    session.validationTimer = null;
  }

  private assertPlayerAvailable(playerId: string): void {
    if (this.currentPlayer) {
      const player = this.currentPlayer(playerId);
      if (!player || !player.online) {
        throw repairError("FLAG_REPAIR_SURFACE_REQUIRED", "Flag warfare is available only while you are present in the world.");
      }
    }
    if (this.isPlayerAlive && !this.isPlayerAlive(playerId)) {
      throw repairError("FLAG_REPAIR_DEFEATED", "You cannot use Flag warfare while defeated.");
    }
    if (this.isPlayerFree && !this.isPlayerFree(playerId)) {
      throw repairError("FLAG_REPAIR_COMBAT_LOCKED", "Finish your current combat action before using Flag warfare.");
    }
  }
}

function repairError(code: string, message: string): StructureWarfareError {
  return new StructureWarfareError(
    code.startsWith("FLAG_DISRUPT") ? "disrupt" : "repair",
    code,
    message
  );
}

export function isFlagRepairError(error: unknown): error is StructureWarfareError {
  return error instanceof StructureWarfareError && (error.phase === "repair" || error.phase === "disrupt");
}
