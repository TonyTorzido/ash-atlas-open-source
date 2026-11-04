import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  TRUST_ALERT_ACTIONS,
  trustAlertListQuerySchema,
  trustLabProfileSchema,
  trustQuarantineArrivalsRequestSchema,
  trustUnanchoredRoutesQuerySchema,
  type TrustAdminAccountDetailResponse,
  type TrustAdminAccountListResponse,
  type TrustAdminAlertDecisionResponse,
  type TrustAdminAlertListResponse,
  type TrustAdminSettlementActionResponse,
  type TrustAdminUnanchoredRoutesResponse,
  type TrustAlertAction,
  type TrustLabDryRunResponse,
  type TrustQuarantineArrivalsResponse
} from "@ash-atlas/shared";

import type { AuthService } from "../auth/authService.js";
import type { TrustAdminOps } from "../auth/trust/trustAdminOps.js";
import type { TrustLab } from "../auth/trust/trustLab.js";
import type { TrustAdminStore } from "../auth/trust/trustStore.js";
import { sendError } from "./errors.js";
import {
  authorizeDeveloperHttp,
  recordDeveloperHttpResult
} from "./routes/routeAuthentication.js";

const CAPABILITY = "developer:test-access-manage" as const;
const LIST_COMMAND = "trust.accounts.list";
const DETAIL_COMMAND = "trust.accounts.detail";
const RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
const MUTATION_OPTIONS = {
  bodyLimit: 1_024,
  config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
};
const LAB_OPTIONS = {
  bodyLimit: 4_096,
  config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
};

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  minLogodds: z.coerce.number().finite().default(0)
}).strict();
const paramsSchema = z.object({ id: z.string().uuid() }).strict();
const alertActionParamsSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(TRUST_ALERT_ACTIONS)
}).strict();

/**
 * Operator view of the account trust ledger (shadow signals) and, when `ops`
 * is given, the alert inbox, Settled overrides, arrival quarantine and the
 * unanchored-routes report, and when `lab` is given the Trust Lab dry run
 * (simulated profile through the live decision code; writes nothing).
 * State-changing routes sit behind the global auth guard (origin + CSRF) and
 * the developer:test-access-manage capability.
 */
export function registerDeveloperTrustRoutes(
  app: FastifyInstance,
  auth: AuthService,
  store: TrustAdminStore,
  config: Readonly<{ TRUST_DECAY_TAU_DAYS: number }>,
  now: () => Date = () => new Date(),
  ops?: TrustAdminOps,
  lab?: Pick<TrustLab, "dryRun">
): void {
  if (ops) registerTrustAdminOpsRoutes(app, auth, ops, now);
  if (lab) registerTrustLabRoute(app, auth, lab);

  app.get("/api/dev/trust/accounts", RATE_LIMIT, async (request, reply) => {
    const session = await authorizeDeveloperHttp(request, reply, auth, CAPABILITY, LIST_COMMAND);
    if (!session) return;
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command: LIST_COMMAND, outcome: "failed" });
      sendError(reply, 400, "INVALID_TRUST_QUERY", "Trust account list request is invalid");
      return;
    }
    try {
      const at = now();
      const accounts = await store.listTopAccounts({
        limit: parsed.data.limit,
        minLogodds: parsed.data.minLogodds,
        now: at,
        tauDays: config.TRUST_DECAY_TAU_DAYS
      });
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command: LIST_COMMAND, outcome: "succeeded" });
      return { accounts, generatedAt: at.toISOString() } satisfies TrustAdminAccountListResponse;
    } catch {
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command: LIST_COMMAND, outcome: "failed" });
      sendError(reply, 503, "TRUST_UNAVAILABLE", "Trust data is temporarily unavailable");
    }
  });

  app.get("/api/dev/trust/accounts/:id", RATE_LIMIT, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const target = params.success ? params.data.id : null;
    const session = await authorizeDeveloperHttp(request, reply, auth, CAPABILITY, DETAIL_COMMAND, target);
    if (!session) return;
    if (!params.success) {
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command: DETAIL_COMMAND, outcome: "failed" });
      sendError(reply, 400, "INVALID_TRUST_QUERY", "Trust account id is invalid");
      return;
    }
    try {
      const at = now();
      const account = await store.accountDetail(params.data.id, at, config.TRUST_DECAY_TAU_DAYS);
      await recordDeveloperHttpResult(auth, session, {
        capability: CAPABILITY,
        command: DETAIL_COMMAND,
        target: params.data.id,
        outcome: account ? "succeeded" : "failed"
      });
      if (!account) {
        sendError(reply, 404, "TRUST_ACCOUNT_NOT_FOUND", "Account not found");
        return;
      }
      return { account, generatedAt: at.toISOString() } satisfies TrustAdminAccountDetailResponse;
    } catch {
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command: DETAIL_COMMAND, target: params.data.id, outcome: "failed" });
      sendError(reply, 503, "TRUST_UNAVAILABLE", "Trust data is temporarily unavailable");
    }
  });
}

