import { describe, expect, it } from "vitest";

import {
  moveToward,
  type ClassSnapshot,
  type EquipmentSnapshot,
  type LatLon
} from "@ash-atlas/shared";

import { CombatEngine } from "./combatEngine.js";
import {
  combatBalanceSummarySchema,
  type CombatBalanceSummary
} from "./combatTelemetry.js";

const ORIGIN: LatLon = { lat: 35.0844, lon: -106.6504 };

describe("CombatEngine aggregate telemetry integration", () => {
  it("emits one valid, nonempty, logical-time summary from a completed real session", () => {
    const summaries: CombatBalanceSummary[] = [];
    const engine = new CombatEngine({
      tickRateHz: 20,
      playerMovementSpeedMps: 40,
      isPlayerAuthorityActive: () => true,
      onCombatSummary: (summary) => summaries.push(summary)
    });
    addWarrior(engine, 40);
    const mob = engine.spawnMob({
      archetype: "goblin",
      // Keep the pre-matrix 100 HP Goblin so the session spans several exchanges.
      maxHealthMultiplier: 100 / 40,
      position: east(8),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.startAttack(request(mob.entityId));

    const replicated = JSON.stringify(engine.entity("telemetry-player"));
    expect(replicated).not.toContain("actionTrace");
    expect(replicated).not.toContain("mitigationBySource");
    expect(replicated).not.toContain("combatEndReason");
    expect(replicated).not.toContain("telemetryStartedAt");

    for (let tick = 0; tick < 100 && summaries.length === 0; tick += 1) engine.tick();
    expect(summaries).toHaveLength(1);
    const summary = combatBalanceSummarySchema.parse(summaries[0]);
    expect(summary.durationMs).toBeGreaterThan(0);
    expect(summary.durationMs % 50).toBe(0);
    expect(summary.combatEndReason).toBe("enemies_defeated");
    expect(summary.playerSurvived).toBe(true);
    expect(summary.enemiesDefeated).toBe(1);
    expect(summary.playerActionCount).toBeGreaterThan(0);
    expect(summary.enemyActionCount).toBeGreaterThan(0);
    expect(summary.damageBySource.warrior_basic_attack).toBe(mob.maxHealth);
    expect(summary.damageReceived).toBeGreaterThan(0);
    expect(summary.rageGenerated).toBe(0);
    expect(summary.initialEnemyQueueSize).toBe(0);
    expect(summary.maximumEnemyQueueSize).toBe(1);
    expect(summary.queueInsertions).toBe(1);
    expect(summary.queueRemovals).toBe(1);

    for (let tick = 0; tick < 20; tick += 1) engine.tick();
    engine.cancelCombat("telemetry-player");
    expect(summaries).toHaveLength(1);
  });

  it("finishes cancellation once without exposing aggregate state in snapshots", () => {
    const summaries: CombatBalanceSummary[] = [];
    const engine = new CombatEngine({
      tickRateHz: 20,
      playerMovementSpeedMps: 40,
      isPlayerAuthorityActive: () => true,
      onCombatSummary: (summary) => summaries.push(summary)
    });
    addWarrior(engine, 10);
    const mob = engine.spawnMob({
      archetype: "ogre",
      position: east(8),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.startAttack(request(mob.entityId));
    engine.tick(); // Claim through a landed hit before cancelling.
    expect(engine.cancelCombat("telemetry-player")).toBe(true);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      combatEndReason: "cancelled",
      durationMs: 50,
      playerSurvived: true,
      initialEnemyQueueSize: 0,
      maximumEnemyQueueSize: 1,
      queueInsertions: 1,
      queueRemovals: 1
    });
    expect(JSON.stringify(engine.entity("telemetry-player"))).not.toContain("actionTrace");

    engine.disconnectPlayer("telemetry-player");
    expect(summaries).toHaveLength(1);
  });

  it("captures a Taunt-created session after the full deterministic candidate batch", () => {
    const summaries: CombatBalanceSummary[] = [];
    const engine = new CombatEngine({
      tickRateHz: 20,
      playerMovementSpeedMps: 40,
      isPlayerAuthorityActive: () => true,
      onCombatSummary: (summary) => summaries.push(summary)
    });
    addWarrior(engine, 10);
    const knight = classSnapshot();
    knight.activeClassId = "knight";
    knight.classes = [{ classId: "knight", level: 3, xp: 4_257, nextLevelXp: 6_212, completedAt: null }];
    knight.loadout = { resetActives: [null, null], normalActives: ["knight_taunt", null], passiveTiers: [null, null, null], ultimateActive: null };
    engine.updatePlayerClassState("telemetry-player", knight, equipment());
    for (const distanceM of [5, 7, 9]) {
      engine.spawnMob({
        archetype: "goblin",
        position: east(distanceM),
        regionCode: "NM",
        zoneId: "world:NM"
      });
    }

    const result = engine.useUniversalTaunt({
      playerId: "telemetry-player",
      accountId: "account-telemetry-player",
      connectionId: "connection-telemetry-player"
    });
    expect(result.pveCombat?.enemyQueue).toHaveLength(3);
    expect(engine.cancelCombat("telemetry-player")).toBe(true);
    engine.clearMobs();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      initialEnemyQueueSize: 3,
      maximumEnemyQueueSize: 3,
      queueInsertions: 3,
      tauntUses: 1,
      tauntEligibleCandidates: 3,
      tauntEnemiesAdded: 3,
      tauntEnemiesExcludedByCap: 0
    });
  });
});

