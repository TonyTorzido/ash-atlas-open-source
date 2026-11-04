import {
  isPointInsideBossGeometry,
  type BossCastSnapshot,
  type BossDefinition,
  type BossEntityOwnership,
  type BossEncounterProjection,
  type BossHostKind,
  type BossLifecycleState,
  type BossRewardPolicy,
  type BossTelegraphGeometry,
  type LatLon,
  distanceMeters,
  isFiniteLatLon,
  validateBossGeometry
} from "@ash-atlas/shared";

import type { CombatDefeatSettlementCandidate } from "./combat/combatEngine.js";

/** A host decides who may participate; a controller never owns this policy. */
export interface BossHostAdapter {
  readonly hostKind: BossHostKind;
  readonly encounterHandlerId: string;
  readonly hostInstanceId: string;
  readonly encounterInstanceId: string;
  readonly participationPolicyId: string;
  getEligibleParticipants(): readonly string[];
  canParticipate(playerId: string): boolean;
  onLifecycleChanged?(state: BossLifecycleState, encounter: BossEncounter): void;
  onPhaseChanged?(phaseId: string, encounter: BossEncounter): void;
  onDefeated?(encounter: BossEncounter): void;
  onReset?(encounter: BossEncounter): void;
  onCancelled?(encounter: BossEncounter, reason: string): void;
  /** Dungeon hosts: the boss room's objects (bombs, arms) and room notices, for bespoke controllers. */
  readonly room?: BossRoomHooks;
}

export type BossRoomHooks = Readonly<{
  objectAvailable(objectId: string): boolean;
  objectState(objectId: string): string | null;
  setObjectAvailable(objectId: string, available: boolean): void;
  setObjectState(objectId: string, state: "idle" | "intact" | "destroyed" | "open" | "closed" | "on" | "off"): void;
  /** A HUD line for one player, or for everyone in the room when playerId is null. */
  notify(playerId: string | null, text: string, tone: "info" | "success" | "warning"): void;
}>;

export type BossCastRequest = Readonly<{
  abilityId: string;
  geometry: BossTelegraphGeometry;
  startTime?: number;
  resolveTime?: number;
  castDurationMs?: number;
  origin?: LatLon;
  facingDegrees?: number;
  targetEntityId?: string;
  castInstanceId?: string;
  lifeGeneration?: number;
}>;

export type BossCastResolution = Readonly<{
  cast: BossCastSnapshot;
  eligibleParticipantIds: readonly string[];
  hitParticipantIds: readonly string[];
}>;

export type BossCastResolver = Readonly<{
  positionOfEntity(entityId: string): LatLon | null;
  applyHit(cast: BossCastSnapshot, participantId: string): void;
}>;

export type BossControllerContext = Readonly<{
  encounter: BossEncounter;
  now: number;
  lifeGeneration: number;
  eligibleParticipants: readonly string[];
  beginCast(input: BossCastRequest): BossCastSnapshot | null;
  selectTarget(policy: BossTargetingPolicy, origin?: LatLon): string | null;
}>;

export interface BossController {
  onActivate?(context: BossControllerContext): void;
  update?(context: BossControllerContext): void;
  onDamage?(context: BossControllerContext, amount: number, sourceEntityId: string): void;
  onPhaseTransition?(context: BossControllerContext, previousPhaseId: string | null): void;
  onReset?(context: BossControllerContext): void;
  onDefeat?(context: BossControllerContext): void;
  destroy?(context: BossControllerContext): void;
  /** A player used an object in the boss's room (never called for a replayed request). */
  onObjectInteract?(context: BossControllerContext, playerId: string, objectId: string): void;
}

export type BossControllerFactory = (
  context: BossControllerContext
) => BossController;

export type BossTargetingPolicy =
  | Readonly<{ kind: "current"; currentTargetEntityId: string | null }>
  | Readonly<{ kind: "random" }>
  | Readonly<{ kind: "nearest"; origin: LatLon }>;

export type BossEncounterOptions = Readonly<{
  encounterId: string;
  definition: BossDefinition;
  host: BossHostAdapter;
  mobEntityId: string;
  controller: BossController;
  initialState?: BossLifecycleState;
  initialPhaseId?: string | null;
  lifeGeneration?: number;
  initialAppearanceVariant?: BossEntityOwnership["appearanceVariant"];
  positionOfEntity?: (entityId: string) => LatLon | null;
  now?: () => number;
}>;

export type BossEncounterTickResult = Readonly<{
  resolved: readonly BossCastResolution[];
  state: BossLifecycleState;
}>;

