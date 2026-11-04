import {
  BASIC_ATTACK_INTERVAL_MS,
  BONE_THRALL_DURATION_MS,
  BONE_THRALL_MAX_LEVEL,
  GRAVE_ECHO_DURATION_MS,
  GROVE_TREE_COMPANIONS,
  MINION_CAP,
  TREANT_DEFINITIONS,
  TREANT_GROW_COOLDOWN_MS,
  TREANT_STATS,
  VALKYRIE_DURATION_MS,
  VALKYRIE_STATS,
  boneThrallStats,
  destinationPoint,
  distanceMeters,
  type LatLon,
  type MinionSnapshot,
  type MinionSpeciesId,
  type TreantKind
} from "@ash-atlas/shared";
import type { CombatEngine } from "./combatEngine.js";
import { METAL_PROC_BALANCE } from "./metalProcs.js";
import { createRoamState, MINION_ROAM, roamPoint, roamStep, type RoamState } from "./companionFollow.js";

type Minion = {
  entityId: string;
  species: MinionSpeciesId;
  level: number;
  expiresAtMs: number | null;
  nextAttackAtMs: number;
  nextSelfHealAtMs: number;
  lastMovedAtMs: number;
  roam: RoamState;
};

export class MinionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MinionError";
  }
}

/** Companions step every 50 ms (the 20 Hz tick) so each 10 Hz combat delta carries even motion. */
const UPDATE_INTERVAL_MS = 40;
/** Minions share the pet's comfort ring; alternating sides and spreads fan them out. */
/** Each minion favours its own sector so they spread out. */
const MINION_OFFSETS_DEG = [0, 72, -72, 144, -144] as const;
/** An owner step this large between updates is travel (walking covers far less): minions follow. */
const OWNER_TRAVEL_STEP_M = 60;
const ASSIST_RANGE_M = 150;
const MELEE_RANGE_M = 6;
const RANGED_RANGE_M = 60;
/** Minions move at exactly the owner's walking speed. */
const MINION_SPEED_MULTIPLIER = 1;
const ON_HIT_CHANCE = 0.18;

/**
 * Server-authoritative minions (treants from Grove Lore, the Bone Thrall and the Grave Echo). Unlike
 * whistle pets they may enter dungeons, can't be sent home, and several may be out at once (cap 5).
 * They follow their owner and attack the owner's target on the uniform basic attack cadence.
 */
export class MinionRuntime {
  private readonly byOwner = new Map<string, Minion[]>();
  private readonly lastTreantGrowAt = new Map<string, number>();
  private readonly lastUpdateAt = new Map<string, number>();
  /** Owner facing from their movement, shared by every minion (null until they first move). */
  private readonly ownerFacing = new Map<string, { heading: number | null; position: LatLon }>();
  private sequence = 0;

  constructor(
    private readonly combat: CombatEngine,
    private readonly options: Readonly<{ playerBaseSpeedMps: number; random?: () => number }>
  ) {}

  private random(): number {
    return (this.options.random ?? Math.random)();
  }

  snapshot(ownerPlayerId: string): MinionSnapshot[] {
    return (this.byOwner.get(ownerPlayerId) ?? []).map((minion) => ({
      species: minion.species,
      level: minion.level,
      expiresAt: minion.expiresAtMs === null ? null : new Date(minion.expiresAtMs).toISOString()
    }));
  }

  count(ownerPlayerId: string, predicate: (species: MinionSpeciesId) => boolean = () => true): number {
    return (this.byOwner.get(ownerPlayerId) ?? []).filter((minion) => predicate(minion.species)).length;
  }

