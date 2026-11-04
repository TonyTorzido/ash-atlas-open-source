import type { CombatEquipmentServerMessage } from "@ash-atlas/shared";

type EquipmentMutationResponse =
  | Pick<
      Extract<
        CombatEquipmentServerMessage,
        { type: "EQUIPMENT_SNAPSHOT" }
      >,
      "type"
    >
  | Pick<
      Extract<
        CombatEquipmentServerMessage,
        { type: "EQUIPMENT_UPDATED" | "EQUIPMENT_UPGRADE_RESULT" | "EQUIPMENT_ACQUIRED" | "EQUIPMENT_REPAIRED" | "REPAIR_KIT_CRAFTED" | "RING_OPERATION_RESULT" }
      >,
      "type" | "requestId"
    >;

export function reconcileEquipmentMutationRequest(
  activeRequestId: string | null,
  message: EquipmentMutationResponse
): { accepted: boolean; activeRequestId: string | null } {
  if (message.type === "EQUIPMENT_SNAPSHOT") {
    return { accepted: true, activeRequestId };
  }
  if (message.requestId !== activeRequestId) {
    return { accepted: false, activeRequestId };
  }
  return { accepted: true, activeRequestId: null };
}
