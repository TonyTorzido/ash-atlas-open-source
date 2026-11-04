import { randomUUID } from "node:crypto";

import { BASIC_ATTACK_INTERVAL_MS, destinationPoint, distanceMeters, type LatLon } from "@ash-atlas/shared";

import type { CombatEngine, RevenantMetalHandler, LichCombatSnapshot } from "./combatEngine.js";
import { createRoamState, roamPoint, roamStep, type RoamState } from "./companionFollow.js";
import { REVENANT_METAL_FORMATION, attackApproachPosition, formationSlotPosition, undeadRoam } from "./revenantMetalFormation.js";
import { resolveMobCombatProfile } from "./mobDefinitions.js";

/** Revenant Metal balance numbers. */
export const REVENANT_METAL_BALANCE = Object.freeze({
  maxSkeletons: 4,
  maxSkeletonLevel: 5,
  /** Skeleton level N fights as mob level min(6 x N, owner effective level). */
  mobLevelsPerSkeletonLevel: 6,
  skeletonLifetimeMs: 45 * 60 * 1_000,
  lichLifetimeMs: 20 * 60 * 60 * 1_000,
  /** The dog-companion leash. */
  leashM: 600,
  /** The uniform basic attack cadence (all players and monsters). */
  attackCadenceMs: BASIC_ATTACK_INTERVAL_MS,
  lichHealthPersistIntervalMs: 5_000
});

const SKELETON_ARCHETYPE = "risen_skeleton" as const;
const LICH_ARCHETYPE = "revenant_lich" as const;
const MAX_MOB_LEVEL = 25;
/** The owner must move this far before the formation heading turns. */
const HEADING_SAMPLE_M = 25;

export type SkeletonRecord = Readonly<{ entityId: string; level: number; expiresAt: number }>;
export type SkeletonRaisePlan =
  | Readonly<{ kind: "spawn"; level: 1 }>
  | Readonly<{ kind: "upgrade"; entityId: string; level: number }>;

/**
 * A Revenant weapon killing blow: below 4 skeletons a new level 1 skeleton rises; at 4 the
 * lowest-level one gains a level (cap 5), and once all four are level 5 the one with the
 * least time left is refreshed. Ties go to the least time left.
 */
export function planSkeletonRaise(skeletons: readonly SkeletonRecord[]): SkeletonRaisePlan {
  if (skeletons.length < REVENANT_METAL_BALANCE.maxSkeletons) return { kind: "spawn", level: 1 };
  const byPriority = [...skeletons].sort((left, right) =>
    left.level - right.level || left.expiresAt - right.expiresAt || left.entityId.localeCompare(right.entityId));
  const chosen = byPriority[0]!;
  return {
    kind: "upgrade",
    entityId: chosen.entityId,
    level: Math.min(REVENANT_METAL_BALANCE.maxSkeletonLevel, chosen.level + 1)
  };
}

export function skeletonMobLevel(skeletonLevel: number, ownerLevel: number): number {
  return Math.max(0, Math.min(
    MAX_MOB_LEVEL,
    REVENANT_METAL_BALANCE.mobLevelsPerSkeletonLevel * skeletonLevel,
    Math.trunc(ownerLevel)
  ));
}

export type StoredLich = Readonly<{
  ownerPlayerId: string;
  deathOperationKey: string;
  snapshot: LichCombatSnapshot;
  currentHealth: number;
  expiresAt: number;
}>;

/** Durable Lich state (owner, stat snapshot, current HP, expiry). */
export interface RevenantMetalLichStore {
  load(ownerPlayerId: string): Promise<StoredLich | null>;
  /** Replaces the owner's Lich (one per owner). */
  replace(lich: StoredLich): Promise<void>;
  updateHealth(ownerPlayerId: string, deathOperationKey: string, currentHealth: number): Promise<void>;
  remove(ownerPlayerId: string, deathOperationKey: string): Promise<void>;
}

