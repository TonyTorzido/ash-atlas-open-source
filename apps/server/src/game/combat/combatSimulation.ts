import {
  CLASS_IDS,
  applyClassCombatStats,
  classDefinition,
  moveToward,
  playerPveStats,
  requireTechniqueDefinition,
  type ClassSnapshot,
  type ClassId,
  type ClassWeaponMode,
  type EquipmentInstance,
  type EquipmentSnapshot,
  type LatLon,
  type MobArchetypeKey,
  type SubclassId
} from "@ash-atlas/shared";

import { CombatEngine, CombatRequestError } from "./combatEngine.js";
import {
  combatSimulationReportJson,
  createCombatSimulationReport,
  type CombatSimulationReport,
  type CombatSimulationRun
} from "./combatSimulationReporter.js";
import {
  COMBAT_MITIGATION_SOURCES,
  COMBAT_TELEMETRY_SCHEMA_VERSION,
  combatBalanceSummarySchema,
  type CombatBalanceSummary
} from "./combatTelemetry.js";
import { packageIdForPosition, zoneIdForPosition } from "../spatialZones.js";

const TICK_RATE_HZ = 20;
const MAXIMUM_SIMULATION_SECONDS = 360;
const SIMULATION_EPOCH_MS = Date.UTC(2026, 0, 1);
const PLAYER_ID = "simulation-player";
const ORIGIN: LatLon = { lat: 35.0844, lon: -106.6504 };
const EXPECTED_CONTROLLER_REJECTIONS = new Set([
  "ABILITY_ACTIVATION_LOCKOUT", // The current brief activation lock is retried on a later driver tick.
  "ABILITY_COOLDOWN",
  "ABILITY_EQUIPMENT_REQUIRED",
  "SUBCLASS_WEAPON_REQUIRED",
  "ABILITY_TARGET_INVALID",
  "FORTIFY_ACTIVE",
  "FORTIFY_ALREADY_ACTIVE",
  "RAGE_INSUFFICIENT",
  "FOCUS_INSUFFICIENT",
  "RESET_TARGET_INVALID",
  "RESET_TARGET_OUT_OF_RANGE",
  "RESET_WINDOW_UNAVAILABLE"
]);

export type CombatSimulationScenarioId =
  | "one-normal"
  | "three-normal"
  | "five-normal"
  | "ten-weak"
  | "durable-boss"
  | "mixed-weak-strong";

export type CombatSimulationLoadoutId =
  | "tank" | "aggressive" | "balanced" | "reaver" | "warden"
  | "hunter-boss" | "hunter-pack" | "sharpshooter" | "stalker";

export type CombatSimulationScenario = {
  id: CombatSimulationScenarioId;
  label: string;
  enemies: readonly MobArchetypeKey[];
};

export type CombatSimulationLoadout = {
  id: CombatSimulationLoadoutId;
  label: string;
  classId: ClassId;
  weaponMode: ClassWeaponMode;
  subclassId: SubclassId | null;
  guaranteedTrait: string | null;
  resetActives: readonly string[];
  normalActives: readonly string[];
  passiveTiers: readonly string[];
};

export const COMBAT_SIMULATION_SCENARIOS: readonly CombatSimulationScenario[] = [
  { id: "one-normal", label: "1 normal Goblin", enemies: ["goblin"] },
  { id: "three-normal", label: "3 normal Goblins", enemies: ["goblin", "goblin", "goblin"] },
  {
    id: "five-normal",
    label: "5 normal Goblins",
    enemies: ["goblin", "goblin", "goblin", "goblin", "goblin"]
  },
  {
    id: "ten-weak",
    label: "10 weak Wolves",
    enemies: ["wolf", "wolf", "wolf", "wolf", "wolf", "wolf", "wolf", "wolf", "wolf", "wolf"]
  },
  { id: "durable-boss", label: "1 durable Ogre", enemies: ["ogre"] },
  {
    id: "mixed-weak-strong",
    label: "Mixed Wolves, Goblins, Bandits, Orc, and Ogre",
    enemies: ["wolf", "wolf", "goblin", "goblin", "bandit", "bandit", "orc_brute", "ogre"]
  }
] as const;

