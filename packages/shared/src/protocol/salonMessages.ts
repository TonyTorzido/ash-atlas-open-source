import type { PlayerAppearanceSnapshot, PlayerSalonStyles } from "../appearance.js";
import type { SalonPosition } from "../salon.js";
import type { PlayerSnapshot } from "../playerSnapshotContracts.js";

export type SalonServerMessage =
  | {
      type: "SALON_ENTERED";
      requestId?: string;
      structureId: string;
      salonSessionId: string;
      displayColor: string | null;
      appearance?: PlayerAppearanceSnapshot;
      position: SalonPosition;
      movementSequence: number;
      serverTime: number;
    }
  | {
      type: "SALON_POSITION";
      salonSessionId: string;
      position: SalonPosition;
      movementSequence: number;
      serverTime: number;
    }
  | {
      type: "SALON_EDITOR_OPENED";
      requestId: string;
      editorSessionId: string;
      releaseSha: string | null;
      catalogRevision: number;
      schemaVersion: number;
      appearanceRevision: number;
      styles: PlayerSalonStyles;
    }
  | { type: "SALON_EDITOR_CANCELLED"; requestId?: string }
  | {
      type: "SALON_APPEARANCE_SAVED";
      requestId: string;
      appearanceRevision: number;
      styles: PlayerSalonStyles;
      appearance: PlayerAppearanceSnapshot;
      replayed: boolean;
      price: 0;
    }
  | { type: "SALON_EXITED"; requestId?: string; reason?: string; player: PlayerSnapshot }
  | {
      type: "MASK_EQUIPPED";
      requestId: string;
      /** The worn mask (appearance id), or null when none is worn. */
      maskAppearanceId: string | null;
      /** The worn face_mask copy (inventory variant), or null. */
      maskCopyId: string | null;
      appearanceRevision: number;
      styles: PlayerSalonStyles;
      appearance: PlayerAppearanceSnapshot;
      replayed: boolean;
      message: string;
    }
  | { type: "SALON_ERROR"; requestId?: string; code: string; message: string };
