import {
  PROGRESSION_ICON_PRESENTATION_CATALOG,
  progressionIconKey,
  progressionIconRegistryEntry,
  type GeneralSkillId,
  type TradeSkillId
} from "@ash-atlas/shared";

import type { ProgressionSpriteSource } from "./ProgressionIcon.js";
import { PROFESSION_SKILL_SPRITES } from "./ProfessionIcons.js";

const GENERAL_SKILL_ATLAS_SRC = `${import.meta.env.BASE_URL}assets/skills/general-skills-v3.png`;
const GENERAL_SKILL_ATLAS_CELL_SIZE = 256;

function atlasCell(id: Exclude<GeneralSkillId, TradeSkillId>): ProgressionSpriteSource {
  const entry = progressionIconRegistryEntry("general", id);
  const transform = PROGRESSION_ICON_PRESENTATION_CATALOG.transforms[progressionIconKey("general", id)]!;
  return {
    src: GENERAL_SKILL_ATLAS_SRC,
    x: (entry.index % entry.columns) * entry.cellSize,
    y: Math.floor(entry.index / entry.columns) * entry.cellSize,
    width: GENERAL_SKILL_ATLAS_CELL_SIZE,
    height: GENERAL_SKILL_ATLAS_CELL_SIZE,
    key: id,
    ...transform,
  };
}

export const GENERAL_SKILL_SPRITES = {
  cleave: atlasCell("cleave"), shield_charge: atlasCell("shield_charge"), provoke: atlasCell("provoke"),
  pursuit: atlasCell("pursuit"), pierce_armor: atlasCell("pierce_armor"), blight_strike: atlasCell("blight_strike"),
  second_wind: atlasCell("second_wind"), deathburst: atlasCell("deathburst"), archery: atlasCell("archery"),
  ricochet: atlasCell("ricochet"), quarry_sense: atlasCell("quarry_sense"), huntsmans_edge: atlasCell("huntsmans_edge"),
  concentration: atlasCell("concentration"), martial_arts: atlasCell("martial_arts"), perfect_strike: atlasCell("perfect_strike"),
  tactics: atlasCell("tactics"), taunt: atlasCell("taunt"), war_standard: atlasCell("war_standard"),
  heroism: atlasCell("heroism"), cleanse: atlasCell("cleanse"), calm_mind: atlasCell("calm_mind"),
  scavenge: atlasCell("scavenge"), companion_bond: atlasCell("companion_bond"), delvers_lore: atlasCell("delvers_lore"),
  // The trade skills draw from the profession-skill atlas.
  ...PROFESSION_SKILL_SPRITES,
} as const satisfies Readonly<Record<GeneralSkillId, ProgressionSpriteSource>>;

type GeneralSkillIconProps = Readonly<{ iconKey: GeneralSkillId; sprite: ProgressionSpriteSource }>;

export function generalSkillIconProps(id: GeneralSkillId): GeneralSkillIconProps {
  return { iconKey: id, sprite: GENERAL_SKILL_SPRITES[id] };
}
