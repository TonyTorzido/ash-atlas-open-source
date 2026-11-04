import { requireEquipmentDefinition, ringTierForDefinitionId, type ItemRarity, type RingTier } from "@ash-atlas/shared";

const RING_TIER_RARITY: Readonly<Record<RingTier, ItemRarity>> = {
  plain: "common", fine: "uncommon", prime: "rare", peerless: "epic"
};

/** Loot-card entries for rings found on a kill, named by tier ("Fine Ring"). */
export function ringLootEntries(
  idStem: string,
  rings: readonly Readonly<{ definitionId: string; onGround: boolean; lost?: boolean }>[]
): LootCardEntry[] {
  return rings.map((ring, index) => {
    const tier = ringTierForDefinitionId(ring.definitionId);
    let name = ring.definitionId;
    try { name = requireEquipmentDefinition(ring.definitionId).displayName; } catch { /* unknown id: show raw */ }
    return {
      key: `${idStem}:ring:${index}`,
      kind: ring.onGround ? "ground" : "item",
      itemId: ring.definitionId,
      name: ring.lost ? `Found a ${name} (no room; lost)` : `Found a ${name}`,
      quantity: 1,
      rarity: tier ? RING_TIER_RARITY[tier] : "common"
    };
  });
}

/** How long a loot card stays up; bosses linger so the guaranteed drop is not missed. */
export const LOOT_CARD_VISIBLE_MS = 5_200;
export const LOOT_CARD_BOSS_VISIBLE_MS = 7_500;
/** Newest cards win: a fourth card pushes the oldest off. */
export const LOOT_CARD_MAX = 3;

export type LootCardEntryKind = "item" | "gold" | "ground";

export type LootCardEntry = Readonly<{
  key: string;
  kind: LootCardEntryKind;
  /** Item art id; null for gold. */
  itemId: string | null;
  name: string;
  quantity: number;
  rarity: ItemRarity;
}>;

export type LootCard = Readonly<{
  /** Stable per reward event, so a replayed frame never shows a second card. */
  id: string;
  source: "kill" | "chest" | "gift";
  boss: boolean;
  eyebrow: string | null;
  heading: string;
  entries: readonly LootCardEntry[];
  createdAtMs: number;
  expiresAtMs: number;
}>;

export type LootItemLookup = (itemId: string) => Readonly<{ name: string; rarity: ItemRarity }>;

const RARITY_ORDER: Readonly<Record<ItemRarity, number>> = {
  legendary: 0, epic: 1, rare: 2, uncommon: 3, common: 4
};

type Line = Readonly<{ itemId: string; quantity: number }>;

function entriesFor(
  idStem: string,
  gold: number,
  delivered: readonly Line[],
  ground: readonly Line[],
  lookup: LootItemLookup
): LootCardEntry[] {
  const merge = (lines: readonly Line[]): Map<string, number> => {
    const totals = new Map<string, number>();
    for (const line of lines) {
      if (line.quantity > 0) totals.set(line.itemId, (totals.get(line.itemId) ?? 0) + line.quantity);
    }
    return totals;
  };
  const itemEntries = (lines: readonly Line[], kind: "item" | "ground"): LootCardEntry[] =>
    [...merge(lines)].map(([itemId, quantity]): LootCardEntry => {
      const described = lookup(itemId);
      return { key: `${idStem}:${kind}:${itemId}`, kind, itemId, name: described.name, quantity, rarity: described.rarity };
    }).sort((left, right) => RARITY_ORDER[left.rarity] - RARITY_ORDER[right.rarity]);
  return [
    ...(gold > 0
      ? [{ key: `${idStem}:gold`, kind: "gold", itemId: null, name: "Gold", quantity: gold, rarity: "common" } as const]
      : []),
    ...itemEntries(delivered, "item"),
    ...itemEntries(ground, "ground")
  ];
}

