import type { PlayerInventorySnapshot } from "../collectibles.js";
import type { SaplingMapItem, SaplingStateAction, SaplingWorldSnapshot } from "../givingSaplings.js";
import type { PetStateSnapshot, PetTrackPing } from "../petSystem.js";
import type { PremiumWalletSnapshot } from "../premiumCurrency.js";

export const PET_STATE_ACTIONS = [
  "call", "dismiss", "command", "feed", "heal", "train", "unlock", "ability", "hatch", "hermit", "sent_home", "rested", "treant", "dev_grant"
] as const;
export type PetStateAction = (typeof PET_STATE_ACTIONS)[number];

export type PetServerMessage =
  | {
      type: "PET_STATE";
      requestId?: string;
      action?: PetStateAction;
      state: PetStateSnapshot;
      notice?: string;
      ping?: PetTrackPing;
      /** Find Open Land found a spot: the client starts the standard travel to it (VISIT_OPEN_LAND). */
      openLand?: { lat: number; lon: number };
      /** Stay/Follow reply: the spot the pet was told to walk to and stay at (none for plain Stay or Follow). */
      stayAt?: { lat: number; lon: number };
      inventory?: PlayerInventorySnapshot;
      premiumWallet?: PremiumWalletSnapshot;
    }
  | { type: "PET_ERROR"; requestId?: string; code: string; message: string; retryable: boolean }
  | {
      /** The full compact list around the player: on connect, after moving far, and the slow safety resync. */
      type: "SAPLINGS_STATE";
      requestId?: string;
      saplings: SaplingMapItem[];
      serverNowMs: number;
    }
  | {
      /** One changed tree pushed to the players within view of it: upserts and removals, nothing else. */
      type: "SAPLING_DELTA";
      upserts: SaplingMapItem[];
      removed: string[];
      serverNowMs: number;
    }
  | {
      /** One tree with its owner and exact timers (the prompt), or null when it is gone. */
      type: "SAPLING_DETAIL";
      requestId?: string;
      saplingId: string;
      sapling: SaplingWorldSnapshot | null;
      serverNowMs: number;
    }
  | {
      /** The reply to Plant, Tend, Pull or Gather. */
      type: "SAPLING_RESULT";
      requestId?: string;
      action: SaplingStateAction;
      sapling: SaplingWorldSnapshot | null;
      serverNowMs: number;
      notice?: string;
      inventory?: PlayerInventorySnapshot;
    }
  | { type: "SAPLING_ERROR"; requestId?: string; code: string; message: string; retryable: boolean };
