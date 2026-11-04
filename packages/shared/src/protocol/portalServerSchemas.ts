import { z } from "zod";

const worldPosition = z.object({ lat: z.number().finite().min(-90).max(90), lon: z.number().finite().min(-180).max(180) });
const localPosition = z.object({ x: z.number().finite(), y: z.number().finite() });
const locationType = z.enum(["manor", "salon", "cistern_warrens", "dungeon", "greenhouse"]);
const endpoint = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("world"), regionCode: z.string(), position: worldPosition }),
  z.object({ kind: z.literal("interior"), locationType, locationId: z.string(), instanceId: z.string(), spaceId: z.string(), position: localPosition, facing: z.number().finite().optional() })
]);
const location = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("world"), regionCode: z.string(), zoneId: z.string(), position: worldPosition, revision: z.number().int().nonnegative(), lastPortalId: z.string().optional() }),
  z.object({ kind: z.literal("interior"), locationType, locationId: z.string(), instanceId: z.string(), spaceId: z.string(), regionCode: z.string(), zoneId: z.string(), position: localPosition, facing: z.number().finite().optional(), revision: z.number().int().nonnegative(), lastPortalId: z.string() })
]);

export const portalServerMessageSchemas = {
  PORTAL_TRANSITION_PLANNED: z.object({
    type: z.literal("PORTAL_TRANSITION_PLANNED"), requestId: z.string(), transitionId: z.string(), portalId: z.string(), portalRevision: z.string(), source: endpoint, destination: endpoint,
    sourceApproach: z.union([worldPosition, localPosition]), sourceThreshold: z.union([worldPosition, localPosition]), preloadSceneKey: z.string(), presentation: z.enum(["door", "stairs", "ladder", "hatch", "cave"]), status: z.string()
  }),
  PORTAL_TRANSITION_PHASE: z.object({ type: z.literal("PORTAL_TRANSITION_PHASE"), transitionId: z.string(), phase: z.enum(["approaching", "threshold_reached", "waiting_for_destination", "covered", "committing"]) }),
  PLAYER_LOCATION_SNAPSHOT: z.object({ type: z.literal("PLAYER_LOCATION_SNAPSHOT"), location, transitionId: z.string().optional() }),
  PORTAL_TRANSITION_FAILED: z.object({ type: z.literal("PORTAL_TRANSITION_FAILED"), requestId: z.string().optional(), transitionId: z.string().optional(), code: z.string(), message: z.string(), location })
} as const;
