import { readFile } from "node:fs/promises";

import {
  ASH_ATLAS_MAX_PROTOCOL_VERSION,
  ASH_ATLAS_MIN_PROTOCOL_VERSION,
  sharedVersionMetadataSchema,
  type SharedVersionMetadata,
  type VersionClients
} from "@ash-atlas/shared";

export const DEFAULT_PUBLIC_RELEASE_METADATA_PATH = "/srv/www/playashatlas/current/release.json";

type JsonRecord = Record<string, unknown>;

export async function readPublishedVersionMetadata(
  releasePath = DEFAULT_PUBLIC_RELEASE_METADATA_PATH
): Promise<SharedVersionMetadata | null> {
  try {
    const source: unknown = JSON.parse(await readFile(releasePath, "utf8"));
    if (!isRecord(source)) return null;

    const clients = readClients(source.clients, source.client_sha);
    const serverVersion = validServerVersion(source.server_version) ??
      validServerVersion(source.server_component_sha);
    const protocolMin = validProtocol(source.protocol_min) ??
      validProtocol(source.server_protocol_min) ?? ASH_ATLAS_MIN_PROTOCOL_VERSION;
    const protocolMax = validProtocol(source.protocol_max) ??
      validProtocol(source.server_protocol_max) ?? ASH_ATLAS_MAX_PROTOCOL_VERSION;
    const publicVersion = source.public_version === undefined || source.public_version === null
      ? null
      : typeof source.public_version === "string" && PUBLIC_VERSION_PATTERN.test(source.public_version)
        ? source.public_version
        : undefined;
    const generationValue = source.generation ?? source.game_generation;
    const generation = generationValue === undefined || generationValue === null
      ? null
      : typeof generationValue === "string" && GENERATION_PATTERN.test(generationValue)
        ? generationValue
        : undefined;
    if (!serverVersion || publicVersion === undefined || generation === undefined) return null;

    const parsed = sharedVersionMetadataSchema.safeParse({
      clients,
      serverVersion,
      protocolMin,
      protocolMax,
      publicVersion,
      generation
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readClients(value: unknown, legacyClientSha: unknown): VersionClients {
  const record = isRecord(value) ? value : {};
  const webValue = isRecord(record.web) ? record.web : {};
  const clientSha = validWebClientSha(webValue.client_sha) ?? validWebClientSha(legacyClientSha);
  const minProtocol = validProtocol(webValue.min_protocol) ?? ASH_ATLAS_MIN_PROTOCOL_VERSION;
  return {
    web: clientSha ? { clientSha, minProtocol } : null,
    ios: readNativeClient(record.ios),
    android: readNativeClient(record.android)
  };
}

function readNativeClient(value: unknown): VersionClients["ios"] {
  if (!isRecord(value)) return null;
  const clientSha = validWebClientSha(value.client_sha);
  const minProtocol = validProtocol(value.min_protocol);
  return clientSha && minProtocol !== null ? { clientSha, minProtocol } : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validWebClientSha(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

function validServerVersion(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/u.test(value) ? value : null;
}

function validProtocol(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

const PUBLIC_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const GENERATION_PATTERN = /^test\/t[0-9]{3,}$/u;
