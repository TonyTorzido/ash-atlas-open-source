import {
  FISHING_HUT_INTERACTION_RADIUS_M,
  distanceMeters,
  type DroppedItemSnapshot,
  type FishingEncounterSnapshot,
  type FishingHutBuildSnapshot,
  type FishingHutWorldSnapshot,
  type LatLon,
  type FishingRecordSnapshot,
  type FishingStateSnapshot,
  type ManorServerMessage,
  type PlayerInventorySnapshot,
  type PlayerSnapshot
} from "@ash-atlas/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ManorClient } from "../../client/domains/manorClient.js";
import { createFlagBuildCountdown, type FlagBuildCountdown } from "../../flags/flagBuildCountdown.js";
import { getClosestInteractionApproachPoint } from "../../movement/interactionApproach.js";
import type { FishingCastPresentation } from "../../map/mapObjects.js";

type Pending = {
  build: string | null;
  open: string | null;
  collect: string | null;
  start: string | null;
  cast: string | null;
  hook: string | null;
  control: string | null;
  land: string | null;
  records: string | null;
  cancel: string | null;
  progress: string | null;
};
type FishingControlIntent = Readonly<{
  encounterId: string;
  direction: "left" | "right" | "neutral";
  reeling: boolean;
}>;
type FishingCastRequest = Readonly<{
  encounterId: string;
  point: LatLon;
  requestId: string;
}>;
type FishingCastIdentity = Readonly<{
  encounterId: string;
  point: LatLon;
}>;
type FishingEncounterMarker = Readonly<{
  encounterId: string;
  serverTime: number;
  castPoint: LatLon | null;
}>;
const emptyPending = (): Pending => ({ build: null, open: null, collect: null, start: null, cast: null, hook: null, control: null, land: null, records: null, cancel: null, progress: null });
type FishingEncounterOutcome = "missed" | "expired";

