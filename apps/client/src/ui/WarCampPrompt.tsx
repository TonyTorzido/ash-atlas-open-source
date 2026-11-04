import {
  WAR_CAMP_BURN_THRESHOLD,
  distanceMeters,
  type MilitaryUnitGroupSnapshot,
  type MilitaryUnitSnapshot,
  type WarCampAttackMode,
  type WarCampSnapshot
} from "@ash-atlas/shared";

import { buildRemainingTimeLabel } from "../flags/flagBuildCountdown.js";
import { GameActionPrompt, type GamePromptAction } from "./GameActionPrompt.js";

/** The nearest own group that can strike the camp in `mode`, if any. */
export function warCampStrikeGroup(
  camp: Pick<WarCampSnapshot, "lat" | "lon">,
  mode: Exclude<WarCampAttackMode, "hand">,
  groups: readonly MilitaryUnitGroupSnapshot[],
  units: readonly MilitaryUnitSnapshot[],
  playerId: string | null
): MilitaryUnitGroupSnapshot | null {
  const unitType = mode === "bomber" ? "bomber" : "field_ballista";
  const states = mode === "bomber" ? ["FOLLOWING_PLAYER", "DEPLOYED_FIELD"] : ["DEPLOYED_FIELD"];
  const candidates = groups.filter((group) =>
    group.ownerPlayerId === playerId && group.unitType === unitType && states.includes(group.locationState) &&
    group.lat !== null && group.lon !== null &&
    units.some((unit) => group.memberUnitIds.includes(unit.unitId) && unit.status === "available" && unit.currentHp > 0)
  );
  return candidates.sort((left, right) =>
    distanceMeters(camp, { lat: left.lat!, lon: left.lon! }) - distanceMeters(camp, { lat: right.lat!, lon: right.lon! })
  )[0] ?? null;
}

/**
 * Another player's War Camp: health and burn state, with Attack (by hand),
 * Bomb (nearest ready Bomber group) and Siege (nearest deployed Siege). The
 * server checks range, cooldowns, allies and the burn threshold.
 */
export function WarCampPrompt({
  camp,
  groups,
  units,
  playerId,
  busy,
  connected,
  compact,
  nowMs,
  onStrike,
  onCancel
}: Readonly<{
  camp: WarCampSnapshot;
  groups: readonly MilitaryUnitGroupSnapshot[];
  units: readonly MilitaryUnitSnapshot[];
  playerId: string | null;
  busy: boolean;
  connected: boolean;
  /** Phone bottom sheet presentation. */
  compact: boolean;
  nowMs: number;
  onStrike(mode: WarCampAttackMode, groupId?: string): void;
  onCancel(): void;
}>): React.JSX.Element {
  const burningUntilMs = camp.burningUntil ? Date.parse(camp.burningUntil) : Number.NaN;
  const burning = Number.isFinite(burningUntilMs) && burningUntilMs > nowMs;
  const maximum = camp.maximumHealth ?? 2_000;
  const health = camp.health ?? maximum;
  const detail = burning
    ? `Burning · ${buildRemainingTimeLabel(burningUntilMs - nowMs)}`
    : `${health.toLocaleString("en-US")} / ${maximum.toLocaleString("en-US")} HP`;
  const blocked = !connected
    ? "Unavailable while disconnected."
    : busy ? "Another military command is in progress."
      : burning || health <= WAR_CAMP_BURN_THRESHOLD ? "This War Camp is already burning." : null;
  const bomber = warCampStrikeGroup(camp, "bomber", groups, units, playerId);
  const siege = warCampStrikeGroup(camp, "siege", groups, units, playerId);
  const actions: GamePromptAction[] = [
    {
      key: "attack",
      label: "Attack",
      tone: "primary",
      enabled: blocked === null,
      disabledReason: blocked,
      onSelect: () => onStrike("hand")
    },
    {
      key: "bomb",
      label: "Bomb",
      enabled: blocked === null && bomber !== null,
      disabledReason: blocked ?? (bomber ? null : "No ready Bomber group."),
      onSelect: () => { if (bomber) onStrike("bomber", bomber.groupId); }
    },
    {
      key: "siege",
      label: "Siege",
      enabled: blocked === null && siege !== null,
      disabledReason: blocked ?? (siege ? null : "No deployed Siege group."),
      onSelect: () => { if (siege) onStrike("siege", siege.groupId); }
    }
  ];
  return (
    <GameActionPrompt
      title={camp.ownerName ? `${camp.ownerName}'s War Camp` : "War Camp"}
      category="War Camp"
      ariaLabel="Enemy War Camp"
      detail={detail}
      actions={actions}
      onCancel={onCancel}
      dismissOnOutsideClick
      compact={compact}
    />
  );
}