  /** Grove Lore: grow one treant of the chosen kind (cap = GROVE_TREE_COMPANIONS by rank; total minions cap 5). */
  growTreant(ownerPlayerId: string, kind: TreantKind, groveLoreRank: number, nowMs = Date.now()): void {
    const cap = GROVE_TREE_COMPANIONS[Math.max(0, Math.min(3, Math.trunc(groveLoreRank))) as 0 | 1 | 2 | 3];
    if (cap <= 0) throw new MinionError("MINION_SKILL_REQUIRED", "Learn Grove Lore to grow treants.");
    if (this.count(ownerPlayerId, (species) => species.startsWith("treant_")) >= cap) {
      throw new MinionError("MINION_CAP", `Grove Lore lets you keep ${cap} treant${cap === 1 ? "" : "s"} at once.`);
    }
    const last = this.lastTreantGrowAt.get(ownerPlayerId);
    if (last !== undefined && nowMs - last < TREANT_GROW_COOLDOWN_MS) {
      throw new MinionError("MINION_COOLDOWN", `You can grow another treant in ${Math.ceil((TREANT_GROW_COOLDOWN_MS - (nowMs - last)) / 1_000)}s.`);
    }
    this.spawn(ownerPlayerId, `treant_${kind}` as MinionSpeciesId, 1, null, TREANT_DEFINITIONS[kind].displayName, TREANT_STATS, nowMs);
    this.lastTreantGrowAt.set(ownerPlayerId, nowMs);
  }

  /**
   * A killing blow with a Bonewrought weapon: raises a Bone Thrall, or levels the existing one;
   * a maxed thrall lets the next kill raise a second.
   */
  recordBonewroughtKill(ownerPlayerId: string, nowMs = Date.now()): void {
    const thralls = (this.byOwner.get(ownerPlayerId) ?? []).filter((minion) => minion.species === "bone_thrall");
    const growing = thralls.find((minion) => minion.level < BONE_THRALL_MAX_LEVEL);
    if (growing) {
      growing.level += 1;
      const stats = boneThrallStats(growing.level);
      this.combat.rescaleCompanionHealth(growing.entityId, stats.maxHp / boneThrallStats(1).maxHp);
      return;
    }
    if (thralls.length >= 2 || this.count(ownerPlayerId) >= MINION_CAP) return;
    const stats = boneThrallStats(1);
    this.spawn(ownerPlayerId, "bone_thrall", 1, nowMs + BONE_THRALL_DURATION_MS, "Bone Thrall",
      { maxHp: stats.maxHp, damage: stats.damage, defense: 1 }, nowMs);
  }

  /** Dying in Bonewrought Mail usually raises one Grave Echo that copies the owner's strength. */
  recordBonewroughtDeath(ownerPlayerId: string, chance: number, nowMs = Date.now()): boolean {
    if (this.count(ownerPlayerId, (species) => species === "grave_echo") > 0) return false;
    if (this.count(ownerPlayerId) >= MINION_CAP || this.random() >= chance) return false;
    const owner = this.combat.entity(ownerPlayerId);
    if (!owner) return false;
    this.spawn(ownerPlayerId, "grave_echo", 1, nowMs + GRAVE_ECHO_DURATION_MS, `${owner.name}'s Echo`,
      { maxHp: Math.max(1, owner.maxHealth), damage: Math.max(1, this.combat.attackDamageOf(ownerPlayerId) ?? 5), defense: 2 }, nowMs, owner);
    return true;
  }

  /** Fallen Prison rescue: a freed Caged Valkyrie joins the owner (fails quietly when they are down or at the cap). */
  summonRescuedValkyrie(ownerPlayerId: string, nowMs = Date.now()): boolean {
    if (this.count(ownerPlayerId) >= MINION_CAP) return false;
    try {
      this.spawn(ownerPlayerId, "valkyrie", 1, nowMs + VALKYRIE_DURATION_MS, "Freed Valkyrie", VALKYRIE_STATS, nowMs);
    } catch (error) {
      if (error instanceof MinionError) return false;
      throw error;
    }
    return true;
  }

  /** Dismisses one kind of minion (the Valkyries leave with the dungeon run). */
  despawnSpecies(ownerPlayerId: string, species: MinionSpeciesId): void {
    const minions = this.byOwner.get(ownerPlayerId);
    if (!minions) return;
    const kept: Minion[] = [];
    for (const minion of minions) {
      if (minion.species === species) this.combat.despawnMob(minion.entityId);
      else kept.push(minion);
    }
    if (kept.length) this.byOwner.set(ownerPlayerId, kept);
    else this.byOwner.delete(ownerPlayerId);
  }