type ActiveSkeleton = { entityId: string; level: number; expiresAt: number; nextAttackAt: number };
type ActiveLich = {
  record: StoredLich;
  entityId: string | null;
  persistedHealth: number;
  lastPersistAt: number;
  /** Fought first, until the owner respawns. */
  killerEntityId: string | null;
  nextAttackAt: number;
};
type OwnerUndead = {
  skeletons: ActiveSkeleton[];
  lich: ActiveLich | null;
  /** Owner travel direction (compass degrees) and where it was last sampled; behind = opposite. */
  headingDeg: number;
  headingFrom: LatLon | null;
};
type PendingEvent =
  | Readonly<{ kind: "raise"; ownerPlayerId: string; position: LatLon; regionCode: string; zoneId: string }>
  | Readonly<{
      kind: "lich"; ownerPlayerId: string; deathOperationKey: string; position: LatLon;
      regionCode: string; zoneId: string; killerEntityId: string | null; snapshot: LichCombatSnapshot;
    }>;

export type RevenantMetalUndeadRuntimeOptions = Readonly<{
  /** Overworld presence: connected, on the world layer, not in a dungeon or interior. */
  isOverworldPresent(ownerPlayerId: string): boolean;
  /** Players to check once for a stored Lich (restored on their next overworld presence). */
  overworldPlayerIds?(): Iterable<string>;
  playerBaseSpeedMps: number;
  store?: RevenantMetalLichStore;
  onStoreError?(error: unknown, ownerPlayerId: string): void;
  random?: () => number;
  idFactory?: () => string;
}>;

/**
 * Server-authoritative controller for Revenant Metal undead. Skeletons are memory-only; the Lich is
 * persisted. Both are overworld-only: they are dismissed (skeletons) or despawned (the Lich) when
 * the owner leaves the overworld or logs out. They follow the owner loosely (the pet roam logic around a formation slot),
 * attack the owner's target and anything fighting the owner, and never heal.
 */
export class RevenantMetalUndeadRuntime implements RevenantMetalHandler {
  private readonly owners = new Map<string, OwnerUndead>();
  private readonly pending: PendingEvent[] = [];
  private readonly lichChecked = new Set<string>();
  private readonly idFactory: () => string;
  /** Relaxed-follow state per undead (skeleton or Lich object); collected with the undead. */
  private readonly motion = new WeakMap<object, { roam: RoamState; lastMovedAt: number }>();

  constructor(private readonly combat: CombatEngine, private readonly options: RevenantMetalUndeadRuntimeOptions) {
    this.idFactory = options.idFactory ?? randomUUID;
  }

  /** Engine callback; deferred to the next update so the engine is never re-entered mid-defeat. */
  onRevenantWeaponKillingBlow(input: Parameters<RevenantMetalHandler["onRevenantWeaponKillingBlow"]>[0]): void {
    this.pending.push({ kind: "raise", ...input });
  }

  onRevenantArmorDeath(input: Parameters<RevenantMetalHandler["onRevenantArmorDeath"]>[0]): void {
    this.pending.push({ kind: "lich", ...input });
  }

  skeletons(ownerPlayerId: string): readonly SkeletonRecord[] {
    return (this.owners.get(ownerPlayerId)?.skeletons ?? []).map(({ entityId, level, expiresAt }) => ({ entityId, level, expiresAt }));
  }

  lich(ownerPlayerId: string): Readonly<{ entityId: string | null; record: StoredLich }> | null {
    const lich = this.owners.get(ownerPlayerId)?.lich;
    return lich ? { entityId: lich.entityId, record: lich.record } : null;
  }

  updateAll(nowMs = Date.now()): void {
    for (const event of this.pending.splice(0)) {
      if (event.kind === "raise") this.raiseSkeleton(event, nowMs);
      else this.raiseLich(event, nowMs);
    }
    this.restoreStoredLiches();
    for (const [ownerPlayerId, state] of [...this.owners]) {
      this.updateOwner(ownerPlayerId, state, nowMs);
      if (state.skeletons.length === 0 && !state.lich) this.owners.delete(ownerPlayerId);
    }
  }

