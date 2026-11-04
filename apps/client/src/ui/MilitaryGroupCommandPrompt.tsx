import {
  distanceMeters,
  MILITARY_FUSION_RANGE_M,
  MILITARY_MAX_FUSION_SIZE,
  MILITARY_UNIT_ATTACK_DAMAGE,
  MILITARY_UNIT_ATTACK_RANGE_M,
  MILITARY_UNIT_INTERACTION_RADIUS_M,
  STRUCTURE_WARFARE_ATTACK_DAMAGE,
  SIEGE_ATTACK_RANGE_METERS,
  isWithinSiegeAttackRange,
  siegeOrganizationMinimumPlacementMeters,
  militaryGroupDisplayName,
  type CitySnapshot,
  type CombatEntitySnapshot,
  type FlagSnapshot,
  type LatLon,
  type MilitaryUnitGroupSnapshot,
  type MilitaryUnitSnapshot,
  type WarCampSnapshot
} from "@ash-atlas/shared";
import { damagedHealthLabel } from "../combat/healthBarPresentation.js";
import { buildRemainingTimeLabel } from "../flags/flagBuildCountdown.js";
import { useEffect, useMemo, useState } from "react";

import {
  flagInteractionDisplayName,
  isFlagAttackablePresentationTarget,
  isFlagDemolishablePresentationTarget,
  isFlagSiegeTargetPresentationTarget,
  isFlagOrganizationSiegeTargetPresentationTarget,
  structureWarfareStructureLabel,
  type FlagPresentationAllies
} from "../flags/flagDisplay.js";
import {
  GameActionPrompt,
  GameConfirmationPrompt,
  type GamePromptAction
} from "./GameActionPrompt.js";
import { GameTargetPicker, type GameTargetChoice } from "./GameTargetPicker.js";

export type MilitaryGroupTargetAction = "attack" | "demolish" | "ballista" | "merge";

export type MilitaryGroupCommandPromptProps = Readonly<{
  group: MilitaryUnitGroupSnapshot;
  city: CitySnapshot | null;
  warCamp: WarCampSnapshot | null;
  units: readonly MilitaryUnitSnapshot[];
  playerPosition: LatLon | null;
  ownPlayerId: string | null;
  online?: boolean;
  busy?: boolean;
  now?: number;
  combatTargets?: readonly CombatEntitySnapshot[];
  flagTargets?: readonly FlagSnapshot[];
  /** The viewer's own city / kingdom, excluded from Siege and Bomber targets. */
  warfareAllies?: FlagPresentationAllies;
  /** Structures with an active repair: valid Bomber targets even while their burn is paused. */
  repairingFlagIds?: ReadonlySet<string>;
  mergeCandidates?: readonly MilitaryUnitGroupSnapshot[];
  onFollow?(groupId: string): void;
  onMoveToMe?(groupId: string, position: LatLon): void;
  onStay?(groupId: string): void;
  onPackUp?(groupId: string): void;
  onDeploy?(groupId: string): void;
  onDeployPreview?(groupId: string, flagIds: readonly string[]): void;
  onDefend?(groupId: string): void;
  onReturn?(groupId: string): void;
  onStop?(groupId: string): void;
  onAttack?(groupId: string, targetEntityId: string): void;
  onAttackSiege?(groupId: string): void;
  onDemolish?(groupId: string, targetFlagId: string): void;
  onSetBallistaTarget?(groupId: string, targetFlagId: string): void;
  onMerge?(groupId: string, adjacentGroupId: string): void;
  onCancel(): void;
}>;

const DEPLOYED_STATES = new Set<MilitaryUnitGroupSnapshot["locationState"]>([
  "FOLLOWING_PLAYER",
  "DEPLOYED_FIELD"
]);

function militaryUnitLabel(unitType: MilitaryUnitGroupSnapshot["unitType"]): string {
  return unitType === "field_ballista"
    ? "Siege"
    : unitType.replaceAll("_", " ").replace(/(^| )\w/g, (letter) => letter.toUpperCase());
}

