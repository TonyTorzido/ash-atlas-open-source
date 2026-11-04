import { destinationPoint, type CombatEntitySnapshot, type LatLon, type ResourceVision } from "@ash-atlas/shared";

import { zoneIdForPosition } from "./spatialZones.js";

type AmbientWolfCombat = {
  entity(entityId: string): CombatEntitySnapshot | null;
  spawnMob(input: {
    entityId?: string;
    archetype: "wolf";
    position: LatLon;
    regionCode: string;
    zoneId: string;
    originFlagId: string;
  }): CombatEntitySnapshot;
};

type WolfSlot = {
  entityId: string | null;
  generation: number;
  nextSpawnAtMs: number;
};

export const AMBIENT_WOLF_SLOT_COUNT = 3;

export class AmbientWolfCoordinator {
  private readonly slotsByFlag = new Map<string, WolfSlot[]>();

  constructor(
    private readonly combat: AmbientWolfCombat,
    _disabledRespawnMs: number,
    private readonly now: () => number = Date.now
  ) {}

  ensure(resourceVision: ResourceVision, regionCode: string): readonly WolfSlot[] {
    const nowMs = this.now();
    const positions = ambientWolfPositions(resourceVision.center);
    const slots = this.slotsByFlag.get(resourceVision.flagId) ?? positions.map(() => ({
      entityId: null,
      generation: 0,
      nextSpawnAtMs: 0
    }));

    for (let index = 0; index < positions.length; index += 1) {
      const slot = slots[index]!;
      if (slot.entityId) {
        const entity = this.combat.entity(slot.entityId);
        if (entity?.lifeState === "alive") continue;
        slot.entityId = null;
        // Legacy ambient slots are one-life only. Durable allowance wolves replace this path.
        slot.nextSpawnAtMs = Number.POSITIVE_INFINITY;
      }
      if (nowMs < slot.nextSpawnAtMs) continue;

      slot.generation += 1;
      const position = positions[index]!;
      const entityId = ambientWolfEntityId(resourceVision.flagId, index, slot.generation);
      slot.entityId = this.combat.spawnMob({
        entityId,
        archetype: "wolf",
        position,
        regionCode,
        zoneId: zoneIdForPosition(position),
        originFlagId: resourceVision.flagId
      }).entityId;
      slot.nextSpawnAtMs = 0;
    }
    this.slotsByFlag.set(resourceVision.flagId, slots);
    return slots.map((slot) => ({ ...slot }));
  }
}

export function ambientWolfPositions(center: LatLon): LatLon[] {
  return [
    destinationPoint(center, 320, 35),
    destinationPoint(center, 640, 165),
    destinationPoint(center, 920, 285)
  ];
}

export function ambientWolfEntityId(flagId: string, slotIndex: number, generation: number): string {
  return `mob:wolf-slot:${flagId}:${slotIndex}:g${generation}`;
}
