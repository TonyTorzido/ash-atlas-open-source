import {
  PROGRESSION_ICON_PRESENTATION_CATALOG,
  progressionIconKey,
  progressionIconRegistryEntry,
  type SpecializationId
} from "@ash-atlas/shared";

import type { ProgressionSpriteSource } from "./ProgressionIcon.js";

const CLASS_ICON_ATLAS_SRC = `${import.meta.env.BASE_URL}assets/skills/class-icons-v3.png`;
const CLASS_ICON_ATLAS_CELL_SIZE = 256;

function atlasCell(id: SpecializationId): ProgressionSpriteSource {
  const entry = progressionIconRegistryEntry("class", id);
  const transform = PROGRESSION_ICON_PRESENTATION_CATALOG.transforms[progressionIconKey("class", id)]!;
  return {
    src: CLASS_ICON_ATLAS_SRC,
    x: (entry.index % entry.columns) * entry.cellSize,
    y: Math.floor(entry.index / entry.columns) * entry.cellSize,
    width: CLASS_ICON_ATLAS_CELL_SIZE,
    height: CLASS_ICON_ATLAS_CELL_SIZE,
    key: id,
    ...transform,
  };
}

export const CLASS_SPRITES = {
  warrior: atlasCell("warrior"), knight: atlasCell("knight"), legionnaire: atlasCell("legionnaire"),
  ranger: atlasCell("ranger"), mercenary: atlasCell("mercenary"),
  sentinel: atlasCell("sentinel"), assassin: atlasCell("assassin"), ninja: atlasCell("ninja"),
  monk: atlasCell("monk"), rogue: atlasCell("rogue"),
  druid: atlasCell("druid"), merchant: atlasCell("merchant"), artificer: atlasCell("artificer"), voyager: atlasCell("voyager"),
  // Ronin reuses the Ninja cell until it gets its own art.
  ronin: atlasCell("ronin"),
} as const satisfies Readonly<Record<SpecializationId, ProgressionSpriteSource>>;

export function classIconProps(id: SpecializationId): Readonly<{
  iconKey: SpecializationId;
  sprite: ProgressionSpriteSource;
}> {
  return { iconKey: id, sprite: CLASS_SPRITES[id] };
}