const MAX_RECENT_CAST_IDS = 256;
const MAX_ACTIVE_CASTS = 64;

/**
 * One live boss life.  It owns every cast and generation check, so callers do
 * not need per-boss timers or callback cleanup to make reset/death safe.
 */
export class BossEncounter {
  private controller: BossController;
  private state: BossLifecycleState;
  private phaseId: string | null;
  private phaseDeadlineAtValue: number | null = null;
  private lifeGenerationValue: number;
  private castSequence = 0;
  private readonly activeCastById = new Map<string, BossCastSnapshot>();
  private readonly completedCastIds = new Set<string>();
  private readonly cancelledCastIds = new Set<string>();
  private movementOverrideValue: BossMovementOverride | null = null;
  private destroyed = false;
  private activationNotified = false;
  private failureReasonValue: string | null = null;

  readonly now: () => number;

  constructor(private readonly options: BossEncounterOptions) {
    if (!options.encounterId.trim()) throw new Error("Boss encounter id is required");
    if (!options.mobEntityId.trim()) throw new Error("Boss mob entity id is required");
    if (!options.definition.id.trim()) throw new Error("Boss definition id is required");
    if (!Number.isSafeInteger(options.definition.revision) || options.definition.revision < 1) {
      throw new Error("Boss definition revision must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.lifeGeneration ?? 0) || (options.lifeGeneration ?? 0) < 0) {
      throw new Error("Boss encounter life generation must be a non-negative safe integer");
    }
    this.state = options.initialState ?? "created";
    this.phaseId = options.initialPhaseId ?? null;
    this.lifeGenerationValue = options.lifeGeneration ?? 0;
    this.now = options.now ?? Date.now;
    this.controller = options.controller;
  }

  get encounterId(): string { return this.options.encounterId; }
  get definition(): BossDefinition { return this.options.definition; }
  get host(): BossHostAdapter { return this.options.host; }
  get mobEntityId(): string { return this.options.mobEntityId; }
  get lifecycleState(): BossLifecycleState { return this.state; }
  get phase(): string | null { return this.phaseId; }
  get phaseDeadlineAt(): number | null { return this.phaseDeadlineAtValue; }
  get lifeGeneration(): number { return this.lifeGenerationValue; }
  get activeCasts(): readonly BossCastSnapshot[] { return [...this.activeCastById.values()]; }
  get movementOverride(): BossMovementOverride | null {
    return this.movementOverrideValue ? { ...this.movementOverrideValue } : null;
  }

  ownership(): BossEntityOwnership {
    return {
      bossId: this.definition.id,
      bossRevision: this.definition.revision,
      encounterHandlerId: this.host.encounterHandlerId,
      hostKind: this.host.hostKind,
      hostInstanceId: this.host.hostInstanceId,
      encounterInstanceId: this.host.encounterInstanceId,
      ...(this.definition.appearanceId ? { appearanceId: this.definition.appearanceId } : {}),
      ...(this.options.initialAppearanceVariant
        ? { appearanceVariant: this.options.initialAppearanceVariant }
        : {}),
      lifeGeneration: this.lifeGenerationValue
    };
  }

  activate(): boolean {
    if (this.destroyed || this.state === "defeated" || this.state === "cancelled" || this.state === "despawned") {
      return false;
    }
    if (this.state === "active") {
      if (!this.activationNotified) {
        this.activationNotified = true;
        this.options.host.onLifecycleChanged?.(this.state, this);
        this.controller.onActivate?.(this.controllerContext(this.now()));
      }
      return false;
    }
    this.state = "active";
    this.activationNotified = true;
    this.options.host.onLifecycleChanged?.(this.state, this);
    this.controller.onActivate?.(this.controllerContext(this.now()));
    return true;
  }

  /** Hosts may choose a dormant state without activating mechanics. */
  dormanize(): boolean {
    if (this.destroyed || this.state === "defeated" || this.state === "cancelled" || this.state === "despawned") {
      return false;
    }
    this.cancelAllCasts("dormant");
    this.state = "dormant";
    this.phaseDeadlineAtValue = null;
    this.movementOverrideValue = null;
    this.options.host.onLifecycleChanged?.(this.state, this);
    return true;
  }

  setDormant(): boolean { return this.dormanize(); }

  reset(): boolean {
    if (this.destroyed || this.state === "defeated" || this.state === "cancelled" || this.state === "despawned") {
      return false;
    }
    this.state = "resetting";
    this.cancelAllCasts("reset");
    this.lifeGenerationValue += 1;
    this.phaseId = null;
    this.phaseDeadlineAtValue = null;
    this.movementOverrideValue = null;
    this.options.host.onLifecycleChanged?.(this.state, this);
    this.controller.onReset?.(this.controllerContext(this.now()));
    this.options.host.onReset?.(this);
    return true;
  }

  defeat(): boolean {
    if (this.destroyed || this.state === "defeated" || this.state === "cancelled" || this.state === "despawned") {
      return false;
    }
    this.cancelAllCasts("defeat");
    this.state = "defeated";
    this.phaseDeadlineAtValue = null;
    this.movementOverrideValue = null;
    this.options.host.onLifecycleChanged?.(this.state, this);
    this.controller.onDefeat?.(this.controllerContext(this.now()));
    this.options.host.onDefeated?.(this);
    return true;
  }

  cancel(reason = "cancelled"): boolean {
    if (this.destroyed || this.state === "defeated" || this.state === "cancelled" || this.state === "despawned") {
      return false;
    }
    this.cancelAllCasts(reason);
    this.state = "cancelled";
    this.phaseDeadlineAtValue = null;
    this.movementOverrideValue = null;
    this.options.host.onLifecycleChanged?.(this.state, this);
    this.controller.destroy?.(this.controllerContext(this.now()));
    this.options.host.onCancelled?.(this, reason);
    return true;
  }

  despawn(reason = "despawned"): boolean {
    if (this.destroyed) return false;
    this.cancelAllCasts(reason);
    this.destroyed = true;
    this.state = "despawned";
    this.phaseDeadlineAtValue = null;
    this.movementOverrideValue = null;
    this.options.host.onLifecycleChanged?.(this.state, this);
    this.controller.destroy?.(this.controllerContext(this.now()));
    this.options.host.onCancelled?.(this, reason);
    return true;
  }

  beginCast(input: BossCastRequest): BossCastSnapshot | null {
    if (this.destroyed || this.state !== "active") return null;
    if (!input.abilityId.trim()) throw new Error("Boss cast ability id is required");
    validateBossGeometry(input.geometry);
    const startTime = input.startTime ?? this.now();
    const resolveTime = input.resolveTime ?? startTime + Math.max(0, input.castDurationMs ?? 0);
    if (!Number.isFinite(startTime) || !Number.isFinite(resolveTime) || resolveTime < startTime) {
      throw new Error("Boss cast timing is invalid");
    }
    if (input.lifeGeneration !== undefined && input.lifeGeneration !== this.lifeGenerationValue) return null;
    if (input.targetEntityId !== undefined) {
      const eligibleParticipants = this.host.getEligibleParticipants();
      if (!eligibleParticipants.includes(input.targetEntityId) || !this.host.canParticipate(input.targetEntityId)) {
        return null;
      }
    }
    if (input.origin !== undefined && !isFiniteLatLon(input.origin.lat, input.origin.lon)) {
      throw new TypeError("Boss cast origin must be a finite WGS84 coordinate");
    }
    if (input.facingDegrees !== undefined && !Number.isFinite(input.facingDegrees)) {
      throw new TypeError("Boss cast facing must be finite");
    }
    if (this.activeCastById.size >= MAX_ACTIVE_CASTS) return null;
    const castInstanceId = input.castInstanceId ?? `${this.encounterId}:cast:${++this.castSequence}`;
    if (this.activeCastById.has(castInstanceId) || this.completedCastIds.has(castInstanceId) || this.cancelledCastIds.has(castInstanceId)) {
      return null;
    }
    const origin = input.origin ?? geometryOrigin(input.geometry);
    const cast: BossCastSnapshot = {
      encounterId: this.encounterId,
      bossId: this.definition.id,
      abilityId: input.abilityId,
      castInstanceId,
      startTime,
      resolveTime,
      origin: { ...origin },
      ...(input.facingDegrees === undefined ? {} : { facingDegrees: input.facingDegrees }),
      ...(input.targetEntityId === undefined ? {} : { targetEntityId: input.targetEntityId }),
      geometry: structuredClone(input.geometry),
      lifeGeneration: this.lifeGenerationValue
    };
    this.activeCastById.set(cast.castInstanceId, cast);
    return cast;
  }

  cancelCast(castInstanceId: string, reason = "cancelled"): boolean {
    void reason;
    const cast = this.activeCastById.get(castInstanceId);
    if (!cast) return false;
    this.activeCastById.delete(castInstanceId);
    this.rememberCastId(this.cancelledCastIds, castInstanceId);
    return true;
  }

  cancelAllCasts(reason = "cancelled"): number {
    void reason;
    const ids = [...this.activeCastById.keys()];
    for (const castInstanceId of ids) this.cancelCast(castInstanceId, reason);
    return ids.length;
  }

  transitionPhase(phaseId: string): boolean {
    if (this.destroyed || this.state !== "active" || !phaseId.trim() || this.phaseId === phaseId) return false;
    const previousPhaseId = this.phaseId;
    this.phaseId = phaseId;
    this.cancelAllCasts("phase-transition");
    this.options.host.onPhaseChanged?.(phaseId, this);
    this.controller.onPhaseTransition?.(this.controllerContext(this.now()), previousPhaseId);
    return true;
  }

  setMovementOverride(override: BossMovementOverride | null): void {
    if (override !== null && (
      !override.id.trim() || override.generation !== this.lifeGenerationValue ||
      (override.endsAt !== undefined && (!Number.isFinite(override.endsAt) || override.endsAt < 0)) ||
      (override.movementSpeedMps !== undefined && (!Number.isFinite(override.movementSpeedMps) || override.movementSpeedMps < 0)) ||
      (override.movementSpeedMultiplier !== undefined && (!Number.isFinite(override.movementSpeedMultiplier) || override.movementSpeedMultiplier < 0)) ||
      (override.outgoingDamageMultiplier !== undefined && (!Number.isFinite(override.outgoingDamageMultiplier) || override.outgoingDamageMultiplier < 0)) ||
      (override.incomingDamageMultiplier !== undefined && (!Number.isFinite(override.incomingDamageMultiplier) || override.incomingDamageMultiplier < 0))
    )) {
      throw new Error("Boss movement override must be valid and belong to the current life generation");
    }
    this.movementOverrideValue = override ? { ...override } : null;
  }

  /**
   * The controller asks its host to fail the encounter (K3: a timed add outlived its deadline). A
   * dungeon host resets the encounter and ejects the room (DungeonRuntime.failEncounterAndEject).
   */
  requestFailure(reason: string): void {
    if (this.state === "active" && this.failureReasonValue === null) this.failureReasonValue = reason;
  }

  get failureRequested(): string | null { return this.failureReasonValue; }

  /** Forwards a room object interaction to an active controller. */
  objectInteract(playerId: string, objectId: string): void {
    if (this.destroyed || this.state !== "active") return;
    this.controller.onObjectInteract?.(this.controllerContext(this.now()), playerId, objectId);
  }

  setPhaseDeadline(deadlineAt: number | null): void {
    if (deadlineAt !== null && (!Number.isFinite(deadlineAt) || deadlineAt < 0)) {
      throw new Error("Boss phase deadline must be a non-negative finite timestamp");
    }
    this.phaseDeadlineAtValue = deadlineAt;
  }

  tick(now = this.now(), resolver?: BossCastResolver): BossEncounterTickResult {
    if (this.destroyed) return { resolved: [], state: this.state };
    if (this.movementOverrideValue?.endsAt !== undefined && this.movementOverrideValue.endsAt <= now) {
      this.movementOverrideValue = null;
    }
    const eligibleParticipantIds = this.host.getEligibleParticipants()
      .filter((playerId) => this.host.canParticipate(playerId));
    if (this.state === "active") {
      this.controller.update?.(this.controllerContext(now, eligibleParticipantIds));
    }
    const resolved: BossCastResolution[] = [];
    for (const cast of [...this.activeCastById.values()].sort((left, right) =>
      left.resolveTime - right.resolveTime || left.castInstanceId.localeCompare(right.castInstanceId))) {
      if (cast.lifeGeneration !== this.lifeGenerationValue || cast.resolveTime > now) continue;
      this.activeCastById.delete(cast.castInstanceId);
      this.rememberCastId(this.completedCastIds, cast.castInstanceId);
      const hitParticipantIds = resolver
        ? eligibleParticipantIds.filter((playerId) => {
            if (cast.targetEntityId !== undefined && cast.targetEntityId !== playerId) return false;
            const position = resolver.positionOfEntity(playerId);
            return position !== null && isPointInsideBossGeometry(position, cast.geometry);
          })
        : [];
      if (resolver) for (const playerId of hitParticipantIds) resolver.applyHit(cast, playerId);
      resolved.push({ cast, eligibleParticipantIds, hitParticipantIds });
    }
    return { resolved, state: this.state };
  }

  projection(now = this.now(), participantId?: string): BossEncounterProjection {
    const participants = this.host.getEligibleParticipants()
      .filter((playerId) => this.host.canParticipate(playerId));
    return {
      encounterId: this.encounterId,
      bossId: this.definition.id,
      bossRevision: this.definition.revision,
      encounterHandlerId: this.host.encounterHandlerId,
      hostKind: this.host.hostKind,
      hostInstanceId: this.host.hostInstanceId,
      encounterInstanceId: this.host.encounterInstanceId,
      mobEntityId: this.mobEntityId,
      lifecycleState: this.state,
      phaseId: this.phaseId,
      ...(this.phaseDeadlineAtValue === null ? {} : { phaseDeadlineAt: this.phaseDeadlineAtValue }),
      lifeGeneration: this.lifeGenerationValue,
      participation: {
        policyId: this.host.participationPolicyId,
        canJoin: participantId === undefined || this.host.canParticipate(participantId),
        participantIds: participants
      },
      activeCasts: [...this.activeCastById.values()].filter((cast) =>
        cast.lifeGeneration === this.lifeGenerationValue && cast.resolveTime > now)
    };
  }

  controllerContext(
    now: number,
    eligibleParticipants = this.host.getEligibleParticipants().filter((playerId) => this.host.canParticipate(playerId))
  ): BossControllerContext {
    const contextGeneration = this.lifeGenerationValue;
    return {
      encounter: this,
      now,
      lifeGeneration: contextGeneration,
      eligibleParticipants,
      beginCast: (input) => this.beginCast({
        ...input,
        ...(input.startTime === undefined ? { startTime: now } : {}),
        ...(input.lifeGeneration === undefined ? { lifeGeneration: contextGeneration } : {})
      }),
      selectTarget: (policy, origin) => this.selectTarget(policy, eligibleParticipants, origin)
    };
  }

  private selectTarget(
    policy: BossTargetingPolicy,
    eligibleParticipants: readonly string[],
    origin?: LatLon
  ): string | null {
    if (policy.kind === "current") {
      return policy.currentTargetEntityId && eligibleParticipants.includes(policy.currentTargetEntityId)
        ? policy.currentTargetEntityId
        : null;
    }
    if (eligibleParticipants.length === 0) return null;
    if (policy.kind === "random") {
      return eligibleParticipants[Math.floor(Math.random() * eligibleParticipants.length)] ?? null;
    }
    const anchor = origin ?? policy.origin;
    if (!anchor) return null;
    const distances = eligibleParticipants.flatMap((playerId) => {
      const position = this.options.positionOfEntity?.(playerId);
      return position ? [{ playerId, distance: distanceMeters(anchor, position) }] : [];
    });
    distances.sort((left, right) => left.distance - right.distance || left.playerId.localeCompare(right.playerId));
    return distances[0]?.playerId ?? null;
  }

  setController(controller: BossController): void {
    if (this.destroyed) throw new Error("Cannot install a controller on a destroyed boss encounter");
    this.controller = controller;
  }

  notifyDamage(amount: number, sourceEntityId: string): void {
    if (this.state !== "active" || !Number.isFinite(amount) || amount <= 0) return;
    this.controller.onDamage?.(this.controllerContext(this.now()), amount, sourceEntityId);
  }

  private rememberCastId(set: Set<string>, castInstanceId: string): void {
    set.add(castInstanceId);
    while (set.size > MAX_RECENT_CAST_IDS) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  }
}

export type BossMovementOverride = Readonly<{
  id: string;
  generation: number;
  endsAt?: number;
  movementSpeedMps?: number;
  movementSpeedMultiplier?: number;
  outgoingDamageMultiplier?: number;
  incomingDamageMultiplier?: number;
}>;

export class BossDefinitionRegistry {
  private readonly definitions = new Map<string, BossDefinition>();

