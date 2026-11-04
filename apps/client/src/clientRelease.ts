import {
  ASH_ATLAS_MAX_PROTOCOL_VERSION,
  ASH_ATLAS_MIN_PROTOCOL_VERSION,
  createVersionClients,
  protocolRangesOverlap,
  type VersionClients
} from "@ash-atlas/shared";

export type PublishedRelease = Readonly<{
  gameSha: string;
  gameGeneration: string | null;
  createdAt: string | null;
  clientSha: string;
  clients: VersionClients;
  serverComponentSha: string;
  serverVersion: string;
  protocolMin: number;
  protocolMax: number;
  publicVersion: string | null;
  patchNotes: readonly string[];
  patchNoteReleases: readonly PatchNoteRelease[];
}>;

export type PatchNoteRelease = Readonly<{
  gameSha: string;
  gameGeneration: string;
  createdAt: string | null;
  publicVersion: string;
  patchNotes: readonly string[];
}>;

export type ClientReleaseStatus =
  | { status: "current"; release: PublishedRelease }
  | { status: "update_available"; release: PublishedRelease }
  | { status: "update_required"; requiredRelease: PublishedRelease }
  | { status: "unavailable" };

export type ClientVersionSnapshot = Readonly<{
  currentClientSha: string | null;
  publishedClientSha: string | null;
  currentServerSha: string | null;
  publishedServerSha: string | null;
  publicVersion: string | null;
  generation: string | null;
  protocolCompatible: boolean | null;
  clientMatchesPublished: boolean | null;
  serverMatchesPublished: boolean | null;
  nativeShellBuild: string | null;
  nativeBundleId: string | null;
}>;

type ReleaseDocument = {
  game_sha?: unknown;
  game_generation?: unknown;
  generation?: unknown;
  created_at_utc?: unknown;
  client_sha?: unknown;
  clients?: unknown;
  server_component_sha?: unknown;
  server_version?: unknown;
  protocol_min?: unknown;
  protocol_max?: unknown;
  server_protocol_min?: unknown;
  server_protocol_max?: unknown;
  public_version?: unknown;
  patch_notes?: unknown;
  patch_note_releases?: unknown;
};

type ReleaseClientDocument = Readonly<{
  client_sha: string;
  min_protocol: number;
}>;

const GAME_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const CLIENT_SHA_PATTERN = /^[a-f0-9]{64}$/u;
const PUBLIC_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const GAME_GENERATION_PATTERN = /^test\/t[0-9]{3,}$/u;
const MAX_PATCH_NOTES = 50;
const MAX_PATCH_NOTE_LENGTH = 160;
const MAX_PATCH_NOTE_RELEASES = 20;

