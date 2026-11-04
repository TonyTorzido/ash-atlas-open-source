import type {
  PlayerSnapshot,
  TravelInboxEntry,
  TravelServerMessage
} from "@ash-atlas/shared";
import { useCallback, type Dispatch, type SetStateAction } from "react";

import type { HarvestTask } from "../../collectibles/harvest.js";
import {
  markFlagVisitCompleted,
  visitFlagSucceededUiState
} from "../../flags/visitFlagUi.js";
import {
  clearPostArrivalTravelBinding,
  setPostArrivalTravelBinding,
  type LocalMovementRequestTracker
} from "../../movement/localMovementRequests.js";
import {
  RECENTER_CAMERA_DURATION_MS,
  RECENTER_CAMERA_TIMEOUT_MS
} from "../../map/flagTravelCamera.js";
import type { FlagTravelPresentationCapture } from "../../map/pixiOverlay.js";
import { snapLifecyclePlayer } from "../../movement/playerMessageHandling.js";
import type { PlayerRenderTimeline } from "../../movement/playerRenderSmoothing.js";
import { progressionRecorder } from "../../perf/progressionRecorder.js";
import { upsertPlayerSnapshot } from "../../players/playerSnapshotCollection.js";
import type {
  WorldViewEpochInstallationResult
} from "../../worldView/committedWorldViewEpoch.js";

type RefCell<T> = { current: T };

const TRAVEL_FRAME_TYPES = new Set<string>([
  "TRAVEL_INBOX_SNAPSHOT",
  "VISIBLE_FLAG_VISIT_PREPARED",
  "TRAVEL_RESULT",
  "FLAG_VISITED",
  "FLAG_TOLL_RECEIVED",
  "CITY_VISITED"
]);

export function isTravelServerMessage(
  message: { type: string }
): message is TravelServerMessage {
  return TRAVEL_FRAME_TYPES.has(message.type);
}

export interface TravelFrameHandlerOptions {
  onVisibleFlagVisitPrepared?(
    message: Extract<TravelServerMessage, { type: "VISIBLE_FLAG_VISIT_PREPARED" }>
  ): void;
  observeWorldMapTravelFrame?(message: TravelServerMessage): void;
  observeManorTravelResult(
    message: Extract<TravelServerMessage, { type: "TRAVEL_RESULT" }>
  ): void;
  onTravelInviteSent?(
    message: Extract<TravelServerMessage, { type: "TRAVEL_RESULT" }>
  ): void;
  onRelocationResult?(
    message: Extract<TravelServerMessage, { type: "TRAVEL_RESULT" }>
  ): void;
  setTravelInbox: Dispatch<SetStateAction<TravelInboxEntry[]>>;
  setTravelInboxServerTime: Dispatch<SetStateAction<number>>;
  setTravelInboxServerOffsetMs: Dispatch<SetStateAction<number>>;
  setRelocationAvailableAt: Dispatch<SetStateAction<number | null>>;
  setRelocationExemptionAvailable?: Dispatch<SetStateAction<boolean>>;
  setTravelInviteAvailableAt: Dispatch<SetStateAction<number | null>>;
  pendingTravelRequestIdRef: RefCell<string | null>;
  postArrivalTravelRequestIdRef: RefCell<string | null>;
  postArrivalTravelRequestExpiresAtRef: RefCell<number>;
  completedTravelArrivalRequestIdsRef: RefCell<Set<string>>;
  localMovementRequests: LocalMovementRequestTracker;
  localPlayerRef: RefCell<PlayerSnapshot | null>;
  playerRenderTimeline: PlayerRenderTimeline;
  installCommittedWorldViewEpoch(
    player: PlayerSnapshot,
    resourceVisionRevision?: number
  ): WorldViewEpochInstallationResult;
  beginFlagTravelPresentation?(
    player: PlayerSnapshot,
    resourceVisionRevision: number | undefined,
    destinationFlagId: string | null,
    requestId: string
  ): FlagTravelPresentationCapture | null;
  cancelFlagTravelPresentation?(capture: FlagTravelPresentationCapture): void;
  cancelPendingFlagTravelCamera?(requestId: string): void;
  harvestTaskRef: RefCell<HarvestTask | null>;
  requestHarvestCancellation(stopMovement?: boolean): void;
  setPlayers: Dispatch<SetStateAction<PlayerSnapshot[]>>;
  setWalletGold(gold: string, revision?: string): void;
  setSelectedCityId: Dispatch<SetStateAction<string | null>>;
  setSelectedFlagId: Dispatch<SetStateAction<string | null>>;
  setFlagListOpen: Dispatch<SetStateAction<boolean>>;
  setWarning: Dispatch<SetStateAction<string | null>>;
  centerCamera(
    trigger: "visit-flag" | "visit-city",
    position: { lat: number; lon: number },
    durationMs: number,
    suppressMs: number,
    phase?: "intent" | "arrival",
    requestId?: string
  ): void;
  showActionError(message: string): void;
}

