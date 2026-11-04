import { describe, expect, it } from "vitest";

import { CLASS_IDS, LAUNCH_ACTIVE_ABILITY_IDS, LAUNCH_CLASS_IDS, activateClassMessageSchema } from "@ash-atlas/shared";
import { ClassService, assertLaunchClassSelection, reconcileLaunchLoadout } from "./classService.js";

describe("first five class roster", () => {
  it("offers exactly Warrior, Ranger, Ninja, Knight, and Druid while retaining prior identities", () => {
    expect(LAUNCH_CLASS_IDS).toEqual(["warrior", "ranger", "ninja", "knight", "druid"]);
    expect(CLASS_IDS).toEqual(["warrior", "druid", "ranger", "knight", "ninja", "hunter"]);
    for (const classId of LAUNCH_CLASS_IDS) expect(() => assertLaunchClassSelection(classId)).not.toThrow();
    for (const classId of ["hunter"] as const) {
      expect(() => assertLaunchClassSelection(classId)).toThrow();
      expect(activateClassMessageSchema.safeParse({ type: "ACTIVATE_CLASS", requestId: `retired-${classId}`, classId }).success).toBe(true);
    }
  });

  it("does not equip retained class skills or passive slots", () => {
    const retained = {
      resetActives: [null, null],
      normalActives: ["warrior_v2_sundering_arc", "warrior_v2_iron_reversal"],
      passiveTiers: ["warrior_v2_retaliation", null, null],
      ultimateActive: "warrior_v2_worldbreaker"
    };
    for (const classId of LAUNCH_CLASS_IDS) {
      expect(LAUNCH_ACTIVE_ABILITY_IDS[classId]).toEqual([]);
      expect(reconcileLaunchLoadout(retained, classId, 15)).toEqual({
        resetActives: [null, null], normalActives: [null, null],
        passiveTiers: [null, null, null], ultimateActive: null
      });
    }
  });

  it("rejects legacy player class switching and paid unlock commands before database mutation", async () => {
    const service = new ClassService(null as never);
    for (const classId of LAUNCH_CLASS_IDS) {
      await expect(service.activateClass("player", classId, `switch-${classId}`, { restricted: false }))
        .rejects.toMatchObject({ code: "CLASS_SELECTION_MOVED" });
    }
    await expect(service.unlockClass("player", "knight", "unlock-knight"))
      .rejects.toMatchObject({ code: "CLASS_SELECTION_MOVED" });
  });
});
