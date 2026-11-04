import type {
  AbilityTargetMode,
  GeneralSkillId,
  LatLon,
  MobAppearanceVariant,
  MobArchetypeKey,
  ResourceVision,
  WaterShoreHint
} from "@ash-atlas/shared";

import type { WaterLeg } from "./state.js";

type CommandEnvelope = {
  playerId: string;
  accountId: string;
  connectionId: string;
  requestId: string;
  acceptedTick: number;
  acceptedRelocationRevision?: number;
};

type AbilityTargetSelection = {
  targetEntityId?: string;
  targetMode?: AbilityTargetMode;
  targetPosition?: LatLon;
};

export type WorldCommand =
  | (CommandEnvelope & {
      kind: "move";
      target: LatLon;
      boundTravelRequestId?: string;
      waterLeg?: WaterLeg;
      shore?: WaterShoreHint;
    })
  | (CommandEnvelope & {
      kind: "dash";
      /** World-space unit vector: dirX east, dirY north. */
      dirX: number;
      dirY: number;
      /** Water planning cap (shoreline); the leash/edge clamp happens at command time. */
      maxDistanceM?: number;
      receivedAtMs: number;
    })
  | (CommandEnvelope & {
      kind: "swing";
      /** Client per-connection sequence (monotonic); echoed in SWING_RESULT. */
      seq: number;
      /** World-space unit vector: dirX east, dirY north. */
      dirX: number;
      dirY: number;
      /** Client lag hint, schema-capped at 1 s; the engine clamps it to SWING_LAG_COMP_MAX_MS. */
      lagMs: number;
      receivedAtMs: number;
    })
  | (CommandEnvelope & { kind: "start-attack"; targetEntityId: string })
  | (CommandEnvelope & { kind: "cancel-attack" })
  | (CommandEnvelope & AbilityTargetSelection & { kind: "normal-ability"; abilityId: string })
  | (CommandEnvelope & AbilityTargetSelection & {
      kind: "general-active";
      skillId: GeneralSkillId | "edict_stride";
      /** World Knowledge rank for `edict_stride`, resolved by the handler. */
      worldKnowledgeRank?: number;
      /** Called once the engine has accepted a Edict Stride use; the Edict Seal is charged only then. */
      onEdictStrideAccepted?: () => void;
      directionDegrees?: number;
    })
  | (CommandEnvelope & AbilityTargetSelection & { kind: "ultimate-ability"; abilityId: string })
  | (CommandEnvelope & AbilityTargetSelection & { kind: "reset-ability"; abilityId: string })
  | (CommandEnvelope & { kind: "universal-taunt"; acceptedViewGeneration: number })
  | (CommandEnvelope & {
      kind: "dev-spawn-mob";
      archetype: MobArchetypeKey;
      appearanceVariant?: MobAppearanceVariant;
      position: LatLon;
    })
  | (CommandEnvelope & { kind: "dev-clear-mobs" })
  | (CommandEnvelope & {
      kind: "dev-teleport";
      destination: LatLon;
      resourceVision?: ResourceVision;
    })
  | (CommandEnvelope & {
      kind: "lifecycle-cancel";
      reason: "visit-flag" | "visit-city" | "connection-replaced" | "manor-entry";
    })
  | (CommandEnvelope & { kind: "disconnect-player" });

export type WorldCommandInput = WorldCommand extends infer Command
  ? Command extends WorldCommand
    ? Omit<Command, "acceptedTick" | "acceptedViewGeneration" | "acceptedRelocationRevision">
    : never
  : never;

export type CommandProcessResult = "processed" | "rejected" | "stale";

export type WorldCommandQueueMetrics = {
  depth: number;
  peakDepth: number;
  accepted: number;
  processed: number;
  rejected: number;
  stale: number;
  duplicates: number;
  globalOverflows: number;
  playerOverflows: number;
};

export type EnqueueResult =
  | { accepted: true; sequence: number; buffered?: boolean }
  | { accepted: false; reason: "duplicate" | "global-overflow" | "player-overflow" | "transition-pending" };

type QueuedCommand = {
  sequence: number;
  command: WorldCommand;
};

export class WorldCommandQueue {
  private readonly queued: QueuedCommand[] = [];
  private readonly queuedByPlayer = new Map<string, number>();
  private readonly pendingMovementsByPlayer = new Map<string, number>();
  private readonly seenRequests = new Map<string, number>();
  private head = 0;
  private nextSequence = 1;
  private metrics: WorldCommandQueueMetrics = {
    depth: 0,
    peakDepth: 0,
    accepted: 0,
    processed: 0,
    rejected: 0,
    stale: 0,
    duplicates: 0,
    globalOverflows: 0,
    playerOverflows: 0
  };

  constructor(
    readonly globalLimit: number,
    readonly perPlayerLimit: number,
    private readonly requestRetentionTicks: number
  ) {
    if (globalLimit <= 0 || perPlayerLimit <= 0 || requestRetentionTicks <= 0) {
      throw new Error("world command queue limits must be positive");
    }
  }

