import { BASIC_ATTACK_INTERVAL_MS, destinationPoint, distanceMeters, type LatLon } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";
import type { CombatEngine } from "./combatEngine.js";
import { companionBaseHealthFromRuntime, PetCompanionRuntime } from "./petCompanionRuntime.js";
import type { ActivePet } from "../petService.js";

type HarnessEntity = {
  entityId: string;
  kind: "player" | "mob";
  lifeState: "alive" | "downed" | "dead";
  targetEntityId: string | null;
  lat: number;
  lon: number;
  regionCode: string;
  zoneId: string;
  npcFaction?: null;
  companion?: { ownerPlayerId: string; dogId: string; species: string; mode: string } | null;
};

const PET = "pet-companion:dog-1";

describe("PetCompanionRuntime", () => {
  it("converts scaled runtime health back to base persistence units", () => {
    expect(companionBaseHealthFromRuntime({ currentHealth: 85, maxHealth: 170, baseMaxHealth: 100 })).toBe(50);
  });

  it("roams loosely a few hundred metres off, drifts after a walking owner and never glues to them", () => {
    const harness = createHarness();
    harness.runtime.summon("player-1", dog(), 0);
    let now = 0;
    const walking: number[] = [];
    let walkPrevious = { ...harness.entities.get(PET)! };
    let walkMaxStep = 0;
    // Owner walks 500 m east at 5 m/s.
    for (let step = 1; step <= 1_000; step += 1) {
      now += 100;
      Object.assign(harness.owner, destinationPoint(harness.owner, 0.5, 90));
      harness.runtime.update("player-1", now);
      const current = harness.entities.get(PET)!;
      walkMaxStep = Math.max(walkMaxStep, distanceMeters(walkPrevious, current));
      walkPrevious = { ...current };
      walking.push(distanceMeters(current, harness.owner));
    }
    // One constant speed (the owner's 5 m/s): never more than 0.5 m per 100 ms update.
    expect(walkMaxStep).toBeLessThanOrEqual(0.51);
    expect(Math.max(...walking)).toBeLessThanOrEqual(240);
    expect(Math.min(...walking.slice(100))).toBeGreaterThanOrEqual(25);
    // Owner idles 60 s: the pet keeps roaming calmly inside its area.
    const idle: number[] = [];
    let maxStep = 0;
    let previous = { ...harness.entities.get(PET)! };
    for (let tick = 0; tick < 600; tick += 1) {
      now += 100;
      harness.runtime.update("player-1", now);
      const current = harness.entities.get(PET)!;
      maxStep = Math.max(maxStep, distanceMeters(previous, current));
      previous = { ...current };
      idle.push(distanceMeters(current, harness.owner));
    }
    expect(Math.max(...idle)).toBeLessThanOrEqual(220);
    expect(maxStep).toBeLessThanOrEqual(0.51);
  });

  it("does not run away when the owner walks up to it", () => {
    const harness = createHarness();
    harness.runtime.summon("player-1", dog(), 0);
    let now = 0;
    for (let tick = 0; tick < 300; tick += 1) { now += 100; harness.runtime.update("player-1", now); }
    const petAt = { ...harness.entities.get(PET)! };
    // Owner walks straight to the pet at 5 m/s and stands beside it for 40 s.
    while (distanceMeters(harness.owner, petAt) > 3) {
      now += 100;
      const step = Math.min(0.5, distanceMeters(harness.owner, petAt));
      Object.assign(harness.owner, destinationPoint(harness.owner, step, bearingTo(harness.owner, petAt)));
      harness.runtime.update("player-1", now);
      expect(distanceMeters(harness.entities.get(PET)!, harness.owner)).toBeLessThanOrEqual(distanceMeters(petAt, harness.owner) + 160);
    }
    const settledAt = { ...harness.entities.get(PET)! };
    for (let tick = 0; tick < 400; tick += 1) { now += 100; harness.runtime.update("player-1", now); }
    expect(distanceMeters(harness.entities.get(PET)!, settledAt)).toBe(0);
  });

  it("reappears in its roam area after a teleport", () => {
    const harness = createHarness();
    harness.runtime.summon("player-1", dog(), 0);
    Object.assign(harness.owner, destinationPoint(harness.owner, 5_000, 45));
    harness.revision += 1;
    harness.runtime.update("player-1", 100);
    const separation = distanceMeters(harness.entities.get(PET)!, harness.owner);
    expect(separation).toBeGreaterThanOrEqual(35);
    expect(separation).toBeLessThanOrEqual(95);
  });

  it("travels with its owner on a jump even when staying, and keeps staying where it lands", () => {
    for (const bumpRevision of [true, false]) {
      const harness = createHarness();
      harness.runtime.summon("player-1", dog(), 0);
      harness.runtime.update("player-1", 100);
      expect(harness.runtime.command("player-1", "dog-1", "stay", 100)).toBe(true);
      Object.assign(harness.owner, destinationPoint(harness.owner, 40_000, 200));
      // A flag jump bumps the relocation revision; a position that lands first must still count.
      if (bumpRevision) harness.revision += 1;
      harness.runtime.update("player-1", 200);
      expect(distanceMeters(harness.entities.get(PET)!, harness.owner)).toBeLessThanOrEqual(95);
      expect(harness.entities.get(PET)!.companion?.mode).toBe("sit");
      expect(harness.runtime.stayAt("player-1")).toBeNull();
      const landed = { ...harness.entities.get(PET)! };
      for (let tick = 1; tick <= 100; tick += 1) {
        Object.assign(harness.owner, destinationPoint(harness.owner, 0.5, 90));
        harness.runtime.update("player-1", 200 + tick * 100);
      }
      expect(distanceMeters(harness.entities.get(PET)!, landed)).toBe(0);
    }
  });

  it("Stay holds exactly where it is until Follow", () => {
    const harness = createHarness();
    harness.runtime.summon("player-1", dog(), 0);
    expect(harness.runtime.command("player-1", "dog-1", "stay", 0)).toBe(true);
    const held = { ...harness.entities.get(PET)! };
    for (let tick = 1; tick <= 1_200; tick += 1) {
      Object.assign(harness.owner, destinationPoint(harness.owner, 0.5, 90));
      harness.runtime.update("player-1", 100 + tick * 100);
    }
    expect(distanceMeters(harness.owner, held)).toBeGreaterThan(500);
    expect(distanceMeters(harness.entities.get(PET)!, held)).toBe(0);
    expect(harness.runtime.command("player-1", "dog-1", "follow", 200_000)).toBe(true);
    harness.runtime.update("player-1", 200_200);
    expect(distanceMeters(harness.entities.get(PET)!, held)).toBeGreaterThan(0);
  });

  it("joins the owner's fight on the uniform basic attack cadence and goes back to roaming after", () => {
    const harness = createHarness();
    harness.combat.generalSkillRank.mockReturnValue(2);
    harness.combat.applyScriptedDamage.mockReturnValue(1);
    const mob: HarnessEntity = { entityId: "mob-1", kind: "mob", lifeState: "alive", targetEntityId: null, ...destinationPoint(harness.owner, 200, 0), regionCode: "r", zoneId: "z", companion: null, npcFaction: null };
    harness.entities.set("mob-1", mob);
    harness.runtime.summon("player-1", { ...dog(), health: 50 }, 0);
    expect(harness.combat.spawnMob.mock.calls[0]?.[0].companion).toMatchObject({ maxHealth: 145, currentHealth: 73 });
    let now = 0;
    for (let tick = 0; tick < 30; tick += 1) { now += 100; harness.runtime.update("player-1", now); }
    expect(harness.combat.applyScriptedDamage).not.toHaveBeenCalled();
    harness.owner.targetEntityId = "mob-1";
    for (let tick = 0; tick < 400 && !harness.combat.applyScriptedDamage.mock.calls.length; tick += 1) {
      now += 100; harness.runtime.update("player-1", now);
    }
    expect(harness.combat.applyScriptedDamage).toHaveBeenCalledWith("player-1", "mob-1", 10, "pet_companion_assist", PET);
    expect(harness.combat.healEntity).toHaveBeenCalledWith("player-1", 4, PET);
    const firstHitAt = now;
    harness.combat.applyScriptedDamage.mockClear();
    while (now < firstHitAt + BASIC_ATTACK_INTERVAL_MS - 100) { now += 100; harness.runtime.update("player-1", now); }
    expect(harness.combat.applyScriptedDamage).not.toHaveBeenCalled();
    now += 100; harness.runtime.update("player-1", now);
    expect(harness.combat.applyScriptedDamage).toHaveBeenCalledTimes(1);
    mob.lifeState = "dead";
    const before = { ...harness.entities.get(PET)! };
    for (let tick = 0; tick < 200; tick += 1) { now += 100; harness.runtime.update("player-1", now); }
    expect(distanceMeters(harness.entities.get(PET)!, before)).toBeGreaterThan(5);
    expect(distanceMeters(harness.entities.get(PET)!, harness.owner)).toBeLessThanOrEqual(170);
  });

  it("sends the pet home when its timer ends and when the owner enters a dungeon", () => {
    const expired = vi.fn();
    const sentHome = vi.fn();
    const harness = createHarness({ onExpired: expired, onSentHome: sentHome });
    harness.runtime.summon("player-1", { ...dog(), activeUntilMs: 5_000 }, 0);
    harness.runtime.update("player-1", 4_900);
    expect(harness.combat.despawnMob).not.toHaveBeenCalled();
    harness.runtime.update("player-1", 5_000);
    expect(expired).toHaveBeenCalledWith("player-1", "dog-1");
    expect(harness.runtime.activePetId("player-1")).toBeNull();

    harness.runtime.summon("player-1", dog(), 6_000);
    harness.owner.regionCode = "interior:dungeon:fangrock:player:player-1";
    harness.runtime.update("player-1", 6_100);
    expect(sentHome).toHaveBeenCalledWith("player-1", "dog-1");
    expect(harness.runtime.activePetId("player-1")).toBeNull();
    harness.runtime.summon("player-1", dog(), 7_000);
    expect(harness.runtime.activePetId("player-1")).toBeNull();
  });

  it("sends the pet home to rest when its owner dies", () => {
    const ownerDefeated = vi.fn();
    const harness = createHarness({ onOwnerDefeated: ownerDefeated });
    harness.runtime.summon("player-1", dog(), 0);
    harness.owner.lifeState = "downed";
    harness.runtime.update("player-1", 100);
    expect(ownerDefeated).toHaveBeenCalledWith("player-1", "dog-1");
    expect(harness.runtime.activePetId("player-1")).toBeNull();
    expect(harness.combat.despawnMob).toHaveBeenCalledWith(PET);
  });

  it("comes to defend its owner when a monster attacks them", () => {
    const harness = createHarness();
    harness.combat.applyScriptedDamage.mockReturnValue(1);
    const attacker: HarnessEntity = { entityId: "mob-2", kind: "mob", lifeState: "alive", targetEntityId: "player-1", ...destinationPoint(harness.owner, 5, 0), regionCode: "r", zoneId: "z", companion: null, npcFaction: null };
    harness.entities.set("mob-2", attacker);
    harness.combat.nearbyEntityIds.mockReturnValue(["mob-2"]);
    harness.runtime.summon("player-1", dog(), 0);
    let now = 0;
    for (let tick = 0; tick < 400 && !harness.combat.applyScriptedDamage.mock.calls.length; tick += 1) {
      now += 100; harness.runtime.update("player-1", now);
    }
    expect(harness.combat.applyScriptedDamage).toHaveBeenCalledWith("player-1", "mob-2", 10, "pet_companion_assist", PET);
  });

  it("rescales max health when Companion Bond changes", () => {
    const harness = createHarness();
    harness.runtime.summon("player-1", dog(), 0);
    harness.combat.generalSkillRank.mockReturnValue(3);
    harness.runtime.update("player-1", 100);
    expect(harness.combat.rescaleCompanionHealth).toHaveBeenCalledWith(PET, 1.75);
  });
});

