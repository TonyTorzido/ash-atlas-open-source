import { describe, expect, it } from "vitest";

import {
  EQUIPMENT_DEFINITIONS,
  GATHERING_TOOL_CATEGORY_BY_KIND,
  GATHERING_TOOL_FAMILIES,
  GATHERING_TOOL_SLOT_BY_KIND,
  gatheringToolKindForDefinition,
} from "./equipment.js";
import { resolveEquipmentCombatStats } from "./equipmentBalance.js";
import { emptyEquipmentSlots, type EquipmentSnapshotV2 } from "./equipment.js";
import { baseAppearanceForEquipment, projectPlayerAppearance } from "./appearance.js";
import { DEFAULT_PLAYER_APPEARANCE_CATALOG } from "./appearanceCatalog.js";

const TOOLS = [
  ["wooden_axe", "chop", 1, "tool_axe", "gathering_axe"],
  ["stone_axe", "chop", 2, "tool_axe", "gathering_axe"],
  ["wooden_pickaxe", "mine", 1, "tool_pickaxe", "gathering_pickaxe"],
  ["stone_pickaxe", "mine", 2, "tool_pickaxe", "gathering_pickaxe"],
  ["starter_fishing_pole", "fish", 1, "tool_fishing_pole", "gathering_fishing_pole"]
] as const;

describe("gathering tools", () => {
  it("are tradable stock items of their own families in their kind's slot with zero stats", () => {
    for (const [definitionId, kind, tier, slot, category] of TOOLS) {
      const definition = EQUIPMENT_DEFINITIONS[definitionId];
      expect(definition).toMatchObject({
        slot,
        category,
        equipmentRole: "stock",
        marketTradable: true,
        basePveAttackContribution: 0,
        basePveDefenseContribution: 0,
        utilityKind: "none",
        weaponCategory: null,
        gameplayFamilyId: definitionId
      });
      expect(GATHERING_TOOL_FAMILIES[definitionId]).toMatchObject({ kind, tier });
      expect(gatheringToolKindForDefinition(definitionId)).toBe(kind);
    }
    expect(gatheringToolKindForDefinition("training_axe")).toBeNull();
  });

  it("puts every tool family (and so every future tier or skin) in its kind's slot", () => {
    for (const tool of Object.values(GATHERING_TOOL_FAMILIES)) {
      const definitions = Object.values(EQUIPMENT_DEFINITIONS)
        .filter((definition) => definition.gameplayFamilyId === tool!.familyId);
      expect(definitions.length).toBeGreaterThan(0);
      for (const definition of definitions) {
        expect(definition.slot).toBe(GATHERING_TOOL_SLOT_BY_KIND[tool!.kind]);
        expect(definition.category).toBe(GATHERING_TOOL_CATEGORY_BY_KIND[tool!.kind]);
      }
    }
  });

  it("adds nothing to combat stats when equipped at any level", () => {
    const base = {
      context: "pve" as const,
      characterLevel: 10,
      classId: "warrior" as const,
      classRank: 0
    };
    const empty = resolveEquipmentCombatStats({
      ...base,
      loadout: { readiedWeaponSlot: "melee", active: emptyEquipmentSlots(null) }
    });
    const tool = (definitionId: (typeof TOOLS)[number][0], n: number) => ({
      instanceId: `00000000-0000-4000-8000-00000000000${n}`,
      definition: EQUIPMENT_DEFINITIONS[definitionId],
      itemLevel: 25,
      enchantmentIdentity: "iron" as const
    });
    // Axe, pickaxe and pole all equipped together.
    const withTools = resolveEquipmentCombatStats({
      ...base,
      loadout: {
        readiedWeaponSlot: "melee",
        active: {
          ...emptyEquipmentSlots(null),
          tool_axe: tool("stone_axe", 1),
          tool_pickaxe: tool("stone_pickaxe", 2),
          tool_fishing_pole: tool("starter_fishing_pole", 3)
        }
      }
    });
    const { items: _items, ...withoutItems } = withTools;
    const { items: _emptyItems, ...emptyWithoutItems } = empty;
    void _items; void _emptyItems;
    expect(withoutItems).toEqual(emptyWithoutItems);
  });

  it("have catalog art but are never projected onto the idle sprite", () => {
    for (const [definitionId] of TOOLS) {
      expect(baseAppearanceForEquipment(DEFAULT_PLAYER_APPEARANCE_CATALOG, definitionId)?.assetKey)
        .toBe(`tools/${definitionId.replaceAll("_", "-")}.png`);
    }
    const equipment = {
      active: {
        ...emptyEquipmentSlots(null),
        tool_axe: { definitionId: "stone_axe", category: "gathering_axe", enchantmentIdentity: null },
        tool_pickaxe: { definitionId: "stone_pickaxe", category: "gathering_pickaxe", enchantmentIdentity: null },
        tool_fishing_pole: {
          definitionId: "starter_fishing_pole", category: "gathering_fishing_pole", enchantmentIdentity: null
        }
      },
      readiedWeaponSlot: "melee",
      activeRevision: 1
    } as unknown as EquipmentSnapshotV2;
    const slots = projectPlayerAppearance(equipment, DEFAULT_PLAYER_APPEARANCE_CATALOG).slots;
    for (const slot of ["tool_axe", "tool_pickaxe", "tool_fishing_pole"]) expect(slots).not.toHaveProperty(slot);
  });
});
