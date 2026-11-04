import type { PlayerInventorySnapshot } from "@ash-atlas/shared";

export const PERSONAL_FLAG_WARFARE_KIND = "personal_flag" as const;

export type StructureWarfareKind = typeof PERSONAL_FLAG_WARFARE_KIND;

export type StructureWarfarePlayer = Readonly<{
  position: Readonly<{ lat: number; lon: number }>;
  target: Readonly<{ lat: number; lon: number }> | null;
  online: boolean;
}>;

export type StructureWarfareRepairPlayer = StructureWarfarePlayer;

export type StructureWarfareAttackInput = Readonly<{
  kind: StructureWarfareKind;
  playerId: string;
  structureId: string;
  requestId: string;
  player: StructureWarfarePlayer;
  /**
   * A pet strike on the player's behalf (Tail Lash): reach is measured from `origin`, the player
   * may be moving, and the hit deals the full hit phase (down to the burn threshold). Every other
   * rule (ownership, alliances, peace, burning, the per-player 24 h hit cooldown) is unchanged.
   */
  strike?: Readonly<{ origin: Readonly<{ lat: number; lon: number }>; radiusM: number; /** Fixed damage before reductions (Ember Bomb); pet strikes roll their own. */ damage?: number }>;
}>;

export type StructureWarfareAttackResult = Readonly<{
  structure: unknown;
  damage: number;
  replayed: boolean;
}>;

export type StructureWarfareIgnitionInput = Readonly<{
  kind: StructureWarfareKind;
  playerId: string;
  structureId: string;
  requestId: string;
  player: StructureWarfarePlayer;
}>;

export type StructureWarfareIgnitionOperation = Readonly<{
  operationId: string;
  attackerId: string;
  defenderId: string;
  structureId: string;
  requestId: string;
  structureName: string;
  reinforcementLevel: number;
  position: Readonly<{ lat: number; lon: number }>;
  startedAt: number;
  completesAt: number;
  durationMs: number;
  noticeMessage: string;
  /** Reconciliation committed a periodic HP change that needs publication. */
  healthChanged?: boolean;
  /** Reconciliation atomically completed a burn whose damage exhausted HP. */
  completion?: StructureWarfareIgnitionCompletion;
}>;

export type StructureWarfareIgnitionStartResult = Readonly<{
  operation: StructureWarfareIgnitionOperation;
  replayed: boolean;
  status: "active" | "cancelled" | "completed";
  inventory?: PlayerInventorySnapshot;
}>;

export type StructureWarfareDeletionResult = Readonly<{
  structureId: string;
  affectedStructureIds: readonly string[];
  notificationPlayerIds: readonly string[];
}>;

export type StructureWarfareIgnitionCompletion = Readonly<{
  inventory: PlayerInventorySnapshot;
  deletion: StructureWarfareDeletionResult;
  replayed: boolean;
}>;

export type StructureWarfareRepairOperation = Readonly<{
  operationId: string;
  ownerId: string;
  structureId: string;
  requestId: string;
  structureName: string;
  reinforcementLevel: number;
  position: Readonly<{ lat: number; lon: number }>;
  startedAt: number;
  completesAt: number;
  durationMs: number;
  pausedBurnRemainingMs: number;
  repairKitQuantity: number;
  stoneQuantity: number;
}>;

export type StructureWarfareRepairStartResult = Readonly<{
  operation: StructureWarfareRepairOperation;
  replayed: boolean;
  status: "active" | "cancelled" | "completed" | "disrupted" | "server_refunded";
  inventory: PlayerInventorySnapshot;
}>;

export type StructureWarfareRepairCompletion = Readonly<{
  structure: unknown;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
}>;

/** One progressive repair tick (5x burn rate, billed per chunk). */
export type StructureWarfareRepairProgress =
  | Readonly<{
      status: "active";
      operation: StructureWarfareRepairOperation;
      healthRestored: number;
      structure?: unknown;
    }>
  | Readonly<{
      status: "completed";
      structure: unknown;
      inventory: PlayerInventorySnapshot;
      replayed: boolean;
    }>
  | Readonly<{ status: "stopped"; reason: string }>;

