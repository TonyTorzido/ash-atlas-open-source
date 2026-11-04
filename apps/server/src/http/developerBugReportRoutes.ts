import { z } from "zod";
import type { FastifyInstance } from "fastify";

import type { AuthService } from "../auth/authService.js";
import {
  type ClosedTestTelemetryService,
  type DeveloperBugReportListItem
} from "../telemetry/service.js";
import { sendError } from "./errors.js";
import {
  authorizeDeveloperHttp,
  recordDeveloperHttpResult
} from "./routes/routeAuthentication.js";

const CAPABILITY = "developer:observe" as const;
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();

type BugReportReader = Pick<ClosedTestTelemetryService, "listBugReports">;

export function registerDeveloperBugReportRoutes(
  app: FastifyInstance,
  auth: AuthService,
  telemetry: BugReportReader
): void {
  app.get(
    "/api/dev/bug-reports",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const session = await authorizeDeveloperHttp(
        request,
        reply,
        auth,
        CAPABILITY,
        "bug-reports.list"
      );
      if (!session) return;
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        await recordDeveloperHttpResult(auth, session, {
          capability: CAPABILITY,
          command: "bug-reports.list",
          outcome: "failed"
        });
        sendError(reply, 400, "INVALID_BUG_REPORT_QUERY", "Bug report list request is invalid");
        return;
      }
      try {
        const reports = await telemetry.listBugReports(parsed.data.limit);
        await recordDeveloperHttpResult(auth, session, {
          capability: CAPABILITY,
          command: "bug-reports.list",
          outcome: "succeeded"
        });
        return { reports } satisfies { reports: DeveloperBugReportListItem[] };
      } catch {
        await recordDeveloperHttpResult(auth, session, {
          capability: CAPABILITY,
          command: "bug-reports.list",
          outcome: "failed"
        });
        sendError(
          reply,
          503,
          "BUG_REPORTS_UNAVAILABLE",
          "Bug reports are temporarily unavailable"
        );
      }
    }
  );
}
