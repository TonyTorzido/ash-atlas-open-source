import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const harvestingFrames = readFileSync(
  new URL("./features/harvesting/useHarvestingFrameHandler.ts", import.meta.url),
  "utf8"
);
const flagSheet = readFileSync(
  new URL("./ui/MobileFlagActionSheet.tsx", import.meta.url),
  "utf8"
);
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("mobile inspection and active-action architecture", () => {
  it("keeps selection close separate from active harvest cancellation", () => {
    const closeSelection = sourceBlock(
      app,
      "const closeCollectibleSelection",
      "const requestHarvestCancellation"
    );
    const cancelActive = sourceBlock(
      app,
      "const requestHarvestCancellation",
      "const closeDroppedItemSelection"
    );

    expect(app).not.toContain("cancelHarvestSelection");
    expect(closeSelection).toContain("setSelectedCollectibleId(null)");
    expect(closeSelection).not.toMatch(/cancelHarvest|setHarvestTask|requestLocalMovement/);
    expect(cancelActive).toContain("cancelHarvest(cancellation.sessionId)");
    expect(cancelActive).toContain("setHarvestTask(null)");
  });

  it("selecting another collectible does not clear or cancel the active task", () => {
    const selection = sourceBlock(
      app,
      "if (pickedCollectible)",
      "if (pickedPlayer"
    );
    expect(selection).toContain("setSelectedCollectibleId(pickedCollectible.id)");
    expect(selection).not.toMatch(/requestHarvestCancellation|cancelHarvest|setHarvestTask\(null\)|requestLocalMovement/);
  });

  it("wires different-node harvesting availability through phone and desktop prompts", () => {
    expect(app).toContain("const presentedCollectibleIsActive = Boolean(");
    expect(app).toContain("actionBusy={presentedCollectibleIsActive");
    expect(app).toContain("otherHarvestBusy={harvestTask !== null || pendingHarvestCompletionRef.current !== null}");
    expect(app).toContain("busy: (harvestTask?.nodeId ?? pendingHarvestCompletionRef.current?.nodeId) ===");
    expect(app).toContain("queueHarvestReplacement(");
  });

  it("does not force server harvest or combat focus back into inspection selection", () => {
    expect(harvestingFrames).not.toContain(
      "setSelectedCollectibleId(message.session.nodeId)"
    );
    expect(app).not.toContain("setSelectedCombatEntityId(canonicalFocus)");
    expect(app).toContain(
      "resolveActiveHarvestCollectible(harvestTask, activeCollectibles)"
    );
  });

  it("closes quick sheets only after successful initiation", () => {
    expect(app).toContain('if (requestHarvest(nodeId, "primary")) closeCollectibleSelection()');
    const goblinInteraction = sourceBlock(
      app,
      ") : presentedCombatEntity && isGoblinInteractionTarget(presentedCombatEntity) ? (",
      ") : uiEnvironment.profile === \"phone\" ? ("
    );
    const ordinaryCombatInteraction = sourceBlock(
      app,
      ") : uiEnvironment.profile === \"phone\" ? (",
      '{uiEnvironment.profile === "phone" ? ('
    );
    const multiTargetQuickAction = sourceBlock(
      app,
      "const runMobileWorldTargetQuickAction",
      "const flagOptionAction"
    );
    expect(goblinInteraction).toContain("<GoblinInteractionPrompt");
    expect(goblinInteraction).not.toContain("requestAttack(");
    expect(ordinaryCombatInteraction).toContain("const accepted =");
    expect(ordinaryCombatInteraction).toContain(": requestAttack(targetId);");
    expect(ordinaryCombatInteraction.match(/if \(accepted\) closeCombatTarget\(\);/g))
      .toHaveLength(2);
    expect(multiTargetQuickAction).toContain(
      'accepted = confirmDroppedItemPickup({ mode: "all" }, target.value.dropId)'
    );
    expect(multiTargetQuickAction).toContain("if (accepted) setMobileWorldTargets([])");
    expect(flagSheet).toContain(
      "if (visitAction.enabled && props.onVisit(props.flag.id, visitAction.expectedTollGold)) props.onClose();"
    );
    expect(flagSheet).not.toContain("accessTraceId");
    expect(flagSheet).not.toMatch(/props\.onVisit[\s\S]{0,120}props\.onClose\(\);[\s\S]{0,40}else/);
  });

  it("keeps cancellation network-only and authoritative removal local-only", () => {
    const requestCancellation = sourceBlock(
      app,
      "const requestHarvestCancellation",
      "const settleHarvestAfterAuthoritativeRemoval"
    );
    const settleRemoval = sourceBlock(
      app,
      "const settleHarvestAfterAuthoritativeRemoval",
      "const closeDroppedItemSelection"
    );
    expect(requestCancellation).toContain("planHarvestCancellation");
    expect(requestCancellation).toContain("if (cancellation === null) return;");
    expect(requestCancellation).toContain(
      "cancelHarvest(cancellation.sessionId)"
    );
    expect(settleRemoval).not.toContain("cancelHarvest(");
    expect(settleRemoval).not.toContain("Gathering canceled.");
    expect(app).toContain('"Gathering canceled: out of range."');
    expect(app).toMatch(
      /localCombatEntity && localCombatEntity\.lifeState !== "alive"[\s\S]{0,100}requestHarvestCancellation\(false\)/
    );
    expect(app).toContain("onBeforeEnter: handleBeforeManorEnter");
    expect(app).toContain("requestHarvestCancellation(false)");
  });

  it("clears a queued harvest replacement for every accepted manual movement intent", () => {
    const movementIntent = sourceBlock(
      app,
      "const handleMovementIntent",
      "let pendingSelectionEvent"
    );
    expect(movementIntent).toContain("queuedHarvestReplacementRef.current = null;");
    expect(movementIntent.indexOf("queuedHarvestReplacementRef.current = null;"))
      .toBeLessThan(movementIntent.indexOf("if (harvestTaskRef.current?.phase === \"approaching\")"));
    expect(movementIntent.indexOf("queuedHarvestReplacementRef.current = null;"))
      .toBeLessThan(movementIntent.indexOf("requestLocalMovement(intent.target.lat, intent.target.lon)"));
  });

  it("clears canonical world selections before double-click movement dispatch", () => {
    const movementIntent = sourceBlock(
      app,
      "const handleMovementIntent",
      "let pendingSelectionEvent"
    );
    expect(movementIntent).toContain("clearWorldTargetSelection();");
    expect(movementIntent).toContain(
      "clearDroppedItemInteraction({ stopMovement: false });"
    );
    expect(movementIntent.indexOf("clearWorldTargetSelection();"))
      .toBeLessThan(movementIntent.indexOf("requestLocalMovement(intent.target.lat, intent.target.lon)"));
    expect(movementIntent.indexOf("clearDroppedItemInteraction({ stopMovement: false });"))
      .toBeLessThan(movementIntent.indexOf("requestLocalMovement(intent.target.lat, intent.target.lon)"));
  });

  it("keeps combat inspection passive until Attack is pressed", () => {
    const combatSelection = sourceBlock(
      app,
      "if (pickedCombatEntity",
      "if (pickedManor"
    );
    expect(combatSelection).toContain(
      "setSelectedCombatEntityId(pickedCombatEntity.entityId)"
    );
    expect(combatSelection).not.toMatch(/startAttack|cancel|targetEntityId\s*=/);
  });

  it("provides a semantic companion for active Pixi progress", () => {
    expect(app).toContain('role="progressbar"');
    expect(app).toContain("aria-valuemin={0}");
    expect(app).toContain("aria-valuemax={100}");
    expect(app).toContain("aria-valuenow={Math.round(gatheringProgress.progress * 100)}");
    expect(app).toContain('role="status" aria-live="polite"');
  });

  it("keeps the sheet above the safe-area dock with compact touch targets", () => {
    const sheetCss = sourceBlock(
      styles,
      'html[data-ui-profile="phone"] .mobile-world-action-sheet {',
      "/* Selection remains select-then-confirm"
    );
    expect(sheetCss).toContain("bottom: calc(var(--hud-bottom-bar-height) + 18px)");
    expect(sheetCss).toContain("min-height: 44px");
    expect(sheetCss).toContain("min-width: 0");
  });

  it("restores phone pinch zoom after leaving the manor", () => {
    expect(app).toContain("map?.touchZoomRotate.disable();");
    expect(app).toContain("map?.touchZoomRotate.enable();");
    expect(app).toContain("map?.touchZoomRotate.disableRotation();");
  });

  it("routes Kingdom management through the phone destination app", () => {
    const phoneDestinationSync = sourceBlock(
      app,
      'setInventoryOpen(mobileView === "equipment")',
      "const profileOpen"
    );
    const buildOptions = sourceBlock(
      app,
      "const phoneBuildOptions",
      "const closeUtilityPanels"
    );

    expect(phoneDestinationSync).toContain(
      'const kingdomAppOpen = mobileView === "kingdom";'
    );
    expect(phoneDestinationSync).toContain("setKingdomPanelOpen(kingdomAppOpen);");
    expect(buildOptions).toMatch(
      /id: "kingdom"[\s\S]*mobileMenuNavigation\.openDestination\("kingdom"\);/
    );
  });

  it("keeps map-selected Castles travel-only", () => {
    const kingdomPrompt = sourceBlock(
      app,
      "uiEnvironment.profile === \"phone\" && kingdomMapPromptOpen",
      "<MarketErrorBoundary"
    );

    expect(kingdomPrompt).toContain('primaryActionLabel="Travel to Castle"');
    expect(kingdomPrompt).not.toContain("View Kingdom");
    expect(kingdomPrompt).not.toContain("secondaryActionLabel");
  });

  it("presents canonical world-target names, one-line details, and action verbs", () => {
    const choices = sourceBlock(
      app,
      "function mobileWorldTargetChoice",
      "type MobileWorldQuickAction"
    );

    expect(choices).toContain("cityStructureDisplayName(target.value)");
    expect(choices).toContain("`Owned by ${target.value.ownerUsername}`");
    expect(choices).toContain("const name = collectibleDisplayName(target.value)");
    expect(choices).toContain("const resourceType = resourceDisplayName(target.value.type)");
    expect(choices).toContain("detail: resourceType === name ? null : resourceType");
    expect(choices).toContain("target.value.level > 0 ? `Lv ${target.value.level}` : null");
    expect(choices).toContain("flagInteractionDetail(target.value)");
    expect(app).toContain('label: "Travel"');
    expect(app).toContain('label: "Take All"');
    expect(app).toContain('secondaryActionLabel="Travel"');
    expect(app).toContain('primaryActionLabel={selectedManorOwner ? "Travel" : "Enter"}');
    expect(app).toContain('label: "Take Ring"');
  });

  it("keeps Market Open separate from Travel in the multi-target picker", () => {
    const choices = sourceBlock(
      app,
      "const mobileWorldTargetChoices",
      "useEffect(() => {"
    );
    const quickActions = sourceBlock(
      app,
      "const runMobileWorldTargetQuickAction",
      "const flagOptionAction"
    );

    expect(choices).toContain('target.kind === "city_structure" && target.value.type === "market"');
    expect(choices).toContain('label: "Open"');
    expect(choices).toContain("marketApproaching || opening");
    expect(quickActions).toContain('requestOpenCityMarket(target.value, "world")');
    expect(quickActions).toContain("if (accepted) setMobileWorldTargets([])");
    expect(quickActions).not.toContain("requestJumpToCityMarket");
  });

  it("restores the selected Market before opening after authoritative arrival", () => {
    const immediateOpen = sourceBlock(
      app,
      "const requestOpenCityMarket = useCallback",
      "const requestInspectOilWell"
    );
    const arrival = sourceBlock(
      app,
      "const intent = cityStructureInteractionIntent",
      "const pending = pendingMineClaim"
    );
    const restoreSelection = arrival.indexOf("openCityMarket(current)");
    const clearIntent = arrival.indexOf("updateCityStructureInteractionIntent(null)");
    const openOrdinaryMarket = arrival.indexOf("marketController.openVenue(");
    const openGoblinMarket = arrival.indexOf("openGoblinMarket(current.structureId)");

    expect(app).toContain("const [cityStructureInteractionIntent, setCityStructureInteractionIntent]");
    expect(app).toContain("cityStructureInteractionIntentRef.current = intent");
    expect(app).toContain("setCityStructureInteractionIntent(intent)");
    expect(arrival).toContain("advanceCityStructureInteraction({");
    expect(arrival).toContain("movement: localMovementRequestsRef.current.snapshot()");
    expect(arrival).toContain('if (transition === "waiting") return;');
    expect(arrival).toContain('if (transition === "unreachable")');
    expect(arrival).not.toContain("const intent = cityStructureInteractionIntentRef.current");
    expect(clearIntent).toBeGreaterThanOrEqual(0);
    expect(restoreSelection).toBeGreaterThan(clearIntent);
    expect(openOrdinaryMarket).toBeGreaterThan(restoreSelection);
    expect(openGoblinMarket).toBeGreaterThan(restoreSelection);
    expect(immediateOpen).toContain('if (!sent) {');
    expect(immediateOpen).toContain("The Goblin Market could not be opened.");
    expect(immediateOpen).toContain("The Market could not be opened.");
    expect(arrival).toContain('if (!marketController.openVenue(current.structureId, current.placementRevision))');
    expect(arrival).toContain("The Goblin Market could not be opened.");
    expect(arrival).toContain("The Market could not be opened.");
  });

  it("clears only the matching city-structure approach when movement is rejected", () => {
    const messageHandling = sourceBlock(
      app,
      "const handleMessage = useCallback",
      "serverMessageHandlerRef.current = handleMessage"
    );

    expect(messageHandling).toContain('message.code === "MOVE_REJECTED"');
    expect(messageHandling).toContain("cityStructureInteractionIntentRef.current?.movementRequestId === message.requestId");
    expect(messageHandling).toContain("updateCityStructureInteractionIntent(null)");

    const movement = sourceBlock(
      app,
      "const requestLocalMovement = useCallback",
      "const requestFurnaceMovement"
    );
    expect(movement).toContain("if (cityStructureInteractionIntentRef.current)");
    expect(movement.indexOf("updateCityStructureInteractionIntent(null)"))
      .toBeLessThan(movement.indexOf("clientRef.current?.moveTo("));
  });
});

function sourceBlock(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
