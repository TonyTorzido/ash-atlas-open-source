import {
  BASIC_ATTACK_INTERVAL_MS,
  COMBAT_KIT_INDICES,
  EQUIPMENT_BALANCE_VERSION,
  EQUIPMENT_SLOTS,
  MAX_EQUIPMENT_LEVEL,
  WARRIOR_XP_THRESHOLDS,
  activeEquipmentLoadoutFromSnapshot,
  emptyEquipmentSlots,
  equipmentUpgradeCost,
  requireEquipmentDefinition,
  resolveEquipmentCombatStats,
  resolveEquipmentItemDerivedStats,
  type ClassProgressView,
  type ClassSnapshot,
  type CombatKitIndex,
  type CombatKitSnapshot,
  type EquipmentCombatStats,
  type EquipmentDefinition,
  type EquipmentDefinitionId,
  type EquipmentInstanceV2,
  type EquipmentSlotRecord,
  type EquipmentSnapshotV2,
  type ReadiedWeaponSlot
} from "@ash-atlas/shared";

import {
  CombatEngine,
  CombatRequestError,
  playerEquipmentCombatStateFromSnapshot,
  type AppliedEquipmentCombatUpdates
} from "./combatEngine.js";

const TICK_RATE_HZ = 20;
const ATTACK_INTERVAL_TICKS = Math.round(BASIC_ATTACK_INTERVAL_MS / 1_000 * TICK_RATE_HZ);
const MAXIMUM_DUEL_TICKS = 5_000;
const SIMULATION_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const SIMULATION_SERVER_TIME = Date.parse(SIMULATION_TIMESTAMP);
const LEFT_PLAYER_ID = "equipment-simulation-left";
const RIGHT_PLAYER_ID = "equipment-simulation-right";

export type EquipmentAffinityProfile = "preferred" | "off_affinity";
export type EquipmentSecondaryConfiguration = "ranged" | "shield";
export type EquipmentKitLayout = "one_valid" | "six_reused" | "six_unique";

export type EquipmentProgressionProfile = {
  id: string;
  label: string;
  characterLevel: number;
  warriorRank: number;
  gearLevel: number;
  affinity: EquipmentAffinityProfile;
};

export const EQUIPMENT_PROGRESSION_PROFILES = [
  {
    id: "character-00-warrior-00-gear-00",
    label: "Character 0 / Warrior 0 / gear 0",
    characterLevel: 0,
    warriorRank: 0,
    gearLevel: 0,
    affinity: "preferred"
  },
  {
    id: "character-15-warrior-09-gear-00",
    label: "Character 15 / Warrior 9 / gear 0",
    characterLevel: 15,
    warriorRank: 9,
    gearLevel: 0,
    affinity: "preferred"
  },
  {
    id: "character-15-warrior-09-gear-15",
    label: "Character 15 / Warrior 9 / gear 15",
    characterLevel: 15,
    warriorRank: 9,
    gearLevel: 15,
    affinity: "preferred"
  },
  {
    id: "character-20-warrior-12-gear-20",
    label: "Character 20 / Warrior 12 / gear 20",
    characterLevel: 20,
    warriorRank: 12,
    gearLevel: 20,
    affinity: "preferred"
  },
  {
    id: "character-25-warrior-15-gear-20",
    label: "Character 25 / Warrior 15 / gear 20",
    characterLevel: 25,
    warriorRank: 15,
    gearLevel: 20,
    affinity: "preferred"
  },
  {
    id: "character-25-warrior-15-gear-25-off-affinity",
    label: "Character 25 / Warrior 15 / gear 25 off-affinity",
    characterLevel: 25,
    warriorRank: 15,
    gearLevel: 25,
    affinity: "off_affinity"
  },
  {
    id: "character-25-warrior-15-gear-25-preferred",
    label: "Character 25 / Warrior 15 / gear 25 preferred",
    characterLevel: 25,
    warriorRank: 15,
    gearLevel: 25,
    affinity: "preferred"
  }
] as const satisfies readonly EquipmentProgressionProfile[];

export type EquipmentPowerSummary = {
  maximumHealth: number;
  pvpOffense: number;
  pvpGuard: number;
  effectiveWeaponLevel: number;
  weightedArmorLevel: number;
  shieldLevel: number | null;
  shieldGuardBonus: number;
  pveAttackPower: number;
  pveDefense: number;
  readiedWeaponSlot: ReadiedWeaponSlot;
  readiedWeaponCategory: string | null;
};

export type EquipmentCombatFighterOutcome = {
  profileId: string;
  finalHealth: number;
  successfulBasicAttacks: number;
  damageDealt: number;
  hitTicks: number[];
  hitDamage: number[];
  inventoryItemCount: number;
  validKitCount: number;
  power: EquipmentPowerSummary;
};

export type EquipmentCombatDuelCategory =
  | "matrix_mirror"
  | "maximum_gap"
  | "level_comparison"
  | "affinity_comparison"
  | "secondary_comparison"
  | "independence_control";

export type EquipmentCombatDuelOutcome = {
  scenarioId: string;
  label: string;
  category: EquipmentCombatDuelCategory;
  ticksElapsed: number;
  durationMs: number;
  winnerSide: "left" | "right" | null;
  winnerProfileId: string | null;
  left: EquipmentCombatFighterOutcome;
  right: EquipmentCombatFighterOutcome;
};

export type EquipmentSwitchStage = {
  requestId: string;
  requestedAfterTick: number;
  acceptedTick: number;
  requestedProfileId: string;
};

export type EquipmentSwitchSimulationOutcome = {
  scenarioId: "before_attack_tick" | "after_attack_tick" | "mid_fight" | "repeated_each_action";
  label: string;
  initialProfileId: string;
  replacementProfileId: string;
  stages: EquipmentSwitchStage[];
  activationTicks: number[];
  attackerHitTicks: number[];
  attackerHitDamage: number[];
  defenderHitTicks: number[];
  attackIntervalTicks: number;
  cadencePreserved: boolean;
  extraAttackObserved: boolean;
};

export type EquipmentReconnectSimulationOutcome = {
  scenarioId: "authority_handoff_mid_combat";
  label: string;
  reconnectAfterTick: number;
  authorityRotated: boolean;
  oldAuthorityRejected: boolean;
  replacementAuthorityAccepted: boolean;
  healthBeforeReconnect: {
    attacker: number;
    defender: number;
  };
  healthAfterReconnect: {
    attacker: number;
    defender: number;
  };
  healthPreserved: boolean;
  targetPreserved: boolean;
  runtimeRestored: boolean;
  restoredEquipment: {
    activeKitIndex: number | null;
    inventoryRevision: number;
    activeRevision: number;
    readiedWeaponSlot: ReadiedWeaponSlot;
    pvpOffense: number;
    pvpGuard: number;
    maximumHealth: number;
  };
  attackerHitTicks: number[];
  attackerHitDamage: number[];
  defenderHitTicks: number[];
  attackIntervalTicks: number;
  cadencePreserved: boolean;
  damagePreserved: boolean;
};

export type EquipmentCombatBalanceGate = {
  id: string;
  passed: boolean;
  evidence: string;
};

export type EquipmentCombatSimulationSuite = {
  schemaVersion: 1;
  balanceVersion: number;
  engine: "CombatEngine";
  tickRateHz: number;
  matrix: readonly EquipmentProgressionProfile[];
  profilePower: Array<{
    profileId: string;
    power: EquipmentPowerSummary;
  }>;
  duels: EquipmentCombatDuelOutcome[];
  switches: EquipmentSwitchSimulationOutcome[];
  reconnect: EquipmentReconnectSimulationOutcome;
  gates: EquipmentCombatBalanceGate[];
};