  register(definition: BossDefinition): void {
    if (!definition.id.trim()) throw new Error("Boss definition id is required");
    if (!Number.isSafeInteger(definition.revision) || definition.revision < 1) {
      throw new Error("Boss definition revision must be a positive safe integer");
    }
    if (this.definitions.has(definition.id)) throw new Error(`Duplicate boss definition: ${definition.id}`);
    this.definitions.set(definition.id, definition);
  }

  get(id: string): BossDefinition | null { return this.definitions.get(id) ?? null; }

  require(id: string): BossDefinition {
    const definition = this.get(id);
    if (!definition) throw new Error(`Unknown boss definition: ${id}`);
    return definition;
  }

  list(): readonly BossDefinition[] { return [...this.definitions.values()]; }
}

export class BossControllerRegistry {
  private readonly factories = new Map<string, BossControllerFactory>();

  register(controllerId: string, factory: BossControllerFactory): void {
    if (!controllerId.trim()) throw new Error("Boss controller id is required");
    if (this.factories.has(controllerId)) throw new Error(`Duplicate boss controller: ${controllerId}`);
    this.factories.set(controllerId, factory);
  }

  create(definition: BossDefinition, context: BossControllerContext): BossController {
    const factory = this.factories.get(definition.controllerId);
    if (!factory) throw new Error(`Unknown boss controller: ${definition.controllerId}`);
    return factory(context);
  }
}

export type BossEncounterManagerOptions = Readonly<{
  now?: () => number;
  resolver?: BossCastResolver;
  positionOfEntity?: (entityId: string) => LatLon | null;
}>;

export class BossEncounterManager {
  private readonly encountersById = new Map<string, BossEncounter>();
  private readonly encountersByEntityId = new Map<string, BossEncounter>();
  private readonly definitions: BossDefinitionRegistry;
  private readonly controllers: BossControllerRegistry;
  private readonly now: () => number;
  private readonly resolver: BossCastResolver | undefined;
  private readonly positionOfEntity: ((entityId: string) => LatLon | null) | undefined;

