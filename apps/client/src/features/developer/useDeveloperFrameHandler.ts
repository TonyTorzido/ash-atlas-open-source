import type {
  DeveloperServerMessage,
  ActiveGoblinVillageSnapshot,
  DungeonEntranceSnapshot,
  MobArchetypeKey,
  PlantBookKey,
  DeveloperTestFlagKind,
  DeveloperTestUnitType,
  PlayerInventorySnapshot,
  PlayerSnapshot,
  PremiumWalletSnapshot
} from "@ash-atlas/shared";
import { useCallback, type Dispatch, type SetStateAction } from "react";

import type { LocalMovementRequestTracker } from "../../movement/localMovementRequests.js";
import {
  snapLifecyclePlayer
} from "../../movement/playerMessageHandling.js";
import type { PlayerRenderTimeline } from "../../movement/playerRenderSmoothing.js";
import { upsertPlayerSnapshot } from "../../players/playerSnapshotCollection.js";
import type {
  WorldViewEpochInstallationResult
} from "../../worldView/committedWorldViewEpoch.js";

type RefCell<T> = { current: T };

const DEVELOPER_FRAME_TYPES = new Set<string>([
  "DEV_ASSETS_GRANTED",
  "DEV_CLASS_COOLDOWNS_RESET",
  "DEV_MOB_SPAWNED",
  "DEV_PLANT_SPAWNED",
  "DEV_DUNGEON_ENTRANCE_SPAWNED",
  "DEV_DUNGEON_ENTRANCES_SNAPSHOT",
  "DEV_DUNGEON_ENTRANCE_DELETED",
  "DEV_MOBS_CLEARED",
  "DEV_PLANTS_CLEARED",
  "DEV_TEST_FLAG_SPAWNED",
  "DEV_TEST_UNIT_SPAWNED",
  "DEV_GOBLIN_VILLAGE_SPAWNED",
  "DEV_GOBLIN_VILLAGES_SNAPSHOT",
  "DEV_GOBLIN_VILLAGE_DELETED",
  "DEV_CAPITAL_FOUNDING_RESULT",
  "DEV_TERRITORY_COLLAPSE_RESULT",
  "DEV_TELEPORT_COMPLETED",
  "DEV_MINE_VISIT_COMPLETED"
]);

export function isDeveloperServerMessage(
  message: { type: string }
): message is DeveloperServerMessage {
  return DEVELOPER_FRAME_TYPES.has(message.type);
}

export interface DeveloperFrameHandlerOptions {
  showActionSuccess(message: string): void;
  receiveInventorySnapshot(inventory: PlayerInventorySnapshot): void;
  setWalletGold(gold: string, revision?: string): void;
  receivePremiumWalletSnapshot(snapshot: PremiumWalletSnapshot): void;
  setDevGrantBusy: Dispatch<SetStateAction<boolean>>;
  setDevGrantFeedback: Dispatch<SetStateAction<string | null>>;
  setDevCityTreasury: Dispatch<SetStateAction<{
    cityName: string;
    treasuryBalance: string;
    playerContribution: string;
  } | null>>;
  refreshMarket(): void;
  refreshCityApp(): void;
  setMobSpawnArchetype: Dispatch<SetStateAction<MobArchetypeKey | null>>;
  setPlantSpawnKey: Dispatch<SetStateAction<PlantBookKey | null>>;
  setDeveloperMilitarySpawnMode: Dispatch<SetStateAction<DeveloperTestFlagKind | DeveloperTestUnitType | null>>;
  developerMilitarySpawnRequestRef: RefCell<string | null>;
  setGoblinVillageSpawnMode: Dispatch<SetStateAction<boolean>>;
  goblinVillageSpawnRequestRef: RefCell<string | null>;
  setGoblinVillages: Dispatch<SetStateAction<ActiveGoblinVillageSnapshot[]>>;
  setGoblinVillagesLoading: Dispatch<SetStateAction<boolean>>;
  setGoblinVillageDeleteBusy: Dispatch<SetStateAction<boolean>>;
  onGoblinVillageSpawned?(): void;
  onGoblinVillagesSnapshot?(): void;
  onGoblinVillageDeleted?(requestId: string): void;
  onCapitalFoundingResult?(
    message: Extract<DeveloperServerMessage, { type: "DEV_CAPITAL_FOUNDING_RESULT" }>
  ): void;
  setDeveloperDungeonEntrances: Dispatch<SetStateAction<DungeonEntranceSnapshot[]>>;
  setDeveloperDungeonEntrancesLoading: Dispatch<SetStateAction<boolean>>;
  setDeveloperDungeonEntranceDeleteBusy: Dispatch<SetStateAction<boolean>>;
  dungeonEntranceSpawnTemplateRef: RefCell<string | null>;
  dungeonEntranceSpawnRequestRef: RefCell<string | null>;
  dungeonEntranceListRequestRef: RefCell<string | null>;
  dungeonEntranceDeleteRequestRef: RefCell<string | null>;
  onDungeonEntranceSpawned?(): void;
  onDungeonEntrancesSnapshot?(): void;
  onDungeonEntranceDeleted?(requestId: string): void;
  selectedCombatEntityIdRef: RefCell<string | null>;
  setSelectedCombatEntityId: Dispatch<SetStateAction<string | null>>;
  teleportRequestRef: RefCell<string | null>;
  localPlayerRef: RefCell<PlayerSnapshot | null>;
  installCommittedWorldViewEpoch(
    player: PlayerSnapshot,
    resourceVisionRevision?: number
  ): WorldViewEpochInstallationResult;
  setTeleportMode: Dispatch<SetStateAction<"idle" | "targeting" | "pending">>;
  setPlayers: Dispatch<SetStateAction<PlayerSnapshot[]>>;
  playerRenderTimeline: PlayerRenderTimeline;
  localMovementRequests: LocalMovementRequestTracker;
  setSelectedFlagId: Dispatch<SetStateAction<string | null>>;
  setSelectedCityId: Dispatch<SetStateAction<string | null>>;
  setSelectedCollectibleId: Dispatch<SetStateAction<string | null>>;
  setSelectedDroppedItemId: Dispatch<SetStateAction<string | null>>;
  requestHarvestCancellation(stopMovement?: boolean): void;
  centerMap(player: PlayerSnapshot, includeDefaultZoom: boolean): void;
  setDeveloperToolsOpen: Dispatch<SetStateAction<boolean>>;
}