type SnapshotFixtureOptions = {
  profile: EquipmentProgressionProfile;
  ownerPlayerId: string;
  fixtureId: string;
  secondary?: EquipmentSecondaryConfiguration;
  readiedWeaponSlot?: ReadiedWeaponSlot;
  inventorySetCount?: 1 | 6;
  kitLayout?: EquipmentKitLayout;
};

type DuelFixture = {
  profile: EquipmentProgressionProfile;
  snapshot: EquipmentSnapshotV2;
};

type DuelInput = {
  scenarioId: string;
  label: string;
  category: EquipmentCombatDuelCategory;
  left: DuelFixture;
  right: DuelFixture;
};

type TrackedFighter = {
  damageDealt: number;
  hitTicks: number[];
  hitDamage: number[];
};

const PREFERRED_DEFINITIONS = {
  head: "training_heavy_helm",
  chest: "breast_plate" as EquipmentDefinitionId,
  gloves: "training_heavy_gloves",
  boots: "training_heavy_boots",
  ring: "ring_plain",
  ring_2: "ring_plain",
  melee: "double_axe" as EquipmentDefinitionId,
  tool_axe: "wooden_axe",
  tool_pickaxe: "wooden_pickaxe",
  tool_fishing_pole: "starter_fishing_pole"
} as const satisfies Omit<EquipmentSlotRecord<EquipmentDefinitionId>, "secondary">;

const OFF_AFFINITY_DEFINITIONS = {
  head: "training_light_hood",
  chest: "padded_tunic",
  gloves: "training_light_gloves",
  boots: "training_light_boots",
  ring: "ring_plain",
  ring_2: "ring_plain",
  melee: "starter_sword",
  tool_axe: "stone_axe",
  tool_pickaxe: "stone_pickaxe",
  tool_fishing_pole: "starter_fishing_pole"
} as const satisfies Omit<EquipmentSlotRecord<EquipmentDefinitionId>, "secondary">;

export function createEquipmentCombatSimulationSnapshot(
  options: SnapshotFixtureOptions
): EquipmentSnapshotV2 {
  const inventorySetCount = options.inventorySetCount ?? 1;
  const kitLayout = options.kitLayout ?? "one_valid";
  const secondary = options.secondary ?? "ranged";
  const readiedWeaponSlot = options.readiedWeaponSlot ?? "melee";
  if (secondary === "shield" && readiedWeaponSlot === "secondary") {
    throw new Error("A simulation shield cannot be the readied attacking weapon");
  }
  if (kitLayout === "six_unique" && inventorySetCount !== 6) {
    throw new Error("Six unique kits require six complete inventory sets");
  }

  const baseDefinitions = options.profile.affinity === "preferred"
    ? PREFERRED_DEFINITIONS
    : OFF_AFFINITY_DEFINITIONS;
  const definitions: EquipmentSlotRecord<EquipmentDefinitionId> = {
    ...baseDefinitions,
    secondary: secondary === "shield" ? "training_shield" : "starter_bow"
  };
  const instanceIdsBySet = Array.from({ length: inventorySetCount }, (_, setIndex) =>
    Object.fromEntries(EQUIPMENT_SLOTS.map((slot) => [
      slot,
      `${options.fixtureId}-set-${setIndex + 1}-${slot}`
    ])) as EquipmentSlotRecord<string>
  );
  const activeBalanceLoadout = {
    readiedWeaponSlot,
    active: Object.fromEntries(EQUIPMENT_SLOTS.map((slot) => [
      slot,
      {
        instanceId: instanceIdsBySet[0]![slot],
        definition: requireEquipmentDefinition(definitions[slot]),
        itemLevel: options.profile.gearLevel
      }
    ])) as EquipmentSlotRecord<{
      instanceId: string;
      definition: EquipmentDefinition;
      itemLevel: number;
    }>
  };
  const derivedStats = resolveEquipmentCombatStats({
    context: "pvp_open_world",
    characterLevel: options.profile.characterLevel,
    classId: "warrior",
    classRank: options.profile.warriorRank,
    loadout: activeBalanceLoadout
  });

  const instancesBySet = instanceIdsBySet.map((ids, setIndex) =>
    Object.fromEntries(EQUIPMENT_SLOTS.map((slot) => {
      const definition = requireEquipmentDefinition(definitions[slot]);
      const derived = resolveEquipmentItemDerivedStats({
        item: {
          instanceId: ids[slot],
          definition,
          itemLevel: options.profile.gearLevel
        },
        slot,
        classId: "warrior"
      });
      const savedKitIndices = savedKitIndicesFor(setIndex, kitLayout);
      const instance: EquipmentInstanceV2 = {
        instanceId: ids[slot],
        definitionId: definition.definitionId,
        displayName: definition.displayName,
        ownerPlayerId: options.ownerPlayerId,
        location: setIndex === 0 ? "equipped" : "inventory",
        equippedSlot: setIndex === 0 ? slot : null,
        itemLevel: options.profile.gearLevel,
        maximumItemLevel: MAX_EQUIPMENT_LEVEL,
        category: definition.category,
        balanceVersion: EQUIPMENT_BALANCE_VERSION,
        enchantmentIdentity: null,
        attackPowerBonus: derived.pveAttackContribution,
        defenseBonus: derived.pveDefenseContribution,
        weaponCategory: definition.weaponCategory,
        armorCategory: definition.armorCategory,
        twoHanded: definition.twoHanded,
        savedKitIndices,
        derived,
        nextUpgradeLevel: options.profile.gearLevel === MAX_EQUIPMENT_LEVEL
          ? null
          : options.profile.gearLevel + 1,
        nextUpgradeCost: options.profile.gearLevel === MAX_EQUIPMENT_LEVEL
          ? null
          : String(equipmentUpgradeCost(options.profile.gearLevel)),
        upgradeDisabledReason: options.profile.gearLevel === MAX_EQUIPMENT_LEVEL
          ? "maximum_level"
          : null,
        createdAt: SIMULATION_TIMESTAMP,
        updatedAt: SIMULATION_TIMESTAMP
      };
      return [slot, instance];
    })) as EquipmentSlotRecord<EquipmentInstanceV2>
  );
  const active = { ...instancesBySet[0]! };
  const kits = COMBAT_KIT_INDICES.map((kitIndex) =>
    createFixtureKit(kitIndex, kitLayout, instancesBySet, readiedWeaponSlot)
  );
  const readied = active[readiedWeaponSlot];
  const totalDefenseBonus = EQUIPMENT_SLOTS.reduce(
    (total, slot) => total + active[slot].derived.pveDefenseContribution,
    0
  );

  return {
    playerId: options.ownerPlayerId,
    snapshotVersion: 2,
    balanceVersion: EQUIPMENT_BALANCE_VERSION,
    characterLevel: options.profile.characterLevel,
    repairMessage: null,
    instances: instancesBySet.flatMap((set) => EQUIPMENT_SLOTS.map((slot) => set[slot])),
    active,
    readiedWeaponSlot,
    activeKitIndex: 1,
    kits,
    inventoryRevision: inventorySetCount * EQUIPMENT_SLOTS.length,
    activeRevision: 1,
    checkpointRevision: 1,
    derivedStats,
    weapon: readied,
    chest: active.chest,
    totalAttackPowerBonus: readied.derived.pveAttackContribution,
    totalDefenseBonus
  };
}

