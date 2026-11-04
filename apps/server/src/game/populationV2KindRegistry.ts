import { createHash } from "node:crypto";

import { POPULATION_STONE_PLACEMENT_VERSION } from "./populationZonesV2Identity.js";
import {
  environmentSpawnPolicyMatches,
  type EnvironmentSpawnFacts,
  type EnvironmentSpawnPolicy
} from "./environmentSpawnProfiles.js";

export type PopulationV2KindCategory =
  | "mob"
  | "harvestable_plant_tree"
  | "generation_scoped_node"
  | "permanent_repeatable_node"
  | "noninteractive_decoration";

export type PopulationV2KindLifecyclePolicy =
  | "GENERATION_SCOPED"
  | "PER_ENTITY_RESPAWNING_WITHIN_GENERATION"
  | "PERMANENT_REPEATABLE"
  | "STATIC_DECORATION";

export type PopulationV2KindProjectionAdapter =
  | "combat_mob"
  | "generated_tree"
  | "permanent_resource"
  | "none";

export type PopulationV2KindInteractionAuthorityAdapter =
  | "combat_engine"
  | "tree_harvest"
  | "permanent_resource"
  | "none";

export type PopulationV2KindDefinition<KindKey extends string = string> =
  Readonly<{
    kindKey: KindKey;
    category: PopulationV2KindCategory;
    combatArchetype?: string;
    clientPresentationKey: string;
    placementRevision: string;
    lifecycleRevision: string;
    habitatPolicyKey: string;
    /** Optional declarative geography policy supplied by content definitions. */
    habitatPolicy?: EnvironmentSpawnPolicy;
    densityPolicy: Readonly<{
      model: "common" | "rare" | "permanent" | "none";
      policyKey: string;
    }>;
    spacingPolicy: Readonly<{
      classKey: string;
    }>;
    groupPolicy: Readonly<{
      model: "single" | "group" | "none";
      atomic: boolean;
    }>;
    lifecyclePolicy: PopulationV2KindLifecyclePolicy;
    respawnPolicy:
      | "generation_replacement"
      | "per_entity_timer"
      | "permanent_timer"
      | "none";
    requiresRuntimeActor: boolean;
    existingGenerationRollout:
      | "never"
      | "explicit_revisioned_top_up";
    projectionAdapter: PopulationV2KindProjectionAdapter;
    interactionAuthorityAdapter:
      PopulationV2KindInteractionAuthorityAdapter;
    diagnosticsLabel: string;
  }>;

type PopulationV2MobKindAdapterInput = Readonly<{
  mobKind: string;
  combatArchetype: string;
  placementRevision: string;
  spawnModel: "single" | "pack";
  density: Readonly<{ model: "common" | "rare" }>;
  spacingClass: string;
  existingGenerationRolloutEligible: boolean;
  diagnosticsLabel: string;
  habitatPolicy?: EnvironmentSpawnPolicy;
}>;

export class PopulationV2KindRegistry<
  Definition extends PopulationV2KindDefinition = PopulationV2KindDefinition
> {
  readonly definitions: readonly Definition[];
  readonly revision: string;
  private readonly byKind: ReadonlyMap<string, Definition>;

  constructor(definitions: readonly Definition[]) {
    validatePopulationV2KindDefinitions(definitions);
    this.definitions = Object.freeze([...definitions].sort((left, right) =>
      left.kindKey.localeCompare(right.kindKey)
    ));
    this.byKind = new Map(this.definitions.map((definition) => [
      definition.kindKey,
      definition
    ]));
    this.revision = populationV2KindRegistryRevision(this.definitions);
  }

  definitionForKind(kindKey: string): Definition | undefined {
    return this.byKind.get(kindKey);
  }

  requireDefinition(kindKey: string): Definition {
    const definition = this.definitionForKind(kindKey);
    if (!definition) {
      throw new Error(`unsupported Population V2 kind ${kindKey}`);
    }
    return definition;
  }
}

export function createPopulationV2KindRegistry<
  Definition extends PopulationV2KindDefinition
>(
  definitions: readonly Definition[]
): PopulationV2KindRegistry<Definition> {
  return new PopulationV2KindRegistry(definitions);
}

/**
 * Shared gate for content definitions that opt into declarative geography
 * policy. Definitions without a policy retain their existing anchor rules.
 */
export function populationV2KindHabitatPolicyMatches(
  definition: Pick<PopulationV2KindDefinition, "habitatPolicy">,
  facts: EnvironmentSpawnFacts,
  placementTags: readonly string[] = facts.placementTags ?? []
): boolean {
  return definition.habitatPolicy === undefined
    || environmentSpawnPolicyMatches({ ...facts, placementTags }, definition.habitatPolicy);
}

