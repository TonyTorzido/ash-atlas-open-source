import {
  FLAG_BURN_DURATION_MS,
  FLAG_BURN_INTERACTION_RADIUS_M,
  FLAG_BURN_OUTPUT,
  FLAG_BURN_RECIPE,
  structureWarfareHealthForReinforcementLevel,
  structureWarfareBreachThresholdForReinforcementLevel,
  structureWarfareBurnDurationForReinforcementLevel,
  distanceMeters,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";

import type { AppLogger } from "../logger.js";
import {
  type BurnFlagDeletionResult,
  type FlagService
} from "./flags.js";
import { DEFAULT_INVENTORY_VARIANT, type InventoryService } from "./inventory.js";
import { PersonalFlagWarfareAdapter } from "./personalFlagWarfare.js";
import {
  PERSONAL_FLAG_WARFARE_KIND,
  StructureWarfareError,
  StructureWarfareService,
  type StructureWarfareIgnitionOperation
} from "./structureWarfare.js";

export const FLAG_BURN_EVENT_KIND = "flag_burn_started";

export class FlagBurnError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FlagBurnError";
  }
}

export type FlagBurnSession = Readonly<{
  operationId: string;
  playerId: string;
  victimPlayerId: string;
  flagId: string;
  requestId: string;
  flagName: string;
  position: Readonly<{ lat: number; lon: number }>;
  startedAt: number;
  completesAt: number;
  durationMs: number;
  noticeMessage: string;
}>;

export type FlagBurnCompletion = Readonly<{
  inventory: PlayerInventorySnapshot;
  deletion: BurnFlagDeletionResult;
  replayed: boolean;
}>;

export type FlagBurnStartOutcome = Readonly<{
  session: FlagBurnSession;
  replayed: boolean;
  status: "active" | "cancelled" | "completed";
  inventory?: PlayerInventorySnapshot;
}>;

type BurnRow = {
  operation_id: string;
  burner_player_id: string;
  victim_player_id: string;
  flag_id: string;
  request_id: string;
  flag_name: string;
  flag_lat: number;
  flag_lon: number;
  notice_message: string;
  started_at: Date | string;
  completes_at: Date | string;
  status: "active" | "cancelled" | "completed";
  reinforcement_level: number;
  burn_duration_ms: number;
};

type CurrentPlayer = Readonly<{
  position: Readonly<{ lat: number; lon: number }>;
  target: Readonly<{ lat: number; lon: number }> | null;
  online: boolean;
}>;

type Hooks = Readonly<{
  currentPlayer(playerId: string): CurrentPlayer | null;
  isPlayerAlive?(playerId: string): boolean;
  sendStarted(session: FlagBurnSession): void;
  sendVictimNotice(session: FlagBurnSession): void;
  sendCancelled(session: FlagBurnSession, reason: string): void;
  healthChanged?(flagId: string): void | Promise<void>;
  completed(session: FlagBurnSession, result: FlagBurnCompletion): void | Promise<void>;
  failed(session: FlagBurnSession, error: unknown): void;
}>;

type RuntimeSession = FlagBurnSession & {
  status: "active" | "completing" | "cancelled";
  timer: ReturnType<typeof setTimeout> | null;
};

type BurnFlags = Pick<
  FlagService,
  "databasePool" | "getFlag" | "deleteFlagForBurnInTransaction"
> & Partial<Pick<FlagService, "getMapFlag">>;

export class FlagBurnCoordinator {
  private readonly active = new Map<string, RuntimeSession>();
  private readonly starting = new Set<string>();
  private readonly warfare: StructureWarfareService;
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private reconciliationFlight: Promise<void> | null = null;

  constructor(
    private readonly flags: BurnFlags,
    private readonly inventory: InventoryService,
    private readonly logger: Pick<AppLogger, "info" | "warn">,
    private readonly hooks: Hooks,
    private readonly now: () => number = Date.now,
    warfare?: StructureWarfareService
  ) {
    this.warfare = warfare ?? new StructureWarfareService(
      new PersonalFlagWarfareAdapter(
        {
          databasePool: flags.databasePool,
          getMapFlag: flags.getMapFlag ?? flags.getFlag,
          deleteFlagForBurnInTransaction: flags.deleteFlagForBurnInTransaction
        },
        inventory
      )
    );
  }

