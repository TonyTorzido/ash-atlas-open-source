import type { FastifyInstance } from "fastify";
import { TEST_ACCESS_MODES } from "@ash-atlas/shared";
import { z } from "zod";

import type { AuthService } from "./authService.js";
import { sendAuthError } from "./authGuard.js";
import type { AccountConnectionCloser } from "./authRoutes.js";
import type { TestAccessService } from "./testAccessService.js";
import { AuthError, type AuthenticatedSession } from "./types.js";

const listQuerySchema = z.object({
  status: z.enum(["pending", "approved", "denied", "revoked", "unclaimed", "dev"]).default("pending"),
  search: z.string().max(320).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
}).strict();

const preapproveBodySchema = z.object({
  email: z.string().trim().email().max(320),
  reason: z.string().trim().min(1).max(1000).nullable().optional(),
  operationKey: z.string().trim().min(1).max(255).nullable().optional()
}).strict();

const decisionBodySchema = z.object({
  reason: z.string().trim().min(1).max(1000).nullable().optional(),
  operationKey: z.string().trim().min(1).max(255).nullable().optional()
}).strict();

const accessModeBodySchema = z.object({
  mode: z.enum(TEST_ACCESS_MODES)
}).strict();

const devGrantBodySchema = z.object({
  email: z.string().trim().email().max(320),
  reason: z.string().trim().min(1).max(1000).nullable().optional(),
  operationKey: z.string().trim().min(1).max(255).nullable().optional()
}).strict();

const accountParamsSchema = z.object({ accountId: z.string().uuid() }).strict();
const grantParamsSchema = z.object({ grantId: z.string().uuid() }).strict();

/** Re-runs the gameplay gate for live sockets in this server process. */
export interface LiveSessionRevalidator {
  revalidateLiveSessions(accountId?: string): Promise<void>;
}

