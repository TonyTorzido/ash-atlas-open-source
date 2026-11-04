import {
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  projectPlayerAppearance,
  type EquipmentSnapshotV2,
  type PlayerAppearanceSnapshot
} from "@ash-atlas/shared";

import type { GameState } from "./state.js";

export function installAuthoritativePlayerAppearance(
  gameState: GameState,
  equipment: EquipmentSnapshotV2,
  activeHandOverride?: "melee" | "secondary" | null
): PlayerAppearanceSnapshot | null {
  return gameState.setPlayerAppearance(
    equipment.playerId,
    projectPlayerAppearance(
      equipment,
      DEFAULT_PLAYER_APPEARANCE_CATALOG,
      {},
      activeHandOverride,
      gameState.getPlayer(equipment.playerId)?.bodyVariantId ?? "default",
      gameState.getPlayer(equipment.playerId)?.salonStyles ?? {}
    )
  );
}
