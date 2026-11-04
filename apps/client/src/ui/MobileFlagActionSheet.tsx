import { distanceMeters, kingdomDowngradeStructureMaxLevel, militaryGroupDisplayName, type CityMembershipSnapshot, type FlagAccessSnapshot, type FlagReinforcementTarget, type FlagSnapshot, type KingdomStateSnapshot, type MilitaryUnitGroupSnapshot, type PlayerSnapshot } from "@ash-atlas/shared";
import { useEffect, useMemo, useState } from "react";

import { requestFlagPassage } from "../flags/flagAccess.js";
import { damagedHealthLabel } from "../combat/healthBarPresentation.js";
import {
  flagInteractionHeading,
  isFlagAttackablePresentationTarget,
  isFlagDemolishablePresentationTarget,
  isFlagBurnablePresentationTarget,
  structureWarfareStructureLabel,
  kingdomStructureBuildKingdomId,
  kingdomStructureOffers,
  towerStatusLabel,
  towerUpgradeOffer
} from "../flags/flagDisplay.js";
import { flagVisitActionLabel, resolveFlagVisitAction } from "../flags/flagVisitAction.js";
import { KingdomApiClient } from "../kingdom/kingdomClient.js";
import { KINGDOM_DOWNGRADE_ACTION_LABEL, downgradeConfirmationMessage } from "../kingdom/kingdomDowngrade.js";
import type { AtlasShrineMutationResult } from "../flags/atlasShrines.js";
import { useFlagHardeningAction } from "../flags/useFlagHardeningAction.js";
import { useFlagRepairAction } from "../flags/useFlagRepairAction.js";
import { FlagMorePrompt } from "./FlagMorePrompt.js";
import { GameConfirmationPrompt, type GamePromptPresentationState } from "./GameActionPrompt.js";
import { GameTargetPicker, type GameTargetChoice } from "./GameTargetPicker.js";
import { MobileWorldActionSheet } from "./MobileWorldActionSheet.js";

type Props = Readonly<{
  flag: FlagSnapshot;
  player: PlayerSnapshot | null;
  walletGold: string | null;
  serverHttpBase: string;
  csrfToken: string;
  access?: FlagAccessSnapshot | null;
  aggressiveRemainingMs: number;
  travelPending?: boolean;
  connected: boolean;
  cityMembership?: CityMembershipSnapshot | null;
  cityBusy?: boolean;
  onConvertCityFlag?(flagId: string): void;
  kingdomState?: KingdomStateSnapshot | null;
  onKingdomSnapshot?(snapshot: KingdomStateSnapshot): void;
  onKingdomRefresh?(): void;
  managementOpen: boolean;
  deleting?: boolean;
  presentationState?: GamePromptPresentationState | undefined;
  actionsReady?: boolean;
  onVisit(flagId: string, expectedTollGold?: string, requestId?: string): boolean;
  onManage(): void;
  /** Pathfinder Boot: present only while one is worn and this building can be marked. */
  onMark?(flagId: string): void;
  onRename?(flagId: string, name: string): Promise<void> | void;
  onDestroy?(): void;
  onReturnToGame(): void;
  onClose(): void;
  onAccessChange(access: FlagAccessSnapshot): void;
  onAccessSaved?(access: FlagAccessSnapshot): void;
  onAtlasShrineMutation?(result: AtlasShrineMutationResult): void;
  onFlagSnapshot?(flag: FlagSnapshot): void;
  hardeningFlagId?: string | null;
  activeUpgradeTargetTier?: FlagReinforcementTarget | null;
  upgradeApproachReachable?: boolean;
  onHarden?(flagId: string): boolean;
  onUpgrade?(flagId: string, targetTier: FlagReinforcementTarget, targetTowerLevel?: number): boolean;
  onBurn?(flagId: string): boolean;
  onAttack?(flagId: string): boolean;
  bomberGroups?: readonly MilitaryUnitGroupSnapshot[];
  onExplode?(groupId: string, flagId: string): boolean | void;
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
}>;