export const COMBAT_SIMULATION_LOADOUTS: readonly CombatSimulationLoadout[] = [
  {
    id: "tank",
    label: "Tank",
    classId: "warrior", weaponMode: "melee",
    subclassId: null,
    guaranteedTrait: null,
    resetActives: [],
    normalActives: ["warrior_concussive_blow", "warrior_battle_cry"],
    passiveTiers: ["warrior_bloodthirst", "warrior_crowd_fighter", "warrior_last_stand"]
  },
  {
    id: "aggressive",
    label: "Aggressive",
    classId: "warrior", weaponMode: "melee",
    subclassId: null,
    guaranteedTrait: null,
    resetActives: [],
    normalActives: ["warrior_empowered_hit", "warrior_anger_explosion"],
    passiveTiers: ["warrior_heavy_handed", "warrior_relentless", "warrior_desperate_fury"]
  },
  {
    id: "balanced",
    label: "Balanced",
    classId: "warrior", weaponMode: "melee",
    subclassId: null,
    guaranteedTrait: null,
    resetActives: [],
    normalActives: ["warrior_empowered_hit", "warrior_concussive_blow"],
    passiveTiers: ["warrior_heavy_handed", "warrior_crowd_fighter", "warrior_last_stand"]
  },
  {
    id: "reaver",
    label: "Reaver",
    classId: "warrior", weaponMode: "melee",
    subclassId: null,
    guaranteedTrait: null,
    resetActives: [],
    normalActives: ["warrior_anger_explosion", "warrior_concussive_blow"],
    passiveTiers: ["warrior_bloodthirst", "warrior_relentless", "warrior_desperate_fury"]
  },
  {
    id: "warden",
    label: "Warden",
    classId: "warrior", weaponMode: "melee",
    subclassId: null,
    guaranteedTrait: null,
    resetActives: [],
    normalActives: ["warrior_empowered_hit", "warrior_battle_cry"],
    passiveTiers: ["warrior_bloodthirst", "warrior_crowd_fighter", "warrior_last_stand"]
  },
  {
    id: "hunter-boss", label: "Hunter Boss", classId: "hunter", weaponMode: "ranged", subclassId: null,
    guaranteedTrait: null, resetActives: ["hunter_predators_strike", "hunter_marked_strike"],
    normalActives: ["hunter_sweep", "hunter_snare_trap"],
    passiveTiers: ["hunter_keen_focus", "hunter_lone_hunter", "hunter_killer_instinct"]
  },
  {
    id: "hunter-pack", label: "Hunter Pack", classId: "hunter", weaponMode: "melee", subclassId: null,
    guaranteedTrait: null, resetActives: ["hunter_predators_strike", "hunter_cull"],
    normalActives: ["hunter_sweep", "hunter_snare_trap"],
    passiveTiers: ["hunter_hardened_leathers", "hunter_pack_hunter", "hunter_patient_hunter"]
  },
  {
    id: "sharpshooter", label: "Sharpshooter", classId: "hunter", weaponMode: "ranged", subclassId: "sharpshooter",
    guaranteedTrait: "sharpshooter_steady_hand", resetActives: ["sharpshooter_deadeye_shot", "hunter_cull"],
    normalActives: ["hunter_sweep", "hunter_snare_trap"],
    passiveTiers: ["hunter_keen_focus", "hunter_lone_hunter", "hunter_killer_instinct"]
  },
  {
    id: "stalker", label: "Stalker", classId: "hunter", weaponMode: "melee", subclassId: "stalker",
    guaranteedTrait: "stalker_blood_scent", resetActives: ["stalker_rending_strike", "hunter_cull"],
    normalActives: ["hunter_sweep", "hunter_snare_trap"],
    passiveTiers: ["hunter_hardened_leathers", "hunter_pack_hunter", "hunter_patient_hunter"]
  }] as const;

export type CombatSimulationOutcome = CombatSimulationRun & {
  ticksElapsed: number;
  playerMaximumHealth: number;
  playerFinalHealth: number;
  initialEnemyHealth: number;
  enemyHealthRemaining: number;
  timedOut: boolean;
};

export type CombatSimulationSuite = {
  schemaVersion: typeof COMBAT_TELEMETRY_SCHEMA_VERSION;
  engine: "CombatEngine";
  tickRateHz: number;
  maximumSimulationSeconds: number;
  playerProfile: string;
  scenarios: readonly CombatSimulationScenario[];
  loadouts: readonly CombatSimulationLoadout[];
  runs: CombatSimulationOutcome[];
  report: CombatSimulationReport;
};

export type CombatSimulationOptions = {
  scenarios?: readonly CombatSimulationScenario[];
  loadouts?: readonly CombatSimulationLoadout[];
  maximumSimulationSeconds?: number;
};

