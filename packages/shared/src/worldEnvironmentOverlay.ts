import definitionJson from "./data/world-environment-overlay-v1.json" with { type: "json" };

export const WORLD_ENVIRONMENT_OVERLAY_DEFINITION = definitionJson;
export const WORLD_ENVIRONMENT_OVERLAY_VERSION =
  WORLD_ENVIRONMENT_OVERLAY_DEFINITION.worldEnvironmentOverlayVersion;

export type WorldEnvironmentOverlayGroupId =
  typeof WORLD_ENVIRONMENT_OVERLAY_DEFINITION.groups[number]["id"];

export type WorldEnvironmentOverlayCategoryId =
  typeof WORLD_ENVIRONMENT_OVERLAY_DEFINITION.groups[number]["categories"][number]["id"];