export async function checkClientRelease(
  embeddedClientSha: string,
  origin: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<ClientReleaseStatus> {
  const release = await readPublishedRelease(
    new URL(`/play/release.json?check=${Date.now()}`, origin),
    fetcher
  );
  if (!release) return { status: "unavailable" };

  const protocolCompatible = protocolRangesOverlap(
    { min: ASH_ATLAS_MIN_PROTOCOL_VERSION, max: ASH_ATLAS_MAX_PROTOCOL_VERSION },
    { min: release.protocolMin, max: release.protocolMax }
  );
  if (!protocolCompatible) {
    return { status: "update_required", requiredRelease: release };
  }
  if (release.clientSha !== embeddedClientSha) {
    return { status: "update_available", release };
  }
  return { status: "current", release };
}

// Returns the published web build's download size, or null when the size file
// is missing or describes a different build than the release being offered.
export async function readClientUpdateSize(
  release: PublishedRelease,
  origin: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<number | null> {
  try {
    const response = await fetcher(
      new URL(`/play/client-update.json?check=${release.clientSha}`, origin),
      { method: "GET", cache: "no-store", credentials: "include" }
    );
    if (!response.ok) return null;
    const document = await response.json() as { client_sha?: unknown; download_bytes?: unknown };
    return document.client_sha === release.clientSha &&
      typeof document.download_bytes === "number" &&
      Number.isSafeInteger(document.download_bytes) && document.download_bytes > 0
      ? document.download_bytes
      : null;
  } catch {
    return null;
  }
}

export function createClientVersionSnapshot(input: Readonly<{
  currentClientSha: string | null;
  publishedRelease: PublishedRelease | null;
  currentServerSha?: string | null;
  currentProtocolMin?: number | null;
  currentProtocolMax?: number | null;
  nativeShellBuild?: string | null;
  nativeBundleId?: string | null;
  nativePlatform?: "ios" | "android" | null;
}>): ClientVersionSnapshot {
  const release = input.publishedRelease;
  const currentServerSha = input.currentServerSha ?? null;
  const protocolMin = input.currentProtocolMin ?? ASH_ATLAS_MIN_PROTOCOL_VERSION;
  const protocolMax = input.currentProtocolMax ?? ASH_ATLAS_MAX_PROTOCOL_VERSION;
  return {
    currentClientSha: input.currentClientSha,
    publishedClientSha: input.nativePlatform
      ? release?.clients[input.nativePlatform]?.clientSha ?? null
      : release?.clientSha ?? null,
    currentServerSha,
    publishedServerSha: release?.serverVersion ?? null,
    publicVersion: release?.publicVersion ?? null,
    generation: release?.gameGeneration ?? null,
    protocolCompatible: release
      ? protocolRangesOverlap(
          { min: protocolMin, max: protocolMax },
          { min: release.protocolMin, max: release.protocolMax }
        )
      : null,
    clientMatchesPublished: !input.nativePlatform && release && input.currentClientSha
      ? input.currentClientSha === release.clientSha
      : null,
    serverMatchesPublished: release && currentServerSha
      ? currentServerSha === release.serverVersion
      : null,
    nativeShellBuild: input.nativeShellBuild ?? null,
    nativeBundleId: input.nativeBundleId ?? null
  };
}

async function readPublishedRelease(
  url: URL,
  fetcher: typeof fetch
): Promise<PublishedRelease | null> {
  try {
    const controller = typeof AbortController === "undefined" ? null : new AbortController();
    const timeout = controller
      ? globalThis.setTimeout(() => controller.abort(), 2_000)
      : null;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET",
        cache: "no-store",
        credentials: "include",
        ...(controller ? { signal: controller.signal } : {})
      });
    } finally {
      if (timeout !== null) globalThis.clearTimeout(timeout);
    }
    if (!response.ok) return null;
    const document = await response.json() as ReleaseDocument;
    if (typeof document.game_sha !== "string" || !GAME_SHA_PATTERN.test(document.game_sha)) {
      return null;
    }

    const legacyClientSha = validClientSha(document.client_sha);
    const clientDocument = validReleaseClient(document.clients);
    const clientSha = clientDocument?.clientSha ?? legacyClientSha;
    if (!clientSha) return null;

    const serverVersion = validServerVersion(document.server_version) ??
      validServerVersion(document.server_component_sha);
    if (!serverVersion) return null;
    const protocolMin = validProtocol(document.protocol_min) ??
      validProtocol(document.server_protocol_min) ?? ASH_ATLAS_MIN_PROTOCOL_VERSION;
    const protocolMax = validProtocol(document.protocol_max) ??
      validProtocol(document.server_protocol_max) ?? ASH_ATLAS_MAX_PROTOCOL_VERSION;
    if (protocolMin > protocolMax) return null;

    const publicVersion = document.public_version === undefined
      ? null
      : typeof document.public_version === "string" &&
          PUBLIC_VERSION_PATTERN.test(document.public_version)
        ? document.public_version
        : undefined;
    if (publicVersion === undefined) return null;
    const rawGeneration = document.generation ?? document.game_generation;
    const gameGeneration = rawGeneration === undefined || rawGeneration === null
      ? null
      : validGeneration(rawGeneration);
    if (rawGeneration !== undefined && rawGeneration !== null && gameGeneration === null) return null;
    const createdAt = validCreatedAt(document.created_at_utc);
    if (createdAt === undefined) return null;
    const patchNotes = document.patch_notes === undefined
      ? []
      : validPatchNotes(document.patch_notes);
    if (!patchNotes) return null;
    const patchNoteReleases = document.patch_note_releases === undefined
      ? gameGeneration && publicVersion && patchNotes.length > 0
        ? [{
            gameSha: document.game_sha,
            gameGeneration,
            createdAt,
            publicVersion,
            patchNotes
          }]
        : []
      : validPatchNoteReleases(document.patch_note_releases);
    if (!patchNoteReleases) return null;
    const normalizedPatchNoteReleases = patchNoteReleases.map((release) =>
      release.gameSha === document.game_sha && release.createdAt === null && createdAt !== null
        ? { ...release, createdAt }
        : release
    );
    if (document.patch_note_releases !== undefined) {
      const current = normalizedPatchNoteReleases[0];
      if (patchNotes.length > 0) {
        if (!current || current.gameSha !== document.game_sha ||
            current.gameGeneration !== gameGeneration || current.publicVersion !== publicVersion ||
            !sameNotes(current.patchNotes, patchNotes) ||
            (createdAt !== null && current.createdAt !== createdAt)) return null;
      } else if (current && (!gameGeneration || !publicVersion ||
          generationNumber(gameGeneration) <= generationNumber(current.gameGeneration) ||
          comparePublicVersions(publicVersion, current.publicVersion) <= 0)) return null;
    }
    const clients: VersionClients = {
      ...createVersionClients({
      clientSha,
      minProtocol: clientDocument?.minProtocol ?? ASH_ATLAS_MIN_PROTOCOL_VERSION
      }),
      ios: validNativeReleaseClient(document.clients, "ios"),
      android: validNativeReleaseClient(document.clients, "android")
    };
    return {
      gameSha: document.game_sha,
      gameGeneration,
      createdAt: createdAt ?? normalizedPatchNoteReleases[0]?.createdAt ?? null,
      clientSha,
      clients,
      serverComponentSha: serverVersion,
      serverVersion,
      protocolMin,
      protocolMax,
      publicVersion,
      patchNotes,
      patchNoteReleases: normalizedPatchNoteReleases
    };
  } catch {
    return null;
  }
}

