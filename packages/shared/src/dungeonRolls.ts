import type {
  DungeonChestRarity,
  DungeonDefinition,
  DungeonObjectDefinition,
  DungeonRewardTableDefinition,
  DungeonResourceSpawnZoneDefinition
} from "./dungeonCatalog.js";

/** Stable across reconnect/retry; callers use durable run and content identities. */
export function randomDungeonPointInShape(
  shape: DungeonResourceSpawnZoneDefinition["shape"],
  seed: string
): { x: number; y: number } | null {
  const random = (suffix: string) => dungeonPlacementHash(`${seed}:${suffix}`);
  if (shape.kind === "rectangle") {
    return {
      x: shape.x + random("x") * shape.width,
      y: shape.y + random("y") * shape.height
    };
  }
  const minX = Math.min(...shape.points.map((point) => point.x));
  const maxX = Math.max(...shape.points.map((point) => point.x));
  const minY = Math.min(...shape.points.map((point) => point.y));
  const maxY = Math.max(...shape.points.map((point) => point.y));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const point = {
      x: minX + random(`x:${attempt}`) * (maxX - minX),
      y: minY + random(`y:${attempt}`) * (maxY - minY)
    };
    if (pointInPolygon(point, shape.points)) return point;
  }
  return null;
}

function pointInPolygon(
  point: { x: number; y: number },
  polygon: readonly { x: number; y: number }[]
): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const current = polygon[index]!;
    const prior = polygon[previous]!;
    const intersects = ((current.y > point.y) !== (prior.y > point.y)) &&
      point.x < (prior.x - current.x) * (point.y - current.y) / (prior.y - current.y) + current.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function dungeonPlacementHash(seed: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) hash = Math.imul(hash ^ seed.charCodeAt(index), 16_777_619);
  return (hash >>> 0) % 1_000_000 / 1_000_000;
}

