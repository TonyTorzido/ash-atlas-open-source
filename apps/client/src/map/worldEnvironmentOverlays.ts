import {
  WORLD_ENVIRONMENT_OVERLAY_DEFINITION,
  type WorldEnvironmentOverlayGroupId
} from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";

import environmentJungleUrl from "../assets/world-environment-overlays/environment--jungle.png";
import environmentPinewildUrl from "../assets/world-environment-overlays/environment--pinewild.png";
import environmentGreenwoodUrl from "../assets/world-environment-overlays/environment--greenwood.png";
import environmentFrostwoodUrl from "../assets/world-environment-overlays/environment--frostwood.png";
import environmentPlainsUrl from "../assets/world-environment-overlays/environment--plains.png";
import environmentSavannaUrl from "../assets/world-environment-overlays/environment--savanna.png";
import environmentMarshUrl from "../assets/world-environment-overlays/environment--marsh.png";
import environmentHighmeadowUrl from "../assets/world-environment-overlays/environment--highmeadow.png";
import environmentScrublandUrl from "../assets/world-environment-overlays/environment--scrubland.png";
import environmentBadlandsUrl from "../assets/world-environment-overlays/environment--badlands.png";
import environmentSteppeUrl from "../assets/world-environment-overlays/environment--steppe.png";
import environmentTundraUrl from "../assets/world-environment-overlays/environment--tundra.png";
import environmentFrozenWasteUrl from "../assets/world-environment-overlays/environment--frozen_waste.png";
import environmentAllUrl from "../assets/world-environment-overlays/environment--all.png";
import elevationExtremeUrl from "../assets/world-environment-overlays/elevation--extreme.png";
import elevationSummitUrl from "../assets/world-environment-overlays/elevation--summit.png";
import elevationHighUrl from "../assets/world-environment-overlays/elevation--high.png";
import elevationLowUrl from "../assets/world-environment-overlays/elevation--low.png";
import elevationModerateUrl from "../assets/world-environment-overlays/elevation--moderate.png";
import oceanDepthAbyssalUrl from "../assets/world-environment-overlays/ocean_depth--abyssal.png";
import oceanDepthDeepUrl from "../assets/world-environment-overlays/ocean_depth--deep.png";
import oceanDepthNearshoreUrl from "../assets/world-environment-overlays/ocean_depth--nearshore.png";
import oceanDepthShallowUrl from "../assets/world-environment-overlays/ocean_depth--shallow.png";
import waterLakesUrl from "../assets/world-environment-overlays/water--lakes.png";
import waterRiversUrl from "../assets/world-environment-overlays/water--rivers.png";
import terrainFlatUrl from "../assets/world-environment-overlays/terrain--flat.png";
import terrainHillyUrl from "../assets/world-environment-overlays/terrain--hilly.png";
import terrainMountainousUrl from "../assets/world-environment-overlays/terrain--mountainous.png";
import administrativeSubdivisionsUrl from "../assets/world-environment-overlays/north-america-administrative-subdivisions.pmtiles?url";

export const WORLD_ENVIRONMENT_OVERLAY_BORDER_LAYER_ID = "world-map-country-borders";
export const WORLD_ADMINISTRATIVE_SUBDIVISION_LAYER_ID = "world-map-administrative-subdivisions";
const ADMINISTRATIVE_SUBDIVISION_SOURCE_ID = "world-map-administrative-subdivisions-source";
const SOURCE_PREFIX = "world-environment-overlay-source--";
const LAYER_PREFIX = "world-environment-overlay-layer--";
const ENVIRONMENT_ALL_KEY = "environment:all";
const overlayCoordinates = WORLD_ENVIRONMENT_OVERLAY_DEFINITION.bounds.map(
  ([longitude, latitude]) => [longitude, latitude] as [number, number]
) as [[number, number], [number, number], [number, number], [number, number]];