export function MobileFlagActionSheet(props: Props): React.JSX.Element {
  const [access, setAccess] = useState<FlagAccessSnapshot | null>(props.access ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repairConfirmation, setRepairConfirmation] = useState(false);
  const [bomberPickerOpen, setBomberPickerOpen] = useState(false);
  const [downgradeConfirmation, setDowngradeConfirmation] = useState(false);
  const [downgrading, setDowngrading] = useState(false);

  useEffect(() => {
    setAccess(props.access ?? null);
    setError(null);
    setRepairConfirmation(false);
    setBomberPickerOpen(false);
    setDowngradeConfirmation(false);
  }, [props.access, props.flag.id]);

  const developerTestTarget = props.flag.developerTestTarget === true;
  // A test fixture's raw owner is retained for cleanup only; the marker makes
  // it a hostile target even to the developer who spawned it.
  const owner = props.flag.controlType === "personal" &&
    props.flag.ownerId === props.player?.playerId && !developerTestTarget;
  const visitAction = access
    ? resolveFlagVisitAction({
        flag: props.flag,
        access,
        busy,
        travelPending: props.travelPending === true,
        connected: props.connected,
        aggressiveRemainingMs: props.aggressiveRemainingMs,
        walletGold: props.walletGold
      })
    : {
        kind: "visit" as const,
        label: "Loading Access…",
        enabled: false,
        disabledReason: "Flag access is still loading.",
        busy: false
      };
  const displayName = flagInteractionHeading(props.flag, access);
  const healthLabel = props.flag.controlType === "kingdom_seat" && props.flag.health === 0
    ? "Castle in rubble"
    : towerStatusLabel(props.flag) ?? damagedHealthLabel(props.flag.health, props.flag.maximumHealth);
  // Like Harden, tower upgrades only appear when the flag can be approached.
  const towerOffer = (props.upgradeApproachReachable ?? true) ? towerUpgradeOffer(props.flag, {
    playerId: props.player?.playerId,
    mayorOfCityId: props.cityMembership?.role === "mayor" ? props.cityMembership.cityId : null
  }) : null;
  const towerUpgrading = props.hardeningFlagId === props.flag.id && towerOffer !== null &&
    props.activeUpgradeTargetTier === towerOffer.targetTier;
  // The kingdom leader builds Obelisks and Kingdom Towers: one offer acts
  // directly, two (a plain Kingdom Flag) open a picker.
  const kingdomOffers = (props.upgradeApproachReachable ?? true)
    ? kingdomStructureOffers(props.flag, { buildKingdomId: kingdomStructureBuildKingdomId(props.kingdomState) })
    : [];
  const [structurePickerOpen, setStructurePickerOpen] = useState(false);
  // The kingdom leader can take a Kingdom Tower or Obelisk above level 1 down
  // one level for a 45% treasury refund (confirmed first).
  const downgradeTarget = kingdomStructureDowngradeTarget(
    props.flag, kingdomStructureBuildKingdomId(props.kingdomState)
  );
  const downgrade = (): void => {
    if (!downgradeTarget) return;
    setDowngrading(true);
    setError(null);
    void new KingdomApiClient(props.serverHttpBase, props.csrfToken)
      .downgradeStructure({ structure: downgradeTarget.kind, fromLevel: downgradeTarget.level, flagId: props.flag.id })
      .then((result) => {
        if (result.state) props.onKingdomSnapshot?.(result.state);
        else props.onKingdomRefresh?.();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Downgrade failed."))
      .finally(() => setDowngrading(false));
  };
  const structureBuilding = props.hardeningFlagId === props.flag.id &&
    kingdomOffers.some((offer) => offer.targetTier === props.activeUpgradeTargetTier);
  const hardeningAction = useFlagHardeningAction({
    flag: props.flag,
    playerId: props.player?.playerId,
    connected: props.connected,
    hardening: props.hardeningFlagId === props.flag.id,
    anotherHardeningActive: props.hardeningFlagId !== null &&
      props.hardeningFlagId !== undefined && props.hardeningFlagId !== props.flag.id,
    approachReachable: props.upgradeApproachReachable ?? true,
    onHarden: props.onHarden ?? (() => false)
  });
  const warfareAllies = {
    cityId: props.cityMembership?.cityId ?? null,
    kingdomId: props.kingdomState?.membership && props.kingdomState.kingdom?.status === "active"
      ? props.kingdomState.kingdom.id
      : null
  };
  const repairAction = useFlagRepairAction({
    allies: warfareAllies,
    flag: props.flag,
    playerId: props.player?.playerId,
    connected: props.connected,
    serverHttpBase: props.serverHttpBase,
    csrfToken: props.csrfToken,
    ...(props.onFlagSnapshot ? { onFlagSnapshot: props.onFlagSnapshot } : {}),
    ...(props.onRepair ? { onRepair: props.onRepair } : {}),
    repairing: props.repairing ?? false,
    ...(props.onCancelRepair && props.repairOperationId ? {
      onCancel: () => props.onCancelRepair?.(props.flag.id, props.repairOperationId!)
    } : {})
  });
  const enemyFlag = access?.decision.reasonCode.endsWith("ENEMY_BLOCKED") === true;
  const canBurn = !owner && Boolean(
    props.onBurn && isFlagBurnablePresentationTarget(props.flag, props.player?.playerId, warfareAllies)
  );
  const canAttack = !owner && Boolean(
    props.onAttack && isFlagAttackablePresentationTarget(props.flag, props.player?.playerId, warfareAllies)
  );
  const eligibleBomberGroups = useMemo(
    () => (props.bomberGroups ?? [])
      .filter((group) =>
        group.ownerPlayerId === props.player?.playerId &&
        group.unitType === "bomber" &&
        group.memberCount > 0 &&
        ["FOLLOWING_PLAYER", "DEPLOYED_FIELD"].includes(group.locationState) &&
        group.packingCompletesAt === null
      )
      .sort((left, right) => left.groupId.localeCompare(right.groupId)),
    [props.bomberGroups, props.player?.playerId]
  );
  const canExplode = !owner && Boolean(
    props.onExplode &&
    isFlagDemolishablePresentationTarget(props.flag, props.player?.playerId, warfareAllies, props.repairActive === true) &&
    eligibleBomberGroups.length > 0
  );
  const bomberChoices = useMemo<GameTargetChoice[]>(
    () => eligibleBomberGroups.map((group) => {
      const distance = group.lat !== null && group.lon !== null
        ? Math.round(distanceMeters({ lat: group.lat, lon: group.lon }, props.flag))
        : null;
      return {
        key: group.groupId,
        name: militaryGroupDisplayName(group.unitType, group.memberCount),
        category: "MILITARY GROUP",
        ...(distance === null ? {} : { meta: `${distance} m from target` })
      };
    }),
    [eligibleBomberGroups, props.flag]
  );
  // Defenders (the owner, or members of the structure's city / kingdom) repair;
  // only hostile contributors disrupt.
  const canDisrupt = !owner && !repairAction.visible && props.repairActive === true && Boolean(props.onDisrupt);
  const disruptDisabledReason = !props.disruptEligible
    ? "Only a player who damaged this Flag during this damage cycle can Disrupt Repair."
    : !props.connected
      ? "Disrupting a repair requires an online connection."
      : null;
  const directCombat = (enemyFlag || developerTestTarget || props.flag.controlType !== "personal") && (canAttack || canBurn);
  const middleAction = canExplode
    ? {
        visible: true,
        label: "Plant Bomb",
        enabled: props.connected,
        busy: false,
        disabledReason: props.connected ? null : "Planting a Bomb requires an online connection.",
        error: null
      }
    : directCombat && canAttack
    ? {
        visible: true,
        label: `Attack ${structureWarfareStructureLabel(props.flag)}`,
        enabled: props.connected,
        busy: false,
        disabledReason: props.connected ? null : "Attacking a Flag requires an online connection.",
        error: null
      }
    : directCombat && canBurn
    ? {
        visible: true,
        label: `Burn ${structureWarfareStructureLabel(props.flag)} · 1 Torch`,
        enabled: props.connected,
        busy: false,
        disabledReason: props.connected ? null : "Burning a Flag requires an online connection.",
        error: null
      }
    : canDisrupt
    ? {
        visible: true,
        label: props.disrupting ? "Disrupting… 0:08" : "Disrupt Repair",
        enabled: props.disrupting ? props.connected : props.connected && props.disruptEligible === true,
        busy: props.disrupting === true,
        disabledReason: props.disrupting ? (!props.connected ? disruptDisabledReason : null) : disruptDisabledReason,
        error: null
      }
    : repairAction.visible
      ? {
          ...repairAction,
          label: repairAction.label,
          enabled: props.repairing ? props.connected : repairAction.enabled
        }
      : towerOffer && props.onUpgrade
        ? {
            visible: true,
            label: towerUpgrading ? "Upgrading…" : towerOffer.label,
            enabled: props.connected && !props.hardeningFlagId,
            busy: towerUpgrading,
            disabledReason: props.connected ? null : "Upgrading requires an online connection.",
            error: null
          }
      : kingdomOffers.length > 0 && props.onUpgrade
        ? {
            visible: true,
            label: structureBuilding ? "Building…" : kingdomOffers.length === 1 ? kingdomOffers[0]!.label : "Build",
            enabled: props.connected && !props.hardeningFlagId,
            busy: structureBuilding,
            disabledReason: props.connected ? null : "Building requires an online connection.",
            error: null
          }
      : props.onMark && !enemyFlag && !developerTestTarget
        ? {
            visible: true,
            label: "Mark",
            enabled: props.connected,
            busy: false,
            disabledReason: props.connected ? null : "Marking requires an online connection.",
            error: null
          }
      : hardeningAction;

  const act = (): void => {
    if (visitAction.kind === "request_access") {
      if (!access) {
        setError("Flag access is still loading.");
        return;
      }
      setBusy(true);
      setError(null);
      void requestFlagPassage(props.serverHttpBase, props.csrfToken, props.flag.id)
        .then(() => {
          const next = { ...access, requestPending: true, decision: { ...access.decision, requestable: false } };
          setAccess(next);
          props.onAccessChange(next);
        })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Passage request failed."))
        .finally(() => setBusy(false));
      return;
    }
    if (visitAction.enabled && props.onVisit(props.flag.id, visitAction.expectedTollGold)) props.onClose();
  };

  if (bomberPickerOpen && canExplode) {
    return <GameTargetPicker
      ariaLabel="Choose a Bomber group"
      title="Choose Bomber"
      choices={bomberChoices}
      onSelect={(groupId) => {
        setBomberPickerOpen(false);
        props.onExplode?.(groupId, props.flag.id);
      }}
      onQuickAction={() => undefined}
      onCancel={() => setBomberPickerOpen(false)}
    />;
  }

  if (structurePickerOpen && kingdomOffers.length > 1) {
    return <GameTargetPicker
      ariaLabel="Choose a Kingdom structure"
      title="Build on this Kingdom Flag"
      choices={kingdomOffers.map((offer) => ({
        key: offer.targetTier,
        name: offer.targetTier === "obelisk" ? "Obelisk" : "Kingdom Tower",
        category: "KINGDOM STRUCTURE",
        meta: offer.label.split(" · ").slice(1).join(" · ")
      }))}
      onSelect={(key) => {
        setStructurePickerOpen(false);
        const offer = kingdomOffers.find((entry) => entry.targetTier === key);
        if (offer) props.onUpgrade?.(props.flag.id, offer.targetTier, offer.targetTowerLevel);
      }}
      onQuickAction={() => undefined}
      onCancel={() => setStructurePickerOpen(false)}
    />;
  }

  if (downgradeConfirmation && downgradeTarget) {
    const name = downgradeTarget.kind === "obelisk" ? "Obelisk" : "Kingdom Tower";
    return <GameConfirmationPrompt
      title={`Downgrade to ${name} level ${downgradeTarget.level - 1}?`}
      category="KINGDOM STRUCTURE"
      detail={downgradeConfirmationMessage(downgradeTarget.kind, downgradeTarget.level)}
      confirmLabel="Downgrade"
      confirmEnabled={props.connected && !downgrading}
      disabledReason={!props.connected ? "Downgrading requires an online connection." : null}
      onCancel={() => setDowngradeConfirmation(false)}
      onConfirm={() => {
        setDowngradeConfirmation(false);
        downgrade();
      }}
    />;
  }

  if (props.managementOpen && (owner ? access !== null : canBurn || canAttack)) {
    return <FlagMorePrompt
      flag={props.flag}
      {...(owner ? { access } : {})}
      displayName={displayName}
      {...(owner ? { serverHttpBase: props.serverHttpBase, csrfToken: props.csrfToken } : {})}
      connected={props.connected}
      showManagement={owner}
      {...(canAttack ? { onAttack: () => { props.onAttack?.(props.flag.id); } } : {})}
      {...(canBurn ? { onBurn: () => { props.onBurn?.(props.flag.id); } } : {})}
      {...(props.deleting === undefined ? {} : { deleting: props.deleting })}
      onAccessSaved={(next) => {
        setAccess(next);
        (props.onAccessSaved ?? props.onAccessChange)(next);
      }}
      {...(props.onAtlasShrineMutation ? { onAtlasShrineMutation: props.onAtlasShrineMutation } : {})}
      {...(props.onDestroy ? { onDestroy: props.onDestroy } : {})}
      onClose={props.onReturnToGame}
    />;
  }

  // The confirmation replaces the sheet while it is open: the sheet dismisses
  // on any tap outside itself, which would close the flag interaction (and
  // unmount this confirmation) before the confirm tap lands.
  if (repairConfirmation && repairAction.visible) {
    return <GameConfirmationPrompt
      title="Repair this Flag?"
      category="FLAG REPAIR"
      detail="Repair is free and takes time: health returns at 5x the burn rate and any burn pauses while you stay. Damage taken while repairing counts triple, and Bombers can destroy a repairing structure. Moving, travel, death, or disconnect stops the repair and keeps the health restored so far."
      confirmLabel="Repair Flag"
      confirmEnabled={props.connected && repairAction.enabled}
      disabledReason={!props.connected ? "Repairing a Flag requires an online connection." : null}
      onCancel={() => setRepairConfirmation(false)}
      onConfirm={() => {
        setRepairConfirmation(false);
        repairAction.repair();
      }}
    />;
  }

  return <>
  <MobileWorldActionSheet
    displayName={displayName}
    detail={healthLabel}
    presentationState={props.presentationState}
    actionsReady={props.actionsReady ?? true}
    primaryActionLabel={enemyFlag || developerTestTarget ? null : visitAction.label}
    {...(enemyFlag || developerTestTarget ? {} : { primaryActionEnabled: visitAction.enabled })}
    disabledReason={visitAction.disabledReason ?? null}
    actionBusy={visitAction.busy}
    middleActionLabel={middleAction.visible ? middleAction.label : null}
    middleActionEnabled={middleAction.enabled}
    middleActionBusy={middleAction.busy}
    middleDisabledReason={middleAction.disabledReason}
    secondaryActionLabel={owner || (!enemyFlag && !developerTestTarget && props.flag.controlType === "personal" && (canBurn || canAttack)) ? "More" : null}
    secondaryActionEnabled={!busy}
    errorMessage={error ?? middleAction.error}
    onPrimaryAction={act}
    {...(canExplode ? { onMiddleAction: () => setBomberPickerOpen(true) }
      : canAttack && directCombat ? { onMiddleAction: () => props.onAttack?.(props.flag.id) }
      : canBurn && directCombat ? { onMiddleAction: () => {
        props.onBurn?.(props.flag.id);
        props.onClose();
      } }
      : canDisrupt ? {
        onMiddleAction: () => {
          if (props.disrupting) {
            if (props.disruptOperationId) props.onCancelDisrupt?.(props.flag.id, props.disruptOperationId);
          } else if (props.repairOperationId) {
            props.onDisrupt?.(props.flag.id, props.repairOperationId);
          }
        }
      }
      : repairAction.visible ? { onMiddleAction: () => {
        if (props.repairing) repairAction.cancel();
        else setRepairConfirmation(true);
      } }
      : towerOffer && props.onUpgrade ? { onMiddleAction: () => {
        props.onUpgrade?.(props.flag.id, towerOffer.targetTier, towerOffer.targetTowerLevel);
      } }
      : kingdomOffers.length > 0 && props.onUpgrade ? { onMiddleAction: () => {
        if (kingdomOffers.length > 1) {
          setStructurePickerOpen(true);
          return;
        }
        const offer = kingdomOffers[0]!;
        props.onUpgrade?.(props.flag.id, offer.targetTier, offer.targetTowerLevel);
      } }
      : props.onMark && !enemyFlag && !developerTestTarget ? { onMiddleAction: () => {
        props.onMark?.(props.flag.id);
        props.onClose();
      } }
      : hardeningAction.visible ? { onMiddleAction: hardeningAction.harden } : {})}
    {...(owner || (!enemyFlag && !developerTestTarget && props.flag.controlType === "personal" && (canBurn || canAttack)) ? { onSecondaryAction: props.onManage } : {})}
    {...(downgradeTarget ? { extraActions: [{
      key: "kingdom-structure-downgrade",
      tone: "secondary" as const,
      label: downgrading ? "Downgrading…" : KINGDOM_DOWNGRADE_ACTION_LABEL,
      enabled: props.connected && !downgrading && !props.hardeningFlagId,
      busy: downgrading,
      onSelect: () => setDowngradeConfirmation(true)
    }] } : {})}
    onClose={props.onClose}
  />
  {props.repairing && props.repairPausedBurnRemainingMs !== null && props.repairPausedBurnRemainingMs !== undefined ? (
    <p className="flag-panel-repair-status">
      Burn paused · {formatFlagRepairRemaining(props.repairPausedBurnRemainingMs)} remaining
    </p>
  ) : null}
  </>;
}

/** The Kingdom Tower or Obelisk on this flag the viewer may downgrade (level 2+), if any. */
function kingdomStructureDowngradeTarget(
  flag: FlagSnapshot,
  buildKingdomId: string | null
): { kind: "kingdom_tower" | "obelisk"; level: number } | null {
  if (flag.controlType !== "kingdom" || !flag.kingdomId || flag.kingdomId !== buildKingdomId ||
      (flag.warStructureKind ?? null) !== null || flag.developerTestTarget === true) return null;
  const obelisk = flag.obeliskLevel ?? null;
  const tower = flag.towerLevel ?? null;
  const target = obelisk !== null
    ? { kind: "obelisk" as const, level: obelisk }
    : tower !== null ? { kind: "kingdom_tower" as const, level: tower } : null;
  if (!target || target.level < 2 || target.level > kingdomDowngradeStructureMaxLevel(target.kind)) return null;
  return target;
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

export function mobileFlagActionLabel(
  access: FlagAccessSnapshot,
  busy: boolean,
  aggressiveRemainingMs: number
): string {
  return flagVisitActionLabel(access, busy, aggressiveRemainingMs);
}
