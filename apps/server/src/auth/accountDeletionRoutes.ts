import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";

import { requireRequestSession, sendAuthError } from "./authGuard.js";
import type { AuthService } from "./authService.js";
import {
  ACCOUNT_DELETION_CONFIRMATION,
  type AccountDeletionService
} from "./accountDeletionService.js";
import type { AccountConnectionCloser } from "./authRoutes.js";
import type { AppConfig } from "../config.js";
import {
  CAPACITOR_NATIVE_REQUEST_HEADER,
  isCapacitorNativeRequestHeader
} from "./nativeAppAuthorization.js";

const authenticatedRequestBodySchema = z.object({
  confirmation: z.literal(ACCOUNT_DELETION_CONFIRMATION)
}).strict();

const publicRequestBodySchema = z.object({
  email: z.string().trim().email().max(320)
}).strict();

export function registerAccountDeletionRoutes(
  app: FastifyInstance,
  auth: AuthService,
  deletion: AccountDeletionService,
  config: AppConfig,
  connections: AccountConnectionCloser
): void {
  app.post(
    "/api/account/deletion-request",
    {
      bodyLimit: 1_024,
      config: {
        rateLimit: {
          max: 3,
          timeWindow: "1 hour",
          groupId: "account-deletion-authenticated"
        }
      }
    },
    async (request, reply) => {
      try {
        const session = requireRequestSession(request);
        const body = authenticatedRequestBodySchema.safeParse(request.body);
        if (!body.success) {
          reply.code(400).send({
            error: {
              code: "DELETION_CONFIRMATION_REQUIRED",
              message: `Type ${ACCOUNT_DELETION_CONFIRMATION} to confirm account deletion`
            }
          });
          return;
        }
        const result = await deletion.requestAuthenticated({
          accountId: session.account.id,
          verifiedEmail: session.verifiedEmail
        });
        await connections.finalizeAccountConnections(
          session.account.id,
          4002,
          "account deletion requested"
        );
        await auth.logoutAll(session);
        clearSessionCookie(reply, auth, config);
        reply.code(202);
        return {
          accepted: true,
          requestId: result.requestId,
          status: result.status,
          message: "Your deletion request was received and is pending manual processing."
        };
      } catch (error) {
        sendAuthError(reply, error);
      }
    }
  );

  app.post(
    "/api/account/deletion-request/public",
    {
      bodyLimit: 2_048,
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 hour",
          groupId: "account-deletion-public"
        }
      }
    },
    async (request, reply) => {
      try {
        auth.assertOrigin(
          request.headers.origin,
          isCapacitorNativeRequestHeader(request.headers[CAPACITOR_NATIVE_REQUEST_HEADER])
        );
        const body = publicRequestBodySchema.safeParse(request.body);
        if (!body.success) {
          reply.code(400).send({
            error: {
              code: "DELETION_EMAIL_INVALID",
              message: "Enter a valid email address"
            }
          });
          return;
        }
        await deletion.requestPublic(body.data.email);
        reply.code(202);
        return {
          accepted: true,
          message:
            "Your request was received. Support will verify ownership before any account or data is deleted."
        };
      } catch (error) {
        sendAuthError(reply, error);
      }
    }
  );
}

function clearSessionCookie(
  reply: FastifyReply,
  auth: AuthService,
  config: AppConfig
): void {
  reply.clearCookie(auth.sessionCookieName, {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax",
    path: "/"
  });
}