export function runEquipmentCombatDuel(input: DuelInput): EquipmentCombatDuelOutcome {
  const engine = createSimulationEngine();
  connectSimulationFighter(engine, LEFT_PLAYER_ID, input.left.profile, input.left.snapshot, 0);
  connectSimulationFighter(engine, RIGHT_PLAYER_ID, input.right.profile, input.right.snapshot, 0.000001);
  engine.startAttack({
    attackerId: LEFT_PLAYER_ID,
    targetEntityId: RIGHT_PLAYER_ID,
    requestId: `duel-${input.scenarioId}`,
    accountId: accountId(LEFT_PLAYER_ID),
    connectionId: connectionId(LEFT_PLAYER_ID)
  });

  const leftTrace: TrackedFighter = { damageDealt: 0, hitTicks: [], hitDamage: [] };
  const rightTrace: TrackedFighter = { damageDealt: 0, hitTicks: [], hitDamage: [] };
  let ticksElapsed = 0;
  while (ticksElapsed < MAXIMUM_DUEL_TICKS) {
    if (engine.serverTick === ATTACK_INTERVAL_TICKS) {
      // Defenders require an authorized attack request; incoming PvP damage never auto-retaliates.
      engine.startAttack({ attackerId: RIGHT_PLAYER_ID, targetEntityId: LEFT_PLAYER_ID,
        requestId: "defender-start", accountId: accountId(RIGHT_PLAYER_ID), connectionId: connectionId(RIGHT_PLAYER_ID) });
    }
    engine.tick();
    ticksElapsed += 1;
    collectDamageEvents(engine.beginDeltaFlush(), leftTrace, rightTrace);
    const left = engine.entity(LEFT_PLAYER_ID);
    const right = engine.entity(RIGHT_PLAYER_ID);
    if (left?.lifeState !== "alive" || right?.lifeState !== "alive") break;
  }
  const left = engine.entity(LEFT_PLAYER_ID);
  const right = engine.entity(RIGHT_PLAYER_ID);
  if (left?.lifeState === "alive" && right?.lifeState === "alive") {
    throw new Error(`Equipment combat duel ${input.scenarioId} exceeded ${MAXIMUM_DUEL_TICKS} ticks`);
  }
  const winnerSide = left?.lifeState === "alive"
    ? "left"
    : right?.lifeState === "alive"
      ? "right"
      : null;

  return {
    scenarioId: input.scenarioId,
    label: input.label,
    category: input.category,
    ticksElapsed,
    durationMs: ticksElapsed * 1_000 / TICK_RATE_HZ,
    winnerSide,
    winnerProfileId: winnerSide === "left"
      ? input.left.profile.id
      : winnerSide === "right"
        ? input.right.profile.id
        : null,
    left: fighterOutcome(input.left, left?.currentHealth ?? 0, leftTrace),
    right: fighterOutcome(input.right, right?.currentHealth ?? 0, rightTrace)
  };
}

export function runEquipmentCombatSimulationSuite(): EquipmentCombatSimulationSuite {
  const profiles = EQUIPMENT_PROGRESSION_PROFILES.map((profile) => ({ ...profile }));
  const maximumPreferred = profiles.at(-1)!;
  const duels: EquipmentCombatDuelOutcome[] = [];

  for (const profile of profiles) {
    duels.push(runProfileDuel({
      scenarioId: `mirror-${profile.id}`,
      label: `${profile.label} mirror`,
      category: "matrix_mirror",
      leftProfile: profile,
      rightProfile: profile
    }));
  }
  for (const profile of profiles.slice(0, -1)) {
    duels.push(runProfileDuel({
      scenarioId: `maximum-gap-${profile.id}`,
      label: `${profile.label} versus maximum preferred`,
      category: "maximum_gap",
      leftProfile: profile,
      rightProfile: maximumPreferred
    }));
  }

  const levelZeroOffAffinity = progressionProfile({
    id: "character-00-warrior-00-gear-00-off-affinity",
    label: "Character 0 / Warrior 0 / gear 0 off-affinity",
    characterLevel: 0,
    warriorRank: 0,
    gearLevel: 0,
    affinity: "off_affinity"
  });
  const levelOnePreferred = progressionProfile({
    id: "character-00-warrior-00-gear-01-preferred",
    label: "Character 0 / Warrior 0 / gear 1 preferred",
    characterLevel: 0,
    warriorRank: 0,
    gearLevel: 1,
    affinity: "preferred"
  });
  const maximumLevelZeroPreferred = progressionProfile({
    id: "character-25-warrior-15-gear-00-preferred",
    label: "Character 25 / Warrior 15 / gear 0 preferred",
    characterLevel: 25,
    warriorRank: 15,
    gearLevel: 0,
    affinity: "preferred"
  });
  duels.push(runProfileDuel({
    scenarioId: "level-zero-off-affinity-vs-level-zero-preferred",
    label: "Level 0 off-affinity versus level 0 preferred",
    category: "affinity_comparison",
    leftProfile: levelZeroOffAffinity,
    rightProfile: profiles[0]!
  }));
  duels.push(runProfileDuel({
    scenarioId: "level-one-vs-level-zero",
    label: "Level 1 preferred versus level 0 preferred",
    category: "level_comparison",
    leftProfile: levelOnePreferred,
    rightProfile: profiles[0]!
  }));
  duels.push(runProfileDuel({
    scenarioId: "level-zero-vs-level-25-equal-progression",
    label: "Level 0 versus level 25 at equal maximum character and Warrior progression",
    category: "level_comparison",
    leftProfile: maximumLevelZeroPreferred,
    rightProfile: maximumPreferred
  }));
  duels.push(runProfileDuel({
    scenarioId: "maximum-off-affinity-vs-maximum-preferred",
    label: "Maximum off-affinity versus maximum preferred",
    category: "affinity_comparison",
    leftProfile: profiles[5]!,
    rightProfile: maximumPreferred
  }));
  duels.push(runProfileDuel({
    scenarioId: "maximum-ranged-vs-maximum-shield",
    label: "Maximum ranged-secondary versus maximum shield",
    category: "secondary_comparison",
    leftProfile: maximumPreferred,
    rightProfile: maximumPreferred,
    leftSnapshot: {
      secondary: "ranged",
      readiedWeaponSlot: "secondary"
    },
    rightSnapshot: {
      secondary: "shield",
      readiedWeaponSlot: "melee"
    }
  }));

  const independenceInputs = [
    {
      suffix: "baseline",
      label: `${EQUIPMENT_SLOTS.length} inventory items / one valid kit`,
      inventorySetCount: 1,
      kitLayout: "one_valid"
    },
    {
      suffix: "large-inventory",
      label: `${EQUIPMENT_SLOTS.length * 6} inventory items / one valid kit`,
      inventorySetCount: 6,
      kitLayout: "one_valid"
    },
    {
      suffix: "six-reused",
      label: `${EQUIPMENT_SLOTS.length} inventory items / six kits reusing the active items`,
      inventorySetCount: 1,
      kitLayout: "six_reused"
    },
    {
      suffix: "six-unique",
      label: `${EQUIPMENT_SLOTS.length * 6} inventory items / six entirely unique kits`,
      inventorySetCount: 6,
      kitLayout: "six_unique"
    }
  ] as const;
  for (const variant of independenceInputs) {
    duels.push(runProfileDuel({
      scenarioId: `independence-${variant.suffix}`,
      label: variant.label,
      category: "independence_control",
      leftProfile: maximumPreferred,
      rightProfile: profiles[5]!,
      leftSnapshot: {
        inventorySetCount: variant.inventorySetCount,
        kitLayout: variant.kitLayout
      }
    }));
  }

  const switches = [
    runEquipmentSwitchSimulation("before_attack_tick"),
    runEquipmentSwitchSimulation("after_attack_tick"),
    runEquipmentSwitchSimulation("mid_fight"),
    runEquipmentSwitchSimulation("repeated_each_action")
  ];
  const reconnect = runEquipmentReconnectSimulation();
  const profilePower = profiles.map((profile) => ({
    profileId: profile.id,
    power: powerSummary(createEquipmentCombatSimulationSnapshot({
      profile,
      ownerPlayerId: `power-${profile.id}`,
      fixtureId: `power-${profile.id}`
    }).derivedStats)
  }));
  const gates = buildBalanceGates(duels, switches, reconnect, profiles);

  return {
    schemaVersion: 1,
    balanceVersion: EQUIPMENT_BALANCE_VERSION,
    engine: "CombatEngine",
    tickRateHz: TICK_RATE_HZ,
    matrix: profiles,
    profilePower,
    duels,
    switches,
    reconnect,
    gates
  };
}

