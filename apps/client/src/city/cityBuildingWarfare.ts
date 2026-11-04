import {
  MILITARY_UNIT_INTERACTION_RADIUS_M,
  STRUCTURE_WARFARE_INTERACTION_RADIUS_M,
  cityBuildingHealthFromSnapshot,
  distanceMeters,
  isWithinSiegeAttackRange,
  siegeOrganizationMinimumPlacementMeters,
  type CityStructureSnapshot,
  type MilitaryUnitGroupSnapshot
} from "@ash-atlas/shared";

import type { GamePromptAction } from "../ui/GameActionPrompt.js";

/*
 * City building warfare presentation (war part C3): health and burn status
 * for building prompts and map markers, plus the Attack / Repair / Bomb
 * actions. The server decides every outcome; these helpers only gate the
 * buttons with the same rules so the prompt does not offer dead actions.
 */

export type CityBuildingWarfareView = Readonly<{
  health: number;
  maximumHealth: number;
  ratio: number;
  damaged: boolean;
  burning: boolean;
  repairing: boolean;
  atThreshold: boolean;
}>;

export function cityBuildingWarfareView(
  structure: Pick<CityStructureSnapshot, "warfare" | "state">,
  nowMs: number
): CityBuildingWarfareView | null {
  const warfare = structure.warfare;
  if (!warfare || structure.state !== "active") return null;
  const health = cityBuildingHealthFromSnapshot(warfare, nowMs);
  return {
    health,
    maximumHealth: warfare.maximumHealth,
    ratio: warfare.maximumHealth > 0 ? Math.max(0, Math.min(1, health / warfare.maximumHealth)) : 0,
    damaged: health < warfare.maximumHealth || warfare.burning,
    burning: warfare.burning,
    repairing: warfare.repairing,
    atThreshold: health <= warfare.burnThreshold
  };
}

/** Prompt detail line, for example "12,400 / 20,000 HP · Burning"; null at full health. */
export function cityBuildingWarfareDetail(
  structure: Pick<CityStructureSnapshot, "warfare" | "state">,
  nowMs: number
): string | null {
  const view = cityBuildingWarfareView(structure, nowMs);
  if (!view || !view.damaged) return null;
  const status = view.repairing ? " · Repairing" : view.burning ? " · Burning" : "";
  return `${view.health.toLocaleString("en-US")} / ${view.maximumHealth.toLocaleString("en-US")} HP${status}`;
}

export function eligibleCityBuildingBomberGroup(
  groups: readonly MilitaryUnitGroupSnapshot[] | undefined,
  playerId: string,
  structure: Pick<CityStructureSnapshot, "lat" | "lon">
): MilitaryUnitGroupSnapshot | null {
  const eligible = (groups ?? []).filter((group) =>
    group.ownerPlayerId === playerId &&
    group.unitType === "bomber" &&
    group.memberCount > 0 &&
    group.packingCompletesAt === null &&
    (group.locationState === "FOLLOWING_PLAYER" || group.locationState === "DEPLOYED_FIELD")
  );
  const distance = (group: MilitaryUnitGroupSnapshot): number =>
    group.lat === null || group.lon === null
      ? Number.POSITIVE_INFINITY
      : distanceMeters({ lat: group.lat, lon: group.lon }, structure);
  return eligible.sort((left, right) => distance(left) - distance(right))[0] ?? null;
}

/** A deployed Siege of the viewer that can fire at the building from where it stands. */
export function eligibleCityBuildingSiegeGroup(
  groups: readonly MilitaryUnitGroupSnapshot[] | undefined,
  playerId: string,
  structure: Pick<CityStructureSnapshot, "lat" | "lon">
): MilitaryUnitGroupSnapshot | null {
  return (groups ?? []).find((group) => {
    if (
      group.ownerPlayerId !== playerId || group.unitType !== "field_ballista" || group.memberCount < 1 ||
      group.locationState !== "DEPLOYED_FIELD" || group.movementOrder === "MOVE_TO_COORDINATE" ||
      group.lat === null || group.lon === null
    ) return false;
    const distance = distanceMeters({ lat: group.lat, lon: group.lon }, structure);
    return isWithinSiegeAttackRange(distance) &&
      distance >= siegeOrganizationMinimumPlacementMeters(group.memberCount);
  }) ?? null;
}

