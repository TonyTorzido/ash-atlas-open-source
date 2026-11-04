import type {
  CityActiveConstructionSnapshot,
  CityConstructionAction,
  CityAppSnapshot,
  CityFoundingPreview,
  CityInfoSnapshot,
  CityMembershipSnapshot,
  CitySnapshot,
  CityStructureSnapshot,
  DroppedItemSnapshot,
  FlagSnapshot,
  KingdomPublicSnapshot,
  KingdomStateSnapshot,
  OilWellSnapshot,
  LibrarySnapshot,
  PlayerInventorySnapshot,
  PremiumWalletSnapshot,
  CityPhysicalConstructionAction,
  GoblinMarketSnapshot,
  HollinHutShopSnapshot,
  WanderingMerchantMapEntry,
  WanderingMerchantShopSnapshot,
  EquipmentSnapshotV2,
  BackpackSnapshot,
  SettlementServerMessage,
  MilitaryIndustrySnapshot,
  MilitarySiegeVolleyCue,
  MilitaryBomberDetonationCue
} from "@ash-atlas/shared";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";

import { applyCityUpdate, reconcileCitySnapshot } from "../../city/cityReplication.js";
import { upsertFlagSnapshot } from "../../flags/flagDisplay.js";
import {
  createFlagBuildCountdown
} from "../../flags/flagBuildCountdown.js";
import type { GameClient } from "../../gameClient.js";
import {
  mergeKingdomChatHistory,
  nextSelectedKingdomId
} from "../../kingdom/kingdomPanelModel.js";
import { KingdomSpatialRevisionTracker } from "../../kingdom/kingdomSpatial.js";
import {
  reconcileActiveCityConstruction,
  upsertCityStructure,
  type ActiveCityFlagConversion,
  type PendingCityFlagConversion
} from "./settlementFeatureModel.js";
import { useCityWarehouseFeature } from "./useCityWarehouseFeature.js";

export const CITY_CONSTRUCTION_RESULT_TIMEOUT_MS = 15_000;

export {
  isSettlementServerMessage,
  type ActiveCityFlagConversion,
  type CityWarehouseDonationIntent,
  type CityWarehousePendingRequest,
  type PendingCityFlagConversion
} from "./settlementFeatureModel.js";

export interface SettlementFeatureOptions {
  ownPlayerId: string;
  getClient(): GameClient | null;
  online?: boolean;
  receiveInventorySnapshot?(snapshot: PlayerInventorySnapshot): void;
  receiveWalletGold?(gold: string, revision?: string): void;
  receivePremiumWallet?(snapshot: PremiumWalletSnapshot): void;
  receiveEquipmentSnapshot?(snapshot: EquipmentSnapshotV2): void;
  receiveBackpackSnapshot?(snapshot: BackpackSnapshot): void;
  receiveDroppedItems?(drops: DroppedItemSnapshot[]): void;
  onOilWellHarvested?(requestId: string, quantity: number, itemId: "crude_oil" | "crystal"): void;
  showActionError(message: string): void;
  showActionSuccess(message: string): void;
  setFlags: Dispatch<SetStateAction<FlagSnapshot[]>>;
  setSelectedFlagId: Dispatch<SetStateAction<string | null>>;
  closeFlagInteraction?(): void;
  setWarning: Dispatch<SetStateAction<string | null>>;
  isFlagVisible?(flag: FlagSnapshot): boolean;
}