export function equipmentCombatSimulationSuiteJson(
  suite: EquipmentCombatSimulationSuite
): string {
  return JSON.stringify(suite, null, 2);
}

export function equipmentCombatSimulationSuiteMarkdown(
  suite: EquipmentCombatSimulationSuite
): string {
  const lines = [
    "# Equipment Combat Balance Report",
    "",
    `Deterministic ${suite.tickRateHz} Hz fights run through the production \`${suite.engine}\`. ` +
      "The left fighter initiates each duel, so mirror winners reflect the one-action initiative advantage.",
    "",
    "## Progression matrix",
    "",
    "| Profile | HP | Offense | Guard | Weapon | Armor | Mirror winner hits | First hit |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const profile of suite.matrix) {
    const power = suite.profilePower.find((entry) => entry.profileId === profile.id)!.power;
    const mirror = suite.duels.find((duel) => duel.scenarioId === `mirror-${profile.id}`)!;
    const winner = mirror.winnerSide === "left" ? mirror.left : mirror.right;
    lines.push(
      `| ${profile.label} | ${power.maximumHealth} | ${decimal(power.pvpOffense)} | ` +
      `${decimal(power.pvpGuard)} | ${decimal(power.effectiveWeaponLevel)} | ` +
      `${decimal(power.weightedArmorLevel)} | ${winner.successfulBasicAttacks} | ` +
      `${winner.hitDamage[0] ?? 0} |`
    );
  }

  lines.push(
    "",
    "## Focused comparisons",
    "",
    "| Scenario | Winner | Ticks | Left hits/damage | Right hits/damage |",
    "| --- | --- | ---: | ---: | ---: |"
  );
  for (const duel of suite.duels.filter((candidate) =>
    candidate.category !== "matrix_mirror" &&
    candidate.category !== "independence_control"
  )) {
    lines.push(
      `| ${duel.label} | ${duel.winnerSide ?? "draw"} | ${duel.ticksElapsed} | ` +
      `${duel.left.successfulBasicAttacks}/${duel.left.damageDealt} | ` +
      `${duel.right.successfulBasicAttacks}/${duel.right.damageDealt} |`
    );
  }

  lines.push(
    "",
    "## Inventory and saved-kit controls",
    "",
    "| Inventory items | Valid kits | Winner | Ticks | Left hit ticks |",
    "| ---: | ---: | --- | ---: | --- |"
  );
  for (const duel of suite.duels.filter((candidate) =>
    candidate.category === "independence_control"
  )) {
    lines.push(
      `| ${duel.left.inventoryItemCount} | ${duel.left.validKitCount} | ` +
      `${duel.winnerSide ?? "draw"} | ${duel.ticksElapsed} | ` +
      `${duel.left.hitTicks.join(", ")} |`
    );
  }

  lines.push(
    "",
    "## Tick-boundary kit switching",
    "",
    "| Scenario | Requested after tick(s) | Applied tick(s) | Attacker hit ticks | Damage | Cadence preserved |",
    "| --- | --- | --- | --- | --- | --- |"
  );
  for (const simulation of suite.switches) {
    lines.push(
      `| ${simulation.label} | ${simulation.stages.map((stage) => stage.requestedAfterTick).join(", ")} | ` +
      `${simulation.activationTicks.join(", ")} | ${simulation.attackerHitTicks.join(", ")} | ` +
      `${simulation.attackerHitDamage.join(", ")} | ${simulation.cadencePreserved ? "yes" : "no"} |`
    );
  }

  lines.push(
    "",
    "## Reconnect authority handoff",
    "",
    "| Scenario | Reconnect after tick | Health before/after | Target retained | Restored equipment | Attacker hit ticks | Cadence preserved |",
    "| --- | ---: | --- | --- | --- | --- | --- |",
    `| ${suite.reconnect.label} | ${suite.reconnect.reconnectAfterTick} | ` +
      `${suite.reconnect.healthBeforeReconnect.attacker}/${suite.reconnect.healthBeforeReconnect.defender} -> ` +
      `${suite.reconnect.healthAfterReconnect.attacker}/${suite.reconnect.healthAfterReconnect.defender} | ` +
      `${suite.reconnect.targetPreserved ? "yes" : "no"} | ` +
      `kit ${suite.reconnect.restoredEquipment.activeKitIndex ?? "none"}, ` +
      `${suite.reconnect.restoredEquipment.readiedWeaponSlot}, active revision ` +
      `${suite.reconnect.restoredEquipment.activeRevision} | ` +
      `${suite.reconnect.attackerHitTicks.join(", ")} | ` +
      `${suite.reconnect.cadencePreserved ? "yes" : "no"} |`
  );

  lines.push(
    "",
    "## Balance gates",
    "",
    "| Gate | Result | Evidence |",
    "| --- | --- | --- |"
  );
  for (const gate of suite.gates) {
    lines.push(`| ${gate.id} | ${gate.passed ? "PASS" : "FAIL"} | ${gate.evidence} |`);
  }
  return lines.join("\n");
}

function progressionProfile(profile: EquipmentProgressionProfile): EquipmentProgressionProfile {
  return profile;
}

function savedKitIndicesFor(
  setIndex: number,
  layout: EquipmentKitLayout
): CombatKitIndex[] {
  if (layout === "one_valid") return setIndex === 0 ? [1] : [];
  if (layout === "six_reused") return setIndex === 0 ? [...COMBAT_KIT_INDICES] : [];
  return [COMBAT_KIT_INDICES[setIndex]!];
}

function createFixtureKit(
  kitIndex: CombatKitIndex,
  layout: EquipmentKitLayout,
  instancesBySet: EquipmentSlotRecord<EquipmentInstanceV2>[],
  readiedWeaponSlot: ReadiedWeaponSlot
): CombatKitSnapshot {
  const completeSet = layout === "six_reused"
    ? instancesBySet[0]
    : layout === "six_unique"
      ? instancesBySet[kitIndex - 1]
      : kitIndex === 1
        ? instancesBySet[0]
        : undefined;
  if (!completeSet) {
    return {
      kitIndex,
      name: `Kit ${kitIndex}`,
      readiedWeaponSlot: "melee",
      items: emptyEquipmentSlots(null),
      valid: false,
      invalidReason: "incomplete",
      revision: 1
    };
  }
  return {
    kitIndex,
    name: `Kit ${kitIndex}`,
    readiedWeaponSlot,
    items: { ...completeSet },
    valid: true,
    invalidReason: null,
    revision: 1
  };
}