export function populationV2KindDefinitionForMob(
  definition: PopulationV2MobKindAdapterInput
): PopulationV2KindDefinition {
  return {
    kindKey: definition.mobKind,
    category: "mob",
    combatArchetype: definition.combatArchetype,
    clientPresentationKey: definition.combatArchetype,
    placementRevision: definition.placementRevision,
    lifecycleRevision: "combat-generation-scoped-v1",
    habitatPolicyKey: `mob:${definition.mobKind}:habitat-v1`,
    ...(definition.habitatPolicy ? { habitatPolicy: definition.habitatPolicy } : {}),
    densityPolicy: {
      model: definition.density.model,
      policyKey: `mob:${definition.mobKind}:density-v1`
    },
    spacingPolicy: {
      classKey: definition.spacingClass
    },
    groupPolicy: {
      model: definition.spawnModel === "pack" ? "group" : "single",
      atomic: definition.spawnModel === "pack"
    },
    lifecyclePolicy: "GENERATION_SCOPED",
    respawnPolicy: "generation_replacement",
    requiresRuntimeActor: true,
    existingGenerationRollout:
      definition.existingGenerationRolloutEligible
        ? "explicit_revisioned_top_up"
        : "never",
    projectionAdapter: "combat_mob",
    interactionAuthorityAdapter: "combat_engine",
    diagnosticsLabel: definition.diagnosticsLabel
  };
}

function permanentMineKindDefinition(
  kindKey: "stone" | "coal" | "iron"
): PopulationV2KindDefinition {
  return {
    kindKey,
    category: "permanent_repeatable_node",
    clientPresentationKey: `permanent_${kindKey}`,
    placementRevision: POPULATION_STONE_PLACEMENT_VERSION,
    lifecycleRevision: "permanent-mine-regeneration-v1",
    habitatPolicyKey: "permanent-mine:population-v2-land-v1",
    densityPolicy: {
      model: "permanent",
      policyKey: "permanent-mine:population-v2-density-v1"
    },
    spacingPolicy: {
      classKey: "permanent-stone"
    },
    groupPolicy: {
      model: "single",
      atomic: false
    },
    lifecyclePolicy: "PERMANENT_REPEATABLE",
    respawnPolicy: "permanent_timer",
    requiresRuntimeActor: false,
    existingGenerationRollout: "never",
    projectionAdapter: "permanent_resource",
    interactionAuthorityAdapter: "permanent_resource",
    diagnosticsLabel: `Permanent ${kindKey} mine`
  };
}

function oceanSulfurKindDefinition(): PopulationV2KindDefinition {
  return {
    kindKey: "sulfur",
    category: "permanent_repeatable_node",
    clientPresentationKey: "permanent_sulfur",
    placementRevision: "ocean-sulfur-placement-v1",
    lifecycleRevision: "ocean-sulfur-regeneration-v1",
    habitatPolicyKey: "permanent-sulfur:population-v2-ocean-v1",
    densityPolicy: {
      model: "permanent",
      policyKey: "permanent-sulfur:population-v2-ocean-density-v1"
    },
    spacingPolicy: {
      classKey: "permanent-stone"
    },
    groupPolicy: {
      model: "single",
      atomic: false
    },
    lifecyclePolicy: "PERMANENT_REPEATABLE",
    respawnPolicy: "permanent_timer",
    requiresRuntimeActor: false,
    existingGenerationRollout: "never",
    projectionAdapter: "permanent_resource",
    interactionAuthorityAdapter: "permanent_resource",
    diagnosticsLabel: "Permanent sulfur mine"
  };
}

export const POPULATION_V2_RESOURCE_KIND_DEFINITIONS = Object.freeze([
  {
    kindKey: "tree",
    category: "harvestable_plant_tree",
    clientPresentationKey: "scenery_tree",
    placementRevision: "legacy-generated-tree-placement-v1",
    lifecycleRevision: "generated-tree-harvest-v1",
    habitatPolicyKey: "tree:population-v2-habitat-v1",
    densityPolicy: {
      model: "common",
      policyKey: "tree:population-v2-density-v1"
    },
    spacingPolicy: {
      classKey: "generated-tree"
    },
    groupPolicy: {
      model: "single",
      atomic: false
    },
    lifecyclePolicy: "GENERATION_SCOPED",
    respawnPolicy: "generation_replacement",
    requiresRuntimeActor: false,
    existingGenerationRollout: "never",
    projectionAdapter: "generated_tree",
    interactionAuthorityAdapter: "tree_harvest",
    diagnosticsLabel: "Generated tree"
  },
  {
    kindKey: "flax",
    category: "generation_scoped_node",
    clientPresentationKey: "scenery_flax",
    placementRevision: "legacy-generated-flax-placement-v1",
    lifecycleRevision: "generated-flax-harvest-v1",
    habitatPolicyKey: "flax:population-v2-habitat-v1",
    densityPolicy: {
      model: "common",
      policyKey: "flax:population-v2-density-v1"
    },
    spacingPolicy: {
      classKey: "generated-tree"
    },
    groupPolicy: {
      model: "single",
      atomic: false
    },
    lifecyclePolicy: "GENERATION_SCOPED",
    respawnPolicy: "generation_replacement",
    requiresRuntimeActor: false,
    existingGenerationRollout: "never",
    projectionAdapter: "generated_tree",
    interactionAuthorityAdapter: "tree_harvest",
    diagnosticsLabel: "Wild Flax plant"
  },
  permanentMineKindDefinition("stone"),
  permanentMineKindDefinition("coal"),
  permanentMineKindDefinition("iron"),
  oceanSulfurKindDefinition()
] satisfies readonly PopulationV2KindDefinition[]);

