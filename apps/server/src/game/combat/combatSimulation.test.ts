import { afterEach, describe, expect, it, vi } from "vitest";
import { classDefinition } from "@ash-atlas/shared";

import { combatBalanceSummarySchema } from "./combatTelemetry.js";
import {
  COMBAT_SIMULATION_LOADOUTS,
  COMBAT_SIMULATION_SCENARIOS,
  combatSimulationSuiteJson,
  combatSimulationSuiteMarkdown,
  runCombatSimulation,
  runCombatSimulationSuite
} from "./combatSimulation.js";

afterEach(() => vi.restoreAllMocks());

describe("real-engine deterministic combat simulations", () => {
  it("runs every required scenario with every representative loadout", () => {
    const suite = runCombatSimulationSuite();

    expect(suite.engine).toBe("CombatEngine");
    expect(suite.runs).toHaveLength(
      COMBAT_SIMULATION_SCENARIOS.length * COMBAT_SIMULATION_LOADOUTS.length
    );
    expect(new Set(suite.runs.map((run) => run.scenarioId))).toEqual(
      new Set(COMBAT_SIMULATION_SCENARIOS.map((scenario) => scenario.id))
    );
    expect(new Set(suite.runs.map((run) => run.loadoutId))).toEqual(
      new Set(COMBAT_SIMULATION_LOADOUTS.map((loadout) => loadout.id))
    );

    for (const run of suite.runs) {
      expect(() => combatBalanceSummarySchema.parse(run.summary)).not.toThrow();
      expect(run.timedOut).toBe(false);
      expect(run.summary.durationMs).toBe(run.ticksElapsed * 1_000 / suite.tickRateHz);
      expect(run.summary.initialEnemyQueueSize).toBe(0); // Selection precedes the first landed claim.
      expect(run.summary.maximumEnemyQueueSize).toBeLessThanOrEqual(run.enemyCount);
      expect(run.summary.enemiesDefeated).toBeLessThanOrEqual(run.enemyCount);
      expect(sum(run.summary.damageBySource)).toBe(
        run.initialEnemyHealth - run.enemyHealthRemaining
      );
      expect(run.summary.resourceSpent).toBeLessThanOrEqual(
        run.summary.resourceGenerated + classDefinition(
          COMBAT_SIMULATION_LOADOUTS.find((loadout) => loadout.id === run.loadoutId)!.classId
        ).initialResource
      );
      expect(run.summary.resetWindowSuccesses).toBeLessThanOrEqual(
        run.summary.resetWindowOpportunities
      );
      expect(run.summary.tauntEnemiesAdded + run.summary.tauntEnemiesExcludedByCap)
        .toBeLessThanOrEqual(run.summary.tauntEligibleCandidates);
      expect(run.summary.tauntEnemiesExcludedByCap).toBe(0);
      const loadout = COMBAT_SIMULATION_LOADOUTS.find(
        (candidate) => candidate.id === run.loadoutId
      )!;
      expect(
        Object.keys(run.summary.resetStrikesByAbility).every(
          (abilityId) => loadout.resetActives.includes(abilityId)
        )
      ).toBe(true);
      expect(run.playerFinalHealth).toBeGreaterThanOrEqual(0);
      expect(run.playerFinalHealth).toBeLessThanOrEqual(run.playerMaximumHealth);

      const reportRow = suite.report.rows.find((row) =>
        row.scenarioId === run.scenarioId && row.loadoutId === run.loadoutId
      );
      expect(reportRow).toBeDefined();
      if (run.summary.enemiesDefeated === run.enemyCount) {
        expect(reportRow?.timeToDefeatMs).toBe(run.summary.durationMs);
        expect(run.summary.playerSurvived).toBe(true);
      } else {
        expect(reportRow?.timeToDefeatMs).toBeNull();
      }
    }
    expect(suite.runs.reduce((total, run) => total + run.summary.mitigationBySource.armor, 0)).toBeGreaterThan(0);
    // Queue Discipline and Warrior reset strikes were retired by the resource-free Warrior kit.
    expect(suite.runs.every((run) => run.summary.mitigationBySource.queue_discipline === 0)).toBe(true);
    for (const abilityId of ["warrior_empowered_hit", "warrior_anger_explosion", "warrior_concussive_blow", "warrior_battle_cry"]) {
      expect(suite.runs.reduce((total, run) => total + (run.summary.normalActivesByAbility[abilityId] ?? 0), 0)).toBeGreaterThan(0);
    }
    for (const id of ["hunter-boss", "hunter-pack", "sharpshooter", "stalker"] as const) {
      expect(suite.runs.some((run) => run.loadoutId === id && run.summary.activeClassId === "hunter")).toBe(true);
    }
    expect(suite.runs.some((run) => run.summary.primaryResourceId === "focus" && run.summary.resourceGenerated > 0)).toBe(true);
    for (const run of suite.runs) {
      expect(run.summary.damageBySource.simulation_opening_hit).toBe(run.enemyCount);
      expect(run.summary.maximumEnemyQueueSize).toBe(run.enemyCount);
      if (run.summary.combatEndReason === "enemies_defeated") expect(run.summary.enemiesDefeated).toBe(run.enemyCount);
      else expect(["player_defeated", "enemies_cleared"]).toContain(run.summary.combatEndReason);
    }  });

  it("repeats the same real-engine run without outcome drift", () => {
    const scenario = COMBAT_SIMULATION_SCENARIOS.find((entry) => entry.id === "three-normal")!;
    const loadout = COMBAT_SIMULATION_LOADOUTS.find((entry) => entry.id === "balanced")!;
    const first = runCombatSimulation(scenario, loadout);
    const second = runCombatSimulation(scenario, loadout);

    expect(second).toEqual(first);
  });

  it("emits aggregate machine-readable JSON and a tuning-oriented Markdown table", () => {
    const suite = runCombatSimulationSuite({
      scenarios: [COMBAT_SIMULATION_SCENARIOS[0]!],
      loadouts: [COMBAT_SIMULATION_LOADOUTS[0]!]
    });
    const parsed = JSON.parse(combatSimulationSuiteJson(suite)) as {
      engine: string;
      runs: Array<{ summary: Record<string, unknown> }>;
    };
    expect(parsed.engine).toBe("CombatEngine");
    expect(parsed.runs[0]?.summary).not.toHaveProperty("actionTrace");
    expect(parsed.runs[0]?.summary).toMatchObject({
      tauntEligibleCandidates: expect.any(Number),
      tauntEnemiesAdded: expect.any(Number),
      tauntEnemiesExcludedByCap: 0
    });

    const markdown = combatSimulationSuiteMarkdown(suite);
    expect(markdown).toContain("production `CombatEngine`");
    expect(markdown).toContain("Resource G/S/W");
    expect(markdown).toContain("queue discipline");
    expect(markdown).toContain("| one-normal | tank |");
  });
});

function sum(metric: Record<string, number>): number {
  return Object.values(metric).reduce((total, value) => total + value, 0);
}
