import type { PlayerLocationSnapshot, PortalEndpoint, PortalPresentation, PortalTransitionPhase } from "../locations.js";

export type PortalServerMessage =
  | { type: "PORTAL_TRANSITION_PLANNED"; requestId: string; transitionId: string;
      portalId: string; portalRevision: string; source: PortalEndpoint;
      destination: PortalEndpoint; sourceApproach: PortalEndpoint["position"];
      sourceThreshold: PortalEndpoint["position"]; preloadSceneKey: string;
      presentation: PortalPresentation; status: string }
  | { type: "PORTAL_TRANSITION_PHASE"; transitionId: string; phase: PortalTransitionPhase }
  | { type: "PLAYER_LOCATION_SNAPSHOT"; location: PlayerLocationSnapshot; transitionId?: string }
  | { type: "PORTAL_TRANSITION_FAILED"; requestId?: string; transitionId?: string;
      code: string; message: string; location: PlayerLocationSnapshot };
