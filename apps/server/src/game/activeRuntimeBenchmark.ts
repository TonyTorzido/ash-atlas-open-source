import { performance } from "node:perf_hooks";

import { loadConfig } from "../config.js";
import { GameState } from "./state.js";

const populations = [1_000, 10_000, 100_000];
const config = loadConfig({ NODE_ENV: "test" });
const results: Array<Record<string, number | string>> = [];

for (const population of populations) {
  const offline = new GameState(config);
  for (let index = 0; index < population; index += 1) {
    const player = offline.helloPlayer(`offline-${population}-${index}`, "Offline");
    offline.markOffline(player.playerId);
  }
  results.push(measure("offline", population, offline, 25));

  const active = new GameState(config);
  for (let index = 0; index < population; index += 1) {
    const player = active.helloPlayer(`active-${population}-${index}`, "Active");
    active.setTarget(player.playerId, {
      lat: player.anchor.lat,
      lon: player.anchor.lon + 0.001
    });
  }
  results.push(measure("active", population, active, 10));
}

console.table(results);
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));

function measure(
  kind: "offline" | "active",
  population: number,
  state: GameState,
  samples: number
): Record<string, number | string> {
  state.tick(0.001);
  const durations: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const startedAt = performance.now();
    state.tick(0.001);
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  return {
    kind,
    population,
    loadedPlayers: state.activeRuntimeMetrics().loadedPlayers,
    movingPlayers: state.activeRuntimeMetrics().movingPlayers,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    heapUsedMb: process.memoryUsage().heapUsed / 1024 / 1024
  };
}

function percentile(values: number[], quantile: number): number {
  return Number(values[Math.min(values.length - 1, Math.floor(values.length * quantile))]!.toFixed(3));
}