  despawnAll(ownerPlayerId: string): void {
    for (const minion of this.byOwner.get(ownerPlayerId) ?? []) this.combat.despawnMob(minion.entityId);
    this.byOwner.delete(ownerPlayerId);
  }

  updateAll(nowMs = Date.now()): void {
    for (const ownerPlayerId of [...this.byOwner.keys()]) this.update(ownerPlayerId, nowMs);
  }

  update(ownerPlayerId: string, nowMs = Date.now()): void {
    const minions = this.byOwner.get(ownerPlayerId);
    if (!minions) return;
    const owner = this.combat.entity(ownerPlayerId);
    if (!owner || owner.kind !== "player") return this.despawnAll(ownerPlayerId);
    // While the owner is down only the Grave Echo fights on (it is raised by that death).
    const ownerAlive = owner.lifeState === "alive";
    const last = this.lastUpdateAt.get(ownerPlayerId) ?? 0;
    if (nowMs - last < UPDATE_INTERVAL_MS) return;
    this.lastUpdateAt.set(ownerPlayerId, nowMs);
    const facing = this.ownerFacing.get(ownerPlayerId) ?? { heading: null, position: { lat: owner.lat, lon: owner.lon } };
    const ownerStep = distanceMeters(facing.position, owner);
    if (ownerStep >= 1) {
      if (ownerStep < OWNER_TRAVEL_STEP_M) facing.heading = bearing(facing.position, owner);
      facing.position = { lat: owner.lat, lon: owner.lon };
    }
    const ownerTravelled = ownerStep >= OWNER_TRAVEL_STEP_M;
    this.ownerFacing.set(ownerPlayerId, facing);
    minions.forEach((minion, index) => {
      minion.roam.offsetDeg = MINION_OFFSETS_DEG[index % MINION_OFFSETS_DEG.length]!;
    });
    const survivors: Minion[] = [];
    for (const minion of minions) {
      const entity = this.combat.entity(minion.entityId);
      if (!entity || entity.lifeState !== "alive" || (minion.expiresAtMs !== null && nowMs >= minion.expiresAtMs)) {
        if (entity) this.combat.despawnMob(minion.entityId);
        continue;
      }
      survivors.push(minion);
      if (!ownerAlive && minion.species !== "grave_echo") continue;
      // Only the owner's travel (or a door into/out of an interior) places minions instantly;
      // otherwise they walk at the owner's speed, however far behind.
      const crossedInterior = entity.regionCode !== owner.regionCode &&
        (entity.regionCode.startsWith("interior:") || owner.regionCode.startsWith("interior:"));
      if (ownerTravelled || crossedInterior || (entity.zoneId !== owner.zoneId && owner.zoneId.startsWith("interior:"))) {
        minion.roam.goal = null;
        this.combat.relocateCompanion(minion.entityId, roamPoint(minion.roam, MINION_ROAM, owner, facing.heading, 0.6), owner);
        continue;
      }
      this.act(ownerPlayerId, owner, minion, entity, survivors, nowMs);
    }
    if (survivors.length) this.byOwner.set(ownerPlayerId, survivors);
    else this.byOwner.delete(ownerPlayerId);
  }