export function runCombatSimulationSuite(options: CombatSimulationOptions = {}): CombatSimulationSuite {
  const scenarios = options.scenarios ?? COMBAT_SIMULATION_SCENARIOS;
  const loadouts = options.loadouts ?? COMBAT_SIMULATION_LOADOUTS;
  const maximumSimulationSeconds = options.maximumSimulationSeconds ?? MAXIMUM_SIMULATION_SECONDS;
  if (!Number.isFinite(maximumSimulationSeconds) || maximumSimulationSeconds <= 0) {
    throw new Error("maximum simulation duration must be positive");
  }

  const runs = scenarios.flatMap((scenario) =>
    loadouts.map((loadout) => runCombatSimulation(scenario, loadout, maximumSimulationSeconds))
  );
  const report = createCombatSimulationReport(runs);
  return {
    schemaVersion: COMBAT_TELEMETRY_SCHEMA_VERSION,
    engine: "CombatEngine",
    tickRateHz: TICK_RATE_HZ,
    maximumSimulationSeconds,
    playerProfile: "Level 25 Warrior and Hunter production profiles with compatible starter gear",
    scenarios,
    loadouts,
    runs,
    report
  };
}

export function runCombatSimulation(
  scenario: CombatSimulationScenario,
  loadout: CombatSimulationLoadout,
  maximumSimulationSeconds = MAXIMUM_SIMULATION_SECONDS
): CombatSimulationOutcome {
  const originalDateNow = Date.now;
  let simulatedNowMs = SIMULATION_EPOCH_MS;
  Date.now = () => simulatedNowMs;
  try {
    let completedSummary: CombatBalanceSummary | null = null;
    const engine = new CombatEngine({
      tickRateHz: TICK_RATE_HZ,
      playerMovementSpeedMps: 40,
      isPlayerAuthorityActive: () => true,
      onCombatSummary: (summary: CombatBalanceSummary) => {
        if (completedSummary) throw new Error("simulation emitted more than one combat summary");
        completedSummary = summary;
      }
    });
    const equipment = simulationEquipment(loadout);
    const classSnapshot = simulationClassSnapshot(loadout);
    const baseStats = playerPveStats(classSnapshot.characterLevel, {
      attackPower: equipment.totalAttackPowerBonus,
      defense: equipment.totalDefenseBonus
    });
    const stats = applyClassCombatStats(baseStats, classSnapshot, equipment);
    const definition = classDefinition(loadout.classId);
    engine.connectPlayer({
      playerId: PLAYER_ID,
      name: `Simulation ${definition.name}`,
      regionCode: packageIdForPosition(ORIGIN),
      zoneId: zoneIdForPosition(ORIGIN),
      position: ORIGIN,
      accountId: simulationAccountId(),
      connectionId: simulationConnectionId(),
      profile: {
        playerId: PLAYER_ID,
        level: classSnapshot.characterLevel,
        maxHealth: stats.maxHealth,
        currentHealth: stats.maxHealth,
        baseAttackDamage: stats.attackPower,
        defense: stats.defense
      }
    });
    engine.updatePlayerClassState(PLAYER_ID, classSnapshot, equipment, {
      activeClassId: loadout.classId,
      resourceId: definition.resourceId,
      resourceCurrent: definition.initialResource,
      resourceReserved: 0,
      rage: definition.initialResource,
      rageReserved: 0,
      queuedAbilityId: null,
      queuedTargetEntityId: null,
      queuedAtTick: null,
      cooldownEndsAt: {},
      statusEffects: [],
      counters: {},
      combatGeneration: 0,
      lastCombatAt: null
    });

    const enemies = scenario.enemies.map((archetype, index) =>
      engine.spawnMob({
        archetype,
        position: east(4 + index * 1.25),
        regionCode: packageIdForPosition(ORIGIN),
        zoneId: zoneIdForPosition(ORIGIN)
      })
    );
    if (enemies.length === 0) throw new Error(`simulation scenario ${scenario.id} has no enemies`);
    const initialEnemyHealth = enemies.reduce((total, enemy) => total + enemy.maxHealth, 0);
    engine.startAttack({
      attackerId: PLAYER_ID,
      targetEntityId: enemies[0]!.entityId,
      requestId: `simulation-start-${scenario.id}-${loadout.id}`,
      accountId: simulationAccountId(),
      connectionId: simulationConnectionId()
    });
    // An explicit diagnostic opening hit establishes every intended enemy through damage authority.
    for (const enemy of enemies) engine.applyScriptedDamage(PLAYER_ID, enemy.entityId, 1, "simulation_opening_hit");
    if (engine.entity(PLAYER_ID)?.pveCombat?.enemyQueue.length !== enemies.length) {
      throw new Error("Simulation opening failed to acquire the complete intended encounter");
    }

    const maximumTicks = Math.ceil(maximumSimulationSeconds * TICK_RATE_HZ);
    let ticksElapsed = 0;
    while (!completedSummary && ticksElapsed < maximumTicks) {
      driveClass(engine, loadout);
      if (completedSummary) break;
      engine.tick();
      ticksElapsed += 1;
      simulatedNowMs += 1_000 / TICK_RATE_HZ;
      engine.beginDeltaFlush();
    }
    const timedOut = completedSummary === null;
    if (timedOut) engine.cancelCombat(PLAYER_ID);
    if (!completedSummary) {
      throw new Error(`simulation ${scenario.id}/${loadout.id} ended without an aggregate summary`);
    }

    const summary = normalizeSimulationSummary(completedSummary, scenario.id, loadout.id);
    const player = engine.entity(PLAYER_ID);
    const enemyHealthRemaining = enemies.reduce(
      (total, enemy) => total + (engine.entity(enemy.entityId)?.currentHealth ?? 0),
      0
    );
    return {
      scenarioId: scenario.id,
      enemyProfile: scenario.label,
      enemyCount: scenario.enemies.length,
      loadoutId: loadout.id,
      summary,
      ticksElapsed,
      playerMaximumHealth: stats.maxHealth,
      playerFinalHealth: player?.currentHealth ?? 0,
      initialEnemyHealth,
      enemyHealthRemaining,
      timedOut
    };
  } finally {
    Date.now = originalDateNow;
  }
}

