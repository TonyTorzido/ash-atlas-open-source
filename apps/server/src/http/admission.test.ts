import Fastify from "fastify";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import {
  HTTP_ADMISSION_MAX_HANDLER_MS,
  HttpAdmissionController
} from "./admission.js";

describe("HTTP admission control", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.useRealTimers();
  });

  it("bounds active expensive work and its pending queue", async () => {
    const app = Fastify();
    apps.push(app);
    const config = loadConfig({
      NODE_ENV: "test",
      HTTP_EXPENSIVE_CONCURRENCY: "1",
      HTTP_EXPENSIVE_QUEUE_MAX: "1",
      HTTP_EXPENSIVE_QUEUE_TIMEOUT_MS: "1000"
    });
    const admission = new HttpAdmissionController(config);
    admission.install(app, new Map([["GET /slow", "expensive"]]));
    const gate = deferred<void>();
    app.get("/slow", async () => {
      await gate.promise;
      return { ok: true };
    });

    const first = app.inject({ method: "GET", url: "/slow" });
    await vi.waitFor(() => expect(admission.metricsSnapshot().active).toBe(1));
    const second = app.inject({ method: "GET", url: "/slow" });
    await vi.waitFor(() => expect(admission.metricsSnapshot().queueDepth).toBe(1));
    const rejected = await app.inject({ method: "GET", url: "/slow" });
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("1");

    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { statusCode: 200 },
      { statusCode: 200 }
    ]);
    expect(admission.metricsSnapshot()).toMatchObject({
      accepted: 2,
      rejected: 1,
      active: 0,
      queued: 1,
      queueDepth: 0,
      completed: 2
    });
  });

  it("limits authenticated identity and trusted request IP windows with Retry-After", async () => {
    const app = Fastify();
    apps.push(app);
    app.decorateRequest("authSession", null);
    app.addHook("preHandler", async (request) => {
      request.authSession = session("player-1");
    });
    const config = loadConfig({
      NODE_ENV: "test",
      HTTP_STANDARD_RATE_PER_MINUTE: "2",
      HTTP_NETWORK_RATE_MULTIPLIER: "10"
    });
    const admission = new HttpAdmissionController(config);
    admission.install(app, new Map([["GET /limited", "standard"]]));
    app.get("/limited", async () => ({ ok: true }));

    expect((await app.inject({ method: "GET", url: "/limited", remoteAddress: "192.0.2.1" })).statusCode)
      .toBe(200);
    expect((await app.inject({ method: "GET", url: "/limited", remoteAddress: "192.0.2.2" })).statusCode)
      .toBe(200);
    const rejected = await app.inject({ method: "GET", url: "/limited", remoteAddress: "192.0.2.3" });
    expect(rejected.statusCode).toBe(429);
    expect(Number(rejected.headers["retry-after"])).toBeGreaterThan(0);
    expect(rejected.json()).toMatchObject({ error: { code: "HTTP_RATE_LIMITED" } });
  });

  it("releases a permit when the raw response finishes without Fastify onResponse", async () => {
    const app = Fastify();
    apps.push(app);
    const config = loadConfig({
      NODE_ENV: "test",
      HTTP_STANDARD_CONCURRENCY: "1"
    });
    const admission = new HttpAdmissionController(config);
    admission.install(app, new Map([["GET /raw", "standard"]]));
    app.get("/raw", async (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "application/json" });
      reply.raw.end('{"ok":true}');
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    await expect(fetch(`${address}/raw`).then((response) => response.json()))
      .resolves.toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(admission.metricsSnapshot()).toMatchObject({
        accepted: 1,
        completed: 1,
        active: 0
      });
    });
  });

  it("expires an active permit when a handler never settles", async () => {
    vi.useFakeTimers();
    const app = Fastify();
    apps.push(app);
    const config = loadConfig({
      NODE_ENV: "test",
      HTTP_STANDARD_CONCURRENCY: "1"
    });
    const admission = new HttpAdmissionController(config);
    admission.install(app, new Map([["GET /stalled", "standard"]]));
    const gate = deferred<void>();
    app.get("/stalled", async () => {
      await gate.promise;
      return { ok: true };
    });

    const stalled = app.inject({ method: "GET", url: "/stalled" });
    await vi.waitFor(() => expect(admission.metricsSnapshot().active).toBe(1));
    await vi.advanceTimersByTimeAsync(HTTP_ADMISSION_MAX_HANDLER_MS);

    expect(admission.metricsSnapshot()).toMatchObject({
      active: 0,
      handlerTimedOut: 1
    });
    gate.resolve();
    await stalled;
  });

  it("times queued requests out with retryable errors and metrics", async () => {
    const app = Fastify();
    apps.push(app);
    const config = loadConfig({
      NODE_ENV: "test",
      HTTP_EXPENSIVE_CONCURRENCY: "1",
      HTTP_EXPENSIVE_QUEUE_MAX: "1",
      HTTP_EXPENSIVE_QUEUE_TIMEOUT_MS: "10"
    });
    const admission = new HttpAdmissionController(config);
    admission.install(app, new Map([["GET /timeout", "expensive"]]));
    const gate = deferred<void>();
    app.get("/timeout", async () => {
      await gate.promise;
      return { ok: true };
    });

    const first = app.inject({ method: "GET", url: "/timeout" });
    await vi.waitFor(() => expect(admission.metricsSnapshot().active).toBe(1));
    const timedOut = await app.inject({ method: "GET", url: "/timeout" });
    expect(timedOut.statusCode).toBe(429);
    expect(timedOut.json()).toMatchObject({ error: { code: "HTTP_ADMISSION_BUSY" } });
    expect(admission.metricsSnapshot()).toMatchObject({ timedOut: 1, rejected: 1 });
    gate.resolve();
    await first;
  });

  it("removes an abandoned socket from the queue without leaking a permit", async () => {
    const app = Fastify();
    apps.push(app);
    const config = loadConfig({
      NODE_ENV: "test",
      HTTP_EXPENSIVE_CONCURRENCY: "1",
      HTTP_EXPENSIVE_QUEUE_MAX: "2",
      HTTP_EXPENSIVE_QUEUE_TIMEOUT_MS: "5000"
    });
    const admission = new HttpAdmissionController(config);
    admission.install(app, new Map([["GET /disconnect", "expensive"]]));
    const gate = deferred<void>();
    app.get("/disconnect", async () => {
      await gate.promise;
      return { ok: true };
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const first = fetch(`${address}/disconnect`);
    await vi.waitFor(() => expect(admission.metricsSnapshot().active).toBe(1));
    const abandoned = httpRequest(`${address}/disconnect`);
    const abandonedClosed = new Promise<void>((resolve) => {
      abandoned.once("error", () => resolve());
      abandoned.once("close", () => resolve());
    });
    abandoned.end();
    await vi.waitFor(() => expect(admission.metricsSnapshot().queueDepth).toBe(1));
    abandoned.destroy();
    await abandonedClosed;
    await vi.waitFor(() => {
      expect(admission.metricsSnapshot()).toMatchObject({
        active: 1,
        queueDepth: 0,
        clientCancelled: 1
      });
    });

    const replacement = fetch(`${address}/disconnect`);
    await vi.waitFor(() => expect(admission.metricsSnapshot().queueDepth).toBe(1));
    gate.resolve();
    await expect(Promise.all([first, replacement])).resolves.toMatchObject([
      { status: 200 },
      { status: 200 }
    ]);
    await vi.waitFor(() => {
      expect(admission.metricsSnapshot()).toMatchObject({
        accepted: 2,
        active: 0,
        queueDepth: 0,
        completed: 2
      });
    });
  });

  it("keeps randomized queue cancellation and permit accounting consistent", async () => {
    const app = Fastify();
    apps.push(app);
    const config = loadConfig({
      NODE_ENV: "test",
      HTTP_EXPENSIVE_CONCURRENCY: "2",
      HTTP_EXPENSIVE_QUEUE_MAX: "12",
      HTTP_EXPENSIVE_QUEUE_TIMEOUT_MS: "5000"
    });
    const admission = new HttpAdmissionController(config);
    admission.install(app, new Map([["GET /race", "expensive"]]));
    const gate = deferred<void>();
    app.get("/race", async () => {
      await gate.promise;
      return { ok: true };
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const active = [fetch(`${address}/race`), fetch(`${address}/race`)];
    await vi.waitFor(() => expect(admission.metricsSnapshot().active).toBe(2));
    const queued = Array.from({ length: 8 }, () => socketGet(`${address}/race`));
    await vi.waitFor(() => expect(admission.metricsSnapshot().queueDepth).toBe(8));
    const cancellationOrder = seededShuffle([...Array(8).keys()], 0xA57A5);
    const cancelled = new Set(cancellationOrder.slice(0, 5));
    for (const index of cancelled) queued[index]!.request.destroy();
    await vi.waitFor(() => {
      expect(admission.metricsSnapshot()).toMatchObject({
        active: 2,
        queueDepth: 3,
        clientCancelled: 5
      });
    });

    gate.resolve();
    await Promise.all([...active, ...queued.map(({ response }) => response)]);
    await vi.waitFor(() => {
      expect(admission.metricsSnapshot()).toMatchObject({
        accepted: 5,
        active: 0,
        queued: 8,
        queueDepth: 0,
        clientCancelled: 5,
        completed: 5
      });
    });
    expect(queued.filter((_request, index) => !cancelled.has(index)).length).toBe(3);
  });
});

function session(playerId: string) {
  return {
    sessionId: "session-1",
    verifiedEmail: "ash@example.com",
    account: {
      id: "account-1",
      status: "active" as const,
      trustTier: "new" as const,
      riskScore: 0,
      testAccessStatus: "approved" as const,
      testAccessRequestedAt: new Date(),
      testAccessDecidedAt: new Date(),
      createdAt: new Date(),
      lastLoginAt: null
    },
    player: {
      id: playerId,
      accountId: "account-1",
      displayName: "Ash",
      personalFlagColor: "blue" as const,
      onboardingCompletedAt: new Date()
    },
    deviceInstallationId: "device-1",
    csrfToken: "csrf"
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve: () => resolve(undefined as T) };
}

function socketGet(url: string) {
  let settled = false;
  let settle!: (status: number | null) => void;
  const response = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  const finish = (status: number | null): void => {
    if (settled) return;
    settled = true;
    settle(status);
  };
  const request = httpRequest(url, (incoming) => {
    incoming.resume();
    incoming.once("end", () => finish(incoming.statusCode ?? null));
  });
  request.once("error", () => finish(null));
  request.once("close", () => {
    if (request.destroyed) finish(null);
  });
  request.end();
  return { request, response };
}

function seededShuffle<T>(values: T[], seed: number): T[] {
  let state = seed >>> 0;
  for (let index = values.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [values[index], values[target]] = [values[target]!, values[index]!];
  }
  return values;
}
