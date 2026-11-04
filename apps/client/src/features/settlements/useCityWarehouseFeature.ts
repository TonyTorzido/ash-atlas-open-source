import type {
  CityAppSnapshot,
  CityStructureSnapshot,
  CityWarehouseSnapshot,
  PlayerInventorySnapshot,
  SettlementServerMessage
} from "@ash-atlas/shared";
import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";

import type { GameClient } from "../../gameClient.js";
import type {
  CityWarehouseDonationIntent,
  CityWarehousePendingRequest
} from "./settlementFeatureModel.js";

interface CityWarehouseFeatureOptions {
  getClient(): GameClient | null;
  receiveInventorySnapshot?: ((snapshot: PlayerInventorySnapshot) => void) | undefined;
  receiveWalletGold?: ((gold: string, revision?: string) => void) | undefined;
  showActionError(message: string): void;
  showActionSuccess(message: string): void;
  setCityActionBusy: Dispatch<SetStateAction<boolean>>;
  setCityApp: Dispatch<SetStateAction<CityAppSnapshot | null>>;
}

type CityWarehouseMessage = Extract<
  SettlementServerMessage,
  {
    type:
      | "CITY_WAREHOUSE_OPENED"
      | "CITY_WAREHOUSE_UPDATED"
      | "CITY_GOLD_DONATED";
  }
>;