function createSimulationEngine(
  onEquipmentCombatUpdatesApplied?: (result: AppliedEquipmentCombatUpdates) => void
): CombatEngine {
  return new CombatEngine({
    tickRateHz: TICK_RATE_HZ,
    playerMovementSpeedMps: 40,
    random: () => 0.5,
    isPlayerAuthorityActive: () => true,
    ...(onEquipmentCombatUpdatesApplied
      ? { onEquipmentCombatUpdatesApplied }
      : {})
  });
}

function connectSimulationFighter(
  engine: CombatEngine,
  playerId: string,
  profile: EquipmentProgressionProfile,
  snapshot: EquipmentSnapshotV2,
  longitudeOffset: number
): void {
  engine.connectPlayer({
    playerId,
    name: profile.label,
    regionCode: "NM",
    zoneId: "world:NM",
    position: { lat: 35, lon: -106 + longitudeOffset },
    accountId: accountId(playerId),
    connectionId: connectionId(playerId),
    profile: {
      playerId,
      level: profile.characterLevel,
      maxHealth: snapshot.derivedStats.maximumHealth,
      currentHealth: snapshot.derivedStats.maximumHealth,
      baseAttackDamage: snapshot.derivedStats.pveAttackPower,
      defense: snapshot.derivedStats.pveDefense
    }
  });
  engine.updatePlayerClassState(
    playerId,
    warriorClassSnapshot(playerId, profile),
    snapshot
  );
  if (!engine.syncPlayerEquipmentCombatState(
    playerId,
    playerEquipmentCombatStateFromSnapshot(snapshot)
  )) {
    throw new Error(`Unable to install simulation equipment for ${playerId}`);
  }
}

function warriorClassSnapshot(
  playerId: string,
  profile: EquipmentProgressionProfile
): ClassSnapshot {
  const warrior = warriorProgress(profile.warriorRank);
  return {
    playerId,
    characterLevel: profile.characterLevel,
    activeClassId: "warrior",
    activeSubclassId: null,
    warrior,
    classes: [warrior],
    subclasses: [],
    loadout: {
      resetActives: [],
      normalActives: [],
      passiveTiers: [], ultimateActive: null
    },
    resource: {
      classId: "warrior",
      resourceId: "rage",
      displayName: "Rage",
      current: 0,
      maximum: 100,
      reserved: 0,
      updatedAt: SIMULATION_TIMESTAMP
    },
    legacyIds: [],
    rage: 0,
    maximumRage: 100,
    queuedAbility: null,
    cooldownEndsAt: {},
    serverTime: SIMULATION_SERVER_TIME,
    revision: 1
  };
}

function warriorProgress(rank: number): ClassProgressView {
  return {
    classId: "warrior",
    level: rank,
    xp: WARRIOR_XP_THRESHOLDS[rank]!,
    nextLevelXp: rank < WARRIOR_XP_THRESHOLDS.length - 1
      ? WARRIOR_XP_THRESHOLDS[rank + 1]!
      : null,
    completedAt: null
  };
}

function collectDamageEvents(
  frame: ReturnType<CombatEngine["beginDeltaFlush"]>,
  left: TrackedFighter,
  right: TrackedFighter
): void {
  for (const event of frame.events) {
    if (event.type !== "DAMAGE" || !event.amount) continue;
    if (event.sourceEntityId === LEFT_PLAYER_ID && event.targetEntityId === RIGHT_PLAYER_ID) {
      left.damageDealt += event.amount;
      left.hitTicks.push(event.tick);
      left.hitDamage.push(event.amount);
    } else if (
      event.sourceEntityId === RIGHT_PLAYER_ID &&
      event.targetEntityId === LEFT_PLAYER_ID
    ) {
      right.damageDealt += event.amount;
      right.hitTicks.push(event.tick);
      right.hitDamage.push(event.amount);
    }
  }
}

function fighterOutcome(
  fixture: DuelFixture,
  finalHealth: number,
  trace: TrackedFighter
): EquipmentCombatFighterOutcome {
  return {
    profileId: fixture.profile.id,
    finalHealth,
    successfulBasicAttacks: trace.hitTicks.length,
    damageDealt: trace.damageDealt,
    hitTicks: trace.hitTicks,
    hitDamage: trace.hitDamage,
    inventoryItemCount: fixture.snapshot.instances.length,
    validKitCount: fixture.snapshot.kits.filter((kit) => kit.valid).length,
    power: powerSummary(fixture.snapshot.derivedStats)
  };
}

function powerSummary(stats: EquipmentCombatStats): EquipmentPowerSummary {
  return {
    maximumHealth: stats.maximumHealth,
    pvpOffense: stats.pvpOffense,
    pvpGuard: stats.pvpGuard,
    effectiveWeaponLevel: stats.effectiveWeaponLevel,
    weightedArmorLevel: stats.weightedArmorLevel,
    shieldLevel: stats.shieldLevel,
    shieldGuardBonus: stats.shieldGuardBonus,
    pveAttackPower: stats.pveAttackPower,
    pveDefense: stats.pveDefense,
    readiedWeaponSlot: stats.readiedWeaponSlot,
    readiedWeaponCategory: stats.readiedWeaponCategory
  };
}

function runProfileDuel(input: {
  scenarioId: string;
  label: string;
  category: EquipmentCombatDuelCategory;
  leftProfile: EquipmentProgressionProfile;
  rightProfile: EquipmentProgressionProfile;
  leftSnapshot?: Partial<Pick<
    SnapshotFixtureOptions,
    "secondary" | "readiedWeaponSlot" | "inventorySetCount" | "kitLayout"
  >>;
  rightSnapshot?: Partial<Pick<
    SnapshotFixtureOptions,
    "secondary" | "readiedWeaponSlot" | "inventorySetCount" | "kitLayout"
  >>;
}): EquipmentCombatDuelOutcome {
  return runEquipmentCombatDuel({
    scenarioId: input.scenarioId,
    label: input.label,
    category: input.category,
    left: {
      profile: input.leftProfile,
      snapshot: createEquipmentCombatSimulationSnapshot({
        profile: input.leftProfile,
        ownerPlayerId: LEFT_PLAYER_ID,
        fixtureId: `${input.scenarioId}-left`,
        ...input.leftSnapshot
      })
    },
    right: {
      profile: input.rightProfile,
      snapshot: createEquipmentCombatSimulationSnapshot({
        profile: input.rightProfile,
        ownerPlayerId: RIGHT_PLAYER_ID,
        fixtureId: `${input.scenarioId}-right`,
        ...input.rightSnapshot
      })
    }
  });
}

