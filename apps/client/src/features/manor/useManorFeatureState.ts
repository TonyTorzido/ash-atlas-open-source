import type {
  DroppedItemSnapshot,
  ManorDecorationSnapshot,
  ManorGuestManagementSnapshot,
  ManorOccupantPresenceSnapshot,
  ManorWorldSnapshot,
  PlayerSnapshot
} from "@ash-atlas/shared";
import { useEffect, useRef, useState } from "react";

import { ManorMovementTimeline } from "../../movement/manorMovementTimeline.js";
import {
  emptyPendingRequests,
  type LocationMode,
  type ManorClientSession,
  type ManorPendingRequests
} from "./manorFeatureContracts.js";
import type { ManorInteractionIntent } from "./manorInteraction.js";

export function useManorFeatureState() {
  const [manors, setManors] = useState<ManorWorldSnapshot[]>([]);
  const [ownManor, setOwnManor] = useState<ManorWorldSnapshot | null>(null);
  const [selectedManorId, setSelectedManorId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [buildPanelOpen, setBuildPanelOpen] = useState(false);
  const [session, setSession] = useState<ManorClientSession | null>(null);
  const [smithOpen, setSmithOpen] = useState(false);
  const [jewelOpen, setJewelOpen] = useState(false);
  const [breederOpen, setBreederOpen] = useState(false);
  const [interactionIntent, setInteractionIntent] = useState<ManorInteractionIntent>(null);
  const [guests, setGuests] = useState<ManorGuestManagementSnapshot | null>(null);
  const [occupants, setOccupants] = useState<ManorOccupantPresenceSnapshot[]>([]);
  const [guestPanelOpen, setGuestPanelOpen] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [decorations, setDecorations] = useState<ManorDecorationSnapshot | null>(null);
  const [manorEquipmentDrops, setManorEquipmentDrops] = useState<DroppedItemSnapshot[]>([]);
  const [locationMode, setLocationMode] = useState<LocationMode>("world");
  const movementTimelineRef = useRef(new ManorMovementTimeline());
  const pendingRef = useRef<ManorPendingRequests>(emptyPendingRequests());
  const sessionRef = useRef<ManorClientSession | null>(null);
  const locationModeRef = useRef<LocationMode>("world");
  const pendingWorldRestoreRef = useRef<PlayerSnapshot | null>(null);
  const displayColorRef = useRef<string | null>(null);
  const interactionIntentRef = useRef<ManorInteractionIntent>(null);
  const interactionTokenRef = useRef(0);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    locationModeRef.current = locationMode;
  }, [locationMode]);
  useEffect(() => {
    interactionIntentRef.current = interactionIntent;
  }, [interactionIntent]);

  return {
    manors,
    setManors,
    ownManor,
    setOwnManor,
    selectedManorId,
    setSelectedManorId,
    panelOpen,
    setPanelOpen,
    buildPanelOpen,
    setBuildPanelOpen,
    session,
    setSession,
    smithOpen,
    setSmithOpen,
    jewelOpen,
    setJewelOpen,
    breederOpen,
    setBreederOpen,
    interactionIntent,
    setInteractionIntent,
    guests,
    setGuests,
    occupants,
    setOccupants,
    guestPanelOpen,
    setGuestPanelOpen,
    feedback,
    setFeedback,
    decorations,
    setDecorations,
    manorEquipmentDrops,
    setManorEquipmentDrops,
    locationMode,
    setLocationMode,
    movementTimelineRef,
    pendingRef,
    sessionRef,
    locationModeRef,
    pendingWorldRestoreRef,
    displayColorRef,
    interactionIntentRef,
    interactionTokenRef
  };
}