  constructor(
    definitions = new BossDefinitionRegistry(),
    controllers = new BossControllerRegistry(),
    options: BossEncounterManagerOptions = {}
  ) {
    this.definitions = definitions;
    this.controllers = controllers;
    this.now = options.now ?? Date.now;
    this.resolver = options.resolver;
    this.positionOfEntity = options.positionOfEntity ?? options.resolver?.positionOfEntity;
  }

  /** Hosts may register authored definitions while loading a dungeon catalog. */
  registerDefinition(definition: BossDefinition): void {
    if (this.definitions.get(definition.id)) return;
    this.definitions.register(definition);
  }

  /** Read-only lookup used by authored hosts to reuse registered boss packages. */
  definition(definitionId: string): BossDefinition | null {
    return this.definitions.get(definitionId);
  }

  definitionsList(): readonly BossDefinition[] {
    return this.definitions.list();
  }

  registerController(controllerId: string, factory: BossControllerFactory): void {
    try {
      this.controllers.register(controllerId, factory);
    } catch (error) {
      if (error instanceof Error && error.message === `Duplicate boss controller: ${controllerId}`) return;
      throw error;
    }
  }

  create(input: Readonly<{
    encounterId: string;
    definitionId: string;
    host: BossHostAdapter;
    mobEntityId: string;
    initialState?: BossLifecycleState;
    initialPhaseId?: string | null;
    lifeGeneration?: number;
    initialAppearanceVariant?: BossEntityOwnership["appearanceVariant"];
  }>): BossEncounter {
    if (this.encountersById.has(input.encounterId)) throw new Error(`Duplicate boss encounter: ${input.encounterId}`);
    if (this.encountersByEntityId.has(input.mobEntityId)) throw new Error(`Boss entity already belongs to an encounter: ${input.mobEntityId}`);
    const definition = this.definitions.require(input.definitionId);
    const provisional: BossEncounterOptions = {
      encounterId: input.encounterId,
      definition,
      host: input.host,
      mobEntityId: input.mobEntityId,
      controller: {} as BossController,
      ...(input.initialState === undefined ? {} : { initialState: input.initialState }),
      ...(input.initialPhaseId === undefined ? {} : { initialPhaseId: input.initialPhaseId }),
      ...(input.lifeGeneration === undefined ? {} : { lifeGeneration: input.lifeGeneration }),
      ...(input.initialAppearanceVariant === undefined
        ? {}
        : { initialAppearanceVariant: input.initialAppearanceVariant }),
      now: this.now,
      ...(this.positionOfEntity ? { positionOfEntity: this.positionOfEntity } : {})
    };
    const encounter = new BossEncounter(provisional);
    encounter.setController(this.controllers.create(definition, encounter.controllerContext(this.now())));
    if (encounter.lifecycleState === "active") encounter.activate();
    this.encountersById.set(encounter.encounterId, encounter);
    this.encountersByEntityId.set(encounter.mobEntityId, encounter);
    return encounter;
  }

