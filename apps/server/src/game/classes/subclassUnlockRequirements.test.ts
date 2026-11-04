import { describe, expect, it } from "vitest";
import type { SubclassId } from "@ash-atlas/shared";

import {
  ClassRequestError,
  resolveSubclassUnlockRequirement
} from "./classService.js";

describe("authoritative subclass unlock requirements", () => {
  it.each(["reaver", "warden"] as const)(
    "keeps %s behind Level 25 and an unavailable production challenge",
    (subclassId) => {
      expect(resolveSubclassUnlockRequirement({
        subclassId,
        warriorLevel: 24,
        unlocked: false
      })).toMatchObject({
        warriorLevelEligible: false,
        satisfied: false,
        productionUnlockAvailable: false,
        reason: "warrior_level_25_required"
      });
      expect(resolveSubclassUnlockRequirement({
        subclassId,
        warriorLevel: 25,
        unlocked: false
      })).toMatchObject({
        warriorLevelEligible: true,
        satisfied: false,
        productionUnlockAvailable: false,
        reason: "challenge_unavailable"
      });
      expect(resolveSubclassUnlockRequirement({
        subclassId,
        warriorLevel: 25,
        unlocked: true
      })).toMatchObject({
        warriorLevelEligible: true,
        satisfied: true,
        productionUnlockAvailable: false,
        reason: "already_unlocked"
      });
    }
  );

  it("still requires Level 25 when a development unlock is retained after level-down", () => {
    expect(resolveSubclassUnlockRequirement({
      subclassId: "reaver",
      warriorLevel: 24,
      unlocked: true
    })).toMatchObject({
      warriorLevelEligible: false,
      satisfied: false,
      reason: "warrior_level_25_required"
    });
  });

  it.each([
    ["sharpshooter", "hunter"],
    ["stalker", "hunter"]
  ] as const)("uses generic Class Level eligibility for %s", (subclassId, classId) => {
    expect(resolveSubclassUnlockRequirement({
      subclassId,
      classId,
      classLevel: 24,
      unlocked: true
    })).toMatchObject({
      classId,
      classLevelEligible: false,
      satisfied: false,
      reason: "class_level_25_required"
    });
    expect(resolveSubclassUnlockRequirement({
      subclassId,
      classId,
      classLevel: 25,
      unlocked: true
    })).toMatchObject({
      classId,
      classLevelEligible: true,
      satisfied: true,
      reason: "already_unlocked"
    });
  });

  it("rejects a valid subclass paired with the wrong class", () => {
    expectRequirementError(() => resolveSubclassUnlockRequirement({
      subclassId: "reaver",
      classId: "hunter",
      classLevel: 25,
      unlocked: true
    }), "SUBCLASS_CLASS_INVALID");
  });

  it("rejects forged subclass IDs and invalid levels", () => {
    expectRequirementError(() => resolveSubclassUnlockRequirement({
      subclassId: "berserker" as unknown as SubclassId,
      warriorLevel: 25,
      unlocked: false
    }), "SUBCLASS_UNKNOWN");
    expectRequirementError(() => resolveSubclassUnlockRequirement({
      subclassId: "warden",
      warriorLevel: 26,
      unlocked: false
    }), "SUBCLASS_LEVEL_INVALID");
  });
});

function expectRequirementError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected authoritative subclass requirement rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ClassRequestError);
    expect((error as ClassRequestError).code).toBe(code);
  }
}
