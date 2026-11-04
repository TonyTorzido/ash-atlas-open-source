import type {
  PetAbilityId,
  PetSpeciesId,
  PetStateSnapshot,
  PetTrackPing,
  TreantKind,
  PlayerInventorySnapshot,
  PremiumWalletSnapshot,
  ServerMessage
} from "@ash-atlas/shared";
import { useCallback, useRef, useState } from "react";

import type { PetClient } from "../../client/domains/petClient.js";

export type PetBusyAction =
  | "refresh" | "call" | "dismiss" | "feed" | "heal" | "train" | "unlock" | "ability" | "hatch" | "hermit" | "treant" | "devGrant";

type PetServerMessage = Extract<ServerMessage, { type: "PET_STATE" | "PET_ERROR" }>;

const PET_FRAME_TYPES = new Set<ServerMessage["type"]>(["PET_STATE", "PET_ERROR"]);

export function isPetServerMessage(message: ServerMessage): message is PetServerMessage {
  return PET_FRAME_TYPES.has(message.type);
}

/** Everything the pets frame family carries: pet state plus the Giving Tree sapling frames. */
export function isPetFamilyServerMessage(message: ServerMessage): boolean {
  return PET_FRAME_TYPES.has(message.type) || message.type.startsWith("SAPLING");
}

export interface PetFeatureOptions {
  getCommands(): PetClient | null;
  receivePremiumWallet?(snapshot: PremiumWalletSnapshot): void;
  receiveInventory?(snapshot: PlayerInventorySnapshot): void;
  /** Tracking abilities mark a spot on the map. */
  onPing?(ping: PetTrackPing): void;
  /** Notices shown as a game toast: server pushes, ability results, and anything while the panel is closed. */
  onNotice?(notice: string): void;
  /** Find Open Land found a spot: start the standard travel there. */
  onOpenLand?(): void;
  /** Errors while the panel is closed (HUD strip or companion prompt) shown as the game's error notice. */
  onError?(message: string): void;
  /** Stay/Follow replies: the placed Stay spot (null after Follow or a plain Stay). */
  onStayAt?(spot: Readonly<{ lat: number; lon: number }> | null): void;
}

export function usePetFeature({ getCommands, receivePremiumWallet, receiveInventory, onPing, onNotice, onError, onOpenLand, onStayAt }: PetFeatureOptions) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;
  const [state, setState] = useState<PetStateSnapshot | null>(null);
  const [busy, setBusy] = useState<PetBusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);

  const beginRequest = useCallback((action: PetBusyAction, send: () => string | null): boolean => {
    if (pendingRef.current) return false;
    const requestId = send();
    if (!requestId) {
      setBusy(null);
      setError("Pets are disconnected. Reconnect and try again.");
      return false;
    }
    pendingRef.current = requestId;
    setBusy(action);
    setError(null);
    setNotice(null);
    return true;
  }, []);

  const openPanel = useCallback((): void => {
    setOpen(true);
    beginRequest("refresh", () => getCommands()?.requestPetState() ?? null);
  }, [beginRequest, getCommands]);

  const handleServerMessage = useCallback((message: PetServerMessage): void => {
    const correlated = Boolean(message.requestId) && message.requestId === pendingRef.current;
    // Stay/Follow from the HUD is sent outside the panel's request queue.
    if (message.type === "PET_STATE" && message.action === "command") onStayAt?.(message.stayAt ?? null);
    if (message.type === "PET_ERROR" && message.code.startsWith("PET_STAY_SPOT")) {
      onError?.(message.message);
      return;
    }
    if (message.requestId && pendingRef.current && !correlated) return;
    if (correlated) pendingRef.current = null;
    if (message.type === "PET_STATE") {
      setState(message.state);
      if (message.premiumWallet) receivePremiumWallet?.(message.premiumWallet);
      if (message.inventory) receiveInventory?.(message.inventory);
      if (message.ping) onPing?.(message.ping);
      if (message.openLand && correlated) onOpenLand?.();
      if (correlated) {
        setBusy(null);
        setError(null);
        setNotice(message.notice ?? null);
        if (message.notice && (message.action === "ability" || !openRef.current)) onNotice?.(message.notice);
      } else if (message.notice) {
        onNotice?.(message.notice);
      }
      return;
    }
    if (correlated || !message.requestId) {
      setBusy(null);
      setError(message.message);
      if (!openRef.current) onError?.(message.message);
    }
  }, [onError, onNotice, onOpenLand, onPing, onStayAt, receiveInventory, receivePremiumWallet]);

  const resetForWelcome = useCallback((): void => {
    setState(null);
    setBusy(null);
    setError(null);
    setNotice(null);
    pendingRef.current = null;
  }, []);

  const commands = getCommands;
  return {
    view: { open, state, busy, error, notice },
    actions: {
      setOpen,
      openPanel,
      refresh: () => beginRequest("refresh", () => commands()?.requestPetState() ?? null),
      call: (petId: string) => beginRequest("call", () => commands()?.callPet(petId) ?? null),
      dismiss: (petId: string) => beginRequest("dismiss", () => commands()?.dismissPet(petId) ?? null),
      feed: (petId: string) => beginRequest("feed", () => commands()?.feedPet(petId) ?? null),
      heal: (petId: string) => beginRequest("heal", () => commands()?.healPet(petId) ?? null),
      train: (petId: string) => beginRequest("train", () => commands()?.trainPet(petId) ?? null),
      unlock: (petId: string, abilityId: PetAbilityId) =>
        beginRequest("unlock", () => commands()?.unlockPetAbility(petId, abilityId) ?? null),
      useAbility: (petId: string, abilityId: PetAbilityId, targetEntityId?: string) =>
        beginRequest("ability", () => commands()?.usePetAbility(petId, abilityId, targetEntityId) ?? null),
      hatch: (itemId: string) => beginRequest("hatch", () => commands()?.hatchPetEgg(itemId) ?? null),
      buyFromHermit: (species: PetSpeciesId) => beginRequest("hermit", () => commands()?.buyHermitPet(species) ?? null),
      grantAllForDeveloper: () => beginRequest("devGrant", () => commands()?.grantOwnDevPets() ?? null),
      growTreant: (kind: TreantKind) => beginRequest("treant", () => commands()?.growTreant(kind) ?? null)
    },
    handleServerMessage,
    resetForWelcome
  } as const;
}

export type PetFeature = ReturnType<typeof usePetFeature>;
export type { PetServerMessage };