export function useDeveloperFrameHandler(
  options: DeveloperFrameHandlerOptions
) {
  const {
    showActionSuccess,
    receiveInventorySnapshot,
    setWalletGold,
    receivePremiumWalletSnapshot,
    setDevGrantBusy,
    setDevGrantFeedback,
    setDevCityTreasury,
    refreshMarket,
    refreshCityApp,
    setMobSpawnArchetype,
    setPlantSpawnKey,
    setDeveloperMilitarySpawnMode,
    developerMilitarySpawnRequestRef,
    setGoblinVillageSpawnMode,
    goblinVillageSpawnRequestRef,
    setGoblinVillages,
    setGoblinVillagesLoading,
    setGoblinVillageDeleteBusy,
    onGoblinVillageSpawned,
    onGoblinVillagesSnapshot,
    onGoblinVillageDeleted,
    onCapitalFoundingResult,
    setDeveloperDungeonEntrances,
    setDeveloperDungeonEntrancesLoading,
    setDeveloperDungeonEntranceDeleteBusy,
    dungeonEntranceSpawnTemplateRef,
    dungeonEntranceSpawnRequestRef,
    dungeonEntranceListRequestRef,
    dungeonEntranceDeleteRequestRef,
    onDungeonEntranceSpawned,
    onDungeonEntrancesSnapshot,
    onDungeonEntranceDeleted,
    selectedCombatEntityIdRef,
    setSelectedCombatEntityId,
    teleportRequestRef,
    localPlayerRef,
    installCommittedWorldViewEpoch,
    setTeleportMode,
    setPlayers,
    playerRenderTimeline,
    localMovementRequests,
    setSelectedFlagId,
    setSelectedCityId,
    setSelectedCollectibleId,
    setSelectedDroppedItemId,
    requestHarvestCancellation,
    centerMap,
    setDeveloperToolsOpen
  } = options;

  return useCallback((message: DeveloperServerMessage): void => {
    switch (message.type) {
      case "DEV_CLASS_COOLDOWNS_RESET":
        showActionSuccess("Class ability cooldowns reset.");
        return;
      case "DEV_ASSETS_GRANTED":
        receiveInventorySnapshot(message.inventory);
        setWalletGold(message.walletGold, message.walletVersion);
        if (message.premiumWallet) receivePremiumWalletSnapshot(message.premiumWallet);
        setDevGrantBusy(false);
        if (message.cityCoins) {
          setDevCityTreasury({
            cityName: message.cityCoins.cityName,
            treasuryBalance: message.cityCoins.treasuryBalance,
            playerContribution: message.cityCoins.playerContribution
          });
          refreshCityApp();
        }
        setDevGrantFeedback(message.replayed
          ? "This request was already applied; balances were not doubled."
          : grantFeedback(message.grants, message.cityCoins));
        refreshMarket();
        return;
      case "DEV_MOB_SPAWNED":
        setMobSpawnArchetype(null);
        return;
      case "DEV_PLANT_SPAWNED":
        setPlantSpawnKey(null);
        showActionSuccess("Wild Flax spawned.");
        return;
      case "DEV_TEST_FLAG_SPAWNED":
        if (developerMilitarySpawnRequestRef.current !== message.requestId) return;
        developerMilitarySpawnRequestRef.current = null;
        setDeveloperMilitarySpawnMode(null);
        setDeveloperToolsOpen(false);
        showActionSuccess(message.replayed
          ? `${message.flag.name} was already spawned here.`
          : `${message.flag.name} spawned.`);
        return;
      case "DEV_TEST_UNIT_SPAWNED":
        if (developerMilitarySpawnRequestRef.current !== message.requestId) return;
        developerMilitarySpawnRequestRef.current = null;
        setDeveloperMilitarySpawnMode(null);
        setDeveloperToolsOpen(false);
        showActionSuccess(message.replayed
          ? "That developer military unit was already spawned."
          : "Developer military unit spawned.");
        return;
      case "DEV_DUNGEON_ENTRANCE_SPAWNED":
        if (dungeonEntranceSpawnRequestRef.current !== message.requestId) return;
        dungeonEntranceSpawnRequestRef.current = null;
        dungeonEntranceSpawnTemplateRef.current = null;
        setDeveloperDungeonEntrances((current) => [
          ...current.filter((entrance) => entrance.entranceId !== message.entrance.entranceId),
          message.entrance
        ]);
        onDungeonEntranceSpawned?.();
        showActionSuccess(message.replayed
          ? "That dungeon entrance was already spawned here."
          : "Dungeon entrance spawned.");
        return;
      case "DEV_DUNGEON_ENTRANCES_SNAPSHOT":
        if (dungeonEntranceListRequestRef.current !== message.requestId) return;
        dungeonEntranceListRequestRef.current = null;
        setDeveloperDungeonEntrances(message.entrances);
        setDeveloperDungeonEntrancesLoading(false);
        onDungeonEntrancesSnapshot?.();
        return;
      case "DEV_DUNGEON_ENTRANCE_DELETED":
        if (dungeonEntranceDeleteRequestRef.current !== message.requestId) return;
        dungeonEntranceDeleteRequestRef.current = null;
        setDeveloperDungeonEntrances((current) => current.filter(
          (entrance) => entrance.entranceId !== message.entranceId
        ));
        setDeveloperDungeonEntranceDeleteBusy(false);
        onDungeonEntranceDeleted?.(message.requestId);
        showActionSuccess(message.replayed
          ? "That dungeon entrance was already deleted."
          : "Dungeon entrance permanently removed.");
        return;
      case "DEV_MOBS_CLEARED":
        setSelectedCombatEntityId((current) => {
          if (!current?.startsWith("mob:")) return current;
          selectedCombatEntityIdRef.current = null;
          return null;
        });
        return;
      case "DEV_PLANTS_CLEARED":
        setPlantSpawnKey(null);
        showActionSuccess(`Cleared ${message.removedCount} developer plant${message.removedCount === 1 ? "" : "s"}.`);
        return;
      case "DEV_GOBLIN_VILLAGE_SPAWNED":
        if (goblinVillageSpawnRequestRef.current !== message.requestId) return;
        goblinVillageSpawnRequestRef.current = null;
        setGoblinVillageSpawnMode(false);
        onGoblinVillageSpawned?.();
        showActionSuccess(message.replayed
          ? "Goblin Village was already spawned here."
          : "Goblin Village spawned.");
        return;
      case "DEV_GOBLIN_VILLAGES_SNAPSHOT":
        setGoblinVillages(message.villages);
        setGoblinVillagesLoading(false);
        onGoblinVillagesSnapshot?.();
        return;
      case "DEV_GOBLIN_VILLAGE_DELETED":
        setGoblinVillages((current) => current.filter(
          (village) => village.cityId !== message.result.city.cityId
        ));
        setGoblinVillageDeleteBusy(false);
        onGoblinVillageDeleted?.(message.requestId);
        showActionSuccess(message.result.replayed
          ? "Goblin Village was already deleted."
          : "Goblin Village permanently removed.");
        return;
      case "DEV_CAPITAL_FOUNDING_RESULT":
        onCapitalFoundingResult?.(message);
        if (!message.dryRun) {
          showActionSuccess(message.replayed
            ? `${message.plan.cityName} was already founded by this request.`
            : `${message.plan.cityName} founded with ${message.plan.placedFlags.length} flags.`);
        }
        return;
      case "DEV_TERRITORY_COLLAPSE_RESULT":
        showActionSuccess(
          `${message.name} collapse started: ${message.flagCount} flags will break.`
        );
        return;
      case "DEV_TELEPORT_COMPLETED":
        if (teleportRequestRef.current !== message.requestId) return;
        teleportRequestRef.current = null;
        if (
          installCommittedWorldViewEpoch(
            message.player,
            message.resourceVisionRevision
          ) === "stale-epoch-ignored"
        ) {
          setTeleportMode("idle");
          return;
        }
        localPlayerRef.current = message.player;
        setTeleportMode("idle");
        setPlayers((current) => upsertPlayerSnapshot(current, message.player));
        snapLifecyclePlayer(
          playerRenderTimeline,
          message.player,
          performance.now(),
          "dev-teleport",
          localMovementRequests
        );
        setSelectedFlagId(null);
        setSelectedCityId(null);
        setSelectedCollectibleId(null);
        setSelectedDroppedItemId(null);
        requestHarvestCancellation(false);
        centerMap(message.player, false);
        return;
      case "DEV_MINE_VISIT_COMPLETED":
        setPlayers((current) => upsertPlayerSnapshot(current, message.player));
        centerMap(message.player, true);
        setDeveloperToolsOpen(false);
        return;
    }
  }, [
    requestHarvestCancellation,
    centerMap,
    installCommittedWorldViewEpoch,
    localMovementRequests,
    localPlayerRef,
    playerRenderTimeline,
    receiveInventorySnapshot,
    refreshMarket,
    refreshCityApp,
    selectedCombatEntityIdRef,
    showActionSuccess,
    setDevGrantBusy,
    setDevGrantFeedback,
    setDevCityTreasury,
    setWalletGold,
    receivePremiumWalletSnapshot,
    setDeveloperToolsOpen,
    setMobSpawnArchetype,
    setDeveloperMilitarySpawnMode,
    developerMilitarySpawnRequestRef,
    goblinVillageSpawnRequestRef,
    setGoblinVillageSpawnMode,
    setGoblinVillages,
    setGoblinVillagesLoading,
    setGoblinVillageDeleteBusy,
    onGoblinVillageSpawned,
    onGoblinVillagesSnapshot,
    onGoblinVillageDeleted,
    onCapitalFoundingResult,
    setDeveloperDungeonEntrances,
    setDeveloperDungeonEntrancesLoading,
    setDeveloperDungeonEntranceDeleteBusy,
    dungeonEntranceSpawnTemplateRef,
    dungeonEntranceSpawnRequestRef,
    dungeonEntranceListRequestRef,
    dungeonEntranceDeleteRequestRef,
    onDungeonEntranceSpawned,
    onDungeonEntrancesSnapshot,
    onDungeonEntranceDeleted,
    setPlayers,
    setSelectedCityId,
    setSelectedCollectibleId,
    setSelectedCombatEntityId,
    setSelectedDroppedItemId,
    setSelectedFlagId,
    setTeleportMode,
    teleportRequestRef
  ]);
}