  encounter(encounterId: string): BossEncounter | null { return this.encountersById.get(encounterId) ?? null; }
  encounterForEntity(entityId: string): BossEncounter | null { return this.encountersByEntityId.get(entityId) ?? null; }

  projectionForEntity(entityId: string, now = this.now(), participantId?: string): BossEncounterProjection | null {
    return this.encounterForEntity(entityId)?.projection(now, participantId) ?? null;
  }

  ownershipForEntity(entityId: string): BossEntityOwnership | null {
    return this.encounterForEntity(entityId)?.ownership() ?? null;
  }

  ownsDefeatCandidate(candidate: Pick<CombatDefeatSettlementCandidate, "defeatedEntityId" | "bossOwnership">): boolean {
    const encounter = this.encounterForEntity(candidate.defeatedEntityId);
    if (!encounter || encounter.lifecycleState !== "active" || !candidate.bossOwnership) return false;
    return sameOwnership(encounter.ownership(), candidate.bossOwnership);
  }

  async acceptDefeatCandidate(
    candidate: CombatDefeatSettlementCandidate,
    settle: (candidate: CombatDefeatSettlementCandidate, policy: BossRewardPolicy) => Promise<boolean> | boolean
  ): Promise<boolean> {
    const encounter = this.encounterForEntity(candidate.defeatedEntityId);
    if (!encounter || encounter.lifecycleState !== "active" || !candidate.bossOwnership ||
        !sameOwnership(encounter.ownership(), candidate.bossOwnership)) {
      return false;
    }
    const accepted = await settle(candidate, encounter.definition.rewardPolicy);
    if (accepted) encounter.defeat();
    return accepted;
  }

