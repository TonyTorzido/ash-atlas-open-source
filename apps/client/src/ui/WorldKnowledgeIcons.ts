import type { WorldKnowledgeSkillId } from "@ash-atlas/shared";

const SKILL_ICON_ROOT = `${import.meta.env.BASE_URL}assets/skills/new/`;

/** Single-PNG icons for discovered World Knowledge (these are not part of the progression atlases). */
export const WORLD_KNOWLEDGE_ICON_SRC: Readonly<Record<WorldKnowledgeSkillId, string>> = {
  tidecraft: `${SKILL_ICON_ROOT}tidecraft.png`,
  rare_beast_mastery: `${SKILL_ICON_ROOT}rare-beast-mastery.png`,
  wildkin_lore: `${SKILL_ICON_ROOT}hollin-lore.png`,
  deepstone_lore: `${SKILL_ICON_ROOT}deepstone-lore.png`,
  grove_lore: `${SKILL_ICON_ROOT}grove-lore.png`,
  // Reuses the Deepstone icon until Edict Stride has its own art.
  edict_stride: `${SKILL_ICON_ROOT}deepstone-lore.png`,
  field_engineering: `${SKILL_ICON_ROOT}field-engineering.png`
};
