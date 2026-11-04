import type { PlayerInventorySnapshot } from "../collectibles.js";
import type { EquipmentSnapshotV2 } from "../equipment.js";
import type { PlayerGiftStatus } from "../playerGifts.js";

export type PlayerGiftServerMessage =
  | {
      type: "GIFT_BOX_PURCHASE_RESULT";
      requestId: string;
      replayed: boolean;
      quantity: number;
      totalPriceGold: string;
      walletGold: string;
      walletVersion: string;
      inventory: PlayerInventorySnapshot;
    }
  | {
      type: "PLAYER_GIFT_SEND_RESULT";
      requestId: string;
      replayed: boolean;
      packageId: string;
      recipientPlayerId: string;
      recipientName: string;
      inventory: PlayerInventorySnapshot;
      equipment: EquipmentSnapshotV2;
    }
  | ({
      type: "PLAYER_GIFT_STATUS";
      requestId: string;
    } & PlayerGiftStatus)
  | {
      type: "PLAYER_GIFT_ERROR";
      requestId: string;
      code: string;
      message: string;
    };

export const PLAYER_GIFT_SERVER_MESSAGE_TYPES = new Set<
  PlayerGiftServerMessage["type"]
>([
  "GIFT_BOX_PURCHASE_RESULT",
  "PLAYER_GIFT_SEND_RESULT",
  "PLAYER_GIFT_STATUS",
  "PLAYER_GIFT_ERROR"
]);

export function isPlayerGiftServerMessage(
  message: { type: string }
): message is PlayerGiftServerMessage {
  return PLAYER_GIFT_SERVER_MESSAGE_TYPES.has(
    message.type as PlayerGiftServerMessage["type"]
  );
}
