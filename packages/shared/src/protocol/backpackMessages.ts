import type {
  BackpackErrorCode,
  BackpackOperationResult,
  BackpackSnapshot,
  BackpackUnequipDiagnostic
} from "../backpacks.js";

export type BackpackServerMessage =
  | { type: "BACKPACK_SNAPSHOT"; backpacks: BackpackSnapshot }
  | { type: "BACKPACK_OPERATION_RESULT"; result: BackpackOperationResult }
  | {
      type: "BACKPACK_ERROR";
      requestId: string | null;
      code: BackpackErrorCode;
      message: string;
      diagnostic?: BackpackUnequipDiagnostic;
    };