export function handlePendingGoblinVillageSpawnError(
  message: Readonly<{ requestId?: string; message: string }>,
  requestRef: RefCell<string | null>,
  showActionError: (message: string) => void
): boolean {
  if (!message.requestId || requestRef.current !== message.requestId) return false;
  requestRef.current = null;
  showActionError(message.message);
  return true;
}

function grantFeedback(
  grants: Extract<DeveloperServerMessage, { type: "DEV_ASSETS_GRANTED" }>["grants"],
  cityCoins: Extract<
    DeveloperServerMessage,
    { type: "DEV_ASSETS_GRANTED" }
  >["cityCoins"]
): string {
  if (cityCoins && grants.length === 0) {
    return `Granted ${cityCoins.creditedAmount.toLocaleString()} City Coins to ${cityCoins.cityName}. Treasury: ${formatInteger(cityCoins.treasuryBalance)}; your contribution: ${formatInteger(cityCoins.playerContribution)}.`;
  }
  if (grants.length === 0) return "Assets committed to the authoritative wallet.";
  const granted = grants.map((grant) =>
    `${grant.grantedQuantity.toLocaleString()} ${grant.itemId.replaceAll("_", " ")}`
  ).join(", ");
  const remainder = grants
    .filter((grant) => grant.remainderQuantity > 0)
    .map((grant) => `${grant.remainderQuantity.toLocaleString()} ${grant.itemId.replaceAll("_", " ")}`)
    .join(", ");
  return remainder
    ? `Granted ${granted}. Could not fit: ${remainder}.`
    : `Granted ${granted}.`;
}

function formatInteger(value: string): string {
  return BigInt(value).toLocaleString();
}
