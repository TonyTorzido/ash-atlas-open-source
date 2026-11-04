import { useEffect, useMemo, useRef, useState } from "react";
import { useWorldTargetExitGhost } from "./worldTargetExitGhost.js";
import type {
  CityMembershipSnapshot,
  FlagAccessSnapshot,
  FlagReinforcementTarget,
  FlagSnapshot,
  KingdomFlagEligibility,
  KingdomFlagRemovalPreview,
  KingdomStateSnapshot,
  PlayerSnapshot,
  MilitaryUnitGroupSnapshot
} from "@ash-atlas/shared";
import {
  distanceMeters,
  militaryGroupDisplayName
} from "@ash-atlas/shared";

import {
  flagInteractionHeading,
  flagOwnerIndicatorColor,
  hasPersonalAccessPresentation,
  isFlagAttackablePresentationTarget,
  isFlagDemolishablePresentationTarget,
  isFlagBurnablePresentationTarget,
  structureWarfareStructureLabel,
  kingdomStructureBuildKingdomId,
  kingdomStructureOffers,
  towerStatusLabel,
  towerUpgradeOffer
} from "../flags/flagDisplay.js";
import { flagVisitLockLabel } from "../combat/aggressive.js";
import { damagedHealthLabel } from "../combat/healthBarPresentation.js";
import { PlayerFlagDetails } from "./PlayerFlagDetails.js";
import { KingdomApiClient } from "../kingdom/kingdomClient.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { FlagAccessControls } from "./FlagAccessControls.js";
import { AtlasShrineControls } from "./AtlasShrineControls.js";
import type { AtlasShrineMutationResult } from "../flags/atlasShrines.js";
import { useFlagHardeningAction } from "../flags/useFlagHardeningAction.js";
import { useFlagRepairAction } from "../flags/useFlagRepairAction.js";
import { GameConfirmationPrompt, type GamePromptPresentationState } from "./GameActionPrompt.js";
import { FlagMorePrompt } from "./FlagMorePrompt.js";
import { GameTargetPicker, type GameTargetChoice } from "./GameTargetPicker.js";

type FlagPanelProps = {
  flag: FlagSnapshot | null;
  player: PlayerSnapshot | null;
  serverHttpBase?: string;
  csrfToken?: string;
  kingdomState?: KingdomStateSnapshot | null;
  onKingdomSnapshot?: (snapshot: KingdomStateSnapshot) => void;
  onKingdomRefresh?: () => void;
  cityMembership?: CityMembershipSnapshot | null;
  /** Developer world-mutate sessions; the server enforces the exemption itself. */
  cityExpansionLimitExempt?: boolean;
  cityBusy?: boolean;
  onPreviewCityFounding?(flagId: string): void;
  onConvertCityFlag?(flagId: string): void;
  onOpenCity?(cityId: string): void;
  walletGold?: string | null;
  access?: FlagAccessSnapshot | null;
  accessTraceId?: string | null;
  travelPending?: boolean;
  onAccessChange?(access: FlagAccessSnapshot): void;
  onAccessSaved?(access: FlagAccessSnapshot): void;
  onVisitFlag(flagId: string, expectedTollGold?: string, requestId?: string): boolean;
  /** Pathfinder Boot: present only while one is worn and this building can be marked. */
  onMark?(flagId: string): void;
  onRenameFlag?(flagId: string, name: string): Promise<void> | void;
  onDeleteFlag(): void;
  onAtlasShrineMutation?(result: AtlasShrineMutationResult): void;
  onFlagSnapshot?(flag: FlagSnapshot): void;
  hardeningFlagId?: string | null;
  activeUpgradeTargetTier?: FlagReinforcementTarget | null;
  upgradeApproachReachable?: boolean;
  onHarden?(flagId: string): boolean;
  onUpgrade?(flagId: string, targetTier: FlagReinforcementTarget, targetTowerLevel?: number): boolean;
  onBurn?(flagId: string): boolean;
  onAttack?(flagId: string): boolean;
  onRepair?(flagId: string): boolean;
  repairing?: boolean;
  repairOperationId?: string | null;
  repairPausedBurnRemainingMs?: number | null;
  onCancelRepair?(flagId: string, operationId: string): boolean;
  repairActive?: boolean;
  disruptEligible?: boolean;
  disrupting?: boolean;
  disruptOperationId?: string | null;
  onDisrupt?(flagId: string, repairOperationId: string): boolean;
  onCancelDisrupt?(flagId: string, operationId: string): boolean;
  bomberGroups?: readonly MilitaryUnitGroupSnapshot[];
  onExplode?(groupId: string, flagId: string): boolean | void;
  deleting: boolean;
  aggressiveRemainingMs?: number;
  connected?: boolean;
  presentationState?: GamePromptPresentationState | undefined;
  actionsReady?: boolean;
  onClose(): void;
};

