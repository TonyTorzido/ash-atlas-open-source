import {
  BASIC_ATTACK_INTERVAL_MS,
  COMPANION_BOND_HEAL_PER_HIT,
  COMPANION_BOND_MAX_HEALTH_MULTIPLIERS,
  destinationPoint,
  distanceMeters,
  type CombatEntitySnapshot,
  type DogCompanionMode,
  type PetAbilityId,
  type PetTrackPing,
  PET_ABILITY_DEFINITIONS,
  PET_PVP_DAMAGE_MULTIPLIER,
  PET_PVP_MAX_HOLD_MS,
  PET_STAY_PLACE_MAX_DISTANCE_M,
  PET_TAIL_LASH_RADIUS_M,
  isWithinWorldEdge,
  petAbilityCooldownMs,
  type LatLon
} from "@ash-atlas/shared";
import type { CombatEngine } from "./combatEngine.js";
import { createRoamState, PET_ROAM, roamPoint, roamStep, type RoamState } from "./companionFollow.js";
import { MOB_DEFINITIONS } from "./mobDefinitions.js";
import { isDisplaceable } from "./minionRuntime.js";
import { OPEN_LAND_FRESH_SEARCH_MAX_M } from "../openLandSearch.js";
import { adjacentZoneIdsForPosition, zoneIdForPosition } from "../spatialZones.js";
import type { ActivePet } from "../petService.js";

type CompanionBoundary = Readonly<{ anchor: LatLon; radiusM: number; revision: number }>;
type ActiveCompanion = {
  dog: ActivePet; entityId: string; mode: DogCompanionMode;
  lastMovedAt: number; nextAssistAt: number; companionBondRank: number;
  abilityReadyAt: Partial<Record<PetAbilityId, number>>; rageUntil: number;
  /** Owner's facing, learned from their movement (null until they first move). */
  ownerHeading: number | null; lastOwnerPosition: LatLon;
  /** Enemy the owner sent the pet at through an ability or the target menu. */
  assignedTargetId: string | null; lastOwnerTargetId: string | null;
  boundaryIdentity: string;
  roam: RoamState;
  /** An ability waiting for the pet to walk into reach of its target. */
  pending: PendingAbility | null;
  /** Drag-to-place Stay: the pet walks here, then stays until Follow. */
  stayAt: LatLon | null;
};

/** Reachability samples along a placed-Stay walk. */
const STAY_PATH_SAMPLE_M = 50;

/** Companions step every 50 ms (the 20 Hz tick) so each 10 Hz combat delta carries even motion. */
const UPDATE_INTERVAL_MS = 40;
const OWNER_HEADING_MIN_STEP_M = 1;
/** An owner step longer than this in one tick (and 3x their walk) is a jump, not a walk. */
const OWNER_JUMP_MIN_M = 1_000;
/** Combat: the pet chases a target only while it stays within this range of the owner. */
const PET_COMBAT_LEASH_M = 450;
/** The pet joins a fight when something attacks its owner within this range of the owner. */
const PET_DEFEND_RADIUS_M = 60;
const PET_MELEE_RANGE_M = 4;
/** Pets attack on the uniform basic attack cadence; Companion Bond cuts ability cooldowns instead. */
const PET_ATTACK_CADENCE_MS = BASIC_ATTACK_INTERVAL_MS;
/** Base trot a little above the owner's pace; the follow step scales it up when far behind. */


type PendingAbility = {
  abilityId: PetAbilityId;
  targetId: string;
  startedAtMs: number;
  ownerTargetAtStart: string | null;
};

/** How close the pet must be to its target for each aimed ability; others use melee reach. */
const PET_ABILITY_REACH_M: Partial<Record<PetAbilityId, number>> = { ember_spit: 60, pounce: 30 };
const PET_MELEE_ABILITY_REACH_M = 8;
/** A pet that cannot reach its target in this time gives up (no cooldown). */
const PET_PENDING_ABILITY_TIMEOUT_MS = 20_000;

export function petAbilityReachM(abilityId: PetAbilityId): number {
  return PET_ABILITY_REACH_M[abilityId] ?? PET_MELEE_ABILITY_REACH_M;
}

/** Result of an ability that fired (or was cancelled) after the pet walked into reach. */
export type PetDeferredAbilityOutcome = Readonly<{
  abilityId: PetAbilityId;
  fired: boolean;
  notice: string;
  ping?: PetTrackPing;
}>;

type PetCompanionRuntimeOptions = Readonly<{
  /** A deferred ability fired or was cancelled (moving-into-range abilities). */
  onDeferredAbility?: (ownerPlayerId: string, petId: string, outcome: PetDeferredAbilityOutcome) => void;
  playerBaseSpeedMps: number;
  boundaryForOwner?: (ownerPlayerId: string) => CompanionBoundary | null;
  /** The pet's timer ran out (the runtime has already removed it). */
  onExpired?: (ownerPlayerId: string, petId: string) => void;
  /** The owner died: the pet goes home to rest (the runtime has already removed it). */
  onOwnerDefeated?: (ownerPlayerId: string, petId: string) => void;
  /** The owner entered a dungeon: pets are not allowed there (the runtime has already removed it). */
  onSentHome?: (ownerPlayerId: string, petId: string) => void;
  /** Find Open Land: the nearest point the owner could legally plant a flag on. */
  findOpenLand?: (ownerPlayerId: string, position: LatLon) => Promise<(LatLon & { distanceM: number; fresh?: boolean; searchMs?: number }) | null>;
  /** Rage buffs the owner and their party only. */
  partyMemberIds?: (ownerPlayerId: string) => readonly string[];
}>;

