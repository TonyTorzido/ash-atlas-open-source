import type {
  CitySnapshot,
  CityStructureSnapshot,
  CollectibleNode,
  CombatEntitySnapshot,
  DroppedItemSnapshot,
  DungeonEntranceSnapshot,
  DungeonObjectSnapshot,
  FlagSnapshot,
  FurnaceWorldSnapshot,
  TanneryWorldSnapshot,
  LoomWorldSnapshot,
  KitchenWorldSnapshot,
  FishingHutWorldSnapshot,
  GreenhouseSnapshot,
  ManorWorldSnapshot,
  PlayerSnapshot
} from "@ash-atlas/shared";

export type WorldObjectPick =
  | { kind: "flag"; value: FlagSnapshot }
  | { kind: "city"; value: CitySnapshot }
  | { kind: "city_structure"; value: CityStructureSnapshot }
  | { kind: "dungeon_entrance"; value: DungeonEntranceSnapshot }
  | { kind: "manor"; value: ManorWorldSnapshot }
  | { kind: "greenhouse"; value: GreenhouseSnapshot }
  | { kind: "furnace"; value: FurnaceWorldSnapshot }
  | { kind: "tannery"; value: TanneryWorldSnapshot }
  | { kind: "loom"; value: LoomWorldSnapshot }
  | { kind: "kitchen"; value: KitchenWorldSnapshot }
  | { kind: "fishing_hut"; value: FishingHutWorldSnapshot }
  | { kind: "collectible"; value: CollectibleNode }
  | { kind: "dropped_item"; value: DroppedItemSnapshot }
  | { kind: "player"; value: PlayerSnapshot }
  | { kind: "combat_entity"; value: CombatEntitySnapshot }
  /** Room fixture or portal of a map-rendered interior (local room units). */
  | { kind: "interior_object"; value: DungeonObjectSnapshot };

export function worldObjectPickKey(target: WorldObjectPick): string {
  switch (target.kind) {
    case "flag": return `flag:${target.value.id}`;
    case "city": return `city:${target.value.id}`;
    case "city_structure": return `city_structure:${target.value.structureId}`;
    case "dungeon_entrance": return `dungeon_entrance:${target.value.entranceId}`;
    case "manor": return `manor:${target.value.manorId}`;
    case "greenhouse": return `greenhouse:${target.value.greenhouseId}`;
    case "furnace": return `furnace:${target.value.furnaceId}`;
    case "tannery": return `tannery:${target.value.tanneryId}`;
    case "loom": return `loom:${target.value.loomId}`;
    case "kitchen": return `kitchen:${target.value.kitchenId}`;
    case "fishing_hut": return `fishing_hut:${target.value.fishingHutId}`;
    case "collectible": return `collectible:${target.value.id}`;
    case "dropped_item": return `dropped_item:${target.value.pileId ?? target.value.dropId}`;
    case "player": return `player:${target.value.playerId}`;
    case "combat_entity": return `combat_entity:${target.value.entityId}`;
    case "interior_object": return `interior_object:${target.value.id}`;
  }
}