export function combatSimulationSuiteJson(suite: CombatSimulationSuite): string {
  const aggregateRuns = suite.runs.map((run) => {
    const { actionTrace, ...aggregateSummary } = run.summary;
    void actionTrace;
    return { ...run, summary: aggregateSummary };
  });
  return JSON.stringify({
    schemaVersion: suite.schemaVersion,
    engine: suite.engine,
    tickRateHz: suite.tickRateHz,
    maximumSimulationSeconds: suite.maximumSimulationSeconds,
    playerProfile: suite.playerProfile,
    scenarios: suite.scenarios,
    loadouts: suite.loadouts,
    runs: aggregateRuns,
    report: JSON.parse(combatSimulationReportJson(suite.report)) as unknown
  }, null, 2);
}

export function combatSimulationSuiteMarkdown(suite: CombatSimulationSuite): string {
  const mitigationHeaders = COMBAT_MITIGATION_SOURCES
    .map((source) => source.replaceAll("_", " "))
    .join(" | ");
  const mitigationAlignments = COMBAT_MITIGATION_SOURCES.map(() => "---:").join(" | ");
  const rows = suite.runs
    .slice()
    .sort((left, right) =>
      left.scenarioId.localeCompare(right.scenarioId) || left.loadoutId.localeCompare(right.loadoutId)
    )
    .map((run) => {
      const summary = run.summary;
      const damageDealt = sumMetric(summary.damageBySource);
      const mitigation = COMBAT_MITIGATION_SOURCES.map((source) => formatNumber(summary.mitigationBySource[source]));
      const resetUses = sumMetric(summary.resetStrikesByAbility);
      const defeatedAll = summary.enemiesDefeated === run.enemyCount;
      return [
        run.scenarioId,
        run.loadoutId,
        String(run.enemyCount),
        defeatedAll ? formatSeconds(summary.durationMs) : "n/a",
        formatNumber(damageDealt),
        formatNumber(summary.damageReceived),
        `${summary.primaryResourceId} ${formatNumber(summary.resourceGenerated)}/${formatNumber(summary.resourceSpent)}/${formatNumber(summary.resourceWastedAtCap)}`,
        ...mitigation,
        formatNumber(resetUses),
        summary.playerSurvived ? "yes" : "no",
        summary.combatEndReason
      ].join(" | ");
    });

  return [
    "# Deterministic PvE Combat Balance Summary",
    "",
    "This report is generated by driving the production `CombatEngine`; it does not reimplement damage, resources, healing, mitigation, queue rotation, cooldown, or ability formulas. Each run uses a Level 25 Warrior or Hunter with compatible starter gear and its canonical initial resource, opens on the first enemy, and uses authoritative Taunt to build the queue. The controller prioritizes damaging normal actives, uses solo support when health warrants it, and arms equipped next-attack empowers for the next scheduled basic attack; solo friendly support targets default to self.",
    "",
    `Simulation cadence: ${suite.tickRateHz} Hz. Per-run safety limit: ${suite.maximumSimulationSeconds} seconds. A time-to-defeat value is shown only when every enemy was defeated.`,
    "",
    "The active class resource is shown as generated/spent/wasted-at-cap. Mitigation columns are amounts prevented, attributed by the engine telemetry accumulator.",
    "",
    `| Scenario | Loadout | Enemies | TTD | Damage dealt | Damage received | Resource G/S/W | ${mitigationHeaders} | Reset uses | Survived | End reason |`,
    `| --- | --- | ---: | ---: | ---: | ---: | ---: | ${mitigationAlignments} | ---: | :---: | --- |`,
    ...rows.map((row) => `| ${row} |`),
    "",
    "## Coverage",
    "",
    ...suite.scenarios.map((scenario) => `- **${scenario.id}:** ${scenario.label}.`),
    "",
    ...suite.loadouts.map((loadout) => {
      const subclassTrait = loadout.guaranteedTrait ? `; inherent ${loadout.guaranteedTrait}` : "";
      return `- **${loadout.id}:** passives ${loadout.passiveTiers.join(", ")}; normals ${loadout.normalActives.join(", ")}; resets ${loadout.resetActives.join(", ")}${subclassTrait}.`;
    }),
    "",
    "Warrior, Hunter, and their representative subclasses are run against every scenario. These are deterministic development baselines, not assertions that a particular build must win or meet an exact tuning threshold."
  ].join("\n");
}