/** `travelTo`: Find Open Land moves the owner there through the authoritative relocation path. */
export type PetAbilityResult = Readonly<{
  notice: string;
  ping?: PetTrackPing;
  travelTo?: LatLon;
  searchMs?: number;
  /** True while the pet walks into reach; the ability fires (and its cooldown starts) on arrival. */
  pending?: boolean;
  /** Tail Lash: attackable structures around this point take one full hit each. */
  structureStrike?: Readonly<{ origin: LatLon; radiusM: number }>;
}>;

export class PetAbilityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PetAbilityError";
  }
}

const OPEN_LAND_GRANT_MS = 55_000;
const PET_RAGE_BONUS = 3;
const PET_RAGE_MS = 22_000;
/** Pounce leaps onto the target only from this close. */
const PET_POUNCE_LEAP_M = 28;
const PET_TRACK_RADIUS_M = 4_600;
const PET_AREA_RADIUS_M = 27;
const PET_EMBER_SPIT_SPLASH_RADIUS_M = 14;
/** Diminishing returns: repeat holds on the same player within this window shrink by half each time. */
const PET_PVP_DR_WINDOW_MS = 15_000;
const HIDE_ITEM = /(^leather$|_hide$|_pelt$)/u;
const HIDE_ARCHETYPES: ReadonlySet<string> = new Set(Object.values(MOB_DEFINITIONS)
  .filter((definition) => [...(definition.rewards?.items ?? []), ...(definition.rewards?.chanceItems ?? [])]
    .some((reward) => HIDE_ITEM.test(reward.itemId)))
  .map((definition) => definition.key));

export function companionBaseHealthFromRuntime(input: Readonly<{ currentHealth: number; maxHealth: number; baseMaxHealth: number }>): number {
  if (input.maxHealth <= 0 || input.baseMaxHealth <= 0) return 0;
  return Math.max(0, Math.min(input.baseMaxHealth, Math.round(input.currentHealth / input.maxHealth * input.baseMaxHealth)));
}

/** Lightweight server-authoritative controller over the existing mob-backed companion entity. */
export class PetCompanionRuntime {
  private readonly activeByOwner = new Map<string, ActiveCompanion>();
  private readonly pvpHolds = new Map<string, { atMs: number; count: number }>();
  /** Find Open Land results waiting for the owner's travel request (one use, short-lived). */
  private readonly openLandGrants = new Map<string, { lat: number; lon: number; expiresAtMs: number }>();

  constructor(private readonly combat: CombatEngine, private readonly options: PetCompanionRuntimeOptions) {}

  activePetId(ownerPlayerId: string): string | null {
    return this.activeByOwner.get(ownerPlayerId)?.dog.id ?? null;
  }

  isOwnerInDungeon(ownerPlayerId: string): boolean {
    const owner = this.combat.entity(ownerPlayerId);
    return owner ? isDungeonRegion(owner.regionCode) : false;
  }

  /** A Giving Berry healed the pet to full. */
  restoreHealth(ownerPlayerId: string, petId: string): void {
    const active = this.activeByOwner.get(ownerPlayerId);
    if (!active || active.dog.id !== petId) return;
    active.dog = { ...active.dog, health: active.dog.baseMaxHealth };
    const entity = this.combat.entity(active.entityId);
    if (entity) this.combat.healEntity(active.entityId, entity.maxHealth, active.entityId);
  }

  /** The spot Find Open Land found, consumed by the owner's VISIT_OPEN_LAND travel. */
  takeOpenLandGrant(ownerPlayerId: string, nowMs = Date.now()): LatLon | null {
    const grant = this.openLandGrants.get(ownerPlayerId);
    this.openLandGrants.delete(ownerPlayerId);
    return grant && grant.expiresAtMs > nowMs ? { lat: grant.lat, lon: grant.lon } : null;
  }

  /** Gives an ability back when its follow-up failed (e.g. the Find Open Land move was refused). */
  clearCooldown(ownerPlayerId: string, abilityId: PetAbilityId): void {
    const active = this.activeByOwner.get(ownerPlayerId);
    if (active) delete active.abilityReadyAt[abilityId];
  }

  /** Ability ready times for the owner's pet out right now (ISO), for the pet snapshot. */
  abilityReadyAt(ownerPlayerId: string): Partial<Record<PetAbilityId, string>> {
    const active = this.activeByOwner.get(ownerPlayerId);
    if (!active) return {};
    return Object.fromEntries(Object.entries(active.abilityReadyAt)
      .map(([id, at]) => [id, new Date(at!).toISOString()])) as Partial<Record<PetAbilityId, string>>;
  }

