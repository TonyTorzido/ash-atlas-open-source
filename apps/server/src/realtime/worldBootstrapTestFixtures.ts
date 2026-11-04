import { vi } from "vitest";

import type { PlayerLocationService } from "../game/locations/playerLocationService.js";
import { PortalRegistry } from "../game/locations/portalRegistry.js";

export function worldBootstrapLocationFixtures() {
  return {
    // Exercise bootstrap's world-location fallback from the persisted PlayerRecord.
    playerLocations: { load: vi.fn(async () => null) } as unknown as PlayerLocationService,
    portals: new PortalRegistry()
  };
}
