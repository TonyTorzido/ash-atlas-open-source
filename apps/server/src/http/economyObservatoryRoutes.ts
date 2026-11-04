import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CURRENT_LEVEL_CAP } from "@ash-atlas/shared";

import type { AuthService } from "../auth/authService.js";
import {
  ECONOMY_OBSERVATORY_CAPABILITY,
  ECONOMY_OBSERVATORY_SCOPES,
  type EconomyObservatoryService
} from "../game/economyObservatory.js";
import { sendError } from "./errors.js";
import {
  authorizeDeveloperHttp,
  recordDeveloperHttpResult
} from "./routes/routeAuthentication.js";

const windowSchema = z.enum(["24h", "7d", "30d"]).default("24h");
const scopeSchema = z.enum(ECONOMY_OBSERVATORY_SCOPES).default("existing_world_supply");
const queryBooleanSchema = z.preprocess(
  (value) => value === "true" ? true : value === "false" ? false : value,
  z.boolean()
);
const overviewQuerySchema = z.object({ window: windowSchema }).strict();
const itemListQuerySchema = z.object({
  window: windowSchema,
  scope: scopeSchema,
  search: z.string().trim().max(80).default(""),
  limit: z.coerce.number().int().min(1).max(250).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(250).optional(),
  sort: z.enum(["quantity", "holders", "assetId", "displayName"]).default("quantity"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  category: z.string().trim().max(40).optional(),
  assetKind: z.enum(["fungible", "unique"]).optional()
}).strict();
const playerListQuerySchema = z.object({
  window: windowSchema,
  search: z.string().trim().max(80).default(""),
  limit: z.coerce.number().int().min(1).max(250).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(250).optional(),
  sort: z.enum(["quantity", "activeGameplaySeconds", "level", "lastActiveAt", "displayName", "gold"]).default("quantity"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  activeOnly: queryBooleanSchema.default(false),
  lastActiveHours: z.coerce.number().finite().min(0).max(24 * 365).optional(),
  activeGameplayHoursMin: z.coerce.number().finite().min(0).max(24 * 365).optional(),
  activeGameplayHoursMax: z.coerce.number().finite().min(0).max(24 * 365).optional(),
  levelMin: z.coerce.number().int().min(0).max(CURRENT_LEVEL_CAP).optional(),
  levelMax: z.coerce.number().int().min(0).max(CURRENT_LEVEL_CAP).optional(),
  kingdom: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  accountAgeCohort: z.enum(["<7d", "7-30d", "30+d", "unknown"]).optional()
}).strict();
const itemParamsSchema = z.object({ assetId: z.string().min(1).max(160) }).strict();
const playerParamsSchema = z.object({ playerId: z.string().min(1).max(128) }).strict();
const itemDetailQuerySchema = z.object({
  window: windowSchema,
  scope: scopeSchema,
  search: z.string().trim().max(80).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(250).optional(),
  sort: z.enum(["currentQuantity", "grossAcquired", "grossOutflow", "netChange", "percentile", "activeGameplaySeconds", "displayName"]).default("currentQuantity"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  activeOnly: queryBooleanSchema.default(false),
  levelMin: z.coerce.number().int().min(0).max(CURRENT_LEVEL_CAP).optional(),
  levelMax: z.coerce.number().int().min(0).max(CURRENT_LEVEL_CAP).optional(),
  kingdom: z.string().trim().max(80).optional(),
  activityCohort: z.string().trim().max(20).optional(),
  accountAgeCohort: z.enum(["<7d", "7-30d", "30+d", "unknown"]).optional()
}).strict();
const itemHolderQuerySchema = z.object({
  window: windowSchema,
  scope: scopeSchema,
  assetId: z.string().min(1).max(160),
  search: z.string().trim().max(80).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(250).optional(),
  sort: z.enum(["currentQuantity", "grossAcquired", "grossOutflow", "netChange", "percentile", "activeGameplaySeconds", "displayName"]).default("currentQuantity"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  activeOnly: queryBooleanSchema.default(false),
  levelMin: z.coerce.number().int().min(0).max(CURRENT_LEVEL_CAP).optional(),
  levelMax: z.coerce.number().int().min(0).max(CURRENT_LEVEL_CAP).optional(),
  kingdom: z.string().trim().max(80).optional(),
  activityCohort: z.string().trim().max(20).optional(),
  accountAgeCohort: z.enum(["<7d", "7-30d", "30+d", "unknown"]).optional()
}).strict();

const CAPABILITY = ECONOMY_OBSERVATORY_CAPABILITY;

export function registerEconomyObservatoryRoutes(
  app: FastifyInstance,
  auth: AuthService,
  observatory: EconomyObservatoryService
): void {
  app.get("/api/dev/economy/overview", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await authorizeDeveloperHttp(
      request, reply, auth, CAPABILITY, "economy.observatory.overview"
    );
    if (!session) return;
    const query = overviewQuerySchema.safeParse(request.query);
    if (!query.success) {
      sendError(reply, 400, "INVALID_ECONOMY_REQUEST", "Economy Observatory request is invalid");
      return;
    }
    return runRead(reply, auth, session, "economy.observatory.overview", () =>
      observatory.overview(query.data.window)
    );
  });

  app.get("/api/dev/economy/items", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await authorizeDeveloperHttp(
      request, reply, auth, CAPABILITY, "economy.observatory.items"
    );
    if (!session) return;
    const query = itemListQuerySchema.safeParse(request.query);
    if (!query.success) {
      sendError(reply, 400, "INVALID_ECONOMY_REQUEST", "Economy item request is invalid");
      return;
    }
    return runRead(reply, auth, session, "economy.observatory.items", () =>
      observatory.listItems({
        window: query.data.window,
        scope: query.data.scope,
        search: query.data.search,
        limit: query.data.limit,
        page: query.data.page,
        pageSize: query.data.pageSize,
        sort: query.data.sort,
        direction: query.data.direction,
        category: query.data.category,
        assetKind: query.data.assetKind
      })
    );
  });

  app.get("/api/dev/economy/items/:assetId", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const parsedParams = itemParamsSchema.safeParse(request.params);
    const target = parsedParams.success ? parsedParams.data.assetId : null;
    const session = await authorizeDeveloperHttp(
      request, reply, auth, CAPABILITY, "economy.observatory.item", target
    );
    if (!session) return;
    const query = itemDetailQuerySchema.safeParse(request.query);
    if (!parsedParams.success || !query.success) {
      sendError(reply, 400, "INVALID_ECONOMY_REQUEST", "Economy item request is invalid");
      return;
    }
    return runRead(reply, auth, session, "economy.observatory.item", () =>
      observatory.inspectItem(
        parsedParams.data.assetId,
        query.data.scope,
        query.data.window,
        {
          search: query.data.search,
          page: query.data.page,
          pageSize: query.data.pageSize,
          sort: query.data.sort,
          direction: query.data.direction,
          activeOnly: query.data.activeOnly,
          levelMin: query.data.levelMin,
          levelMax: query.data.levelMax,
          kingdom: query.data.kingdom,
          activityCohort: query.data.activityCohort,
          accountAgeCohort: query.data.accountAgeCohort
        }
      )
    , target);
  });

  app.get("/api/dev/economy/players", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await authorizeDeveloperHttp(
      request, reply, auth, CAPABILITY, "economy.observatory.players"
    );
    if (!session) return;
    const query = playerListQuerySchema.safeParse(request.query);
    if (!query.success) {
      sendError(reply, 400, "INVALID_ECONOMY_REQUEST", "Economy player request is invalid");
      return;
    }
    return runRead(reply, auth, session, "economy.observatory.players", () =>
      observatory.listPlayers({
        window: query.data.window,
        search: query.data.search,
        limit: query.data.limit,
        page: query.data.page,
        pageSize: query.data.pageSize,
        sort: query.data.sort,
        direction: query.data.direction,
        activeOnly: query.data.activeOnly,
        lastActiveHours: query.data.lastActiveHours,
        activeGameplayHoursMin: query.data.activeGameplayHoursMin,
        activeGameplayHoursMax: query.data.activeGameplayHoursMax,
        levelMin: query.data.levelMin,
        levelMax: query.data.levelMax,
        kingdom: query.data.kingdom,
        city: query.data.city,
        accountAgeCohort: query.data.accountAgeCohort
      })
    );
  });

  app.get("/api/dev/economy/item-holders", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const query = itemHolderQuerySchema.safeParse(request.query);
    const target = query.success ? query.data.assetId : null;
    const session = await authorizeDeveloperHttp(
      request, reply, auth, CAPABILITY, "economy.observatory.item-holders", target
    );
    if (!session) return;
    if (!query.success) {
      sendError(reply, 400, "INVALID_ECONOMY_REQUEST", "Economy holder request is invalid");
      return;
    }
    return runRead(reply, auth, session, "economy.observatory.item-holders", () =>
      observatory.inspectItem(query.data.assetId, query.data.scope, query.data.window, query.data), target);
  });

  app.get("/api/dev/economy/report", {
    config: { rateLimit: { max: 15, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await authorizeDeveloperHttp(
      request, reply, auth, CAPABILITY, "economy.observatory.report"
    );
    if (!session) return;
    const query = overviewQuerySchema.safeParse(request.query);
    if (!query.success) {
      sendError(reply, 400, "INVALID_ECONOMY_REQUEST", "Economy report request is invalid");
      return;
    }
    return runRead(reply, auth, session, "economy.observatory.report", () => observatory.report(query.data.window));
  });

  app.get("/api/dev/economy/players/:playerId", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const parsedParams = playerParamsSchema.safeParse(request.params);
    const target = parsedParams.success ? parsedParams.data.playerId : null;
    const session = await authorizeDeveloperHttp(
      request, reply, auth, CAPABILITY, "economy.observatory.player", target
    );
    if (!session) return;
    const query = overviewQuerySchema.safeParse(request.query);
    if (!parsedParams.success || !query.success) {
      sendError(reply, 400, "INVALID_ECONOMY_REQUEST", "Economy player request is invalid");
      return;
    }
    return runRead(reply, auth, session, "economy.observatory.player", () =>
      observatory.inspectPlayer(parsedParams.data.playerId, query.data.window), target);
  });

  app.get("/api/dev/economy/cohorts", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await authorizeDeveloperHttp(
      request, reply, auth, CAPABILITY, "economy.observatory.cohorts"
    );
    if (!session) return;
    const query = overviewQuerySchema.safeParse(request.query);
    if (!query.success) {
      sendError(reply, 400, "INVALID_ECONOMY_REQUEST", "Economy cohort request is invalid");
      return;
    }
    return runRead(reply, auth, session, "economy.observatory.cohorts", () =>
      observatory.cohorts(query.data.window)
    );
  });

  app.get("/api/dev/economy/flow", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await authorizeDeveloperHttp(
      request, reply, auth, CAPABILITY, "economy.observatory.flow"
    );
    if (!session) return;
    const query = overviewQuerySchema.safeParse(request.query);
    if (!query.success) {
      sendError(reply, 400, "INVALID_ECONOMY_REQUEST", "Economy flow request is invalid");
      return;
    }
    return runRead(reply, auth, session, "economy.observatory.flow", () =>
      observatory.flow(query.data.window)
    );
  });

  app.get("/api/dev/economy/export.xlsx", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await authorizeDeveloperHttp(
      request, reply, auth, CAPABILITY, "economy.observatory.export"
    );
    if (!session) return;
    const query = overviewQuerySchema.safeParse(request.query);
    if (!query.success) {
      sendError(reply, 400, "INVALID_ECONOMY_REQUEST", "Economy export request is invalid");
      return;
    }
    try {
      const workbook = await observatory.exportWorkbook(query.data.window);
      await recordDeveloperHttpResult(auth, session, {
        capability: CAPABILITY,
        command: "economy.observatory.export",
        outcome: "succeeded"
      });
      return reply
        .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="economy-observatory-${query.data.window}.xlsx"`)
        .send(workbook);
    } catch {
      await recordFailure(auth, session, "economy.observatory.export");
      sendError(reply, 500, "ECONOMY_OBSERVATORY_UNAVAILABLE", "Economy Observatory is temporarily unavailable");
      return undefined;
    }
  });
}

async function runRead<T>(
  reply: Parameters<typeof sendError>[0],
  auth: AuthService,
  session: Parameters<typeof recordDeveloperHttpResult>[1],
  command: string,
  read: () => Promise<T>,
  target: string | null = null
): Promise<T | undefined> {
  try {
    const result = await read();
    await recordDeveloperHttpResult(auth, session, {
      capability: CAPABILITY,
      command,
      target,
      outcome: "succeeded"
    });
    return result;
  } catch {
    await recordFailure(auth, session, command, target);
    sendError(reply, 500, "ECONOMY_OBSERVATORY_UNAVAILABLE", "Economy Observatory is temporarily unavailable");
    return undefined;
  }
}

async function recordFailure(
  auth: AuthService,
  session: Parameters<typeof recordDeveloperHttpResult>[1],
  command: string,
  target: string | null = null
): Promise<void> {
  await recordDeveloperHttpResult(auth, session, {
    capability: CAPABILITY,
    command,
    target,
    outcome: "failed"
  });
}
