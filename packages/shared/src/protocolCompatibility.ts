import { z } from "zod";

import {
  ASH_ATLAS_MAX_PROTOCOL_VERSION,
  ASH_ATLAS_MIN_PROTOCOL_VERSION,
  ASH_ATLAS_PROTOCOL_ID,
  ASH_ATLAS_PROTOCOL_VERSION
} from "./version.js";

export {
  ASH_ATLAS_MAX_PROTOCOL_VERSION,
  ASH_ATLAS_MIN_PROTOCOL_VERSION,
  ASH_ATLAS_PROTOCOL_ID,
  ASH_ATLAS_PROTOCOL_VERSION
} from "./version.js";

export const ASH_ATLAS_LEGACY_PROTOCOL_VERSION = 1;
export const ASH_ATLAS_PROTOCOL_CAPABILITIES = [
  "welcome-protocol-metadata",
  "welcome-release-sha",
  "welcome-version-metadata",
  "client-suspend",
  "scoped-flag-snapshots",
  "viewport-flag-loading-v1",
  "prepared-flag-arrival-v1",
  "territory-collapse-v1",
  "skill-unlock-offerings-v1"
] as const;
export const ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_CODE = 4003;
export const ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_REASON = "protocol incompatible";

export const ASH_ATLAS_PROTOCOL_QUERY_KEYS = Object.freeze({
  id: "aaProtocolId",
  minimum: "aaProtocolMin",
  maximum: "aaProtocolMax",
  capabilities: "aaProtocolCapabilities"
});

const protocolVersionSchema = z.number().int().positive().max(1_000_000);
const protocolCapabilitySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);

export const ashAtlasProtocolSupportMetadataSchema = z.object({
  protocolId: z.string().min(1).max(64),
  minVersion: protocolVersionSchema,
  maxVersion: protocolVersionSchema,
  capabilities: z.array(protocolCapabilitySchema).max(16)
}).strict().superRefine((metadata, context) => {
  if (metadata.minVersion > metadata.maxVersion) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "protocol minimum exceeds maximum"
    });
  }
  if (new Set(metadata.capabilities).size !== metadata.capabilities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "protocol capabilities must be unique"
    });
  }
});

export const ashAtlasProtocolWelcomeMetadataSchema = z.object({
  protocolId: z.string().min(1).max(64),
  minVersion: protocolVersionSchema,
  maxVersion: protocolVersionSchema,
  version: protocolVersionSchema,
  capabilities: z.array(protocolCapabilitySchema).max(16)
}).strict().superRefine((metadata, context) => {
  if (metadata.minVersion > metadata.maxVersion) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "protocol minimum exceeds maximum"
    });
  }
  if (metadata.version < metadata.minVersion || metadata.version > metadata.maxVersion) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "negotiated protocol version is outside the advertised range"
    });
  }
  if (new Set(metadata.capabilities).size !== metadata.capabilities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "protocol capabilities must be unique"
    });
  }
});

export type AshAtlasProtocolCapability = (typeof ASH_ATLAS_PROTOCOL_CAPABILITIES)[number];
export type AshAtlasProtocolSupportMetadata = z.infer<
  typeof ashAtlasProtocolSupportMetadataSchema
>;
export type AshAtlasProtocolWelcomeMetadata = z.infer<
  typeof ashAtlasProtocolWelcomeMetadataSchema
>;

export type AshAtlasNegotiatedProtocol = Readonly<{
  protocolId: typeof ASH_ATLAS_PROTOCOL_ID;
  minVersion: number;
  maxVersion: number;
  version: number;
  capabilities: AshAtlasProtocolCapability[];
}>;

export type AshAtlasProtocolNegotiationResult =
  | Readonly<{
      status: "compatible-current" | "compatible-legacy";
      protocol: AshAtlasNegotiatedProtocol;
    }>
  | Readonly<{
      status:
        | "incompatible-peer-too-old"
        | "incompatible-peer-too-new"
        | "invalid-metadata";
      reason: "protocol-id" | "protocol-range" | "protocol-version" | "metadata-shape";
    }>;

export function createAshAtlasProtocolSupportMetadata(): AshAtlasProtocolSupportMetadata {
  return {
    protocolId: ASH_ATLAS_PROTOCOL_ID,
    minVersion: ASH_ATLAS_MIN_PROTOCOL_VERSION,
    maxVersion: ASH_ATLAS_MAX_PROTOCOL_VERSION,
    capabilities: [...ASH_ATLAS_PROTOCOL_CAPABILITIES]
  };
}

