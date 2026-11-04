import type { CombatEntitySnapshot, ResourceVision } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { AmbientWolfCoordinator, ambientWolfPositions } from "./ambientWolves.js";

describe("AmbientWolfCoordinator", () => {
  it("keeps one living wolf per stable slot across repeated preparation", () => {
    let nowMs = 1_000;
    const entities = new Map<string, CombatEntitySnapshot>();
    const spawned: Array<{ id: string; lat: number; lon: number }> = [];
    const coordinator = new AmbientWolfCoordinator({
      entity: (entityId) => entities.get(entityId) ?? null,
      spawnMob: (input) => {
        const entity = wolf(input.entityId!, input.position.lat, input.position.lon);
        entities.set(entity.entityId, entity);
        spawned.push({ id: entity.entityId, lat: entity.lat, lon: entity.lon });
        return entity;
      }
    }, 60_000, () => nowMs);

    const first = coordinator.ensure(vision(), "NM");
    const second = coordinator.ensure(vision(), "NM");
    expect(first.map((slot) => slot.entityId)).toEqual(second.map((slot) => slot.entityId));
    expect(spawned).toHaveLength(3);
    expect(new Set(spawned.map((entry) => `${entry.lat}:${entry.lon}`)).size).toBe(3);

    const defeatedMiddle = first[1]!.entityId!;
    entities.delete(defeatedMiddle);
    coordinator.ensure(vision(), "NM");
    coordinator.ensure(vision(), "NM");
    expect(spawned).toHaveLength(3);

    nowMs += 60_000;
    coordinator.ensure(vision(), "NM");
    expect(spawned).toHaveLength(3);
    nowMs += 7 * 24 * 60 * 60 * 1_000;
    const stillConsumed = coordinator.ensure(vision(), "NM");
    expect(spawned).toHaveLength(3);
    expect(stillConsumed[1]!.entityId).toBeNull();
  });

  it("uses three distinct authored offsets for every circle", () => {
    expect(ambientWolfPositions(vision().center)).toHaveLength(3);
  });
});

function vision(): ResourceVision {
  return {
    flagId: "flag-1",
    flagName: "Flag",
    center: { lat: 35, lon: -106 },
    movementLeashRadiusM: 1_250,
    paddingM: 250,
    radiusM: 1_500
  };
}

function wolf(entityId: string, lat: number, lon: number): CombatEntitySnapshot {
  return {
    entityId,
    kind: "mob",
    archetypeKey: "wolf",
    name: "Wolf",
    level: 1,
    regionCode: "NM",
    zoneId: "world:NM",
    lat,
    lon,
    maxHealth: 20,
    currentHealth: 20,
    lifeState: "alive",
    activityState: "idle",
    targetEntityId: null,
    revision: 1
  };
}