export function FlagPanel({
  flag,
  player,
  serverHttpBase = window.location.origin,
  csrfToken = "",
  kingdomState = null,
  onKingdomSnapshot,
  onKingdomRefresh,
  cityMembership = null,
  cityExpansionLimitExempt = false,
  cityBusy = false,
  onPreviewCityFounding,
  onConvertCityFlag,
  onOpenCity,
  onVisitFlag,
  onMark,
  onRenameFlag,
  onDeleteFlag,
  onAtlasShrineMutation,
  onFlagSnapshot,
  hardeningFlagId = null,
  activeUpgradeTargetTier = null,
  upgradeApproachReachable = true,
  onHarden = () => false,
  onUpgrade = () => false,
  onBurn,
  onAttack,
  onRepair,
  repairing = false,
  repairOperationId = null,
  repairPausedBurnRemainingMs = null,
  onCancelRepair,
  repairActive = false,
  disruptEligible = false,
  disrupting = false,
  disruptOperationId = null,
  onDisrupt,
  onCancelDisrupt,
  bomberGroups = [],
  onExplode,
  deleting,
  walletGold = null,
  access = null,
  accessTraceId = null,
  travelPending = false,
  onAccessChange,
  onAccessSaved,
  aggressiveRemainingMs = 0,
  connected = true,
  presentationState,
  actionsReady = true,
  onClose
}: FlagPanelProps): React.JSX.Element | null {
  const [playerDetailsOpen, setPlayerDetailsOpen] = useState(false);
  const [eligibility, setEligibility] = useState<KingdomFlagEligibility | null>(null);
  const [removalPreview, setRemovalPreview] = useState<KingdomFlagRemovalPreview | null>(null);
  const [kingdomBusy, setKingdomBusy] = useState(false);
  const [kingdomError, setKingdomError] = useState<string | null>(null);
  const [fetchedKingdomState, setFetchedKingdomState] = useState<KingdomStateSnapshot | null>(null);
  const kingdomStateRequestFlagId = useRef<string | null>(null);
  const flagPanelRef = useRef<HTMLElement>(null);
  useWorldTargetExitGhost(flagPanelRef);
  const [confirmation, setConfirmation] = useState<"remove" | "burn" | "repair" | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [bomberPickerOpen, setBomberPickerOpen] = useState(false);
  const kingdomApi = useMemo(
    () => new KingdomApiClient(serverHttpBase, csrfToken),
    [csrfToken, serverHttpBase]
  );
  const effectiveKingdomState = kingdomState?.membership
    ? kingdomState
    : fetchedKingdomState ?? kingdomState;
  const warfareAllies = {
    cityId: cityMembership?.cityId ?? null,
    kingdomId: effectiveKingdomState?.membership && effectiveKingdomState.kingdom?.status === "active"
      ? effectiveKingdomState.kingdom.id
      : null
  };
  const hardeningAction = useFlagHardeningAction({
    flag,
    playerId: player?.playerId,
    connected,
    hardening: hardeningFlagId === flag?.id,
    anotherHardeningActive: hardeningFlagId !== null && hardeningFlagId !== flag?.id,
    approachReachable: upgradeApproachReachable,
    onHarden
  });
  const repairAction = useFlagRepairAction({
    flag,
    playerId: player?.playerId,
    connected,
    serverHttpBase,
    csrfToken,
    ...(onFlagSnapshot ? { onFlagSnapshot } : {}),
    ...(onRepair ? { onRepair } : {}),
    repairing,
    allies: warfareAllies,
    ...(onCancelRepair && repairOperationId ? {
      onCancel: () => onCancelRepair(flag?.id ?? "", repairOperationId)
    } : {})
  });
  useEffect(() => {
    setPlayerDetailsOpen(false);
    setMoreOpen(false);
    setBomberPickerOpen(false);
    setRenameOpen(false);
    setRenameValue(flag?.name ?? "");
    setFetchedKingdomState(null);
    kingdomStateRequestFlagId.current = null;
  }, [flag?.id]);

  useEffect(() => {
    if (!moreOpen || !flag || flag.controlType !== "personal" || flag.ownerId !== player?.playerId ||
        (flag.upgradeTier === "atlas_shrine" || flag.upgradeTier === "tower") ||
        effectiveKingdomState?.membership ||
        kingdomStateRequestFlagId.current === flag.id) return;
    let active = true;
    kingdomStateRequestFlagId.current = flag.id;
    void kingdomApi.getState().then((snapshot) => {
      if (!active) return;
      setFetchedKingdomState(snapshot);
      onKingdomSnapshot?.(snapshot);
    }).catch((error: unknown) => {
      if (active) setKingdomError(error instanceof Error ? error.message : "Kingdom authority is unavailable");
    });
    return () => { active = false; };
  }, [effectiveKingdomState?.membership, flag, kingdomApi, moreOpen, onKingdomSnapshot, player?.playerId]);

  useEffect(() => {
    let active = true;
    setEligibility(null);
    setRemovalPreview(null);
    setKingdomError(null);
    if (!flag || !effectiveKingdomState?.membership || !effectiveKingdomState.kingdom ||
        effectiveKingdomState.kingdom.status !== "active") return () => { active = false; };
    const sameKingdom = flag.controlType === "kingdom" && flag.kingdomId === effectiveKingdomState.kingdom.id;
    const canInspectRemoval = sameKingdom &&
      effectiveKingdomState.permissions.includes("release_kingdom_flags");
    const request = canInspectRemoval
      ? kingdomApi.getFlagRemovalPreview(flag.id).then((value) => { if (active) setRemovalPreview(value); })
      : flag.ownerId === player?.playerId && flag.controlType === "personal" &&
          flag.upgradeTier !== "atlas_shrine" && flag.upgradeTier !== "tower"
        ? kingdomApi.getFlagEligibility(flag.id).then((value) => { if (active) setEligibility(value); })
        : Promise.resolve();
    void request.catch((error: unknown) => {
      if (active) setKingdomError(error instanceof Error ? error.message : "Kingdom Flag authority is unavailable");
    });
    return () => { active = false; };
  }, [effectiveKingdomState?.kingdom, effectiveKingdomState?.membership, flag, kingdomApi, player?.playerId]);

  if (!flag) {
    return null;
  }
  // Developer fixtures retain the spawning player as their raw lifecycle
  // owner, but their presentation/combat identity is the dedicated hostile
  // test opponent. Never expose owner/access actions to that creator.
  const personalOwner = flag.controlType === "personal" &&
    player?.playerId === flag.ownerId && flag.developerTestTarget !== true;
  const isBuoy = flag.anchorKind === "buoy";
  const cityControlled = flag.controlType === "city" || flag.controlType === "city_seat";
  const activeKingdomId = effectiveKingdomState?.membership && effectiveKingdomState.kingdom?.status === "active"
    ? effectiveKingdomState.kingdom.id
    : null;
  const sameActiveKingdom = flag.controlType === "kingdom" && flag.kingdomId === activeKingdomId;
  const canConvert = Boolean(
    personalOwner &&
    !isBuoy &&
    flag.upgradeTier !== "atlas_shrine" && flag.upgradeTier !== "tower" &&
    activeKingdomId
  );
  const canRemoveAffiliation = Boolean(
    sameActiveKingdom && effectiveKingdomState?.permissions.includes("release_kingdom_flags")
  );
  const canDestroyCityFlag = Boolean(
    flag.controlType === "city" &&
    flag.cityId === cityMembership?.cityId &&
    (cityMembership.role === "mayor" || flag.ownerId === player?.playerId)
  );
  const canDelete = Boolean(
    personalOwner ||
    canDestroyCityFlag ||
    (sameActiveKingdom && effectiveKingdomState?.permissions.includes("destroy_kingdom_flags"))
  );
  const canUpgrade = Boolean(
    !isBuoy && (personalOwner ||
    canDestroyCityFlag ||
    (sameActiveKingdom && effectiveKingdomState?.permissions.includes("manage_kingdom_flags")))
  );
  const enemyFlag = access?.decision.reasonCode.endsWith("ENEMY_BLOCKED") === true;
  const canBurn = !personalOwner && Boolean(
    onBurn && isFlagBurnablePresentationTarget(flag, player?.playerId, warfareAllies)
  );
  const canAttack = !personalOwner && Boolean(
    onAttack && isFlagAttackablePresentationTarget(flag, player?.playerId, warfareAllies)
  );
  const eligibleBomberGroups = useMemo(
    () => bomberGroups
      .filter((group) =>
        group.ownerPlayerId === player?.playerId &&
        group.unitType === "bomber" &&
        group.memberCount > 0 &&
        ["FOLLOWING_PLAYER", "DEPLOYED_FIELD"].includes(group.locationState) &&
        group.packingCompletesAt === null
      )
      .sort((left, right) => left.groupId.localeCompare(right.groupId)),
    [bomberGroups, player?.playerId]
  );
  const canExplode = !personalOwner && Boolean(
    onExplode &&
    isFlagDemolishablePresentationTarget(flag, player?.playerId, warfareAllies, repairActive) &&
    eligibleBomberGroups.length > 0
  );
  const bomberChoices = useMemo<GameTargetChoice[]>(
    () => eligibleBomberGroups.map((group) => {
      const distance = group.lat !== null && group.lon !== null
        ? Math.round(distanceMeters({ lat: group.lat, lon: group.lon }, flag))
        : null;
      return {
        key: group.groupId,
        name: militaryGroupDisplayName(group.unitType, group.memberCount),
        category: "MILITARY GROUP",
        ...(distance === null ? {} : { meta: `${distance} m from target` })
      };
    }),
    [eligibleBomberGroups, flag]
  );
  // City and kingdom structures are always hostile when the predicates allow
  // them, so their combat actions sit on the panel like an enemy Flag's.
  const organizationTarget = flag.controlType !== "personal";
  const directCombat = enemyFlag || flag.developerTestTarget === true || organizationTarget;
  const structureLabel = structureWarfareStructureLabel(flag);
  const combatMoreVisible = !personalOwner && !directCombat && (canBurn || canAttack);
  const canDisrupt = !personalOwner && !repairAction.visible && repairActive && Boolean(onDisrupt);
  const disruptDisabledReason = !disruptEligible
    ? "Only a player who damaged this Flag during this damage cycle can Disrupt Repair."
    : !connected
      ? "Disrupting a repair requires an online connection."
      : null;
  const cityExpansionLimitReason = cityMembership && !cityExpansionLimitExempt &&
    cityMembership.expansionFlagCount >= cityMembership.expansionFlagLimit
    ? `City expansion limit reached: ${cityMembership.expansionFlagCount} of ` +
      `${cityMembership.expansionFlagLimit} flags` +
      `${cityMembership.expansionFlagCount > cityMembership.expansionFlagLimit
        ? " (over capacity)"
        : ""}.`
    : null;
  const displayName = flagInteractionHeading(flag, access);
  const towerLabel = towerStatusLabel(flag);
  const healthLabel = towerLabel ?? damagedHealthLabel(flag.health, flag.maximumHealth);
  // Like Harden, tower upgrades only appear when the flag can be approached.
  const towerOffer = upgradeApproachReachable ? towerUpgradeOffer(flag, {
    playerId: player?.playerId,
    mayorOfCityId: cityMembership?.role === "mayor" ? cityMembership.cityId : null
  }) : null;
  // The kingdom leader builds Obelisks and Kingdom Towers on the kingdom's flags.
  const kingdomOffers = upgradeApproachReachable
    ? kingdomStructureOffers(flag, { buildKingdomId: kingdomStructureBuildKingdomId(effectiveKingdomState) })
    : [];
  const applyKingdomMutation = async (operation: () => Promise<{ state: KingdomStateSnapshot | null }>): Promise<void> => {
    setKingdomBusy(true);
    setKingdomError(null);
    try {
      const result = await operation();
      if (result.state) onKingdomSnapshot?.(result.state);
      else onKingdomRefresh?.();
      setConfirmation(null);
    } catch (error) {
      setKingdomError(error instanceof Error ? error.message : "Kingdom Flag action failed");
    } finally {
      setKingdomBusy(false);
    }
  };

  if (bomberPickerOpen && canExplode) {
    return <GameTargetPicker
      ariaLabel="Choose a Bomber group"
      title="Choose Bomber"
      choices={bomberChoices}
      onSelect={(groupId) => {
        setBomberPickerOpen(false);
        onExplode?.(groupId, flag.id);
      }}
      onQuickAction={() => undefined}
      onCancel={() => setBomberPickerOpen(false)}
    />;
  }

  if (personalOwner && moreOpen && access) {
    return <FlagMorePrompt
      flag={flag}
      access={access}
      displayName={displayName}
      serverHttpBase={serverHttpBase}
      csrfToken={csrfToken}
      connected={connected}
      deleting={deleting}
      onAccessSaved={(next) => {
        if (onAccessSaved) onAccessSaved(next);
        else onAccessChange?.(next);
      }}
      {...(onAtlasShrineMutation ? { onAtlasShrineMutation } : {})}
      onDestroy={onDeleteFlag}
      onClose={onClose}
    />;
  }
  if (!personalOwner && moreOpen && (canBurn || canAttack)) {
    return <FlagMorePrompt
      flag={flag}
      displayName={displayName}
      connected={connected}
      {...(onBurn && canBurn ? { onBurn: () => { onBurn(flag.id); } } : {})}
      {...(onAttack && canAttack ? { onAttack: () => { onAttack(flag.id); } } : {})}
      showManagement={false}
      onClose={onClose}
    />;
  }

  return (
    <>
      <aside
        ref={flagPanelRef}
        className="flag-panel"
        aria-label={`${displayName} actions`}
        data-world-target-presentation={presentationState}
        onClickCapture={actionsReady ? undefined : (event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onSubmitCapture={actionsReady ? undefined : (event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <button
          type="button"
          className="panel-close"
          onClick={onClose}
          aria-label="Close flag panel"
        >
          ×
        </button>
        <h2>{displayName}</h2>
        {healthLabel !== null ? <p className="flag-panel-health">{healthLabel}</p> : null}
        {flag.controlType === "kingdom" ? (
          <p className="flag-panel-affiliation">
            <strong>Kingdom Flag</strong> — contributed by {flag.contributedByUsername ?? flag.ownerUsername ?? "Unknown contributor"}<br />
            {flag.kingdomEmblemKey ? <span aria-hidden="true">{flag.kingdomEmblemKey} · </span> : null}
            {flag.kingdomName ?? "Unknown Kingdom"}
          </p>
        ) : null}
        {cityControlled ? (
          <p className="flag-panel-affiliation">
            <strong>{flag.controlType === "city_seat" ? "City Center" : "City Flag"}</strong>
            {flag.burning && flag.burningUntil ? <> · Burning</> : null}
          </p>
        ) : null}
        {!hasPersonalAccessPresentation(flag) ? <div className="flag-panel-owner">
          <span
            className="owner-color-dot"
            style={{ backgroundColor: flagOwnerIndicatorColor(flag) }}
            aria-hidden="true"
          />
          <span>{flag.ownerUsername ?? "Unknown owner"}</span>
        </div> : null}
        <div className="flag-panel-actions">
          {flag.controlType === "personal" && !flag.developerTestTarget && !enemyFlag && access && accessTraceId ? <FlagAccessControls
            flag={flag}
            player={player}
            walletGold={walletGold}
            serverHttpBase={serverHttpBase}
            csrfToken={csrfToken}
            access={access}
            travelPending={travelPending}
            aggressiveRemainingMs={aggressiveRemainingMs}
            connected={connected}
            compact={!moreOpen}
            onVisitFlag={onVisitFlag}
            onAccessChange={(next) => onAccessChange?.(next)}
            onAccessSaved={(next) => {
              if (onAccessSaved) onAccessSaved(next);
              else onAccessChange?.(next);
            }}
          /> : flag.controlType !== "personal" && !enemyFlag ? <button
              type="button"
              className="panel-action"
              onClick={() => onVisitFlag(flag.id)}
              disabled={aggressiveRemainingMs > 0}
              title={aggressiveRemainingMs > 0 ? "Flag travel is locked while Aggressive" : undefined}
            >
              {aggressiveRemainingMs > 0 ? flagVisitLockLabel(aggressiveRemainingMs) : "Travel to Flag"}
            </button> : null}
          {!moreOpen && onMark && !enemyFlag ? <button
            type="button"
            className="panel-action"
            disabled={!connected}
            onClick={() => {
              onMark(flag.id);
              onClose();
            }}
          >Mark</button> : null}
          {!moreOpen && hardeningAction.visible ? <button
            type="button"
            className="panel-action"
            disabled={!hardeningAction.enabled}
            title={hardeningAction.disabledReason ?? undefined}
            onClick={hardeningAction.harden}
          >{hardeningAction.label}</button> : null}
          {!moreOpen && canAttack && directCombat ? <button
            type="button"
            className="panel-action panel-action-danger"
            disabled={!connected}
            title={!connected ? "Attacking a Flag requires an online connection." : undefined}
            onClick={() => onAttack?.(flag.id)}
          >Attack {structureLabel}</button> : null}
          {!moreOpen && canBurn && directCombat ? <button
            type="button"
            className="panel-action panel-action-danger"
            disabled={!connected}
            title={!connected ? "Burning a Flag requires an online connection." : undefined}
            onClick={() => {
              onBurn?.(flag.id);
              onClose();
            }}
          >Burn {structureLabel} · 1 Torch</button> : null}
          {!moreOpen && canExplode ? <button
            type="button"
            className="panel-action panel-action-danger"
            disabled={!connected}
            title={!connected ? "Planting a Bomb requires an online connection." : undefined}
            onClick={() => setBomberPickerOpen(true)}
          >Plant Bomb</button> : null}
          {!moreOpen && towerOffer ? <button
            type="button"
            className="panel-action"
            disabled={!connected || hardeningFlagId !== null}
            title={!connected ? "Upgrading requires an online connection." : undefined}
            onClick={() => onUpgrade(flag.id, towerOffer.targetTier, towerOffer.targetTowerLevel)}
          >{hardeningFlagId === flag.id && activeUpgradeTargetTier === towerOffer.targetTier
            ? "Upgrading…"
            : towerOffer.label}</button> : null}
          {!moreOpen ? kingdomOffers.map((offer) => <button
            key={offer.targetTier}
            type="button"
            className="panel-action"
            disabled={!connected || hardeningFlagId !== null}
            title={!connected ? "Building requires an online connection." : undefined}
            onClick={() => onUpgrade(flag.id, offer.targetTier, offer.targetTowerLevel)}
          >{hardeningFlagId === flag.id && activeUpgradeTargetTier === offer.targetTier
            ? "Building…"
            : offer.label}</button>) : null}
          {!moreOpen && hardeningAction.error ? (
            <p className="panel-error" role="alert">{hardeningAction.error}</p>
          ) : null}
          {!moreOpen && repairAction.visible ? <button
            type="button"
            className="panel-action"
            disabled={repairing ? !connected : !repairAction.enabled}
            title={repairAction.disabledReason ?? undefined}
            onClick={() => repairing ? repairAction.cancel() : setConfirmation("repair")}
          >{repairAction.label}</button> : null}
          {!moreOpen && repairing && repairPausedBurnRemainingMs !== null ? (
            <small className="flag-panel-repair-status">
              Burn paused · {formatFlagRepairRemaining(repairPausedBurnRemainingMs)} remaining
            </small>
          ) : null}
          {!moreOpen && repairAction.visible && repairAction.error ? (
            <p className="panel-error" role="alert">{repairAction.error}</p>
          ) : null}
          {!moreOpen && canDisrupt ? <button
            type="button"
            className="panel-action panel-action-danger"
            disabled={disrupting ? !connected : !disruptEligible || !connected}
            title={disrupting ? (!connected ? disruptDisabledReason ?? undefined : undefined) : disruptDisabledReason ?? undefined}
            onClick={() => {
              if (disrupting) {
                if (disruptOperationId) onCancelDisrupt?.(flag.id, disruptOperationId);
              } else if (repairOperationId) {
                onDisrupt?.(flag.id, repairOperationId);
              }
            }}
          >{disrupting ? "Disrupting… 0:08" : "Disrupt Repair"}</button> : null}
          {(personalOwner && access || combatMoreVisible) && !moreOpen ? <button
            type="button" className="panel-action panel-action-secondary" onClick={() => setMoreOpen(true)}
          >More</button> : null}
      {!personalOwner ? <div>
          {personalOwner && flag.upgradeTier === "atlas_shrine" && onRenameFlag ? renameOpen ? (
            <form className="flag-panel-rename" onSubmit={(event) => {
              event.preventDefault();
              const name = renameValue.trim();
              if (name === flag.name) return;
              setRenameBusy(true);
              void Promise.resolve(onRenameFlag(flag.id, name)).then(() => {
                setRenameOpen(false);
              }).finally(() => setRenameBusy(false));
            }}>
              <label>Flag name<input value={renameValue} maxLength={15}
                onChange={(event) => setRenameValue(event.currentTarget.value)} /></label>
              <button type="submit" className="panel-action" disabled={renameBusy}>
                {renameBusy ? "Renaming…" : "Save Name"}
              </button>
              <button type="button" className="panel-action panel-action-secondary"
                onClick={() => { setRenameOpen(false); setRenameValue(flag.name); }}>Cancel</button>
            </form>
          ) : (
            <button type="button" className="panel-action panel-action-secondary"
              onClick={() => { setRenameValue(flag.name); setRenameOpen(true); }}>Rename</button>
          ) : null}
          {flag.cityId && onOpenCity ? (
            <button
              type="button"
              className="panel-action"
              onClick={() => onOpenCity(flag.cityId!)}
            >
              Open City Information
            </button>
          ) : null}
          {personalOwner && !isBuoy && flag.upgradeTier !== "atlas_shrine" && flag.upgradeTier !== "tower" &&
          !cityMembership && onPreviewCityFounding ? (
            <button
              type="button"
              className="panel-action"
              disabled={cityBusy}
              title="Place a city blueprint at the selected flag center."
              onClick={() => onPreviewCityFounding(flag.id)}
            >
              {cityBusy ? "Validating Blueprint…" : "Place City Blueprint"}
            </button>
          ) : null}
          {personalOwner && !isBuoy && flag.upgradeTier !== "atlas_shrine" && flag.upgradeTier !== "tower" &&
          cityMembership && onConvertCityFlag ? (
            <button
              type="button"
              className="panel-action"
              disabled={cityBusy || cityExpansionLimitReason !== null}
              title={cityExpansionLimitReason ?? undefined}
              onClick={() => onConvertCityFlag(flag.id)}
            >
              {cityBusy ? "Converting…" : `Contribute to ${cityMembership.cityName}`}
            </button>
          ) : null}
          {canConvert ? (
            <button
              type="button"
              className="panel-action"
              disabled={kingdomBusy || !eligibility?.eligible}
              title={eligibility?.reason ?? kingdomError ?? "Checking authoritative territory connectivity"}
              onClick={() => void applyKingdomMutation(() => kingdomApi.convertFlag(flag.id))}
            >
              {`Contribute to ${effectiveKingdomState?.kingdom?.displayName ?? "Kingdom"}`}
            </button>
          ) : null}
          {canRemoveAffiliation ? (
            <button
              type="button"
              className="panel-action panel-action-secondary"
              disabled={kingdomBusy || !removalPreview?.allowed}
              title={removalPreview?.reason ?? kingdomError ?? "Checking downstream Kingdom Flags"}
              onClick={() => setConfirmation("remove")}
            >
              Return to Personal Flag
            </button>
          ) : null}
          {canDelete ? (
            <button
              type="button"
              className="panel-action panel-action-danger"
              onClick={onDeleteFlag}
              disabled={deleting || Boolean(flag.controlType === "kingdom" && !removalPreview?.allowed)}
              title={flag.controlType === "kingdom" && !removalPreview?.allowed
                ? removalPreview?.reason ?? kingdomError ?? "Checking downstream Kingdom Flags"
                : undefined}
            >
              {deleting ? "Destroying…" : `Destroy ${isBuoy ? "Buoy" : "Flag"}`}
            </button>
          ) : null}
          {personalOwner && flag.upgradeTier === "stone" ? (
            <button
              type="button"
              className="panel-action"
              disabled={!connected || hardeningFlagId !== null || !upgradeApproachReachable}
              title={!upgradeApproachReachable
                ? "This Tower upgrade cannot be reached from your current movement area."
                : undefined}
              onClick={() => onUpgrade(flag.id, "tower")}
            >{hardeningFlagId === flag.id && activeUpgradeTargetTier === "tower"
              ? "Upgrading…"
              : "Upgrade to Tower · 25 Stone"}</button>
          ) : null}
          {canUpgrade ? <AtlasShrineControls
            flag={flag}
            canUpgrade
            showStoneUpgrade={!personalOwner}
            hardening={hardeningFlagId === flag.id}
            anotherHardeningActive={hardeningFlagId !== null && hardeningFlagId !== flag.id}
            onHarden={onHarden}
             connected={connected}
             serverHttpBase={serverHttpBase}
             csrfToken={csrfToken}
             {...(onRepair ? { onRepair } : {})}
             {...(onAtlasShrineMutation ? { onMutation: onAtlasShrineMutation } : {})}
          /> : null}
          <button
            type="button"
            className="panel-action panel-action-secondary"
            onClick={() => setPlayerDetailsOpen(true)}
          >
            Player Details
          </button>
          </div> : null}
        </div>
        {canConvert && eligibility && !eligibility.eligible ? (
          <p className="kingdom-note">Cannot convert: {eligibility.reason}</p>
        ) : null}
        {personalOwner && cityMembership && cityExpansionLimitReason ? (
          <p className="kingdom-note">Cannot convert: {cityExpansionLimitReason}</p>
        ) : null}
        {flag.controlType === "kingdom" && flag.contributedByPlayerId === player?.playerId && !canDelete && !canRemoveAffiliation ? (
          <p className="kingdom-note">This flag is controlled by the Kingdom. You do not have permission to release or destroy it.</p>
        ) : null}
        {canRemoveAffiliation && removalPreview && !removalPreview.allowed ? (
          <p className="kingdom-note">Cannot remove affiliation: {removalPreview.reason}</p>
        ) : null}
        {kingdomError ? <p className="panel-error" role="alert">{kingdomError}</p> : null}
      </aside>
      {confirmation === "remove" && removalPreview?.allowed && removalPreview.networkRevision ? (
        <ConfirmDialog
          title="Return to Personal Flag?"
          message={`Kingdom control will end and the flag will return to ${flag.contributedByUsername ?? flag.ownerUsername ?? "its original contributor"}. ${removalPreview.downstreamCount === 0 ? "No downstream Kingdom Flags will be affected." : `${removalPreview.downstreamCount} downstream Kingdom Flag${removalPreview.downstreamCount === 1 ? "" : "s"} will also return to personal flags.`}`}
          confirmLabel="Return to Personal"
          busy={kingdomBusy}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => void applyKingdomMutation(() =>
            kingdomApi.removeFlag(flag.id, removalPreview.networkRevision!))}
        />
      ) : null}
      {confirmation === "repair" && repairAction.visible ? (
        <GameConfirmationPrompt
          title="Repair this Flag?"
          category="FLAG REPAIR"
          detail="Repair is free and takes time: health returns at 5x the burn rate and any burn pauses while you stay. Damage taken while repairing counts triple, and Bombers can destroy a repairing structure. Moving, travel, death, or disconnect stops the repair and keeps the health restored so far."
          confirmLabel="Repair Flag"
          confirmEnabled={connected && repairAction.enabled}
          disabledReason={!connected ? "Repairing a Flag requires an online connection." : null}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            setConfirmation(null);
            repairAction.repair();
          }}
        />
      ) : null}
      {playerDetailsOpen ? (
        <PlayerFlagDetails
          flagId={flag.id}
          flagName={displayName}
          serverHttpBase={serverHttpBase}
          onClose={() => setPlayerDetailsOpen(false)}
        />
      ) : null}
    </>
  );
}

function formatFlagRepairRemaining(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
