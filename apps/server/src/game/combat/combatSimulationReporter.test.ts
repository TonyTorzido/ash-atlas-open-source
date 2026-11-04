import { describe, expect, it } from "vitest";

import { CombatTelemetryAccumulator, type CombatBalanceSummary } from "./combatTelemetry.js";
import {
  combatSimulationReportJson,
  combatSimulationReportMarkdown,
  createCombatSimulationReport
} from "./combatSimulationReporter.js";

describe("deterministic combat simulation reporter", () => {
  it("derives stable human-tuning rows from authoritative aggregate summaries", () => {
    const report = createCombatSimulationReport([
      {
        scenarioId: "three-normal",
        enemyProfile: "three wolves",
        enemyCount: 3,
        loadoutId: "balanced",
        summary: simulationSummary("simulation:three", 3, true)
      },
      {
        scenarioId: "one-boss",
        enemyProfile: "durable ogre",
        enemyCount: 1,
        loadoutId: "tank",
        summary: simulationSummary("simulation:boss", 0, false)
      }
    ]);

    expect(report.rows.map((row) => row.scenarioId)).toEqual(["one-boss", "three-normal"]);
    expect(report.rows[0]).toMatchObject({
      timeToDefeatMs: null,
      damageDealt: 45,
      damageReceived: 20,
      rageGenerated: 22,
      rageSpent: 20,
      damageMitigated: 8,
      resetUsage: 1,
      survived: false
    });
    expect(report.rows[1]).toMatchObject({ timeToDefeatMs: 2_000, enemiesDefeated: 3, survived: true });

    const markdown = combatSimulationReportMarkdown(report);
    expect(markdown).toContain("| one-boss (durable ogre) | tank | 1 | n/a |");
    expect(markdown).toContain("| three-normal (three wolves) | balanced | 3 | 2.00s |");
    expect(JSON.parse(combatSimulationReportJson(report))).toEqual(report);
  });

  it("does not encode a required winner or exact balance threshold", () => {
    const report = createCombatSimulationReport([{
      scenarioId: "tuning-run",
      enemyProfile: "mixed",
      enemyCount: 5,
      loadoutId: "aggressive",
      summary: simulationSummary("simulation:tuning", 2, true)
    }]);
    expect(report.rows[0]?.timeToDefeatMs).toBeNull();
    expect(report.rows[0]?.fightDurationMs).toBe(2_000);
    expect(report.rows[0]?.combatEndReason).toBe("simulation_complete");
  });

});

const STARTED_AT = 1_800_000_000_000;

function simulationSummary(
  combatSessionId: string,
  defeatedEnemies: number,
  survived: boolean
): CombatBalanceSummary {
  const accumulator = new CombatTelemetryAccumulator({
    combatSessionId,
    playerId: "simulation-player",
    activeClassId: "warrior",
    activeSubclassId: null,
    warriorLevel: 25,
    equippedResetActives: ["warrior_punishing_strike", "warrior_sundering_strike"],
    equippedNormalActives: ["warrior_cleave", "warrior_fortify"],
    selectedTierPassives: {
      tier0: "warrior_rageborn",
      tier10: "warrior_crowd_breaker",
      tier20: "warrior_last_stand"
    },
    initialEnemyQueueSize: Math.max(1, defeatedEnemies),
    enemyArchetypeCounts: { wolf: Math.max(1, defeatedEnemies) },
    startedAtMs: STARTED_AT
  });
  accumulator.recordPlayerAction({ action: "basic_attack", atMs: STARTED_AT + 100, damage: 15 });
  accumulator.recordPlayerAction({ action: "reset_strike", abilityId: "warrior_punishing_strike", atMs: STARTED_AT + 120, damage: 30 });
  accumulator.recordDamageDealt("basic_attack", 15);
  accumulator.recordDamageDealt("warrior_punishing_strike", 30);
  accumulator.recordDamageReceived(20, { armor: 5, queue_discipline: 3 });
  accumulator.recordRage({ generated: 22, spent: 20, wastedAtCap: 2 });
  for (let index = 0; index < defeatedEnemies; index += 1) {
    accumulator.recordEnemyDefeated("wolf", STARTED_AT + 500 + index);
  }
  return accumulator.finish({
    endedAtMs: STARTED_AT + 2_000,
    playerSurvived: survived,
    combatEndReason: "simulation_complete"
  });
}
