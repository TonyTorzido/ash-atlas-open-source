import { afterEach, describe, expect, it, vi } from "vitest";

import {
  moveToward,
  type ClassSnapshot,
  type EquipmentSnapshot,
  type LatLon
} from "@ash-atlas/shared";

import { CombatEngine } from "./combatEngine.js";

const origin = { lat: 35.0844, lon: -106.6504 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Warrior authoritative combat runtime", () => {
  it("keeps class and PvE combat state private in recipient snapshots and deltas", () => {
    const engine = setup(100);
    const mob = engine.spawnMob({
      archetype: "goblin",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.startAttack(request("warrior", mob.entityId, "private-state"));

    const ownerView = engine.snapshotForPlayer("warrior").upserts.find(
      (entity) => entity.entityId === "warrior"
    );
    const remoteView = engine.snapshotForPlayer("enemy").upserts.find(
      (entity) => entity.entityId === "warrior"
    );
    expect(ownerView?.classCombat).not.toBeNull();
    expect(ownerView?.pveCombat).not.toBeNull();
    expect(remoteView).toMatchObject({ classCombat: null, pveCombat: null });

    engine.beginDeltaFlush();
    engine.updatePlayerPveStats("warrior", {
      level: 25,
      maxHealth: 100,
      attackPower: 12,
      defense: 1
    });
    const delta = engine.deltaForPlayer("enemy", engine.beginDeltaFlush());
    expect(delta?.upserts.find((entity) => entity.entityId === "warrior"))
      .toMatchObject({ classCombat: null, pveCombat: null });
  });

  it("decays Warden Guard by eight per second out of combat and clears it for non-Wardens", () => {
    const warden = setup(0, [], [], { subclassId: "warden", guard: 50 });
    for (let tick = 0; tick < 20; tick += 1) warden.tick();
    expect(warden.entity("warrior")?.classCombat?.guard).toBe(42);

    const reaver = setup(0, [], [], { subclassId: "reaver", guard: 50 });
    expect(reaver.entity("warrior")?.classCombat?.guard).toBe(0);
  });

  it("increments combat generation once per PvE session, not on focus repair or switch", () => {
    const engine = setup(0);
    const first = engine.spawnMob({
      archetype: "goblin", position: east(8), regionCode: "NM", zoneId: "world:NM"
    });
    const second = engine.spawnMob({
      archetype: "goblin", position: east(10), regionCode: "NM", zoneId: "world:NM"
    });
    engine.startAttack(request("warrior", first.entityId, "generation-one"));
    engine.startAttack(request("warrior", second.entityId, "focus-switch"));
    expect(engine.peekDirtyClassRuntimes().find((entry) => entry.playerId === "warrior")?.combatGeneration)
      .toBe(1);

    engine.cancelCombat("warrior");
    engine.startAttack(request("warrior", first.entityId, "generation-two"));
    expect(engine.peekDirtyClassRuntimes().find((entry) => entry.playerId === "warrior")?.combatGeneration)
      .toBe(2);
  });

  it("restores the newly active class cooldowns and advances generation on class switches", () => {
    const engine = setup(0);
    const initialSnapshot = switchSnapshot("warrior", {});
    initialSnapshot.loadout = {
      ...initialSnapshot.loadout,
      normalActives: ["warrior_empowered_hit", null]
    };
    engine.updatePlayerClassState("warrior", initialSnapshot, equipment("warrior"), {
      version: 40,
      activeClassId: "warrior",
      rage: 0,
      rageReserved: 0,
      queuedAbilityId: null,
      queuedTargetEntityId: null,
      queuedAtTick: null,
      cooldownEndsAt: {},
      statusEffects: [
        persistedEffect("external-protection", "party-knight", "knight_brace"),
        persistedEffect("self-cleave-effect", "warrior", "warrior_empowered_hit")
      ],
      counters: {},
      combatGeneration: 0,
      lastCombatAt: null
    });
    expect(engine.peekDirtyClassRuntimes().find((entry) => entry.playerId === "warrior")?.version)
      .toBe(41);
    const hunterCooldown = Date.now() + 5_000;
    engine.updatePlayerClassState(
      "warrior",
      switchSnapshot("hunter", { hunter_sweep: hunterCooldown }),
      equipment("warrior")
    );
    expect(engine.entity("warrior")?.classCombat?.cooldownEndsAt).toEqual({ hunter_sweep: hunterCooldown });
    expect(engine.peekDirtyClassRuntimes().find((entry) => entry.playerId === "warrior")?.statusEffects)
      .toEqual([persistedEffect("external-protection", "party-knight", "knight_brace")]);
    expect(engine.peekDirtyClassRuntimes().find((entry) => entry.playerId === "warrior")?.combatGeneration)
      .toBe(1);
    expect(engine.peekDirtyClassRuntimes().find((entry) => entry.playerId === "warrior")?.version)
      .toBe(43);

    const warriorCooldown = Date.now() + 10_000;
    engine.updatePlayerClassState(
      "warrior",
      switchSnapshot("warrior", { warrior_empowered_hit: warriorCooldown }),
      equipment("warrior")
    );
    expect(engine.entity("warrior")?.classCombat?.cooldownEndsAt).toEqual({ warrior_empowered_hit: warriorCooldown });
    expect(engine.peekDirtyClassRuntimes().find((entry) => entry.playerId === "warrior")?.combatGeneration)
      .toBe(2);
    expect(engine.peekDirtyClassRuntimes().find((entry) => entry.playerId === "warrior")?.version)
      .toBe(45);
  });

  it("resets only the connected player's class ability and Taunt cooldowns", () => {
    const engine = setup(0);
    const enemySnapshot = switchSnapshot("warrior", { enemy_ability: 88_000 });
    enemySnapshot.playerId = "enemy";
    engine.updatePlayerClassState("enemy", enemySnapshot, equipment("enemy"), {
      rage: 0, rageReserved: 0, queuedAbilityId: null, queuedTargetEntityId: null,
      queuedAtTick: null, cooldownEndsAt: { enemy_ability: 88_000 }, statusEffects: [],
      counters: {}, combatGeneration: 0, lastCombatAt: null
    });
    type MutableRuntime = {
      cooldownEndsAt: Record<string, number>;
      counters: Record<string, number | string | boolean>;
      effects: Array<Record<string, unknown>>;
      queuedAbility: Record<string, unknown> | null;
    };
    type MutableCombatant = { tauntCooldownEndsAt: number; classRuntime: MutableRuntime | null };
    const entities = (engine as unknown as { entities: Map<string, MutableCombatant> }).entities;
    const player = entities.get("warrior")!;
    const runtime = player.classRuntime!;
    entities.get("enemy")!.classRuntime!.cooldownEndsAt = { enemy_ability: 88_000 };
    runtime.cooldownEndsAt = {
      warrior_v2_sundering_arc: 50_000,
      warrior_v2_worldbreaker: 60_000,
      basic_attack_reset: 70_000,
      universal_taunt: 80_000
    };
    player.tauntCooldownEndsAt = 80_000;
    runtime.queuedAbility = {
      abilityId: "warrior_v2_sundering_arc", targetEntityId: null,
      queuedAtTick: 4, reservedRage: 0, activationCommitted: true
    };
    runtime.counters.passiveInternalCooldown = 90_000;
    runtime.effects.push({
      id: "preserved-buff", kind: "flat_attack", sourceTechniqueId: "preserved",
      sourceEntityId: "warrior", startTick: 0, endTick: 999, nextTick: 999,
      stacks: 1, maximumStacks: 1, amount: 2
    });
    const queueBefore = runtime.queuedAbility;
    const effectsBefore = runtime.effects;

    engine.beginDeltaFlush();
    expect(engine.resetPlayerClassAbilityCooldowns("warrior")).toBe(true);
    expect(runtime.cooldownEndsAt).toEqual({});
    expect(player.tauntCooldownEndsAt).toBe(0);
    expect(runtime.queuedAbility).toBe(queueBefore);
    expect(runtime.counters.passiveInternalCooldown).toBe(90_000);
    expect(runtime.effects).toBe(effectsBefore);
    expect(entities.get("enemy")!.classRuntime!.cooldownEndsAt).toEqual({ enemy_ability: 88_000 });
    expect(engine.beginDeltaFlush().dirtyEntityIds).toContain("warrior");
    expect(engine.peekDirtyClassRuntimes().find((entry) => entry.playerId === "warrior"))
      .toMatchObject({ cooldownEndsAt: {}, queuedAbilityId: "warrior_v2_sundering_arc" });
    expect(engine.resetPlayerClassAbilityCooldowns("missing")).toBe(false);
  });
});

type SetupOptions = {
  passives?: string[];
  subclassId?: "reaver" | "warden";
  currentHealth?: number;
  maxHealth?: number;
  legacyIds?: string[];
  guard?: number;
};

function setup(
  rage: number,
  resetActives: string[] = [],
  normalActives: string[] = [],
  options: SetupOptions = {}
): CombatEngine {
  const engine = new CombatEngine({ tickRateHz: 20, playerMovementSpeedMps: 40, isPlayerAuthorityActive: () => true });
  addPlayer(engine, "warrior", origin, options.currentHealth ?? 100, options.maxHealth ?? 100);
  addPlayer(engine, "enemy", east(10));
  const snapshot: ClassSnapshot = {
    playerId: "warrior",
    characterLevel: 25,
    activeClassId: "warrior",
    activeSubclassId: options.subclassId ?? null,
    warrior: { classId: "warrior", level: 25, xp: 38_000, nextLevelXp: null, completedAt: null },
    subclasses: [
      { subclassId: "reaver", unlocked: options.subclassId === "reaver" },
      { subclassId: "warden", unlocked: options.subclassId === "warden" }
    ],
    loadout: {
      resetActives: [resetActives[0] ?? null, resetActives[1] ?? null],
      normalActives: [normalActives[0] ?? null, normalActives[1] ?? null],
      passiveTiers: [
        options.passives?.[0] ?? null,
        options.passives?.[1] ?? null,
        options.passives?.[2] ?? null
      ],
      ultimateActive: null
    },
    legacyIds: options.legacyIds ?? [], rage, maximumRage: 100, queuedAbility: null, cooldownEndsAt: {},
    serverTime: Date.now(), revision: 1
  };
  engine.updatePlayerClassState("warrior", snapshot, equipment("warrior"), {
    rage, rageReserved: 0, queuedAbilityId: null, queuedTargetEntityId: null, queuedAtTick: null,
    cooldownEndsAt: {}, statusEffects: [], counters: { guard: options.guard ?? 0 }, combatGeneration: 0,
    lastCombatAt: options.guard ? Date.now() : null
  });
  return engine;
}

function addPlayer(
  engine: CombatEngine,
  playerId: string,
  position: LatLon,
  currentHealth = 100,
  maxHealth = 100
): void {
  engine.connectPlayer({
    playerId, name: playerId, regionCode: "NM", zoneId: "world:NM", position,
    accountId: `account-${playerId}`, connectionId: `connection-${playerId}`,
    profile: { playerId, maxHealth, currentHealth, baseAttackDamage: 10 }
  });
}

function equipment(playerId: string): EquipmentSnapshot {
  return {
    playerId, instances: [], chest: null, totalAttackPowerBonus: 2, totalDefenseBonus: 0,
    weapon: {
      instanceId: "00000000-0000-4000-8000-000000000001", definitionId: "starter_sword",
      displayName: "Starter Sword", ownerPlayerId: playerId, location: "equipped", equippedSlot: "weapon",
      attackPowerBonus: 2, defenseBonus: 0, weaponCategory: "sword", armorCategory: null, twoHanded: false,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
    }
  };
}

function switchSnapshot(
  activeClassId: "warrior" | "hunter",
  cooldownEndsAt: Record<string, number>
): ClassSnapshot {
  const warrior = { classId: "warrior" as const, level: 25, xp: 38_000, nextLevelXp: null, completedAt: null };
  const hunter = { classId: "hunter" as const, level: 25, xp: 38_000, nextLevelXp: null, completedAt: null };
  const hunterActive = activeClassId === "hunter";
  return {
    playerId: "warrior",
    characterLevel: 25,
    activeClassId,
    activeSubclassId: null,
    warrior,
    hunter,
    classes: [warrior, hunter],
    subclasses: [],
    loadout: {
      resetActives: [null, null],
      normalActives: [hunterActive ? "hunter_sweep" : "warrior_empowered_hit", null],
      passiveTiers: [null, null, null], ultimateActive: null
    },
    resource: {
      classId: activeClassId,
      resourceId: hunterActive ? "focus" : "rage",
      displayName: hunterActive ? "Focus" : "Rage",
      current: hunterActive ? 100 : 0,
      maximum: 100,
      reserved: 0,
      updatedAt: new Date(0).toISOString()
    },
    legacyIds: [],
    rage: 0,
    maximumRage: 100,
    queuedAbility: null,
    cooldownEndsAt,
    serverTime: Date.now(),
    revision: 1
  };
}

function persistedEffect(id: string, sourceEntityId: string, sourceTechniqueId: string) {
  return {
    id,
    kind: "incoming_mitigation",
    sourceTechniqueId,
    sourceEntityId,
    startTick: 0,
    endTick: 1_000,
    nextTick: 1_000,
    stacks: 1,
    maximumStacks: 1,
    amount: 0.1
  };
}

function request(attackerId: string, targetEntityId: string, requestId: string) {
  return { attackerId, targetEntityId, requestId, accountId: `account-${attackerId}`, connectionId: `connection-${attackerId}` };
}

function east(distanceM: number): LatLon {
  return moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, distanceM);
}
