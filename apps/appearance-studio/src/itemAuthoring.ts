import {
  EQUIPMENT_DEFINITIONS,
  EQUIPMENT_GAMEPLAY_FAMILIES,
  appearanceCompatibleWithEquipment,
  playerOverlaySlotForFamily,
  PLAYER_OVERLAY_ANCHOR,
  PLAYER_OVERLAY_RENDER_LAYER,
  type AppearanceDefinition,
  type AppearanceFamily,
  type AppearancePartId,
  type AppearancePlacement,
  type EquipmentDefinitionId,
  type EquipmentGameplayFamilyId,
  type ItemVariantCatalog,
  type ItemVariantDefinitionId,
  type PlayerAppearanceCatalog,
  type PlayerAppearanceCategoryId,
  type PlayerAuthoringLayerId,
  type PlayerCombatPoseId,
  type PlayerOverlaySlotId
} from "@ash-atlas/shared";

const CONTENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export type ItemAuthoringDraft = {
  catalog: PlayerAppearanceCatalog;
  itemVariants: ItemVariantCatalog;
  appearance: AppearanceDefinition;
};

export function createItemVariantDraft(input: {
  catalog: PlayerAppearanceCatalog;
  itemVariants: ItemVariantCatalog;
  definitionId: string;
  displayName: string;
  familyId: EquipmentGameplayFamilyId;
  assetKey: string;
  authoringLayer?: PlayerAuthoringLayerId;
  partId?: AppearancePartId;
}): ItemAuthoringDraft {
  const definitionId = input.definitionId.trim();
  const displayName = input.displayName.trim();
  if (!CONTENT_ID.test(definitionId)) {
    throw new Error("Item IDs use lowercase letters, digits, underscores, and hyphens");
  }
  if (!displayName) throw new Error("Display name is required");
  if (
    Object.hasOwn(EQUIPMENT_DEFINITIONS, definitionId) ||
    input.itemVariants.variants.some((variant) => variant.definitionId === definitionId)
  ) {
    throw new Error(`Item ID already exists: ${definitionId}`);
  }
  if (input.catalog.appearances.some(({ appearanceId }) => appearanceId === definitionId)) {
    throw new Error(`Appearance ID already exists: ${definitionId}`);
  }
  const family = familyForEquipment(
    input.catalog,
    input.familyId,
    input.authoringLayer
  );
  const authoringBaseDefinitionId = EQUIPMENT_GAMEPLAY_FAMILIES[
    input.familyId
  ].authoringBaseDefinitionId;
  const variantDefinitionId = definitionId as ItemVariantDefinitionId;
  const appearance: AppearanceDefinition = {
    appearanceId: definitionId,
    displayName,
    familyId: family.familyId,
    ...appearanceAsset(input.assetKey, input.partId, family.authoringLayer),
    cosmetic: false,
    compatibleEquipmentDefinitionIds: [authoringBaseDefinitionId],
    placements: {}
  };
  return {
    catalog: {
      ...input.catalog,
      appearances: [...input.catalog.appearances, appearance]
    },
    itemVariants: {
      ...input.itemVariants,
      variants: [
        ...input.itemVariants.variants,
        {
          definitionId: variantDefinitionId,
          displayName,
          familyId: input.familyId,
          role: "cosmetic",
          appearanceId: appearance.appearanceId
        }
      ]
    },
    appearance
  };
}

