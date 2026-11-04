import {
  GREENHOUSE_CROP_ID_REGEX,
  GREENHOUSE_STAGE_ART_IDS,
  GREENHOUSE_GIVING_BERRY_TREE_CROP_ID,
  type GreenhouseCropCatalogEntrySnapshot,
  type GreenhousePlantStage
} from "@ash-atlas/shared";
import type { RuntimePngGreenhouseCropPresentation } from "@ash-atlas/shared";

export type GreenhouseCropSeed = Readonly<{
  itemId: "seed" | "wheat_seed" | "giving_berry";
  variant: string | null;
  quantity: number;
}>;

export type GreenhouseCropProduce = Readonly<{
  itemId: "produce" | "wheat" | "wood";
  variant: string | null;
  quantity: number;
}>;

export type GreenhouseCropDefinition = Readonly<{
  cropId: string;
  enabled: boolean;
  displayName: string;
  seedDisplayName: string;
  seed: GreenhouseCropSeed;
  starterSeedQuantity: number;
  maxStage: GreenhousePlantStage;
  stageDurationMs: Readonly<{ riverbank: number; inland: number }>;
  stageArtIds: Readonly<Record<GreenhousePlantStage, string>>;
  clippingYieldByStage: Readonly<Partial<Record<GreenhousePlantStage, number>>>;
  harvest: GreenhouseCropProduce;
  kind?: "crop" | "giving_tree";
  berryYield?: number;
  resinYield?: number;
}>;

export const DEFAULT_GREENHOUSE_CROP_ID = "wheat";

/**
 * Wheat keeps its established inventory identities. New crops should use the
 * generic `seed` and `produce` identities with `variant` set to their stable
 * cropId. Crops stay out of this catalog until their verified art is ready.
 */
export const GREENHOUSE_CROP_CATALOG: Readonly<Record<string, GreenhouseCropDefinition>> = Object.freeze({
  wheat: Object.freeze({
    cropId: "wheat",
    enabled: true,
    displayName: "Wheat",
    seedDisplayName: "Wheat Seed",
    seed: Object.freeze({ itemId: "wheat_seed", variant: null, quantity: 1 }),
    starterSeedQuantity: 15,
    maxStage: 4,
    stageDurationMs: Object.freeze({ riverbank: 8 * 60 * 60 * 1_000, inland: 12 * 60 * 60 * 1_000 }),
    stageArtIds: GREENHOUSE_STAGE_ART_IDS,
    clippingYieldByStage: Object.freeze({ 3: 3 }),
    harvest: Object.freeze({ itemId: "wheat", variant: null, quantity: 5 })
  }),
  giving_berry_tree: Object.freeze({
    cropId: "giving_berry_tree",
    enabled: true,
    displayName: "Giving Berry Tree",
    seedDisplayName: "Giving Berry",
    seed: Object.freeze({ itemId: "giving_berry", variant: null, quantity: 1 }),
    starterSeedQuantity: 0,
    maxStage: 4,
    stageDurationMs: Object.freeze({ riverbank: 8 * 60 * 60 * 1_000, inland: 12 * 60 * 60 * 1_000 }),
    stageArtIds: Object.freeze({ 1: "giving_berry_tree_seedling", 2: "giving_berry_tree_middle_2", 3: "giving_berry_tree_fruiting", 4: "giving_berry_tree_mature" }),
    clippingYieldByStage: Object.freeze({ 3: 3 }),
    harvest: Object.freeze({ itemId: "wood", variant: null, quantity: 4 }),
    kind: "giving_tree",
    berryYield: 3,
    resinYield: 1
  })
});

/** Returns only a catalog entry whose key and persisted stable ID agree. */
export function greenhouseCropDefinition(cropId: string): GreenhouseCropDefinition | null {
  if (!GREENHOUSE_CROP_ID_REGEX.test(cropId)) return null;
  const crop = GREENHOUSE_CROP_CATALOG[cropId];
  return crop?.cropId === cropId && cropInventoryIdentitiesMatch(cropId, crop) ? crop : null;
}

export function enabledGreenhouseCropDefinition(cropId: string): GreenhouseCropDefinition | null {
  const crop = greenhouseCropDefinition(cropId);
  return crop?.enabled ? crop : null;
}

export function greenhouseCropPresentationMatchesDefinition(
  presentation: RuntimePngGreenhouseCropPresentation,
  crop: GreenhouseCropDefinition
): boolean {
  return presentation.cropId === crop.cropId &&
    presentation.displayName === crop.displayName &&
    presentation.seedDisplayName === crop.seedDisplayName &&
    presentation.seedItemId === crop.seed.itemId &&
    presentation.seedVariant === crop.seed.variant &&
    presentation.stages.length === 4 &&
    presentation.stages.every((stage) => stage.artId === crop.stageArtIds[stage.stage as GreenhousePlantStage]);
}

export function greenhouseCropCatalogForPack(
  presentations: readonly RuntimePngGreenhouseCropPresentation[],
  catalog: Readonly<Record<string, GreenhouseCropDefinition>> = GREENHOUSE_CROP_CATALOG
): GreenhouseCropCatalogEntrySnapshot[] {
  return Object.values(catalog)
    .flatMap((crop) => {
      const presentation = presentations.find((candidate) =>
        candidate.cropId === crop.cropId && greenhouseCropPresentationMatchesDefinition(candidate, crop)
      );
      return [{
        cropId: crop.cropId,
        displayName: crop.displayName,
        seedDisplayName: crop.seedDisplayName,
        seed: { itemId: crop.seed.itemId, variant: crop.seed.variant },
        maxStage: crop.maxStage,
        harvestQuantity: crop.harvest.quantity,
        clippingStages: Object.entries(crop.clippingYieldByStage)
          .filter(([, quantity]) => quantity !== undefined && quantity > 0)
          .map(([stage]) => Number(stage) as GreenhousePlantStage),
        plantingAvailable: crop.enabled && (presentation !== undefined || crop.cropId === GREENHOUSE_GIVING_BERRY_TREE_CROP_ID),
        stageArtIds: [
          crop.stageArtIds[1],
          crop.stageArtIds[2],
          crop.stageArtIds[3],
          crop.stageArtIds[4]
        ] as const
      }];
    });
}

/** Generic crop-item variants are valid only when the authoritative crop
 * definition assigns that exact seed or produce identity to the same ID. */
export function greenhouseCropSupportsInventoryIdentity(
  itemId: string,
  variant: string,
  catalog: Readonly<Record<string, Pick<GreenhouseCropDefinition, "cropId" | "seed" | "harvest">>> = GREENHOUSE_CROP_CATALOG
): boolean {
  if ((itemId !== "seed" && itemId !== "produce") || !GREENHOUSE_CROP_ID_REGEX.test(variant)) return false;
  const crop = catalog[variant];
  if (!crop || crop.cropId !== variant || !cropInventoryIdentitiesMatch(variant, crop)) return false;
  const identity = itemId === "seed" ? crop.seed : crop.harvest;
  return identity.itemId === itemId && identity.variant === variant;
}

function cropInventoryIdentitiesMatch(
  cropId: string,
  crop: Pick<GreenhouseCropDefinition, "seed" | "harvest">
): boolean {
  return (crop.seed.itemId === "seed" ? crop.seed.variant === cropId : crop.seed.variant === null) &&
    (crop.harvest.itemId === "produce" ? crop.harvest.variant === cropId : crop.harvest.variant === null);
}