function finiteAnchor(
  group: MilitaryUnitGroupSnapshot,
  city: CitySnapshot | null,
  warCamp: WarCampSnapshot | null
): LatLon | null {
  if (group.lat !== null && group.lon !== null && Number.isFinite(group.lat) && Number.isFinite(group.lon)) {
    return { lat: group.lat, lon: group.lon };
  }
  if (warCamp && group.warCampId === warCamp.campId) {
    return { lat: warCamp.lat, lon: warCamp.lon };
  }
  if (city && group.stationCityId === city.id) {
    return { lat: city.lat, lon: city.lon };
  }
  return null;
}

function targetName(target: CombatEntitySnapshot): string {
  return target.kind === "player" ? target.name : `${target.name} · Lv ${target.level}`;
}

function targetCategory(target: CombatEntitySnapshot): string {
  if (target.kind === "player") return "PLAYER";
  if (target.npcFaction?.culture === "goblin") return "GOBLIN DEFENDER";
  return "COMBAT TARGET";
}

function siegeNextVolleyStatus(
  group: MilitaryUnitGroupSnapshot,
  now: number,
  hasKnownTarget: boolean
): string | null {
  if (group.unitType !== "field_ballista" || group.locationState !== "DEPLOYED_FIELD") {
    return null;
  }

  const nextFireAtMs = group.nextFireAt ? Date.parse(group.nextFireAt) : NaN;
  if (!Number.isFinite(nextFireAtMs)) {
    return hasKnownTarget ? "Next volley · Arming…" : "Next volley · Waiting";
  }
  if (!Number.isFinite(now)) return "Next volley · Waiting";

  const remainingSeconds = Math.ceil(Math.max(0, nextFireAtMs - now) / 1_000);
  return remainingSeconds > 0
    ? `Next volley · ${remainingSeconds}s`
    : "Next volley · Finalizing…";
}