  /** Fires one of the pet's learned abilities. Cooldowns are cut by Companion Bond. */
  async useAbility(
    ownerPlayerId: string,
    petId: string,
    abilityId: PetAbilityId,
    nowMs = Date.now(),
    targetEntityId: string | null = null
  ): Promise<PetAbilityResult> {
    const active = this.activeByOwner.get(ownerPlayerId);
    const owner = this.combat.entity(ownerPlayerId);
    const pet = active ? this.combat.entity(active.entityId) : null;
    if (!active || active.dog.id !== petId || !owner || !pet || pet.lifeState !== "alive") {
      throw new PetAbilityError("INVALID_PET_STATE", "That pet is not out right now.");
    }
    const definition = PET_ABILITY_DEFINITIONS[abilityId];
    if (!active.dog.unlockedAbilities.includes(abilityId)) {
      throw new PetAbilityError("PET_ABILITY_LOCKED", `${definition.name} is not learned yet.`);
    }
    const readyAt = active.abilityReadyAt[abilityId] ?? 0;
    if (nowMs < readyAt) {
      throw new PetAbilityError("PET_ABILITY_COOLDOWN", `${definition.name} is ready in ${Math.ceil((readyAt - nowMs) / 1_000)}s.`);
    }
    const target = definition.targeting === "enemy"
      ? this.abilityTarget(ownerPlayerId, owner, pet, definition.hitsPlayers, targetEntityId)
      : null;
    if (definition.targeting === "enemy" && !target) {
      throw new PetAbilityError("PET_ABILITY_TARGET", targetEntityId
        ? `${definition.name} can't reach that target.`
        : "Pick a target in range for your pet first.");
    }
    if (target && active.mode === "sit" && distanceMeters(pet, target) > petAbilityReachM(abilityId)) {
      // Stay holds until Follow: a staying pet never walks off to reach a target.
      throw new PetAbilityError("PET_ABILITY_STAYING", `${definition.name}: your pet is staying and the target is out of reach. Tap Follow first.`);
    }
    if (target && targetEntityId) active.assignedTargetId = target.entityId;
    if (target && distanceMeters(pet, target) > petAbilityReachM(abilityId)) {
      // Out of reach: the pet walks over at its normal speed and fires on arrival (see update).
      if (active.pending) this.cancelPending(ownerPlayerId, active, "replaced by a new order");
      active.pending = { abilityId, targetId: target.entityId, startedAtMs: nowMs, ownerTargetAtStart: owner.targetEntityId };
      active.assignedTargetId = target.entityId;
      return { notice: `${definition.name}: moving into range…`, pending: true };
    }
    if (active.pending?.abilityId === abilityId) active.pending = null;
    if (abilityId !== "shadow_hide") this.combat.breakPetShadowHide(ownerPlayerId);
    const result = await this.resolveAbility(abilityId, ownerPlayerId, owner, pet, active, target, nowMs);
    this.emitAbilityEffect(abilityId, ownerPlayerId, active, pet, target);
    if (result.travelTo) this.openLandGrants.set(ownerPlayerId, { ...result.travelTo, expiresAtMs: nowMs + OPEN_LAND_GRANT_MS });
    active.abilityReadyAt[abilityId] = nowMs + petAbilityCooldownMs(abilityId, this.combat.generalSkillRank(ownerPlayerId, "companion_bond"));
    return result;
  }

  /**
   * Explicit targets must be alive, within reach of the owner and harmable (mobs other than
   * companions and protected NPCs; players only for abilities that hit players and only when the
   * owner could attack them). Without one the owner's current combat target is used.
   */
  private abilityTarget(
    ownerPlayerId: string,
    owner: { targetEntityId: string | null; zoneId: string } & LatLon,
    pet: LatLon,
    hitsPlayers: boolean,
    targetEntityId: string | null
  ) {
    const id = targetEntityId ?? owner.targetEntityId;
    const target = id ? this.combat.entity(id) : null;
    if (!target || target.lifeState !== "alive" || target.entityId === ownerPlayerId || target.zoneId !== owner.zoneId) return null;
    void pet;
    // The pet walks into reach itself, so the target only has to be within its fighting range of the owner.
    if (distanceMeters(owner, target) > PET_COMBAT_LEASH_M) return null;
    if (target.kind === "mob") return target.companion || target.npcFaction?.protected ? null : target;
    return hitsPlayers && this.combat.canOwnerHarmPlayer(ownerPlayerId, target.entityId) ? target : null;
  }

  /** PvP: holds on players stop at 2 s and halve on each repeat within the window. */
  private holdMs(targetId: string, isPlayer: boolean, baseMs: number, nowMs: number): number {
    if (!isPlayer) return baseMs;
    for (const [id, hold] of this.pvpHolds) {
      if (nowMs - hold.atMs >= PET_PVP_DR_WINDOW_MS) this.pvpHolds.delete(id);
    }
    const previous = this.pvpHolds.get(targetId);
    const repeats = previous ? previous.count + 1 : 0;
    this.pvpHolds.set(targetId, { atMs: nowMs, count: repeats });
    return Math.round(Math.min(baseMs, PET_PVP_MAX_HOLD_MS) / 2 ** repeats);
  }

  private hit(ownerPlayerId: string, active: ActiveCompanion, targetId: string, isPlayer: boolean, multiplier: number, techniqueId: string): number {
    const damage = active.dog.damage * multiplier * (isPlayer ? PET_PVP_DAMAGE_MULTIPLIER : 1);
    return this.combat.applyScriptedDamage(ownerPlayerId, targetId, Math.max(1, damage), techniqueId, active.entityId);
  }

  private hostilesAround(ownerPlayerId: string, center: LatLon, radiusM: number, includePlayers: boolean) {
    return this.combat.nearbyEntityIds(center, radiusM)
      .map((id) => this.combat.entity(id))
      .filter((entity): entity is NonNullable<typeof entity> => Boolean(entity) && entity!.lifeState === "alive" &&
        distanceMeters(center, entity!) <= radiusM && entity!.entityId !== ownerPlayerId &&
        (entity!.kind === "mob"
          ? !entity!.companion && !entity!.npcFaction
          : includePlayers && this.combat.canOwnerHarmPlayer(ownerPlayerId, entity!.entityId)));
  }