type Reply = Parameters<typeof sendError>[0];
type DeveloperSession = Parameters<typeof recordDeveloperHttpResult>[1];

function registerTrustAdminOpsRoutes(
  app: FastifyInstance,
  auth: AuthService,
  ops: TrustAdminOps,
  now: () => Date
): void {
  const fail = async (
    reply: Reply,
    session: DeveloperSession,
    command: string,
    target: string | null,
    status: number,
    code: string,
    message: string
  ): Promise<void> => {
    await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command, target, outcome: "failed" });
    sendError(reply, status, code, message);
  };
  const succeed = (session: DeveloperSession, command: string, target: string | null): Promise<void> =>
    recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command, target, outcome: "succeeded" });
  const unavailable = (reply: Reply, session: DeveloperSession, command: string, target: string | null) =>
    fail(reply, session, command, target, 503, "TRUST_UNAVAILABLE", "Trust data is temporarily unavailable");

  app.get("/api/dev/trust/alerts", RATE_LIMIT, async (request, reply) => {
    const command = "trust.alerts.list";
    const session = await authorizeDeveloperHttp(request, reply, auth, CAPABILITY, command);
    if (!session) return;
    const parsed = trustAlertListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      await fail(reply, session, command, null, 400, "INVALID_TRUST_QUERY", "Trust alert list request is invalid");
      return;
    }
    try {
      const { alerts, total } = await ops.listAlerts(parsed.data);
      await succeed(session, command, null);
      return {
        alerts,
        total,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        generatedAt: now().toISOString()
      } satisfies TrustAdminAlertListResponse;
    } catch {
      await unavailable(reply, session, command, null);
    }
  });

  app.post("/api/dev/trust/alerts/:id/:action", MUTATION_OPTIONS, async (request, reply) => {
    const params = alertActionParamsSchema.safeParse(request.params);
    const action: TrustAlertAction | null = params.success ? params.data.action : null;
    const command = `trust.alerts.${action ?? "decide"}`;
    const target = params.success ? params.data.id : null;
    const session = await authorizeDeveloperHttp(request, reply, auth, CAPABILITY, command, target);
    if (!session) return;
    if (!params.success) {
      await fail(reply, session, command, target, 400, "INVALID_TRUST_QUERY", "Trust alert request is invalid");
      return;
    }
    try {
      const result = await ops.decideAlert(params.data.id, params.data.action, session.account.id);
      if (result.outcome === "not_found") {
        await fail(reply, session, command, target, 404, "TRUST_ALERT_NOT_FOUND", "Alert not found");
        return;
      }
      if (result.outcome === "invalid_state") {
        await fail(reply, session, command, target, 409, "TRUST_ALERT_STATE_CONFLICT", "This alert was already decided");
        return;
      }
      await succeed(session, command, target);
      return { alert: result.alert, generatedAt: now().toISOString() } satisfies TrustAdminAlertDecisionResponse;
    } catch {
      await unavailable(reply, session, command, target);
    }
  });

  for (const action of ["settle", "unsettle"] as const) {
    const command = `trust.accounts.${action}`;
    app.post(`/api/dev/trust/accounts/:id/${action}`, MUTATION_OPTIONS, async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const target = params.success ? params.data.id : null;
      const session = await authorizeDeveloperHttp(request, reply, auth, CAPABILITY, command, target);
      if (!session) return;
      if (!params.success) {
        await fail(reply, session, command, target, 400, "INVALID_TRUST_QUERY", "Trust account id is invalid");
        return;
      }
      try {
        const outcome = action === "settle"
          ? await ops.settle(params.data.id, session.account.id)
          : await ops.unsettle(params.data.id, session.account.id);
        if (outcome === "not_found") {
          await fail(reply, session, command, target, 404, "TRUST_ACCOUNT_NOT_FOUND", "Account not found");
          return;
        }
        if (outcome === "no_home") {
          await fail(reply, session, command, target, 409, "TRUST_NO_HOME", "This account has no home to settle at yet");
          return;
        }
        const settlement = await ops.settlementView(params.data.id);
        await succeed(session, command, target);
        return {
          accountId: params.data.id,
          settlement,
          generatedAt: now().toISOString()
        } satisfies TrustAdminSettlementActionResponse;
      } catch {
        await unavailable(reply, session, command, target);
      }
    });
  }

  app.post("/api/dev/trust/accounts/:id/quarantine-arrivals", MUTATION_OPTIONS, async (request, reply) => {
    const command = "trust.accounts.quarantine-arrivals";
    const params = paramsSchema.safeParse(request.params);
    const target = params.success ? params.data.id : null;
    const session = await authorizeDeveloperHttp(request, reply, auth, CAPABILITY, command, target);
    if (!session) return;
    const body = trustQuarantineArrivalsRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      await fail(reply, session, command, target, 400, "INVALID_TRUST_QUERY", "Quarantine request is invalid");
      return;
    }
    try {
      const since = new Date(body.data.since);
      const result = await ops.quarantineArrivals({
        hostAccountId: params.data.id,
        since,
        confirm: body.data.confirm,
        expectedCount: body.data.expectedCount,
        adminAccountId: session.account.id
      });
      if (result.outcome === "not_found") {
        await fail(reply, session, command, target, 404, "TRUST_ACCOUNT_NOT_FOUND", "Account not found");
        return;
      }
      if (result.outcome === "count_mismatch") {
        await fail(
          reply, session, command, target, 409, "TRUST_QUARANTINE_CHANGED",
          "The arrivals changed since the preview; review the count again"
        );
        return;
      }
      await succeed(session, command, target);
      return {
        hostAccountId: params.data.id,
        since: since.toISOString(),
        dryRun: result.dryRun,
        guestCount: result.guestCount,
        suspendedCount: result.suspendedCount
      } satisfies TrustQuarantineArrivalsResponse;
    } catch {
      await unavailable(reply, session, command, target);
    }
  });

  app.get("/api/dev/trust/unanchored-routes", RATE_LIMIT, async (request, reply) => {
    const command = "trust.unanchored-routes";
    const session = await authorizeDeveloperHttp(request, reply, auth, CAPABILITY, command);
    if (!session) return;
    const parsed = trustUnanchoredRoutesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      await fail(reply, session, command, null, 400, "INVALID_TRUST_QUERY", "Unanchored routes request is invalid");
      return;
    }
    try {
      const { since, routes } = await ops.unanchoredRoutes(parsed.data.days, parsed.data.limit);
      await succeed(session, command, null);
      return {
        routes,
        since: since.toISOString(),
        generatedAt: now().toISOString()
      } satisfies TrustAdminUnanchoredRoutesResponse;
    } catch {
      await unavailable(reply, session, command, null);
    }
  });
}

function registerTrustLabRoute(app: FastifyInstance, auth: AuthService, lab: Pick<TrustLab, "dryRun">): void {
  const command = "trust.lab.dry-run";
  app.post("/api/dev/trust/lab/dry-run", LAB_OPTIONS, async (request, reply) => {
    const session = await authorizeDeveloperHttp(request, reply, auth, CAPABILITY, command);
    if (!session) return;
    const parsed = trustLabProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command, outcome: "failed" });
      sendError(reply, 400, "INVALID_TRUST_LAB_PROFILE", parsed.error.issues[0]?.message ?? "Trust Lab profile is invalid");
      return;
    }
    try {
      const result = await lab.dryRun(parsed.data);
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command, outcome: "succeeded" });
      return result satisfies TrustLabDryRunResponse;
    } catch {
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command, outcome: "failed" });
      sendError(reply, 503, "TRUST_UNAVAILABLE", "Trust data is temporarily unavailable");
    }
  });
}