export function validatePopulationV2KindDefinitions(
  definitions: readonly PopulationV2KindDefinition[]
): void {
  if (definitions.length === 0) {
    throw new Error("Population V2 kind registry cannot be empty");
  }
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (
      definition.kindKey.length > 64
      || !/^[a-z][a-z0-9_]*$/u.test(definition.kindKey)
    ) {
      throw new Error(`invalid Population V2 kind ${definition.kindKey}`);
    }
    if (seen.has(definition.kindKey)) {
      throw new Error(`duplicate Population V2 kind ${definition.kindKey}`);
    }
    seen.add(definition.kindKey);
    for (const [label, value] of [
      ["client presentation key", definition.clientPresentationKey],
      ["placement revision", definition.placementRevision],
      ["lifecycle revision", definition.lifecycleRevision],
      ["habitat policy", definition.habitatPolicyKey],
      ["density policy", definition.densityPolicy.policyKey],
      ["spacing class", definition.spacingPolicy.classKey],
      ["diagnostics label", definition.diagnosticsLabel]
    ] as const) {
      if (value.trim().length === 0) {
        throw new Error(
          `Population V2 kind ${definition.kindKey} has no ${label}`
        );
      }
    }
    if (
      definition.category === "mob"
      && (
        !definition.combatArchetype
        || definition.projectionAdapter !== "combat_mob"
        || definition.interactionAuthorityAdapter !== "combat_engine"
        || !definition.requiresRuntimeActor
      )
    ) {
      throw new Error(
        `Population V2 mob kind ${definition.kindKey} has invalid adapters`
      );
    }
    if (
      definition.groupPolicy.model === "group"
      && !definition.groupPolicy.atomic
    ) {
      throw new Error(
        `Population V2 grouped kind ${definition.kindKey} must be atomic`
      );
    }
    if (
      definition.lifecyclePolicy === "STATIC_DECORATION"
      && (
        definition.requiresRuntimeActor
        || definition.interactionAuthorityAdapter !== "none"
      )
    ) {
      throw new Error(
        `Population V2 decoration ${definition.kindKey} cannot own gameplay`
      );
    }
    if (
      definition.lifecyclePolicy === "PERMANENT_REPEATABLE"
      && definition.respawnPolicy !== "permanent_timer"
    ) {
      throw new Error(
        `Population V2 permanent kind ${definition.kindKey} needs a permanent timer`
      );
    }
  }
}

function populationV2KindRegistryRevision(
  definitions: readonly PopulationV2KindDefinition[]
): string {
  const manifest = definitions.map((definition) => ({
    kindKey: definition.kindKey,
    category: definition.category,
    combatArchetype: definition.combatArchetype ?? null,
    clientPresentationKey: definition.clientPresentationKey,
    placementRevision: definition.placementRevision,
    lifecycleRevision: definition.lifecycleRevision,
    habitatPolicyKey: definition.habitatPolicyKey,
    ...(definition.habitatPolicy ? { habitatPolicy: definition.habitatPolicy } : {}),
    densityPolicy: definition.densityPolicy,
    spacingPolicy: definition.spacingPolicy,
    groupPolicy: definition.groupPolicy,
    lifecyclePolicy: definition.lifecyclePolicy,
    respawnPolicy: definition.respawnPolicy,
    requiresRuntimeActor: definition.requiresRuntimeActor,
    existingGenerationRollout: definition.existingGenerationRollout,
    projectionAdapter: definition.projectionAdapter,
    interactionAuthorityAdapter: definition.interactionAuthorityAdapter
  }));
  return `population-kind-registry-v2:${
    createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex")
      .slice(0, 16)
  }`;
}