/** Shared desktop/mobile action state for the outdoor Fishing Hut and fight. */
export function useFishingFeature(options: Readonly<{
  connectionStatus: "offline" | "connecting" | "online";
  localPlayer: PlayerSnapshot | null;
  getCommands(): ManorClient | null;
  requestMove(lat: number, lon: number): boolean;
  receiveInventory(snapshot: PlayerInventorySnapshot): void;
  receiveDroppedItems(snapshot: DroppedItemSnapshot[]): void;
  showActionError(message: string): void;
  onBuildClearanceSuggestion?(position: { lat: number; lon: number }): void;
}>) {
  const { connectionStatus, localPlayer, getCommands, requestMove, receiveInventory, receiveDroppedItems, showActionError, onBuildClearanceSuggestion } = options;
  const [fishingHuts, setFishingHuts] = useState<FishingHutWorldSnapshot[]>([]);
  const [selectedFishingHutId, setSelectedFishingHutId] = useState<string | null>(null);
  const [state, setState] = useState<FishingStateSnapshot | null>(null);
  const [encounterOutcome, setEncounterOutcome] = useState<FishingEncounterOutcome | null>(null);
  const [records, setRecords] = useState<FishingRecordSnapshot | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [targeting, setTargeting] = useState(false);
  const [targetingInvalid, setTargetingInvalid] = useState(false);
  const [selectedWaterbody, setSelectedWaterbody] = useState<{ kind: "river" | "lake" | "ocean"; sourceId: string | null } | null>(null);
  const [castPresentation, setCastPresentation] = useState<FishingCastPresentation | null>(null);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [construction, setConstruction] = useState<Readonly<{ requestId: string; build: FishingHutBuildSnapshot; countdown: FlagBuildCountdown }> | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [approachingId, setApproachingId] = useState<string | null>(null);
  const pendingRef = useRef<Pending>(emptyPending());
  const queuedControlRef = useRef<FishingControlIntent | null>(null);
  const stateRef = useRef(state);
  const encounterOutcomeRef = useRef(encounterOutcome);
  const localPlayerRef = useRef(localPlayer);
  const connectionStatusRef = useRef(connectionStatus);
  const stateDestinationRef = useRef<"app" | "prompt">("prompt");
  const castRequestRef = useRef<FishingCastRequest | null>(null);
  const acceptedCastRef = useRef<FishingCastIdentity | null>(null);
  const encounterMarkerRef = useRef<FishingEncounterMarker | null>(null);
  const dismissedEncounterIdsRef = useRef<Set<string>>(new Set());
  stateRef.current = state;
  encounterOutcomeRef.current = encounterOutcome;
  localPlayerRef.current = localPlayer;
  connectionStatusRef.current = connectionStatus;
  const [pending, setPending] = useState<Pending>(pendingRef.current);
  const updatePending = useCallback((key: keyof Pending, value: string | null): void => {
    pendingRef.current = { ...pendingRef.current, [key]: value };
    setPending(pendingRef.current);
  }, []);
  const selected = useMemo(() => fishingHuts.find((hut) => hut.fishingHutId === selectedFishingHutId) ?? null, [fishingHuts, selectedFishingHutId]);

  const requestState = useCallback((fishingHutId: string | null, destination: "app" | "prompt" = "prompt"): boolean => {
    if (connectionStatusRef.current !== "online" || pendingRef.current.open) return false;
    const requestId = getCommands()?.openFishingHut(fishingHutId ?? undefined) ?? null;
    if (!requestId) return false;
    stateDestinationRef.current = destination;
    updatePending("open", requestId);
    setFeedback("Checking the Fishing Hut…");
    return true;
  }, [getCommands, updatePending]);

  const select = useCallback((hut: FishingHutWorldSnapshot): void => {
    // There is one actionable fishing state. A hut click while an encounter is
    // open focuses that encounter instead of replacing it with a second hut
    // prompt (including after a terminal/missed result is waiting to dismiss).
    const currentState = stateRef.current;
    if (currentState?.encounter || encounterOutcomeRef.current || pendingRef.current.open || pendingRef.current.start || pendingRef.current.cast || pendingRef.current.hook || pendingRef.current.control || pendingRef.current.land || pendingRef.current.cancel) {
      if (currentState?.encounter) {
        stateDestinationRef.current = "app";
        if (currentState.hut) setSelectedFishingHutId(currentState.hut.fishingHutId);
        setActionOpen(false);
        setOpen(true);
        setTargeting(currentState.encounter.phase === "cast" && currentState.encounter.castPoint === null);
        setTargetingInvalid(false);
        setCastPresentation(castPresentationForState(currentState, currentState.encounter.phase === "escaped"));
        setRecordsOpen(false);
        setApproachingId(null);
      }
      return;
    }
    setSelectedFishingHutId(hut.fishingHutId);
    clearFishingEncounterRefs(encounterMarkerRef, castRequestRef, acceptedCastRef);
    setState(null);
    setEncounterOutcome(null);
    setRecords(null);
    setActionOpen(true);
    setOpen(false);
    setTargeting(false);
    setTargetingInvalid(false);
    setSelectedWaterbody(null);
    setCastPresentation(null);
    setRecordsOpen(false);
    setApproachingId(null);
    setFeedback(null);
    const player = localPlayerRef.current;
    if (connectionStatusRef.current === "online" && player && distanceMeters(player, hut) <= FISHING_HUT_INTERACTION_RADIUS_M) requestState(hut.fishingHutId);
  }, [requestState]);

  const fish = useCallback((hut: FishingHutWorldSnapshot | null = selected): boolean => {
    if (!hut) return false;
    if (state?.encounter || encounterOutcome || pendingRef.current.cancel) {
      setActionOpen(false);
      setOpen(true);
      return true;
    }
    const player = localPlayerRef.current;
    if (connectionStatusRef.current !== "online") { showActionError("Cannot use a Fishing Hut while disconnected."); return false; }
    if (!player) { showActionError("Your current world position is unavailable."); return false; }
    const approach = getClosestInteractionApproachPoint(player, hut, FISHING_HUT_INTERACTION_RADIUS_M, 2);
    if (approach) {
      if (!requestMove(approach.lat, approach.lon)) { showActionError("Could not begin walking to the Fishing Hut."); return false; }
      setActionOpen(false);
      setApproachingId(hut.fishingHutId);
      return true;
    }
    if (pendingRef.current.open) { stateDestinationRef.current = "prompt"; setActionOpen(false); return true; }
    if (!requestState(hut.fishingHutId)) { showActionError("Could not open the Fishing Hut."); return false; }
    setActionOpen(false);
    return true;
  }, [encounterOutcome, requestMove, requestState, selected, showActionError, state?.encounter]);

  useEffect(() => {
    if (!approachingId || !localPlayer || localPlayer.moving) return;
    const hut = fishingHuts.find((candidate) => candidate.fishingHutId === approachingId);
    if (!hut || distanceMeters(localPlayer, hut) > FISHING_HUT_INTERACTION_RADIUS_M) return;
    setApproachingId(null);
    if (!requestState(hut.fishingHutId)) { setActionOpen(true); showActionError("Could not open the Fishing Hut."); }
  }, [approachingId, fishingHuts, localPlayer, requestState, showActionError]);

  const build = useCallback((): boolean => {
    if (connectionStatus !== "online") { showActionError("Cannot build a Fishing Hut while disconnected."); return false; }
    if (pendingRef.current.build || construction) { showActionError("A Fishing Hut build is already in progress."); return false; }
    const requestId = getCommands()?.buildFishingHut() ?? null;
    if (!requestId) { showActionError("Could not send the Fishing Hut build request."); return false; }
    updatePending("build", requestId);
    setFeedback(null);
    return true;
  }, [connectionStatus, construction, getCommands, showActionError, updatePending]);

  const collect = useCallback((): void => {
    if (state?.encounter || encounterOutcome) return;
    const id = state?.hut?.fishingHutId ?? selectedFishingHutId;
    if (!id || pendingRef.current.collect) return;
    if (connectionStatusRef.current !== "online") { showActionError("Cannot collect passive fish while disconnected."); return; }
    const requestId = getCommands()?.collectFishingHut(id) ?? null;
    if (!requestId) { showActionError("Could not send the passive fish collection request."); return; }
    updatePending("collect", requestId);
    setFeedback(null);
  }, [encounterOutcome, getCommands, selectedFishingHutId, showActionError, state?.encounter, state?.hut?.fishingHutId, updatePending]);

  const start = useCallback((): void => {
    // Retain the legacy hook for isolated consumers of the feature. The
    // player-facing app starts universal fishing through fishWithRod from the
    // Inventory action, so this compatibility path is not exposed by the hut
    // prompt.
    if (pendingRef.current.start || connectionStatusRef.current !== "online") {
      showActionError("Select a usable Fishing Rod from Inventory to start fishing.");
      return;
    }
    const requestId = getCommands()?.startFishing(selectedFishingHutId ?? "") ?? null;
    if (!requestId) {
      showActionError("Select a usable Fishing Rod from Inventory to start fishing.");
      return;
    }
    clearFishingEncounterRefs(encounterMarkerRef, castRequestRef, acceptedCastRef);
    updatePending("start", requestId);
    setActionOpen(false); setOpen(true); setTargeting(false); setFeedback("Preparing your cast…");
  }, [getCommands, selectedFishingHutId, showActionError, updatePending]);

  const fishWithRod = useCallback((fishingRodId: string): boolean => {
    if (!fishingRodId || state?.encounter || encounterOutcome || pendingRef.current.start || pendingRef.current.cancel) return false;
    if (connectionStatusRef.current !== "online") { showActionError("Cannot fish while disconnected."); return false; }
    const requestId = getCommands()?.startFishingWithRod(fishingRodId) ?? null;
    if (!requestId) { showActionError("Could not start fishing."); return false; }
    clearFishingEncounterRefs(encounterMarkerRef, castRequestRef, acceptedCastRef);
    updatePending("start", requestId);
    setSelectedWaterbody(null);
    setActionOpen(false); setOpen(true); setTargeting(false); setFeedback("Preparing your cast…");
    return true;
  }, [encounterOutcome, getCommands, showActionError, state?.encounter, updatePending]);

  const progressAction = useCallback((requestId: string | null, message: string): boolean => {
    if (!requestId) { showActionError("Could not send the Fishing Hut request."); return false; }
    updatePending("progress", requestId); setFeedback(message); return true;
  }, [showActionError, updatePending]);

  const craftRod = useCallback((fishingHutId?: string): boolean => {
    const id = fishingHutId ?? state?.hut?.fishingHutId ?? selectedFishingHutId;
    if (!id || connectionStatusRef.current !== "online") return false;
    return progressAction(getCommands()?.craftFishingRod(id) ?? null, "Crafting a Fishing Rod…");
  }, [getCommands, progressAction, selectedFishingHutId, state?.hut?.fishingHutId]);

  const upgradeTraining = useCallback((track: "cast_range" | "reel_power" | "line_control", fishingHutId?: string): boolean => {
    const id = fishingHutId ?? state?.hut?.fishingHutId ?? selectedFishingHutId;
    if (!id || connectionStatusRef.current !== "online") return false;
    return progressAction(getCommands()?.upgradeFishingTraining(id, track) ?? null, "Updating Fishing Training…");
  }, [getCommands, progressAction, selectedFishingHutId, state?.hut?.fishingHutId]);

  const specialize = useCallback((specializationType: "river" | "lake" | "ocean", fishingHutId?: string): boolean => {
    const id = fishingHutId ?? state?.hut?.fishingHutId ?? selectedFishingHutId;
    if (!id || connectionStatusRef.current !== "online") return false;
    return progressAction(getCommands()?.selectFishingSpecialization(id, specializationType) ?? null, "Updating Fishing Specialization…");
  }, [getCommands, progressAction, selectedFishingHutId, state?.hut?.fishingHutId]);

  const requestRecords = useCallback((): void => {
    const id = state?.hut?.fishingHutId ?? selectedFishingHutId ?? undefined;
    if (pendingRef.current.records) return;
    if (connectionStatusRef.current !== "online") { showActionError("Cannot view fishing records while disconnected."); return; }
    const requestId = getCommands()?.requestFishingRecords(id) ?? null;
    if (!requestId) { showActionError("Could not request fishing records."); return; }
    updatePending("records", requestId);
  }, [getCommands, selectedFishingHutId, showActionError, state?.hut?.fishingHutId, updatePending]);

  const selectWaterbody = useCallback((waterbody: { kind: "river" | "lake" | "ocean"; sourceId: string | null }): void => {
    setSelectedWaterbody(waterbody);
    setFeedback(`Selected ${waterbody.kind}. Choose a cast square on the map.`);
  }, []);

  const cast = useCallback((castPoint: LatLon, timing = 0.5, waterbody?: { kind: "river" | "lake" | "ocean"; sourceId: string | null }): void => {
    const id = state?.encounter?.encounterId;
    if (!id || !targeting || encounterOutcome || pendingRef.current.cast) return;
    setTargetingInvalid(false);
    setCastPresentation({ point: castPoint, status: "pending" });
    setFeedback("Checking that square of water…");
    const selected = waterbody ?? selectedWaterbody ?? (state?.encounter?.waterbody ? { kind: state.encounter.waterbody.kind, sourceId: state.encounter.waterbody.sourceId } : undefined);
    const hasExplicitChoice = waterbody !== undefined || (state?.encounter?.waterbodyCandidates?.length ?? 0) > 1;
    const requestId = hasExplicitChoice && selected
      ? getCommands()?.fishingCast(id, timing, castPoint, selected) ?? null
      : getCommands()?.fishingCast(id, timing, castPoint) ?? null;
    if (requestId) {
      castRequestRef.current = { encounterId: id, point: castPoint, requestId };
      updatePending("cast", requestId);
    }
    else {
      setCastPresentation(null);
      setTargetingInvalid(true);
    }
  }, [encounterOutcome, getCommands, selectedWaterbody, state?.encounter?.encounterId, state?.encounter?.waterbody, targeting, updatePending]);
  const hook = useCallback((): void => {
    const id = state?.encounter?.encounterId;
    if (!id || encounterOutcome || pendingRef.current.hook) return;
    const requestId = getCommands()?.fishingHook(id) ?? null;
    if (requestId) updatePending("hook", requestId);
  }, [encounterOutcome, getCommands, state?.encounter?.encounterId, updatePending]);
  const sendControlIntent = useCallback((intent: FishingControlIntent): void => {
    const requestId = getCommands()?.fishingControl(intent.encounterId, intent.direction, intent.reeling) ?? null;
    if (requestId) updatePending("control", requestId);
  }, [getCommands, updatePending]);
  const control = useCallback((direction: "left" | "right" | "neutral", reeling: boolean): void => {
    const id = state?.encounter?.encounterId;
    if (!id || encounterOutcome) return;
    const intent = { encounterId: id, direction, reeling } satisfies FishingControlIntent;
    if (pendingRef.current.control) {
      queuedControlRef.current = intent;
      return;
    }
    sendControlIntent(intent);
  }, [encounterOutcome, sendControlIntent, state?.encounter?.encounterId]);
  const land = useCallback((): void => {
    const id = state?.encounter?.encounterId;
    if (!id || encounterOutcome || pendingRef.current.land) return;
    const requestId = getCommands()?.fishingLand(id) ?? null;
    if (requestId) updatePending("land", requestId);
  }, [encounterOutcome, getCommands, state?.encounter?.encounterId, updatePending]);
  const cancel = useCallback((): void => {
    const id = state?.encounter?.encounterId;
    if (id) dismissedEncounterIdsRef.current.add(id);
    const requestId = id ? getCommands()?.fishingCancel(id) ?? null : null;
    queuedControlRef.current = null;
    for (const key of ["open", "start", "cast", "hook", "control", "land", "records"] as const) updatePending(key, null);
    if (requestId) updatePending("cancel", requestId);
    clearFishingEncounterRefs(encounterMarkerRef, castRequestRef, acceptedCastRef);
    setOpen(false); setActionOpen(false); setTargeting(false); setTargetingInvalid(false); setSelectedWaterbody(null); setCastPresentation(null); setRecordsOpen(false); setState(null); setEncounterOutcome(null); setRecords(null); setSelectedFishingHutId(null); setFeedback(null);
  }, [getCommands, state?.encounter?.encounterId, updatePending]);

  // Bite timing is authoritative on the server. Refresh at each server-owned
  // cue boundary so the same action model works on desktop and phone without
  // exposing a client-side timer as authority.
  useEffect(() => {
    const encounter = state?.encounter;
    const hutId = state?.hut?.fishingHutId;
    if (!encounter || encounterOutcome || !encounter.castPoint || pending.cast) return;
    const nextCueAt = encounter.phase === "cast"
      ? encounter.biteAt
      : encounter.phase === "bite"
        // A stale/reconnected bite snapshot has no active cue. Poll briefly
        // so the server can re-arm the same cast instead of leaving a dead HUD.
        ? encounter.biteEvent?.endsAt ?? encounter.serverTime + 250
        : null;
    if (nextCueAt === null) return;
    const delayMs = Math.max(100, nextCueAt - encounter.serverTime + 50);
    let retryTimer: number | null = null;
    const refresh = (): void => {
      if (requestState(hutId ?? null, "app")) {
        if (retryTimer !== null) window.clearInterval(retryTimer);
        retryTimer = null;
      } else if (retryTimer === null) {
        retryTimer = window.setInterval(() => {
          if (requestState(hutId ?? null, "app")) {
            if (retryTimer !== null) window.clearInterval(retryTimer);
            retryTimer = null;
          }
        }, 250);
      }
    };
    const timer = window.setTimeout(refresh, delayMs);
    return () => {
      window.clearTimeout(timer);
      if (retryTimer !== null) window.clearInterval(retryTimer);
    };
  }, [encounterOutcome, pending.cast, requestState, state?.encounter, state?.hut?.fishingHutId]);

  const handleServerMessage = useCallback((message: ManorServerMessage): void => {
    switch (message.type) {
      case "FISHING_HUTS_SNAPSHOT": setFishingHuts(message.fishingHuts); return;
      case "FISHING_HUT_BUILD_STARTED":
        if (pendingRef.current.build && message.requestId !== pendingRef.current.build) return;
        updatePending("build", null);
        setConstruction({ requestId: message.requestId, build: message.build, countdown: createFlagBuildCountdown({ startedAt: message.build.startedAt, completesAt: message.build.completesAt, durationMs: message.build.durationMs, serverTime: message.serverTime }, performance.now()) });
        receiveInventory(message.inventory);
        setFeedback(message.replayed ? "Fishing Hut construction resumed." : "Fishing Hut construction started.");
        return;
      case "FISHING_HUT_BUILD_RESULT":
        if (message.requestId !== pendingRef.current.build && message.requestId !== construction?.requestId) return;
        updatePending("build", null); setConstruction(null); setFishingHuts((current) => upsert(current, message.fishingHut)); receiveInventory(message.inventory); setFeedback(null); return;
      case "FISHING_HUT_BUILD_CANCELLED":
        if (message.requestId !== pendingRef.current.build && message.requestId !== construction?.requestId) return;
        updatePending("build", null); setConstruction(null); receiveInventory(message.inventory); receiveDroppedItems(message.droppedItems); setFeedback(message.message); showActionError(message.message); return;
      case "FISHING_STATE":
        if (message.requestId && message.requestId !== pendingRef.current.open) return;
        {
          if (shouldIgnoreFishingSnapshot(message.state, encounterMarkerRef.current, castRequestRef.current, acceptedCastRef.current, dismissedEncounterIdsRef.current)) {
            if (message.requestId === pendingRef.current.open) updatePending("open", null);
            return;
          }
          const previousState = stateRef.current;
          const rearmed = isRearmedWaitingState(previousState, message.state);
          rememberFishingEncounter(message.state, encounterMarkerRef);
          updatePending("open", null); setState(message.state); if (message.state.hut) setSelectedFishingHutId(message.state.hut.fishingHutId); setSelectedWaterbody(message.state.encounter?.waterbody ? { kind: message.state.encounter.waterbody.kind, sourceId: message.state.encounter.waterbody.sourceId } : null);
          setEncounterOutcome(outcomeForState(message.state));
          setActionOpen(message.state.encounter === null && stateDestinationRef.current === "prompt");
          setOpen(stateDestinationRef.current === "app" || message.state.encounter !== null);
          setTargeting(message.state.encounter?.phase === "cast" && message.state.encounter.castPoint === null); setTargetingInvalid(false); setCastPresentation(castPresentationForState(message.state, message.state.encounter?.phase === "escaped"));
          setFeedback(message.state.encounter?.phase === "escaped" && message.state.encounter ? fishingEscapeFeedback(message.state.encounter) : rearmed ? "The strike passed. The float is set again; watch for another bite." : null);
        }
        return;
      case "FISHING_PASSIVE_COLLECTED":
        if (message.requestId !== pendingRef.current.collect) return;
        updatePending("collect", null); setState(message.state); receiveInventory(message.inventory); setFeedback(message.collectedQuantity > 0 ? `Collected ${message.collectedQuantity} Freshwater Fish.` : "Your inventory is full; fish remain in the hut."); return;
      case "FISHING_ENCOUNTER_STARTED":
        if (message.requestId !== pendingRef.current.start) return;
        dismissedEncounterIdsRef.current.delete(message.state.encounter?.encounterId ?? "");
        clearFishingEncounterRefs(encounterMarkerRef, castRequestRef, acceptedCastRef);
        rememberFishingEncounter(message.state, encounterMarkerRef);
        updatePending("start", null); setState(message.state); setSelectedWaterbody(message.state.encounter?.waterbody ? { kind: message.state.encounter.waterbody.kind, sourceId: message.state.encounter.waterbody.sourceId } : null); setEncounterOutcome(null); setActionOpen(false); setOpen(true);
        setTargeting(message.state.encounter?.phase === "cast" && message.state.encounter.castPoint === null);
        setTargetingInvalid(false);
        setCastPresentation(castPresentationForState(message.state));
        setFeedback(message.state.encounter?.castPoint ? "The float is on the water. Watch for the strike." : "Choose a square of authoritative water on the map."); return;
      case "FISHING_ENCOUNTER_STATE":
        {
          if (shouldIgnoreFishingSnapshot(message.state, encounterMarkerRef.current, castRequestRef.current, acceptedCastRef.current, dismissedEncounterIdsRef.current)) return;
          const previousState = stateRef.current;
          const rearmed = isRearmedWaitingState(previousState, message.state);
          rememberFishingEncounter(message.state, encounterMarkerRef);
          setState(message.state); if (message.state.hut) setSelectedFishingHutId(message.state.hut.fishingHutId); setSelectedWaterbody(message.state.encounter?.waterbody ? { kind: message.state.encounter.waterbody.kind, sourceId: message.state.encounter.waterbody.sourceId } : null); setEncounterOutcome(outcomeForState(message.state)); setActionOpen(false); setOpen(true);
          setTargeting(message.state.encounter?.phase === "cast" && message.state.encounter.castPoint === null);
          setTargetingInvalid(false);
          setCastPresentation(castPresentationForState(message.state, message.state.encounter?.phase === "escaped"));
          setFeedback(message.state.encounter?.phase === "escaped" && message.state.encounter ? fishingEscapeFeedback(message.state.encounter) : rearmed ? "The strike passed. The float is set again; watch for another bite." : null);
        }
        return;
      case "FISHING_CAST_RESULT":
        {
          const castRequest = castRequestRef.current;
          const pendingCastId = pendingRef.current.cast;
          const castEncounterId = castRequest?.encounterId ?? stateRef.current?.encounter?.encounterId;
          if (
            (castRequest?.requestId ?? pendingCastId) !== message.requestId ||
            castEncounterId !== message.state.encounter?.encounterId
          ) return;
          // Keep the request identity authoritative, but use the server's
          // accepted point if the local request metadata was lost during a
          // reconnect. This lets a valid accepted result settle targeting
          // without allowing an unrelated replay through.
          const acceptedPoint = castRequest?.point ?? message.state.encounter?.castPoint;
          if (!acceptedPoint || !message.state.encounter?.castPoint) return;
          acceptedCastRef.current = { encounterId: message.state.encounter.encounterId, point: acceptedPoint };
          castRequestRef.current = null;
          rememberFishingEncounter(message.state, encounterMarkerRef);
          updatePending("cast", null);
          setState(message.state); setEncounterOutcome(null); setActionOpen(false); setOpen(true); setTargeting(false);
          setTargetingInvalid(false);
          setCastPresentation(castPresentationForState(message.state, message.state.encounter?.phase === "escaped", acceptedPoint));
          setFeedback("The float is on the water. Watch for the strike."); return;
        }
      case "FISHING_HOOK_RESULT": {
        if (shouldIgnoreFishingSnapshot(message.state, encounterMarkerRef.current, castRequestRef.current, acceptedCastRef.current, dismissedEncounterIdsRef.current)) return;
        const previousState = stateRef.current;
        const rearmed = isRearmedWaitingState(previousState, message.state);
        if (message.requestId === pendingRef.current.hook) updatePending("hook", null);
        rememberFishingEncounter(message.state, encounterMarkerRef);
        setState(message.state); setEncounterOutcome(outcomeForState(message.state)); setCastPresentation(castPresentationForState(message.state, message.state.encounter?.phase === "escaped"));
        setFeedback(message.state.encounter?.phase === "escaped" && message.state.encounter ? fishingEscapeFeedback(message.state.encounter) : rearmed ? "The strike passed. The float is set again; watch for another bite." : null);
        return;
      }
      case "FISHING_CONTROL_RESULT":
        if (message.requestId === pendingRef.current.cancel) { updatePending("cancel", null); return; }
        if (message.requestId !== pendingRef.current.control) return;
        if (shouldIgnoreFishingSnapshot(message.state, encounterMarkerRef.current, castRequestRef.current, acceptedCastRef.current, dismissedEncounterIdsRef.current)) return;
        rememberFishingEncounter(message.state, encounterMarkerRef);
        updatePending("control", null); setState(message.state); setEncounterOutcome(null); setFeedback(message.state.encounter?.phase === "escaped" ? fishingEscapeFeedback(message.state.encounter) : null); if (isTerminalFishingEncounter(message.state.encounter)) { setTargeting(false); setTargetingInvalid(false); setCastPresentation(castPresentationForState(message.state, message.state.encounter?.phase === "escaped")); }
        {
          const queued = queuedControlRef.current;
          queuedControlRef.current = null;
          if (queued && message.state.encounter?.encounterId === queued.encounterId && !isTerminalFishingEncounter(message.state.encounter)) {
            sendControlIntent(queued);
          }
        }
        return;
      case "FISHING_CATCH_LANDED":
        if (message.requestId !== pendingRef.current.land) return;
        clearFishingEncounterRefs(encounterMarkerRef, castRequestRef, acceptedCastRef);
        updatePending("land", null); setState(message.state); setEncounterOutcome(null); setTargeting(false); setCastPresentation(null); if (message.inventory) receiveInventory(message.inventory); setFeedback(message.catch ? `Landed a ${message.catch.weightLb.toFixed(2)} lb ${message.catch.fishSpecies === "ocean_fish" ? "Ocean Fish" : message.catch.ashen ? "Ashen Fish" : "Freshwater Fish"}.` : "The line went slack."); return;
      case "FISHING_PROGRESS_RESULT":
        if (message.requestId !== pendingRef.current.progress) return;
        updatePending("progress", null); setState(message.state); receiveInventory(message.inventory); setFeedback(message.replayed ? "Fishing Hut training request replayed." : "Fishing Hut training updated."); return;
      case "FISHING_RECORDS":
        if (message.requestId !== pendingRef.current.records) return;
        updatePending("records", null); setRecords(message.records); return;
      case "FISHING_ERROR": {
        const matches = !message.requestId || Object.values(pendingRef.current).includes(message.requestId);
        if (!matches) return;
        const castFailed = message.requestId !== null && message.requestId === pendingRef.current.cast;
        const hookMissed = message.requestId !== null && message.requestId === pendingRef.current.hook;
        const waitingHookMiss = hookMissed && message.code === "FISHING_HOOK_MISSED"
          && /strike passed|has not struck/i.test(message.message);
        const expired = message.code === "FISHING_ENCOUNTER_EXPIRED";
        const currentState = stateRef.current;
        for (const key of Object.keys(pendingRef.current) as Array<keyof Pending>) if (pendingRef.current[key] === message.requestId) updatePending(key, null);
        if (message.code === "FISHING_ENCOUNTER_EXPIRED" || message.code === "FISHING_NOT_FIGHTING") queuedControlRef.current = null;
        if (castFailed && currentState?.encounter?.phase === "cast") {
          castRequestRef.current = null;
          setTargeting(true);
          setTargetingInvalid(true);
          setCastPresentation(null);
        } else if (waitingHookMiss && currentState?.encounter?.castPoint) {
          setEncounterOutcome(null);
          setOpen(true);
          setActionOpen(false);
          setTargeting(false);
          setTargetingInvalid(false);
          setCastPresentation(castPresentationForState(currentState));
          setRecordsOpen(false);
          setFeedback("The strike passed. Checking the next bite…");
          requestState(currentState.hut?.fishingHutId ?? null, "app");
          return;
        } else if (expired && currentState?.encounter) {
          setEncounterOutcome("expired");
          setOpen(true);
          setActionOpen(false);
          setTargeting(false);
          setTargetingInvalid(false);
          setCastPresentation(castPresentationForState(currentState, true, acceptedCastRef.current?.point ?? castRequestRef.current?.point ?? null));
          setRecordsOpen(false);
          setFeedback(message.message);
        }
        setFeedback(message.message);
        if ((message.code === "OUTDOOR_STATION_CLEARANCE_REQUIRED" || message.code === "FISHING_CLEARANCE_REQUIRED") && message.suggestedPosition) onBuildClearanceSuggestion?.(message.suggestedPosition); else showActionError(message.message);
        return;
      }
      default: return;
    }
  }, [construction?.requestId, onBuildClearanceSuggestion, receiveDroppedItems, receiveInventory, requestState, sendControlIntent, showActionError, updatePending]);

  const close = useCallback((): void => {
    const id = stateRef.current?.encounter?.encounterId;
    if (id) dismissedEncounterIdsRef.current.add(id);
    queuedControlRef.current = null;
    clearFishingEncounterRefs(encounterMarkerRef, castRequestRef, acceptedCastRef);
    setOpen(false); setActionOpen(false); setTargeting(false); setTargetingInvalid(false); setSelectedWaterbody(null); setCastPresentation(null); setRecordsOpen(false); setState(null); setEncounterOutcome(null); setRecords(null); setSelectedFishingHutId(null); setApproachingId(null); setFeedback(null); updatePending("open", null); updatePending("records", null);
  }, [updatePending]);
  return {
    view: { fishingHuts, selected, selectedFishingHutId, state, records, actionOpen, open, targeting, targetingInvalid, selectedWaterbody, castPresentation, recordsOpen, encounterOutcome, construction, feedback, approaching: approachingId !== null, pending },
    actions: { select, fish, build, collect, start, fishWithRod, craftRod, upgradeTraining, specialize, selectWaterbody, cast, hook, control, land, cancel, cancelTargeting: cancel, close, refresh: requestState, requestRecords, setSelectedFishingHutId, handleServerMessage }
  };
}

