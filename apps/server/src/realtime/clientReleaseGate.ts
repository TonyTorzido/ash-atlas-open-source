import {
  ASH_ATLAS_CLIENT_RELEASE_QUERY_KEYS,
  type ClientReleasePlatform,
  type SharedVersionMetadata
} from "@ash-atlas/shared";

export type ClientReleaseIdentity = Readonly<{
  platform: ClientReleasePlatform;
  clientSha: string | null;
}>;

// An outdated client keeps playing this long after this server first sees a new
// published client. It covers the whole in-game update: reconnecting after the
// deploy's server restart, noticing the release (10 s poll), the native bundle
// pointer going live after the restart, the 15 s UpdateBanner countdown, and the
// download and reload. Afterwards the client is refused and updates at once.
export const CLIENT_RELEASE_LIVE_GRACE_MS = 90_000;
const METADATA_CACHE_MS = 10_000;

export function clientReleaseIdentityFromQuery(query: unknown): ClientReleaseIdentity {
  const record = query && typeof query === "object" ? query as Record<string, unknown> : {};
  const platform = record[ASH_ATLAS_CLIENT_RELEASE_QUERY_KEYS.platform];
  const clientSha = record[ASH_ATLAS_CLIENT_RELEASE_QUERY_KEYS.clientSha];
  return {
    platform: platform === "ios" || platform === "android" ? platform : "web",
    clientSha: typeof clientSha === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(clientSha)
      ? clientSha
      : null
  };
}

// Only the published client for each platform may play. Without published
// metadata (local and feature runtimes) or a published client for the
// platform, every client is admitted.
export function createClientReleaseGate(
  readMetadata: () => Promise<SharedVersionMetadata | null>,
  now: () => number = Date.now
) {
  let cached: { metadata: SharedVersionMetadata | null; readAt: number } | null = null;
  let pending: Promise<SharedVersionMetadata | null> | null = null;
  const publishedSince = new Map<ClientReleasePlatform, { clientSha: string; at: number }>();

  async function metadata(): Promise<SharedVersionMetadata | null> {
    if (cached && now() - cached.readAt < METADATA_CACHE_MS) return cached.metadata;
    pending ??= readMetadata().catch(() => null).then((value) => {
      cached = { metadata: value, readAt: now() };
      pending = null;
      return value;
    });
    return pending;
  }

  async function expectedClientSha(platform: ClientReleasePlatform): Promise<string | null> {
    const expected = (await metadata())?.clients[platform]?.clientSha ?? null;
    if (expected && publishedSince.get(platform)?.clientSha !== expected) {
      publishedSince.set(platform, { clientSha: expected, at: now() });
    }
    return expected;
  }

  function withinGrace(platform: ClientReleasePlatform): boolean {
    const since = publishedSince.get(platform)?.at ?? now();
    return now() - since < CLIENT_RELEASE_LIVE_GRACE_MS;
  }

  return {
    // Every deploy restarts the server, so players reconnect with the build they
    // were playing; an identified build gets the same grace as a live connection
    // to finish its update countdown. Clients without an identity always update.
    async admitsConnection(identity: ClientReleaseIdentity): Promise<boolean> {
      const expected = await expectedClientSha(identity.platform);
      if (expected === null || identity.clientSha === expected) return true;
      return identity.clientSha !== null && withinGrace(identity.platform);
    },
    async admitsLiveConnection(identity: ClientReleaseIdentity): Promise<boolean> {
      const expected = await expectedClientSha(identity.platform);
      if (expected === null || identity.clientSha === expected) return true;
      return withinGrace(identity.platform);
    }
  };
}

export type ClientReleaseGate = ReturnType<typeof createClientReleaseGate>;