export function useSettlementFeature({
  ownPlayerId,
  getClient,
  online = true,
  receiveInventorySnapshot,
  receiveWalletGold,
  receivePremiumWallet,
  receiveEquipmentSnapshot,
  receiveBackpackSnapshot,
  receiveDroppedItems,
  onOilWellHarvested,
  showActionError,
  showActionSuccess,
  setFlags,
  setSelectedFlagId,
  closeFlagInteraction,
  setWarning,
  isFlagVisible
}: SettlementFeatureOptions) {
  const [cities, setCities] = useState<CitySnapshot[]>([]);
  const [cityMembership, setCityMembership] = useState<CityMembershipSnapshot | null>(null);
  const [cityInfo, setCityInfo] = useState<CityInfoSnapshot | null>(null);
  const [cityApp, setCityApp] = useState<CityAppSnapshot | null>(null);
  const [militaryIndustry, setMilitaryIndustry] = useState<MilitaryIndustrySnapshot | null>(null);
  const [militarySiegeVolleyCues, setMilitarySiegeVolleyCues] =
    useState<readonly MilitarySiegeVolleyCue[]>([]);
  const [militaryBomberDetonationCues, setMilitaryBomberDetonationCues] =
    useState<readonly MilitaryBomberDetonationCue[]>([]);
  const observedBomberChannels = useRef(new Map<string, string>());
  const seenBomberDetonations = useRef(new Set<string>());
  const [cityStructures, setCityStructures] = useState<CityStructureSnapshot[]>([]);
  const [goblinMarket, setGoblinMarket] = useState<GoblinMarketSnapshot | null>(null);
  const [goblinMarketBusy, setGoblinMarketBusy] = useState(false);
  const [hollinShop, setHollinShop] = useState<HollinHutShopSnapshot | null>(null);
  const [hollinShopBusy, setHollinShopBusy] = useState(false);
  const [wanderingMerchants, setWanderingMerchants] = useState<WanderingMerchantMapEntry[]>([]);
  const [merchantShop, setMerchantShop] = useState<WanderingMerchantShopSnapshot | null>(null);
  const [merchantShopBusy, setMerchantShopBusy] = useState(false);
  const [oilWell, setOilWell] = useState<OilWellSnapshot | null>(null);
  const [oilWellFeedback, setOilWellFeedback] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [cityFoundingPreview, setCityFoundingPreview] =
    useState<CityFoundingPreview | null>(null);
  const [selectedCityId, setSelectedCityId] = useState<string | null>(null);
  const [foundingCity, setFoundingCity] = useState(false);
  const [cityActionBusy, setCityActionBusy] = useState(false);
  const [cityConstructionBusy, setCityConstructionBusy] = useState(false);
  const [cityConstructionError, setCityConstructionError] = useState<string | null>(null);
  const [activeCityConstruction, setActiveCityConstruction] =
    useState<CityActiveConstructionSnapshot | null>(null);
  const [pendingCityFlagConversion, setPendingCityFlagConversion] =
    useState<PendingCityFlagConversion | null>(null);
  const [activeCityFlagConversion, setActiveCityFlagConversion] =
    useState<ActiveCityFlagConversion | null>(null);
  const [joiningCity, setJoiningCity] = useState(false);
  const [leavingCity, setLeavingCity] = useState(false);
  const [pendingLeaveCityId, setPendingLeaveCityId] = useState<string | null>(null);
  const [socialRefreshToken, setSocialRefreshToken] = useState(0);
  const [kingdomState, setKingdomState] = useState<KingdomStateSnapshot | null>(null);
  const [kingdomPanelOpen, setKingdomPanelOpen] = useState(false);
  const [selectedKingdomId, setSelectedKingdomId] = useState<string | null>(null);
  const [selectedPublicKingdom, setSelectedPublicKingdom] =
    useState<KingdomPublicSnapshot | null>(null);
  const [publicKingdomError, setPublicKingdomError] = useState<string | null>(null);
  const selectedCityIdRef = useRef<string | null>(selectedCityId);
  const pendingCityFlagConversionRef = useRef<PendingCityFlagConversion | null>(null);
  const pendingCityConstructionRef = useRef<{
    requestId: string;
    action: CityPhysicalConstructionAction;
  } | null>(null);
  const cityConstructionTimeoutRef = useRef<number | null>(null);
  const pendingMarketDailyRef = useRef<string | null>(null);
  const pendingCityStageRef = useRef<{
    requestId: string;
    action: CityConstructionAction;
  } | null>(null);
  const spatialRevisionRef = useRef(new KingdomSpatialRevisionTracker());

  useEffect(() => {
    if (militarySiegeVolleyCues.length === 0) return;
    const timeout = window.setTimeout(() => setMilitarySiegeVolleyCues([]), 1_000);
    return () => window.clearTimeout(timeout);
  }, [militarySiegeVolleyCues]);
  useEffect(() => {
    if (militaryBomberDetonationCues.length === 0) return;
    const timeout = window.setTimeout(() => setMilitaryBomberDetonationCues([]), 3_000);
    return () => window.clearTimeout(timeout);
  }, [militaryBomberDetonationCues]);
  const {
    cityWarehouse,
    activeWarehouseStructureId,
    cityWarehousePending,
    cityWarehouseFeedback,
    cityWarehouseError,
    setCityWarehouse,
    openCityWarehouse,
    donateCityWarehouse,
    donateAllCityWarehouse,
    moveCityWarehouseStack,
    reorganizeCityWarehouse,
    donateCityGold,
    closeCityWarehouse,
    handleCityWarehouseError,
    handleWarehouseFrame,
    handleWarehouseFacilityDestroyed,
    reconcileWarehouseConnection
  } = useCityWarehouseFeature({
    getClient,
    receiveInventorySnapshot,
    receiveWalletGold,
    showActionError,
    showActionSuccess,
    setCityActionBusy,
    setCityApp
  });
  selectedCityIdRef.current = selectedCityId;

  useEffect(() => {
    setCityConstructionError(null);
  }, [selectedCityId]);

  const disarmCityConstructionTimeout = useCallback((): void => {
    if (cityConstructionTimeoutRef.current !== null) {
      window.clearTimeout(cityConstructionTimeoutRef.current);
      cityConstructionTimeoutRef.current = null;
    }
  }, []);

  const settlePendingCityConstruction = useCallback((
    requestId: string,
    matched = false
  ): boolean => {
    const pending = pendingCityConstructionRef.current;
    if (
      (pending && pending.requestId !== requestId) ||
      (!pending && !matched)
    ) return false;
    pendingCityConstructionRef.current = null;
    disarmCityConstructionTimeout();
    setCityActionBusy(false);
    return true;
  }, [disarmCityConstructionTimeout]);

  const armCityConstructionTimeout = useCallback((requestId: string): void => {
    disarmCityConstructionTimeout();
    cityConstructionTimeoutRef.current = window.setTimeout(() => {
      if (pendingCityConstructionRef.current?.requestId !== requestId) return;
      if (!settlePendingCityConstruction(requestId)) return;
      const message = "City construction result was not confirmed. Refresh City records and retry.";
      setCityConstructionError(message);
      getClient()?.requestCityApp();
      showActionError(message);
    }, CITY_CONSTRUCTION_RESULT_TIMEOUT_MS);
  }, [disarmCityConstructionTimeout, getClient, settlePendingCityConstruction, showActionError]);

  useEffect(() => () => {
    disarmCityConstructionTimeout();
  }, [disarmCityConstructionTimeout]);

  useEffect(() => {
    if (online) return;
    const pendingPhysical = pendingCityConstructionRef.current;
    if (pendingPhysical) {
      settlePendingCityConstruction(pendingPhysical.requestId);
      const message = "City construction was interrupted. Reconnect and try again.";
      setCityConstructionError(message);
      showActionError(message);
    }
    if (pendingCityStageRef.current) {
      pendingCityStageRef.current = null;
      setCityActionBusy(false);
      setCityConstructionBusy(false);
      setCityConstructionError("Reconnect to continue city construction.");
    }
  }, [online, settlePendingCityConstruction, showActionError]);

  const installPendingCityFlagConversion = useCallback((
    pending: PendingCityFlagConversion | null
  ): void => {
    pendingCityFlagConversionRef.current = pending;
    setPendingCityFlagConversion(pending);
  }, []);

  const trackCityConstructionRequest = useCallback((
    requestId: string | null,
    action: CityPhysicalConstructionAction
  ): boolean => {
    if (!online || !requestId) return false;
    pendingCityConstructionRef.current = { requestId, action };
    setCityConstructionError(null);
    setCityActionBusy(true);
    armCityConstructionTimeout(requestId);
    return true;
  }, [armCityConstructionTimeout, online]);

  const advanceCityConstruction = useCallback((
    cityId: string,
    action: CityConstructionAction
  ): boolean => {
    if (!online || cityActionBusy || cityConstructionBusy || pendingCityStageRef.current) {
      return false;
    }
    setCityConstructionError(null);
    setWarning(null);
    const requestId = getClient()?.advanceCityConstruction(cityId, action) ?? null;
    if (!requestId) {
      const message = "Cannot continue city construction while disconnected.";
      setCityConstructionError(message);
      showActionError(message);
      return false;
    }
    pendingCityStageRef.current = { requestId, action };
    setCityActionBusy(true);
    setCityConstructionBusy(true);
    return true;
  }, [cityActionBusy, cityConstructionBusy, getClient, online, setWarning, showActionError]);

  const buyCityMarketDaily = useCallback((cityId: string): boolean => {
    if (!online || cityActionBusy || pendingMarketDailyRef.current) return false;
    const requestId = getClient()?.buyCityMarketDaily(cityId) ?? null;
    if (!requestId) {
      showActionError("Cannot buy the daily package while disconnected.");
      return false;
    }
    pendingMarketDailyRef.current = requestId;
    setCityActionBusy(true);
    return true;
  }, [cityActionBusy, getClient, online, showActionError]);

  const handleCityConstructionError = useCallback((message: {
    requestId?: string;
    message: string;
  }): boolean => {
    if (message.requestId && message.requestId === pendingMarketDailyRef.current) {
      pendingMarketDailyRef.current = null;
      setCityActionBusy(false);
      showActionError(message.message);
      return true;
    }
    const pendingStage = pendingCityStageRef.current;
    if (pendingStage && message.requestId === pendingStage.requestId) {
      pendingCityStageRef.current = null;
      setCityActionBusy(false);
      setCityConstructionBusy(false);
      setCityConstructionError(message.message);
      return true;
    }
    const pendingPhysical = pendingCityConstructionRef.current;
    if (!pendingPhysical || message.requestId !== pendingPhysical.requestId) return false;
    settlePendingCityConstruction(message.requestId);
    setCityConstructionError(message.message);
    return true;
  }, [settlePendingCityConstruction]);

  const convertCityFlag = useCallback((flagId: string): boolean => {
    if (pendingCityFlagConversionRef.current) return false;
    setCityActionBusy(true);
    setWarning(null);
    const requestId = getClient()?.convertCityFlag(flagId) ?? null;
    if (!requestId) {
      setCityActionBusy(false);
      showActionError("Cannot contribute a flag while disconnected.");
      return false;
    }
    installPendingCityFlagConversion({ requestId, flagId });
    closeFlagInteraction?.();
    return true;
  }, [
    closeFlagInteraction,
    getClient,
    installPendingCityFlagConversion,
    setWarning,
    showActionError
  ]);

  const handleCityFlagConversionError = useCallback((
    message: {
      requestId?: string;
      message: string;
      type?: string;
      code?: string;
    },
    formattedMessage = message.message
  ): boolean => {
    const pending = pendingCityFlagConversionRef.current;
    if (!pending || message.requestId !== pending.requestId) return false;
    installPendingCityFlagConversion(null);
    setActiveCityFlagConversion(null);
    setCityActionBusy(false);
    if (message.code === "CITY_FLAG_CONVERSION_CANCELLED") {
      showActionSuccess(formattedMessage);
    } else {
      showActionError(formattedMessage);
    }
    return true;
  }, [installPendingCityFlagConversion, showActionError, showActionSuccess]);

  useEffect(() => {
    reconcileWarehouseConnection(online);
  }, [reconcileWarehouseConnection, online]);

  const applyKingdomSnapshot = useCallback((next: KingdomStateSnapshot): void => {
    setKingdomState((current) =>
      spatialRevisionRef.current.reconcileSnapshot(current, next)
    );
    setSelectedKingdomId((current) =>
      nextSelectedKingdomId(current, next.kingdom?.id)
    );
  }, []);

  const resetKingdomState = useCallback((): void => {
    // WELCOME starts a new connection baseline, never a replay of a past explosion.
    observedBomberChannels.current.clear();
    seenBomberDetonations.current.clear();
    setMilitaryBomberDetonationCues([]);
    setMilitarySiegeVolleyCues([]);
    spatialRevisionRef.current.reset();
    setKingdomState(null);
    setSelectedKingdomId(null);
    setSelectedPublicKingdom(null);
    setPublicKingdomError(null);
  }, []);

  const handleServerMessage = useCallback((message: SettlementServerMessage): void => {
    switch (message.type) {
      case "KINGDOM_STATE":
        applyKingdomSnapshot(message.state);
        return;
      case "KINGDOM_STATE_CHANGED":
        setSocialRefreshToken((current) => current + 1);
        getClient()?.requestKingdomState();
        getClient()?.requestWorldMapDestinations();
        return;
      case "KINGDOM_SPATIAL_CHANGES":
        setKingdomState((current) => current
          ? spatialRevisionRef.current.applyBatch(current, message.changes)
          : current);
        return;
      case "KINGDOM_CHAT_MESSAGE":
        setKingdomState((current) => {
          if (!current?.kingdom || current.kingdom.id !== message.message.kingdomId) {
            return current;
          }
          return {
            ...current,
            chatHistory: mergeKingdomChatHistory(current.chatHistory, message.message)
          };
        });
        return;
      case "CITIES_SNAPSHOT":
        setCities((current) => reconcileCitySnapshot(current, message.cities));
        return;
      case "CITY_MEMBERSHIP_SNAPSHOT":
        setCityMembership(message.membership);
        return;
      case "CITY_APP":
        if (
          message.snapshot.activeConstruction &&
          pendingCityConstructionRef.current?.requestId === message.snapshot.activeConstruction.requestId
        ) {
          settlePendingCityConstruction(message.snapshot.activeConstruction.requestId);
          setCityConstructionError(null);
        }
        setCityApp(message.snapshot);
        setActiveCityConstruction(message.snapshot.activeConstruction);
        return;
      case "CITY_STRUCTURES_SNAPSHOT":
        setCityStructures(message.structures);
        return;
      case "GOBLIN_MARKET_SNAPSHOT":
        setGoblinMarket(message.snapshot);
        setGoblinMarketBusy(false);
        return;
      case "GOBLIN_MARKET_SOLD":
        setGoblinMarket(message.snapshot);
        setGoblinMarketBusy(false);
        receiveInventorySnapshot?.(message.inventory);
        receiveEquipmentSnapshot?.(message.equipment);
        receiveBackpackSnapshot?.(message.backpacks);
        receiveWalletGold?.(message.walletGold, message.walletVersion);
        showActionSuccess(`Sold for ${message.offerGold} Gold.`);
        return;
      case "GOBLIN_MARKET_PURCHASED":
        setGoblinMarket(message.snapshot);
        setGoblinMarketBusy(false);
        receiveInventorySnapshot?.(message.inventory);
        receiveWalletGold?.(message.walletGold, message.walletVersion);
        showActionSuccess(`Bought ${message.quantity} Wheat Seed${message.quantity === 1 ? "" : "s"} for ${message.totalGold} Gold.`);
        return;
      case "HOLLIN_HUT_SHOP":
        setHollinShop(message.snapshot);
        setHollinShopBusy(false);
        return;
      case "HOLLIN_HUT_PURCHASED":
        setHollinShop(message.snapshot);
        setHollinShopBusy(false);
        receiveInventorySnapshot?.(message.inventory);
        receiveWalletGold?.(message.walletGold, message.walletVersion);
        showActionSuccess(`Bought ${message.quantity} for ${message.totalGold} Gold.`);
        return;
      case "HOLLIN_HUT_PACIFIED":
        setHollinShop(message.snapshot);
        setHollinShopBusy(false);
        receiveInventorySnapshot?.(message.inventory);
        showActionSuccess(message.message);
        return;
      case "HOLLIN_HUT_SERVICED":
        setHollinShop(message.snapshot);
        setHollinShopBusy(false);
        if (message.inventory) receiveInventorySnapshot?.(message.inventory);
        if (message.walletGold !== undefined && message.walletVersion !== undefined) {
          receiveWalletGold?.(message.walletGold, message.walletVersion);
        }
        showActionSuccess(message.message);
        return;
      case "WANDERING_MERCHANTS":
        setWanderingMerchants(message.merchants);
        return;
      case "WANDERING_MERCHANT_SHOP":
        setMerchantShop(message.snapshot);
        setMerchantShopBusy(false);
        return;
      case "WANDERING_MERCHANT_PURCHASED":
        setMerchantShop(message.snapshot);
        setMerchantShopBusy(false);
        receiveInventorySnapshot?.(message.inventory);
        receiveWalletGold?.(message.walletGold, message.walletVersion);
        showActionSuccess(`Bought ${message.quantity} for ${message.totalGold} Gold.`);
        return;
      case "CINDER_LANTERN_CRAFTED":
        receiveInventorySnapshot?.(message.inventory);
        showActionSuccess(message.message);
        return;
      case "WANDERING_MERCHANT_ERROR":
        setMerchantShopBusy(false);
        showActionError(message.message);
        return;
      case "HOLLIN_HUT_ERROR":
        setHollinShopBusy(false);
        showActionError(message.message);
        return;
      case "GOBLIN_MARKET_ERROR":
        setGoblinMarketBusy(false);
        showActionError(message.message);
        return;
      case "GOBLIN_VILLAGE_REMOVED":
        setCities((current) => current.filter((city) => city.id !== message.cityId));
        setSelectedCityId((current) => current === message.cityId ? null : current);
        setCityInfo((current) => current?.city.id === message.cityId ? null : current);
        setCityApp((current) => current?.city?.id === message.cityId ? null : current);
        setCityStructures((current) => current.filter((structure) =>
          structure.cityId !== message.cityId &&
          !message.structureIds.includes(structure.structureId)
        ));
        setGoblinMarket((current) => current?.cityId === message.cityId ? null : current);
        setGoblinMarketBusy(false);
        return;
      case "OWNER_OIL_WELL_PROJECTION":
        setCityStructures((current) => message.structure
          ? upsertCityStructure(current, message.structure)
          : current.filter((structure) =>
              structure.type !== "oil_well" ||
              structure.ownerPlayerId !== ownPlayerId
            ));
        return;
      case "CITY_HOUSE_CHANGED":
        {
          const matchedPending =
            pendingCityConstructionRef.current?.requestId === message.requestId;
          reconcileActiveCityConstruction(
            message,
            pendingCityConstructionRef,
            setActiveCityConstruction
          );
          if (matchedPending) {
            settlePendingCityConstruction(message.requestId, true);
            setCityConstructionError(null);
          } else if (
            message.structure.state === "destroyed" &&
            !pendingCityConstructionRef.current &&
            !pendingCityStageRef.current
          ) {
            setCityActionBusy(false);
          }
        }
        if (message.inventory) receiveInventorySnapshot?.(message.inventory);
        if (message.droppedItems) receiveDroppedItems?.(message.droppedItems);
        if (message.structure.ownerPlayerId === ownPlayerId) {
          if (
            message.structure.state === "destroyed" &&
            message.requestId.startsWith("city-build-cancel:")
          ) {
            showActionSuccess("City House construction canceled because you moved.");
          }
          setCityMembership(message.membership);
          if (message.membership) {
            showActionSuccess(message.structure.type === "mayor_house"
              ? `Claimed Mayor of ${message.membership.cityName}.`
              : `Built a City House in ${message.membership.cityName}.`);
          }
        }
        setCityStructures((current) => upsertCityStructure(current, message.structure));
        getClient()?.requestCityApp();
        return;
      case "CITY_STRUCTURE_WARFARE_CHANGED":
        if (!message.replayed || message.action !== "repair_stopped") {
          showActionSuccess(message.action === "attack"
            ? `Hit the building for ${message.damage ?? 0} damage.`
            : message.action === "repair_started"
              ? "Repairing the building."
              : "Repair stopped.");
        }
        return;
      case "CITY_FACILITY_CHANGED":
        {
          const matchedPending =
            pendingCityConstructionRef.current?.requestId === message.requestId;
          reconcileActiveCityConstruction(
            message,
            pendingCityConstructionRef,
            setActiveCityConstruction
          );
          if (matchedPending) {
            settlePendingCityConstruction(message.requestId, true);
            setCityConstructionError(null);
          } else if (
            message.structure.state === "destroyed" &&
            !pendingCityConstructionRef.current &&
            !pendingCityStageRef.current
          ) {
            setCityActionBusy(false);
          }
        }
        if (message.droppedItems) receiveDroppedItems?.(message.droppedItems);
        if (
          (message.structure.type === "oil_well" || message.structure.type === "quartz_hut") &&
          message.structure.state === "destroyed" &&
          message.structure.ownerPlayerId === ownPlayerId &&
          message.requestId.startsWith("city-build-cancel:")
        ) {
          showActionSuccess(`${message.structure.type === "quartz_hut" ? "Quartz Hut" : "Oil Well"} construction canceled because you moved.`);
        } else if (message.requestId.startsWith("city-build-cancel:")) {
          showActionSuccess(
            `${message.structure.state === "active" ? "Upgrade" : "Construction"} canceled because you moved.`
          );
        }
        setCityStructures((current) => upsertCityStructure(current, message.structure));
        if (message.structure.state === "destroyed") {
          if (
            (message.structure.type === "oil_well" || message.structure.type === "quartz_hut") &&
            oilWell?.structureId === message.structure.structureId
          ) {
            setOilWell(null);
            setOilWellFeedback(`This ${message.structure.type === "quartz_hut" ? "Quartz Hut" : "Oil Well"} was destroyed.`);
          }
          handleWarehouseFacilityDestroyed(message.structure);
        }
        getClient()?.requestCityApp();
        return;
      case "LIBRARY_STATE":
        setLibrary(message.library);
        if (message.walletGold !== undefined && message.walletVersion !== undefined) {
          receiveWalletGold?.(message.walletGold, message.walletVersion);
        }
        if (message.result && !message.result.replayed) {
          showActionSuccess(`Studied for ${message.result.foliosGained} Folios.`);
        }
        setCityActionBusy(false);
        return;
      case "OIL_WELL_OPENED":
        setOilWell(message.well);
        setOilWellFeedback(null);
        setCityActionBusy(false);
        return;
      case "OIL_WELL_HARVESTED":
        setOilWell(message.well);
        setOilWellFeedback(message.message);
        receiveInventorySnapshot?.(message.inventory);
        if (message.walletGold !== undefined) {
          receiveWalletGold?.(message.walletGold, message.walletVersion);
        }
        if (!message.replayed && message.harvestedQuantity > 0) {
          onOilWellHarvested?.(
            message.requestId,
            message.harvestedQuantity,
            message.well.resourceItemId ?? "crude_oil"
          );
        }
        setCityActionBusy(false);
        return;
      case "CITY_WAREHOUSE_OPENED":
      case "CITY_WAREHOUSE_UPDATED":
      case "CITY_GOLD_DONATED":
        return handleWarehouseFrame(message);
      case "CITY_MARKET_DAILY_PURCHASED":
        if (pendingMarketDailyRef.current === message.requestId) {
          pendingMarketDailyRef.current = null;
          setCityActionBusy(false);
        }
        setCityApp((current) => current
          ? { ...current, marketDaily: message.marketDaily, treasuryBalance: message.treasuryBalance }
          : current);
        receivePremiumWallet?.(message.premiumWallet);
        if (!message.replayed) {
          showActionSuccess(
            `Bought ${message.marketDaily.cityCoins.toLocaleString()} City Coins for ${message.marketDaily.glimmer} Glimmer.`
          );
        }
        getClient()?.requestCityApp();
        return;
      case "CITY_FOUNDING_PREVIEW":
        setFoundingCity(false);
        if (!message.preview.eligible) {
          const reason = message.preview.reason ?? "This flag cannot found a city";
          setWarning(reason);
          showActionError(reason);
          return;
        }
        setCityFoundingPreview(message.preview);
        return;
      case "CITY_CONSTRUCTION_ADVANCED":
        if (pendingCityStageRef.current?.requestId !== message.requestId) return;
        pendingCityStageRef.current = null;
        setCityActionBusy(false);
        setCityConstructionBusy(false);
        setCityConstructionError(null);
        setCities((current) => applyCityUpdate(current, message.city));
        setCityInfo((current) => current?.city.id === message.city.id
          ? { ...current, city: message.city }
          : current);
        if (message.inventory) receiveInventorySnapshot?.(message.inventory);
        if (message.walletGold !== undefined) {
          receiveWalletGold?.(message.walletGold, message.walletVersion);
        }
        showActionSuccess(message.action === "build_foundation"
          ? "Foundation built."
          : message.action === "build_frames"
            ? "Frames built."
            : `${message.city.name} construction complete.`);
        return;
      case "CITY_INFO":
        if (selectedCityIdRef.current === message.info.city.id) {
          setCities((current) => applyCityUpdate(current, message.info.city));
          setCityInfo(message.info);
        }
        return;
      case "CITY_FOUNDED":
        setFoundingCity(false);
        setCityFoundingPreview(null);
        setCities((current) => applyCityUpdate(current, message.city));
        setFlags((current) => message.territoryFlags.reduce(
          (next, flag) => upsertFlagSnapshot(next, flag),
          current
        ));
        setSelectedFlagId(null);
        setSelectedCityId(message.city.id);
        setWarning(null);
        return;
      case "CITY_TERRITORY_SYNC":
        setFlags((current) => message.flags.filter((flag) =>
          isFlagVisible?.(flag) !== false
        ).reduce(
          (next, flag) => upsertFlagSnapshot(next, flag),
          current
        ));
        return;
      case "CITY_JOINED":
        setJoiningCity(false);
        setCityMembership(message.membership);
        setCityInfo(message.info);
        setCityApp(null);
        getClient()?.requestCityApp();
        setWarning(null);
        return;
      case "CITY_LEFT":
        setLeavingCity(false);
        setPendingLeaveCityId(null);
        setCityMembership(null);
        setCityInfo(message.info);
        setCityApp(null);
        setActiveCityConstruction(null);
        setWarning(null);
        return;
      case "CITY_MEMBERSHIP_UPDATED":
        setCityInfo((current) => current?.city.id === message.cityId
          ? {
              ...current,
              memberCount: message.memberCount,
              expansionFlagCount: message.expansionFlagCount,
              expansionFlagLimit: message.expansionFlagLimit
            }
          : current);
        setCityMembership((current) => current?.cityId === message.cityId
          ? {
              ...current,
              expansionFlagCount: message.expansionFlagCount,
              expansionFlagLimit: message.expansionFlagLimit
            }
          : current);
        return;
      case "CITY_MAYOR_UPDATED":
        setCities((current) => applyCityUpdate(current, message.city));
        setCityInfo((current) => current?.city.id === message.city.id
          ? { ...current, city: message.city }
          : current);
        if (message.actorPlayerId === ownPlayerId) {
          setCityActionBusy(false);
          setWarning(null);
          getClient()?.requestCityApp();
        }
        if (selectedCityIdRef.current === message.city.id) {
          getClient()?.requestCityInfo(message.city.id);
        }
        return;
      case "CITY_FLAG_CONVERSION_STARTED":
        installPendingCityFlagConversion({
          requestId: message.requestId,
          flagId: message.flagId
        });
        setActiveCityFlagConversion({
          conversionId: message.conversionId,
          requestId: message.requestId,
          flagId: message.flagId,
          flagName: message.flagName,
          cityId: message.cityId,
          cityName: message.cityName,
          position: message.position,
          countdown: createFlagBuildCountdown(message, performance.now())
        });
        setCityActionBusy(true);
        setWarning(null);
        closeFlagInteraction?.();
        return;
      case "CITY_FLAG_CONVERTED":
        installPendingCityFlagConversion(null);
        setActiveCityFlagConversion(null);
        setCityActionBusy(false);
        closeFlagInteraction?.();
        setFlags((current) => upsertFlagSnapshot(current, message.flag));
        setCityMembership((current) => current
          ? {
              ...current,
              expansionFlagCount: message.expansionFlagCount,
              expansionFlagLimit: message.expansionFlagLimit
            }
          : current);
        setWarning(null);
        return;
      case "MILITARY_INDUSTRY_STATE":
      case "MILITARY_INDUSTRY_CHANGED":
        if (!(message.type === "MILITARY_INDUSTRY_CHANGED" && message.replayed)) {
          const now = getClient()?.synchronizedNow() ?? Date.now();
          const fresh = (message.bomberDetonations ?? []).filter((cue) => {
            if (observedBomberChannels.current.get(cue.requestId) !== cue.groupId ||
                seenBomberDetonations.current.has(cue.requestId) ||
                now - cue.occurredAt > 3_000 || cue.occurredAt - now > 1_000) return false;
            seenBomberDetonations.current.add(cue.requestId);
            if (seenBomberDetonations.current.size > 100) {
              seenBomberDetonations.current.delete(seenBomberDetonations.current.values().next().value!);
            }
            observedBomberChannels.current.delete(cue.requestId);
            return true;
          });
          if (fresh.length) setMilitaryBomberDetonationCues((current) => [...current, ...fresh].slice(-100));
        }
        if (message.snapshot.bomberChannel) {
          const channel = message.snapshot.bomberChannel;
          observedBomberChannels.current.set(channel.requestId, channel.groupId);
          if (observedBomberChannels.current.size > 100) {
            observedBomberChannels.current.delete(observedBomberChannels.current.keys().next().value!);
          }
        }
        setMilitaryIndustry((current) => message.snapshot.visibleGroups === undefined && current?.visibleGroups
          ? { ...message.snapshot, visibleGroups: current.visibleGroups }
          : message.snapshot);
        if (message.siegeVolleys?.length) {
          setMilitarySiegeVolleyCues(message.siegeVolleys);
        }
        setCityActionBusy(false);
        if (message.type === "MILITARY_INDUSTRY_CHANGED" && message.inventory) {
          receiveInventorySnapshot?.(message.inventory);
        }
        if (
          message.type === "MILITARY_INDUSTRY_CHANGED" &&
          message.walletGold !== undefined &&
          message.walletVersion !== undefined
        ) {
          receiveWalletGold?.(message.walletGold, message.walletVersion);
        }
        return;
    }
  }, [
    applyKingdomSnapshot,
    getClient,
    handleWarehouseFrame,
    handleWarehouseFacilityDestroyed,
    installPendingCityFlagConversion,
    onOilWellHarvested,
    openCityWarehouse,
    oilWell,
    ownPlayerId,
    receiveDroppedItems,
    receiveInventorySnapshot,
    receiveEquipmentSnapshot,
    receiveBackpackSnapshot,
    receiveWalletGold,
    receivePremiumWallet,
    setFlags,
    setSelectedFlagId,
    setWarning,
    closeFlagInteraction,
    isFlagVisible,
    settlePendingCityConstruction,
    showActionError,
    showActionSuccess
  ]);

  return {
    view: {
      cities,
      cityMembership,
      cityInfo,
      cityApp,
      militaryIndustry,
      militarySiegeVolleyCues,
      militaryBomberDetonationCues,
      cityStructures,
      goblinMarket,
      goblinMarketBusy,
      hollinShop,
      hollinShopBusy,
      wanderingMerchants,
      merchantShop,
      merchantShopBusy,
      oilWell,
      oilWellFeedback,
      library,
      cityWarehouse,
      activeWarehouseStructureId,
      cityWarehousePending,
      cityWarehouseFeedback,
      cityWarehouseError,
      cityFoundingPreview,
      selectedCityId,
      foundingCity,
      cityActionBusy,
      cityConstructionBusy,
      cityConstructionError,
      pendingCityFlagConversion,
      activeCityFlagConversion,
      activeCityConstruction,
      joiningCity,
      leavingCity,
      pendingLeaveCityId,
      socialRefreshToken,
      kingdomState,
      kingdomPanelOpen,
      selectedKingdomId,
      selectedPublicKingdom,
      publicKingdomError
    },
    actions: {
      setCities,
      setCityMembership,
      setCityInfo,
      setCityApp,
      setMilitaryIndustry,
      setCityStructures,
      setGoblinMarket,
      setGoblinMarketBusy,
      setHollinShop,
      setHollinShopBusy,
      setMerchantShop,
      setMerchantShopBusy,
      setOilWell,
      setOilWellFeedback,
      setLibrary,
      setCityWarehouse,
      setCityFoundingPreview,
      setSelectedCityId,
      setFoundingCity,
      setCityActionBusy,
      setActiveCityConstruction,
      setJoiningCity,
      setLeavingCity,
      setPendingLeaveCityId,
      setSocialRefreshToken,
      setKingdomState,
      setKingdomPanelOpen,
      setSelectedKingdomId,
      setSelectedPublicKingdom,
      setPublicKingdomError
    },
    openCityWarehouse,
    donateCityWarehouse,
    donateAllCityWarehouse,
    moveCityWarehouseStack,
    reorganizeCityWarehouse,
    donateCityGold,
    buyCityMarketDaily,
    closeCityWarehouse,
    convertCityFlag,
    advanceCityConstruction,
    trackCityConstructionRequest,
    handleCityFlagConversionError,
    handleCityConstructionError,
    handleCityWarehouseError,
    handleServerMessage,
    applyKingdomSnapshot,
    resetKingdomState
  } as const;
}

export type SettlementFeature = ReturnType<typeof useSettlementFeature>;