  private async resolveAbility(
    abilityId: PetAbilityId,
    ownerPlayerId: string,
    owner: LatLon & { regionCode: string },
    pet: LatLon & { entityId: string },
    active: ActiveCompanion,
    target: (LatLon & { entityId: string; kind: "player" | "mob" }) | null,
    nowMs: number
  ): Promise<PetAbilityResult> {
    const name = PET_ABILITY_DEFINITIONS[abilityId].name;
    const isPlayer = target?.kind === "player";
    const effect = (kind: Parameters<CombatEngine["applyPetEffect"]>[2], ms: number, amount = 1) =>
      this.combat.applyPetEffect(active.entityId, target!.entityId, kind, ms, amount);
    switch (abilityId) {
      case "track_hide":
      case "sky_sight": {
        const found = this.combat.nearbyEntityIds(owner, PET_TRACK_RADIUS_M)
          .map((id) => this.combat.entity(id))
          .filter((entity): entity is NonNullable<typeof entity> => Boolean(entity) && entity!.kind === "mob" &&
            entity!.lifeState === "alive" && !entity!.companion && !entity!.npcFaction &&
            (abilityId === "track_hide"
              ? HIDE_ARCHETYPES.has(entity!.archetypeKey ?? "")
              : entity!.boss === true || entity!.challengeTier === "epic" || entity!.challengeTier === "legendary"))
          .sort((left, right) => distanceMeters(owner, left) - distanceMeters(owner, right))[0];
        if (!found) {
          return { notice: abilityId === "track_hide"
            ? `${name}: no hide-bearing creatures within ${formatDistance(PET_TRACK_RADIUS_M)}.`
            : `${name}: no elites or bosses within ${formatDistance(PET_TRACK_RADIUS_M)}.` };
        }
        const distanceM = Math.round(distanceMeters(owner, found));
        return { notice: `${name}: ${found.name} found, ${formatDistance(distanceM)} ${compass(owner, found)}.`, ping: {
          abilityId, label: found.name, lat: found.lat, lon: found.lon, distanceM
        } };
      }
      case "find_open_land": {
        const open = await this.options.findOpenLand?.(ownerPlayerId, owner) ?? null;
        if (!open) {
          throw new PetAbilityError("PET_OPEN_LAND_NOT_FOUND", `${name}: no open land within ${formatDistance(OPEN_LAND_FRESH_SEARCH_MAX_M)}.`);
        }
        const distanceM = Math.round(open.distanceM);
        const where = `${formatDistance(distanceM)} ${compass(owner, open)}`;
        return {
          notice: open.fresh === false
            ? `${name}: no fresh land within ${formatDistance(OPEN_LAND_FRESH_SEARCH_MAX_M)}; taking you to the nearest open spot, ${where}.`
            : `${name}: fresh land ${where}.`,
          ping: { abilityId, label: "Open land", lat: open.lat, lon: open.lon, distanceM },
          travelTo: { lat: open.lat, lon: open.lon },
          ...(open.searchMs === undefined ? {} : { searchMs: open.searchMs })
        };
      }
      case "web_snare":
        effect("rooted", this.holdMs(target!.entityId, isPlayer, 5_500, nowMs));
        return { notice: "Web Snare!" };
      case "envenom":
        effect("poison", 1);
        this.hit(ownerPlayerId, active, target!.entityId, isPlayer, 1, "pet_envenom");
        return { notice: "Envenom!" };
      case "pounce":
        if (distanceMeters(pet, target!) <= PET_POUNCE_LEAP_M) {
          this.combat.relocateCompanion(active.entityId, destinationPoint(target!, 2, bearingDegrees(target!, pet)));
        }
        this.hit(ownerPlayerId, active, target!.entityId, isPlayer, 2, "pet_pounce");
        effect("rooted", this.holdMs(target!.entityId, isPlayer, 1_500, nowMs));
        return { notice: "Pounce!" };
      case "rending_bite":
        effect("bleed", 9_000, Math.max(1, Math.round(active.dog.damage / 3)));
        effect("defense_reduction", 9_000, 1);
        return { notice: "Rending Bite!" };
      case "squall_burst": {
        const hits = this.hostilesAround(ownerPlayerId, pet, PET_AREA_RADIUS_M, true);
        for (const entity of hits) {
          if (entity.kind === "player") {
            this.combat.knockbackPlayer(entity.entityId, pet, 18);
            this.combat.applyPetEffect(active.entityId, entity.entityId, "rooted", this.holdMs(entity.entityId, true, 1_000, nowMs));
          } else {
            if (isDisplaceable(entity)) this.combat.leapMobTo(entity.entityId, destinationPoint(entity, 18, bearingDegrees(pet, entity)));
            this.combat.applyPetEffect(active.entityId, entity.entityId, "rooted", 1_400);
          }
        }
        return { notice: hits.length ? `Squall Burst hit ${hits.length}.` : "Squall Burst found nothing to blow away." };
      }
      case "hold_fast":
        if (isPlayer) throw new PetAbilityError("PET_ABILITY_TARGET", "Hold Fast only works on monsters.");
        effect("rooted", 27_000);
        return { notice: "Pinned for 27 seconds." };
      case "shadow_hide":
        this.combat.grantPetShadowHide(ownerPlayerId, 27_000);
        return { notice: "You and your wolf slip into the shadows." };
      case "bull_rush":
        this.hit(ownerPlayerId, active, target!.entityId, isPlayer, 2, "pet_charge");
        effect("rooted", this.holdMs(target!.entityId, isPlayer, 2_000, nowMs));
        return { notice: "Bull Rush!" };
      case "fury": {
        active.rageUntil = nowMs + PET_RAGE_MS;
        this.combat.applyPetEffect(active.entityId, active.entityId, "flat_defense", PET_RAGE_MS, PET_RAGE_BONUS);
        const allies = this.combat.nearbyEntityIds(pet, PET_AREA_RADIUS_M)
          .map((id) => this.combat.entity(id))
          .filter((entity) => entity?.kind === "player" && entity.lifeState === "alive" &&
            (entity.entityId === ownerPlayerId || (this.options.partyMemberIds?.(ownerPlayerId) ?? []).includes(entity.entityId)));
        for (const ally of allies) {
          this.combat.applyPetEffect(active.entityId, ally!.entityId, "flat_defense", PET_RAGE_MS, PET_RAGE_BONUS);
          this.combat.applyPetEffect(active.entityId, ally!.entityId, "outgoing_damage", PET_RAGE_MS, 0.18);
        }
        return { notice: "Fury!" };
      }
      case "ember_spit": {
        this.hit(ownerPlayerId, active, target!.entityId, isPlayer, 3, "pet_ember_spit");
        for (const splash of this.hostilesAround(ownerPlayerId, target!, PET_EMBER_SPIT_SPLASH_RADIUS_M, true)) {
          if (splash.entityId !== target!.entityId) this.hit(ownerPlayerId, active, splash.entityId, splash.kind === "player", 1, "pet_ember_spit");
        }
        return { notice: "Ember Spit!" };
      }
      case "tail_lash": {
        const hits = this.hostilesAround(ownerPlayerId, pet, PET_TAIL_LASH_RADIUS_M, true);
        for (const entity of hits) this.hit(ownerPlayerId, active, entity.entityId, entity.kind === "player", 2, "pet_tail_lash");
        return {
          notice: hits.length ? `Tail Lash hit ${hits.length} creature${hits.length === 1 ? "" : "s"}.` : "Tail Lash hit no creatures.",
          // Outdoors, structures in reach take a full hit each through the normal structure warfare rules.
          ...(owner.regionCode.startsWith("interior:") ? {} : {
            structureStrike: { origin: { lat: pet.lat, lon: pet.lon }, radiusM: PET_TAIL_LASH_RADIUS_M }
          })
        };
      }
      case "hug": {
        const drained = this.hit(ownerPlayerId, active, target!.entityId, isPlayer, 2, "pet_hug");
        if (drained > 0) this.combat.healEntity(ownerPlayerId, drained, active.entityId);
        return { notice: drained > 0 ? `Hug drained ${drained}.` : "Hug!" };
      }
      case "latch":
        effect("movement_slow", this.holdMs(target!.entityId, isPlayer, 5_500, nowMs), 0.35);
        return { notice: "Latch!" };
      case "mend": {
        const ownerEntity = this.combat.entity(ownerPlayerId);
        const petEntity = this.combat.entity(active.entityId);
        if (ownerEntity) this.combat.healEntity(ownerPlayerId, Math.max(1, Math.round(ownerEntity.maxHealth * 0.22)), active.entityId);
        if (petEntity) this.combat.healEntity(active.entityId, Math.max(1, Math.round(petEntity.maxHealth * 0.22)), active.entityId);
        return { notice: "Mend!" };
      }
      case "mischief":
        effect("gloom", 1);
        return { notice: "Mischief: your target is Withered." };
    }
  }