function runEquipmentSwitchSimulation(
  scenarioId: EquipmentSwitchSimulationOutcome["scenarioId"]
): EquipmentSwitchSimulationOutcome {
  const initialProfile = progressionProfile({
    id: "switch-gear-00-off-affinity",
    label: "Switch gear 0 off-affinity",
    characterLevel: 25,
    warriorRank: 15,
    gearLevel: 0,
    affinity: "off_affinity"
  });
  const replacementProfile = progressionProfile({
    id: "switch-gear-25-preferred",
    label: "Switch gear 25 preferred",
    characterLevel: 25,
    warriorRank: 15,
    gearLevel: 25,
    affinity: "preferred"
  });
  const alternateProfile = progressionProfile({
    id: "switch-gear-25-off-affinity",
    label: "Switch gear 25 off-affinity",
    characterLevel: 25,
    warriorRank: 15,
    gearLevel: 25,
    affinity: "off_affinity"
  });
  const initialSnapshot = createEquipmentCombatSimulationSnapshot({
    profile: initialProfile,
    ownerPlayerId: LEFT_PLAYER_ID,
    fixtureId: `${scenarioId}-initial`
  });
  const replacementSnapshot = createEquipmentCombatSimulationSnapshot({
    profile: replacementProfile,
    ownerPlayerId: LEFT_PLAYER_ID,
    fixtureId: `${scenarioId}-replacement`
  });
  const alternateSnapshot = createEquipmentCombatSimulationSnapshot({
    profile: alternateProfile,
    ownerPlayerId: LEFT_PLAYER_ID,
    fixtureId: `${scenarioId}-alternate`
  });
  const defenderSnapshot = createEquipmentCombatSimulationSnapshot({
    profile: replacementProfile,
    ownerPlayerId: RIGHT_PLAYER_ID,
    fixtureId: `${scenarioId}-defender`
  });
  const activationTicks: number[] = [];
  const engine = createSimulationEngine((result) => {
    if (result.playerId === LEFT_PLAYER_ID) activationTicks.push(result.activationTick);
  });
  const startsWithReplacement = scenarioId === "repeated_each_action";
  connectSimulationFighter(
    engine,
    LEFT_PLAYER_ID,
    startsWithReplacement ? replacementProfile : initialProfile,
    startsWithReplacement ? replacementSnapshot : initialSnapshot,
    0
  );
  connectSimulationFighter(
    engine,
    RIGHT_PLAYER_ID,
    replacementProfile,
    defenderSnapshot,
    0.000001
  );
  engine.startAttack({
    attackerId: LEFT_PLAYER_ID,
    targetEntityId: RIGHT_PLAYER_ID,
    requestId: `switch-start-${scenarioId}`,
    accountId: accountId(LEFT_PLAYER_ID),
    connectionId: connectionId(LEFT_PLAYER_ID)
  });

  const stages: EquipmentSwitchStage[] = [];
  const stage = (
    requestId: string,
    profile: EquipmentProgressionProfile,
    snapshot: EquipmentSnapshotV2
  ) => {
    const result = engine.stageEquipmentCombatUpdate(LEFT_PLAYER_ID, {
      requestId,
      kind: "kit_activation",
      state: playerEquipmentCombatStateFromSnapshot(snapshot)
    });
    stages.push({
      requestId,
      requestedAfterTick: engine.serverTick,
      acceptedTick: result.acceptedTick,
      requestedProfileId: profile.id
    });
  };
  if (scenarioId === "before_attack_tick") {
    stage("switch-before-first-hit", replacementProfile, replacementSnapshot);
  }

  const leftTrace: TrackedFighter = { damageDealt: 0, hitTicks: [], hitDamage: [] };
  const rightTrace: TrackedFighter = { damageDealt: 0, hitTicks: [], hitDamage: [] };
  const desiredAttackerHits = scenarioId === "repeated_each_action" ? 6 : 3;
  let lastObservedAttackerHits = 0;
  while (leftTrace.hitTicks.length < desiredAttackerHits && engine.serverTick < 500) {
    engine.tick();
    collectDamageEvents(engine.beginDeltaFlush(), leftTrace, rightTrace);
    if (scenarioId === "after_attack_tick" && engine.serverTick === 1) {
      stage("switch-after-first-hit", replacementProfile, replacementSnapshot);
    } else if (scenarioId === "mid_fight" && engine.serverTick === 10) {
      stage("switch-mid-fight", replacementProfile, replacementSnapshot);
    }
    if (
      scenarioId === "repeated_each_action" &&
      leftTrace.hitTicks.length > lastObservedAttackerHits &&
      leftTrace.hitTicks.length < desiredAttackerHits
    ) {
      const useAlternate = leftTrace.hitTicks.length % 2 === 1;
      stage(
        `switch-after-action-${leftTrace.hitTicks.length}`,
        useAlternate ? alternateProfile : replacementProfile,
        useAlternate ? alternateSnapshot : replacementSnapshot
      );
    }
    lastObservedAttackerHits = leftTrace.hitTicks.length;
    if (
      engine.entity(LEFT_PLAYER_ID)?.lifeState !== "alive" ||
      engine.entity(RIGHT_PLAYER_ID)?.lifeState !== "alive"
    ) {
      break;
    }
  }
  if (leftTrace.hitTicks.length !== desiredAttackerHits) {
    throw new Error(`Switch simulation ${scenarioId} ended before its action trace completed`);
  }
  const attackIntervalTicks = ATTACK_INTERVAL_TICKS;
  const cadencePreserved = leftTrace.hitTicks.every(
    (tick, index) => tick === 1 + index * attackIntervalTicks
  );
  return {
    scenarioId,
    label: ({
      before_attack_tick: "Switch immediately before an attack tick",
      after_attack_tick: "Switch immediately after an attack tick",
      mid_fight: "Switch between scheduled attacks",
      repeated_each_action: "Switch after every resolved action"
    } as const)[scenarioId],
    initialProfileId: startsWithReplacement ? replacementProfile.id : initialProfile.id,
    replacementProfileId: replacementProfile.id,
    stages,
    activationTicks,
    attackerHitTicks: leftTrace.hitTicks,
    attackerHitDamage: leftTrace.hitDamage,
    defenderHitTicks: rightTrace.hitTicks,
    attackIntervalTicks,
    cadencePreserved,
    extraAttackObserved: !cadencePreserved
  };
}