  private act(
    ownerPlayerId: string,
    owner: LatLon & { targetEntityId: string | null; regionCode: string; zoneId: string },
    minion: Minion,
    entity: LatLon & { currentHealth: number; maxHealth: number },
    others: readonly Minion[],
    nowMs: number
  ): void {
    const ranged = minion.species === "treant_shadespine";
    const target = owner.targetEntityId ? this.combat.entity(owner.targetEntityId) : null;
    const assisted = target && target.kind === "mob" && !target.companion && target.lifeState === "alive" &&
      target.zoneId === owner.zoneId && distanceMeters(owner, target) <= ASSIST_RANGE_M ? target : null;
    // The Grave Echo keeps fighting after its owner falls: it picks the nearest monster itself.
    const hostile = assisted ?? (minion.species === "grave_echo" ? this.nearestMonster(entity, owner.zoneId) : null);
    const reach = ranged ? RANGED_RANGE_M : MELEE_RANGE_M;
    const elapsed = Math.min(300, nowMs - minion.lastMovedAtMs) / 1_000;
    const speed = this.options.playerBaseSpeedMps * this.combat.playerMovementMultiplier(ownerPlayerId) * MINION_SPEED_MULTIPLIER;
    if (hostile) {
      minion.roam.goal = null;
      const remaining = distanceMeters(entity, hostile) - reach * 0.8;
      if (remaining > 0) {
        this.combat.relocateCompanion(minion.entityId, destinationPoint(entity, Math.min(remaining, speed * elapsed), bearing(entity, hostile)), owner);
      }
    } else {
      const nextPoint = roamStep(minion.roam, MINION_ROAM, {
        position: entity, owner, ownerHeading: this.ownerFacing.get(ownerPlayerId)?.heading ?? null,
        baseSpeedMps: speed, elapsedS: elapsed, nowMs
      });
      if (nextPoint) this.combat.relocateCompanion(minion.entityId, nextPoint, owner);
    }
    minion.lastMovedAtMs = nowMs;
    if (minion.species === "bone_thrall" && nowMs >= minion.nextSelfHealAtMs) {
      const stats = boneThrallStats(minion.level);
      this.combat.healEntity(minion.entityId, Math.max(1, Math.round(entity.maxHealth * stats.selfHealFraction)), minion.entityId);
      minion.nextSelfHealAtMs = nowMs + stats.selfHealIntervalMs;
    }
    if (nowMs < minion.nextAttackAtMs) return;
    if (minion.species === "treant_mendbark") {
      for (const other of others) {
        if (other !== minion && other.species.startsWith("treant_")) {
          const otherEntity = this.combat.entity(other.entityId);
          if (otherEntity) this.combat.healEntity(other.entityId, Math.max(1, Math.round(otherEntity.maxHealth * 0.05)), minion.entityId);
        }
      }
    }
    if (minion.species === "treant_fernguard") {
      for (const id of this.combat.nearbyEntityIds(entity, 10)) {
        const attacker = this.combat.entity(id);
        if (attacker?.kind === "mob" && attacker.targetEntityId === minion.entityId && this.random() < ON_HIT_CHANCE) {
          this.combat.applyPetEffect(minion.entityId, attacker.entityId, "whetted_attack", METAL_PROC_BALANCE.whetted.durationMs, METAL_PROC_BALANCE.whetted.attackReduction);
        }
      }
    }
    if (!hostile || distanceMeters(this.combat.entity(minion.entityId) ?? entity, hostile) > reach + 1) return;
    const damage = this.minionDamage(minion) + this.combat.petTacticsShare(ownerPlayerId);
    const applied = this.combat.applyScriptedDamage(ownerPlayerId, hostile.entityId, damage, `minion_${minion.species}`, minion.entityId);
    minion.nextAttackAtMs = nowMs + BASIC_ATTACK_INTERVAL_MS;
    if (applied <= 0) return;
    const bond = Math.max(0, Math.min(3, this.combat.generalSkillRank(ownerPlayerId, "companion_bond")));
    if (bond > 0 && minion.species !== "grave_echo") this.combat.healEntity(minion.entityId, bond, minion.entityId);
    if (minion.species === "treant_duskroot" && this.random() < ON_HIT_CHANCE) {
      this.combat.applyPetEffect(minion.entityId, hostile.entityId, "poison", 1);
    } else if (minion.species === "treant_frostwillow") {
      this.combat.applyPetEffect(minion.entityId, hostile.entityId, "movement_slow", 3_000, 0.3);
    } else if (minion.species === "treant_redwood" && this.random() < ON_HIT_CHANCE && isDisplaceable(hostile)) {
      this.combat.leapMobTo(hostile.entityId, destinationPoint(hostile, 12, bearing(entity, hostile)));
    } else if (minion.species === "treant_shadespine") {
      this.combat.applyPetEffect(minion.entityId, hostile.entityId, "gloom", 1);
    }
  }