export function updateExistingItemAppearance(input: {
  catalog: PlayerAppearanceCatalog;
  itemVariants: ItemVariantCatalog;
  definitionId: EquipmentDefinitionId;
  assetKey: string;
  partId?: AppearancePartId;
}): { catalog: PlayerAppearanceCatalog; appearance: AppearanceDefinition } {
  const variant = input.itemVariants.variants.find(
    (candidate) => candidate.definitionId === input.definitionId
  );
  const definition = EQUIPMENT_DEFINITIONS[input.definitionId];
  if (!definition) throw new Error(`Unknown equipment definition: ${input.definitionId}`);
  const familyId = variant?.familyId ?? definition.gameplayFamilyId;
  const baseDefinitionId = EQUIPMENT_GAMEPLAY_FAMILIES[
    familyId
  ].authoringBaseDefinitionId;
  const existing = variant
    ? input.catalog.appearances.find(
        (appearance) => appearance.appearanceId === variant.appearanceId
      )
    : input.catalog.appearances.find(
        (appearance) =>
          !appearance.cosmetic &&
          appearance.equipmentDefinitionId === input.definitionId
      );
  if (existing) {
    const existingLayer = input.catalog.families.find(
      (family) => family.familyId === existing.familyId
    )?.authoringLayer;
    const appearance = withAppearanceAsset(
      existing,
      input.assetKey,
      input.partId,
      existingLayer
    );
    return {
      catalog: {
        ...input.catalog,
        appearances: input.catalog.appearances.map((candidate) =>
          candidate.appearanceId === existing.appearanceId ? appearance : candidate
        )
      },
      appearance
    };
  }
  const family = familyForEquipment(input.catalog, familyId);
  const appearanceId = uniqueAppearanceId(input.catalog, input.definitionId);
  const appearance: AppearanceDefinition = {
    appearanceId,
    displayName: definition.displayName,
    familyId: family.familyId,
    ...appearanceAsset(input.assetKey, input.partId, family.authoringLayer),
    cosmetic: false,
    ...(variant
      ? { compatibleEquipmentDefinitionIds: [baseDefinitionId] }
      : { equipmentDefinitionId: input.definitionId }),
    placements: {}
  };
  return {
    catalog: {
      ...input.catalog,
      appearances: [...input.catalog.appearances, appearance]
    },
    appearance
  };
}

export function createStyleAppearanceDraft(input: {
  catalog: PlayerAppearanceCatalog;
  appearanceId: string;
  displayName: string;
  familyId: string;
  assetKey: string;
}): { catalog: PlayerAppearanceCatalog; appearance: AppearanceDefinition } {
  const appearanceId = input.appearanceId.trim();
  const displayName = input.displayName.trim();
  if (!CONTENT_ID.test(appearanceId)) {
    throw new Error("Appearance IDs use lowercase letters, digits, underscores, and hyphens");
  }
  if (!displayName) throw new Error("Display name is required");
  if (input.catalog.appearances.some((appearance) =>
    appearance.appearanceId === appearanceId
  )) {
    throw new Error(`Appearance ID already exists: ${appearanceId}`);
  }
  const family = input.catalog.families.find(({ familyId }) =>
    familyId === input.familyId
  );
  if (!family || !["hair", "eyes", "nose_mouth", "nose", "mouth", "mask"].includes(family.categoryId)) {
    throw new Error(`Unknown avatar-style family: ${input.familyId}`);
  }
  const appearance: AppearanceDefinition = {
    appearanceId,
    displayName,
    familyId: family.familyId,
    assetKey: input.assetKey,
    cosmetic: true,
    ...(["hair", "eyes", "nose_mouth", "nose", "mouth"].includes(family.categoryId)
      ? {
          salon: {
            state: "selectable" as const,
            accessType: "free" as const,
            gameCreditPrice: 0 as const,
            productId: null
          }
        }
      : {}),
    placements: {}
  };
  return {
    catalog: {
      ...input.catalog,
      appearances: [...input.catalog.appearances, appearance]
    },
    appearance
  };
}

export function familyForCategory(
  catalog: PlayerAppearanceCatalog,
  categoryId: PlayerAppearanceCategoryId,
  familyId?: string
): AppearanceFamily {
  const families = catalog.families.filter((family) =>
    family.categoryId === categoryId && family.familyId !== "back_item"
  );
  const family = families.find((candidate) => candidate.familyId === familyId) ?? families[0];
  if (!family) throw new Error(`No appearance family exists for ${categoryId}`);
  return family;
}

export function familyForEquipment(
  catalog: PlayerAppearanceCatalog,
  gameplayFamilyId: EquipmentGameplayFamilyId,
  authoringLayer?: PlayerAuthoringLayerId
): AppearanceFamily {
  const definition = EQUIPMENT_GAMEPLAY_FAMILIES[gameplayFamilyId];
  const definitionId = definition.authoringBaseDefinitionId;
  const preferredFamilyId = definition.weaponCategory === "sword"
    ? "one_handed_sword"
    : definition.weaponCategory === "axe"
      ? "one_handed_axe"
      : definition.weaponCategory === "bow"
        ? "bow"
        : definition.weaponCategory === "staff"
          ? "staff"
          : definition.category === "shield"
            ? "shield"
            : definition.category === "head_armor"
              ? "head_armor"
              : definition.category === "chest_armor"
                ? `chest_${gameplayFamilyId}`
                : definition.category;
  const compatible = catalog.families.filter((family) =>
    family.compatibleEquipmentDefinitionIds.includes(definitionId)
  );
  const family = compatible.find((candidate) =>
    authoringLayer
      ? candidate.authoringLayer === authoringLayer
      : candidate.familyId === preferredFamilyId
  ) ?? compatible.find((candidate) =>
    !authoringLayer || candidate.authoringLayer === authoringLayer
  );
  if (!family) {
    throw new Error(
      `No ${authoringLayer ?? "appearance"} family supports ${definitionId}`
    );
  }
  return family;
}

