import { loadConfig } from "../config.js";
import { PlayerPersistenceSupervisor } from "./playerPersistenceSupervisor.js";
import { GameState } from "./state.js";

const results = [];
for (const population of [1_000, 10_000]) {
  const state = new GameState(loadConfig({ NODE_ENV: "test" }));
  for (let index = 0; index < population; index += 1) {
    state.helloPlayer(`persistence-${population}-${index}`, "Persistence");
  }
  let active = 0;
  let maxActive = 0;
  let attempts = 0;
  let injectFailures = true;
  const supervisor = new PlayerPersistenceSupervisor(state, async () => {
    const attempt = attempts;
    attempts += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if (injectFailures && attempt % 1_000 === 0) throw new Error("injected database failure");
    return { statements: 1, poolWaitMs: 0.5 };
  }, 8);
  const firstPass = await supervisor.runPass();
  injectFailures = false;
  const retryPass = await supervisor.runPass();
  results.push({
    population,
    concurrency: 8,
    maxActive,
    firstPass,
    retryPass,
    remainingDirty: state.dirtyPlayerMetrics().count
  });
}

console.table(results.map((result) => ({
  population: result.population,
  maxActive: result.maxActive,
  firstDurationMs: Number(result.firstPass.durationMs.toFixed(1)),
  firstSuccesses: result.firstPass.successes,
  firstFailures: result.firstPass.failures,
  retryDurationMs: Number(result.retryPass.durationMs.toFixed(1)),
  remainingDirty: result.remainingDirty
})));
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
