import { describe, expect, it } from "vitest";

import {
  reconcileEquipmentMutationRequest
} from "./features/combatEquipment/equipmentFrameReconciliation.js";
import { reconcileEquipmentSnapshot } from "./ui/CombatKitHotbar.js";

type TestEquipmentSnapshot = {
  inventoryRevision: number;
  activeRevision: number;
  checkpointRevision: number;
  pvpOffense: number;
};

describe("equipment message handling", () => {
  it.each([
    "EQUIPMENT_UPDATED",
    "EQUIPMENT_UPGRADE_RESULT"
  ] as const)(
    "accepts a later correlated %s after an unsolicited context refresh",
    (responseType) => {
      const pendingRequestId = "equipment-request-1";
      const current: TestEquipmentSnapshot = {
        inventoryRevision: 4,
        activeRevision: 2,
        checkpointRevision: 2,
        pvpOffense: 12
      };
      const refreshed: TestEquipmentSnapshot = {
        inventoryRevision: 4,
        activeRevision: 2,
        checkpointRevision: 2,
        pvpOffense: 18
      };

      const refreshRequest = reconcileEquipmentMutationRequest(
        pendingRequestId,
        { type: "EQUIPMENT_SNAPSHOT" }
      );
      const equipmentAfterRefresh = reconcileEquipmentSnapshot(current, refreshed);

      expect(refreshRequest).toEqual({
        accepted: true,
        activeRequestId: pendingRequestId
      });
      expect(equipmentAfterRefresh).toBe(refreshed);
      expect(equipmentAfterRefresh.pvpOffense).toBe(18);

      const mutationResult = reconcileEquipmentMutationRequest(
        refreshRequest.activeRequestId,
        { type: responseType, requestId: pendingRequestId }
      );

      expect(mutationResult).toEqual({
        accepted: true,
        activeRequestId: null
      });
    }
  );

  it("retains exact correlation and monotonic guards around refreshes", () => {
    const activeRequestId = "equipment-request-new";
    const current: TestEquipmentSnapshot = {
      inventoryRevision: 8,
      activeRevision: 6,
      checkpointRevision: 4,
      pvpOffense: 22
    };
    const staleRefresh: TestEquipmentSnapshot = {
      inventoryRevision: 7,
      activeRevision: 7,
      checkpointRevision: 5,
      pvpOffense: 9
    };

    expect(reconcileEquipmentMutationRequest(activeRequestId, {
      type: "EQUIPMENT_UPDATED",
      requestId: "equipment-request-old"
    })).toEqual({
      accepted: false,
      activeRequestId
    });
    expect(reconcileEquipmentMutationRequest(activeRequestId, {
      type: "EQUIPMENT_UPGRADE_RESULT",
      requestId: "equipment-request-old"
    })).toEqual({
      accepted: false,
      activeRequestId
    });

    const refreshRequest = reconcileEquipmentMutationRequest(
      activeRequestId,
      { type: "EQUIPMENT_SNAPSHOT" }
    );
    expect(refreshRequest.activeRequestId).toBe(activeRequestId);
    expect(reconcileEquipmentSnapshot(current, staleRefresh)).toBe(current);
  });
});
