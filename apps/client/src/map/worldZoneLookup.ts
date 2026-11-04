import { parseWorldZoneLookup, type WorldZoneLookup } from "@ash-atlas/shared";

import lookupUrl from "../assets/world-environment-overlays/world-zone-lookup-v1.bin?url";

export type { WorldZoneLookup } from "@ash-atlas/shared";

let pendingLookup: Promise<WorldZoneLookup | null> | null = null;

/** Fetches the lookup once, lazily. Resolves null when it cannot be loaded (banner stays hidden). */
export function loadWorldZoneLookup(): Promise<WorldZoneLookup | null> {
  pendingLookup ??= fetch(lookupUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`world zone lookup HTTP ${response.status}`);
      return response.arrayBuffer();
    })
    .then(parseWorldZoneLookup)
    .catch((error: unknown) => {
      console.warn("world zone lookup unavailable", error);
      return null;
    });
  return pendingLookup;
}