// Whether a native app is running a different bundle than the release publishes
// for its platform: the same test the server's release gate applies. While true,
// the app keeps checking for the bundle, because the OTA pointer goes live after
// the release and server restart. Null when the release names no build for the
// platform, so only a changed release is a reason to check.
export function nativeBundleBehindRelease(
  release: PublishedRelease | null,
  platform: "ios" | "android",
  runningClientSha: string | null
): boolean | null {
  const published = release?.clients[platform]?.clientSha ?? null;
  return published === null ? null : published !== runningClientSha;
}

export function serverComponentNeedsReleaseCheck(
  activeRelease: PublishedRelease,
  serverComponentSha: string
): boolean {
  return GAME_SHA_PATTERN.test(serverComponentSha) &&
    serverComponentSha !== activeRelease.serverComponentSha;
}

export function countUnreadPatchNotes(
  releases: readonly PatchNoteRelease[],
  lastReadGameSha: string | null | undefined
): number {
  if (releases.length === 0 || lastReadGameSha === releases[0]?.gameSha) return 0;
  const lastReadIndex = lastReadGameSha
    ? releases.findIndex(({ gameSha }) => gameSha === lastReadGameSha)
    : -1;
  const unreadReleases = lastReadIndex < 0 ? releases : releases.slice(0, lastReadIndex);
  return unreadReleases.reduce((count, release) => count + release.patchNotes.length, 0);
}

function validReleaseClient(value: unknown): Readonly<{
  clientSha: string;
  minProtocol: number;
}> | null {
  if (!value || typeof value !== "object") return null;
  const web = (value as Record<string, unknown>).web;
  if (!web || typeof web !== "object") return null;
  const record = web as Record<string, unknown>;
  const clientSha = validClientSha(record.client_sha);
  const minProtocol = validProtocol(record.min_protocol);
  if (!clientSha || minProtocol === null) return null;
  return { clientSha, minProtocol };
}

function validNativeReleaseClient(
  value: unknown,
  platform: "ios" | "android"
): VersionClients["ios"] {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[platform];
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const clientSha = validClientSha(record.client_sha);
  const minProtocol = validProtocol(record.min_protocol);
  return clientSha && minProtocol !== null ? { clientSha, minProtocol } : null;
}

function validClientSha(value: unknown): string | null {
  return typeof value === "string" && CLIENT_SHA_PATTERN.test(value) ? value : null;
}

function validServerVersion(value: unknown): string | null {
  return typeof value === "string" && GAME_SHA_PATTERN.test(value) ? value : null;
}

function validGeneration(value: unknown): string | null {
  return typeof value === "string" && GAME_GENERATION_PATTERN.test(value) ? value : null;
}

function validProtocol(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function validPatchNotes(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PATCH_NOTES) return null;
  if (!value.every((note) =>
    typeof note === "string" && note.length > 0 && note.length <= MAX_PATCH_NOTE_LENGTH
  )) return null;
  return value;
}

function validPatchNoteReleases(value: unknown): readonly PatchNoteRelease[] | null {
  if (!Array.isArray(value) || value.length > MAX_PATCH_NOTE_RELEASES) return null;
  const releases: PatchNoteRelease[] = [];
  let noteCount = 0;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return null;
    const entry = candidate as Record<string, unknown>;
    const notes = validPatchNotes(entry.patch_notes);
    const createdAt = validCreatedAt(entry.created_at_utc);
    if (typeof entry.game_sha !== "string" || !GAME_SHA_PATTERN.test(entry.game_sha) ||
        typeof entry.game_generation !== "string" || !GAME_GENERATION_PATTERN.test(entry.game_generation) ||
        typeof entry.public_version !== "string" || !PUBLIC_VERSION_PATTERN.test(entry.public_version) ||
        createdAt === undefined || !notes || notes.length === 0) return null;
    noteCount += notes.length;
    if (noteCount > MAX_PATCH_NOTES) return null;
    releases.push({
      gameSha: entry.game_sha,
      gameGeneration: entry.game_generation,
      createdAt,
      publicVersion: entry.public_version,
      patchNotes: notes
    });
  }
  if (new Set(releases.map(({ gameSha }) => gameSha)).size !== releases.length) return null;
  for (let index = 1; index < releases.length; index += 1) {
    if (generationNumber(releases[index - 1]!.gameGeneration) <= generationNumber(releases[index]!.gameGeneration) ||
        comparePublicVersions(releases[index - 1]!.publicVersion, releases[index]!.publicVersion) <= 0) return null;
  }
  return releases;
}

function generationNumber(value: string): number {
  return Number(value.slice("test/t".length));
}

function comparePublicVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

function sameNotes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((note, index) => note === right[index]);
}

function validCreatedAt(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/(?:[zZ]|[+-][0-9]{2}:[0-9]{2})$/u.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}
