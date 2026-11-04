import {
  PROGRESSION_ICON_PRESENTATION_CATALOG,
  progressionIconKey,
  progressionIconRegistryEntry,
  type ProfessionId,
  type TradeSkillId
} from "@ash-atlas/shared";

import type { ProgressionSpriteSource } from "./ProgressionIcon.js";

const PROFESSION_ICON_ATLAS_SRC = `${import.meta.env.BASE_URL}assets/skills/profession-icons-v3.png`;
const PROFESSION_SKILL_ICON_ATLAS_SRC = `${import.meta.env.BASE_URL}assets/skills/profession-skill-icons-v3.png`;
const PROFESSION_ICON_ATLAS_CELL_SIZE = 256;

function atlasCell(id: ProfessionId): ProgressionSpriteSource {
  const entry = progressionIconRegistryEntry("profession", id);
  const transform = PROGRESSION_ICON_PRESENTATION_CATALOG.transforms[progressionIconKey("profession", id)]!;
  return {
    src: entry.atlasPath.endsWith("profession-skill-icons-v3.png") ? PROFESSION_SKILL_ICON_ATLAS_SRC : PROFESSION_ICON_ATLAS_SRC,
    x: (entry.index % entry.columns) * entry.cellSize,
    y: Math.floor(entry.index / entry.columns) * entry.cellSize,
    width: PROFESSION_ICON_ATLAS_CELL_SIZE,
    height: PROFESSION_ICON_ATLAS_CELL_SIZE,
    key: id,
    ...transform,
  };
}

function professionSkillAtlasCell(id: TradeSkillId): ProgressionSpriteSource {
  const entry = progressionIconRegistryEntry("profession-skill", id);
  const transform = PROGRESSION_ICON_PRESENTATION_CATALOG.transforms[progressionIconKey("profession-skill", id)]!;
  return {
    src: PROFESSION_SKILL_ICON_ATLAS_SRC,
    x: (entry.index % entry.columns) * entry.cellSize,
    y: Math.floor(entry.index / entry.columns) * entry.cellSize,
    width: PROFESSION_ICON_ATLAS_CELL_SIZE,
    height: PROFESSION_ICON_ATLAS_CELL_SIZE,
    key: id,
    ...transform,
  };
}

export const PROFESSION_SPRITES = {
  woodcutter: atlasCell("woodcutter"), miner: atlasCell("miner"),
  oil_worker: atlasCell("oil_worker"), builder: atlasCell("builder"),
  metallurgy: atlasCell("metallurgy"),
} as const satisfies Readonly<Record<ProfessionId, ProgressionSpriteSource>>;

export const PROFESSION_SKILL_SPRITES = {
  blacksmithing: professionSkillAtlasCell("blacksmithing"), leatherworking: professionSkillAtlasCell("leatherworking"),
  alchemy: professionSkillAtlasCell("alchemy"),
  cartography: professionSkillAtlasCell("cartography"), tradecraft: professionSkillAtlasCell("tradecraft"),
} as const satisfies Readonly<Record<TradeSkillId, ProgressionSpriteSource>>;

export function professionIconProps(id: ProfessionId): Readonly<{
  iconKey: ProfessionId;
  sprite: ProgressionSpriteSource;
}> {
  return { iconKey: id, sprite: PROFESSION_SPRITES[id] };
}

export function professionSkillIconProps(id: TradeSkillId): Readonly<{
  iconKey: TradeSkillId;
  sprite: ProgressionSpriteSource;
}> {
  return { iconKey: id, sprite: PROFESSION_SKILL_SPRITES[id] };
}
