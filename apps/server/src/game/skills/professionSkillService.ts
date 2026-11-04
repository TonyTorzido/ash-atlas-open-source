import { ALCHEMY_RECIPE_DEFINITIONS_V3, type AlchemyRecipeDefinitionV3 } from "@ash-atlas/shared";

/**
 * Alchemy recipe seam. The trade skills (Alchemy, Blacksmithing, Leatherworking, Cartography,
 * Tradecraft) are ordinary General Skills now; their rank checks live in `tradeSkillRank.ts`.
 */
export class ProfessionSkillV3Service {
  alchemyRecipes(): readonly AlchemyRecipeDefinitionV3[] {
    return ALCHEMY_RECIPE_DEFINITIONS_V3;
  }
}
