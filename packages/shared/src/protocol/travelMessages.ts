import type { PlayerSnapshot } from "../playerSnapshotContracts.js";
import type { TravelInboxEntry } from "../travel.js";

export type TravelServerMessage =
  | {
      type: "TRAVEL_INBOX_SNAPSHOT";
      entries: TravelInboxEntry[];
      serverTime: number;
      relocationAvailableAt?: number | null;
      travelInviteAvailableAt?: number | null;
      // Epoch ms when land actions are no longer held after a relocation.
      landActionAvailableAt?: number | null;
      // Relocate may still be allowed during the cooldown (the server decides).
      relocationExemptionAvailable?: boolean;
    }
  | {
      type: "VISIBLE_FLAG_VISIT_PREPARED";
      requestId: string;
      flagId: string;
      playerSpawnPosition: { lat: number; lon: number };
      expiresInMs: number;
    }
  | {
      type: "TRAVEL_RESULT";
      requestId?: string;
      kind: "invite" | "invite_sent" | "party_manual" | "party_auto_follow" | "manor_jump" | "pet_open_land" | "gps_relocate" | "whirlpool";
      success: boolean;
      message: string;
      retryAfterMs?: number;
      relocationAvailableAt?: number | null;
      travelInviteAvailableAt?: number | null;
      // Epoch ms when land actions are no longer held after a relocation.
      landActionAvailableAt?: number | null;
      // Relocate may still be allowed during the cooldown (the server decides).
      relocationExemptionAvailable?: boolean;
      player?: PlayerSnapshot;
      resourceVisionRevision?: number;
      arrivalPresentation?: "jump";
      warning?: string;
    }
  | { type: "CITY_VISITED"; requestId: string; cityId: string; player: PlayerSnapshot; resourceVisionRevision?: number; arrivalPresentation?: "jump"; warning?: string }
  | { type: "FLAG_TOLL_RECEIVED"; flagId: string; amount: string; walletGold: string }
  | {
      type: "FLAG_VISITED";
      requestId: string;
      flagId: string;
      resourceVisionRevision: number;
      player: PlayerSnapshot;
      walletGold?: string;
      arrivalPresentation?: "jump";
      warning?: string;
    };