export function negotiateAshAtlasProtocol(
  peerMetadata?: unknown
): AshAtlasProtocolNegotiationResult {
  if (peerMetadata === undefined || peerMetadata === null) {
    return {
      status: "compatible-legacy",
      protocol: {
        protocolId: ASH_ATLAS_PROTOCOL_ID,
        minVersion: ASH_ATLAS_MIN_PROTOCOL_VERSION,
        maxVersion: ASH_ATLAS_MAX_PROTOCOL_VERSION,
        version: ASH_ATLAS_LEGACY_PROTOCOL_VERSION,
        capabilities: []
      }
    };
  }

  const parsed = parseProtocolMetadata(peerMetadata);
  if (!parsed) {
    return { status: "invalid-metadata", reason: "metadata-shape" };
  }
  if (parsed.protocolId !== ASH_ATLAS_PROTOCOL_ID) {
    return { status: "invalid-metadata", reason: "protocol-id" };
  }
  if (parsed.maxVersion < ASH_ATLAS_MIN_PROTOCOL_VERSION) {
    return { status: "incompatible-peer-too-old", reason: "protocol-range" };
  }
  if (parsed.minVersion > ASH_ATLAS_MAX_PROTOCOL_VERSION) {
    return { status: "incompatible-peer-too-new", reason: "protocol-range" };
  }

  const selectedVersion = "version" in parsed
    ? parsed.version
    : Math.min(ASH_ATLAS_MAX_PROTOCOL_VERSION, parsed.maxVersion);
  if (
    selectedVersion < ASH_ATLAS_MIN_PROTOCOL_VERSION ||
    selectedVersion > ASH_ATLAS_MAX_PROTOCOL_VERSION ||
    selectedVersion < parsed.minVersion ||
    selectedVersion > parsed.maxVersion
  ) {
    return { status: "invalid-metadata", reason: "protocol-version" };
  }

  const supportedCapabilities = new Set<string>(ASH_ATLAS_PROTOCOL_CAPABILITIES);
  return {
    status: "compatible-current",
    protocol: {
      protocolId: ASH_ATLAS_PROTOCOL_ID,
      minVersion: ASH_ATLAS_MIN_PROTOCOL_VERSION,
      maxVersion: ASH_ATLAS_MAX_PROTOCOL_VERSION,
      version: selectedVersion,
      capabilities: parsed.capabilities.filter(
        (capability): capability is AshAtlasProtocolCapability =>
          supportedCapabilities.has(capability)
      )
    }
  };
}

export function protocolSupportMetadataFromQuery(query: unknown): unknown | undefined {
  if (!query || typeof query !== "object") return undefined;
  const record = query as Record<string, unknown>;
  const id = record[ASH_ATLAS_PROTOCOL_QUERY_KEYS.id];
  const minimum = record[ASH_ATLAS_PROTOCOL_QUERY_KEYS.minimum];
  const maximum = record[ASH_ATLAS_PROTOCOL_QUERY_KEYS.maximum];
  const capabilities = record[ASH_ATLAS_PROTOCOL_QUERY_KEYS.capabilities];
  if (
    id === undefined &&
    minimum === undefined &&
    maximum === undefined &&
    capabilities === undefined
  ) {
    return undefined;
  }
  return {
    protocolId: id,
    minVersion: numericQueryValue(minimum),
    maxVersion: numericQueryValue(maximum),
    capabilities: typeof capabilities === "string" && capabilities.length > 0
      ? capabilities.split(",")
      : capabilities === ""
        ? []
        : capabilities
  };
}

export function addAshAtlasProtocolQuery(searchParams: Pick<URLSearchParams, "set">): void {
  const metadata = createAshAtlasProtocolSupportMetadata();
  searchParams.set(ASH_ATLAS_PROTOCOL_QUERY_KEYS.id, metadata.protocolId);
  searchParams.set(ASH_ATLAS_PROTOCOL_QUERY_KEYS.minimum, String(metadata.minVersion));
  searchParams.set(ASH_ATLAS_PROTOCOL_QUERY_KEYS.maximum, String(metadata.maxVersion));
  searchParams.set(
    ASH_ATLAS_PROTOCOL_QUERY_KEYS.capabilities,
    metadata.capabilities.join(",")
  );
}

function parseProtocolMetadata(
  value: unknown
): AshAtlasProtocolSupportMetadata | AshAtlasProtocolWelcomeMetadata | null {
  const welcome = ashAtlasProtocolWelcomeMetadataSchema.safeParse(value);
  if (welcome.success) return welcome.data;
  const support = ashAtlasProtocolSupportMetadataSchema.safeParse(value);
  return support.success ? support.data : null;
}

function numericQueryValue(value: unknown): unknown {
  if (typeof value !== "string" || !/^[0-9]{1,7}$/.test(value)) return value;
  return Number(value);
}