function driveClass(engine: CombatEngine, loadout: CombatSimulationLoadout): void {
  const player = engine.entity(PLAYER_ID);
  if (!player || player.lifeState !== "alive" || !player.pveCombat || !player.classCombat) return;
  if (!player.pveCombat.pendingResetAbilityId) {
    tryFirstAvailableAbility(engine, loadout.resetActives, true, player.classCombat.resource?.current ?? player.classCombat.rage);
  }
  // Current normal actions may activate between beats; the engine enforces lockout and cooldown.
  tryFirstAvailableAbility(engine, loadout.normalActives, false, player.classCombat.resource?.current ?? player.classCombat.rage);
}

function tryFirstAvailableAbility(
  engine: CombatEngine,
  abilityIds: readonly string[],
  reset: boolean,
  resource: number
): boolean {
  const player = engine.entity(PLAYER_ID);
  const cooldowns = player?.classCombat?.cooldownEndsAt ?? {};
  for (const abilityId of abilityIds) {
    const definition = requireTechniqueDefinition(abilityId);
    if (
      resource < definition.resourceCost ||
      (cooldowns[abilityId] ?? 0) > Date.now()
    ) continue;
    try {
      const target = simulationAbilityTarget(engine, definition.targetType ?? "hostile");
      if (reset) engine.useResetAbility({ ...authority(), abilityId, ...target });
      else engine.useNormalAbility({ ...authority(), abilityId, ...target });
      return true;
    } catch (error) {
      if (!(error instanceof CombatRequestError)) throw error;
      if (!EXPECTED_CONTROLLER_REJECTIONS.has(error.code)) throw error;
    }
  }
  return false;
}

function simulationAbilityTarget(
  engine: CombatEngine,
  targetType: "hostile" | "friendly" | "self" | "friendly_or_hostile"
): { targetEntityId?: string; targetMode?: "hostile" | "friendly" | "self" } {
  if (targetType === "self" || targetType === "friendly") {
    return { targetEntityId: PLAYER_ID, targetMode: "self" };
  }
  if (targetType === "friendly_or_hostile") {
    const player = engine.entity(PLAYER_ID);
    if (player && player.currentHealth / player.maxHealth <= 0.5) {
      return { targetEntityId: PLAYER_ID, targetMode: "self" };
    }
  }
  return {};
}