  activeForPlayer(playerId: string): FlagBurnSession | null {
    return this.activeRuntimeForPlayer(playerId);
  }

  /**
   * Keep durable burns created by non-interactive damage writers on the same
   * runtime completion path as player-started burns.  The durable row and
   * Flag presentation remain authoritative; this poll only discovers rows
   * created after startup and schedules their server-clock deadline.
   */
  startReconciliation(intervalMs = 1_000): void {
    if (this.reconciliationTimer) return;
    this.reconciliationTimer = setInterval(() => {
      void this.reconcile().catch((error: unknown) => {
        this.logger.warn({ err: error }, "durable Flag burn reconciliation failed");
      });
    }, Math.max(250, Math.trunc(intervalMs)));
    this.reconciliationTimer.unref?.();
  }

  stopReconciliation(): void {
    if (!this.reconciliationTimer) return;
    clearInterval(this.reconciliationTimer);
    this.reconciliationTimer = null;
  }

  private activeRuntimeForPlayer(playerId: string): RuntimeSession | null {
    for (const session of this.active.values()) {
      if (session.playerId === playerId) return session;
    }
    return null;
  }

  async start(
    playerId: string,
    flagId: string,
    requestId: string,
    player: CurrentPlayer
  ): Promise<FlagBurnStartOutcome> {
    const current = this.activeRuntimeForPlayer(playerId);
    if (current) {
      // Re-read the durable operation before deciding whether the runtime
      // session still blocks another target.  A final damage write can retire
      // an operation before the runtime poll observes it; reconcile first so
      // an orphan cannot produce a misleading active-burn error.
      const refreshed = (await this.reconcileDurableOperations())
        .find((operation) => operation.operationId === current.operationId && !operation.completion);
      if (refreshed) {
        if (current.flagId !== flagId || current.status === "cancelled") {
          throw new FlagBurnError("FLAG_BURN_ACTIVE", "A Flag burn is already active.");
        }
        // Bomber-triggered burns can be discovered by the supervisor while
        // the presentation mirror is stale; replay repairs that mirror
        // instead of reporting an active burn the map cannot render.
        if (current.timer) clearTimeout(current.timer);
        const session: RuntimeSession = {
          ...current,
          startedAt: refreshed.startedAt,
          completesAt: refreshed.completesAt,
          durationMs: refreshed.durationMs,
          status: "active",
          timer: null
        };
        this.active.set(session.operationId, session);
        this.schedule(session);
        this.hooks.sendStarted(session);
        return { session, replayed: true, status: "active" };
      }
      if (current.timer) clearTimeout(current.timer);
      if (this.active.get(current.operationId) === current) {
        current.status = "cancelled";
        this.active.delete(current.operationId);
        this.hooks.sendCancelled(current, "reconciled");
      }
    }
    if (this.starting.has(playerId)) {
      throw new FlagBurnError("FLAG_BURN_ACTIVE", "A Flag burn is already starting.");
    }
    this.assertPlayerCanStart(playerId, player);
    const flag = await this.flags.getFlag(flagId);
    this.assertBurnableTarget(playerId, flag, player);
    this.starting.add(playerId);
    try {
      const outcome = await this.reserveDurableOperation(playerId, flagId, requestId, player);
      const session = this.sessionFromRow(outcome.row);
      if (outcome.status === "active") {
        const runtime: RuntimeSession = { ...session, status: "active", timer: null };
        this.active.set(runtime.operationId, runtime);
        this.schedule(runtime);
        this.hooks.sendStarted(runtime);
        if (!outcome.replayed) this.hooks.sendVictimNotice(runtime);
      }
      return {
        session,
        replayed: outcome.replayed,
        status: outcome.status,
        ...(outcome.inventory ? { inventory: outcome.inventory } : {})
      };
    } finally {
      this.starting.delete(playerId);
    }
  }

  async reconcile(): Promise<void> {
    if (this.reconciliationFlight) return this.reconciliationFlight;
    const flight = this.reconcileDurableOperations().then(() => undefined);
    this.reconciliationFlight = flight;
    try {
      await flight;
    } finally {
      if (this.reconciliationFlight === flight) this.reconciliationFlight = null;
    }
  }