export function saveFamilyPosePreset(
  catalog: PlayerAppearanceCatalog,
  familyId: string,
  poseId: PlayerCombatPoseId,
  placement: AppearancePlacement
): PlayerAppearanceCatalog {
  return {
    ...catalog,
    families: catalog.families.map((family) =>
      family.familyId === familyId
        ? {
            ...family,
            placements: {
              ...family.placements,
              [poseId]: { ...placement }
            }
          }
        : family
    )
  };
}

export function createPlayerOverlayAppearanceDraft(input: {
  catalog: PlayerAppearanceCatalog;
  appearanceId: string;
  displayName: string;
  familyId: string;
  assetKey: string;
}): { catalog: PlayerAppearanceCatalog; appearance: AppearanceDefinition } {
  const appearanceId = input.appearanceId.trim();
  const displayName = input.displayName.trim();
  if (!CONTENT_ID.test(appearanceId)) {
    throw new Error("Appearance IDs use lowercase letters, digits, underscores, and hyphens");
  }
  if (!displayName) throw new Error("Display name is required");
  if (input.catalog.appearances.some((appearance) =>
    appearance.appearanceId === appearanceId
  )) {
    throw new Error(`Appearance ID already exists: ${appearanceId}`);
  }
  const family = input.catalog.families.find((candidate) =>
    candidate.familyId === input.familyId && playerOverlaySlotForFamily(candidate) !== null
  );
  if (!family) throw new Error(`Unknown player overlay family: ${input.familyId}`);
  if (family.compatibleEquipmentDefinitionIds.length > 0) {
    throw new Error("Equipment-backed appearance families are authored under Gear");
  }
  const appearance: AppearanceDefinition = {
    appearanceId,
    displayName,
    familyId: family.familyId,
    assetKey: input.assetKey,
    cosmetic: false,
    placements: {}
  };
  return {
    catalog: {
      ...input.catalog,
      appearances: [...input.catalog.appearances, appearance]
    },
    appearance
  };
}

export function setFamilyPlayerOverlaySlot(
  catalog: PlayerAppearanceCatalog,
  familyId: string,
  playerOverlaySlot: PlayerOverlaySlotId | null
): PlayerAppearanceCatalog {
  const anchorForPart = (
    partId: AppearancePartId,
    fallback: PlayerOverlaySlotId
  ) => {
    if (fallback === "hands") return partId === "right" ? "right_hand" : "left_hand";
    if (fallback === "feet") return partId === "right" ? "right_foot" : "left_foot";
    return PLAYER_OVERLAY_ANCHOR[fallback];
  };
  return {
    ...catalog,
    families: catalog.families.map((family) => {
      if (family.familyId !== familyId) return family;
      if (playerOverlaySlot === null) return { ...family, playerOverlaySlot };
      const anchorId = PLAYER_OVERLAY_ANCHOR[playerOverlaySlot];
      const layer = PLAYER_OVERLAY_RENDER_LAYER[playerOverlaySlot];
      return {
        ...family,
        playerOverlaySlot,
        placements: Object.fromEntries(Object.entries(family.placements).map(
          ([poseId, placement]) => [poseId, { ...placement, anchorId, layer }]
        )) as AppearanceFamily["placements"]
      };
    }),
    appearances: playerOverlaySlot === null
      ? catalog.appearances
      : catalog.appearances.map((appearance) => {
          if (appearance.familyId !== familyId || !appearance.parts) return appearance;
          return {
            ...appearance,
            parts: appearance.parts.map((part) => ({
              ...part,
              placements: {
                ...part.placements,
                idle: {
                  ...part.placements?.idle,
                  anchorId: anchorForPart(part.partId, playerOverlaySlot)
                }
              }
            }))
          };
        })
  };
}

