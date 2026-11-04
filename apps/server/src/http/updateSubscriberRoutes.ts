import { z } from "zod";
import type { FastifyInstance } from "fastify";

import type { AuthService } from "../auth/authService.js";
import { sendAuthError } from "../auth/authGuard.js";
import {
  CAPACITOR_NATIVE_REQUEST_HEADER,
  isCapacitorNativeRequestHeader
} from "../auth/nativeAppAuthorization.js";
import { sendError } from "./errors.js";
import { authorizeDeveloperHttp, recordDeveloperHttpResult } from "./routes/routeAuthentication.js";
import {
  UPDATE_SUBSCRIBER_EMAIL_MAX_LENGTH,
  type UpdateSubscriber,
  type UpdateSubscriberService
} from "./updateSubscriberService.js";

export const UPDATE_SUBSCRIBE_PATH = "/api/updates/subscribe";
const ADMIN_LIST_CAPABILITY = "developer:test-access-manage" as const;
const ADMIN_LIST_COMMAND = "updates.subscribers.read";

/** The same reply for new, repeat, and honeypot sign-ups so none reveals what is stored. */
const SUBSCRIBED_REPLY = { ok: true, message: "You're on the list." } as const;

const subscribeBodySchema = z.object({
  email: z.string().trim().max(UPDATE_SUBSCRIBER_EMAIL_MAX_LENGTH).email().transform((email) => email.toLowerCase()),
  source: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u).optional(),
  // Honeypot: hidden on the landing form, so only bots fill it.
  website: z.string().max(512).optional()
}).strict();

const listQuerySchema = z.object({
  format: z.enum(["json", "csv"]).default("json")
}).strict();

export function registerUpdateSubscriberRoutes(
  app: FastifyInstance,
  auth: AuthService,
  subscribers: UpdateSubscriberService
): void {
  app.post(
    UPDATE_SUBSCRIBE_PATH,
    {
      bodyLimit: 2_048,
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
          groupId: "updates-subscribe"
        }
      }
    },
    async (request, reply) => {
      try {
        auth.assertOrigin(
          request.headers.origin,
          isCapacitorNativeRequestHeader(request.headers[CAPACITOR_NATIVE_REQUEST_HEADER])
        );
      } catch (error) {
        sendAuthError(reply, error);
        return;
      }
      // A filled honeypot gets the normal reply and stores nothing, whatever else was sent.
      if (honeypotFilled(request.body)) return SUBSCRIBED_REPLY;
      const body = subscribeBodySchema.safeParse(request.body);
      if (!body.success) {
        sendError(reply, 400, "UPDATES_EMAIL_INVALID", "Enter a valid email address.");
        return;
      }
      try {
        const userAgent = request.headers["user-agent"];
        await subscribers.subscribe({
          email: body.data.email,
          source: body.data.source ?? "landing",
          userAgent: typeof userAgent === "string" && userAgent.length > 0 ? userAgent : null,
          ipHash: request.ip ? auth.networkHashForRequest(request.ip) : null
        });
      } catch {
        sendError(reply, 503, "UPDATES_UNAVAILABLE", "Sign-up is unavailable right now. Please try again later.");
        return;
      }
      return SUBSCRIBED_REPLY;
    }
  );

  app.get("/api/admin/updates/subscribers", async (request, reply) => {
    const session = await authorizeDeveloperHttp(
      request,
      reply,
      auth,
      ADMIN_LIST_CAPABILITY,
      ADMIN_LIST_COMMAND
    );
    if (!session) return;
    const query = listQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      sendError(reply, 400, "UPDATES_QUERY_INVALID", "Use format=json or format=csv.");
      return;
    }
    let list: UpdateSubscriber[];
    try {
      list = await subscribers.list();
    } catch {
      await recordDeveloperHttpResult(auth, session, {
        capability: ADMIN_LIST_CAPABILITY,
        command: ADMIN_LIST_COMMAND,
        outcome: "failed"
      });
      sendError(reply, 503, "UPDATES_UNAVAILABLE", "Update subscribers are unavailable right now.");
      return;
    }
    await recordDeveloperHttpResult(auth, session, {
      capability: ADMIN_LIST_CAPABILITY,
      command: ADMIN_LIST_COMMAND,
      outcome: "succeeded"
    });
    reply.header("Cache-Control", "no-store");
    if (query.data.format === "csv") {
      reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="update-subscribers.csv"');
      return subscribersCsv(list);
    }
    return {
      count: list.length,
      active: list.filter((subscriber) => subscriber.unsubscribedAt === null).length,
      subscribers: list
    };
  });
}

function honeypotFilled(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const website = (body as { website?: unknown }).website;
  return website !== undefined && website !== null && String(website).trim() !== "";
}

export function subscribersCsv(list: readonly UpdateSubscriber[]): string {
  const lines = ["email,source,created_at,unsubscribed_at,user_agent"];
  for (const subscriber of list) {
    lines.push(
      [
        subscriber.email,
        subscriber.source ?? "",
        subscriber.createdAt,
        subscriber.unsubscribedAt ?? "",
        subscriber.userAgent ?? ""
      ].map(csvCell).join(",")
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

function csvCell(value: string): string {
  // Neutralize spreadsheet formulas, then quote when the cell needs it.
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