  /** Despawns everything (server shutdown); the Lich keeps its stored HP. */
  async shutdown(nowMs = Date.now()): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const [ownerPlayerId, state] of this.owners) {
      this.dismissSkeletons(state);
      if (state.lich) writes.push(this.despawnLich(ownerPlayerId, state.lich, nowMs, true));
    }
    await Promise.allSettled(writes);
  }

  private state(ownerPlayerId: string): OwnerUndead {
    let state = this.owners.get(ownerPlayerId);
    if (!state) {
      state = { skeletons: [], lich: null, headingDeg: 0, headingFrom: null };
      this.owners.set(ownerPlayerId, state);
    }
    return state;
  }

  private raiseSkeleton(event: Extract<PendingEvent, { kind: "raise" }>, nowMs: number): void {
    const owner = this.combat.entity(event.ownerPlayerId);
    if (!owner || !this.options.isOverworldPresent(event.ownerPlayerId)) return;
    const state = this.state(event.ownerPlayerId);
    state.skeletons = state.skeletons.filter((skeleton) => this.combat.entity(skeleton.entityId)?.lifeState === "alive");
    const plan = planSkeletonRaise(state.skeletons);
    const expiresAt = nowMs + REVENANT_METAL_BALANCE.skeletonLifetimeMs;
    if (plan.kind === "upgrade") {
      const skeleton = state.skeletons.find((entry) => entry.entityId === plan.entityId)!;
      if (this.combat.upgradeUndeadSkeleton(
        skeleton.entityId, plan.level, skeletonMobLevel(plan.level, owner.level), expiresAt
      )) {
        skeleton.level = plan.level;
        skeleton.expiresAt = expiresAt;
      }
      return;
    }
    const mobLevel = skeletonMobLevel(1, owner.level);
    const profile = resolveMobCombatProfile(SKELETON_ARCHETYPE, mobLevel);
    const entityId = `undead-skeleton:${event.ownerPlayerId}:${this.idFactory()}`;
    this.combat.spawnMob({
      entityId,
      archetype: SKELETON_ARCHETYPE,
      position: event.position,
      regionCode: event.regionCode,
      zoneId: event.zoneId,
      worldAi: false,
      combatProfile: { level: profile.level, tier: profile.tier, balanceVersion: profile.balanceVersion },
      undead: { ownerPlayerId: event.ownerPlayerId, kind: "skeleton", level: 1, expiresAt }
    });
    state.skeletons.push({ entityId, level: 1, expiresAt, nextAttackAt: nowMs });
  }

  private raiseLich(event: Extract<PendingEvent, { kind: "lich" }>, nowMs: number): void {
    const state = this.state(event.ownerPlayerId);
    // One Lich at a time: a new death destroys the old one.
    if (state.lich?.entityId) this.combat.despawnMob(state.lich.entityId);
    const record: StoredLich = {
      ownerPlayerId: event.ownerPlayerId,
      deathOperationKey: event.deathOperationKey,
      snapshot: event.snapshot,
      currentHealth: event.snapshot.maxHealth,
      expiresAt: nowMs + REVENANT_METAL_BALANCE.lichLifetimeMs
    };
    state.lich = {
      record, entityId: null, persistedHealth: record.currentHealth, lastPersistAt: nowMs,
      killerEntityId: event.killerEntityId, nextAttackAt: nowMs
    };
    this.lichChecked.add(event.ownerPlayerId);
    this.persist(event.ownerPlayerId, () => this.options.store?.replace(record));
    if (this.options.isOverworldPresent(event.ownerPlayerId)) {
      this.spawnLich(state.lich, event.position, event.regionCode, event.zoneId);
    }
  }

  private spawnLich(lich: ActiveLich, position: LatLon, regionCode: string, zoneId: string): void {
    const entityId = `revenant-lich:${lich.record.ownerPlayerId}:${this.idFactory()}`;
    this.combat.spawnMob({
      entityId,
      archetype: LICH_ARCHETYPE,
      position,
      regionCode,
      zoneId,
      worldAi: false,
      undead: {
        ownerPlayerId: lich.record.ownerPlayerId,
        kind: "lich",
        level: 1,
        expiresAt: lich.record.expiresAt,
        lich: lich.record.snapshot,
        currentHealth: lich.record.currentHealth
      }
    });
    lich.entityId = entityId;
  }

  private restoreStoredLiches(): void {
    const store = this.options.store;
    if (!store || !this.options.overworldPlayerIds) return;
    for (const ownerPlayerId of this.options.overworldPlayerIds()) {
      if (this.lichChecked.has(ownerPlayerId)) continue;
      this.lichChecked.add(ownerPlayerId);
      void store.load(ownerPlayerId).then((record) => {
        if (!record || record.expiresAt <= Date.now()) {
          if (record) void store.remove(record.ownerPlayerId, record.deathOperationKey).catch(() => undefined);
          return;
        }
        const state = this.state(ownerPlayerId);
        if (state.lich) return;
        state.lich = {
          record, entityId: null, persistedHealth: record.currentHealth, lastPersistAt: Date.now(),
          killerEntityId: null, nextAttackAt: 0
        };
      }).catch((error: unknown) => {
        this.lichChecked.delete(ownerPlayerId);
        this.options.onStoreError?.(error, ownerPlayerId);
      });
    }
  }

  private updateOwner(ownerPlayerId: string, state: OwnerUndead, nowMs: number): void {
    const owner = this.combat.entity(ownerPlayerId);
    const present = owner !== null && this.options.isOverworldPresent(ownerPlayerId);
    if (!present) {
      // Skeletons are dismissed; the Lich waits (despawned) for the owner's next overworld presence.
      this.dismissSkeletons(state);
      if (state.lich?.entityId) void this.despawnLich(ownerPlayerId, state.lich, nowMs, false);
    }
    state.skeletons = state.skeletons.filter((skeleton) => {
      const entity = this.combat.entity(skeleton.entityId);
      if (!entity || entity.lifeState !== "alive") return false;
      if (nowMs >= skeleton.expiresAt) {
        this.combat.despawnMob(skeleton.entityId);
        return false;
      }
      return true;
    });
    const lich = state.lich;
    if (lich) {
      if (nowMs >= lich.record.expiresAt) {
        if (lich.entityId) this.combat.despawnMob(lich.entityId);
        this.destroyLich(ownerPlayerId, state);
      } else if (lich.entityId && this.combat.entity(lich.entityId)?.lifeState !== "alive") {
        // Killed: destroyed for good.
        this.destroyLich(ownerPlayerId, state);
      } else if (!lich.entityId && present && owner?.lifeState === "alive") {
        this.spawnLich(lich, this.slotFor(owner, state, 0), owner.regionCode, owner.zoneId);
      }
    }
    if (!present || !owner) return;
    this.updateHeading(owner, state);
    // Formation order: the Lich takes the slot nearest the owner, skeletons follow in summon order.
    let slotIndex = 0;
    if (state.lich?.entityId) {
      this.persistLichHealth(ownerPlayerId, state.lich, nowMs);
      if (owner.lifeState === "alive") state.lich.killerEntityId = null;
      this.driveUndead(owner, state, state.lich as ActiveLich & { entityId: string }, slotIndex, state.lich.killerEntityId, nowMs);
      slotIndex += 1;
    }
    for (const skeleton of state.skeletons) {
      this.driveUndead(owner, state, skeleton, slotIndex, null, nowMs);
      slotIndex += 1;
    }
  }

  private driveUndead(
    owner: NonNullable<ReturnType<CombatEngine["entity"]>>,
    state: OwnerUndead,
    undead: { entityId: string; nextAttackAt: number },
    slotIndex: number,
    killerEntityId: string | null,
    nowMs: number
  ): void {
    const self = this.combat.entity(undead.entityId);
    if (!self || self.lifeState !== "alive") return;
    // A player engaged it directly: the engine's encounter owns it until that fight ends.
    if (self.targetEntityId !== null) return;
    const target = this.chooseTarget(owner, self, killerEntityId);
    const slot = this.slotFor(owner, state, slotIndex);
    const motion = this.motionFor(undead, self.entityId, nowMs);
    const elapsedS = Math.min(1, Math.max(0, nowMs - motion.lastMovedAt) / 1_000);
    motion.lastMovedAt = nowMs;
    const area = undeadRoam(slotIndex);
    motion.roam.offsetDeg = area.bearingOffsetDeg;
    if (!target && distanceMeters(self, owner) > REVENANT_METAL_BALANCE.leashM) {
      // Flag travel, respawn or teleport: catch up into the roam area around the owner.
      motion.roam.goal = null;
      this.combat.relocateCompanion(self.entityId, roamPoint(motion.roam, area.profile, owner, state.headingDeg));
      return;
    }
    if (target) {
      // Fighting: take this undead's own angle on a ring inside attack range around the target.
      motion.roam.goal = null;
      const destination = attackApproachPosition(target, bearingDegrees(target, owner), self.attackRangeM ?? 2, slotIndex);
      const distance = distanceMeters(self, destination);
      if (distance > 0.5) {
        const stepM = Math.min(
          distance,
          this.options.playerBaseSpeedMps * this.combat.playerMovementMultiplier(owner.entityId) * elapsedS
        );
        this.combat.relocateCompanion(self.entityId, destinationPoint(self, stepM, bearingDegrees(self, destination)));
      }
    } else if (motion.roam.goal || distanceMeters(self, slot) > area.deadZoneM) {
      // Relaxed follow: stand still while the slot is near; otherwise amble around the slot area
      // (the pet roam logic) and only walk at full speed when far behind.
      const walkMps = this.options.playerBaseSpeedMps * this.combat.playerMovementMultiplier(owner.entityId);
      const paceMps = distanceMeters(self, owner) > area.profile.driftAtM
        ? walkMps
        : walkMps * REVENANT_METAL_FORMATION.amblePaceFraction;
      const next = roamStep(motion.roam, area.profile, {
        position: self, owner, ownerHeading: state.headingDeg, baseSpeedMps: paceMps, elapsedS, nowMs
      });
      if (next) this.combat.relocateCompanion(self.entityId, next);
    }
    if (
      target && nowMs >= undead.nextAttackAt && this.combat.undeadInPlayerPhase(owner.entityId) &&
      this.combat.applyUndeadAttack(self.entityId, target.entityId) > 0
    ) {
      undead.nextAttackAt = nowMs + REVENANT_METAL_BALANCE.attackCadenceMs;
    }
  }

  /** The Lich's killer first (while the owner is down), then the owner's target, then anything fighting the owner. */
  private chooseTarget(
    owner: NonNullable<ReturnType<CombatEngine["entity"]>>,
    self: NonNullable<ReturnType<CombatEngine["entity"]>>,
    killerEntityId: string | null
  ) {
    const valid = (entityId: string | null, leashed: boolean) => {
      if (!entityId || !this.combat.canUndeadAttack(self.entityId, entityId)) return null;
      const entity = this.combat.entity(entityId);
      return entity && (!leashed || distanceMeters(entity, owner) <= REVENANT_METAL_BALANCE.leashM) ? entity : null;
    };
    if (killerEntityId) return valid(killerEntityId, false);
    if (owner.lifeState !== "alive") return null;
    return valid(owner.targetEntityId, true) ?? this.combat.hostilesOf(owner.entityId)
      .map((entityId) => valid(entityId, true))
      .filter((entity): entity is NonNullable<typeof entity> => entity !== null)
      .sort((left, right) => distanceMeters(self, left) - distanceMeters(self, right))[0] ?? null;
  }

  private motionFor(undead: object, key: string, nowMs: number): { roam: RoamState; lastMovedAt: number } {
    let motion = this.motion.get(undead);
    if (!motion) {
      motion = { roam: createRoamState(key, nowMs), lastMovedAt: nowMs };
      this.motion.set(undead, motion);
    }
    return motion;
  }

  private slotFor(owner: LatLon, state: OwnerUndead, slotIndex: number): LatLon {
    return formationSlotPosition(owner, state.headingDeg, slotIndex);
  }

  /** The heading follows the owner's travel; it only turns after a real move so slots stay stable. */
  private updateHeading(owner: LatLon, state: OwnerUndead): void {
    if (!state.headingFrom) {
      state.headingFrom = { lat: owner.lat, lon: owner.lon };
      return;
    }
    if (distanceMeters(state.headingFrom, owner) < HEADING_SAMPLE_M) return;
    state.headingDeg = bearingDegrees(state.headingFrom, owner);
    state.headingFrom = { lat: owner.lat, lon: owner.lon };
  }


  private dismissSkeletons(state: OwnerUndead): void {
    for (const skeleton of state.skeletons) this.combat.despawnMob(skeleton.entityId);
    state.skeletons = [];
  }

  private async despawnLich(ownerPlayerId: string, lich: ActiveLich, nowMs: number, awaitWrite: boolean): Promise<void> {
    const entity = lich.entityId ? this.combat.entity(lich.entityId) : null;
    if (lich.entityId) this.combat.despawnMob(lich.entityId);
    lich.entityId = null;
    lich.killerEntityId = null;
    if (entity && entity.lifeState === "alive" && entity.currentHealth > 0) {
      lich.record = { ...lich.record, currentHealth: entity.currentHealth };
    }
    if (lich.record.currentHealth !== lich.persistedHealth) {
      lich.persistedHealth = lich.record.currentHealth;
      lich.lastPersistAt = nowMs;
      const write = this.persist(ownerPlayerId, () =>
        this.options.store?.updateHealth(ownerPlayerId, lich.record.deathOperationKey, lich.record.currentHealth));
      if (awaitWrite) await write;
    }
  }

  private persistLichHealth(ownerPlayerId: string, lich: ActiveLich, nowMs: number): void {
    const entity = lich.entityId ? this.combat.entity(lich.entityId) : null;
    if (!entity || entity.currentHealth <= 0) return;
    lich.record = { ...lich.record, currentHealth: entity.currentHealth };
    if (entity.currentHealth === lich.persistedHealth ||
      nowMs - lich.lastPersistAt < REVENANT_METAL_BALANCE.lichHealthPersistIntervalMs) return;
    lich.persistedHealth = entity.currentHealth;
    lich.lastPersistAt = nowMs;
    void this.persist(ownerPlayerId, () =>
      this.options.store?.updateHealth(ownerPlayerId, lich.record.deathOperationKey, entity.currentHealth));
  }

  private destroyLich(ownerPlayerId: string, state: OwnerUndead): void {
    const lich = state.lich;
    if (!lich) return;
    state.lich = null;
    void this.persist(ownerPlayerId, () => this.options.store?.remove(ownerPlayerId, lich.record.deathOperationKey));
  }

  private persist(ownerPlayerId: string, write: () => Promise<void> | undefined): Promise<void> {
    try {
      return Promise.resolve(write()).catch((error: unknown) => this.options.onStoreError?.(error, ownerPlayerId));
    } catch (error) {
      this.options.onStoreError?.(error, ownerPlayerId);
      return Promise.resolve();
    }
  }
}

function bearingDegrees(from: LatLon, to: LatLon): number {
  const p1 = from.lat * Math.PI / 180;
  const p2 = to.lat * Math.PI / 180;
  const dl = (to.lon - from.lon) * Math.PI / 180;
  return (Math.atan2(
    Math.sin(dl) * Math.cos(p2),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  ) * 180 / Math.PI + 360) % 360;
}
