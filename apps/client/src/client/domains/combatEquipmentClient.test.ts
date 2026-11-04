import { describe, expect, it, vi } from "vitest";

import type { ClientCommandPort } from "../clientCommandPort.js";
import { CombatEquipmentClient } from "./combatEquipmentClient.js";

describe("CombatEquipmentClient authority fencing", () => {
  it("returns a stale-generation outcome without describing the replacement as disconnected", () => {
    const send = vi.fn((_message, expectedGeneration?: number) => ({
      status: "stale-socket-generation" as const,
      expectedGeneration: expectedGeneration ?? -1,
      activeGeneration: 8
    }));
    const port: ClientCommandPort = {
      connectionGeneration: () => 7,
      send
    };

    const attempt = new CombatEquipmentClient(port).startAttack("mob:one");

    expect(attempt.outcome).toEqual({
      status: "stale-socket-generation",
      expectedGeneration: 7,
      activeGeneration: 8
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "START_ATTACK",
        requestId: attempt.requestId,
        targetEntityId: "mob:one"
      }),
      7
    );
  });

  it("sends normal ability placement through the request-tracked command port", () => {
    const messages: unknown[] = [];
    const send: ClientCommandPort["send"] = (message) => {
      messages.push(message);
      return { status: "sent" as const, readiness: "ready" as const, connectionGeneration: 3 };
    };
    const client = new CombatEquipmentClient({ send });

    expect(client.useNormalAbility("faultline", undefined, undefined, { lat: 35.1, lon: -106.6 })).toBe(true);
    expect(messages).toEqual([
      expect.objectContaining({ type: "USE_NORMAL_ABILITY", abilityId: "faultline", targetPosition: { lat: 35.1, lon: -106.6 } })
    ]);
  });

  it("sends revision-fenced Skill System V3 commands with exact optional targeting", () => {
    const messages: unknown[] = [];
    const send: ClientCommandPort["send"] = (message) => {
      messages.push(message);
      return { status: "sent" as const, readiness: "ready" as const, connectionGeneration: 3 };
    };
    const client = new CombatEquipmentClient({ send });

    expect(client.requestSkillTreeV3Snapshot("skills-request")).toBe("skills-request");
    expect(client.spendSkillTreeV3Point(7, { kind: "general_skill", skillId: "cleave" }, "skills-spend")).toBe("skills-spend");
    expect(client.refundSkillTreeV3Rank(8, { kind: "specialization", specializationId: "warrior" }, "skills-refund")).toBe("skills-refund");
    expect(client.activateSkillTreeV3Specialization(9, "warrior", "skills-activate")).toBe("skills-activate");
    expect(client.equipSkillTreeV3GeneralActive(10, 2, "cleanse", "skills-equip")).toBe("skills-equip");
    expect(client.useSkillTreeV3GeneralActive(11, "cleanse", {
      targetEntityId: "player-2",
      targetMode: "friendly"
    }, "skills-use")).toBe("skills-use");

    expect(messages).toEqual([
      { type: "REQUEST_SKILL_TREE_SNAPSHOT", requestId: "skills-request" },
      { type: "SPEND_SKILL_POINT", requestId: "skills-spend", expectedRevision: 7, target: { kind: "general_skill", skillId: "cleave" } },
      { type: "REFUND_SKILL_RANK", requestId: "skills-refund", expectedRevision: 8, target: { kind: "specialization", specializationId: "warrior" } },
      { type: "ACTIVATE_SPECIALIZATION", requestId: "skills-activate", expectedRevision: 9, specializationId: "warrior" },
      { type: "EQUIP_GENERAL_ACTIVE", requestId: "skills-equip", expectedRevision: 10, slot: 2, skillId: "cleanse" },
      { type: "USE_GENERAL_ACTIVE", requestId: "skills-use", expectedRevision: 11, skillId: "cleanse", targetEntityId: "player-2", targetMode: "friendly" }
    ]);
  });
});
