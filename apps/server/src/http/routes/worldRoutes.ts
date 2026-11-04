import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { WorldLookupClient } from "../../world/worldLookupClient.js";
import type { HttpAdmissionController } from "../admission.js";
import { sendError } from "../errors.js";
import { createRouteFamily } from "./routeFamily.js";

const lookupQuerySchema = z.object({
  lat: z.coerce.number().finite(),
  lon: z.coerce.number().finite()
});

export function createWorldRoutes(context: Readonly<{
  app: FastifyInstance;
  worldLookup: WorldLookupClient;
  admission: HttpAdmissionController;
}>): void {
  const { app, worldLookup, admission } = context;
  const worldRoutes = createRouteFamily(app, "world");
  worldRoutes.get("/api/world/lookup", async (request, reply) => {
    const query = lookupQuerySchema.safeParse(request.query);
    if (!query.success) {
      sendError(reply, 400, "BAD_LOOKUP_QUERY", "lat and lon query parameters are required");
      return;
    }
    return await worldLookup.lookup(query.data.lat, query.data.lon, {
      signal: admission.signalFor(request)
    });
  });
}