function isTerminalFishingEncounter(encounter: FishingEncounterSnapshot | null): boolean {
  return encounter === null || encounter.phase === "landed" || encounter.phase === "escaped"
    || encounter.phase === "expired" || encounter.phase === "cancelled";
}

function castPresentationForState(state: FishingStateSnapshot, preserveEscaped = false, fallbackPoint: LatLon | null = null): FishingCastPresentation | null {
  const encounter = state.encounter;
  const point = encounter?.castPoint ?? fallbackPoint;
  return (isTerminalFishingEncounter(encounter) && !(preserveEscaped && encounter?.phase === "escaped")) || !point
    ? null
    : { point, status: "bound", cue: encounter?.biteEvent?.kind ?? null };
}

function sameCastPoint(left: LatLon | null | undefined, right: LatLon | null | undefined): boolean {
  return left !== null && left !== undefined && right !== null && right !== undefined
    && left.lat === right.lat && left.lon === right.lon;
}

function shouldIgnoreFishingSnapshot(
  state: FishingStateSnapshot,
  marker: FishingEncounterMarker | null,
  castRequest: FishingCastRequest | null,
  acceptedCast: FishingCastIdentity | null,
  dismissedEncounterIds: ReadonlySet<string>
): boolean {
  const encounter = state.encounter;
  if (encounter && dismissedEncounterIds.has(encounter.encounterId)) return true;
  if (acceptedCast && (!encounter || encounter.encounterId === acceptedCast.encounterId) && !sameCastPoint(encounter?.castPoint, acceptedCast.point)) return true;
  if (castRequest && (!encounter || encounter.encounterId === castRequest.encounterId) && !sameCastPoint(encounter?.castPoint, castRequest.point)) return true;
  if (marker && (!encounter || (encounter.encounterId === marker.encounterId && encounter.serverTime < marker.serverTime))) return true;
  return false;
}