export function MilitaryGroupCommandPrompt({
  group,
  city,
  warCamp,
  units,
  playerPosition,
  ownPlayerId,
  online = true,
  busy = false,
  now = Date.now(),
  combatTargets = [],
  flagTargets = [],
  warfareAllies,
  repairingFlagIds,
  mergeCandidates = [],
  onFollow,
  onMoveToMe,
  onStay,
  onPackUp,
  onDeploy,
  onDeployPreview,
  onDefend,
  onStop,
  onAttack,
  onAttackSiege,
  onDemolish,
  onSetBallistaTarget,
  onMerge,
  onCancel
}: MilitaryGroupCommandPromptProps): React.JSX.Element {
  const [targetAction, setTargetAction] = useState<MilitaryGroupTargetAction | null>(null);
  const [deployConfirmationOpen, setDeployConfirmationOpen] = useState(false);
  useEffect(() => {
    setTargetAction(null);
    setDeployConfirmationOpen(false);
    onDeployPreview?.(group.groupId, []);
  }, [
    group.groupId,
    group.revision,
    group.locationState,
    group.lat,
    group.lon,
    onDeployPreview
  ]);
  useEffect(() => () => {
    onDeployPreview?.(group.groupId, []);
  }, [group.groupId, onDeployPreview]);

  const groupUnits = useMemo(
    () => units.filter((unit) => group.memberUnitIds.includes(unit.unitId)),
    [group.memberUnitIds, units]
  );
  const survivingMembers = groupUnits.filter((unit) =>
    unit.unitType === group.unitType && unit.status === "available" && unit.currentHp > 0
  );
  const groupAnchor = finiteAnchor(group, city, warCamp);
  const isSiege = group.unitType === "field_ballista";
  const isBomber = group.unitType === "bomber";
  const groupDisplayName = isSiege || isBomber
    ? militaryGroupDisplayName(
      group.unitType,
      survivingMembers.length > 0 ? survivingMembers.length : group.memberCount
    )
    : null;
  const groupAriaName = groupDisplayName ?? `${militaryUnitLabel(group.unitType)} group`;
  const missingMember = group.memberUnitIds.some((unitId) =>
    !units.some((unit) => unit.unitId === unitId)
  );
  const eligibleMergeCandidates = useMemo(
    () => mergeCandidates
      .filter((candidate) => {
        if (
          candidate.groupId === group.groupId ||
          candidate.ownerPlayerId !== group.ownerPlayerId ||
          candidate.unitType !== group.unitType
        ) return false;
        if (
          candidate.locationState !== group.locationState ||
          candidate.locationState === "PACKING_UP" ||
          candidate.locationState === "RECOVERING" ||
          candidate.movementOrder === "MOVE_TO_COORDINATE"
        ) return false;
        if (
          candidate.memberCount < 1 ||
          group.memberCount + candidate.memberCount > MILITARY_MAX_FUSION_SIZE
        ) return false;
        if (candidate.stationCityId !== group.stationCityId || candidate.warCampId !== group.warCampId) return false;
        const candidateAnchor = finiteAnchor(candidate, city, warCamp);
        return Boolean(
          groupAnchor && candidateAnchor &&
          distanceMeters(groupAnchor, candidateAnchor) <= MILITARY_FUSION_RANGE_M
        );
      })
      .sort((left, right) => left.groupId.localeCompare(right.groupId)),
    [
      city,
      group.groupId,
      group.locationState,
      group.memberCount,
      group.ownerPlayerId,
      group.stationCityId,
      group.unitType,
      group.warCampId,
      groupAnchor,
      mergeCandidates,
      warCamp
    ]
  );

  const commandDisabledReason = ownPlayerId !== null && group.ownerPlayerId !== ownPlayerId
    ? "This military group belongs to another player."
    : !online
      ? "Military commands are unavailable while disconnected."
      : busy
        ? "Another military command is in progress."
        : missingMember
          ? "Military member data is still loading. Refresh the City records."
          : survivingMembers.length === 0
            ? "A recovering or destroyed member cannot be commanded."
            : !playerPosition
              ? "Your world position is unavailable."
              : !groupAnchor
                ? "This group's military anchor is unavailable. Refresh the City records."
                : null;

  const stateCanDeploy = DEPLOYED_STATES.has(group.locationState);
  const targetOrigin = groupAnchor ?? playerPosition;
  const combatChoices = useMemo<GameTargetChoice[]>(() => {
    if (!targetOrigin || group.unitType === "field_ballista") return [];
    const rangeM = MILITARY_UNIT_ATTACK_RANGE_M[group.unitType];
    return combatTargets
      .filter((target) =>
        target.entityId !== ownPlayerId &&
        target.lifeState === "alive" &&
        !target.companion &&
        !(target.npcFaction?.culture === "goblin" && target.npcFaction.relation === "neutral") &&
        !(target.archetypeKey === "xoral" && target.bossEventState === "dormant") &&
        distanceMeters(targetOrigin, target) <= rangeM
      )
      .map((target) => ({
        key: target.entityId,
        name: targetName(target),
        category: targetCategory(target),
        meta: `${Math.round(distanceMeters(targetOrigin, target))} m · ${target.currentHealth}/${target.maxHealth} HP`
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [combatTargets, group.unitType, ownPlayerId, targetOrigin]);
  const structureTargetOrigin = groupAnchor ?? playerPosition;
  const structureTargetRangeM = targetAction === "ballista"
    ? SIEGE_ATTACK_RANGE_METERS
    : MILITARY_UNIT_INTERACTION_RADIUS_M;
  const flagChoices = useMemo<GameTargetChoice[]>(() => {
    if (!structureTargetOrigin || ownPlayerId === null) return [];
    return flagTargets
      .filter((flag) =>
        (targetAction === "demolish"
          ? isFlagDemolishablePresentationTarget(flag, ownPlayerId, warfareAllies, repairingFlagIds?.has(flag.id) === true)
          : targetAction === "ballista"
            ? isFlagSiegeTargetPresentationTarget(flag, ownPlayerId) ||
              (isFlagOrganizationSiegeTargetPresentationTarget(flag, ownPlayerId, warfareAllies) &&
                // City and kingdom structures take one single-target volley
                // from at least the fusion level's minimum placement.
                distanceMeters(structureTargetOrigin, flag) >=
                  siegeOrganizationMinimumPlacementMeters(Math.max(1, group.memberCount)))
            : isFlagAttackablePresentationTarget(flag, ownPlayerId, warfareAllies)) &&
        (targetAction === "ballista"
          ? isWithinSiegeAttackRange(distanceMeters(structureTargetOrigin, flag))
          : distanceMeters(structureTargetOrigin, flag) <= structureTargetRangeM)
      )
      .map((flag) => {
        const healthLabel = damagedHealthLabel(flag.health, flag.maximumHealth);
        return {
          key: flag.id,
          name: flag.controlType === "personal"
            ? flagInteractionDisplayName(flag)
            : `${flagInteractionDisplayName(flag)} · ${structureWarfareStructureLabel(flag)}`,
          category: "STRUCTURE",
          meta: `${Math.round(distanceMeters(structureTargetOrigin, flag))} m` +
            (healthLabel ? ` · ${healthLabel} durability` : "")
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [flagTargets, group.memberCount, ownPlayerId, repairingFlagIds, structureTargetOrigin, structureTargetRangeM, targetAction, warfareAllies]);
  const bomberTargetChoices = useMemo(
    () => targetAction === null && structureTargetOrigin && ownPlayerId !== null
      ? flagTargets.filter((flag) =>
          isFlagDemolishablePresentationTarget(flag, ownPlayerId, warfareAllies, repairingFlagIds?.has(flag.id) === true) &&
          distanceMeters(structureTargetOrigin, flag) <= MILITARY_UNIT_INTERACTION_RADIUS_M
        )
      : [],
    [flagTargets, ownPlayerId, repairingFlagIds, structureTargetOrigin, targetAction, warfareAllies]
  );

  const siegePreviewFlags = useMemo(
    () => group.unitType === "field_ballista" && groupAnchor && ownPlayerId !== null
      ? flagTargets
          .filter((flag) =>
            isFlagSiegeTargetPresentationTarget(flag, ownPlayerId) &&
            isWithinSiegeAttackRange(distanceMeters(groupAnchor, flag))
          )
          .sort((left, right) =>
            flagInteractionDisplayName(left).localeCompare(flagInteractionDisplayName(right)) ||
            left.id.localeCompare(right.id)
          )
      : [],
    [flagTargets, group.unitType, groupAnchor, ownPlayerId]
  );
  const nextVolleyStatus = siegeNextVolleyStatus(
    group,
    now,
    group.targetFlagId !== null || siegePreviewFlags.length > 0
  );
  useEffect(() => {
    if (!deployConfirmationOpen || group.unitType !== "field_ballista") return;
    onDeployPreview?.(
      group.groupId,
      siegePreviewFlags.map((flag) => flag.id)
    );
  }, [deployConfirmationOpen, group.groupId, group.unitType, onDeployPreview, siegePreviewFlags]);

  const targetChoices = targetAction === "attack" ? combatChoices : flagChoices;
  const mergeChoices = useMemo<GameTargetChoice[]>(
    () => eligibleMergeCandidates.map((candidate) => {
      const count = candidate.memberCount;
      const candidateAnchor = finiteAnchor(candidate, city, warCamp);
      const distance = groupAnchor && candidateAnchor
        ? Math.round(distanceMeters(groupAnchor, candidateAnchor))
        : null;
      return {
        key: candidate.groupId,
        name: militaryGroupDisplayName(candidate.unitType, count),
        category: "MERGE SOURCE",
        meta: `${distance ?? "?"} m · +${count} fusion level${count === 1 ? "" : "s"}`
      };
    }),
    [city, eligibleMergeCandidates, groupAnchor, warCamp]
  );
  const resolvedTargetChoices = targetAction === "merge" ? mergeChoices : targetChoices;
  const targetTitle = targetAction === "attack"
    ? "Choose Combat Target"
    : targetAction === "merge"
      ? "Choose Merge Source"
      : "Choose Structure Target";
  const targetDetail = targetAction === "attack"
    ? `${groupDisplayName ?? `One ${militaryUnitLabel(group.unitType)} group`} attack · ${MILITARY_UNIT_ATTACK_DAMAGE[group.unitType]} damage per surviving member · ${MILITARY_UNIT_ATTACK_RANGE_M[group.unitType]} m range.`
    : targetAction === "demolish"
      ? `${groupDisplayName ?? "The Bomber group"} moves to an eligible enemy Flag before its 5-second channel.`
      : targetAction === "merge"
        ? `Absorb a compatible owned group within ${MILITARY_FUSION_RANGE_M} meters.`
      : `Siege volleys damage eligible hostile Flag fortifications · ${SIEGE_ATTACK_RANGE_METERS} m range.`;

  const actionDisabledReason = (specificReason: string | null, callback: unknown): string | null =>
    commandDisabledReason ?? specificReason ?? (callback ? null : "This command is unavailable right now.");
  const issue = (callback: (() => void) | undefined): void => {
    if (!callback) return;
    callback();
    onCancel();
  };

  const siegeDeployDisabledReason = group.unitType === "field_ballista"
    ? actionDisabledReason(
        ["PACKED_FIELD", "FOLLOWING_PLAYER"].includes(group.locationState)
          ? null
          : "Pack or follow the Siege before deploying it.",
        onDeploy
      )
      : null;
  const hostileSiege = isSiege && ownPlayerId !== null && group.ownerPlayerId !== ownPlayerId;
  const hostileSiegeDisabledReason = !online
    ? "Military commands are unavailable while disconnected."
    : busy
      ? "Another military command is in progress."
      : !playerPosition
        ? "Your world position is unavailable."
        : !groupAnchor
          ? "This Siege's military anchor is unavailable. Refresh the City records."
          : group.locationState !== "DEPLOYED_FIELD" && group.locationState !== "FOLLOWING_PLAYER"
            ? "Only a deployed hostile Siege can be attacked."
            : group.movementOrder === "MOVE_TO_COORDINATE"
              ? "A Siege moving to a planned point cannot be attacked."
              : group.currentHp <= 0
                ? "This hostile Siege has no surviving members."
                : distanceMeters(playerPosition, groupAnchor) > MILITARY_UNIT_INTERACTION_RADIUS_M
                  ? `Move within ${MILITARY_UNIT_INTERACTION_RADIUS_M}m of the hostile Siege before attacking it.`
                  : onAttackSiege
                    ? null
                    : "This command is unavailable right now.";
  useEffect(() => {
    if (!deployConfirmationOpen || siegeDeployDisabledReason === null) return;
    setDeployConfirmationOpen(false);
    onDeployPreview?.(group.groupId, []);
  }, [
    deployConfirmationOpen,
    group.groupId,
    onDeployPreview,
    siegeDeployDisabledReason
  ]);

  if (hostileSiege) {
    return <GameActionPrompt
      title={`${groupDisplayName} · ${group.currentHp}/${group.maxHp} HP`}
      category="HOSTILE SIEGE"
      detail={`Attack the hostile Siege within ${MILITARY_UNIT_INTERACTION_RADIUS_M}m. Each hit deals ${STRUCTURE_WARFARE_ATTACK_DAMAGE} damage to one surviving member.`}
      actionLayout="military-main-merge"
      actions={[{
        key: "attack-hostile-siege",
        label: "Attack",
        enabled: hostileSiegeDisabledReason === null,
        ...(hostileSiegeDisabledReason ? { disabledReason: hostileSiegeDisabledReason } : {}),
        onSelect: () => issue(() => onAttackSiege?.(group.groupId))
      }]}
      onCancel={onCancel}
    />;
  }

  if (group.unitType === "field_ballista" && group.locationState === "PACKING_UP") {
    const packingDeadlineMs = group.packingCompletesAt
      ? Date.parse(group.packingCompletesAt)
      : NaN;
    const remainingMs = Number.isFinite(packingDeadlineMs)
      ? Math.max(0, packingDeadlineMs - now)
      : 0;
    const packingMessage = remainingMs > 0
      ? `Packing up · ${buildRemainingTimeLabel(remainingMs)} remaining.`
      : "Finalizing…";
    return <GameActionPrompt
      title={`${groupDisplayName} · ${group.currentHp}/${group.maxHp} HP`}
      category={null}
      detail={null}
      message={{ text: packingMessage, tone: "muted" }}
      actionLayout="military-main-merge"
      actions={[{
        key: "merge",
        label: "Merge",
        enabled: false,
        disabledReason: "A military operation is already in progress.",
        onSelect: () => undefined
      }]}
      onCancel={onCancel}
    />;
  }

  if (deployConfirmationOpen) {
    const previewNames = siegePreviewFlags
      .slice(0, 3)
      .map((flag) => flagInteractionDisplayName(flag))
      .join(", ");
    const additionalCount = siegePreviewFlags.length - 3;
    const targetSummary = siegePreviewFlags.length === 0
      ? `No currently known eligible hostile structures are within ${SIEGE_ATTACK_RANGE_METERS}m.`
      : `${siegePreviewFlags.length} eligible structure${siegePreviewFlags.length === 1 ? "" : "s"} within ${SIEGE_ATTACK_RANGE_METERS}m: ${previewNames}${additionalCount > 0 ? `, +${additionalCount} more` : ""}.`;
    return <GameConfirmationPrompt
      title="Deploy Siege?"
      category="SIEGE DEPLOY PREVIEW"
      detail={`${targetSummary} The server will re-check target eligibility when each volley resolves.`}
      confirmLabel="Confirm Deploy"
      cancelLabel="Cancel"
      confirmEnabled={siegeDeployDisabledReason === null && !busy}
      busy={busy}
      disabledReason={siegeDeployDisabledReason}
      onConfirm={() => {
        onDeployPreview?.(group.groupId, []);
        setDeployConfirmationOpen(false);
        issue(() => onDeploy?.(group.groupId));
      }}
      onCancel={() => {
        setDeployConfirmationOpen(false);
        onDeployPreview?.(group.groupId, []);
      }}
    />;
  }

  if (targetAction) {
    if (resolvedTargetChoices.length === 0) {
      return <GameActionPrompt
        title={targetTitle}
        category="TARGETING"
        detail={targetDetail}
        actions={[]}
        cancelLabel="Back"
        onCancel={() => setTargetAction(null)}
      />;
    }
    return <GameTargetPicker
      ariaLabel={`${targetTitle} for ${groupAriaName}`}
      title={targetTitle}
      choices={resolvedTargetChoices}
      onSelect={(key) => {
        if (targetAction === "attack") onAttack?.(group.groupId, key);
        else if (targetAction === "demolish") onDemolish?.(group.groupId, key);
        else if (targetAction === "merge") onMerge?.(group.groupId, key);
        else onSetBallistaTarget?.(group.groupId, key);
        onCancel();
      }}
      onQuickAction={() => undefined}
      onCancel={() => setTargetAction(null)}
    />;
  }

  const actions: GamePromptAction[] = [];
  const moveToMe = onMoveToMe
    ? () => {
      if (playerPosition) onMoveToMe(group.groupId, playerPosition);
    }
    : onFollow
      ? () => onFollow(group.groupId)
      : undefined;
  const moveToMeReason = ["PACKED_FIELD", "FOLLOWING_PLAYER", "DEPLOYED_FIELD"].includes(group.locationState)
    ? null
    : "Move to Me is available once the group enters the field.";
  if (isSiege || isBomber) {
    const moveReason = actionDisabledReason(moveToMeReason, moveToMe);
    actions.push({
      key: "move-to-me",
      label: "Move to Me",
      enabled: moveReason === null,
      ...(moveReason ? { disabledReason: moveReason } : {}),
      onSelect: () => issue(moveToMe)
    });
    const following = group.locationState === "FOLLOWING_PLAYER";
    const stayCallback = isSiege ? onStay : onDeploy;
    const followOrStayReason = actionDisabledReason(null, following ? stayCallback : onFollow);
    actions.push({
      key: following ? "stay" : "follow",
      label: following ? "Stay" : "Follow",
      enabled: followOrStayReason === null,
      ...(followOrStayReason ? { disabledReason: followOrStayReason } : {}),
      onSelect: () => issue(() => {
        if (following) stayCallback?.(group.groupId);
        else onFollow?.(group.groupId);
      })
    });
  } else if (group.locationState !== "FOLLOWING_PLAYER") {
    const reason = actionDisabledReason(null, onFollow);
    actions.push({
      key: "follow",
      label: "Follow",
      enabled: reason === null,
      ...(reason ? { disabledReason: reason } : {}),
      onSelect: () => issue(() => onFollow?.(group.groupId))
    });
  }
  if (
    !isSiege && !isBomber &&
    ["PACKED_FIELD", "FOLLOWING_PLAYER", "DEPLOYED_FIELD"].includes(group.locationState)
  ) {
    const reason = actionDisabledReason(null, moveToMe);
    actions.unshift({
      key: "move-to-me",
      label: "Move to Me",
      enabled: reason === null,
      ...(reason ? { disabledReason: reason } : {}),
      onSelect: () => issue(moveToMe)
    });
  }
  if (isSiege && ["PACKED_FIELD", "FOLLOWING_PLAYER"].includes(group.locationState)) {
    const reason = siegeDeployDisabledReason;
    actions.push({
      key: "deploy",
      label: "Deploy",
      enabled: reason === null,
      ...(reason ? { disabledReason: reason } : {}),
      onSelect: () => setDeployConfirmationOpen(true)
    });
  } else if (isSiege && group.locationState === "DEPLOYED_FIELD") {
    const reason = actionDisabledReason(null, onPackUp);
    actions.push({
      key: "pack-up",
      label: "Pack Up",
      enabled: reason === null,
      ...(reason ? { disabledReason: reason } : {}),
      onSelect: () => issue(() => onPackUp?.(group.groupId))
    });
  } else if (!isSiege && !isBomber && group.locationState === "FOLLOWING_PLAYER") {
    const reason = actionDisabledReason(null, onDeploy);
    actions.push({
      key: "defend-stop",
      label: "Defend / Stop",
      enabled: reason === null,
      ...(reason ? { disabledReason: reason } : {}),
      onSelect: () => issue(() => onDeploy?.(group.groupId))
    });
  }
  if (!isSiege && !isBomber && group.locationState === "DEPLOYED_FIELD") {
    const reason = actionDisabledReason(null, onDefend);
    actions.push({
      key: "defend-stop",
      label: "Defend / Stop",
      enabled: reason === null,
      ...(reason ? { disabledReason: reason } : {}),
      onSelect: () => issue(() => onDefend?.(group.groupId))
    });
  }
  if (!isSiege && !isBomber && group.locationState !== "STATIONED_CITY" && group.locationState !== "RECOVERING") {
    const reason = actionDisabledReason(null, onStop);
    actions.push({
      key: "stop",
      label: "Stop at City",
      enabled: reason === null,
      ...(reason ? { disabledReason: reason } : {}),
      onSelect: () => issue(() => onStop?.(group.groupId))
    });
  }
  if (group.unitType !== "field_ballista" && !isBomber) {
    const reason = actionDisabledReason(
      stateCanDeploy ? null : "Follow or deploy the group before attacking.",
      onAttack
    );
    actions.push({
      key: "attack",
      label: "Attack",
      enabled: reason === null,
      ...(reason ? { disabledReason: reason } : {}),
      onSelect: () => setTargetAction("attack")
    });
  }
  if (group.unitType === "bomber") {
    const reason = actionDisabledReason(
      !stateCanDeploy
        ? "Follow or deploy the Bombers before planting a Bomb."
        : bomberTargetChoices.length === 0
          ? "No eligible enemy Flag is within Bomber charge range."
          : null,
      onDemolish
    );
    actions.push({
      key: "demolish-target",
      label: "Plant Bomb",
      enabled: reason === null,
      ...(reason ? { disabledReason: reason } : {}),
      onSelect: () => setTargetAction("demolish")
    });
  }
  if (isSiege || isBomber) {
    const mergeReason = actionDisabledReason(
      group.memberCount >= MILITARY_MAX_FUSION_SIZE
        ? `This group is already at the +${MILITARY_MAX_FUSION_SIZE} fusion cap.`
        : group.movementOrder === "MOVE_TO_COORDINATE"
          ? "A group moving to a planned point cannot be fused."
        : eligibleMergeCandidates.length === 0
          ? `No compatible owned ${militaryUnitLabel(group.unitType)} group is within ${MILITARY_FUSION_RANGE_M} meters.`
          : null,
      onMerge
    );
    actions.push({
      key: "merge",
      label: "Merge",
      enabled: mergeReason === null,
      ...(mergeReason ? { disabledReason: mergeReason } : {}),
      onSelect: () => setTargetAction("merge")
    });
  }

  return <GameActionPrompt
    title={isSiege || isBomber
      ? `${groupDisplayName} · ${group.currentHp}/${group.maxHp} HP`
      : `${group.memberCount} ${militaryUnitLabel(group.unitType)} group`}
    category={isSiege || isBomber ? null : "MILITARY GROUP"}
    detail={isSiege || isBomber
      ? null
      : `${survivingMembers.length} surviving · ${group.currentHp}/${group.maxHp} HP`}
    message={group.targetFlagId ? { text: "A structure target is currently assigned.", tone: "muted" } : null}
    content={nextVolleyStatus ? <p className="game-compact-message muted" role="status" aria-live="polite">
      {nextVolleyStatus}
    </p> : null}
    actionLayout={isSiege || isBomber ? "military-main-merge" : "stacked"}
    actions={busy ? actions.map((action) => ({ ...action, busy: true })) : actions}
    onCancel={onCancel}
  />;
}