export function dungeonSeededRoll(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  // Avalanche adjacent slot/index seeds before projecting to [0, 1).
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15; hash = Math.imul(hash, 0x846ca68b); hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

export function dungeonRewardRollSeed(
  runId: string,
  rewardSourceId: string,
  table: Pick<DungeonRewardTableDefinition, "id" | "revision">
): string {
  return `${runId}:${rewardSourceId}:${table.id}:${table.revision}`;
}

export function resolveDungeonChestRarity(
  table: DungeonRewardTableDefinition,
  seed: string
): DungeonChestRarity | null {
  if (!table.chestLoot) return null;
  let rarityRoll = dungeonSeededRoll(`${seed}:rarity`) * 100;
  const rows = table.chestLoot.rarities;
  return rows.find((row) => {
    rarityRoll -= row.chance;
    return rarityRoll < 0;
  })?.rarity ?? rows[rows.length - 1]!.rarity;
}

export function dungeonChestAssetKey(
  table: DungeonRewardTableDefinition,
  rarity: DungeonChestRarity | null,
  fallbackAssetKey: string
): string {
  return table.chestLoot?.rarities.find((row) => row.rarity === rarity)?.assetKey ?? fallbackAssetKey;
}

/** Extra completion-chest slots for a run's torches: one per torch beyond the first, for `torchBonusSlots` tables. */
export function dungeonTorchBonusSlots(
  table: Pick<DungeonRewardTableDefinition, "torchBonusSlots">,
  torchTotal: number | undefined
): number {
  return table.torchBonusSlots ? Math.max(0, Math.floor(torchTotal ?? 1) - 1) : 0;
}

/** Each torch beyond the first adds this many percentage points to torch-scaled chance items. */
export const DUNGEON_TORCH_CHANCE_BONUS_PCT = 5;
export const DUNGEON_TORCH_CHANCE_BONUS_CAP_PCT = 25;

/** Bonus percentage points for a run's torches: +5 per torch beyond the first, capped at +25. */
export function dungeonTorchChanceBonusPct(torchTotal: number | undefined): number {
  return Math.min(DUNGEON_TORCH_CHANCE_BONUS_CAP_PCT,
    Math.max(0, Math.floor(torchTotal ?? 1) - 1) * DUNGEON_TORCH_CHANCE_BONUS_PCT);
}

export type DungeonChanceRollContext = Readonly<{
  /** Run torch total; scales entries flagged `torchScaling`. */
  torchTotal?: number | undefined;
  /** Claimant identity, so each member rolls independently from the same run seed. */
  memberId?: string;
}>;

export function resolveDungeonChestLoot(
  table: DungeonRewardTableDefinition,
  seed: string,
  bonusSlots = 0,
  chance: DungeonChanceRollContext = {}
): {
  rarity: DungeonChestRarity | null; items: Array<{ itemId: string; quantity: number }>;
} {
  const items = new Map<string, number>();
  let rarityResult: DungeonChestRarity | null = null;
  if (!table.chestLoot) {
    for (const item of table.items) items.set(item.itemId, (items.get(item.itemId) ?? 0) + item.quantity);
  } else {
    const rows = table.chestLoot.rarities;
    const rarity = rows.find((row) => row.rarity === resolveDungeonChestRarity(table, seed)) ?? rows[rows.length - 1]!;
    rarityResult = rarity.rarity;
    for (let slot = 0; slot < rarity.slots + Math.max(0, bonusSlots); slot += 1) {
      let selection = dungeonSeededRoll(`${seed}:slot:${slot}`) * rarity.loot.reduce((sum, row) => sum + row.weight, 0);
      const loot = rarity.loot.find((row) => { selection -= row.weight; return selection < 0; }) ?? rarity.loot[rarity.loot.length - 1]!;
      const quantity = loot.minQuantity + Math.floor(dungeonSeededRoll(`${seed}:quantity:${slot}`) * (loot.maxQuantity - loot.minQuantity + 1));
      items.set(loot.itemId, (items.get(loot.itemId) ?? 0) + quantity);
    }
  }
  const chanceSeed = `${seed}:chance:${chance.memberId ?? ""}`;
  table.chanceItems?.forEach((entry) => {
    const pct = Math.min(100, entry.chancePct + (entry.torchScaling ? dungeonTorchChanceBonusPct(chance.torchTotal) : 0));
    if (dungeonSeededRoll(`${chanceSeed}:${entry.itemId}:hit`) * 100 >= pct) return;
    const quantity = entry.minQuantity + Math.floor(
      dungeonSeededRoll(`${chanceSeed}:${entry.itemId}:quantity`) * (entry.maxQuantity - entry.minQuantity + 1));
    items.set(entry.itemId, (items.get(entry.itemId) ?? 0) + quantity);
  });
  return { rarity: rarityResult, items: [...items].map(([itemId, quantity]) => ({ itemId, quantity })) };
}

/** Objects of a spawn group present in this run: seeded by run id, `min..max` of the group's members. */
export function dungeonSpawnGroupSelection(
  dungeon: Pick<DungeonDefinition, "rooms">,
  runId: string,
  groupId: string
): ReadonlySet<string> {
  const members = dungeon.rooms.filter((room) => !room.retired).flatMap((room) =>
    room.objects
      .filter((object) => !object.retired && object.spawnGroup?.id === groupId)
      .map((object) => ({ key: `${room.id}:${object.id}`, group: object.spawnGroup! })));
  const group = members[0]?.group;
  if (!group) return new Set();
  const count = Math.min(members.length,
    group.min + Math.floor(dungeonSeededRoll(`${runId}:spawn-group:${groupId}:count`) * (group.max - group.min + 1)));
  return new Set(members
    .map((member) => ({ key: member.key, rank: dungeonSeededRoll(`${runId}:spawn-group:${groupId}:${member.key}`) }))
    .sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key))
    .slice(0, count)
    .map((member) => member.key));
}

/** Whether a dungeon object is present for this run: its group pick, else its `spawnChance` roll. */
export function dungeonObjectSpawnsInRun(
  dungeon: Pick<DungeonDefinition, "rooms">,
  runId: string,
  roomId: string,
  object: Pick<DungeonObjectDefinition, "id" | "spawnChance" | "spawnGroup">
): boolean {
  if (object.spawnGroup) {
    return dungeonSpawnGroupSelection(dungeon, runId, object.spawnGroup.id).has(`${roomId}:${object.id}`);
  }
  return dungeonSeededRoll(`${runId}:${roomId}:${object.id}:spawn`) * 100 < (object.spawnChance ?? 100);
}