export type StructureWarfareDisruptOperation = Readonly<{
  operationId: string;
  contributorId: string;
  structureId: string;
  repairOperationId: string;
  requestId: string;
  damageCycleId: string;
  position: Readonly<{ lat: number; lon: number }>;
  startedAt: number;
  completesAt: number;
  durationMs: number;
}>;

export type StructureWarfareDisruptStartResult = Readonly<{
  operation: StructureWarfareDisruptOperation;
  replayed: boolean;
  status: "active" | "cancelled" | "completed";
}>;

export type StructureWarfareDisruptCompletion = Readonly<{
  repairOperationId: string;
  replayed: boolean;
}>;

export type StructureWarfareAdapter = Readonly<{
  readonly kind: StructureWarfareKind;
  attack(input: StructureWarfareAttackInput): Promise<StructureWarfareAttackResult>;
  reserveIgnition(input: StructureWarfareIgnitionInput): Promise<StructureWarfareIgnitionStartResult>;
  completeIgnition(input: Readonly<{
    kind: StructureWarfareKind;
    operationId: string;
    playerId: string;
    structureId: string;
    now: number;
  }>): Promise<StructureWarfareIgnitionCompletion | null>;
  cancelIgnition(input: Readonly<{
    kind: StructureWarfareKind;
    operationId: string;
    structureId: string;
    reason: string;
  }>): Promise<void>;
  reconcileIgnitions(kind: StructureWarfareKind): Promise<readonly StructureWarfareIgnitionOperation[]>;
  reserveRepair(input: Readonly<{
    kind: StructureWarfareKind;
    playerId: string;
    structureId: string;
    requestId: string;
    player: StructureWarfarePlayer;
  }>): Promise<StructureWarfareRepairStartResult>;
  completeRepair(input: Readonly<{
    kind: StructureWarfareKind;
    operationId: string;
    playerId: string;
    structureId: string;
    now: number;
  }>): Promise<StructureWarfareRepairCompletion | null>;
  advanceRepair(input: Readonly<{
    kind: StructureWarfareKind;
    operationId: string;
    playerId: string;
    structureId: string;
  }>): Promise<StructureWarfareRepairProgress | null>;
  cancelRepair(input: Readonly<{
    kind: StructureWarfareKind;
    operationId: string;
    playerId: string;
    structureId: string;
    reason: string;
  }>): Promise<void>;
  recoverRepairsForServerShutdown(kind: StructureWarfareKind): Promise<void>;
  reconcileRepairs(kind: StructureWarfareKind): Promise<readonly StructureWarfareRepairOperation[]>;
  reserveDisrupt(input: Readonly<{
    kind: StructureWarfareKind;
    playerId: string;
    structureId: string;
    repairOperationId: string;
    requestId: string;
    player: StructureWarfarePlayer;
  }>): Promise<StructureWarfareDisruptStartResult>;
  completeDisrupt(input: Readonly<{
    kind: StructureWarfareKind;
    operationId: string;
    playerId: string;
    structureId: string;
    now: number;
  }>): Promise<StructureWarfareDisruptCompletion | null>;
  cancelDisrupt(input: Readonly<{
    kind: StructureWarfareKind;
    operationId: string;
    playerId: string;
    structureId: string;
    reason: string;
  }>): Promise<void>;
  reconcileDisrupts(kind: StructureWarfareKind): Promise<readonly StructureWarfareDisruptOperation[]>;
}>;

export class StructureWarfareError extends Error {
  constructor(
    readonly phase: "attack" | "ignition" | "repair" | "disrupt" | "system",
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "StructureWarfareError";
  }
}

/**
 * Stable domain seam for structure warfare. Structure-specific ownership,
 * control, and lifecycle rules stay in an adapter; this service only selects
 * the adapter for the requested structure kind.
 */
export class StructureWarfareService {
  private readonly adapters: ReadonlyMap<StructureWarfareKind, StructureWarfareAdapter>;

  constructor(adapters: StructureWarfareAdapter | readonly StructureWarfareAdapter[]) {
    const values = Array.isArray(adapters) ? adapters : [adapters];
    this.adapters = new Map(values.map((adapter) => [adapter.kind, adapter]));
  }