  private async reconcileDurableOperations(): Promise<readonly StructureWarfareIgnitionOperation[]> {
    const operations = await this.warfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND);
    const durableOperationIds = new Set(operations.map((operation) => operation.operationId));
    // Drop runtime sessions whose durable rows were cancelled or retired by
    // reconciliation (for example, a target destroyed while its burn timer
    // was disconnected).  Keep completing sessions on their own authority.
    for (const session of this.active.values()) {
      if (session.status !== "active" || durableOperationIds.has(session.operationId)) continue;
      if (session.timer) clearTimeout(session.timer);
      session.status = "cancelled";
      this.active.delete(session.operationId);
      this.hooks.sendCancelled(session, "reconciled");
    }
    for (const operation of operations) {
      if (operation.completion) {
        const session = this.active.get(operation.operationId);
        if (session?.timer) clearTimeout(session.timer);
        this.active.delete(operation.operationId);
        const result = operation.completion;
        await this.hooks.completed(this.sessionFromOperation(operation), {
          inventory: result.inventory,
          deletion: {
            flagId: result.deletion.structureId,
            affectedFlagIds: result.deletion.affectedStructureIds,
            notificationPlayerIds: result.deletion.notificationPlayerIds
          },
          replayed: result.replayed
        });
        continue;
      }
      if (operation.healthChanged) await this.hooks.healthChanged?.(operation.structureId);
      if (this.active.has(operation.operationId)) continue;
      const session: RuntimeSession = {
        ...this.sessionFromOperation(operation),
        status: "active",
        timer: null
      };
      this.active.set(session.operationId, session);
      this.schedule(session);
      // Reconciliation can discover a burn created by a damage writer or
      // restore one after restart. Publish the same started payload used by
      // manual ignition so clients receive both progress and the authoritative
      // burning Flag snapshot.
      this.hooks.sendStarted(session);
    }
    return operations;
  }

  cancelPlayer(playerId: string, reason: string): boolean {
    const session = this.activeRuntimeForPlayer(playerId);
    if (!session || session.status !== "active") return false;
    session.status = "cancelled";
    if (session.timer) clearTimeout(session.timer);
    this.active.delete(session.operationId);
    this.hooks.sendCancelled(session, reason);
    void this.persistCancellation(session, reason).catch((error: unknown) => {
      this.logger.warn({ err: error, playerId, flagId: session.flagId, reason }, "failed to persist Flag burn cancellation");
    });
    this.logger.info({ playerId, flagId: session.flagId, requestId: session.requestId }, "Flag burn cancelled");
    return true;
  }

  disconnectPlayer(playerId: string): void {
    void playerId;
  }

  async craftTorches(
    playerId: string,
    requestId: string
  ): Promise<Readonly<{ replayed: boolean; inventory: PlayerInventorySnapshot }>> {
    const operationKey = `torch-craft:${playerId}:${requestId}`;
    const client = await this.flags.databasePool.connect();
    try {
      await client.query("BEGIN");
      const debited = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:materials`,
        playerId,
        source: "torch_craft",
        sourceEntityType: "torch_recipe",
        sourceEntityId: operationKey,
        debits: FLAG_BURN_RECIPE.map((item) => ({
          ...item,
          variant: DEFAULT_INVENTORY_VARIANT
        }))
      });
      const granted = await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:output`,
        playerId,
        source: "torch_craft",
        sourceEntityType: "torch_recipe",
        sourceEntityId: operationKey,
        grants: [{
          ...FLAG_BURN_OUTPUT,
          variant: DEFAULT_INVENTORY_VARIANT
        }]
      });
      await client.query("COMMIT");
      return {
        replayed: !debited.applied && !granted.applied,
        inventory: granted.inventory
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async reserveDurableOperation(
    playerId: string,
    flagId: string,
    requestId: string,
    player: CurrentPlayer
  ): Promise<Readonly<{
    row: BurnRow;
    replayed: boolean;
    status: BurnRow["status"];
    inventory?: PlayerInventorySnapshot;
  }>> {
    try {
      const result = await this.warfare.reserveIgnition({
        kind: PERSONAL_FLAG_WARFARE_KIND,
        playerId,
        structureId: flagId,
        requestId,
        player
      });
      return {
        row: operationToRow(result.operation, result.status),
        replayed: result.replayed,
        status: result.status,
        ...(result.inventory ? { inventory: result.inventory } : {})
      };
    } catch (error) {
      if (error instanceof StructureWarfareError && error.phase === "ignition") {
        throw new FlagBurnError(error.code, error.message);
      }
      throw error;
    }
  }

  private schedule(session: RuntimeSession): void {
    const remainingMs = Math.max(0, session.completesAt - this.now());
    session.timer = setTimeout(() => {
      if (this.active.get(session.operationId) !== session || session.status !== "active") return;
      if (this.now() < session.completesAt) {
        this.schedule(session);
        return;
      }
      void this.complete(session);
    }, Math.min(remainingMs, 1_000));
  }

  private async complete(session: RuntimeSession): Promise<void> {
    if (this.active.get(session.operationId) !== session || session.status !== "active") return;
    if (this.now() < session.completesAt) {
      this.schedule(session);
      return;
    }
    session.status = "completing";
    try {
      const result = await this.completeInTransaction(session);
      if (!result) {
        // The durable adapter can reject an early timer wake-up when a
        // contested repair paused the burn and shifted its DB-clock deadline.
        // Refresh the operation before deciding that the runtime channel is
        // gone; otherwise the stale timer would strand the resumed burn.
        const current = await this.reconcileDurableOperations();
        const refreshed = current.find((operation) => operation.operationId === session.operationId && !operation.completion);
        if (refreshed) {
          this.active.delete(session.operationId);
          const resumed: RuntimeSession = {
            ...session,
            startedAt: refreshed.startedAt,
            completesAt: refreshed.completesAt,
            durationMs: refreshed.durationMs,
            status: "active",
            timer: null
          };
          this.active.set(session.operationId, resumed);
          this.schedule(resumed);
        } else {
          this.active.delete(session.operationId);
        }
        return;
      }
      this.active.delete(session.operationId);
      this.logger.info({ playerId: session.playerId, flagId: session.flagId, operationId: session.operationId }, "Flag burn completed");
      await this.hooks.completed(session, result);
    } catch (error) {
      this.active.delete(session.operationId);
      this.hooks.sendCancelled(session, "revalidation-failed");
      this.hooks.failed(session, error);
      this.logger.warn({ err: error, playerId: session.playerId, flagId: session.flagId, operationId: session.operationId }, "Flag burn failed");
      void this.persistCancellation(session, "revalidation-failed").catch(() => undefined);
    }
  }

  private async completeInTransaction(session: RuntimeSession): Promise<FlagBurnCompletion | null> {
    try {
      const result = await this.warfare.completeIgnition({
        kind: PERSONAL_FLAG_WARFARE_KIND,
        operationId: session.operationId,
        playerId: session.playerId,
        structureId: session.flagId,
        now: this.now()
      });
      if (!result) {
        if (this.now() < session.completesAt) {
          session.status = "active";
          this.schedule(session);
        }
        return null;
      }
      return {
        inventory: result.inventory,
        deletion: {
          flagId: result.deletion.structureId,
          affectedFlagIds: result.deletion.affectedStructureIds,
          notificationPlayerIds: result.deletion.notificationPlayerIds
        },
        replayed: result.replayed
      };
    } catch (error) {
      if (error instanceof StructureWarfareError && error.phase === "ignition") {
        throw new FlagBurnError(error.code, error.message);
      }
      throw error;
    }
  }

  private cancelRuntime(session: RuntimeSession, reason: string): void {
    session.status = "cancelled";
    if (session.timer) clearTimeout(session.timer);
    this.active.delete(session.operationId);
    this.hooks.sendCancelled(session, reason);
    void this.persistCancellation(session, reason).catch((error: unknown) => {
      this.logger.warn({ err: error, playerId: session.playerId, flagId: session.flagId, reason }, "failed to persist Flag burn cancellation");
    });
  }

  private async persistCancellation(session: FlagBurnSession, reason: string): Promise<void> {
    try {
      await this.warfare.cancelIgnition({
        kind: PERSONAL_FLAG_WARFARE_KIND,
        operationId: session.operationId,
        structureId: session.flagId,
        reason
      });
    } catch (error) {
      if (error instanceof StructureWarfareError && error.phase === "ignition") {
        throw new FlagBurnError(error.code, error.message);
      }
      throw error;
    }
  }

  private assertPlayerCanStart(playerId: string, player: CurrentPlayer): void {
    if (!player.online) throw new FlagBurnError("FLAG_BURN_DISCONNECTED", "You must be online to burn a Flag.");
    if (player.target) throw new FlagBurnError("FLAG_BURN_MOVING", "Stop moving before burning a Flag.");
    if (this.hooks.isPlayerAlive && !this.hooks.isPlayerAlive(playerId)) {
      throw new FlagBurnError("FLAG_BURN_DEFEATED", "You cannot burn a Flag while defeated.");
    }
  }

  private assertBurnableTarget(
    playerId: string,
    flag: Awaited<ReturnType<FlagService["getFlag"]>>,
    player: CurrentPlayer
  ): void {
    if (!flag) throw new FlagBurnError("FLAG_NOT_FOUND", "Flag does not exist.");
    const expectedHealth = structureWarfareHealthForReinforcementLevel(Number(flag.reinforcementLevel), flag.towerLevel);
    const breachThreshold = structureWarfareBreachThresholdForReinforcementLevel(Number(flag.reinforcementLevel), flag.towerLevel);
    if (
      flag.controlType !== "personal" ||
      (flag.ownerId === playerId && flag.developerTestTarget !== true) ||
      !["flag", "buoy"].includes(flag.anchorKind ?? "flag") ||
      flag.systemControlled ||
      (flag.cityId ?? null) !== null ||
      (flag.kingdomId ?? null) !== null ||
      !["base", "stone", "atlas_shrine", "tower"].includes(flag.upgradeTier ?? "base") ||
      // A durable replay may observe the presentation health countdown. The
      // adapter still revalidates fresh ignition against the locked row.
      (!flag.burning && (
        flag.health === null || flag.health === undefined ||
        flag.maximumHealth === null || flag.maximumHealth === undefined ||
        expectedHealth === null ||
        breachThreshold === null ||
        Number(flag.maximumHealth) !== expectedHealth ||
        Number(flag.health) > breachThreshold
      ))
    ) throw new FlagBurnError("FLAG_BURN_TARGET_INVALID", "This Flag is not ready to burn.");
    if (distanceMeters(player.position, { lat: flag.lat, lon: flag.lon }) > FLAG_BURN_INTERACTION_RADIUS_M) {
      throw new FlagBurnError(
        "FLAG_BURN_OUT_OF_RANGE",
        `Move within ${FLAG_BURN_INTERACTION_RADIUS_M}m of the Flag before burning it.`
      );
    }
  }

  private sessionFromRow(row: BurnRow): FlagBurnSession {
    return {
      operationId: row.operation_id,
      playerId: row.burner_player_id,
      victimPlayerId: row.victim_player_id,
      flagId: row.flag_id,
      requestId: row.request_id,
      flagName: row.flag_name,
      position: { lat: Number(row.flag_lat), lon: Number(row.flag_lon) },
      startedAt: new Date(row.started_at).getTime(),
      completesAt: new Date(row.completes_at).getTime(),
      durationMs: Number(row.burn_duration_ms) ||
        structureWarfareBurnDurationForReinforcementLevel(Number(row.reinforcement_level)) ||
        FLAG_BURN_DURATION_MS,
      noticeMessage: row.notice_message
    };
  }

  private sessionFromOperation(operation: StructureWarfareIgnitionOperation): FlagBurnSession {
    return {
      operationId: operation.operationId,
      playerId: operation.attackerId,
      victimPlayerId: operation.defenderId,
      flagId: operation.structureId,
      requestId: operation.requestId,
      flagName: operation.structureName,
      position: operation.position,
      startedAt: operation.startedAt,
      completesAt: operation.completesAt,
      durationMs: operation.durationMs,
      noticeMessage: operation.noticeMessage
    };
  }

}

function operationToRow(
  operation: StructureWarfareIgnitionOperation,
  status: BurnRow["status"]
): BurnRow {
  return {
    operation_id: operation.operationId,
    burner_player_id: operation.attackerId,
    victim_player_id: operation.defenderId,
    flag_id: operation.structureId,
    request_id: operation.requestId,
    flag_name: operation.structureName,
    flag_lat: operation.position.lat,
    flag_lon: operation.position.lon,
    notice_message: operation.noticeMessage,
    started_at: new Date(operation.startedAt),
    completes_at: new Date(operation.completesAt),
    status,
    reinforcement_level: operation.reinforcementLevel,
    burn_duration_ms: operation.durationMs
  };
}
