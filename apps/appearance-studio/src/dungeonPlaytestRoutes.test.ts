import { fileURLToPath } from "node:url";
import { DUNGEON_CATALOG } from "@ash-atlas/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAppearanceStudioBridge } from "./bridge.js";

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
describe("isolated Play Test bridge", () => {
  it("requires the existing Studio origin and CSRF capability for every runtime operation", async () => {
    app = await createAppearanceStudioBridge({ repositoryRoot: fileURLToPath(new URL("../../..", import.meta.url)), serveUi: false, port: 45241 });
    const session = (await app.inject({ method: "GET", url: "/api/session" })).json();
    const headers = { origin: session.origin, "x-appearance-studio-token": session.csrfToken };
    const payload = { catalog: DUNGEON_CATALOG, dungeonId: DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "cistern_warrens")!.id, mode: "full", seed: "route-test" };
    for (const suffix of ["start", "missing/advance", "missing/command", "missing/stop"]) {
      const denied = await app.inject({ method: "POST", url: "/api/dungeon-playtest/" + suffix, payload });
      expect(denied.statusCode).toBe(403);
    }
    expect((await app.inject({ method: "POST", url: "/api/dungeon-playtest/start", headers: { ...headers, origin: "https://untrusted.example" }, payload })).statusCode).toBe(403);
    const start = await app.inject({ method: "POST", url: "/api/dungeon-playtest/start", headers, payload });
    expect(start.statusCode).toBe(200);
    const initial = start.json();
    expect(initial.snapshot.spaceId).toBe(DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "cistern_warrens")!.entrance.roomId);
    const frames = await Promise.all(Array.from({ length: 3 }, () => app!.inject({ method: "POST", url: "/api/dungeon-playtest/" + initial.runId + "/advance", headers, payload: {} })));
    expect(frames.map((response) => response.json().sequence)).toEqual([2, 3, 4]);
    for (const response of frames) expect(response.json().sandbox.storageAttempts).toBe(0);
    expect((await app.inject({ method: "POST", url: "/api/dungeon-playtest/" + initial.runId + "/stop", headers, payload: {} })).statusCode).toBe(200);
    const stopped = await app.inject({ method: "POST", url: "/api/dungeon-playtest/" + initial.runId + "/advance", headers, payload: {} });
    expect(stopped.json().error).toContain("ended");
  });
  it("bounds concurrent starts and frees capacity after clean stop", async () => {
    app = await createAppearanceStudioBridge({ repositoryRoot: fileURLToPath(new URL("../../..", import.meta.url)), serveUi: false, port: 45241 });
    const session = (await app.inject({ method: "GET", url: "/api/session" })).json();
    const headers = { origin: session.origin, "x-appearance-studio-token": session.csrfToken };
    const payload = { catalog: DUNGEON_CATALOG, dungeonId: DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "cistern_warrens")!.id, mode: "full", seed: "capacity" };
    const starts = await Promise.all(Array.from({ length: 5 }, () => app!.inject({ method: "POST", url: "/api/dungeon-playtest/start", headers, payload })));
    expect(starts.filter((result) => result.statusCode === 200)).toHaveLength(4);
    expect(starts.find((result) => result.statusCode !== 200)?.json().error).toContain("Four");
    for (const result of starts.filter((entry) => entry.statusCode === 200)) await app.inject({ method: "POST", url: "/api/dungeon-playtest/" + result.json().runId + "/stop", headers, payload: {} });
    expect((await app.inject({ method: "POST", url: "/api/dungeon-playtest/start", headers, payload })).statusCode).toBe(200);
  });

  it("returns field issues for malformed drafts and discriminated commands", async () => {
    app = await createAppearanceStudioBridge({ repositoryRoot: fileURLToPath(new URL("../../..", import.meta.url)), serveUi: false, port: 45241 });
    const session = (await app.inject({ method: "GET", url: "/api/session" })).json();
    const headers = { origin: session.origin, "x-appearance-studio-token": session.csrfToken };
    const payload = { catalog: DUNGEON_CATALOG, dungeonId: DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "cistern_warrens")!.id, mode: "full", seed: "" };
    const invalidStart = await app.inject({ method: "POST", url: "/api/dungeon-playtest/start", headers, payload });
    expect(invalidStart.statusCode).toBe(400);
    expect(invalidStart.json()).toMatchObject({
      code: "PLAYTEST_INPUT_INVALID",
      issues: expect.arrayContaining([expect.objectContaining({ path: "seed" })])
    });

    const start = await app.inject({ method: "POST", url: "/api/dungeon-playtest/start", headers, payload: { ...payload, seed: "valid-command-run" } });
    expect(start.statusCode).toBe(200);
    const runId = start.json().runId;
    const invalidCommand = await app.inject({
      method: "POST", url: `/api/dungeon-playtest/${runId}/command`, headers,
      payload: { type: "damage", targetEntityId: "enemy", amount: 999 }
    });
    expect(invalidCommand.statusCode).toBe(400);
    expect(invalidCommand.json()).toMatchObject({
      code: "PLAYTEST_COMMAND_INVALID",
      issues: [expect.objectContaining({ path: "amount", message: "must be exactly 1000" })]
    });
    await app.inject({ method: "POST", url: `/api/dungeon-playtest/${runId}/stop`, headers, payload: {} });
  });
});