export function itemAppearanceForDefinition(
  catalog: PlayerAppearanceCatalog,
  itemVariants: ItemVariantCatalog,
  definitionId: EquipmentDefinitionId
): AppearanceDefinition | null {
  const variant = itemVariants.variants.find(
    (candidate) => candidate.definitionId === definitionId
  );
  if (variant) {
    return catalog.appearances.find(
      (appearance) => appearance.appearanceId === variant.appearanceId
    ) ?? null;
  }
  return catalog.appearances.find((appearance) =>
    !appearance.cosmetic &&
    appearance.equipmentDefinitionId === definitionId
  ) ?? catalog.appearances.find((appearance) =>
    !appearance.cosmetic &&
    appearanceCompatibleWithEquipment(catalog, appearance.appearanceId, definitionId)
  ) ?? null;
}

function uniqueAppearanceId(
  catalog: PlayerAppearanceCatalog,
  definitionId: string
): string {
  if (!catalog.appearances.some(({ appearanceId }) => appearanceId === definitionId)) {
    return definitionId;
  }
  let suffix = 2;
  while (catalog.appearances.some(
    ({ appearanceId }) => appearanceId === `${definitionId}_appearance_${suffix}`
  )) suffix += 1;
  return `${definitionId}_appearance_${suffix}`;
}

function appearanceAsset(
  assetKey: string,
  partId: AppearancePartId = "main",
  layer?: PlayerAuthoringLayerId
): Pick<AppearanceDefinition, "assetKey" | "parts"> {
  if (partId === "main") return { assetKey };
  if (!isPairedAuthoringLayer(layer)) {
    const placements = pairedPartPlacements(partId, layer);
    return {
      parts: [{
        partId,
        assetKey,
        ...(placements ? { placements } : {})
      }]
    };
  }
  return {
    parts: (["right", "left"] as const).map((pairedPartId) => ({
      partId: pairedPartId,
      assetKey,
      placements: pairedPartPlacements(pairedPartId, layer)!
    }))
  };
}

function withAppearanceAsset(
  appearance: AppearanceDefinition,
  assetKey: string,
  partId: AppearancePartId = "main",
  layer?: PlayerAuthoringLayerId
): AppearanceDefinition {
  if (partId === "main") {
    const { parts: _parts, ...single } = appearance;
    void _parts;
    return { ...single, assetKey };
  }
  const parts = appearance.parts ?? [];
  if (!isPairedAuthoringLayer(layer)) {
    const existing = parts.find((part) => part.partId === partId);
    const placements = pairedPartPlacements(partId, layer);
    const { assetKey: _assetKey, ...singlePart } = appearance;
    void _assetKey;
    return {
      ...singlePart,
      parts: existing
        ? parts.map((part) => part.partId === partId ? { ...part, assetKey } : part)
        : [...parts, { partId, assetKey, ...(placements ? { placements } : {}) }]
    };
  }
  const { assetKey: _assetKey, ...paired } = appearance;
  void _assetKey;
  const pairedParts = parts.map((part) =>
    part.partId === "right" || part.partId === "left"
      ? { ...part, assetKey }
      : part
  );
  for (const pairedPartId of ["right", "left"] as const) {
    if (pairedParts.some((part) => part.partId === pairedPartId)) continue;
    pairedParts.push({
      partId: pairedPartId,
      assetKey,
      placements: pairedPartPlacements(pairedPartId, layer)!
    });
  }
  return {
    ...paired,
    parts: pairedParts
  };
}

function isPairedAuthoringLayer(
  layer?: PlayerAuthoringLayerId
): layer is "gloves" | "boots" {
  return layer === "gloves" || layer === "boots";
}

function pairedPartPlacements(
  partId: AppearancePartId,
  layer?: PlayerAuthoringLayerId
) {
  if (partId === "left") {
    return {
      idle: {
        anchorId: layer === "boots" || layer === "feet" ? "left_foot" as const : "left_hand" as const,
        ...(isPairedAuthoringLayer(layer) ? { scaleX: -1 } : {})
      }
    };
  }
  if (partId === "right") {
    return { idle: { anchorId: layer === "boots" || layer === "feet" ? "right_foot" as const : "right_hand" as const } };
  }
  return undefined;
}