export function registerTestAccessRoutes(
  app: FastifyInstance,
  auth: AuthService,
  access: TestAccessService,
  connections: AccountConnectionCloser,
  liveSessions?: LiveSessionRevalidator
): void {
  app.get("/api/admin/test-access/mode", async (request, reply) => {
    try {
      await requireAdministrator(request.authSession, auth, access, "mode.read");
      return await access.readAccessMode();
    } catch (error) {
      sendAuthError(reply, error);
    }
  });

  app.post(
    "/api/admin/test-access/mode",
    { bodyLimit: 1_024 },
    async (request, reply) => {
      try {
        const session = await requireAdministrator(
          request.authSession,
          auth,
          access,
          "mode.change"
        );
        const body = accessModeBodySchema.safeParse(request.body);
        if (!body.success) {
          throw new AuthError(
            "TEST_ACCESS_INVALID_TRANSITION",
            "Invalid test-access mode",
            400
          );
        }
        const result = await access.setAccessMode(session, body.data.mode);
        if (result.mode !== "open") {
          // Closed and dev are more restrictive: kick live sockets that no
          // longer pass now rather than at their next periodic recheck.
          await liveSessions?.revalidateLiveSessions();
        }
        return result;
      } catch (error) {
        sendAuthError(reply, error);
      }
    }
  );

  app.get("/api/admin/test-access", async (request, reply) => {
    try {
      const session = await requireAdministrator(request.authSession, auth, access, "list");
      void session;
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new AuthError("TEST_ACCESS_INVALID_TRANSITION", "Invalid list query", 400);
      }
      return access.list({
        filter: query.data.status,
        search: query.data.search,
        page: query.data.page,
        pageSize: query.data.pageSize
      });
    } catch (error) {
      sendAuthError(reply, error);
    }
  });

  app.post("/api/admin/test-access/preapprove", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const session = await requireAdministrator(
        request.authSession,
        auth,
        access,
        "preapprove"
      );
      const body = preapproveBodySchema.safeParse(request.body);
      if (!body.success) {
        throw new AuthError("TEST_ACCESS_INVALID_TRANSITION", "Enter a valid email", 400);
      }
      return access.preapprove(
        session,
        body.data.email,
        body.data.reason ?? null,
        body.data.operationKey ?? null
      );
    } catch (error) {
      sendAuthError(reply, error);
    }
  });

  for (const action of ["approve", "deny", "revoke", "restore"] as const) {
    app.post(
      `/api/admin/test-access/accounts/:accountId/${action}`,
      { bodyLimit: 2_048 },
      async (request, reply) => {
        try {
          const session = await requireAdministrator(
            request.authSession,
            auth,
            access,
            `account.${action}`
          );
          const params = accountParamsSchema.safeParse(request.params);
          const body = decisionBodySchema.safeParse(request.body ?? {});
          if (!params.success || !body.success) {
            throw new AuthError(
              "TEST_ACCESS_INVALID_TRANSITION",
              "Invalid test-access decision",
              400
            );
          }
          const result = await access.decideAccount(
            session,
            params.data.accountId,
            action,
            body.data.reason ?? null,
            body.data.operationKey ?? null
          );
          if (action === "deny" || action === "revoke") {
            await connections.finalizeAccountConnections(
              params.data.accountId,
              4003,
              action === "revoke" ? "TEST_ACCESS_REVOKED" : "TEST_ACCESS_DENIED"
            );
          }
          return result;
        } catch (error) {
          sendAuthError(reply, error);
        }
      }
    );
  }

  app.post("/api/admin/test-access/dev/grant", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const session = await requireAdministrator(
        request.authSession,
        auth,
        access,
        "dev.grant"
      );
      const body = devGrantBodySchema.safeParse(request.body);
      if (!body.success) {
        throw new AuthError("TEST_ACCESS_INVALID_TRANSITION", "Enter a valid email", 400);
      }
      return await access.grantDevAccessByEmail(
        session,
        body.data.email,
        body.data.reason ?? null,
        body.data.operationKey ?? null
      );
    } catch (error) {
      sendAuthError(reply, error);
    }
  });

  for (const action of ["approve", "deny", "revoke"] as const) {
    app.post(
      `/api/admin/test-access/dev/accounts/:accountId/${action}`,
      { bodyLimit: 2_048 },
      async (request, reply) => {
        try {
          const session = await requireAdministrator(
            request.authSession,
            auth,
            access,
            `dev.${action}`
          );
          const params = accountParamsSchema.safeParse(request.params);
          const body = decisionBodySchema.safeParse(request.body ?? {});
          if (!params.success || !body.success) {
            throw new AuthError(
              "TEST_ACCESS_INVALID_TRANSITION",
              "Invalid dev-access decision",
              400
            );
          }
          const result = await access.decideDevAccess(
            session,
            params.data.accountId,
            action,
            body.data.reason ?? null,
            body.data.operationKey ?? null
          );
          if (action === "revoke") {
            // Outside dev mode this is a no-op recheck; in dev mode it kicks.
            await liveSessions?.revalidateLiveSessions(params.data.accountId);
          }
          return result;
        } catch (error) {
          sendAuthError(reply, error);
        }
      }
    );
  }

  app.post(
    "/api/admin/test-access/grants/:grantId/revoke",
    { bodyLimit: 2_048 },
    async (request, reply) => {
      try {
        const session = await requireAdministrator(
          request.authSession,
          auth,
          access,
          "grant.revoke"
        );
        const params = grantParamsSchema.safeParse(request.params);
        const body = decisionBodySchema.safeParse(request.body ?? {});
        if (!params.success || !body.success) {
          throw new AuthError(
            "TEST_ACCESS_INVALID_TRANSITION",
            "Invalid preapproval revocation",
            400
          );
        }
        return access.revokeGrant(
          session,
          params.data.grantId,
          body.data.reason ?? null,
          body.data.operationKey ?? null
        );
      } catch (error) {
        sendAuthError(reply, error);
      }
    }
  );
}

async function requireAdministrator(
  session: AuthenticatedSession | null,
  auth: AuthService,
  access: TestAccessService,
  command: string
): Promise<AuthenticatedSession> {
  if (!session) {
    await access.recordUnauthorizedAttempt(null, command);
    throw new AuthError("AUTHENTICATION_REQUIRED", "Authentication required", 401);
  }
  if (!auth.hasDeveloperCapability(session, "developer:test-access-manage")) {
    await access.recordUnauthorizedAttempt(session, command);
    throw new AuthError(
      "TEST_ACCESS_ADMIN_FORBIDDEN",
      "Test-access administration is unavailable",
      403
    );
  }
  return session;
}