  /** Stay holds position where the pet stands; Follow resumes following. */
  command(ownerPlayerId: string, petId: string, command: "stay" | "follow", nowMs = Date.now()): boolean {
    const active = this.activeByOwner.get(ownerPlayerId);
    if (!active || active.dog.id !== petId || !this.combat.entity(active.entityId)) return false;
    if (active.pending) this.cancelPending(ownerPlayerId, active, command === "stay" ? "told to stay" : "called back");
    this.setMode(active, command === "follow" ? "play" : "sit");
    active.stayAt = null;
    active.lastMovedAt = nowMs;
    return true;
  }

  /**
   * Drag-to-place Stay: the pet walks (at its normal speed) to `destination` and stays there until
   * Follow. The spot must be outdoors next to the owner, within reach and walkable.
   */
  placeStay(ownerPlayerId: string, petId: string, destination: LatLon, nowMs = Date.now()): LatLon {
    const active = this.activeByOwner.get(ownerPlayerId);
    const owner = this.combat.entity(ownerPlayerId);
    const pet = active ? this.combat.entity(active.entityId) : null;
    if (!active || active.dog.id !== petId || !owner || !pet) throw new PetAbilityError("PET_NOT_OUT", "That pet is not out right now.");
    if (!Number.isFinite(destination.lat) || !Number.isFinite(destination.lon) || !isWithinWorldEdge(destination)) {
      throw new PetAbilityError("PET_STAY_SPOT_INVALID", "Your pet can't go there.");
    }
    if (owner.regionCode.startsWith("interior:") || !owner.zoneId.startsWith("world:") ||
      !adjacentZoneIdsForPosition(owner).includes(zoneIdForPosition(destination))) {
      throw new PetAbilityError("PET_STAY_SPOT_INVALID", "Pets can only be placed outdoors near you.");
    }
    if (distanceMeters(owner, destination) > PET_STAY_PLACE_MAX_DISTANCE_M) {
      throw new PetAbilityError("PET_STAY_SPOT_TOO_FAR", `Place your pet within ${PET_STAY_PLACE_MAX_DISTANCE_M / 1_000} km of you.`);
    }
    const walkM = distanceMeters(pet, destination);
    const bearing = bearingDegrees(pet, destination);
    for (let along = STAY_PATH_SAMPLE_M; along < walkM + STAY_PATH_SAMPLE_M; along += STAY_PATH_SAMPLE_M) {
      const sample = along >= walkM ? destination : destinationPoint(pet, along, bearing);
      if (!this.combat.isCompanionPositionTraversable(sample)) {
        throw new PetAbilityError("PET_STAY_SPOT_UNREACHABLE", "Your pet can't reach that spot.");
      }
    }
    if (active.pending) this.cancelPending(ownerPlayerId, active, "told to stay");
    this.setMode(active, "sit");
    active.assignedTargetId = null;
    active.stayAt = { lat: destination.lat, lon: destination.lon };
    active.lastMovedAt = nowMs;
    return active.stayAt;
  }

  /** The spot a placed Stay walks to (null for Follow or a plain Stay). */
  stayAt(ownerPlayerId: string): LatLon | null {
    return this.activeByOwner.get(ownerPlayerId)?.stayAt ?? null;
  }

