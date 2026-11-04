import { isFiniteLatLon } from "@ash-atlas/shared";
import { useCallback } from "react";

import { perfMetrics } from "../../perf/perfMetrics.js";
import { emptyPopulationZoneProjection } from "../../population/populationZoneProjection.js";
import { useSessionErrorFrameHandler } from "./useSessionErrorFrameHandler.js";
import {
  classifyWorldAuthorityWelcome,
  markerForWorldAuthorityWelcome,
  welcomeRequiresWorldAuthorityReset
} from "./worldAuthorityWelcome.js";
import type {
  ApplicationSessionMessage,
  SessionFrameHandlerOptions,
  WelcomeMessage
} from "./sessionFrameHandlerContracts.js";

export { isApplicationSessionMessage } from "./sessionFrameHandlerContracts.js";
export type { SessionFrameHandlerOptions } from "./sessionFrameHandlerContracts.js";

export function useSessionFrameHandler(options: SessionFrameHandlerOptions) {
  const {
    ownPlayerId,
    hasCompletedBootstrapRef,
    worldAuthorityWelcomeMarkerRef,
    onWorldAuthorityReset,
    dispatchStartup,
    onMarketReady,
    combatStore,
    overlayRef,
    playerRenderTimeline,
    localMovementRequests,
    playerDeltaSequenceRef,
    relocationRevisionRef,
    resourceVisionRevisionRef,
    gameplayViewGenerationRef,
    connectionIdRef,
    connectionGenerationRef,
    populationZoneProjectionRef,
    lastWorldResyncRequestAtRef,
    pendingWorldResyncReasonRef,
    combatServerClockOffsetMsRef,
    selectedCombatEntityIdRef,
    setPopulationPreparing,
    setLocalCombatEntity,
    setAggressiveFallbackUntilMs,
    setSelectedCombatEntity,
    setSelectedCombatEntityId,
    resetPartyForWelcome,
    setTravelInbox,
    resetPetForWelcome,
    resetCombatFocusForWelcome,
    beginChatBootstrap,
    setFlagClaimRadiusM,
    setFlagBuildRecipe,
    setBuoyBuildRecipe,
    onDirectMessageWelcome,
    setWarning,
    resetSettlementForWelcome,
    setDeveloperCapabilities,
    beginProgrammaticCameraMove,
    centerSpawn,
    replayPendingHarvestCompletion,
    setRttMs
  } = options;

  const handleWelcome = useCallback((message: WelcomeMessage): void => {
    if (!isFiniteLatLon(message.spawn.lat, message.spawn.lon)) {
      dispatchStartup({
        type: "error",
        message: "The server returned invalid spawn coordinates."
      });
      return;
    }
    dispatchStartup({ type: "welcome" });
    onMarketReady();
    perfMetrics.markLoadMilestone("welcome received");
    const initialBootstrap = !hasCompletedBootstrapRef.current;
    const welcomeMarker = markerForWorldAuthorityWelcome(message);
    const authorityClassification = classifyWorldAuthorityWelcome(
      worldAuthorityWelcomeMarkerRef.current,
      welcomeMarker
    );
    worldAuthorityWelcomeMarkerRef.current = welcomeMarker;
    const resetWorldAuthority =
      initialBootstrap || welcomeRequiresWorldAuthorityReset(authorityClassification);
    if (resetWorldAuthority) {
      combatStore.clear();
      overlayRef.current?.clearCombatFeedback();
      playerRenderTimeline.clear();
      localMovementRequests.reset();
    }
    playerRenderTimeline.configureLocalPlayer(message.playerId, {
      speedMps: message.playerSpeedMps,
      serverTickHz: message.serverTickHz
    });
    if (resetWorldAuthority) playerDeltaSequenceRef.current = 0;
    relocationRevisionRef.current = message.relocationRevision ?? 0;
    resourceVisionRevisionRef.current = message.resourceVisionRevision ?? 0;
    if (resetWorldAuthority) {
      populationZoneProjectionRef.current = emptyPopulationZoneProjection();
      setPopulationPreparing(false);
    }
    if (!initialBootstrap && welcomeRequiresWorldAuthorityReset(authorityClassification)) {
      onWorldAuthorityReset?.(authorityClassification, message);
    }
    lastWorldResyncRequestAtRef.current = 0;
    pendingWorldResyncReasonRef.current = null;
    if (initialBootstrap) {
      combatServerClockOffsetMsRef.current = 0;
      setLocalCombatEntity(null);
      setAggressiveFallbackUntilMs(0);
      setSelectedCombatEntity(null);
      setSelectedCombatEntityId(null);
      selectedCombatEntityIdRef.current = null;
      resetPartyForWelcome();
      setTravelInbox([]);
      resetPetForWelcome();
      resetCombatFocusForWelcome();
      beginChatBootstrap();
      resetSettlementForWelcome();
      beginProgrammaticCameraMove("welcome", 120);
      centerSpawn(message);
    }
    setFlagClaimRadiusM(message.flagClaimRadiusM);
    setFlagBuildRecipe(message.flagBuildRecipe ?? []);
    setBuoyBuildRecipe(message.buoyBuildRecipe ?? []);
    onDirectMessageWelcome();
    setWarning(null);
    setDeveloperCapabilities(message.developerCapabilities);
  }, [
    beginChatBootstrap,
    beginProgrammaticCameraMove,
    centerSpawn,
    combatServerClockOffsetMsRef,
    combatStore,
    dispatchStartup,
    hasCompletedBootstrapRef,
    onWorldAuthorityReset,
    lastWorldResyncRequestAtRef,
    localMovementRequests,
    onDirectMessageWelcome,
    onMarketReady,
    overlayRef,
    pendingWorldResyncReasonRef,
    playerDeltaSequenceRef,
    playerRenderTimeline,
    populationZoneProjectionRef,
    relocationRevisionRef,
    resetPartyForWelcome,
    resetPetForWelcome,
    resetSettlementForWelcome,
    resourceVisionRevisionRef,
    selectedCombatEntityIdRef,
    resetCombatFocusForWelcome,
    setAggressiveFallbackUntilMs,
    setDeveloperCapabilities,
    setFlagBuildRecipe,
    setBuoyBuildRecipe,
    setFlagClaimRadiusM,
    setLocalCombatEntity,
    setPopulationPreparing,
    setSelectedCombatEntity,
    setSelectedCombatEntityId,
    setTravelInbox,
    setWarning,
    worldAuthorityWelcomeMarkerRef
  ]);

  const handleError = useSessionErrorFrameHandler(options);

  return useCallback((message: ApplicationSessionMessage): void => {
    switch (message.type) {
      case "WELCOME":
        handleWelcome(message);
        replayPendingHarvestCompletion(true);
        return;
      case "PRESENTATION_SNAPSHOT_COMPLETE":
        if (
          message.connectionId === connectionIdRef.current &&
          message.connectionGeneration === connectionGenerationRef.current &&
          message.gameplayViewGeneration === gameplayViewGenerationRef.current &&
          message.relocationRevision === relocationRevisionRef.current &&
          message.resourceVisionRevision === resourceVisionRevisionRef.current
        ) {
          dispatchStartup({
            type: "presentation_snapshot",
            authority: {
              playerId: ownPlayerId,
              connectionId: message.connectionId,
              connectionGeneration: message.connectionGeneration,
              gameplayViewGeneration: message.gameplayViewGeneration,
              relocationRevision: message.relocationRevision,
              resourceVisionRevision: message.resourceVisionRevision,
              populationPreparationGeneration:
                message.populationPreparationGeneration
            }
          });
        }
        return;
      case "ERROR":
        handleError(message);
        return;
      case "PONG":
        setRttMs(performance.now() - message.clientTime);
        return;
    }
  }, [
    handleError,
    handleWelcome,
    ownPlayerId,
    connectionGenerationRef,
    connectionIdRef,
    dispatchStartup,
    gameplayViewGenerationRef,
    relocationRevisionRef,
    replayPendingHarvestCompletion,
    resourceVisionRevisionRef,
    setRttMs
  ]);
}