/** The reveal for a mob kill. Null when the kill paid nothing visible (XP-only). */
export function killLootCard(
  message: Readonly<{
    settlementKey: string;
    items: readonly Line[];
    drops: readonly Line[];
    gold: number;
    mobName?: string;
    boss?: boolean;
    rings?: readonly Readonly<{ definitionId: string; onGround: boolean; lost?: boolean }>[];
  }>,
  lookup: LootItemLookup,
  nowMs: number
): LootCard | null {
  const id = `kill:${message.settlementKey}`;
  const entries = [
    ...ringLootEntries(id, message.rings ?? []),
    ...entriesFor(id, message.gold, message.items, message.drops, lookup)
  ];
  if (entries.length === 0) return null;
  const boss = message.boss === true;
  return {
    id, source: "kill", boss, entries,
    eyebrow: boss ? "Boss defeated" : null,
    heading: message.mobName ?? "Spoils",
    createdAtMs: nowMs,
    expiresAtMs: nowMs + (boss ? LOOT_CARD_BOSS_VISIBLE_MS : LOOT_CARD_VISIBLE_MS)
  };
}

/** The reveal for a freshly claimed dungeon chest. Replays and empty claims are told by the dungeon notice instead. */
export function chestLootCard(
  frame: Readonly<{ runId: string; rewardSourceId: string; applied: boolean; items: readonly Line[]; gold: number }>,
  lookup: LootItemLookup,
  nowMs: number
): LootCard | null {
  if (!frame.applied) return null;
  const id = `chest:${frame.runId}:${frame.rewardSourceId}`;
  const entries = entriesFor(id, frame.gold, frame.items, [], lookup);
  if (entries.length === 0) return null;
  return {
    id, source: "chest", boss: false, entries, eyebrow: null, heading: "Chest opened",
    createdAtMs: nowMs, expiresAtMs: nowMs + LOOT_CARD_VISIBLE_MS
  };
}

/**
 * The reveal for an opened player gift: only what was actually granted (partial claims show less),
 * through the same card mob kills use. Null when nothing was granted.
 */
export function giftLootCard(
  frame: Readonly<{
    package: Readonly<{ packageId: string }>;
    lines: readonly Readonly<{ itemKind: string; itemId: string; grantedQuantity: number }>[];
  }>,
  lookup: LootItemLookup,
  nowMs: number
): LootCard | null {
  const id = `gift:${frame.package.packageId}`;
  const granted = frame.lines.filter((line) => line.grantedQuantity > 0);
  const gold = granted.filter((line) => line.itemKind === "gold").reduce((total, line) => total + line.grantedQuantity, 0);
  const items = granted.filter((line) => line.itemKind !== "gold" && line.itemKind !== "city_coins")
    .map((line) => ({ itemId: line.itemId, quantity: line.grantedQuantity }));
  const equipmentNames = (itemId: string): ReturnType<LootItemLookup> => {
    try { return { name: requireEquipmentDefinition(itemId).displayName, rarity: "common" }; } catch { return lookup(itemId); }
  };
  const equipmentIds = new Set(granted.filter((line) => line.itemKind === "equipment").map((line) => line.itemId));
  const entries = entriesFor(id, gold, items, [], (itemId) => equipmentIds.has(itemId) ? equipmentNames(itemId) : lookup(itemId));
  if (entries.length === 0) return null;
  return {
    id, source: "gift", boss: false, entries, eyebrow: null, heading: "Gift opened",
    createdAtMs: nowMs, expiresAtMs: nowMs + LOOT_CARD_VISIBLE_MS
  };
}

/** Live cards, oldest first. Owned by the combat presentation controller like floating feedback. */
export class LootCardState {
  private cards: LootCard[] = [];
  private readonly seen = new Set<string>();

  push(card: LootCard): boolean {
    if (this.seen.has(card.id)) return false;
    this.seen.add(card.id);
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value as string);
    this.cards = [...this.cards, card].slice(-LOOT_CARD_MAX);
    return true;
  }

  active(nowMs: number): readonly LootCard[] {
    return this.cards.filter((card) => card.expiresAtMs > nowMs);
  }

  prune(nowMs: number): void {
    this.cards = this.cards.filter((card) => card.expiresAtMs > nowMs);
  }

  clear(): void {
    this.cards = [];
    this.seen.clear();
  }
}