  tick(now = this.now()): readonly BossEncounterTickResult[] {
    const result: BossEncounterTickResult[] = [];
    for (const encounter of this.encountersById.values()) {
      result.push(encounter.tick(now, this.resolver));
    }
    return result;
  }

  /** Clear pending casts without changing host lifecycle state during service stop. */
  clearCasts(): void {
    for (const encounter of this.encountersById.values()) encounter.cancelAllCasts("manager-stop");
  }

  reset(encounterId: string): boolean { return this.encounter(encounterId)?.reset() ?? false; }
  cancel(encounterId: string, reason?: string): boolean { return this.encounter(encounterId)?.cancel(reason) ?? false; }
  despawn(encounterId: string, reason?: string): boolean {
    const encounter = this.encounter(encounterId);
    if (!encounter) return false;
    const changed = encounter.despawn(reason);
    if (changed) {
      this.encountersById.delete(encounterId);
      this.encountersByEntityId.delete(encounter.mobEntityId);
    }
    return changed;
  }

  projections(now = this.now()): readonly BossEncounterProjection[] {
    return [...this.encountersById.values()].map((encounter) => encounter.projection(now));
  }
}

/** Locked roster / proximity / event policies belong to the overworld host. */
export class OverworldBossHostAdapter implements BossHostAdapter {
  readonly hostKind = "overworld" as const;
  readonly encounterHandlerId: string;
  readonly hostInstanceId: string;
  readonly encounterInstanceId: string;
  readonly participationPolicyId: string;
  private readonly participants: Set<string>;
  private readonly eligibility: (playerId: string) => boolean;
  private readonly membershipOnly: boolean;