function createHarness(input: {
  onExpired?: (owner: string, petId: string) => void;
  onSentHome?: (owner: string, petId: string) => void;
  onOwnerDefeated?: (owner: string, petId: string) => void;
} = {}) {
  const owner: HarnessEntity = { entityId: "player-1", kind: "player", lifeState: "alive", targetEntityId: null, lat: 0, lon: 0, regionCode: "r", zoneId: "z" };
  const entities = new Map<string, HarnessEntity>([[owner.entityId, owner]]);
  const combat = {
    entity: vi.fn((id: string) => entities.get(id) ?? null),
    playerMovementMultiplier: vi.fn(() => 1),
    generalSkillRank: vi.fn(() => 0),
    spawnMob: vi.fn((spawn: Parameters<CombatEngine["spawnMob"]>[0]) => {
      entities.set(spawn.entityId!, { entityId: spawn.entityId!, kind: "mob", lifeState: "alive", targetEntityId: null, ...spawn.position, regionCode: spawn.regionCode, zoneId: spawn.zoneId, companion: { ownerPlayerId: spawn.companion!.ownerPlayerId, dogId: spawn.companion!.dogId, species: spawn.companion!.species, mode: spawn.companion!.mode ?? "play" } });
    }),
    despawnMob: vi.fn((id: string) => entities.delete(id)),
    relocateCompanion: vi.fn((id: string, position: LatLon) => { Object.assign(entities.get(id)!, { lat: position.lat, lon: position.lon }); return true; }),
    setCompanionMode: vi.fn((id: string, mode: string) => { entities.get(id)!.companion!.mode = mode; return true; }),
    rescaleCompanionHealth: vi.fn(() => true),
    applyScriptedDamage: vi.fn(() => 0),
    petTacticsShare: vi.fn(() => 0),
    breakPetShadowHide: vi.fn(),
    canOwnerHarmPlayer: vi.fn(() => false),
    nearbyEntityIds: vi.fn((): string[] => []),
    healEntity: vi.fn(() => 0),
  };
  const harness = {
    revision: 0,
    runtime: undefined as unknown as PetCompanionRuntime,
    combat, entities, owner
  };
  harness.runtime = new PetCompanionRuntime(combat as unknown as CombatEngine, {
    ...(input.onExpired ? { onExpired: input.onExpired } : {}),
    ...(input.onSentHome ? { onSentHome: input.onSentHome } : {}),
    ...(input.onOwnerDefeated ? { onOwnerDefeated: input.onOwnerDefeated } : {}),
    playerBaseSpeedMps: 5,
    boundaryForOwner: () => ({ anchor: { lat: 0, lon: 0 }, radiusM: 650, revision: harness.revision }),
  });
  return harness;
}

function dog(): ActivePet {
  return {
    id: "dog-1", species: "trail_hound", name: "Milo", effectiveLevel: 0, unlockedAbilities: [],
    baseMaxHealth: 100, health: 100, damage: 10, defense: 0, activeUntilMs: Number.MAX_SAFE_INTEGER,
  };
}

function bearingTo(from: LatLon, to: LatLon): number {
  const p1 = from.lat * Math.PI / 180;
  const p2 = to.lat * Math.PI / 180;
  const dl = (to.lon - from.lon) * Math.PI / 180;
  return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
}