const ignoreRelocationExemption = (): void => undefined;

export function useTravelFrameHandler(options: TravelFrameHandlerOptions) {
  const {
    onVisibleFlagVisitPrepared = () => undefined,
    observeWorldMapTravelFrame,
    observeManorTravelResult,
    onTravelInviteSent = () => undefined,
    onRelocationResult = () => undefined,
    setTravelInbox,
    setTravelInboxServerTime,
    setTravelInboxServerOffsetMs,
    setRelocationAvailableAt,
    setRelocationExemptionAvailable = ignoreRelocationExemption,
    setTravelInviteAvailableAt,
    pendingTravelRequestIdRef,
    postArrivalTravelRequestIdRef,
    postArrivalTravelRequestExpiresAtRef,
    completedTravelArrivalRequestIdsRef,
    localMovementRequests,
    localPlayerRef,
    playerRenderTimeline,
    installCommittedWorldViewEpoch,
    beginFlagTravelPresentation = () => null,
    cancelFlagTravelPresentation = () => undefined,
    cancelPendingFlagTravelCamera = () => undefined,
    harvestTaskRef,
    requestHarvestCancellation,
    setPlayers,
    setWalletGold,
    setSelectedCityId,
    setSelectedFlagId,
    setFlagListOpen,
    setWarning,
    centerCamera,
    showActionError
  } = options;

  return useCallback((message: TravelServerMessage): void => {
    observeWorldMapTravelFrame?.(message);
    const cancelPreSessionHarvest = (): void => {
      const phase = harvestTaskRef.current?.phase;
      if (phase === "approaching" || phase === "starting") {
        requestHarvestCancellation(false);
      }
    };
    switch (message.type) {
      case "VISIBLE_FLAG_VISIT_PREPARED":
        onVisibleFlagVisitPrepared(message);
        return;
      case "TRAVEL_INBOX_SNAPSHOT":
        setTravelInbox(message.entries);
        setTravelInboxServerTime(message.serverTime);
        setTravelInboxServerOffsetMs(message.serverTime - Date.now());
        setRelocationAvailableAt(message.relocationAvailableAt ?? null);
        setRelocationExemptionAvailable(message.relocationExemptionAvailable === true);
        setTravelInviteAvailableAt(message.travelInviteAvailableAt ?? null);
        return;
      case "TRAVEL_RESULT":
        observeManorTravelResult(message);
        {
          if (message.kind === "gps_relocate") {
            onRelocationResult(message);
            if (message.relocationAvailableAt !== undefined) {
              setRelocationAvailableAt(message.relocationAvailableAt);
            }
            if (message.relocationExemptionAvailable !== undefined) {
              setRelocationExemptionAvailable(message.relocationExemptionAvailable);
            }
            if (message.travelInviteAvailableAt !== undefined) {
              setTravelInviteAvailableAt(message.travelInviteAvailableAt);
            }
          }
          if (message.success && message.kind === "invite_sent") {
            onTravelInviteSent(message);
          }
          const presentationCapture =
            message.success &&
            message.player &&
            message.requestId &&
            message.arrivalPresentation === "jump" &&
            !completedTravelArrivalRequestIdsRef.current.has(message.requestId)
              ? beginFlagTravelPresentation(
                  message.player,
                  message.resourceVisionRevision,
                  message.player.currentFlagId ?? null,
                  message.requestId
                )
              : null;
          const installationResult =
            message.success && message.player
              ? installCommittedWorldViewEpoch(
                  message.player,
                  message.resourceVisionRevision
                )
              : null;
          if (installationResult === "stale-epoch-ignored") {
            if (presentationCapture) {
              cancelFlagTravelPresentation(presentationCapture);
            }
            return;
          }
          if (installationResult === "new-epoch-installed") {
            cancelPreSessionHarvest();
            setSelectedFlagId(null);
            setSelectedCityId(null);
            setFlagListOpen(false);
          }
          const firstCompletion =
            message.success && message.player
              ? markFlagVisitCompleted(
                  message.requestId,
                  completedTravelArrivalRequestIdsRef.current
                )
              : false;
          if (
            !message.success &&
            message.requestId === pendingTravelRequestIdRef.current
          ) {
            localMovementRequests.discardBoundTo(message.requestId);
            cancelPendingFlagTravelCamera(message.requestId);
            pendingTravelRequestIdRef.current = null;
            if (postArrivalTravelRequestIdRef.current === message.requestId) {
              clearPostArrivalTravelBinding({
                requestId: postArrivalTravelRequestIdRef,
                expiresAt: postArrivalTravelRequestExpiresAtRef
              }, message.requestId);
            }
          }
          if (
            !message.success &&
            message.requestId === postArrivalTravelRequestIdRef.current
          ) {
            clearPostArrivalTravelBinding({
              requestId: postArrivalTravelRequestIdRef,
              expiresAt: postArrivalTravelRequestExpiresAtRef
            }, message.requestId);
          }
          if (
            message.success &&
            message.player &&
            (
              installationResult === "new-epoch-installed" ||
              firstCompletion
            )
          ) {
            localPlayerRef.current = message.player;
            const matchingTravelRequestId =
              message.requestId === pendingTravelRequestIdRef.current
                ? message.requestId
                : undefined;
            const preservedMove = snapLifecyclePlayer(
              playerRenderTimeline,
              message.player,
              performance.now(),
              "flag-visited",
              localMovementRequests,
              matchingTravelRequestId
            );
            if (matchingTravelRequestId) {
              setPostArrivalTravelBinding({
                requestId: postArrivalTravelRequestIdRef,
                expiresAt: postArrivalTravelRequestExpiresAtRef
              }, matchingTravelRequestId);
              pendingTravelRequestIdRef.current = null;
              completedTravelArrivalRequestIdsRef.current.add(
                matchingTravelRequestId
              );
              if (completedTravelArrivalRequestIdsRef.current.size > 100) {
                completedTravelArrivalRequestIdsRef.current.clear();
                completedTravelArrivalRequestIdsRef.current.add(
                  matchingTravelRequestId
                );
              }
            }
            if (preservedMove) {
              playerRenderTimeline.beginLocalAnticipation(
                preservedMove.requestId,
                preservedMove.generation,
                preservedMove.target,
                performance.now()
              );
            }
            setPlayers((current) =>
              upsertPlayerSnapshot(current, message.player!)
            );
            centerCamera("visit-flag", {
              lat: message.player.anchorLat,
              lon: message.player.anchorLon
            }, RECENTER_CAMERA_DURATION_MS, RECENTER_CAMERA_TIMEOUT_MS,
            "arrival", message.requestId);
          }
          if (!message.success) {
            setWarning(message.message);
            showActionError(message.message);
          } else if (message.warning) {
            setWarning(message.warning);
          }
          return;
        }
      case "FLAG_VISITED": {
        const presentationCapture =
          completedTravelArrivalRequestIdsRef.current.has(message.requestId)
            ? null
            : beginFlagTravelPresentation(
                message.player,
                message.resourceVisionRevision,
                message.flagId,
                message.requestId
              );
        const matchingTravelRequestId =
          message.requestId === pendingTravelRequestIdRef.current
            ? message.requestId
            : undefined;
        if (matchingTravelRequestId) {
          pendingTravelRequestIdRef.current = null;
        }
        const installationResult = installCommittedWorldViewEpoch(
          message.player,
          message.resourceVisionRevision
        );
        if (installationResult === "stale-epoch-ignored") {
          if (presentationCapture) {
            cancelFlagTravelPresentation(presentationCapture);
          }
          return;
        }
        if (installationResult === "new-epoch-installed") {
          cancelPreSessionHarvest();
        }
        const firstCompletion = markFlagVisitCompleted(
          message.requestId,
          completedTravelArrivalRequestIdsRef.current
        );
        if (message.walletGold !== undefined) {
          setWalletGold(message.walletGold);
        }
        localPlayerRef.current = message.player;
        if (
          installationResult === "new-epoch-installed" ||
          firstCompletion
        ) {
          const preservedMove = snapLifecyclePlayer(
            playerRenderTimeline,
            message.player,
            performance.now(),
            "flag-visited",
            localMovementRequests,
            matchingTravelRequestId
          );
          if (matchingTravelRequestId) {
            setPostArrivalTravelBinding({
              requestId: postArrivalTravelRequestIdRef,
              expiresAt: postArrivalTravelRequestExpiresAtRef
            }, matchingTravelRequestId);
          }
          if (preservedMove) {
            playerRenderTimeline.beginLocalAnticipation(
              preservedMove.requestId,
              preservedMove.generation,
              preservedMove.target,
              performance.now()
            );
          }
        }
        setPlayers((current) =>
          upsertPlayerSnapshot(current, message.player)
        );
        if (installationResult === "new-epoch-installed") {
          setSelectedCityId(null);
          setSelectedFlagId((current) =>
            visitFlagSucceededUiState({
              selectedFlagId: current,
              flagListOpen: false
            }).selectedFlagId
          );
        }
        setFlagListOpen((current) =>
          visitFlagSucceededUiState({
            selectedFlagId: null,
            flagListOpen: current
          }).flagListOpen
        );
        if (firstCompletion) {
          centerCamera("visit-flag", {
            lat: message.player.anchorLat,
            lon: message.player.anchorLon
          }, RECENTER_CAMERA_DURATION_MS, RECENTER_CAMERA_TIMEOUT_MS,
          "arrival", message.requestId);
          progressionRecorder.recordEvent({
            type: "flag_visited",
            sourceId: message.flagId
          });
        }
        setWarning(message.warning ?? null);
        return;
      }
      case "FLAG_TOLL_RECEIVED":
        setWalletGold(message.walletGold);
        return;
      case "CITY_VISITED": {
        const presentationCapture =
          message.arrivalPresentation === "jump" &&
          !completedTravelArrivalRequestIdsRef.current.has(message.requestId)
            ? beginFlagTravelPresentation(
                message.player,
                message.resourceVisionRevision,
                message.player.currentFlagId ?? null,
                message.requestId
              )
            : null;
        const matchingTravelRequestId =
          message.requestId === pendingTravelRequestIdRef.current
            ? message.requestId
            : undefined;
        if (matchingTravelRequestId) {
          pendingTravelRequestIdRef.current = null;
        }
        const installationResult = installCommittedWorldViewEpoch(
          message.player,
          message.resourceVisionRevision
        );
        if (installationResult === "stale-epoch-ignored") {
          if (presentationCapture) {
            cancelFlagTravelPresentation(presentationCapture);
          }
          return;
        }
        if (installationResult === "new-epoch-installed") {
          cancelPreSessionHarvest();
        }
        const firstCompletion = markFlagVisitCompleted(
          message.requestId,
          completedTravelArrivalRequestIdsRef.current
        );
        localPlayerRef.current = message.player;
        const preservedMove =
          installationResult === "new-epoch-installed" || firstCompletion
            ? snapLifecyclePlayer(
                playerRenderTimeline,
                message.player,
                performance.now(),
                "city-visited",
                localMovementRequests,
                matchingTravelRequestId
              )
            : null;
        if (matchingTravelRequestId) {
          setPostArrivalTravelBinding({
            requestId: postArrivalTravelRequestIdRef,
            expiresAt: postArrivalTravelRequestExpiresAtRef
          }, matchingTravelRequestId);
        }
        if (preservedMove) {
          playerRenderTimeline.beginLocalAnticipation(
            preservedMove.requestId,
            preservedMove.generation,
            preservedMove.target,
            performance.now()
          );
        }
        setPlayers((current) =>
          upsertPlayerSnapshot(current, message.player)
        );
        if (installationResult === "new-epoch-installed") {
          setSelectedFlagId(null);
        }
        if (firstCompletion) {
          if (message.arrivalPresentation === "jump") {
            centerCamera("visit-flag", {
              lat: message.player.anchorLat,
              lon: message.player.anchorLon
            }, RECENTER_CAMERA_DURATION_MS, RECENTER_CAMERA_TIMEOUT_MS,
            "arrival", message.requestId);
          } else {
            centerCamera("visit-city", message.player, 220, 600);
          }
        }
        setWarning(message.warning ?? null);
        return;
      }
    }
  }, [
    centerCamera,
    beginFlagTravelPresentation,
    cancelFlagTravelPresentation,
    completedTravelArrivalRequestIdsRef,
    harvestTaskRef,
    localMovementRequests,
    onTravelInviteSent,
    onRelocationResult,
    localPlayerRef,
    onVisibleFlagVisitPrepared,
    observeManorTravelResult,
    observeWorldMapTravelFrame,
    pendingTravelRequestIdRef,
    postArrivalTravelRequestIdRef,
    postArrivalTravelRequestExpiresAtRef,
    playerRenderTimeline,
    requestHarvestCancellation,
    installCommittedWorldViewEpoch,
    setWalletGold,
    setFlagListOpen,
    setPlayers,
    setSelectedCityId,
    setSelectedFlagId,
    setTravelInbox,
    setTravelInboxServerOffsetMs,
    setTravelInboxServerTime,
    setRelocationAvailableAt,
    setRelocationExemptionAvailable,
    setTravelInviteAvailableAt,
    setWarning,
    showActionError
  ]);
}