function rememberFishingEncounter(state: FishingStateSnapshot, markerRef: { current: FishingEncounterMarker | null }): void {
  const encounter = state.encounter;
  markerRef.current = encounter
    ? { encounterId: encounter.encounterId, serverTime: encounter.serverTime, castPoint: encounter.castPoint }
    : null;
}

function clearFishingEncounterRefs(
  markerRef: { current: FishingEncounterMarker | null },
  castRequestRef: { current: FishingCastRequest | null },
  acceptedCastRef: { current: FishingCastIdentity | null }
): void {
  markerRef.current = null;
  castRequestRef.current = null;
  acceptedCastRef.current = null;
}

function fishingEscapeFeedback(encounter: FishingEncounterSnapshot): string {
  const reason = encounter.criticalMs >= 2_000
    ? "Line tension stayed too high."
    : encounter.slackMs >= 3_000
      ? "The line went slack too long."
      : "The line lost tension.";
  return `Fish escaped — ${reason}`;
}

function outcomeForState(state: FishingStateSnapshot): FishingEncounterOutcome | null {
  // Waiting and bite phases are both live states. The server re-arms an
  // ended bite on the same encounter, so neither phase is a client outcome.
  void state;
  return null;
}

function isRearmedWaitingState(previous: FishingStateSnapshot | null, next: FishingStateSnapshot): boolean {
  const previousEncounter = previous?.encounter;
  const encounter = next.encounter;
  return previousEncounter?.phase === "bite"
    && encounter?.phase === "cast"
    && encounter.castPoint !== null
    && previousEncounter.encounterId === encounter.encounterId;
}

function upsert(current: FishingHutWorldSnapshot[], hut: FishingHutWorldSnapshot): FishingHutWorldSnapshot[] {
  return [...current.filter((candidate) => candidate.fishingHutId !== hut.fishingHutId), hut];
}