  attack(input: StructureWarfareAttackInput): Promise<StructureWarfareAttackResult> {
    return this.adapterFor(input.kind).attack(input);
  }

  reserveIgnition(input: StructureWarfareIgnitionInput): Promise<StructureWarfareIgnitionStartResult> {
    return this.adapterFor(input.kind).reserveIgnition(input);
  }

  startIgnition(input: StructureWarfareIgnitionInput): Promise<StructureWarfareIgnitionStartResult> {
    return this.reserveIgnition(input);
  }

  completeIgnition(input: Readonly<{
    kind: StructureWarfareKind;
    operationId: string;
    playerId: string;
    structureId: string;
    now: number;
  }>): Promise<StructureWarfareIgnitionCompletion | null> {
    return this.adapterFor(input.kind).completeIgnition(input);
  }

  cancelIgnition(input: Readonly<{
    kind: StructureWarfareKind;
    operationId: string;
    structureId: string;
    reason: string;
  }>): Promise<void> {
    return this.adapterFor(input.kind).cancelIgnition(input);
  }

  reconcileIgnitions(kind: StructureWarfareKind): Promise<readonly StructureWarfareIgnitionOperation[]> {
    return this.adapterFor(kind).reconcileIgnitions(kind);
  }

  reserveRepair(input: Readonly<{
    kind: StructureWarfareKind;
    playerId: string;
    structureId: string;
    requestId: string;
    player: StructureWarfarePlayer;
  }>): Promise<StructureWarfareRepairStartResult> {
    return this.adapterFor(input.kind).reserveRepair(input);
  }

  completeRepair(input: Readonly<{
    kind: StructureWarfareKind;
    operationId: string;
    playerId: string;
    structureId: string;
    now: number;
  }>): Promise<StructureWarfareRepairCompletion | null> {
    return this.adapterFor(input.kind).completeRepair(input);
  }

  advanceRepair(input: Readonly<{
    kind: StructureWarfareKind;
    operationId: string;
    playerId: string;
    structureId: string;
  }>): Promise<StructureWarfareRepairProgress | null> {
    return this.adapterFor(input.kind).advanceRepair(input);
  }

  cancelRepair(input: Readonly<{
    kind: StructureWarfareKind;
    operationId: string;
    playerId: string;
    structureId: string;
    reason: string;
  }>): Promise<void> {
    return this.adapterFor(input.kind).cancelRepair(input);
  }

  recoverRepairsForServerShutdown(kind: StructureWarfareKind): Promise<void> {
    return this.adapterFor(kind).recoverRepairsForServerShutdown(kind);
  }

  reconcileRepairs(kind: StructureWarfareKind): Promise<readonly StructureWarfareRepairOperation[]> {
    return this.adapterFor(kind).reconcileRepairs(kind);
  }

  reserveDisrupt(input: Readonly<{
    kind: StructureWarfareKind;
    playerId: string;
    structureId: string;
    repairOperationId: string;
    requestId: string;
    player: StructureWarfarePlayer;
  }>): Promise<StructureWarfareDisruptStartResult> {
    return this.adapterFor(input.kind).reserveDisrupt(input);
  }

  completeDisrupt(input: Readonly<{
    kind: StructureWarfareKind;
    operationId: string;
    playerId: string;
    structureId: string;
    now: number;
  }>): Promise<StructureWarfareDisruptCompletion | null> {
    return this.adapterFor(input.kind).completeDisrupt(input);
  }

  cancelDisrupt(input: Readonly<{
    kind: StructureWarfareKind;
    operationId: string;
    playerId: string;
    structureId: string;
    reason: string;
  }>): Promise<void> {
    return this.adapterFor(input.kind).cancelDisrupt(input);
  }

  reconcileDisrupts(kind: StructureWarfareKind): Promise<readonly StructureWarfareDisruptOperation[]> {
    return this.adapterFor(kind).reconcileDisrupts(kind);
  }

  private adapterFor(kind: StructureWarfareKind): StructureWarfareAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      throw new StructureWarfareError(
        "system",
        "STRUCTURE_WARFARE_UNSUPPORTED",
        `Structure warfare is unavailable for ${kind}.`
      );
    }
    return adapter;
  }
}
