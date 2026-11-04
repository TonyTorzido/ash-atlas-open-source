import {
  equipmentMetalDisplayName,
  type EquipmentMetal,
  type EnchantmentStoneVariant,
  type EquipmentSnapshotV2,
  type JewelStationState,
  type ManorServerMessage,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ManorClient } from "../../client/domains/manorClient.js";

const JEWEL_STATION_OPEN_TIMEOUT_MS = 8_000;

export function useJewelStationFeature(options: Readonly<{
  open: boolean;
  online: boolean;
  manorSessionId: string | null;
  getMovementSequence(): number;
  getCommands(): ManorClient | null;
  receiveInventory(snapshot: PlayerInventorySnapshot): void;
  receiveEquipment(snapshot: EquipmentSnapshotV2): void;
  showActionError(message: string): void;
  /** Inscribes over HTTP (a replayed request charges once on the server). */
  inscribeRequest(instanceId: string, name: string): Promise<JewelStationState>;
  onClose(): void;
}>) {
  const {
    open, online, manorSessionId, getMovementSequence, getCommands,
    receiveInventory, receiveEquipment, showActionError, inscribeRequest, onClose
  } = options;
  const [state, setState] = useState<JewelStationState | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const openTimeoutRef = useRef<number | null>(null);

  const clearOpenTimeout = useCallback((): void => {
    if (openTimeoutRef.current === null) return;
    window.clearTimeout(openTimeoutRef.current);
    openTimeoutRef.current = null;
  }, []);

  const begin = useCallback((requestId: string | null): boolean => {
    if (!requestId) return false;
    pendingRef.current = requestId;
    setPending(requestId);
    setFeedback(null);
    return true;
  }, []);

  const requestState = useCallback((replacePending: boolean): void => {
    if (!open || !online || !manorSessionId || (!replacePending && pendingRef.current)) return;
    if (replacePending) {
      clearOpenTimeout();
      pendingRef.current = null;
      setPending(null);
    }
    const requestId = getCommands()?.openJewelStation(
      manorSessionId,
      getMovementSequence()
    ) ?? null;
    if (!begin(requestId)) {
      const message = "Could not open the Jewel Station.";
      setFeedback(message);
      showActionError(message);
      return;
    }
    clearOpenTimeout();
    openTimeoutRef.current = window.setTimeout(() => {
      if (pendingRef.current !== requestId) return;
      pendingRef.current = null;
      setPending(null);
      const message = "The Jewel Station did not respond. Try again.";
      setFeedback(message);
      showActionError(message);
    }, JEWEL_STATION_OPEN_TIMEOUT_MS);
  }, [begin, clearOpenTimeout, getCommands, getMovementSequence, manorSessionId, online, open, showActionError]);

  const refresh = useCallback((): void => requestState(false), [requestState]);
  const retry = useCallback((): void => requestState(true), [requestState]);

  useEffect(() => {
    if (!open || !online) {
      clearOpenTimeout();
      setState(null);
      setFeedback(null);
      pendingRef.current = null;
      setPending(null);
      if (!open) return;
    }
    refresh();
  }, [clearOpenTimeout, online, open, refresh]);

  useEffect(() => clearOpenTimeout, [clearOpenTimeout]);

  const prepare = useCallback((instanceId: string, gemstone: EnchantmentStoneVariant): void => {
    if (!manorSessionId || pendingRef.current) return;
    if (!begin(getCommands()?.prepareJewelEquipment(
      manorSessionId,
      getMovementSequence(),
      instanceId,
      gemstone
    ) ?? null)) showActionError("Could not send the preparation request.");
  }, [begin, getCommands, getMovementSequence, manorSessionId, showActionError]);

  const imbue = useCallback((instanceId: string, metal: EquipmentMetal): void => {
    if (!manorSessionId || pendingRef.current) return;
    if (!begin(getCommands()?.imbueJewelEquipment(
      manorSessionId,
      getMovementSequence(),
      instanceId,
      metal
    ) ?? null)) showActionError("Could not send the infusion request.");
  }, [begin, getCommands, getMovementSequence, manorSessionId, showActionError]);

  const reforge = useCallback((
    instanceId: string,
    options: { gemstone?: EnchantmentStoneVariant; changeMetal: boolean }
  ): void => {
    if (!manorSessionId || pendingRef.current) return;
    if (!begin(getCommands()?.reforgeJewelEquipment(
      manorSessionId,
      getMovementSequence(),
      instanceId,
      options
    ) ?? null)) showActionError("Could not send the reforge request.");
  }, [begin, getCommands, getMovementSequence, manorSessionId, showActionError]);

  const inscribe = useCallback((instanceId: string, name: string): void => {
    if (pendingRef.current) return;
    pendingRef.current = "inscribe";
    setPending("inscribe");
    setFeedback(null);
    void inscribeRequest(instanceId, name).then((next) => {
      setState(next);
      receiveInventory(next.inventory);
      receiveEquipment(next.equipment);
      setFeedback("Inscribed.");
    }).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : "Could not inscribe that item.";
      setFeedback(message);
      showActionError(message);
    }).finally(() => {
      pendingRef.current = null;
      setPending(null);
    });
  }, [inscribeRequest, receiveEquipment, receiveInventory, showActionError]);

  const handleServerMessage = useCallback((message: ManorServerMessage): void => {
    if (message.type === "JEWEL_STATION_STATE") {
      if (message.requestId !== pendingRef.current) return;
      clearOpenTimeout();
      pendingRef.current = null;
      setPending(null);
      setState(message.state);
      receiveInventory(message.state.inventory);
      receiveEquipment(message.state.equipment);
      return;
    }
    if (message.type === "JEWEL_STATION_RESULT") {
      if (message.requestId !== pendingRef.current) return;
      clearOpenTimeout();
      pendingRef.current = null;
      setPending(null);
      setState(message.state);
      receiveInventory(message.state.inventory);
      receiveEquipment(message.state.equipment);
      setFeedback(message.action === "prepare"
        ? `Equipment prepared with a ${capitalize(message.gemstone ?? "")} stone.`
        : message.action === "reforge"
          ? [
              message.metalChanged && message.metal
                ? `${equipmentMetalDisplayName(message.metal)} metal removed. Bars returned.`
                : null,
              message.gemstoneChanged ? `Gem changed to ${capitalize(message.gemstone ?? "")}.` : null
            ].filter(Boolean).join(" ")
          : `${equipmentMetalDisplayName(message.metal ?? "venomsteel")} infusion completed.`);
      return;
    }
    if (message.type === "JEWEL_STATION_ERROR") {
      if (message.requestId && message.requestId !== pendingRef.current) return;
      clearOpenTimeout();
      pendingRef.current = null;
      setPending(null);
      setFeedback(message.message);
      showActionError(message.message);
    }
  }, [clearOpenTimeout, receiveEquipment, receiveInventory, showActionError]);

  return {
    state,
    feedback,
    busy: pending !== null,
    prepare,
    imbue,
    reforge,
    inscribe,
    refresh,
    retry,
    close: onClose,
    handleServerMessage
  } as const;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