const assetUrls: Readonly<Record<string, string>> = {
  [ENVIRONMENT_ALL_KEY]: environmentAllUrl,
  "environment:jungle": environmentJungleUrl,
  "environment:pinewild": environmentPinewildUrl,
  "environment:greenwood": environmentGreenwoodUrl,
  "environment:frostwood": environmentFrostwoodUrl,
  "environment:plains": environmentPlainsUrl,
  "environment:savanna": environmentSavannaUrl,
  "environment:marsh": environmentMarshUrl,
  "environment:highmeadow": environmentHighmeadowUrl,
  "environment:scrubland": environmentScrublandUrl,
  "environment:badlands": environmentBadlandsUrl,
  "environment:steppe": environmentSteppeUrl,
  "environment:tundra": environmentTundraUrl,
  "environment:frozen_waste": environmentFrozenWasteUrl,
  "elevation:low": elevationLowUrl,
  "elevation:moderate": elevationModerateUrl,
  "elevation:high": elevationHighUrl,
  "elevation:extreme": elevationExtremeUrl,
  "elevation:summit": elevationSummitUrl,
  "terrain:flat": terrainFlatUrl,
  "terrain:hilly": terrainHillyUrl,
  "terrain:mountainous": terrainMountainousUrl,
  "ocean_depth:nearshore": oceanDepthNearshoreUrl,
  "ocean_depth:shallow": oceanDepthShallowUrl,
  "ocean_depth:deep": oceanDepthDeepUrl,
  "ocean_depth:abyssal": oceanDepthAbyssalUrl,
  "water:rivers": waterRiversUrl,
  "water:lakes": waterLakesUrl
};

export const WORLD_ENVIRONMENT_OVERLAY_GROUPS = WORLD_ENVIRONMENT_OVERLAY_DEFINITION.groups;

export type WorldEnvironmentOverlaySelections = Readonly<Record<string, readonly string[]>>;

export function createDefaultWorldEnvironmentOverlaySelections(): WorldEnvironmentOverlaySelections {
  return Object.fromEntries(WORLD_ENVIRONMENT_OVERLAY_GROUPS.map((overlayGroup) => [
    overlayGroup.id,
    overlayGroup.categories
      .filter((category) => category.defaultEnabled)
      .map((category) => category.id)
  ]));
}

export function setWorldEnvironmentOverlayCategory(
  selections: WorldEnvironmentOverlaySelections,
  groupId: WorldEnvironmentOverlayGroupId,
  categoryId: string,
  enabled: boolean
): WorldEnvironmentOverlaySelections {
  const current = new Set(selections[groupId] ?? []);
  if (enabled) current.add(categoryId);
  else current.delete(categoryId);
  return { ...selections, [groupId]: [...current] };
}

export function setAllWorldEnvironmentOverlayCategories(
  selections: WorldEnvironmentOverlaySelections,
  groupId: WorldEnvironmentOverlayGroupId,
  enabled: boolean
): WorldEnvironmentOverlaySelections {
  const overlayGroup = WORLD_ENVIRONMENT_OVERLAY_GROUPS.find(
    (candidate) => candidate.id === groupId
  );
  if (!overlayGroup) return selections;
  return {
    ...selections,
    [groupId]: enabled ? overlayGroup.categories.map((category) => category.id) : []
  };
}

export type WorldEnvironmentOverlayPresenter = Readonly<{
  sync(groupId: WorldEnvironmentOverlayGroupId | null, enabledCategoryIds: readonly string[]): void;
  destroy(): void;
}>;