  summon(ownerPlayerId: string, dog: ActivePet, nowMs = Date.now()): void {
    this.unsummon(ownerPlayerId);
    const owner = this.combat.entity(ownerPlayerId);
    if (!owner || owner.kind !== "player" || owner.lifeState !== "alive") throw new Error("Pet owner is not an active CombatEngine player");
    if (isDungeonRegion(owner.regionCode)) return;
    const entityId = `pet-companion:${dog.id}`;
    const companionBondRank = this.combat.generalSkillRank(ownerPlayerId, "companion_bond");
    const maxHealthMultiplier = COMPANION_BOND_MAX_HEALTH_MULTIPLIERS[companionBondRank]!;
    const scaledMaxHealth = Math.max(1, Math.round(dog.baseMaxHealth * maxHealthMultiplier));
    this.combat.spawnMob({
      entityId, archetype: "wolf", position: roamPoint(createRoamState(dog.id, nowMs), PET_ROAM, owner, null, 0.4),
      homePosition: { lat: owner.lat, lon: owner.lon },
      regionCode: owner.regionCode, zoneId: owner.zoneId, worldAi: false,
      movementSpeedMpsOverride: this.ownerRelativeSpeedMps(ownerPlayerId),
      defenseOverride: dog.defense,
      companion: {
        ownerPlayerId, dogId: dog.id, name: dog.name, species: dog.species,
        baseMaxHealth: dog.baseMaxHealth, maxHealth: scaledMaxHealth,
        currentHealth: Math.max(0, Math.min(scaledMaxHealth, Math.round(scaledMaxHealth * dog.health / dog.baseMaxHealth))),
        damage: dog.damage, mode: "play",
      },
    });
    this.activeByOwner.set(ownerPlayerId, {
      dog, entityId, mode: "play", lastMovedAt: nowMs, nextAssistAt: nowMs, companionBondRank,
      abilityReadyAt: {}, rageUntil: 0, ownerHeading: null, lastOwnerPosition: { lat: owner.lat, lon: owner.lon },
      assignedTargetId: null, lastOwnerTargetId: owner.targetEntityId, boundaryIdentity: this.boundaryIdentity(ownerPlayerId),
      roam: createRoamState(dog.id, nowMs), pending: null, stayAt: null,
    });
  }

  unsummon(ownerPlayerId: string): void {
    const active = this.activeByOwner.get(ownerPlayerId);
    if (!active) return;
    this.combat.despawnMob(active.entityId);
    this.activeByOwner.delete(ownerPlayerId);
  }

  sync(ownerPlayerId: string, dog: ActivePet | null, nowMs = Date.now()): void {
    if (!dog) return this.unsummon(ownerPlayerId);
    const active = this.activeByOwner.get(ownerPlayerId);
    if (active?.dog.id === dog.id && this.combat.entity(active.entityId)) {
      active.dog = dog;
      return;
    }
    this.summon(ownerPlayerId, dog, nowMs);
  }

  /**
   * Pet behaviour: roam loosely a few hundred metres around the owner (relaxed walks, pauses), drift
   * after them when they move far, jog to catch up beyond ~430 m, and join fights: the owner's
   * target, the enemy it was sent at, or whatever attacks the owner. Stay holds it in place.
   */
  update(ownerPlayerId: string, nowMs = Date.now()): void {
    const active = this.activeByOwner.get(ownerPlayerId);
    if (!active || nowMs - active.lastMovedAt < UPDATE_INTERVAL_MS) return;
    const owner = this.combat.entity(ownerPlayerId);
    const petEntity = this.combat.entity(active.entityId);
    if (owner && owner.lifeState !== "alive") {
      // The pet goes away with its owner: it heads home to rest like a defeated pet.
      this.unsummon(ownerPlayerId);
      this.options.onOwnerDefeated?.(ownerPlayerId, active.dog.id);
      return;
    }
    if (!owner || !petEntity || petEntity.lifeState !== "alive") return this.unsummon(ownerPlayerId);
    if (nowMs >= active.dog.activeUntilMs) {
      this.unsummon(ownerPlayerId);
      this.options.onExpired?.(ownerPlayerId, active.dog.id);
      return;
    }
    if (isDungeonRegion(owner.regionCode)) {
      this.unsummon(ownerPlayerId);
      this.options.onSentHome?.(ownerPlayerId, active.dog.id);
      return;
    }
    const elapsedS = Math.min(300, nowMs - active.lastMovedAt) / 1_000;
    active.lastMovedAt = nowMs;

    const rank = this.combat.generalSkillRank(ownerPlayerId, "companion_bond");
    if (rank !== active.companionBondRank) {
      this.combat.rescaleCompanionHealth(active.entityId, COMPANION_BOND_MAX_HEALTH_MULTIPLIERS[rank]!);
      active.companionBondRank = rank;
    }

    // Owner facing comes from their own movement.
    const ownerStep = distanceMeters(active.lastOwnerPosition, owner);
    const boundaryIdentity = this.boundaryIdentity(ownerPlayerId);
    // Only the owner's own travel (flag jump, relocate, World Map, Find Open Land) moves the pet
    // instantly: a relocation bumps the owner's relocation revision/anchor. A jump far beyond any
    // walk also counts, in case the anchor and the owner's position land on different ticks.
    const jumped = ownerStep > Math.max(OWNER_JUMP_MIN_M, this.ownerRelativeSpeedMps(ownerPlayerId) * elapsedS * 3);
    const relocated = boundaryIdentity !== active.boundaryIdentity || jumped;
    active.boundaryIdentity = boundaryIdentity;
    if (ownerStep >= OWNER_HEADING_MIN_STEP_M && !relocated) active.ownerHeading = bearingDegrees(active.lastOwnerPosition, owner);
    if (ownerStep >= OWNER_HEADING_MIN_STEP_M) active.lastOwnerPosition = { lat: owner.lat, lon: owner.lon };

    if (relocated) {
      // Every pet travels with its owner. One on Stay keeps staying wherever it lands.
      active.stayAt = null;
      active.roam.goal = null;
      this.combat.relocateCompanion(active.entityId, roamPoint(active.roam, PET_ROAM, owner, active.ownerHeading, 0.6), owner);
      return;
    }

    // Stay: nothing moves the pet until Follow (it still bites anything in reach). A placed Stay
    // first walks to its spot at the normal speed.
    if (active.mode === "sit") {
      let pet = petEntity;
      if (active.stayAt) {
        const remaining = distanceMeters(petEntity, active.stayAt);
        const step = Math.min(remaining, this.ownerRelativeSpeedMps(ownerPlayerId) * elapsedS);
        if (remaining > 0.5) {
          this.combat.relocateCompanion(active.entityId, step >= remaining
            ? active.stayAt
            : destinationPoint(petEntity, step, bearingDegrees(petEntity, active.stayAt)), owner);
          pet = this.combat.entity(active.entityId) ?? petEntity;
        }
      }
      const target = this.combatTarget(ownerPlayerId, owner, active);
      if (target && distanceMeters(pet, target) <= PET_MELEE_RANGE_M) this.assist(ownerPlayerId, active, target, rank, nowMs);
      return;
    }
    if (active.pending) this.advancePending(ownerPlayerId, owner, petEntity, active, nowMs);

    // An owner retarget overrides an assigned target.
    if (owner.targetEntityId && owner.targetEntityId !== active.lastOwnerTargetId) active.assignedTargetId = null;
    active.lastOwnerTargetId = owner.targetEntityId;
    const target = this.combatTarget(ownerPlayerId, owner, active);
    if (!target) active.assignedTargetId = null;

    if (target) {
      // Join the fight: run straight in, then attack on the uniform cadence.
      active.roam.goal = null;
      const remaining = distanceMeters(petEntity, target) - PET_MELEE_RANGE_M * 0.8;
      if (remaining > 0) {
        const step = Math.min(remaining, this.ownerRelativeSpeedMps(ownerPlayerId) * elapsedS);
        this.combat.relocateCompanion(active.entityId, destinationPoint(petEntity, step, bearingDegrees(petEntity, target)), owner);
      }
      const pet = this.combat.entity(active.entityId) ?? petEntity;
      if (distanceMeters(pet, target) <= PET_MELEE_RANGE_M) this.assist(ownerPlayerId, active, target, rank, nowMs);
      return;
    }
    const nextPoint = roamStep(active.roam, PET_ROAM, {
      position: petEntity, owner, ownerHeading: active.ownerHeading,
      baseSpeedMps: this.ownerRelativeSpeedMps(ownerPlayerId), elapsedS, nowMs
    });
    if (nextPoint) this.combat.relocateCompanion(active.entityId, nextPoint, owner);
  }