function simulationClassSnapshot(loadout: CombatSimulationLoadout): ClassSnapshot {
  const updatedAt = new Date(SIMULATION_EPOCH_MS).toISOString();
  const resources = CLASS_IDS.map((classId) => {
    const definition = classDefinition(classId);
    return {
      classId,
      resourceId: definition.resourceId,
      displayName: definition.resourceDisplayName,
      current: definition.initialResource,
      maximum: 100,
      reserved: 0,
      updatedAt
    };
  });
  return {
    playerId: PLAYER_ID,
    characterLevel: 25,
    activeClassId: loadout.classId,
    activeSubclassId: loadout.subclassId,
    warrior: { classId: "warrior", level: 25, xp: 38_000, nextLevelXp: null, completedAt: null },
    hunter: { classId: "hunter", level: 25, xp: 38_000, nextLevelXp: null, completedAt: null },
    classes: [
      { classId: "warrior", level: 25, xp: 38_000, nextLevelXp: null, completedAt: null },
      { classId: "hunter", level: 25, xp: 38_000, nextLevelXp: null, completedAt: null }
    ],
    subclasses: [
      { classId: "warrior", subclassId: "reaver", unlocked: loadout.subclassId === "reaver" },
      { classId: "warrior", subclassId: "warden", unlocked: loadout.subclassId === "warden" },
      { classId: "hunter", subclassId: "sharpshooter", unlocked: loadout.subclassId === "sharpshooter" },
      { classId: "hunter", subclassId: "stalker", unlocked: loadout.subclassId === "stalker" }
    ],
    selectedSubclasses: {
      warrior: loadout.classId === "warrior" ? loadout.subclassId : null,
      hunter: loadout.classId === "hunter" ? loadout.subclassId : null
    },
    loadout: {
      resetActives: loadout.resetActives,
      normalActives: loadout.normalActives,
      passiveTiers: loadout.passiveTiers, ultimateActive: null
    },
    legacyIds: [],
    resource: resources.find((entry) => entry.classId === loadout.classId)!,
    resources,
    weaponMode: loadout.weaponMode,
    rage: 0,
    maximumRage: 100,
    queuedAbility: null,
    cooldownEndsAt: {},
    serverTime: SIMULATION_EPOCH_MS,
    revision: 1
  };
}

function simulationEquipment(loadout: CombatSimulationLoadout): EquipmentSnapshot {
  const createdAt = new Date(SIMULATION_EPOCH_MS).toISOString();
  const weaponDefinition = loadout.weaponMode === "ranged"
      ? { definitionId: "starter_bow", displayName: "Bow", weaponCategory: "bow", twoHanded: true } as const
      : { definitionId: "starter_sword", displayName: "Sword", weaponCategory: "sword", twoHanded: false } as const;
  const weapon: EquipmentInstance = {
    instanceId: "00000000-0000-4000-8000-000000000001",
    definitionId: weaponDefinition.definitionId,
    displayName: weaponDefinition.displayName,
    ownerPlayerId: PLAYER_ID,
    location: "equipped",
    equippedSlot: "weapon",
    attackPowerBonus: 2,
    defenseBonus: 0,
    weaponCategory: weaponDefinition.weaponCategory,
    armorCategory: null,
    twoHanded: weaponDefinition.twoHanded,
    createdAt,
    updatedAt: createdAt
  };
  const chest: EquipmentInstance = {
    instanceId: "00000000-0000-4000-8000-000000000002",
    definitionId: "padded_tunic",
    displayName: "Tunic",
    ownerPlayerId: PLAYER_ID,
    location: "equipped",
    equippedSlot: "chest",
    attackPowerBonus: 0,
    defenseBonus: 2,
    weaponCategory: null,
    armorCategory: "light",
    twoHanded: false,
    createdAt,
    updatedAt: createdAt
  };
  return {
    playerId: PLAYER_ID,
    instances: [weapon, chest],
    weapon,
    chest,
    totalAttackPowerBonus: 2,
    totalDefenseBonus: 2
  };
}

function normalizeSimulationSummary(
  summary: CombatBalanceSummary,
  scenarioId: CombatSimulationScenarioId,
  loadoutId: CombatSimulationLoadoutId
): CombatBalanceSummary {
  return combatBalanceSummarySchema.parse({
    ...summary,
    combatSessionId: `simulation:${scenarioId}:${loadoutId}`
  });
}

function authority() {
  return {
    playerId: PLAYER_ID,
    accountId: simulationAccountId(),
    connectionId: simulationConnectionId()
  };
}

function simulationAccountId(): string {
  return `account-${PLAYER_ID}`;
}

function simulationConnectionId(): string {
  return `connection-${PLAYER_ID}`;
}

function east(distanceM: number): LatLon {
  return moveToward(ORIGIN, { lat: ORIGIN.lat, lon: ORIGIN.lon + 0.02 }, distanceM);
}

function sumMetric(metric: Record<string, number>): number {
  return Object.values(metric).reduce((total, value) => total + value, 0);
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(2)}s`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
