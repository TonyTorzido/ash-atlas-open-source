import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const clientSourceRoot = path.resolve(import.meta.dirname, "..");
const appSource = fs
  .readFileSync(path.join(clientSourceRoot, "App.tsx"), "utf8")
  .replaceAll("\r\n", "\n");
const overlaySource = fs.readFileSync(
  path.join(clientSourceRoot, "map", "pixiOverlay.ts"),
  "utf8"
).replaceAll("\r\n", "\n");
const travelHandlerSource = fs.readFileSync(
  path.join(clientSourceRoot, "features", "travel", "useTravelFrameHandler.ts"),
  "utf8"
).replaceAll("\r\n", "\n");
describe("retained-world flag travel architecture", () => {
  it("resolves structure damage in the shared desktop/phone overlay and retains destroyed world anchors", () => {
    const draw = overlaySource.slice(overlaySource.indexOf("  const drawDamageFloaters ="), overlaySource.indexOf("  const dynamicEntityCenter ="));
    expect(draw).toContain("retainedFlagMarkers.get(floater.targetEntityId)");
    expect(draw).toContain("damageFloaterLayer.toLocal(target.container.toGlobal(floaterOrigin, floaterGlobal), undefined, floaterLocal)");
    expect(draw).toContain("map.project([floater.worldPosition!.lon, floater.worldPosition!.lat])");
    expect(overlaySource).toContain("const key = `flag:${flag.id}`;");
  });

  it("keeps local-player presentation outside the transformed world layer", () => {
    expect(overlaySource).toContain("gameplayWorldLayer.addChild(");
    expect(overlaySource).toContain("staticLayer,");
    expect(overlaySource).toContain("worldDynamicEntityLayer,");
    expect(overlaySource).not.toContain("gatheringProgressLayer");
    expect(overlaySource).toContain("kingdomSeatLayer");
    const rootLayers = overlaySource.slice(
      overlaySource.indexOf("  root.addChild("),
      overlaySource.indexOf("  app.stage.addChild(root)")
    );
    expect(rootLayers).toContain("gameplayWorldLayer,");
    expect(rootLayers).toContain("localPlayerLayer,");
    expect(rootLayers).toContain("damageFloaterLayer");
    expect(overlaySource).toContain(
      "(local ? localPlayerLayer : worldDynamicEntityLayer).addChild("
    );
    expect(overlaySource).toContain(
      "worldDynamicEntityLayer.addChild(created.container)"
    );
    expect(overlaySource).not.toContain("flagTravelLocalPlayerAnchor");
    expect(overlaySource).not.toContain(
      "gameplayWorldLayer.toLocal("
    );
  });

  it("retains camera handling for authoritative flag arrivals", () => {
    const centerStart = appSource.indexOf("  const centerCamera = useCallback");
    const planStart = appSource.indexOf(
      "const travelPlan = planFlagTravelCamera({",
      centerStart
    );
    const plannedVisitFlagBranch = appSource.slice(
      planStart,
      appSource.indexOf("  const recenterCameraOnLocalPlayer", planStart)
    );
    expect(plannedVisitFlagBranch).toContain("FLAG_TRAVEL_CAMERA_FALLBACK_MS");
    expect(plannedVisitFlagBranch).toContain("map.easeTo");
    expect(plannedVisitFlagBranch).toContain("map.jumpTo");
    expect(plannedVisitFlagBranch).toContain("intentOnly");
    expect(plannedVisitFlagBranch).not.toContain("startFlagTravelPlayerMotion");
    expect(plannedVisitFlagBranch).not.toContain("setFlagTravelCoverVisible");
    expect(plannedVisitFlagBranch).not.toContain("setProgrammaticCameraMoveActive(true)");
    expect(plannedVisitFlagBranch).toContain("intentOnly\n        );");
  });

  it("waits for authoritative flag arrival before starting the manual visit camera", () => {
    const visitStart = appSource.indexOf("  const visitFlag = (");
    const visit = appSource.slice(
      visitStart,
      appSource.indexOf("  retryVisibleFlagVisitRef.current", visitStart)
    );
    expect(visit).toContain("beginWatchedTravelRequest(sentRequestId)");
    expect(visit).not.toContain("centerCamera(");
    expect(visit).not.toContain('"intent",');
    expect(visit).not.toContain("beginFlagTravelPresentation(");
    expect(visit).not.toContain("pendingFlagTravelRevealRef.current =");
    expect(visit).not.toContain("map.easeTo");
    expect(visit).not.toContain("map.jumpTo");
    expect(visit).not.toContain("map.stop");

    const centerStart = appSource.indexOf("  const centerCamera = useCallback");
    const center = appSource.slice(
      centerStart,
      appSource.indexOf("  const refreshCombatUi", centerStart)
    );
    expect(center).toContain('phase !== "intent"');
    expect(center).toContain('const intentOnly = phase === "intent"');
    expect(center).toContain("flagTravelCameraTransactionOwnerRef.current.begin({");
    expect(center).toContain("flagTravelCameraTransactionOwnerRef.current.adoptArrival(");
    expect(center).toContain("activeFlagTravelCameraGenerationRef.current =");

    const beginStart = appSource.indexOf(
      "  const beginFlagTravelPresentation = useCallback"
    );
    const begin = appSource.slice(
      beginStart,
      appSource.indexOf("  const cancelFlagTravelPresentation", beginStart)
    );
    expect(begin).not.toContain("flagTravelCameraTransactionOwnerRef");
    expect(begin).toContain("{ lat: player.lat, lon: player.lon }");
    expect(begin).toContain("{ lat: player.anchorLat, lon: player.anchorLon }");

    const flagVisitedBranch = travelHandlerSource.slice(
      travelHandlerSource.indexOf('case "FLAG_VISITED"'),
      travelHandlerSource.indexOf('case "FLAG_TOLL_RECEIVED"')
    );
    expect(flagVisitedBranch).toContain('"arrival", message.requestId');
    expect(appSource).not.toContain(
      "// A manual flag visit keeps the viewport fixed."
    );
    expect(flagVisitedBranch.indexOf("installCommittedWorldViewEpoch("))
      .toBeLessThan(flagVisitedBranch.indexOf("centerCamera("));
  });

  it("keeps one camera owner through arrival, recreation, replacement, and cancellation", () => {
    const centerStart = appSource.indexOf("  const centerCamera = useCallback");
    const center = appSource.slice(
      centerStart,
      appSource.indexOf("  const refreshCombatUi", centerStart)
    );
    expect(center).toContain("flagTravelCameraTransactionOwnerRef.current.adoptArrival(");
    expect(center).toContain("continueFlagTravelCameraRef.current(");
    expect(center).toContain("requestedDestination: position");
    const arrivalStart = center.indexOf('phase === "arrival"');
    const matchingArrival = center.slice(
      arrivalStart,
      center.indexOf('phase !== "intent"', arrivalStart)
    );
    expect(matchingArrival).toContain("adoptArrival(");
    expect(matchingArrival).not.toContain("map.easeTo");

    const overlayCreationStart = appSource.indexOf("overlayRef.current = created");
    const overlayCreation = appSource.slice(
      overlayCreationStart,
      appSource.indexOf("created.update(renderStateRef.current)", overlayCreationStart)
    );
    expect(overlayCreation).toContain("shouldReapplyFlagTravelCameraTransform(");

    const viewportStart = appSource.indexOf("    const beginViewportInteraction = (");
    const viewport = appSource.slice(
      viewportStart,
      appSource.indexOf("    beginViewportInteractionRef.current", viewportStart)
    );
    expect(viewport).toContain(
      'flagTravelCameraTransactionOwnerRef.current.cancel("cancelled")'
    );
    expect(appSource).not.toContain("flagTravelIntentCameraRef");
  });

  it("captures the origin without blocking authoritative Pixi frames", () => {
    const flagVisitedBranch = travelHandlerSource.slice(
      travelHandlerSource.indexOf('case "FLAG_VISITED"'),
      travelHandlerSource.indexOf('case "FLAG_TOLL_RECEIVED"')
    );
    expect(flagVisitedBranch.indexOf("beginFlagTravelPresentation("))
      .toBeLessThan(flagVisitedBranch.indexOf("installCommittedWorldViewEpoch("));
    expect(appSource).toContain(
      "{ lat: player.lat, lon: player.lon }"
    );
    const beginStart = overlaySource.indexOf(
      "    beginFlagTravelPresentation("
    );
    const begin = overlaySource.slice(
      beginStart,
      overlaySource.indexOf(
        "    startFlagTravelPlayerMotion(",
        beginStart
      )
    );
    expect(begin).toContain(
      "flagTravelOriginLocalPlayerScreen ="
    );
    expect(begin).toContain("flagTravelOriginStaticState =");
    expect(begin).not.toContain("updateFlagTravelPlayerMotion(null, now)");

    const motionStart = overlaySource.indexOf(
      "  function updateFlagTravelPlayerMotion("
    );
    const motion = overlaySource.slice(
      motionStart,
      overlaySource.indexOf("  function observeFlagTravelFrame(", motionStart)
    );
    expect(motion).toContain("if (\n      !flagTravelPlayerMotion ||");
    expect(motion).not.toContain("flagTravelDestinationPlayer");
    expect(motion).not.toContain("map.project(");

    const drawFrame = overlaySource.slice(
      overlaySource.indexOf("const drawFrame ="),
      overlaySource.indexOf("const dynamicAnimation =")
    );
    expect(drawFrame).toContain("if (flagTravelPresentationActive)");
    expect(drawFrame).not.toContain("return;");
    expect(drawFrame.indexOf("drawDirtyStaticLayers("))
      .toBeLessThan(drawFrame.indexOf("observeFlagTravelFrame()"));
    expect(drawFrame).toContain(
      "flagTravelPresentationActive || flagTravelVisibilityTransition"
    );
    expect(drawFrame).toContain("markFlagTravelLiveStaticLayersDirty();");
    expect(drawFrame).toContain('? "flag-travel-live"');
    expect(drawFrame.indexOf("drawTimedDynamicPresentation(now, deltaSeconds)"))
      .toBeLessThan(drawFrame.indexOf("observeFlagTravelFrame()"));
  });

  it("places player and circle from authority, then releases destination entities", () => {
    const visitStart = appSource.indexOf("  const visitFlag = (");
    const visit = appSource.slice(
      visitStart,
      appSource.indexOf("  retryVisibleFlagVisitRef.current", visitStart)
    );
    expect(visit).not.toContain("preparedArrivalPosition");
    expect(visit).not.toContain("beginFlagTravelPresentation(");
    expect(visit).not.toContain("scheduleFlagTravelPresentationDeadline(");

    const completeStart = appSource.indexOf(
      "  const completeFlagTravelReveal ="
    );
    const complete = appSource.slice(
      completeStart,
      appSource.indexOf(
        "  completeFlagTravelRevealRef.current =",
        completeStart
      )
    );
    expect(complete).not.toContain("setMobPresentationReady(true)");
    expect(complete).toContain("commitFlagTravelDestination()");

    const beginStart = overlaySource.indexOf(
      "    beginFlagTravelPresentation("
    );
    const begin = overlaySource.slice(
      beginStart,
      overlaySource.indexOf("    startFlagTravelPlayerMotion(", beginStart)
    );
    expect(begin).toContain("mobPresentationReady = false");
    expect(begin).toContain("flagTravelOriginCombatEntities =");
    expect(begin).not.toContain('rendered.kind !== "mob"');
    expect(begin).not.toContain("collectibles: []");
    expect(overlaySource).toContain("function displayStateForDynamicEntities()");
    expect(overlaySource).toContain("player.playerId === state.localPlayerId");

    const presentationState = overlaySource.slice(
      overlaySource.indexOf("function displayStateForStaticLayers()"),
      overlaySource.indexOf("function stateWithPendingSelection(")
    );
    expect(presentationState).toContain("flagTravelOriginStaticState");
    expect(presentationState).toContain("anchorLat: anchor.lat");
    expect(presentationState).toContain("anchorLon: anchor.lon");
    expect(presentationState).toContain("center: anchor");
  });

  it("draws the complete static and dynamic destination before one synchronized paint", () => {
    const commitStart = overlaySource.indexOf(
      "    commitFlagTravelDestination(): boolean {"
    );
    const commit = overlaySource.slice(
      commitStart,
      overlaySource.indexOf(
        "    cancelFlagTravelPresentation(capture:",
        commitStart
      )
    );
    expect(commit.indexOf("drawDirtyStaticLayers("))
      .toBeLessThan(commit.indexOf("drawDynamicEntities("));
    expect(commit.indexOf("drawDynamicEntities("))
      .toBeLessThan(commit.indexOf("renderOverlay()"));
    expect(commit.indexOf("resetFlagTravelDurableTransforms();"))
      .toBeLessThan(commit.indexOf("markAllStaticLayersDirty();"));
    expect(commit.indexOf("markAllStaticLayersDirty();"))
      .toBeLessThan(commit.indexOf("drawDirtyStaticLayers("));
    expect(commit.slice(
      commit.indexOf("resetFlagTravelDurableTransforms();"),
      commit.indexOf("drawDynamicEntities(")
    )).not.toContain("renderOverlay()");
    expect(commit).not.toContain("staticLayer.visible = false");
    expect(commit).not.toContain("kingdomSeatLayer.visible = false");

    const finishStart = appSource.indexOf(
      "  const finishProgrammaticCameraMove ="
    );
    const finish = appSource.slice(
      finishStart,
      appSource.indexOf(
        "  const scheduleProgrammaticCameraMoveEnd =",
        finishStart
      )
    );
    expect(finish).not.toContain("completeFlagTravelPlayerMotion(generation)");
    expect(finish).toContain("commitFlagTravelDestination()");
  });

  it("paints each flag-travel overlay frame synchronously with MapLibre", () => {
    const transformStart = overlaySource.indexOf(
      "    updateFlagTravelTransform(_cameraGeneration:"
    );
    const transform = overlaySource.slice(
      transformStart,
      overlaySource.indexOf(
        "    completeFlagTravelPlayerMotion(",
        transformStart
      )
    );

    expect(transform).toContain("paintSynchronizedOverlayFrame(");
    expect(transform).toContain("applyFlagTravelTransform();");
    expect(transform).toContain("markFlagTravelLiveStaticLayersDirty();");
    expect(transform).toContain(
      '"flag-travel-live"'
    );
    expect(transform).not.toContain("markAllStaticLayersDirty();");
    expect(transform).toContain(
      "drawTimedDynamicPresentation(now, deltaSeconds);"
    );
    expect(transform).toContain("observeFlagTravelFrame();");
    expect(transform).toContain("}, renderOverlay);");
    expect(transform).not.toContain("dynamicAnimation.restart()");
  });

  it("keeps flag-travel durable geometry transformed while redrawing only live layers", () => {
    const staticLayerSetup = overlaySource.slice(
      overlaySource.indexOf("  durableStaticUnderlay.addChild("),
      overlaySource.indexOf("  gameplayWorldLayer.addChild(")
    );
    expect(staticLayerSetup.indexOf("durableStaticUnderlay.addChild(territoryLayer)"))
      .toBeLessThan(staticLayerSetup.indexOf("flagTravelLiveStaticLayer.addChild("));
    expect(staticLayerSetup.indexOf("flagTravelLiveStaticLayer.addChild("))
      .toBeLessThan(staticLayerSetup.indexOf("durableStaticMarkers.addChild("));
    expect(staticLayerSetup).toContain(
      "staticLayer.addChild(\n    durableStaticUnderlay,\n    flagTravelLiveStaticLayer,\n    durableStaticMarkers"
    );

    const applyStart = overlaySource.indexOf("  function applyFlagTravelTransform()");
    const apply = overlaySource.slice(
      applyStart,
      overlaySource.indexOf("  function resetFlagTravelDurableTransforms()", applyStart)
    );
    expect(apply).toContain("computeLiveStaticOverlayReference(");
    expect(apply).toContain(
      "applyStaticOverlayContainerTransform(durableStaticUnderlay, reference);"
    );
    expect(apply).toContain(
      "applyStaticOverlayContainerTransform(durableStaticMarkers, reference);"
    );
    expect(apply).toContain(
      "applyStaticOverlayContainerTransform(kingdomSeatLayer, reference);"
    );
    expect(apply).not.toContain("gameplayWorldLayer");
    expect(apply).not.toContain("staticLayer, reference");
    expect(apply).not.toContain("flagTravelLiveStaticLayer, reference");
    expect(apply).not.toContain("collectibleSpriteLayer");
    expect(apply).not.toContain("droppedItemSpriteLayer");

    const mapTransformStart = overlaySource.indexOf(
      "  const markMapTransformDirty = (): void => {"
    );
    const mapTransform = overlaySource.slice(
      mapTransformStart,
      overlaySource.indexOf("  const getCachedTerritoryGroups", mapTransformStart)
    );
    const renderingGuardIndex = mapTransform.indexOf("if (!renderingActive)");
    const frozenGuardIndex = mapTransform.indexOf("if (staticLayersFrozen)");
    const travelGuardIndex = mapTransform.indexOf(
      "if (flagTravelPresentationActive || flagTravelVisibilityTransition)"
    );
    expect(renderingGuardIndex).toBeLessThan(frozenGuardIndex);
    expect(frozenGuardIndex).toBeLessThan(travelGuardIndex);
    const travelGuard = mapTransform.slice(
      travelGuardIndex,
      mapTransform.indexOf("markAllStaticLayersDirty();", travelGuardIndex)
    );
    expect(travelGuard).toContain("markFlagTravelLiveStaticLayersDirty();");
    expect(travelGuard).not.toContain("markAllStaticLayersDirty();");

    const transformStart = overlaySource.indexOf(
      "    updateFlagTravelTransform(_cameraGeneration:"
    );
    const transform = overlaySource.slice(
      transformStart,
      overlaySource.indexOf("    completeFlagTravelPlayerMotion(", transformStart)
    );
    const cleanupIndex = transform.indexOf("visibilityNow >=");
    const frozenTravelIndex = transform.indexOf("if (staticLayersFrozen)");
    const paintIndex = transform.indexOf("paintSynchronizedOverlayFrame(");
    expect(cleanupIndex).toBeLessThan(frozenTravelIndex);
    expect(frozenTravelIndex).toBeLessThan(paintIndex);
    const frozenTravel = transform.slice(frozenTravelIndex, paintIndex);
    expect(frozenTravel).toContain(
      "if (flagTravelVisibilityTransition?.timing) map.triggerRepaint();"
    );
    expect(frozenTravel).toContain("return;");
    expect(frozenTravel).not.toContain("markFlagTravelLiveStaticLayersDirty();");
    expect(frozenTravel).not.toContain("drawDirtyStaticLayers(");

    const drawStart = overlaySource.indexOf("  const drawDirtyStaticLayers = (");
    const draw = overlaySource.slice(
      drawStart,
      overlaySource.indexOf("  const drawDynamicEntities = (", drawStart)
    );
    expect(draw).toContain('scope: "full" | "flag-travel-live" = "full"');
    expect(draw).toContain('scope === "full" && needsTerritoryRedraw');
    expect(draw).toContain('scope === "full" && needsFlagRedraw');
    expect(draw).toContain('redrew && scope === "full"');
    expect(draw).toContain("lastDrawnVisibleStaticState = visibleState;");
    expect(draw).toContain("staticGeometryReference =");

    const cancelStart = overlaySource.indexOf(
      "    cancelFlagTravelPresentation(capture:"
    );
    const cancel = overlaySource.slice(
      cancelStart,
      overlaySource.indexOf("    flagTravelPresentationMetrics()", cancelStart)
    );
    expect(cancel.indexOf("resetFlagTravelDurableTransforms();"))
      .toBeLessThan(cancel.indexOf("markAllStaticLayersDirty();"));
    expect(cancel.indexOf("markAllStaticLayersDirty();"))
      .toBeLessThan(cancel.indexOf("drawDirtyStaticLayers("));
  });

  it("starts authoritative scoped visibility before paint and leaves durable layers opaque", () => {
    const centerStart = appSource.indexOf("  const centerCamera = useCallback");
    const planStart = appSource.indexOf(
      "const travelPlan = planFlagTravelCamera({",
      centerStart
    );
    const plannedVisitFlagBranch = appSource.slice(
      planStart,
      appSource.indexOf("  const recenterCameraOnLocalPlayer", planStart)
    );
    const transitionStart = plannedVisitFlagBranch.indexOf(
      "startFlagTravelVisibilityTransition("
    );
    expect(transitionStart).toBeGreaterThan(-1);
    expect(transitionStart).toBeLessThan(
      plannedVisitFlagBranch.indexOf("overlayRef.current?.update(")
    );
    expect(transitionStart).toBeLessThan(
      plannedVisitFlagBranch.indexOf("overlayRef.current?.paintCurrentFrame()")
    );
    expect(transitionStart).toBeLessThan(
      plannedVisitFlagBranch.indexOf("map.easeTo({")
    );

    expect(overlaySource).toContain(
      'visibilityDecision("player", destination.localPlayerId, true)'
    );
    expect(overlaySource).toContain('visibilityDecision("mob", entity.entityId)');
    expect(overlaySource).toContain(
      'const visibility = visibilityDecision("collectible", id);'
    );
    expect(overlaySource).toContain('(id) => visibilityDecision("drop", id)');
    expect(overlaySource).toContain('(id) => visibilityDecision("water", id).alpha');
    for (const durableKind of [
      "flag",
      "territory",
      "city",
      "cityStructure",
      "manor",
      "furnace",
      "tannery"
    ]) {
      expect(overlaySource).not.toContain(`visibilityDecision("${durableKind}"`);
    }
    expect(appSource).toContain("const FLAG_TRAVEL_PRESENTATION_MAX_MS = 2_000;");

    const reconcileStart = overlaySource.indexOf(
      "    reconcileLocalPlayer(): boolean {"
    );
    const reconcile = overlaySource.slice(
      reconcileStart,
      overlaySource.indexOf("    setPendingSelection(", reconcileStart)
    );
    expect(reconcile).toContain("if (!flagTravelVisibilityTransition)");
    expect(reconcile.indexOf("if (!flagTravelVisibilityTransition)"))
      .toBeLessThan(reconcile.indexOf("dynamicAnimation.restart()"));
  });

  it("supersedes a late visibility fade before capturing a new origin", () => {
    const beginStart = overlaySource.indexOf(
      "    beginFlagTravelPresentation("
    );
    const begin = overlaySource.slice(
      beginStart,
      overlaySource.indexOf(
        "    startFlagTravelVisibilityTransition(",
        beginStart
      )
    );
    const supersede = begin.indexOf("if (flagTravelVisibilityTransition)");
    const restore = begin.indexOf(
      "drawDirtyStaticLayers(stateWithPendingSelection(latestState));"
    );
    const capture = begin.indexOf("flagTravelOriginStaticState =");
    expect(supersede).toBeGreaterThan(-1);
    expect(supersede).toBeLessThan(restore);
    expect(restore).toBeLessThan(capture);
    expect(begin.slice(supersede, capture)).toContain(
      "flagTravelVisibilityTransition = null;"
    );
    expect(begin.slice(supersede, capture)).toContain(
      "drawDynamicEntities(stateWithPendingSelection(latestState), 0, now);"
    );
  });

  it("arms the origin visibility hold before the capture's first draw", () => {
    const beginStart = overlaySource.indexOf(
      "    beginFlagTravelPresentation("
    );
    const begin = overlaySource.slice(
      beginStart,
      overlaySource.indexOf(
        "    startFlagTravelVisibilityTransition(",
        beginStart
      )
    );
    const originCaptured = begin.indexOf("flagTravelOriginStaticState =");
    const holdArmed = begin.indexOf("flagTravelVisibilityTransition = {", originCaptured);
    const firstDraw = begin.indexOf(
      "drawDirtyStaticLayers(displayStateForStaticLayers());",
      holdArmed
    );
    expect(originCaptured).toBeGreaterThan(-1);
    expect(holdArmed).toBeGreaterThan(originCaptured);
    expect(begin.slice(holdArmed, firstDraw)).toContain("timing: null");
    expect(holdArmed).toBeLessThan(firstDraw);
  });

  it("does not start an independent local-player animation during camera travel", () => {
    const centerStart = appSource.indexOf("  const centerCamera = useCallback");
    const planStart = appSource.indexOf(
      "const travelPlan = planFlagTravelCamera({",
      centerStart
    );
    const plannedVisitFlagBranch = appSource.slice(
      planStart,
      appSource.indexOf("  const recenterCameraOnLocalPlayer", planStart)
    );
    expect(plannedVisitFlagBranch).not.toContain(
      "startFlagTravelPlayerMotion("
    );
    expect(plannedVisitFlagBranch).toContain(
      "map.easeTo({"
    );
    expect(plannedVisitFlagBranch.indexOf("reconcileLocalPlayer()"))
      .toBeLessThan(plannedVisitFlagBranch.indexOf("map.easeTo({"));
  });

  it("fades only genuinely new retained mob ids and composes interaction alpha", () => {
    const mobStart = overlaySource.indexOf("  const updateRetainedMob = (");
    const mob = overlaySource.slice(
      mobStart,
      overlaySource.indexOf("  const updateRetainedEntity = (", mobStart)
    );
    expect(mob).toContain('rendered?.kind === "mob"');
    expect(mob).toContain("? rendered.firstPresentedAtMs");
    expect(mob).toContain("visibility.alpha * mobSpawnAlpha(");
    expect(mob).toContain("combinedAlpha < MOB_SPAWN_INTERACTION_ALPHA");
  });

  it("gates destination entity commit on authoritative presentation readiness", () => {
    const completeStart = appSource.indexOf(
      "  const completeFlagTravelReveal ="
    );
    const complete = appSource.slice(
      completeStart,
      appSource.indexOf(
        "  completeFlagTravelRevealRef.current =",
        completeStart
      )
    );
    expect(complete).toContain("!pending.worldReady");
    expect(complete).toContain("!pending.cameraReady");
    expect(complete).toContain("!pending.mapPaintReady");
    expect(complete.indexOf("!pending.mapPaintReady"))
      .toBeLessThan(complete.indexOf("commitFlagTravelDestination()"));
    expect(appSource).toContain("authorityReady: true");
    expect(appSource).toContain("pendingReveal.cameraReady = true");
    expect(appSource).toContain("pendingReveal.mapPaintReady = true");
  });

  it("creates no second renderer and no flag-travel veil", () => {
    expect(appSource.match(/runtimeFactories\.createMapRuntime\(/g)).toHaveLength(1);
    expect(overlaySource.match(/new Application\(\)/g)).toHaveLength(1);
    expect(appSource).not.toContain("FlagTravelTransitionOverlay");
    expect(appSource).not.toContain("flag-travel-cover");
    expect(appSource).not.toContain("setFlagTravelCoverVisible");
    expect(appSource).toContain(
      "{!flagTravelPresentationActive ? ("
    );
  });
});