  private nearestMonster(from: LatLon, zoneId: string) {
    return this.combat.nearbyEntityIds(from, ASSIST_RANGE_M)
      .map((id) => this.combat.entity(id))
      .filter((entity): entity is NonNullable<typeof entity> => Boolean(entity) && entity!.kind === "mob" &&
        !entity!.companion && !entity!.npcFaction && entity!.lifeState === "alive" && entity!.zoneId === zoneId)
      .sort((left, right) => distanceMeters(from, left) - distanceMeters(from, right))[0] ?? null;
  }

  private minionDamage(minion: Minion): number {
    if (minion.species === "bone_thrall") return boneThrallStats(minion.level).damage;
    return Math.max(1, this.combat.attackDamageOf(minion.entityId) ?? TREANT_STATS.damage);
  }

  private spawn(
    ownerPlayerId: string,
    species: MinionSpeciesId,
    level: number,
    expiresAtMs: number | null,
    name: string,
    stats: Readonly<{ maxHp: number; damage: number; defense: number }>,
    nowMs: number,
    ownerEntity?: unknown
  ): void {
    void ownerEntity;
    const owner = this.combat.entity(ownerPlayerId);
    if (!owner || owner.kind !== "player" || (owner.lifeState !== "alive" && species !== "grave_echo")) {
      throw new MinionError("MINION_OWNER", "You must be alive to raise a minion.");
    }
    if (this.count(ownerPlayerId) >= MINION_CAP) throw new MinionError("MINION_CAP", `At most ${MINION_CAP} minions at once.`);
    const index = this.count(ownerPlayerId);
    const roam = createRoamState(`minion:${ownerPlayerId}:${this.sequence + 1}`, nowMs,
      MINION_OFFSETS_DEG[index % MINION_OFFSETS_DEG.length]!);
    const entityId = `minion:${ownerPlayerId}:${this.sequence += 1}`;
    this.combat.spawnMob({
      entityId,
      summoned: true,
      archetype: "wolf",
      position: roamPoint(roam, MINION_ROAM, owner, this.ownerFacing.get(ownerPlayerId)?.heading ?? null, 0.5),
      homePosition: { lat: owner.lat, lon: owner.lon },
      regionCode: owner.regionCode,
      zoneId: owner.zoneId,
      worldAi: false,
      movementSpeedMpsOverride: this.options.playerBaseSpeedMps * MINION_SPEED_MULTIPLIER,
      defenseOverride: stats.defense,
      companion: {
        ownerPlayerId, dogId: entityId, name, species,
        baseMaxHealth: stats.maxHp, maxHealth: stats.maxHp, currentHealth: stats.maxHp,
        damage: stats.damage, mode: "play"
      }
    });
    const minions = this.byOwner.get(ownerPlayerId) ?? [];
    minions.push({ entityId, species, level, expiresAtMs, nextAttackAtMs: nowMs, nextSelfHealAtMs: nowMs, lastMovedAtMs: nowMs, roam });
    this.byOwner.set(ownerPlayerId, minions);
  }
}

/** Knockbacks never move bosses or dungeon encounter mobs (their rooms and scripts own them). */
export function isDisplaceable(entity: Readonly<{ boss?: boolean; regionCode: string; bossOwnership?: unknown }>): boolean {
  return entity.boss !== true && !entity.bossOwnership && !entity.regionCode.startsWith("interior:");
}

function bearing(from: LatLon, to: LatLon): number {
  const p1 = from.lat * Math.PI / 180;
  const p2 = to.lat * Math.PI / 180;
  const dl = (to.lon - from.lon) * Math.PI / 180;
  return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
}