  updateAll(nowMs = Date.now()): void {
    for (const ownerPlayerId of [...this.activeByOwner.keys()]) this.update(ownerPlayerId, nowMs);
  }

  /** Changes whenever the owner travels; without a boundary source only a long jump counts. */
  private boundaryIdentity(ownerPlayerId: string): string {
    const boundary = this.options.boundaryForOwner?.(ownerPlayerId);
    return boundary ? `${boundary.revision}:${boundary.anchor.lat}:${boundary.anchor.lon}:${boundary.radiusM}` : "";
  }

  private ownerRelativeSpeedMps(ownerPlayerId: string): number {
    // One constant speed for every pet movement: the owner's walking speed.
    return this.options.playerBaseSpeedMps * this.combat.playerMovementMultiplier(ownerPlayerId);
  }

  /** The enemy the owner sent the pet at, else the owner's own attack target, while it is in leash. */
  private combatTarget(
    ownerPlayerId: string,
    owner: { targetEntityId: string | null; zoneId: string } & LatLon,
    active: ActiveCompanion
  ) {
    for (const id of [active.assignedTargetId, owner.targetEntityId, this.ownerAttacker(ownerPlayerId, owner)]) {
      const target = id ? this.combat.entity(id) : null;
      if (!target || target.lifeState !== "alive" || target.zoneId !== owner.zoneId) continue;
      if (distanceMeters(owner, target) > PET_COMBAT_LEASH_M) continue;
      if (target.kind === "mob" && !target.companion && !target.npcFaction?.protected) return target;
      if (target.kind === "player" && this.combat.canOwnerHarmPlayer(ownerPlayerId, target.entityId)) return target;
    }
    return null;
  }

  /** One-shot on-map visual for the ability, drawn at ground scale for everyone who can see it. */
  private emitAbilityEffect(
    abilityId: PetAbilityId,
    ownerPlayerId: string,
    active: ActiveCompanion,
    pet: LatLon,
    target: (LatLon & { entityId: string }) | null
  ): void {
    const at = { lat: pet.lat, lon: pet.lon };
    const effect = ((): { position: LatLon; radiusM?: number; targetEntityId?: string; durationMs: number } | null => {
      switch (abilityId) {
        case "tail_lash": return { position: at, radiusM: PET_TAIL_LASH_RADIUS_M, durationMs: 600 };
        case "squall_burst": return { position: at, radiusM: PET_AREA_RADIUS_M, durationMs: 500 };
        case "fury": return { position: at, radiusM: PET_AREA_RADIUS_M, durationMs: 600 };
        case "ember_spit": return target
          ? { position: { lat: target.lat, lon: target.lon }, radiusM: PET_EMBER_SPIT_SPLASH_RADIUS_M, targetEntityId: target.entityId, durationMs: 800 }
          : null;
        case "mend": {
          const owner = this.combat.entity(ownerPlayerId);
          return owner ? { position: { lat: owner.lat, lon: owner.lon }, targetEntityId: ownerPlayerId, durationMs: 700 } : null;
        }
        default:
          // Single-target hits get a small flash on the target.
          return target && PET_ABILITY_DEFINITIONS[abilityId].targeting === "enemy"
            ? { position: { lat: target.lat, lon: target.lon }, targetEntityId: target.entityId, durationMs: 300 }
            : null;
      }
    })();
    if (effect) this.combat.emitPetAbilityEffect({ sourceEntityId: active.entityId, abilityId, ...effect });
  }

