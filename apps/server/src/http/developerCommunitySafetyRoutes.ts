import { z } from "zod";
import type { FastifyInstance } from "fastify";

import type { AuthService } from "../auth/authService.js";
import type { CommunitySafetyService, UgcReport } from "../communitySafety.js";
import { sendError } from "./errors.js";
import {
  authorizeDeveloperHttp,
  recordDeveloperHttpResult
} from "./routes/routeAuthentication.js";

const CAPABILITY = "developer:observe" as const;
const COMMAND = "community-reports.list";
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100)
}).strict();

type CommunitySafetyReader = Pick<CommunitySafetyService, "listOpenReports">;

/** Read-only operator queue access; report mutation stays behind the staffed review process. */
export function registerDeveloperCommunitySafetyRoutes(
  app: FastifyInstance,
  auth: AuthService,
  safety: CommunitySafetyReader
): void {
  app.get(
    "/api/dev/community-reports",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const session = await authorizeDeveloperHttp(
        request,
        reply,
        auth,
        CAPABILITY,
        COMMAND
      );
      if (!session) return;
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        await recordDeveloperHttpResult(auth, session, {
          capability: CAPABILITY,
          command: COMMAND,
          outcome: "failed"
        });
        sendError(reply, 400, "INVALID_COMMUNITY_REPORT_QUERY", "Community report list request is invalid");
        return;
      }
      try {
        const reports = await safety.listOpenReports(parsed.data.limit);
        await recordDeveloperHttpResult(auth, session, {
          capability: CAPABILITY,
          command: COMMAND,
          outcome: "succeeded"
        });
        return { reports } satisfies { reports: UgcReport[] };
      } catch {
        await recordDeveloperHttpResult(auth, session, {
          capability: CAPABILITY,
          command: COMMAND,
          outcome: "failed"
        });
        sendError(reply, 503, "COMMUNITY_REPORTS_UNAVAILABLE", "Community reports are temporarily unavailable");
      }
    }
  );
}