export function runEquipmentReconnectSimulation(): EquipmentReconnectSimulationOutcome {
  const profile = progressionProfile({
    id: "reconnect-maximum-preferred",
    label: "Reconnect maximum preferred",
    characterLevel: 25,
    warriorRank: 15,
    gearLevel: 25,
    affinity: "preferred"
  });
  const attackerSnapshot = createEquipmentCombatSimulationSnapshot({
    profile,
    ownerPlayerId: LEFT_PLAYER_ID,
    fixtureId: "reconnect-attacker"
  });
  const defenderSnapshot = createEquipmentCombatSimulationSnapshot({
    profile,
    ownerPlayerId: RIGHT_PLAYER_ID,
    fixtureId: "reconnect-defender"
  });
  const engine = createSimulationEngine();
  connectSimulationFighter(engine, LEFT_PLAYER_ID, profile, attackerSnapshot, 0);
  connectSimulationFighter(engine, RIGHT_PLAYER_ID, profile, defenderSnapshot, 0.000001);
  engine.startAttack({
    attackerId: LEFT_PLAYER_ID,
    targetEntityId: RIGHT_PLAYER_ID,
    requestId: "reconnect-start",
    accountId: accountId(LEFT_PLAYER_ID),
    connectionId: connectionId(LEFT_PLAYER_ID)
  });

  const leftTrace: TrackedFighter = { damageDealt: 0, hitTicks: [], hitDamage: [] };
  const rightTrace: TrackedFighter = { damageDealt: 0, hitTicks: [], hitDamage: [] };
  while (engine.serverTick < 40) {
    if (engine.serverTick === ATTACK_INTERVAL_TICKS) {
      // Defenders require an authorized attack request; incoming PvP damage never auto-retaliates.
      engine.startAttack({ attackerId: RIGHT_PLAYER_ID, targetEntityId: LEFT_PLAYER_ID,
        requestId: "defender-start", accountId: accountId(RIGHT_PLAYER_ID), connectionId: connectionId(RIGHT_PLAYER_ID) });
    }
    engine.tick();
    collectDamageEvents(engine.beginDeltaFlush(), leftTrace, rightTrace);
  }
  const attackerBefore = engine.entity(LEFT_PLAYER_ID);
  const defenderBefore = engine.entity(RIGHT_PLAYER_ID);
  if (!attackerBefore || !defenderBefore) {
    throw new Error("Reconnect simulation lost a fighter before authority rotation");
  }

  const replacementConnectionId = `${connectionId(LEFT_PLAYER_ID)}-replacement`;
  const rotated = engine.rotatePlayerAuthority(
    LEFT_PLAYER_ID,
    accountId(LEFT_PLAYER_ID),
    replacementConnectionId
  );
  let oldAuthorityRejected = false;
  try {
    engine.startAttack({
      attackerId: LEFT_PLAYER_ID,
      targetEntityId: RIGHT_PLAYER_ID,
      requestId: "reconnect-old-authority",
      accountId: accountId(LEFT_PLAYER_ID),
      connectionId: connectionId(LEFT_PLAYER_ID)
    });
  } catch (error) {
    if (
      error instanceof CombatRequestError &&
      error.code === "COMBAT_AUTHORITY_REJECTED"
    ) {
      oldAuthorityRejected = true;
    } else {
      throw error;
    }
  }
  const restoredEquipmentState = playerEquipmentCombatStateFromSnapshot(attackerSnapshot);
  const restored = engine.syncPlayerEquipmentCombatState(
    LEFT_PLAYER_ID,
    restoredEquipmentState
  );
  let replacementAuthorityAccepted = true;
  try {
    engine.startAttack({
      attackerId: LEFT_PLAYER_ID,
      targetEntityId: RIGHT_PLAYER_ID,
      requestId: "reconnect-replacement-authority",
      accountId: accountId(LEFT_PLAYER_ID),
      connectionId: replacementConnectionId
    });
  } catch {
    replacementAuthorityAccepted = false;
  }
  const defenderAfter = engine.entity(RIGHT_PLAYER_ID);
  if (!defenderAfter) {
    throw new Error("Reconnect simulation lost the defender during authority rotation");
  }

  while (leftTrace.hitTicks.length < 4 && engine.serverTick < 130) {
    engine.tick();
    collectDamageEvents(engine.beginDeltaFlush(), leftTrace, rightTrace);
  }
  if (leftTrace.hitTicks.length !== 4) {
    throw new Error("Reconnect simulation ended before its action trace completed");
  }

  const attackIntervalTicks = ATTACK_INTERVAL_TICKS;
  const cadencePreserved = leftTrace.hitTicks.every(
    (tick, index) => tick === 1 + index * attackIntervalTicks
  ) && rightTrace.hitTicks.every(
    (tick, index) => tick === 1 + (index + 1) * attackIntervalTicks
  );
  const healthBeforeReconnect = {
    attacker: attackerBefore.currentHealth,
    defender: defenderBefore.currentHealth
  };
  const healthAfterReconnect = {
    attacker: restored?.currentHealth ?? -1,
    defender: defenderAfter.currentHealth
  };

  return {
    scenarioId: "authority_handoff_mid_combat",
    label: "Replacement connection during active combat",
    reconnectAfterTick: 40,
    authorityRotated: rotated !== null,
    oldAuthorityRejected,
    replacementAuthorityAccepted,
    healthBeforeReconnect,
    healthAfterReconnect,
    healthPreserved:
      healthAfterReconnect.attacker === healthBeforeReconnect.attacker &&
      healthAfterReconnect.defender === healthBeforeReconnect.defender,
    targetPreserved:
      rotated?.targetEntityId === RIGHT_PLAYER_ID &&
      restored?.targetEntityId === RIGHT_PLAYER_ID,
    runtimeRestored: restored !== null,
    restoredEquipment: {
      activeKitIndex: restoredEquipmentState.activeKitIndex,
      inventoryRevision: restoredEquipmentState.inventoryRevision,
      activeRevision: restoredEquipmentState.activeRevision,
      readiedWeaponSlot: restoredEquipmentState.stats.readiedWeaponSlot,
      pvpOffense: restoredEquipmentState.stats.pvpOffense,
      pvpGuard: restoredEquipmentState.stats.pvpGuard,
      maximumHealth: restoredEquipmentState.stats.maximumHealth
    },
    attackerHitTicks: leftTrace.hitTicks,
    attackerHitDamage: leftTrace.hitDamage,
    defenderHitTicks: rightTrace.hitTicks,
    attackIntervalTicks,
    cadencePreserved,
    damagePreserved:
      leftTrace.hitDamage.length === 4 &&
      leftTrace.hitDamage.every((damage) => damage === leftTrace.hitDamage[0])
  };
}

