import {
  COMBAT_TELEMETRY_SCHEMA_VERSION,
  combatBalanceSummarySchema,
  type CombatBalanceSummary
} from "./combatTelemetry.js";
import type { ClassResourceId } from "@ash-atlas/shared";

export type CombatSimulationRun = {
  scenarioId: string;
  enemyProfile: string;
  enemyCount: number;
  loadoutId: string;
  summary: CombatBalanceSummary;
};

export type CombatSimulationReportRow = {
  scenarioId: string;
  enemyProfile: string;
  enemyCount: number;
  loadoutId: string;
  fightDurationMs: number;
  timeToDefeatMs: number | null;
  damageDealt: number;
  damageReceived: number;
  resourceId: ClassResourceId;
  resourceGenerated: number;
  resourceSpent: number;
  resourceWastedAtCap: number;
  rageGenerated: number;
  rageSpent: number;
  rageWastedAtCap: number;
  damageMitigated: number;
  resetUsage: number;
  playerActions: number;
  enemyActions: number;
  survived: boolean;
  enemiesDefeated: number;
  combatEndReason: string;
};

export type CombatSimulationReport = {
  schemaVersion: typeof COMBAT_TELEMETRY_SCHEMA_VERSION;
  rows: CombatSimulationReportRow[];
};

/**
 * Converts authoritative aggregate summaries into stable balance-report rows.
 * A future real-engine runner only needs to produce CombatBalanceSummary values;
 * this reporter deliberately owns no second damage or combat implementation.
 */
export function createCombatSimulationReport(runs: readonly CombatSimulationRun[]): CombatSimulationReport {
  const rows = runs.map((run) => {
    const summary = combatBalanceSummarySchema.parse(run.summary);
    const enemyCount = requireNonnegativeInteger(run.enemyCount, "simulation enemy count");
    const allEnemiesDefeated = summary.enemiesDefeated >= enemyCount;
    return {
      scenarioId: requireLabel(run.scenarioId, "scenario id"),
      enemyProfile: requireLabel(run.enemyProfile, "enemy profile"),
      enemyCount,
      loadoutId: requireLabel(run.loadoutId, "loadout id"),
      fightDurationMs: summary.durationMs,
      timeToDefeatMs: allEnemiesDefeated ? summary.durationMs : null,
      damageDealt: sumValues(summary.damageBySource),
      damageReceived: summary.damageReceived,
      resourceId: summary.primaryResourceId,
      resourceGenerated: summary.resourceGenerated,
      resourceSpent: summary.resourceSpent,
      resourceWastedAtCap: summary.resourceWastedAtCap,
      rageGenerated: summary.rageGenerated,
      rageSpent: summary.rageSpent,
      rageWastedAtCap: summary.rageWastedAtCap,
      damageMitigated: sumValues(summary.mitigationBySource),
      resetUsage: sumValues(summary.resetStrikesByAbility),
      playerActions: summary.playerActionCount,
      enemyActions: summary.enemyActionCount,
      survived: summary.playerSurvived,
      enemiesDefeated: summary.enemiesDefeated,
      combatEndReason: summary.combatEndReason
    } satisfies CombatSimulationReportRow;
  }).sort((left, right) =>
    left.scenarioId.localeCompare(right.scenarioId) || left.loadoutId.localeCompare(right.loadoutId)
  );
  return { schemaVersion: COMBAT_TELEMETRY_SCHEMA_VERSION, rows };
}

export function combatSimulationReportJson(report: CombatSimulationReport): string {
  return JSON.stringify(report, null, 2);
}

export function combatSimulationReportMarkdown(report: CombatSimulationReport): string {
  const header = [
    "| Scenario | Loadout | Enemies | Time to defeat | Damage dealt | Damage received | Resource generated/spent | Mitigated | Resets | Survived |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |"
  ];
  const rows = report.rows.map((row) => [
    escapeCell(`${row.scenarioId} (${row.enemyProfile})`),
    escapeCell(row.loadoutId),
    String(row.enemyCount),
    row.timeToDefeatMs === null ? "n/a" : formatSeconds(row.timeToDefeatMs),
    formatNumber(row.damageDealt),
    formatNumber(row.damageReceived),
    `${row.resourceId} ${formatNumber(row.resourceGenerated)}/${formatNumber(row.resourceSpent)}`,
    formatNumber(row.damageMitigated),
    formatNumber(row.resetUsage),
    row.survived ? "yes" : "no"
  ].join(" | "));
  return [...header, ...rows.map((row) => `| ${row} |`)].join("\n");
}

function sumValues(values: Record<string, number>): number {
  return Object.values(values).reduce((total, value) => total + value, 0);
}

function requireNonnegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer`);
  return value;
}

function requireLabel(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 120) throw new Error(`${label} must contain 1-120 characters`);
  return normalized;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(2)}s`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
