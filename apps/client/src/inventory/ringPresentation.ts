import {
  RING_TIER_RULES,
  formatRingBonusValue,
  resolveWornRingBonuses,
  ringBonusDefinition,
  ringBonusLabel,
  ringBonusValue,
  ringDumpShards,
  ringPolishCost,
  wornRingMetals,
  EQUIPMENT_SLOTS,
  isGatheringToolSlot,
  type EquipmentInstanceV2,
  type EquipmentSlot,
  type EquipmentSnapshotV2,
  type RingInstanceView,
  type WornRing,
  type WornRingBonusState
} from "@ash-atlas/shared";

export type RingBonusPresentation = Readonly<{
  key: string;
  label: string;
  value: string;
  note: string | null;
  state: WornRingBonusState;
}>;

export function isRoughRing(item: EquipmentInstanceV2): boolean {
  return item.ring?.rough === true;
}

/** First empty ring slot, else the first slot (the server swaps the worn ring back to inventory). */
export function ringEquipSlot(equipment: EquipmentSnapshotV2 | null): EquipmentSlot {
  if (!equipment?.active.ring) return "ring";
  if (!equipment.active.ring_2) return "ring_2";
  return "ring";
}

function wornRing(item: EquipmentInstanceV2 | null): WornRing | null {
  if (!item?.ring) return null;
  return { instanceId: item.instanceId, tier: item.ring.tier, rough: item.ring.rough, bonuses: item.ring.bonuses };
}

/**
 * Bonus lines for a ring tooltip. Worn rings resolve against each other (duplicates grey out);
 * an unworn ring shows what it would do on its own. Rows with no hook today read "inactive".
 */
export function ringBonusPresentation(
  item: EquipmentInstanceV2,
  equipment: EquipmentSnapshotV2 | null
): RingBonusPresentation[] {
  const ring = item.ring;
  if (!ring || ring.rough) return [];
  const worn = item.location === "equipped" && equipment
    ? [wornRing(equipment.active.ring), wornRing(equipment.active.ring_2)]
    : [wornRing(item)];
  const metals = wornRingMetals(equipment
    ? EQUIPMENT_SLOTS.filter((slot) => slot !== "ring" && slot !== "ring_2" && !isGatheringToolSlot(slot))
      .map((slot) => equipment.active[slot]?.enchantmentIdentity ?? null)
    : []);
  const lines = resolveWornRingBonuses(worn, metals).lines.filter((line) => line.instanceId === item.instanceId);
  return ring.bonuses.map((roll) => {
    const definition = ringBonusDefinition(roll.id);
    const line = lines.find((entry) => entry.id === roll.id);
    return {
      key: roll.family ? `${roll.id}:${roll.family}` : roll.id,
      label: ringBonusLabel(roll),
      value: formatRingBonusValue(roll.id, ringBonusValue(ring.tier, roll.id)),
      note: definition?.note ?? null,
      state: line?.state ?? "inactive"
    };
  });
}

/** Bonus lines for a ring seen on its own (market listing): no duplicate check, wiring only. */
export function ringViewBonusPresentation(ring: RingInstanceView, instanceId: string): RingBonusPresentation[] {
  const lines = resolveWornRingBonuses([
    { instanceId, tier: ring.tier, rough: ring.rough, bonuses: ring.bonuses }
  ]).lines;
  return ring.bonuses.map((roll) => {
    const definition = ringBonusDefinition(roll.id);
    return {
      key: roll.family ? `${roll.id}:${roll.family}` : roll.id,
      label: ringBonusLabel(roll),
      value: formatRingBonusValue(roll.id, ringBonusValue(ring.tier, roll.id)),
      note: definition?.note ?? null,
      state: lines.find((entry) => entry.id === roll.id)?.state ?? "inactive"
    };
  });
}

export function ringTierName(item: EquipmentInstanceV2): string | null {
  return item.ring ? RING_TIER_RULES[item.ring.tier].displayName : null;
}

export function ringPolishLabel(item: EquipmentInstanceV2): string | null {
  if (!item.ring?.rough) return null;
  const normal = ringPolishCost(item.ring.tier, false);
  const pass = ringPolishCost(item.ring.tier, true);
  return `Polish · ${normal} Glimmer Oil (${pass} with Atlas Pass)`;
}

export function ringDumpShardCount(item: EquipmentInstanceV2): number | null {
  return item.ring ? ringDumpShards(item.ring.tier, item.ring.rough) : null;
}

export function ringStateLabel(state: WornRingBonusState): string | null {
  switch (state) {
    case "active": return null;
    case "duplicate": return "duplicate";
    case "inactive": return "inactive";
  }
}