function addWarrior(engine: CombatEngine, damage: number): void {
  engine.connectPlayer({
    playerId: "telemetry-player",
    name: "Telemetry Player",
    regionCode: "NM",
    zoneId: "world:NM",
    position: ORIGIN,
    accountId: "account-telemetry-player",
    connectionId: "connection-telemetry-player",
    profile: {
      playerId: "telemetry-player",
      level: 25,
      maxHealth: 220,
      currentHealth: 220,
      baseAttackDamage: damage,
      defense: 7
    }
  });
  engine.updatePlayerClassState(
    "telemetry-player",
    classSnapshot(),
    equipment(),
    {
      rage: 0,
      rageReserved: 0,
      queuedAbilityId: null,
      queuedTargetEntityId: null,
      queuedAtTick: null,
      cooldownEndsAt: {},
      statusEffects: [],
      counters: {},
      combatGeneration: 0,
      lastCombatAt: null
    }
  );
}

function classSnapshot(): ClassSnapshot {
  return {
    playerId: "telemetry-player",
    characterLevel: 25,
    activeClassId: "warrior",
    activeSubclassId: null,
    warrior: { classId: "warrior", level: 25, xp: 38_000, nextLevelXp: null, completedAt: null },
    subclasses: [
      { subclassId: "reaver", unlocked: false },
      { subclassId: "warden", unlocked: false }
    ],
    loadout: {
      resetActives: [null, null],
      normalActives: ["warrior_empowered_hit", "warrior_anger_explosion"],
      passiveTiers: ["warrior_heavy_handed", "warrior_relentless", "warrior_last_stand"], ultimateActive: null
    },
    legacyIds: [],
    rage: 0,
    maximumRage: 100,
    queuedAbility: null,
    cooldownEndsAt: {},
    serverTime: 0,
    revision: 1
  };
}

function equipment(): EquipmentSnapshot {
  const createdAt = new Date(0).toISOString();
  return {
    playerId: "telemetry-player",
    instances: [],
    weapon: {
      instanceId: "00000000-0000-4000-8000-000000000001",
      definitionId: "starter_sword",
      displayName: "Starter Sword",
      ownerPlayerId: "telemetry-player",
      location: "equipped",
      equippedSlot: "weapon",
      attackPowerBonus: 2,
      defenseBonus: 0,
      weaponCategory: "sword",
      armorCategory: null,
      twoHanded: false,
      createdAt,
      updatedAt: createdAt
    },
    chest: null,
    totalAttackPowerBonus: 2,
    totalDefenseBonus: 0
  };
}

function request(targetEntityId: string) {
  return {
    attackerId: "telemetry-player",
    targetEntityId,
    requestId: `request-${targetEntityId}`,
    accountId: "account-telemetry-player",
    connectionId: "connection-telemetry-player"
  };
}

function east(distanceM: number): LatLon {
  return moveToward(ORIGIN, { lat: ORIGIN.lat, lon: ORIGIN.lon + 0.02 }, distanceM);
}
