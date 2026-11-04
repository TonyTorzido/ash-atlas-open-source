export const POPULATION_DENSITY_REVISION =
  "population-land-encounter-density-v2";

export const POPULATION_DENSITY_MULTIPLIERS = {
  tree: 1.25,
  flax: 1,
  deer: 2,
  wolf_pack: 2
} as const;

export const POPULATION_BALANCE = {
  common: {
    tree: {
      densityPerEligibleKm2: 4 * POPULATION_DENSITY_MULTIPLIERS.tree,
      minimumSpacingM: 70,
      candidateOversamplingFactor: 1.08
    },
    flax: {
      densityPerEligibleKm2: 1.5 * POPULATION_DENSITY_MULTIPLIERS.flax,
      minimumSpacingM: 50,
      candidateOversamplingFactor: 1.08
    },
    deer: {
      densityPerEligibleKm2: 3.2 * POPULATION_DENSITY_MULTIPLIERS.deer,
      minimumSpacingM: 45,
      candidateOversamplingFactor: 1.03
    },
    deer_group: {
      densityPerEligibleKm2: 2.56,
      minimumSpacingM: 45,
      candidateOversamplingFactor: 1.03
    },
    wolf_pack: {
      densityPerEligibleKm2:
        (1 / 2.4) * POPULATION_DENSITY_MULTIPLIERS.wolf_pack,
      minimumSpacingM: 700,
      candidateOversamplingFactor: 1.6
    }
  },
  rare: {
    stone: {
      targetAreaKm2: 5,
      candidateOversamplingFactor: 1.115
    },
    ogre: {
      targetAreaKm2: 4,
      candidateOversamplingFactor: 1.25
    },
    sap_crawler_group: {
      targetAreaKm2: 8,
      candidateOversamplingFactor: 1.25
    }
  },
  wolfPackSize: {
    rollNamespace: "population-wolf-pack-size-v2",
    outcomes: [
      { memberCount: 2, probability: 0.20 },
      { memberCount: 3, probability: 0.80 }
    ]
  },
  deerGroupSize: {
    rollNamespace: "population-deer-group-size-v3",
    outcomes: [
      { memberCount: 1, probability: 0.20 },
      { memberCount: 2, probability: 0.40 },
      { memberCount: 3, probability: 0.40 }
    ]
  },
  sapCrawlerGroupSize: {
    rollNamespace: "population-sap-crawler-group-size-v3",
    outcomes: [
      { memberCount: 3, probability: 0.375 },
      { memberCount: 4, probability: 0.625 }
    ]
  }
} as const;

const LEGACY_SAP_CRAWLER_GROUP_SIZE = {
  outcomes: [
    { memberCount: 5, probability: 0.30 },
    { memberCount: 6, probability: 0.50 },
    { memberCount: 7, probability: 0.20 }
  ]
} as const;

export type GroupedEncounterSizeSpec<
  MemberCount extends number = number
> = Readonly<{
  outcomes: readonly Readonly<{
    memberCount: MemberCount;
    probability: number;
  }>[];
}>;

export function groupedEncounterSizeForUnit<MemberCount extends number>(
  specification: GroupedEncounterSizeSpec<MemberCount>,
  unit: number,
  label: string
): MemberCount {
  if (!Number.isFinite(unit) || unit < 0 || unit >= 1) {
    throw new Error(`${label} unit must be finite and in [0, 1)`);
  }
  let upperExclusive = 0;
  for (const outcome of specification.outcomes) {
    upperExclusive += outcome.probability;
    if (unit < upperExclusive) return outcome.memberCount;
  }
  throw new Error(`${label} configuration did not select an outcome`);
}

function validateGroupedEncounterSizeSpec(
  specification: Readonly<{
    outcomes: readonly Readonly<{ probability: number }>[];
  }>,
  label: string
): void {
  const probabilities = specification.outcomes.map(
    (outcome) => outcome.probability
  );
  if (probabilities.some((probability) =>
    !Number.isFinite(probability) || probability < 0
  )) {
    throw new Error(`${label} probabilities must be finite and nonnegative`);
  }
  if (probabilities.reduce((total, probability) => total + probability, 0) !== 1) {
    throw new Error(`${label} probabilities must total exactly 1`);
  }
}

export function validatePopulationBalance(
  balance: Readonly<{
    wolfPackSize: Readonly<{
      outcomes: readonly Readonly<{ probability: number }>[];
    }>;
    deerGroupSize?: Readonly<{
      outcomes: readonly Readonly<{ probability: number }>[];
    }>;
    sapCrawlerGroupSize?: Readonly<{
      outcomes: readonly Readonly<{ probability: number }>[];
    }>;
  }> = POPULATION_BALANCE
): void {
  validateGroupedEncounterSizeSpec(balance.wolfPackSize, "wolf pack-size");
  validateGroupedEncounterSizeSpec(
    balance.deerGroupSize ?? POPULATION_BALANCE.deerGroupSize,
    "Deer group-size"
  );
  validateGroupedEncounterSizeSpec(
    balance.sapCrawlerGroupSize ?? POPULATION_BALANCE.sapCrawlerGroupSize,
    "Resin Crawler group-size"
  );
}

export function wolfPackSizeForUnit(unit: number): 2 | 3 {
  return groupedEncounterSizeForUnit(
    POPULATION_BALANCE.wolfPackSize,
    unit,
    "wolf pack-size"
  );
}

export function deerGroupSizeForUnit(unit: number): 1 | 2 | 3 {
  return groupedEncounterSizeForUnit(
    POPULATION_BALANCE.deerGroupSize,
    unit,
    "Deer group-size"
  );
}

export function sapCrawlerGroupSizeForUnit(unit: number): 3 | 4 {
  return groupedEncounterSizeForUnit(
    POPULATION_BALANCE.sapCrawlerGroupSize,
    unit,
    "Resin Crawler group-size"
  );
}

export function legacySapCrawlerGroupSizeForUnit(unit: number): 5 | 6 | 7 {
  return groupedEncounterSizeForUnit(
    LEGACY_SAP_CRAWLER_GROUP_SIZE,
    unit,
    "legacy Resin Crawler group-size"
  );
}

validatePopulationBalance();
