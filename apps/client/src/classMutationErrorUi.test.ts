import { describe, expect, it } from "vitest";

import {
  classMutationErrorUiEffect,
  equipmentMutationRequestAfterClassError
} from "./classMutationErrorUi.js";

describe("class mutation server-error UI effects", () => {
  it("surfaces a world-transition rejection for an active class mutation", () => {
    expect(classMutationErrorUiEffect(
      "PLAYER_WORLD_TRANSITION_PENDING",
      true
    )).toEqual({
      clearBusy: true,
      clearEquipmentBusy: false,
      showActionError: true
    });
  });

  it("does not treat a passive world-transition collision as a class error", () => {
    expect(classMutationErrorUiEffect("PLAYER_WORLD_TRANSITION_PENDING")).toEqual({
      clearBusy: false,
      clearEquipmentBusy: false,
      showActionError: false
    });
  });

  it.each([
    "CLASS_SWITCH_REJECTED",
    "TECHNIQUE_LOCKED",
    "LOADOUT_INVALID",
    "SUBCLASS_LOCKED",
    "TRAINING_REQUIRED"
  ])("retains the existing class mutation handling for %s", (code) => {
    expect(classMutationErrorUiEffect(code)).toEqual({
      clearBusy: true,
      clearEquipmentBusy: false,
      showActionError: true
    });
  });

  it.each([
    "CLASS_WEAPON_INCOMPATIBLE",
    "CLASS_ARMOR_INCOMPATIBLE",
    "SUBCLASS_WEAPON_REQUIRED"
  ])("also releases equipment controls for %s", (code) => {
    expect(classMutationErrorUiEffect(code)).toEqual({
      clearBusy: true,
      clearEquipmentBusy: true,
      showActionError: true
    });
  });

  it("does not release class mutation UI for unrelated server errors", () => {
    expect(classMutationErrorUiEffect("MOVE_REJECTED")).toEqual({
      clearBusy: false,
      clearEquipmentBusy: false,
      showActionError: false
    });
  });

  it.each([
    "CLASS_WEAPON_INCOMPATIBLE",
    "CLASS_ARMOR_INCOMPATIBLE",
    "SUBCLASS_WEAPON_REQUIRED",
    "CLASS_MUTATION_PENDING"
  ])("releases the matching equipment request guard after %s", (code) => {
    let activeRequestId: string | null = "equip-rejected";
    activeRequestId = equipmentMutationRequestAfterClassError(
      activeRequestId,
      "equip-rejected",
      code
    );

    expect(activeRequestId).toBeNull();
    if (activeRequestId === null) activeRequestId = "equip-next";
    expect(activeRequestId).toBe("equip-next");
  });

  it("does not release a newer equipment request for a stale class rejection", () => {
    expect(equipmentMutationRequestAfterClassError(
      "equip-current",
      "equip-stale",
      "CLASS_WEAPON_INCOMPATIBLE"
    )).toBe("equip-current");
  });
});