export function cityBuildingWarfareActions(input: Readonly<{
  structure: CityStructureSnapshot;
  nowMs: number;
  playerId: string;
  playerCityId: string | null;
  player: Readonly<{ lat: number; lon: number }> | null;
  connected: boolean;
  bomberGroups?: readonly MilitaryUnitGroupSnapshot[];
  onAttack(structureId: string): void;
  onRepair(structureId: string): void;
  onStopRepair(): void;
  onBomb(groupId: string, structureId: string): void;
  onSiege(groupId: string, structureId: string): void;
}>): GamePromptAction[] {
  const { structure } = input;
  const view = cityBuildingWarfareView(structure, input.nowMs);
  if (!view || structure.cityControllerKind === "npc") return [];
  const disconnected = input.connected ? null : "Unavailable while disconnected.";
  const near = input.player !== null &&
    distanceMeters(input.player, structure) <= STRUCTURE_WARFARE_INTERACTION_RADIUS_M + structure.footprintRadiusM;
  if (input.playerCityId === structure.cityId) {
    if (structure.warfare?.repairPlayerId === input.playerId) {
      return [{
        key: "stop-building-repair",
        label: "Stop Repair",
        tone: "secondary",
        enabled: disconnected === null,
        disabledReason: disconnected,
        onSelect: input.onStopRepair
      }];
    }
    if (!view.damaged) return [];
    const reason = disconnected ??
      (view.repairing ? "Another city member is repairing this building." : null) ??
      (near ? null : "Move next to the building to repair it.");
    return [{
      key: "repair-building",
      label: "Repair",
      tone: "secondary",
      enabled: reason === null,
      disabledReason: reason,
      onSelect: () => input.onRepair(structure.structureId)
    }];
  }
  const attackReason = disconnected ??
    (view.burning ? "This building is burning." : null) ??
    (view.atThreshold ? "This building is ready to burn." : null) ??
    (near ? null : "Move next to the building to attack it.");
  const actions: GamePromptAction[] = [{
    key: "attack-building",
    label: "Attack",
    tone: "danger",
    enabled: attackReason === null,
    disabledReason: attackReason,
    onSelect: () => input.onAttack(structure.structureId)
  }];
  const siege = eligibleCityBuildingSiegeGroup(input.bomberGroups, input.playerId, structure);
  if (siege && !view.burning && !view.atThreshold) {
    actions.push({
      key: "siege-building",
      label: "Siege",
      tone: "danger",
      enabled: disconnected === null,
      disabledReason: disconnected,
      onSelect: () => input.onSiege(siege.groupId, structure.structureId)
    });
  }
  if (structure.warfare?.bombable) {
    const bomber = eligibleCityBuildingBomberGroup(input.bomberGroups, input.playerId, structure);
    const bombReason = disconnected ??
      (view.burning && !view.repairing ? "A burning building cannot be bombed." : null) ??
      (bomber ? null : "Bring a deployed Bomber group to plant a bomb.");
    actions.push({
      key: "bomb-building",
      label: "Plant Bomb",
      tone: "danger",
      enabled: bombReason === null,
      disabledReason: bombReason,
      onSelect: () => { if (bomber) input.onBomb(bomber.groupId, structure.structureId); }
    });
  }
  return actions;
}

/** True once a Bomber group stands within charge range of the building. */
export function bomberInRangeOfCityBuilding(
  group: Pick<MilitaryUnitGroupSnapshot, "lat" | "lon">,
  structure: Pick<CityStructureSnapshot, "lat" | "lon" | "footprintRadiusM">
): boolean {
  return group.lat !== null && group.lon !== null &&
    distanceMeters({ lat: group.lat, lon: group.lon }, structure) <=
      MILITARY_UNIT_INTERACTION_RADIUS_M + structure.footprintRadiusM;
}