  constructor(input: Readonly<{
    hostInstanceId: string;
    encounterInstanceId?: string;
    encounterHandlerId?: string;
    participationPolicyId: string;
    participantIds?: readonly string[];
    canParticipate?: (playerId: string) => boolean;
  }>) {
    this.hostInstanceId = input.hostInstanceId;
    this.encounterInstanceId = input.encounterInstanceId ?? input.hostInstanceId;
    this.encounterHandlerId = input.encounterHandlerId ?? "overworld";
    this.participationPolicyId = input.participationPolicyId;
    this.participants = new Set(input.participantIds ?? []);
    this.membershipOnly = input.canParticipate === undefined;
    this.eligibility = input.canParticipate ?? ((playerId) => this.participants.has(playerId));
  }

  getEligibleParticipants(): readonly string[] {
    return [...this.participants].filter((playerId) => this.eligibility(playerId));
  }

  canParticipate(playerId: string): boolean { return this.eligibility(playerId); }

  addParticipant(playerId: string): boolean {
    if (!this.membershipOnly && !this.eligibility(playerId)) return false;
    this.participants.add(playerId);
    return true;
  }

  removeParticipant(playerId: string): boolean { return this.participants.delete(playerId); }

}

/** Dungeon participation is scoped to a single run, instance, and room. */
export class DungeonBossHostAdapter implements BossHostAdapter {
  readonly hostKind = "dungeon" as const;
  readonly encounterHandlerId = "dungeon";
  readonly hostInstanceId: string;
  readonly encounterInstanceId: string;
  readonly participationPolicyId = "dungeon-run";
  private readonly participantContext = new Map<string, Readonly<{ instanceId: string; runId: string; roomId: string }>>();
  private readonly expectedRunId: string;
  private readonly expectedRoomId: string;
  readonly room?: BossRoomHooks;