export function installWorldEnvironmentOverlays(
  map: maplibregl.Map,
  onAssetError: (label: string) => void
): WorldEnvironmentOverlayPresenter {
  let installedGroupId: WorldEnvironmentOverlayGroupId | null = null;
  const installedKeys = new Set<string>();
  const failedSourceIds = new Set<string>();
  const handleError = (event: maplibregl.ErrorEvent): void => {
    const sourceId = "sourceId" in event && typeof event.sourceId === "string"
      ? event.sourceId
      : null;
    if (!sourceId || failedSourceIds.has(sourceId)) return;
    if (sourceId === ADMINISTRATIVE_SUBDIVISION_SOURCE_ID) {
      failedSourceIds.add(sourceId);
      onAssetError("Administrative subdivisions");
      return;
    }
    if (!sourceId.startsWith(SOURCE_PREFIX)) return;
    failedSourceIds.add(sourceId);
    const key = sourceId.slice(SOURCE_PREFIX.length);
    const definition = categoryDefinition(key);
    onAssetError(definition?.label ?? "Environmental overlay");
  };
  map.on("error", handleError);
  map.addSource(ADMINISTRATIVE_SUBDIVISION_SOURCE_ID, {
    type: "raster",
    url: `pmtiles://${new URL(
      administrativeSubdivisionsUrl,
      globalThis.location?.href ?? import.meta.url
    ).toString()}`,
    tileSize: 256,
    minzoom: 0,
    maxzoom: 5
  });
  map.addLayer({
    id: WORLD_ADMINISTRATIVE_SUBDIVISION_LAYER_ID,
    type: "raster",
    source: ADMINISTRATIVE_SUBDIVISION_SOURCE_ID,
    paint: {
      "raster-opacity": 1,
      "raster-fade-duration": 0
    }
  }, WORLD_ENVIRONMENT_OVERLAY_BORDER_LAYER_ID);

  const removeInstalledKeys = (keys: Iterable<string> = installedKeys): void => {
    for (const key of [...keys]) {
      const layerId = layerIdFor(key);
      const sourceId = sourceIdFor(key);
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      installedKeys.delete(key);
    }
  };

  return {
    sync(groupId, enabledCategoryIds) {
      if (installedGroupId !== groupId) {
        removeInstalledKeys();
        installedGroupId = groupId;
      }
      if (!groupId) return;
      const overlayGroup = WORLD_ENVIRONMENT_OVERLAY_GROUPS.find(
        (candidate) => candidate.id === groupId
      );
      if (!overlayGroup) return;
      const enabled = new Set(enabledCategoryIds);
      const validEnabledCategories = overlayGroup.categories.filter((category) =>
        enabled.has(category.id)
      );
      const desiredKeys = groupId === "environment"
        && validEnabledCategories.length === overlayGroup.categories.length
        ? [ENVIRONMENT_ALL_KEY]
        : validEnabledCategories.map((category) => `${groupId}:${category.id}`);
      const desired = new Set(desiredKeys);
      removeInstalledKeys([...installedKeys].filter((key) => !desired.has(key)));
      for (const key of desiredKeys) {
        const category = categoryDefinition(key);
        const sourceId = sourceIdFor(key);
        const layerId = layerIdFor(key);
        if (!installedKeys.has(key)) {
          const assetUrl = assetUrls[key];
          if (!assetUrl) {
            onAssetError(category?.label ?? "Biomes");
            continue;
          }
          map.addSource(sourceId, {
            type: "image",
            url: assetUrl,
            coordinates: overlayCoordinates
          });
          map.addLayer({
            id: layerId,
            type: "raster",
            source: sourceId,
            paint: {
              "raster-opacity": WORLD_ENVIRONMENT_OVERLAY_DEFINITION.defaultOpacity,
              "raster-fade-duration": 0
            }
          }, WORLD_ADMINISTRATIVE_SUBDIVISION_LAYER_ID);
          installedKeys.add(key);
        }
      }
    },
    destroy() {
      map.off("error", handleError);
      removeInstalledKeys();
      if (map.getLayer(WORLD_ADMINISTRATIVE_SUBDIVISION_LAYER_ID)) {
        map.removeLayer(WORLD_ADMINISTRATIVE_SUBDIVISION_LAYER_ID);
      }
      if (map.getSource(ADMINISTRATIVE_SUBDIVISION_SOURCE_ID)) {
        map.removeSource(ADMINISTRATIVE_SUBDIVISION_SOURCE_ID);
      }
    }
  };
}

function categoryDefinition(key: string) {
  const [groupId, categoryId] = key.split(":");
  return WORLD_ENVIRONMENT_OVERLAY_GROUPS
    .find((candidate) => candidate.id === groupId)
    ?.categories.find((candidate) => candidate.id === categoryId);
}

function sourceIdFor(key: string): string {
  return `${SOURCE_PREFIX}${key}`;
}

function layerIdFor(key: string): string {
  return `${LAYER_PREFIX}${key}`;
}
