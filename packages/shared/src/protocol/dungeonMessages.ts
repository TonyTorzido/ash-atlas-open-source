import type {
  DungeonEntranceSnapshot,
  DungeonSnapshot,
  DungeonSnapshotUpdate
} from "../dungeon.js";
import type { PlayerSnapshot } from "../playerSnapshotContracts.js";
import type { PlayerInventorySnapshot } from "../collectibles.js";
import type { PlayerWalletSnapshot } from "../wallet.js";

import type { DungeonResourceType } from "../dungeonCatalog.js";
import type { FallenPrisonHuntHint } from "../fallenPrisonHunt.js";

/**
 * Torch lobby at a dungeon entrance (WP16). `open`: members pick torches and ready up; `starting`: the
 * leader's start is charging everyone; `started`: torches are paid, members enter through the portal;
 * `in_progress`: a run is already paid or under way, so anyone in the party enters free (no lobby).
 */
export type DungeonTorchLobbySnapshot = {
  lobbyId: string;
  entranceId: string;
  dungeonId: string;
  dungeonName: string;
  partyId: string | null;
  leaderPlayerId: string;
  status: "open" | "starting" | "started" | "in_progress";
  revision: number;
  /** What one torch costs; each member pays torches x this from their own pack. */
  torchCost: Array<{ itemId: string; quantity: number }>;
  minTotalTorches: number;
  maxTotalTorches: number;
  totalTorches: number;
  members: Array<{ playerId: string; name: string; torches: number; ready: boolean }>;
  /** Last start failure, shown to every member; null otherwise. */
  message: string | null;
};

export type DungeonServerMessage =
  | { type: "DUNGEON_ENTRANCES"; requestId?: string; entrances: DungeonEntranceSnapshot[] }
  | { type: "DUNGEON_ENTRANCE_UPSERTED"; entrance: DungeonEntranceSnapshot }
  | { type: "DUNGEON_ENTRANCE_REMOVED"; entranceId: string }
  /** Level 40+ only: the rough live hint towards a Fallen Prison crash (null clears it), and its landing line. */
  | { type: "FALLEN_PRISON_HUNT"; hint: FallenPrisonHuntHint | null; announcement?: string }
  | { type: "DUNGEON_ENTERED"; requestId: string; snapshot: DungeonSnapshot }
  | { type: "DUNGEON_SNAPSHOT"; requestId?: string; snapshot: DungeonSnapshot | DungeonSnapshotUpdate }
  | { type: "DUNGEON_RESOURCE_HARVESTED"; requestId: string; resourceId: string;
      resourceType: DungeonResourceType; quantity: number; snapshot: DungeonSnapshot | DungeonSnapshotUpdate }
  | { type: "DUNGEON_REWARD_GRANTED"; requestId?: string; runId: string;
      rewardSourceId: string; rewardTableId: string; applied: boolean;
      inventory: PlayerInventorySnapshot; wallet: PlayerWalletSnapshot;
      items: Array<{ itemId: string; quantity: number }>; gold: number; message: string }
  | { type: "DUNGEON_EXITED"; requestId: string; player: PlayerSnapshot }
  | { type: "DUNGEON_TORCH_LOBBY"; requestId?: string; lobby: DungeonTorchLobbySnapshot | null }
  | { type: "DUNGEON_ERROR"; requestId?: string; code: string; message: string };
