import type {
  DroppedItemSnapshot,
  ManorGuestManagementSnapshot,
  ManorDecorationSnapshot,
  ManorOccupantPresenceSnapshot,
  ManorServerMessage,
  ManorWorldSnapshot,
  PlayerSnapshot,
  TravelServerMessage
} from "@ash-atlas/shared";
import { useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import type { ManorClient } from "../../client/domains/manorClient.js";
import type { ManorMovementTimeline } from "../../movement/manorMovementTimeline.js";
import type {
  LocationMode,
  ManorClientSession,
  ManorPendingRequests
} from "./manorFeatureContracts.js";
import type { ManorInteractionIntent, ManorInteractionKind } from "./manorInteraction.js";

type Setter<T> = Dispatch<SetStateAction<T>>;

export interface ManorFeatureResultInput {
  manors: ManorWorldSnapshot[];
  ownManor: ManorWorldSnapshot | null;
  selectedManor: ManorWorldSnapshot | null;
  selectedManorId: string | null;
  panelOpen: boolean;
  buildPanelOpen: boolean;
  session: ManorClientSession | null;
  smithOpen: boolean;
  jewelOpen: boolean;
  breederOpen: boolean;
  interactionIntent: ManorInteractionIntent;
  guests: ManorGuestManagementSnapshot | null;
  occupants: ManorOccupantPresenceSnapshot[];
  guestPanelOpen: boolean;
  feedback: string | null;
  decorations: ManorDecorationSnapshot | null;
  manorEquipmentDrops: DroppedItemSnapshot[];
  locationMode: LocationMode;
  pending: ManorPendingRequests;
  movementTimelineRef: MutableRefObject<ManorMovementTimeline>;
  pendingWorldRestoreRef: MutableRefObject<PlayerSnapshot | null>;
  displayColorRef: MutableRefObject<string | null>;
  locationModeRef: MutableRefObject<LocationMode>;
  sessionRef: MutableRefObject<ManorClientSession | null>;
  setSelectedManorId: Setter<string | null>;
  setPanelOpen: Setter<boolean>;
  setBuildPanelOpen: Setter<boolean>;
  setSmithOpen: Setter<boolean>;
  setJewelOpen: Setter<boolean>;
  setGuestPanelOpen: Setter<boolean>;
  setFeedback: Setter<string | null>;
  requestBuild: () => void;
  requestDestroy: () => void;
  requestEquipSkin: (manorTypeId: string, copyId?: string) => boolean;
  requestJump: (manorId?: string, travelRequestId?: string) => string | null;
  requestEnter: (manorId?: string) => boolean;
  requestGuests: (manorId?: string) => void;
  requestExit: () => void;
  requestMove: (x: number, y: number) => string | null;
  requestOpenSmith: () => void;
  requestOpenJewel: () => void;
  requestOpenBreeder: () => void;
  requestManorDecorations: () => boolean;
  placeManorDecoration: (definitionId: string, x?: number, y?: number) => boolean;
  moveManorDecoration: (placementId: string, x: number, y: number) => boolean;
  removeManorDecoration: (placementId: string) => boolean;
  setManorEquipmentDrops: Setter<DroppedItemSnapshot[]>;
  requestInteraction: (kind: ManorInteractionKind) => boolean;
  cancelInteraction: () => void;
  cancelEntry: () => void;
  getCommands(): ManorClient | null;
  handleServerMessage: (message: ManorServerMessage) => void;
  handleTravelResult: (
    message: Extract<TravelServerMessage, { type: "TRAVEL_RESULT" }>
  ) => void;
  onDisconnected: () => void;
}

export function useManorFeatureResult(input: ManorFeatureResultInput) {
  const {
    manors,
    ownManor,
    selectedManor,
    selectedManorId,
    panelOpen,
    buildPanelOpen,
    session,
    smithOpen,
    jewelOpen,
    breederOpen,
    interactionIntent,
    guests,
    occupants,
    guestPanelOpen,
    feedback,
    decorations,
    manorEquipmentDrops,
    locationMode,
    pending,
    movementTimelineRef,
    pendingWorldRestoreRef,
    displayColorRef,
    locationModeRef,
    sessionRef,
    setSelectedManorId,
    setPanelOpen,
    setBuildPanelOpen,
    setSmithOpen,
    setJewelOpen,
    setGuestPanelOpen,
    setFeedback,
    requestBuild,
    requestDestroy,
    requestEquipSkin,
    requestJump,
    requestEnter,
    requestGuests,
    requestExit,
    requestMove,
    requestOpenSmith,
    requestOpenJewel,
    requestOpenBreeder,
    requestManorDecorations,
    placeManorDecoration,
    moveManorDecoration,
    removeManorDecoration,
    setManorEquipmentDrops,
    requestInteraction,
    cancelInteraction,
    cancelEntry,
    getCommands,
    handleServerMessage,
    handleTravelResult,
    onDisconnected
  } = input;

  return useMemo(() => ({
    view: {
      manors,
      ownManor,
      selectedManor,
      selectedManorId,
      panelOpen,
      buildPanelOpen,
      session,
      smithOpen,
      jewelOpen,
      breederOpen,
      interactionIntent,
      guests,
      occupants,
      guestPanelOpen,
      feedback,
      decorations,
      manorEquipmentDrops,
      locationMode,
      pending: { ...pending }
    },
    refs: {
      movementTimeline: movementTimelineRef,
      pendingWorldRestore: pendingWorldRestoreRef,
      displayColor: displayColorRef,
      locationMode: locationModeRef,
      session: sessionRef
    },
    actions: {
      setSelectedManorId,
      setPanelOpen,
      setBuildPanelOpen,
      setSmithOpen,
      setJewelOpen,
      setGuestPanelOpen,
      setFeedback,
      requestBuild,
      requestDestroy,
      requestEquipSkin,
      requestJump,
      requestEnter,
      requestGuests,
      requestExit,
      requestMove,
      requestOpenSmith,
      requestOpenJewel,
      requestOpenBreeder,
      requestManorDecorations,
      placeManorDecoration,
      moveManorDecoration,
      removeManorDecoration,
      setManorEquipmentDrops,
      requestInteraction,
      cancelInteraction,
      cancelEntry,
      kickGuest: (targetPlayerId: string) => (guests?.manorId ?? session?.manorId)
        ? Boolean(getCommands()?.kickManorGuest(
            guests?.manorId ?? session!.manorId,
            targetPlayerId
          ))
        : false,
      banGuest: (targetPlayerId: string) => guests
        ? Boolean(getCommands()?.banManorGuest(guests.manorId, targetPlayerId))
        : false,
      unbanGuest: (targetPlayerId: string) => guests
        ? Boolean(getCommands()?.unbanManorGuest(guests.manorId, targetPlayerId))
        : false
    },
    handleServerMessage,
    handleTravelResult,
    onDisconnected
  } as const), [
    buildPanelOpen,
    cancelInteraction,
    feedback,
    getCommands,
    guestPanelOpen,
    guests,
    occupants,
    handleServerMessage,
    handleTravelResult,
    locationMode,
    manors,
    onDisconnected,
    ownManor,
    panelOpen,
    requestBuild,
    requestDestroy,
    requestEquipSkin,
    requestEnter,
    requestExit,
    requestGuests,
    requestJump,
    requestMove,
    requestOpenSmith,
    requestOpenJewel,
    requestOpenBreeder,
    requestManorDecorations,
    placeManorDecoration,
    moveManorDecoration,
    removeManorDecoration,
    requestInteraction,
    selectedManor,
    selectedManorId,
    session,
    smithOpen,
    jewelOpen,
    breederOpen,
    decorations,
    manorEquipmentDrops,
    interactionIntent
  ]);
}
