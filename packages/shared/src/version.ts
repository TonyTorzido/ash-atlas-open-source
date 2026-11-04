import { z } from "zod";

import protocolVersions from "../../../config/protocol-versions.json" with { type: "json" };

const positiveProtocol = z.number().int().positive().max(1_000_000);
const clientShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const publicVersionSchema = z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u);
const generationSchema = z.string().regex(/^test\/t[0-9]{3,}$/u);

export const ASH_ATLAS_PROTOCOL_ID = protocolVersions.protocol_id;
export const ASH_ATLAS_MIN_PROTOCOL_VERSION = protocolVersions.min_protocol;
export const ASH_ATLAS_MAX_PROTOCOL_VERSION = protocolVersions.max_protocol;
export const ASH_ATLAS_PROTOCOL_VERSION = protocolVersions.max_protocol;

// The game client names its build in the WebSocket URL so the server can refuse
// gameplay to any build other than the one currently published for its platform.
export const ASH_ATLAS_CLIENT_RELEASE_QUERY_KEYS = Object.freeze({
  clientSha: "aaClientSha",
  platform: "aaClientPlatform"
});

export type ClientReleasePlatform = "web" | "ios" | "android";

export const versionClientIdentitySchema = z.object({
  clientSha: clientShaSchema,
  minProtocol: positiveProtocol
}).strict();

export const versionClientsSchema = z.object({
  web: versionClientIdentitySchema.nullable(),
  ios: versionClientIdentitySchema.nullable(),
  android: versionClientIdentitySchema.nullable()
}).strict();

export const sharedVersionMetadataSchema = z.object({
  clients: versionClientsSchema,
  serverVersion: z.string().min(1).max(80).nullable(),
  protocolMin: positiveProtocol,
  protocolMax: positiveProtocol,
  publicVersion: publicVersionSchema.nullable(),
  generation: generationSchema.nullable()
}).strict().superRefine((metadata, context) => {
  if (metadata.protocolMin > metadata.protocolMax) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "version protocol minimum exceeds maximum"
    });
  }
});

export type VersionClientIdentity = z.infer<typeof versionClientIdentitySchema>;
export type VersionClients = z.infer<typeof versionClientsSchema>;
export type SharedVersionMetadata = z.infer<typeof sharedVersionMetadataSchema>;

export function createVersionClients(web: VersionClientIdentity | null): VersionClients {
  return { web, ios: null, android: null };
}

export function protocolRangesOverlap(
  left: Readonly<{ min: number; max: number }>,
  right: Readonly<{ min: number; max: number }>
): boolean {
  return Number.isInteger(left.min) && Number.isInteger(left.max) &&
    Number.isInteger(right.min) && Number.isInteger(right.max) &&
    left.min <= left.max && right.min <= right.max &&
    left.min <= right.max && right.min <= left.max;
}
