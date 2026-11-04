import type {
  GreenhouseCropCatalogSnapshot,
  GreenhouseStateSnapshot,
  RuntimePngGreenhouseCropPresentation
} from "@ash-atlas/shared";

import { activeRuntimePngContentPack } from "../content/runtimePngContentPack.js";
import {
  enabledGreenhouseCropDefinition,
  greenhouseCropCatalogForPack,
  greenhouseCropPresentationMatchesDefinition
} from "./greenhouseCrops.js";

export function greenhouseCropCatalogForClientPack(
  activePackId: string | null,
  presentations: readonly RuntimePngGreenhouseCropPresentation[],
  clientPackId: string | null | undefined
): GreenhouseCropCatalogSnapshot {
  const selectedPackId = activePackId && activePackId === clientPackId ? activePackId : null;
  return {
    packId: selectedPackId,
    crops: greenhouseCropCatalogForPack(selectedPackId ? presentations : [])
  };
}

export async function greenhouseStateForCropCapableClient(
  state: GreenhouseStateSnapshot,
  clientCatalogVersion: number | undefined,
  clientPackId: string | null | undefined
): Promise<GreenhouseStateSnapshot> {
  if (clientCatalogVersion !== 1) return state;
  try {
    const pack = await activeRuntimePngContentPack();
    return {
      ...state,
      cropCatalog: greenhouseCropCatalogForClientPack(
        pack?.manifest.packId ?? null,
        pack?.manifest.greenhouseCropPresentations ?? [],
        clientPackId
      )
    };
  } catch {
    return {
      ...state,
      cropCatalog: greenhouseCropCatalogForClientPack(null, [], clientPackId)
    };
  }
}

export async function greenhousePlantPresentationIsCurrent(
  cropId: string,
  requestedPackId: string,
  clientPackId: string | null | undefined
): Promise<boolean> {
  if (requestedPackId !== clientPackId) return false;
  try {
    const pack = await activeRuntimePngContentPack();
    if (!pack || pack.manifest.packId !== requestedPackId) return false;
    const crop = enabledGreenhouseCropDefinition(cropId);
    if (!crop) return false;
    const presentation = pack.manifest.greenhouseCropPresentations.find((candidate) => candidate.cropId === cropId);
    return Boolean(presentation && greenhouseCropPresentationMatchesDefinition(presentation, crop));
  } catch {
    return false;
  }
}
