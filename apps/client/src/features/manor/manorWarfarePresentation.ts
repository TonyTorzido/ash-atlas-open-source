import {
  MANOR_WARFARE_PROFILE,
  STRUCTURE_WARFARE_INTERACTION_RADIUS_M,
  distanceMeters,
  manorHealthFromSnapshot,
  type ManorWorldSnapshot
} from "@ash-atlas/shared";

import type { GamePromptAction } from "../../ui/GameActionPrompt.js";

/*
 * Manor warfare presentation (houses): health and burn status for the
 * Manor prompt and map marker, plus the Attack / Repair actions. The server
 * decides every outcome; these helpers only gate the buttons with the same
 * rules so the prompt does not offer dead actions.
 */

export type ManorWarfareView = Readonly<{
  health: number;
  maximumHealth: number;
  ratio: number;
  damaged: boolean;
  burning: boolean;
  repairing: boolean;
  atThreshold: boolean;
  /** 0 health: the Manor keeps its contents but cannot be entered until repaired. */
  burnt: boolean;
}>;

export function manorWarfareView(
  manor: Pick<ManorWorldSnapshot, "warfare">,
  nowMs: number
): ManorWarfareView {
  const warfare = manor.warfare;
  const maximumHealth = warfare?.maximumHealth ?? MANOR_WARFARE_PROFILE.maximumHealth;
  const health = manorHealthFromSnapshot(warfare, nowMs);
  return {
    health,
    maximumHealth,
    ratio: maximumHealth > 0 ? Math.max(0, Math.min(1, health / maximumHealth)) : 0,
    damaged: health < maximumHealth || warfare?.burning === true,
    burning: warfare?.burning === true && health > 0,
    repairing: warfare?.repairing === true,
    atThreshold: health <= (warfare?.burnThreshold ?? MANOR_WARFARE_PROFILE.burnThreshold),
    burnt: health <= 0
  };
}

/** Prompt detail line, for example "2,400 / 4,400 HP · Burning"; null at full health. */
export function manorWarfareDetail(manor: Pick<ManorWorldSnapshot, "warfare">, nowMs: number): string | null {
  const view = manorWarfareView(manor, nowMs);
  if (!view.damaged) return null;
  const status = view.repairing
    ? " · Repairing"
    : view.burnt
      ? " · Burnt down (repair to enter)"
      : view.burning ? " · Burning" : "";
  return `${view.health.toLocaleString("en-US")} / ${view.maximumHealth.toLocaleString("en-US")} HP${status}`;
}

export function manorWarfareActions(input: Readonly<{
  manor: ManorWorldSnapshot;
  nowMs: number;
  playerId: string;
  player: Readonly<{ lat: number; lon: number }> | null;
  connected: boolean;
  onAttack(manorId: string): void;
  onRepair(manorId: string): void;
  onStopRepair(): void;
}>): GamePromptAction[] {
  const { manor } = input;
  const view = manorWarfareView(manor, input.nowMs);
  const disconnected = input.connected ? null : "Unavailable while disconnected.";
  const near = input.player !== null && distanceMeters(input.player, manor) <= STRUCTURE_WARFARE_INTERACTION_RADIUS_M;
  if (manor.ownerPlayerId === input.playerId) {
    if (manor.warfare?.repairPlayerId === input.playerId) {
      return [{
        key: "stop-manor-repair",
        label: "Stop Repair",
        tone: "secondary",
        enabled: disconnected === null,
        disabledReason: disconnected,
        onSelect: input.onStopRepair
      }];
    }
    if (!view.damaged) return [];
    const reason = disconnected ?? (near ? null : "Move next to your Manor to repair it.");
    return [{
      key: "repair-manor",
      label: "Repair",
      tone: "secondary",
      enabled: reason === null,
      disabledReason: reason,
      onSelect: () => input.onRepair(manor.manorId)
    }];
  }
  const reason = disconnected ??
    (view.burnt ? "This Manor has burnt down." : null) ??
    (view.burning ? "This Manor is burning." : null) ??
    (view.atThreshold ? "This Manor is ready to burn." : null) ??
    (near ? null : "Move next to the Manor to attack it.");
  return [{
    key: "attack-manor",
    label: "Attack",
    tone: "danger",
    enabled: reason === null,
    disabledReason: reason,
    onSelect: () => input.onAttack(manor.manorId)
  }];
}
