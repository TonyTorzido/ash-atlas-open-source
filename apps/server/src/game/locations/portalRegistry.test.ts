import type { PlayerLocationSnapshot, PortalDefinition } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { PortalRegistry, PortalRegistryError, validatePortalDefinition } from "./portalRegistry.js";

const world: PlayerLocationSnapshot = {
  kind: "world", regionCode: "NM", zoneId: "world:NM",
  position: { lat: 35, lon: -106 }, revision: 4
};
const foyer = {
  kind: "interior" as const, locationType: "manor" as const,
  locationId: "home", instanceId: "manor:home", spaceId: "manor_foyer",
  position: { x: 10, y: 10 }
};
const main = { ...foyer, spaceId: "manor_main_room", position: { x: 20, y: 20 } };

function portal(overrides: Partial<PortalDefinition> = {}): PortalDefinition {
  return {
    portalId: "manor:home:foyer-to-main",
    source: foyer,
    destination: main,
    sourceApproach: { x: 8, y: 10 },
    sourceThreshold: { x: 10, y: 10 },
    destinationArrival: { x: 18, y: 20 },
    interactionLabel: "Enter Main Hall",
    transitionPresentation: "door",
    enabled: true,
    revision: "7",
    ...overrides
  };
}

describe("PortalRegistry", () => {
  it("validates reciprocal pairs and resolves only from the active space", async () => {
    const registry = new PortalRegistry();
    const forward = portal({ pairedPortalId: "manor:home:main-to-foyer" });
    const reverse = portal({
      portalId: "manor:home:main-to-foyer",
      source: main,
      destination: foyer,
      sourceApproach: { x: 18, y: 20 },
      sourceThreshold: { x: 20, y: 20 },
      destinationArrival: { x: 8, y: 10 },
      pairedPortalId: forward.portalId
    });
    registry.register(forward);
    registry.register(reverse);

    expect(() => registry.validateGraph()).not.toThrow();
    await expect(registry.resolve(forward.portalId, {
      ...world,
      kind: "interior",
      locationType: "manor",
      locationId: "home",
      instanceId: "manor:home",
      spaceId: "manor_foyer",
      regionCode: "interior:manor:home",
      zoneId: "interior:manor:home:manor_foyer",
      position: { x: 8, y: 10 },
      lastPortalId: "entry"
    })).resolves.toEqual(forward);
    await expect(registry.resolve(forward.portalId, {
      kind: "interior", locationType: "manor", locationId: "home",
      instanceId: "manor:home", spaceId: "manor_main_room",
      regionCode: "interior:manor:home", zoneId: "interior:manor:home:manor_main_room",
      position: { x: 18, y: 20 }, revision: 4, lastPortalId: "entry"
    })).rejects.toMatchObject({ code: "PORTAL_SOURCE_MISMATCH" });
  });

  it("fails clearly for a missing pair", () => {
    const registry = new PortalRegistry();
    registry.register(portal({ pairedPortalId: "missing" }));
    expect(() => registry.validateGraph()).toThrowError(PortalRegistryError);
    expect(() => registry.validateGraph()).toThrow(/missing pair/u);
  });

  it("rejects cross-instance room changes and coordinate shapes from another space kind", () => {
    expect(() => validatePortalDefinition(portal({
      destination: { ...main, instanceId: "manor:other" }
    }))).toThrowError(expect.objectContaining({ code: "INSTANCE_CHANGED" }));
    expect(() => validatePortalDefinition(portal({
      destinationArrival: { lat: 35, lon: -106 }
    }))).toThrowError(expect.objectContaining({ code: "INVALID_PORTAL_POSITION" }));
  });
});