function buildBalanceGates(
  duels: EquipmentCombatDuelOutcome[],
  switches: EquipmentSwitchSimulationOutcome[],
  reconnect: EquipmentReconnectSimulationOutcome,
  profiles: EquipmentProgressionProfile[]
): EquipmentCombatBalanceGate[] {
  const maximumPreferred = profiles.at(-1)!;
  const maximumMirror = requireDuel(duels, `mirror-${maximumPreferred.id}`);
  const maximumWinner = maximumMirror.winnerSide === "left"
    ? maximumMirror.left
    : maximumMirror.right;
  const maximumGapDuels = duels.filter((duel) => duel.category === "maximum_gap");
  const strictlyLowerGearGapDuels = maximumGapDuels.filter(
    (duel) => !duel.scenarioId.includes("gear-25-off-affinity")
  );
  const levelOne = requireDuel(duels, "level-one-vs-level-zero");
  const levelZeroToMaximum = requireDuel(
    duels,
    "level-zero-vs-level-25-equal-progression"
  );
  const affinity = requireDuel(duels, "maximum-off-affinity-vs-maximum-preferred");
  const independence = duels.filter((duel) => duel.category === "independence_control");
  const baselineSignature = duelCombatSignature(independence[0]!);
  const monotonicPower = Array.from({ length: MAX_EQUIPMENT_LEVEL + 1 }, (_, level) => {
    const profile = progressionProfile({
      id: `monotonic-${level}`,
      label: `Monotonic gear ${level}`,
      characterLevel: 25,
      warriorRank: 15,
      gearLevel: level,
      affinity: "preferred"
    });
    return createEquipmentCombatSimulationSnapshot({
      profile,
      ownerPlayerId: `monotonic-${level}`,
      fixtureId: `monotonic-${level}`
    }).derivedStats;
  });
  const pvpProficiencySnapshot = createEquipmentCombatSimulationSnapshot({
    profile: maximumPreferred,
    ownerPlayerId: "proficiency-neutral",
    fixtureId: "proficiency-neutral"
  });
  const pvpWithRequestedProficiency = resolveEquipmentCombatStats({
    context: "pvp_open_world",
    characterLevel: maximumPreferred.characterLevel,
    classId: "warrior",
    classRank: maximumPreferred.warriorRank,
    loadout: activeEquipmentLoadoutFromSnapshot(pvpProficiencySnapshot),
    pveWeaponProficiencyMultiplier: 2
  });
  const before = switches.find((entry) => entry.scenarioId === "before_attack_tick")!;
  const after = switches.find((entry) => entry.scenarioId === "after_attack_tick")!;
  const repeated = switches.find((entry) => entry.scenarioId === "repeated_each_action")!;

  return [
    {
      id: "ordinary_maximum_health",
      passed: duels.every((duel) =>
        duel.left.power.maximumHealth === 100 && duel.right.power.maximumHealth === 100
      ),
      evidence: "Every simulated ordinary configuration resolves exactly 100 maximum HP."
    },
    {
      id: "maximum_mirror_ttk",
      passed:
        // V3 Axe/Breastplate 4 + equal upgrades (0) + Warrior Axe mastery (4).
        maximumWinner.successfulBasicAttacks === 12 &&
        maximumWinner.hitDamage[0] === 8,
      evidence:
        `${maximumWinner.successfulBasicAttacks} successful basics; ` +
        `${maximumWinner.hitDamage[0] ?? 0} first-hit damage.`
    },
    {
      id: "required_progression_gaps",
      passed: strictlyLowerGearGapDuels.every((duel) => duel.winnerSide === "right"),
      evidence:
        `${strictlyLowerGearGapDuels.filter((duel) => duel.winnerSide === "right").length}/` +
        `${strictlyLowerGearGapDuels.length} lower-gear initiators lost to maximum gear.`
    },
    {
      id: "level_one_is_measurably_stronger",
      passed:
        levelOne.left.power.pvpOffense > levelOne.right.power.pvpOffense &&
        levelOne.left.power.pvpGuard > levelOne.right.power.pvpGuard,
      evidence:
        `Offense ${decimal(levelOne.right.power.pvpOffense)} -> ` +
        `${decimal(levelOne.left.power.pvpOffense)}; Guard ` +
        `${decimal(levelOne.right.power.pvpGuard)} -> ${decimal(levelOne.left.power.pvpGuard)}.`
    },
    {
      id: "level_zero_overwhelmingly_disadvantaged",
      passed:
        levelZeroToMaximum.winnerSide === "right" &&
        levelZeroToMaximum.right.damageDealt === 100 &&
        levelZeroToMaximum.left.damageDealt <= 25,
      evidence:
        `Maximum dealt ${levelZeroToMaximum.right.damageDealt} damage while level 0 dealt ` +
        `${levelZeroToMaximum.left.damageDealt} before defeat.`
    },
    {
      id: "affinity_is_neutral",
      passed:
        affinity.left.power.pvpOffense === affinity.right.power.pvpOffense &&
        affinity.left.power.pvpGuard === affinity.right.power.pvpGuard,
      evidence:
        `Former preferred/off-affinity labels both resolve Offense/Guard ` +
        `${decimal(affinity.right.power.pvpOffense)}/${decimal(affinity.right.power.pvpGuard)} versus ` +
        `${decimal(affinity.left.power.pvpOffense)}/${decimal(affinity.left.power.pvpGuard)}.`
    },
    {
      id: "inventory_size_independence",
      passed:
        independence.find((duel) => duel.left.inventoryItemCount === EQUIPMENT_SLOTS.length * 6) !== undefined &&
        independence.every((duel) => duelCombatSignature(duel) === baselineSignature),
      evidence: `${EQUIPMENT_SLOTS.length}-item and ${EQUIPMENT_SLOTS.length * 6}-item inventories produced identical combat traces.`
    },
    {
      id: "saved_kit_count_independence",
      passed:
        independence.some((duel) => duel.left.validKitCount === 1) &&
        independence.some((duel) => duel.left.validKitCount === 6) &&
        independence.every((duel) => duelCombatSignature(duel) === baselineSignature),
      evidence: "One valid kit, six reused kits, and six unique kits produced identical traces."
    },
    {
      id: "all_equipment_levels_monotonic",
      passed: monotonicPower.every((stats, index) =>
        index === 0 || (
          stats.pvpOffense > monotonicPower[index - 1]!.pvpOffense &&
          stats.pvpGuard > monotonicPower[index - 1]!.pvpGuard &&
          stats.pveAttackPower >= monotonicPower[index - 1]!.pveAttackPower &&
          stats.pveDefense >= monotonicPower[index - 1]!.pveDefense
        )
      ),
      evidence: "Levels 0 through 25 are strictly increasing in PvP power and nondecreasing in PvE stats."
    },
    {
      id: "pve_proficiency_neutral_in_pvp",
      passed:
        pvpWithRequestedProficiency.pveWeaponProficiencyMultiplier === 1 &&
        pvpWithRequestedProficiency.pvpOffense === pvpProficiencySnapshot.derivedStats.pvpOffense &&
        pvpWithRequestedProficiency.pvpGuard === pvpProficiencySnapshot.derivedStats.pvpGuard,
      evidence: "A requested 2x PvE proficiency resolves to exactly 1x in PvP without changing power."
    },
    {
      id: "switch_tick_order",
      passed:
        before.activationTicks[0] === 1 &&
        after.activationTicks[0] === 2 &&
        (before.attackerHitDamage[0] ?? 0) > (after.attackerHitDamage[0] ?? 0) &&
        after.attackerHitDamage[1] === before.attackerHitDamage[0],
      evidence:
        `Before-switch applied tick ${before.activationTicks[0]}; after-switch applied tick ` +
        `${after.activationTicks[0]}; first damages ${before.attackerHitDamage[0]}/` +
        `${after.attackerHitDamage[0]}.`
    },
    {
      id: "switch_preserves_attack_schedule",
      passed:
        switches.every((entry) => entry.cadencePreserved && !entry.extraAttackObserved) &&
        repeated.attackerHitTicks.length === 6,
      evidence:
        `All traces remained on ticks 1 + n*${repeated.attackIntervalTicks}; repeated switching resolved six actions.`
    },
    {
      id: "reconnect_preserves_live_combat_state",
      passed:
        reconnect.authorityRotated &&
        reconnect.oldAuthorityRejected &&
        reconnect.replacementAuthorityAccepted &&
        reconnect.healthPreserved &&
        reconnect.targetPreserved &&
        reconnect.runtimeRestored &&
        reconnect.restoredEquipment.maximumHealth === 100 &&
        reconnect.cadencePreserved &&
        reconnect.damagePreserved,
      evidence:
        `Authority rotated after tick ${reconnect.reconnectAfterTick}; health ` +
        `${reconnect.healthBeforeReconnect.attacker}/${reconnect.healthBeforeReconnect.defender} ` +
        `was preserved; attacks remained on ticks ${reconnect.attackerHitTicks.join(", ")} ` +
        `with active revision ${reconnect.restoredEquipment.activeRevision}.`
    }
  ];
}

function requireDuel(
  duels: EquipmentCombatDuelOutcome[],
  scenarioId: string
): EquipmentCombatDuelOutcome {
  const duel = duels.find((candidate) => candidate.scenarioId === scenarioId);
  if (!duel) throw new Error(`Missing equipment combat duel ${scenarioId}`);
  return duel;
}

function duelCombatSignature(duel: EquipmentCombatDuelOutcome): string {
  return JSON.stringify({
    ticksElapsed: duel.ticksElapsed,
    winnerSide: duel.winnerSide,
    leftFinalHealth: duel.left.finalHealth,
    rightFinalHealth: duel.right.finalHealth,
    leftDamage: duel.left.damageDealt,
    rightDamage: duel.right.damageDealt,
    leftHitTicks: duel.left.hitTicks,
    rightHitTicks: duel.right.hitTicks,
    leftHitDamage: duel.left.hitDamage,
    rightHitDamage: duel.right.hitDamage,
    leftPower: duel.left.power,
    rightPower: duel.right.power
  });
}

function accountId(playerId: string): string {
  return `account-${playerId}`;
}

function connectionId(playerId: string): string {
  return `connection-${playerId}`;
}

function decimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