/** Owns the open warehouse and its request-correlated inventory operations. */
export function useCityWarehouseFeature({
  getClient,
  receiveInventorySnapshot,
  receiveWalletGold,
  showActionError,
  showActionSuccess,
  setCityActionBusy,
  setCityApp
}: CityWarehouseFeatureOptions) {
  const [cityWarehouse, setCityWarehouse] = useState<CityWarehouseSnapshot | null>(null);
  const [activeWarehouseStructureId, setActiveWarehouseStructureId] =
    useState<string | null>(null);
  const [cityWarehousePending, setCityWarehousePending] =
    useState<CityWarehousePendingRequest | null>(null);
  const [cityWarehouseFeedback, setCityWarehouseFeedback] = useState<string | null>(null);
  const [cityWarehouseError, setCityWarehouseError] = useState<string | null>(null);
  const activeWarehouseStructureIdRef = useRef<string | null>(null);
  const cityWarehousePendingRef = useRef<CityWarehousePendingRequest | null>(null);

  const installWarehousePending = useCallback((
    pending: CityWarehousePendingRequest | null
  ): void => {
    cityWarehousePendingRef.current = pending;
    setCityWarehousePending(pending);
  }, []);

  const failWarehouseRequest = useCallback((message: string): void => {
    installWarehousePending(null);
    setCityWarehouseError(message);
    setCityWarehouseFeedback(null);
    showActionError(message);
  }, [installWarehousePending, showActionError]);

  const openCityWarehouse = useCallback((structureId: string): boolean => {
    activeWarehouseStructureIdRef.current = structureId;
    setActiveWarehouseStructureId(structureId);
    setCityWarehouse(null);
    setCityWarehouseError(null);
    setCityWarehouseFeedback(null);
    const requestId = getClient()?.openCityWarehouse(structureId) ?? null;
    if (!requestId) {
      activeWarehouseStructureIdRef.current = null;
      setActiveWarehouseStructureId(null);
      failWarehouseRequest("Cannot open the City Warehouse while disconnected.");
      return false;
    }
    installWarehousePending({
      requestId,
      structureId,
      action: "open"
    });
    return true;
  }, [failWarehouseRequest, getClient, installWarehousePending]);

  const donateCityWarehouse = useCallback((
    donation: CityWarehouseDonationIntent
  ): boolean => {
    const structureId = activeWarehouseStructureIdRef.current;
    if (!structureId || donation.warehouseStructureId !== structureId) {
      failWarehouseRequest(
        "This City Warehouse session is stale. Close it and reopen the Warehouse."
      );
      return false;
    }
    if (cityWarehousePendingRef.current) return false;
    setCityWarehouseError(null);
    setCityWarehouseFeedback(null);
    const requestId = getClient()?.donateCityWarehouse(
      structureId,
      donation.stackId,
      donation.quantity
    ) ?? null;
    if (!requestId) {
      failWarehouseRequest("Cannot donate while disconnected. Reopen the City Warehouse.");
      return false;
    }
    installWarehousePending({
      requestId,
      structureId,
      action: "donate",
      donation
    });
    return true;
  }, [failWarehouseRequest, getClient, installWarehousePending]);

  const donateAllCityWarehouse = useCallback((): boolean => {
    const structureId = activeWarehouseStructureIdRef.current;
    if (!structureId) {
      failWarehouseRequest(
        "This City Warehouse session is stale. Close it and reopen the Warehouse."
      );
      return false;
    }
    if (cityWarehousePendingRef.current) return false;
    setCityWarehouseError(null);
    setCityWarehouseFeedback(null);
    const requestId = getClient()?.donateAllCityWarehouse(structureId) ?? null;
    if (!requestId) {
      failWarehouseRequest("Cannot donate while disconnected. Reopen the City Warehouse.");
      return false;
    }
    installWarehousePending({
      requestId,
      structureId,
      action: "donate_all"
    });
    return true;
  }, [failWarehouseRequest, getClient, installWarehousePending]);

  const moveCityWarehouseStack = useCallback((
    stackId: string,
    targetSlot: number
  ): boolean => {
    const structureId = activeWarehouseStructureIdRef.current;
    if (!structureId) {
      failWarehouseRequest(
        "This City Warehouse session is stale. Close it and reopen the Warehouse."
      );
      return false;
    }
    if (cityWarehousePendingRef.current) return false;
    setCityWarehouseError(null);
    setCityWarehouseFeedback(null);
    const requestId = getClient()?.moveCityWarehouseStack(
      structureId,
      stackId,
      targetSlot
    ) ?? null;
    if (!requestId) {
      failWarehouseRequest(
        "Cannot reorganize while disconnected. Reopen the City Warehouse."
      );
      return false;
    }
    installWarehousePending({
      requestId,
      structureId,
      action: "move"
    });
    return true;
  }, [failWarehouseRequest, getClient, installWarehousePending]);

  const reorganizeCityWarehouse = useCallback((): boolean => {
    const structureId = activeWarehouseStructureIdRef.current;
    if (!structureId || cityWarehousePendingRef.current) return false;
    setCityWarehouseError(null);
    setCityWarehouseFeedback(null);
    const requestId = getClient()?.reorganizeCityWarehouse(structureId) ?? null;
    if (!requestId) {
      failWarehouseRequest(
        "Cannot reorganize while disconnected. Reopen the City Warehouse."
      );
      return false;
    }
    installWarehousePending({ requestId, structureId, action: "reorganize" });
    return true;
  }, [failWarehouseRequest, getClient, installWarehousePending]);

  const donateCityGold = useCallback((amount: string): boolean => {
    const structureId = activeWarehouseStructureIdRef.current;
    if (!structureId || cityWarehousePendingRef.current) return false;
    const requestId = getClient()?.donateCityGold(structureId, amount) ?? null;
    if (!requestId) {
      failWarehouseRequest("Cannot donate Gold while disconnected.");
      return false;
    }
    installWarehousePending({
      requestId,
      structureId,
      action: "gold"
    });
    setCityWarehouseError(null);
    setCityWarehouseFeedback(null);
    return true;
  }, [failWarehouseRequest, getClient, installWarehousePending]);

  const closeCityWarehouse = useCallback((): void => {
    activeWarehouseStructureIdRef.current = null;
    setActiveWarehouseStructureId(null);
    setCityWarehouse(null);
    installWarehousePending(null);
    setCityWarehouseFeedback(null);
    setCityWarehouseError(null);
  }, [installWarehousePending]);

  const handleCityWarehouseError = useCallback((message: {
    type: "ERROR";
    requestId?: string;
    code: string;
    message: string;
  }): boolean => {
    const pending = cityWarehousePendingRef.current;
    if (!pending || !message.requestId || pending.requestId !== message.requestId) {
      return false;
    }
    installWarehousePending(null);
    setCityWarehouseFeedback(null);
    setCityWarehouseError(message.message);
    if (
      pending.action === "open" ||
      message.code === "CITY_WAREHOUSE_ACCESS_DENIED"
    ) {
      activeWarehouseStructureIdRef.current = null;
      setActiveWarehouseStructureId(null);
      setCityWarehouse(null);
    }
    showActionError(message.message);
    return true;
  }, [installWarehousePending, showActionError]);

  const reconcileWarehouseConnection = useCallback((online: boolean): void => {
    if (online || !activeWarehouseStructureIdRef.current) return;
    activeWarehouseStructureIdRef.current = null;
    setActiveWarehouseStructureId(null);
    setCityWarehouse(null);
    installWarehousePending(null);
    setCityWarehouseFeedback(null);
    setCityWarehouseError(
      "Disconnected from the City Warehouse. Reconnect, then reopen it."
    );
  }, [installWarehousePending]);

  const handleWarehouseFacilityDestroyed = useCallback((structure: CityStructureSnapshot): void => {
    const openWarehouseId = activeWarehouseStructureIdRef.current;
    if (
      structure.type === "warehouse" &&
      openWarehouseId === structure.structureId
    ) {
      activeWarehouseStructureIdRef.current = null;
      setActiveWarehouseStructureId(null);
      setCityWarehouse(null);
      installWarehousePending(null);
      setCityWarehouseFeedback(null);
      setCityWarehouseError(
        "This Warehouse was destroyed. Its stored items are now ground drops."
      );
    } else if (openWarehouseId && !cityWarehousePendingRef.current) {
      openCityWarehouse(openWarehouseId);
    }
  }, [installWarehousePending, openCityWarehouse]);

  const handleWarehouseFrame = useCallback((message: CityWarehouseMessage): void => {
    switch (message.type) {
      case "CITY_WAREHOUSE_OPENED":
        if (
          activeWarehouseStructureIdRef.current !== message.warehouse.structureId ||
          cityWarehousePendingRef.current?.requestId !== message.requestId ||
          cityWarehousePendingRef.current.action !== "open"
        ) {
          return;
        }
        installWarehousePending(null);
        setCityWarehouse(message.warehouse);
        setCityWarehouseError(null);
        setCityWarehouseFeedback(message.warehouse.stacks.length === 0
          ? `${message.warehouse.cityName} City Warehouse opened. The Warehouse is empty.`
          : `${message.warehouse.cityName} City Warehouse opened.`);
        return;
      case "CITY_WAREHOUSE_UPDATED": {
        const pending = cityWarehousePendingRef.current;
        if (
          activeWarehouseStructureIdRef.current !== message.warehouse.structureId ||
          !pending ||
          pending.requestId !== message.requestId
        ) {
          return;
        }
        installWarehousePending(null);
        setCityWarehouse(message.warehouse);
        receiveInventorySnapshot?.(message.inventory);
        setCityWarehouseError(null);
        setCityWarehouseFeedback(
          pending.action === "donate"
            ? `Donated ${message.donatedQuantity.toLocaleString()} ${pending.donation?.displayName ?? "materials"} to the City Warehouse.`
            : pending.action === "donate_all"
              ? `Donated ${message.donatedQuantity.toLocaleString()} eligible materials to the City Warehouse.`
            : pending.action === "reorganize"
              ? "City Warehouse reorganized."
              : "City Warehouse organization updated."
        );
        getClient()?.requestCityApp();
        return;
      }
      case "CITY_GOLD_DONATED":
        if (
          cityWarehousePendingRef.current?.action !== "gold" ||
          cityWarehousePendingRef.current.requestId !== message.requestId
        ) {
          return;
        }
        installWarehousePending(null);
        setCityActionBusy(false);
        setCityWarehouse((current) =>
          current?.structureId === message.warehouse.structureId
            ? message.warehouse
            : current
        );
        setCityApp((current) => current
          ? { ...current, gold: message.warehouse.gold }
          : current
        );
        receiveWalletGold?.(message.walletGold, message.walletVersion);
        setCityWarehouseFeedback(
          `Donated ${message.donatedGold} Gold to ${message.warehouse.cityName}.`
        );
        showActionSuccess(
          `Donated ${message.donatedGold} Gold to ${message.warehouse.cityName}.`
        );
        getClient()?.requestCityApp();
        return;
    }
    message satisfies never;
  }, [installWarehousePending, getClient, receiveInventorySnapshot, receiveWalletGold, setCityActionBusy, setCityApp, showActionSuccess]);

  return {
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
  };
}
