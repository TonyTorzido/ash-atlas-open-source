import { describe, expect, it } from "vitest";

import { parseClientMessage } from "./clientMessages.js";
import { parseServerMessage, ServerMessageParseError } from "./serverMessageParser.js";
import { skillSystemV3SnapshotSchema } from "./skillSystemV3ServerSchemas.js";

const snapshot = {
  fullBuildRespecAvailable: false,
  fullClassRosterEnabled: false,
  ultimatesEnabled: false,
  playerId: "player-1",
  characterLevel: 10,
  pointState: { totalEarned: 20, totalSpent: 4, available: 16, revision: 7 },
  generalSkills: [{ skillId: "cleave", rank: 3, pointsSpent: 4 }],
  specializations: [{
    specializationId: "warrior",
    rank: 1,
    pointsSpent: 1,
    grandfathered: false,
    masteryQuestCompleted: false
  }],
  committedSpecializationId: "warrior",
  activeSpecializationId: "warrior",
  equippedClassTechniqueId: null,
  generalActiveLoadout: [null, null],
  ultimate: null,
  cooldownEndsAt: {},
  worldKnowledge: [{
    skillId: "tidecraft",
    revealed: false,
    rank: 0,
    pointsSpent: 0
  }],
  serverTime: 1_800_000_000_000,
  revision: 7
} as const;

describe("Skill System V3 protocol", () => {
  it("parses every additive client mutation with request and optimistic revision", () => {
    const messages = [
      { type: "SPEND_SKILL_POINT", requestId: "spend-1", expectedRevision: 7, target: { kind: "general_skill", skillId: "cleave" } },
      { type: "SPEND_SKILL_POINT", requestId: "spend-world-1", expectedRevision: 7, target: { kind: "world_knowledge", skillId: "grove_lore" } },
      { type: "REFUND_SKILL_RANK", requestId: "refund-1", expectedRevision: 7, target: { kind: "specialization", specializationId: "warrior" } },
      { type: "ACTIVATE_SPECIALIZATION", requestId: "activate-1", expectedRevision: 7, specializationId: "warrior" },
      { type: "EQUIP_GENERAL_ACTIVE", requestId: "equip-1", expectedRevision: 7, slot: 1, skillId: "cleanse" },
      { type: "EQUIP_CLASS_TECHNIQUE", requestId: "equip-technique-1", expectedRevision: 7, techniqueId: "v3_warrior_anger_explosion" },
      { type: "USE_GENERAL_ACTIVE", requestId: "use-1", expectedRevision: 7, skillId: "cleanse", targetMode: "self" },
      { type: "RESPEC_SKILL_BUILD", requestId: "respec-1", expectedRevision: 7 },
      { type: "RESET_OWN_DEV_SKILL_TREE", requestId: "reset-1", expectedRevision: 7 }
    ];
    for (const message of messages) {
      expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
    }
  });

  it("rejects unknown ids, missing revisions, and excess client fields", () => {
    expect(() => parseClientMessage(JSON.stringify({
      type: "SPEND_SKILL_POINT",
      requestId: "bad",
      expectedRevision: 0,
      target: { kind: "general_skill", skillId: "not_a_skill" }
    }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({
      type: "ACTIVATE_SPECIALIZATION",
      requestId: "bad",
      specializationId: "warrior"
    }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({
      type: "REFUND_SKILL_RANK",
      requestId: "world-refund-not-supported",
      expectedRevision: 7,
      target: { kind: "world_knowledge", skillId: "grove_lore" }
    }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({
      type: "EQUIP_GENERAL_ACTIVE",
      requestId: "bad",
      expectedRevision: 0,
      slot: 1,
      skillId: null,
      ignored: true
    }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({
      type: "EQUIP_GENERAL_ACTIVE",
      requestId: "bad-slot",
      expectedRevision: 0,
      slot: 3,
      skillId: null
    }))).toThrow();
  });

  it("strictly validates authoritative snapshots and mutation confirmations", () => {
    expect(skillSystemV3SnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(parseServerMessage(JSON.stringify({
      type: "SKILL_MUTATION_CONFIRMED",
      requestId: "spend-1",
      action: "spend",
      replayed: false,
      snapshot
    }))).toMatchObject({ type: "SKILL_MUTATION_CONFIRMED", snapshot: { revision: 7 } });
    expect(() => parseServerMessage(JSON.stringify({
      type: "SKILL_TREE_SNAPSHOT",
      requestId: "snapshot-1",
      snapshot: { ...snapshot, revision: 8 }
    }))).toThrow(ServerMessageParseError);
    expect(() => parseServerMessage(JSON.stringify({
      type: "SKILL_TREE_SNAPSHOT",
      requestId: "snapshot-1",
      snapshot,
      ignored: true
    }))).toThrow(ServerMessageParseError);
    expect(() => skillSystemV3SnapshotSchema.parse({
      ...snapshot,
      ultimatesEnabled: true,
      specializations: [{ ...snapshot.specializations[0], rank: 5, masteryQuestCompleted: false }],
      ultimate: { id: "warrior_v2_worldbreaker", specializationId: "warrior", status: "ready" }
    })).toThrow();
    expect(skillSystemV3SnapshotSchema.parse({
      ...snapshot,
      ultimatesEnabled: true,
      specializations: [{ ...snapshot.specializations[0], rank: 5, masteryQuestCompleted: true }],
      ultimate: { id: "warrior_v2_worldbreaker", specializationId: "warrior", status: "ready" }
    }).ultimate).toMatchObject({ id: "warrior_v2_worldbreaker" });
    expect(() => skillSystemV3SnapshotSchema.parse({
      ...snapshot,
      ultimate: { id: "warrior_v2_worldbreaker", specializationId: "warrior", status: "ready" }
    })).toThrow();
  });
});