  private cancelPending(ownerPlayerId: string, active: ActiveCompanion, reason: string): void {
    const pending = active.pending;
    if (!pending) return;
    active.pending = null;
    if (active.assignedTargetId === pending.targetId) active.assignedTargetId = null;
    this.options.onDeferredAbility?.(ownerPlayerId, active.dog.id, {
      abilityId: pending.abilityId, fired: false,
      notice: `${PET_ABILITY_DEFINITIONS[pending.abilityId].name} cancelled: ${reason}.`
    });
  }

  /** Checks a moving-into-range ability: cancel, keep walking, or fire once in reach. */
  private advancePending(
    ownerPlayerId: string,
    owner: CombatEntitySnapshot,
    petEntity: CombatEntitySnapshot,
    active: ActiveCompanion,
    nowMs: number
  ): void {
    const pending = active.pending!;
    const target = this.combat.entity(pending.targetId);
    if (!target || target.lifeState !== "alive" || target.zoneId !== owner.zoneId || distanceMeters(owner, target) > PET_COMBAT_LEASH_M) {
      return this.cancelPending(ownerPlayerId, active, "the target is gone");
    }
    if (owner.targetEntityId && owner.targetEntityId !== pending.ownerTargetAtStart && owner.targetEntityId !== pending.targetId) {
      return this.cancelPending(ownerPlayerId, active, "you picked another target");
    }
    if (nowMs - pending.startedAtMs > PET_PENDING_ABILITY_TIMEOUT_MS) {
      return this.cancelPending(ownerPlayerId, active, "your pet couldn't reach the target");
    }
    if (distanceMeters(petEntity, target) > petAbilityReachM(pending.abilityId)) return;
    active.pending = null;
    if (pending.abilityId !== "shadow_hide") this.combat.breakPetShadowHide(ownerPlayerId);
    active.abilityReadyAt[pending.abilityId] = nowMs + petAbilityCooldownMs(pending.abilityId, this.combat.generalSkillRank(ownerPlayerId, "companion_bond"));
    void this.resolveAbility(pending.abilityId, ownerPlayerId, owner, petEntity, active, target, nowMs)
      .then((result) => {
        this.emitAbilityEffect(pending.abilityId, ownerPlayerId, active, petEntity, target);
        return result;
      })
      .then((result) => this.options.onDeferredAbility?.(ownerPlayerId, active.dog.id, {
        abilityId: pending.abilityId, fired: true, notice: result.notice, ...(result.ping ? { ping: result.ping } : {})
      }))
      .catch((error: unknown) => {
        delete active.abilityReadyAt[pending.abilityId];
        this.options.onDeferredAbility?.(ownerPlayerId, active.dog.id, {
          abilityId: pending.abilityId, fired: false,
          notice: error instanceof Error ? error.message : `${PET_ABILITY_DEFINITIONS[pending.abilityId].name} failed.`
        });
      });
  }

  /** A monster attacking the owner near them: the pet comes to defend. */
  private ownerAttacker(ownerPlayerId: string, owner: LatLon & { zoneId: string }): string | null {
    let best: { id: string; distanceM: number } | null = null;
    for (const id of this.combat.nearbyEntityIds(owner, PET_DEFEND_RADIUS_M)) {
      const entity = this.combat.entity(id);
      if (!entity || entity.kind !== "mob" || entity.companion || entity.lifeState !== "alive") continue;
      if (entity.targetEntityId !== ownerPlayerId || entity.zoneId !== owner.zoneId) continue;
      const distanceM = distanceMeters(owner, entity);
      if (!best || distanceM < best.distanceM) best = { id, distanceM };
    }
    return best?.id ?? null;
  }

  private assist(ownerId: string, active: ActiveCompanion, target: { entityId: string; kind: "player" | "mob" }, rank: number, nowMs: number): void {
    if (nowMs < active.nextAssistAt) return;
    this.combat.breakPetShadowHide(ownerId);
    const damage = (active.dog.damage + (nowMs < active.rageUntil ? PET_RAGE_BONUS : 0) + this.combat.petTacticsShare(ownerId)) *
      (target.kind === "player" ? PET_PVP_DAMAGE_MULTIPLIER : 1);
    const applied = this.combat.applyScriptedDamage(ownerId, target.entityId, Math.max(1, damage), "pet_companion_assist", active.entityId);
    const bondHeal = COMPANION_BOND_HEAL_PER_HIT[rank as 0 | 1 | 2 | 3] ?? 0;
    if (applied > 0 && bondHeal > 0) {
      this.combat.healEntity(ownerId, bondHeal, active.entityId);
      this.combat.healEntity(active.entityId, bondHeal, active.entityId);
    }
    active.nextAssistAt = nowMs + PET_ATTACK_CADENCE_MS;
  }

  private setMode(active: ActiveCompanion, mode: DogCompanionMode): void {
    if (active.mode === mode) return;
    active.mode = mode;
    this.combat.setCompanionMode(active.entityId, mode);
  }
}

export function isDungeonRegion(regionCode: string): boolean {
  return regionCode.startsWith("interior:dungeon:") || regionCode.startsWith("interior:sewer:");
}

function compass(from: LatLon, to: LatLon): string {
  const points = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return points[Math.round(bearingDegrees(from, to) / 45) % 8]!;
}

function formatDistance(meters: number): string {
  return meters >= 1_000 ? `${(meters / 1_000).toFixed(1)} km` : `${meters} m`;
}

function bearingDegrees(from: LatLon, to: LatLon): number {
  const p1 = from.lat * Math.PI / 180;
  const p2 = to.lat * Math.PI / 180;
  const dl = (to.lon - from.lon) * Math.PI / 180;
  return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
}