  constructor(input: Readonly<{
    instanceId: string;
    runId: string;
    roomId: string;
    encounterId: string;
    participantIds?: readonly string[];
    participantContext?: ReadonlyMap<string, Readonly<{ instanceId: string; runId: string; roomId: string }>>;
    room?: BossRoomHooks;
  }>) {
    if (input.room) this.room = input.room;
    this.hostInstanceId = input.instanceId;
    this.encounterInstanceId = `${input.instanceId}:${input.runId}:${input.encounterId}`;
    this.expectedRunId = input.runId;
    this.expectedRoomId = input.roomId;
    for (const playerId of input.participantIds ?? []) {
      this.participantContext.set(playerId, {
        instanceId: input.instanceId,
        runId: input.runId,
        roomId: input.roomId
      });
    }
    for (const [playerId, context] of input.participantContext ?? []) {
      this.participantContext.set(playerId, context);
    }
  }

  getEligibleParticipants(): readonly string[] {
    return [...this.participantContext]
      .filter(([, context]) => this.isContextEligible(context))
      .map(([playerId]) => playerId);
  }

  canParticipate(playerId: string): boolean {
    const context = this.participantContext.get(playerId);
    return context !== undefined && this.isContextEligible(context);
  }

  setParticipantContext(
    playerId: string,
    context: Readonly<{ instanceId: string; runId: string; roomId: string }>
  ): void {
    this.participantContext.set(playerId, context);
  }

  participantIds(): readonly string[] { return [...this.participantContext.keys()]; }

  removeParticipant(playerId: string): void { this.participantContext.delete(playerId); }

  private isContextEligible(context: Readonly<{ instanceId: string; runId: string; roomId: string }>): boolean {
    return context.instanceId === this.hostInstanceId &&
      context.runId === this.expectedRunId &&
      context.roomId === this.expectedRoomId;
  }
}

/** Settlement adapter that coalesces retries before the durable adapter runs. */
export class IdempotentBossRewardAdapter {
  private static readonly MAX_ACCEPTED_KEYS = 1_024;
  private readonly accepted = new Set<string>();
  private readonly acceptedOrder: string[] = [];
  private readonly inFlight = new Map<string, Promise<boolean>>();

  async settle(
    settlementKey: string,
    settle: () => Promise<boolean> | boolean
  ): Promise<boolean> {
    if (this.accepted.has(settlementKey)) return true;
    const existing = this.inFlight.get(settlementKey);
    if (existing) return existing;
    const operation = Promise.resolve().then(settle).then((result) => {
      if (result) {
        this.accepted.add(settlementKey);
        this.acceptedOrder.push(settlementKey);
        while (this.acceptedOrder.length > IdempotentBossRewardAdapter.MAX_ACCEPTED_KEYS) {
          const oldest = this.acceptedOrder.shift();
          if (oldest !== undefined) this.accepted.delete(oldest);
        }
      }
      return result;
    }).finally(() => this.inFlight.delete(settlementKey));
    this.inFlight.set(settlementKey, operation);
    return operation;
  }

  hasSettled(settlementKey: string): boolean { return this.accepted.has(settlementKey); }
}

export function eligibleBossRewardParticipants(
  policy: Pick<BossRewardPolicy, "minimumContribution">,
  contributions: ReadonlyArray<Readonly<{ entityId: string; damage: number }>>,
  participants: readonly string[]
): readonly string[] {
  const minimum = Math.max(0, policy.minimumContribution ?? 0);
  const byId = new Map(contributions.map((entry) => [entry.entityId, Math.max(0, entry.damage)]));
  return participants.filter((playerId) => (byId.get(playerId) ?? 0) >= minimum);
}

/** Naming aliases keep the public seam readable in host-specific code. */
export { BossEncounter as BossEncounterInstance };
export type { BossHostAdapter as BossHost };

function geometryOrigin(geometry: BossTelegraphGeometry): LatLon {
  return geometry.kind === "circle" ? geometry.center : geometry.origin;
}

function sameOwnership(left: BossEntityOwnership, right: BossEntityOwnership): boolean {
  return left.bossId === right.bossId &&
    left.bossRevision === right.bossRevision &&
    left.encounterHandlerId === right.encounterHandlerId &&
    left.hostKind === right.hostKind &&
    left.hostInstanceId === right.hostInstanceId &&
    left.encounterInstanceId === right.encounterInstanceId &&
    (left.appearanceId === undefined || right.appearanceId === undefined ||
      left.appearanceId === right.appearanceId) &&
    (left.appearanceVariant === undefined || right.appearanceVariant === undefined ||
      left.appearanceVariant === right.appearanceVariant) &&
    left.lifeGeneration === right.lifeGeneration;
}