  enqueue(command: WorldCommand): EnqueueResult {
    const requestKey = `${command.playerId}:${command.requestId}`;
    if (this.seenRequests.has(requestKey)) {
      this.metrics.duplicates += 1;
      return { accepted: false, reason: "duplicate" };
    }
    if (this.depth >= this.globalLimit) {
      this.metrics.globalOverflows += 1;
      this.metrics.rejected += 1;
      return { accepted: false, reason: "global-overflow" };
    }
    const playerDepth = this.queuedByPlayer.get(command.playerId) ?? 0;
    if (playerDepth >= this.perPlayerLimit) {
      this.metrics.playerOverflows += 1;
      this.metrics.rejected += 1;
      return { accepted: false, reason: "player-overflow" };
    }

    const sequence = this.nextSequence++;
    this.queued.push({ sequence, command });
    this.queuedByPlayer.set(command.playerId, playerDepth + 1);
    if (command.kind === "move") {
      this.pendingMovementsByPlayer.set(
        command.playerId,
        (this.pendingMovementsByPlayer.get(command.playerId) ?? 0) + 1
      );
    }
    this.seenRequests.set(requestKey, command.acceptedTick);
    this.metrics.accepted += 1;
    this.updateDepthMetrics();
    this.pruneSeenRequests(command.acceptedTick);
    return { accepted: true, sequence };
  }

  drain(
    maximum: number,
    process: (command: WorldCommand, sequence: number) => CommandProcessResult
  ): number {
    const limit = Math.max(0, Math.min(maximum, this.depth));
    for (let index = 0; index < limit; index += 1) {
      const queued = this.queued[this.head++];
      if (!queued) {
        break;
      }
      const playerDepth = (this.queuedByPlayer.get(queued.command.playerId) ?? 1) - 1;
      if (playerDepth <= 0) {
        this.queuedByPlayer.delete(queued.command.playerId);
      } else {
        this.queuedByPlayer.set(queued.command.playerId, playerDepth);
      }
      if (queued.command.kind === "move") {
        const pendingMovements =
          (this.pendingMovementsByPlayer.get(queued.command.playerId) ?? 1) - 1;
        if (pendingMovements <= 0) {
          this.pendingMovementsByPlayer.delete(queued.command.playerId);
        } else {
          this.pendingMovementsByPlayer.set(queued.command.playerId, pendingMovements);
        }
      }
      const result = process(queued.command, queued.sequence);
      if (result === "processed") {
        this.metrics.processed += 1;
      } else if (result === "stale") {
        this.metrics.stale += 1;
      } else {
        this.metrics.rejected += 1;
      }
    }
    this.compactIfNeeded();
    this.updateDepthMetrics();
    return limit;
  }

  metricsSnapshot(): WorldCommandQueueMetrics {
    return { ...this.metrics, depth: this.depth };
  }

  get depth(): number {
    return this.queued.length - this.head;
  }

  hasPendingForPlayer(playerId: string): boolean {
    return (this.queuedByPlayer.get(playerId) ?? 0) > 0;
  }

  hasPendingMovementForPlayer(playerId: string): boolean {
    return (this.pendingMovementsByPlayer.get(playerId) ?? 0) > 0;
  }

  /** O(n) diagnostic assertion; never call from the command-processing hot path. */
  assertInternalConsistency(): void {
    const queuedByPlayer = new Map<string, number>();
    const movementsByPlayer = new Map<string, number>();
    for (let index = this.head; index < this.queued.length; index += 1) {
      const command = this.queued[index]?.command;
      if (!command) throw new Error(`world command queue has an empty entry at ${index}`);
      queuedByPlayer.set(command.playerId, (queuedByPlayer.get(command.playerId) ?? 0) + 1);
      if (command.kind === "move") {
        movementsByPlayer.set(
          command.playerId,
          (movementsByPlayer.get(command.playerId) ?? 0) + 1
        );
      }
    }
    assertCountMap("queued commands", this.queuedByPlayer, queuedByPlayer);
    assertCountMap("pending movements", this.pendingMovementsByPlayer, movementsByPlayer);
  }

  private pruneSeenRequests(currentTick: number): void {
    if (this.seenRequests.size <= this.globalLimit * 2) {
      return;
    }
    const cutoff = currentTick - this.requestRetentionTicks;
    for (const [key, acceptedTick] of this.seenRequests) {
      if (acceptedTick < cutoff) {
        this.seenRequests.delete(key);
      }
    }
    const hardLimit = this.globalLimit * 4;
    if (this.seenRequests.size > hardLimit) {
      for (const key of this.seenRequests.keys()) {
        this.seenRequests.delete(key);
        if (this.seenRequests.size <= hardLimit) {
          break;
        }
      }
    }
  }

  private compactIfNeeded(): void {
    if (this.head === 0 || (this.head < 1_024 && this.head * 2 < this.queued.length)) {
      return;
    }
    this.queued.splice(0, this.head);
    this.head = 0;
  }

  private updateDepthMetrics(): void {
    this.metrics.depth = this.depth;
    this.metrics.peakDepth = Math.max(this.metrics.peakDepth, this.depth);
  }
}

function assertCountMap(
  label: string,
  indexed: ReadonlyMap<string, number>,
  scanned: ReadonlyMap<string, number>
): void {
  if (indexed.size !== scanned.size) {
    throw new Error(`${label} index size ${indexed.size} did not match scanned size ${scanned.size}`);
  }
  for (const [playerId, count] of scanned) {
    if (indexed.get(playerId) !== count) {
      throw new Error(
        `${label} index for ${playerId} was ${indexed.get(playerId) ?? 0}; expected ${count}`
      );
    }
  }
}
