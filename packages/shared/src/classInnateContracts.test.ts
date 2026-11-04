import { describe, expect, it } from "vitest";

import { PLAYER_COMBAT_POSE_IDS } from "./appearance.js";
import { COMBAT_LIFE_STATES } from "./combat.js";
import {
  combatEntitySnapshotSchema,
  combatEventSchema
} from "./protocol/combatEquipmentServerSchemas.js";

const entity = {
  entityId: "player-1",
  kind: "player" as const,
  archetypeKey: null,
  name: "Ariadne",
  level: 15,
  regionCode: "AA",
  zoneId: "zone-1",
  lat: 0,
  lon: 0,
  maxHealth: 130,
  currentHealth: 15,
  ward: 8,
  invisibleUntil: 4_000,
  downedUntil: null,
  lifeState: "alive" as const,
  activityState: "idle" as const,
  targetEntityId: null,
  revision: 1,
  classCombat: {
    activeClassId: "ninja" as const,
    innate: {
      id: "ninja_way_of_the_ninja" as const,
      armorActive: true,
      dodgeChance: 0.3,
      cooldownEndsAt: 61_000,
      invisibleEndsAt: 4_000
    },
    rage: 0,
    maximumRage: 0,
    reservedRage: 0,
    guard: 0,
    bloodlust: 0,
    queuedAbility: null,
    cooldownEndsAt: {}
  }
};

describe("class innate combat contracts", () => {
  it("accepts authoritative innate, Ward, invisibility, and Downed snapshot state", () => {
    expect(combatEntitySnapshotSchema.parse(entity)).toEqual(entity);
    expect(COMBAT_LIFE_STATES).toContain("downed");
    expect(PLAYER_COMBAT_POSE_IDS).toContain("downed");
    expect(combatEntitySnapshotSchema.safeParse({ ...entity, ward: -1 }).success).toBe(false);
  });

  it("keeps retained snapshots compatible while strictly validating present innate state", () => {
    const { ward: _ward, invisibleUntil: _invisibleUntil, downedUntil: _downedUntil, ...retained } = entity;
    void [_ward, _invisibleUntil, _downedUntil];
    const { innate: _innate, ...retainedClassCombat } = retained.classCombat;
    void _innate;
    expect(combatEntitySnapshotSchema.safeParse({ ...retained, classCombat: retainedClassCombat }).success).toBe(true);
    expect(combatEntitySnapshotSchema.safeParse({
      ...entity,
      classCombat: { ...entity.classCombat, innate: { ...entity.classCombat.innate, dodgeChance: 1.1 } }
    }).success).toBe(false);
  });

  it("requires an innate id and restricted feedback for innate trigger events", () => {
    const event = {
      eventId: "event-1",
      type: "CLASS_INNATE_TRIGGERED" as const,
      tick: 10,
      sourceEntityId: "player-1",
      targetEntityId: "mob-1",
      innateId: "scout_drill",
      innateFeedback: "FOCUS" as const
    };
    expect(combatEventSchema.parse(event)).toEqual(event);
    expect(combatEventSchema.safeParse({ ...event, innateFeedback: "CRITICAL" }).success).toBe(false);
    const { innateId: _innateId, ...missingId } = event;
    void _innateId;
    expect(combatEventSchema.safeParse(missingId).success).toBe(false);
  });
});
