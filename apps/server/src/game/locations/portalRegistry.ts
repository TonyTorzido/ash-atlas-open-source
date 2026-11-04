import type { PlayerLocationSnapshot, PortalDefinition } from "@ash-atlas/shared";

export class PortalRegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PortalRegistryError";
  }
}

export type PortalResolver = (
  portalId: string,
  source: PlayerLocationSnapshot,
  context: Readonly<{ playerId: string }>
) => PortalDefinition | null | Promise<PortalDefinition | null>;

/** Typed content registry for static and instance-resolved portal graph edges. */
export class PortalRegistry {
  private readonly definitions = new Map<string, PortalDefinition>();
  private readonly resolvers: PortalResolver[] = [];

  register(definition: PortalDefinition): void {
    validatePortalDefinition(definition);
    if (this.definitions.has(definition.portalId)) {
      throw new PortalRegistryError("DUPLICATE_PORTAL", `Portal ${definition.portalId} is already registered.`);
    }
    this.definitions.set(definition.portalId, definition);
  }

  registerResolver(resolver: PortalResolver): void {
    this.resolvers.push(resolver);
  }

  validateGraph(): void {
    for (const definition of this.definitions.values()) {
      if (!definition.pairedPortalId) continue;
      const paired = this.definitions.get(definition.pairedPortalId);
      if (!paired) {
        throw new PortalRegistryError("MISSING_PAIRED_PORTAL", `Portal ${definition.portalId} references missing pair ${definition.pairedPortalId}.`);
      }
      if (paired.pairedPortalId !== definition.portalId) {
        throw new PortalRegistryError("INVALID_PAIRED_PORTAL", `Portal pair ${definition.portalId}/${paired.portalId} is not reciprocal.`);
      }
      if (!sameEndpoint(definition.source, paired.destination) ||
          !sameEndpoint(definition.destination, paired.source)) {
        throw new PortalRegistryError("INVALID_PAIRED_ENDPOINTS", `Portal pair ${definition.portalId}/${paired.portalId} does not reverse endpoints.`);
      }
    }
  }

  async resolve(
    portalId: string,
    source: PlayerLocationSnapshot,
    context: Readonly<{ playerId: string }> = { playerId: "" }
  ): Promise<PortalDefinition> {
    const registered = this.definitions.get(portalId);
    if (registered) return assertPortalSource(registered, source);
    for (const resolver of this.resolvers) {
      const resolved = await resolver(portalId, source, context);
      if (resolved) {
        validatePortalDefinition(resolved);
        return assertPortalSource(resolved, source);
      }
    }
    throw new PortalRegistryError("PORTAL_NOT_FOUND", "That portal is no longer available.");
  }
}

export function validatePortalDefinition(definition: PortalDefinition): void {
  if (!definition.portalId || !definition.revision) {
    throw new PortalRegistryError("INVALID_PORTAL", "Portal identity and revision are required.");
  }
  assertEndpointPosition(definition.source, definition.sourceApproach, "approach");
  assertEndpointPosition(definition.source, definition.sourceThreshold, "threshold");
  assertEndpointPosition(definition.destination, definition.destinationArrival, "arrival");
  if (definition.source.kind === "interior" && definition.destination.kind === "interior" &&
      definition.source.locationId === definition.destination.locationId &&
      definition.source.locationType === definition.destination.locationType &&
      definition.source.instanceId !== definition.destination.instanceId) {
    throw new PortalRegistryError("INSTANCE_CHANGED", "A same-location space portal must preserve instanceId.");
  }
}

function assertPortalSource(
  definition: PortalDefinition,
  source: PlayerLocationSnapshot
): PortalDefinition {
  const matches = source.kind === "world"
    ? definition.source.kind === "world"
    : definition.source.kind === "interior" &&
      definition.source.instanceId === source.instanceId &&
      definition.source.spaceId === source.spaceId;
  if (!matches) {
    throw new PortalRegistryError("PORTAL_SOURCE_MISMATCH", "That portal is not in your current space.");
  }
  return definition;
}

function assertEndpointPosition(
  endpoint: PortalDefinition["source"],
  position: PortalDefinition["sourceApproach"],
  label: string
): void {
  const correct = endpoint.kind === "world"
    ? "lat" in position && "lon" in position
    : "x" in position && "y" in position;
  if (!correct) {
    throw new PortalRegistryError("INVALID_PORTAL_POSITION", `Portal ${label} does not belong to its declared space.`);
  }
}

function sameEndpoint(
  left: PortalDefinition["source"],
  right: PortalDefinition["source"]
): boolean {
  return left.kind === "world" && right.kind === "world"
    ? left.regionCode === right.regionCode
    : left.kind === "interior" && right.kind === "interior" &&
      left.locationType === right.locationType && left.locationId === right.locationId &&
      left.instanceId === right.instanceId && left.spaceId === right.spaceId;
}
