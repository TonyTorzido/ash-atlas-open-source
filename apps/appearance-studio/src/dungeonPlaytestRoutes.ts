import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  validateCreatePlaytestInput,
  validatePlaytestCommand,
  type DungeonPlaytestFrame
} from "./dungeonPlaytestContracts.js";
import type { DungeonPlaytestRuntime } from "./dungeonPlaytestRuntime.js";

export type SequencedPlaytestFrame = DungeonPlaytestFrame & { sequence: number };
type Run = { runtime: DungeonPlaytestRuntime; sequence: number; lastAdvance: number; touched: number; tail: Promise<unknown> };

/** In-memory capability-scoped runs. This module never receives a database or publishing adapter. */
export function registerDungeonPlaytestRoutes(app: FastifyInstance, authorize: (request: FastifyRequest) => void): void {
  const runs = new Map<string, Run>();
  let starting = 0;
  let closing = false;
  const serialize = async <T>(run: Run, operation: () => Promise<T>): Promise<T> => {
    const next = run.tail.then(operation, operation);
    run.tail = next.catch(() => undefined);
    return next;
  };
  const frame = (run: Run, snapshot: DungeonPlaytestFrame): SequencedPlaytestFrame => ({ ...snapshot, sequence: ++run.sequence });
  const remove = async (id: string): Promise<void> => {
    const run = runs.get(id);
    if (!run) return;
    runs.delete(id);
    await serialize(run, () => run.runtime.dispose());
  };
  const find = (request: FastifyRequest): Run => {
    authorize(request);
    const run = runs.get((request.params as { runId: string }).runId);
    if (!run) throw Object.assign(new Error("This Play Test has ended. Restart the dungeon."), { statusCode: 404 });
    run.touched = Date.now();
    return run;
  };
  app.post("/api/dungeon-playtest/start", async (request, reply) => {
    authorize(request);
    for (const [id, run] of runs) if (Date.now() - run.touched > 15 * 60_000) await remove(id);
    if (closing) throw Object.assign(new Error("Studio is closing."), { statusCode: 503 });
    if (runs.size + starting >= 4) throw Object.assign(new Error("Four Play Tests are already open. Exit one before starting another."), { statusCode: 429 });
    const parsed = validateCreatePlaytestInput(request.body);
    if (parsed.issues.length > 0 || !parsed.value) {
      return reply.code(400).send({
        error: "Invalid dungeon Play Test definition.",
        code: "PLAYTEST_INPUT_INVALID",
        issues: parsed.issues
      });
    }
    const input = parsed.value;
    starting += 1;
    try {
    const { DungeonPlaytestRuntime } = await import("./dungeonPlaytestRuntime.js");
    const runtime = await DungeonPlaytestRuntime.create(input);
    if (closing) { await runtime.dispose(); throw new Error("Studio closed while starting this run."); }
    const initial = runtime.snapshot();
    const run: Run = { runtime, sequence: 0, lastAdvance: performance.now(), touched: Date.now(), tail: Promise.resolve() };
    runs.set(initial.runId, run);
    return frame(run, initial);
    } finally { starting -= 1; }
  });
  app.post("/api/dungeon-playtest/:runId/advance", async (request) => {
    const run = find(request);
    return serialize(run, async () => {
      const now = performance.now();
      const elapsed = Math.max(0, Math.min(.25, (now - run.lastAdvance) / 1000));
      run.lastAdvance = now;
      return frame(run, await run.runtime.advance(elapsed));
    });
  });
  app.post("/api/dungeon-playtest/:runId/command", async (request, reply) => {
    const run = find(request);
    const parsed = validatePlaytestCommand(request.body);
    if (parsed.issues.length > 0 || !parsed.value) {
      return reply.code(400).send({
        error: "Invalid dungeon Play Test command.",
        code: "PLAYTEST_COMMAND_INVALID",
        issues: parsed.issues
      });
    }
    const command = parsed.value;
    return serialize(run, async () => {
      const result = await run.runtime.command(command);
      if (command.type === "debug" && command.paused !== undefined) run.lastAdvance = performance.now();
      return frame(run, result);
    });
  });
  app.post("/api/dungeon-playtest/:runId/stop", async (request) => {
    authorize(request);
    await remove((request.params as { runId: string }).runId);
    return { stopped: true };
  });
  const expiry = setInterval(() => {
    for (const [id, run] of runs) if (Date.now() - run.touched > 15 * 60_000) void remove(id).catch((error: unknown) => app.log.error(error, "Could not dispose expired Play Test"));
  }, 60_000);
  expiry.unref();
  app.addHook("onClose", async () => { closing = true; clearInterval(expiry); for (const id of runs.keys()) await remove(id); });
}
