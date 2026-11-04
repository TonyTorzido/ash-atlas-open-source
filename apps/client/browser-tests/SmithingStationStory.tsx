import {
  emptyEquipmentSlots,
  requireEquipmentDefinition,
  resolveEquipmentCombatStats,
  resolveEquipmentItemDerivedStats,
  type EquipmentInstanceV2,
  type EquipmentSnapshotV2
} from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import { SmithingStationPanel } from "../src/ui/SmithingStationPanel.js";

const INSTANCE_ID = "00000000-0000-4000-8000-000000000013";

export function SmithingStationStory(): React.JSX.Element {
  const [characterLevel, setCharacterLevel] = useState(12);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    const applyLevelThirteen = (): void => setCharacterLevel(13);
    window.addEventListener("smithing-story-level-thirteen", applyLevelThirteen);
    return () => window.removeEventListener(
      "smithing-story-level-thirteen",
      applyLevelThirteen
    );
  }, []);
  return (
    <SmithingStationPanel
      open
      equipment={snapshot(characterLevel)}
      walletGold="500"
      online
      busy={false}
      feedback={submitted
        ? {
            kind: "success",
            requestId: "browser-upgrade",
            instanceId: INSTANCE_ID,
            displayName: "Personal Sword",
            levelAfter: 13
          }
        : null}
      layout="desktop"
      manorSession={{ sessionId: "manor-session", accessSource: "OWNER" }}
      onUpgrade={() => {
        setSubmitted(true);
        return "browser-upgrade";
      }}
      onRetryData={() => undefined}
      onClose={() => undefined}
    />
  );
}

function snapshot(characterLevel: number): EquipmentSnapshotV2 {
  const item = sword(characterLevel);
  return {
    snapshotVersion: 2,
    balanceVersion: 2,
    playerId: "browser-player",
    characterLevel,
    repairMessage: null,
    instances: [item],
    active: emptyEquipmentSlots(null),
    readiedWeaponSlot: "melee",
    activeKitIndex: null,
    kits: [],
    inventoryRevision: 1,
    activeRevision: 1,
    checkpointRevision: 1,
    derivedStats: resolveEquipmentCombatStats({
      context: "pvp_open_world",
      characterLevel,
      classId: "warrior",
      classRank: 0,
      loadout: {
        active: emptyEquipmentSlots(null),
        readiedWeaponSlot: "melee"
      }
    }),
    weapon: null,
    chest: null,
    totalAttackPowerBonus: 0,
    totalDefenseBonus: 0
  };
}

function sword(characterLevel: number): EquipmentInstanceV2 {
  const definition = requireEquipmentDefinition("starter_sword");
  const derived = resolveEquipmentItemDerivedStats({
    item: { instanceId: INSTANCE_ID, definition, itemLevel: 12 },
    slot: "melee",
    classId: "warrior"
  });
  return {
    instanceId: INSTANCE_ID,
    definitionId: "starter_sword",
    displayName: "Personal Sword",
    ownerPlayerId: "browser-player",
    location: "equipped",
    equippedSlot: "melee",
    itemLevel: 12,
    maximumItemLevel: 25,
    category: definition.category,
    balanceVersion: 2,
    enchantmentIdentity: null,
    attackPowerBonus: Math.round(derived.pveAttackContribution),
    defenseBonus: Math.round(derived.pveDefenseContribution),
    weaponCategory: definition.weaponCategory,
    armorCategory: definition.armorCategory,
    twoHanded: definition.twoHanded,
    savedKitIndices: [],
    derived,
    nextUpgradeLevel: 13,
    nextUpgradeCost: "450",
    upgradeDisabledReason: characterLevel < 13 ? "character_level_required" : null,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z"
  };
}
