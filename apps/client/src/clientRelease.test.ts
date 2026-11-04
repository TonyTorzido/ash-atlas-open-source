import { describe, expect, it, vi } from "vitest";

import {
  ASH_ATLAS_MAX_PROTOCOL_VERSION,
  ASH_ATLAS_MIN_PROTOCOL_VERSION
} from "@ash-atlas/shared";
import {
  checkClientRelease,
  countUnreadPatchNotes,
  createClientVersionSnapshot,
  nativeBundleBehindRelease,
  serverComponentNeedsReleaseCheck
} from "./clientRelease.js";

const clientSha = "c".repeat(64);
const nextClientSha = "e".repeat(64);
const gameSha = "a".repeat(40);
const serverComponentSha = "d".repeat(40);
const createdAt = "2026-09-07T21:16:46.000Z";

describe("client release check", () => {
  it("accepts cleared history without losing update checks and rejects inconsistent empty history", async () => {
    const cleared = release({ patch_notes: [], patch_note_releases: [] });
    await expect(checkClientRelease(clientSha, "https://playashatlas.com",
      async () => response(cleared) as Response)).resolves.toMatchObject({
      status: "current",
      release: { patchNotes: [], patchNoteReleases: [] }
    });
    await expect(checkClientRelease("f".repeat(64), "https://playashatlas.com",
      async () => response(cleared) as Response)).resolves.toMatchObject({ status: "update_available" });
    await expect(checkClientRelease(clientSha, "https://playashatlas.com",
      async () => response(release({ patch_note_releases: [] })) as Response))
      .resolves.toEqual({ status: "unavailable" });
  });

  it("treats game and server-only changes as current when the client build matches", async () => {
    const fetcher = vi.fn(async () => response(release({
      game_sha: "b".repeat(40),
      server_version: "f".repeat(40),
      server_component_sha: "f".repeat(40),
      generation: "test/t10000",
      patch_note_releases: undefined
    })));
    await expect(checkClientRelease(
      clientSha,
      "https://playashatlas.com",
      fetcher as unknown as typeof fetch
    )).resolves.toMatchObject({
      status: "current",
      release: {
        gameSha: "b".repeat(40),
        gameGeneration: "test/t10000",
        clientSha,
        serverVersion: "f".repeat(40)
      }
    });
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/play/release.json" }),
      expect.objectContaining({ cache: "no-store", credentials: "include", signal: expect.any(AbortSignal) })
    );
  });

  it("accepts silent releases, preserves older note history, and keeps its read revision", async () => {
    const prior = release().patch_note_releases as { game_sha: string }[];
    for (const history of [[], prior]) {
      const result = await checkClientRelease(clientSha, "https://playashatlas.com",
        async () => response(release({ game_sha: "b".repeat(40), generation: "test/t1285",
          game_generation: "test/t1285", public_version: "0.1.10", patch_notes: [],
          patch_note_releases: history })) as Response);
      expect(result.status).toBe("current");
      if (result.status === "current") {
        expect(result.release.patchNotes).toEqual([]);
        expect(result.release.patchNoteReleases.map((entry) => entry.gameSha)).toEqual(
          history.map((entry) => entry.game_sha));
        expect(countUnreadPatchNotes(result.release.patchNoteReleases, gameSha)).toBe(0);
      }
    }
  });

  it("offers a nonblocking update for a compatible client-only change or both components", async () => {
    for (const body of [
      release({ clients: { web: { client_sha: nextClientSha, min_protocol: ASH_ATLAS_MIN_PROTOCOL_VERSION }, ios: null, android: null } }),
      release({
        clients: { web: { client_sha: nextClientSha, min_protocol: ASH_ATLAS_MIN_PROTOCOL_VERSION }, ios: null, android: null },
        server_version: "f".repeat(40),
        server_component_sha: "f".repeat(40)
      })
    ]) {
      await expect(checkClientRelease(
        clientSha,
        "https://playashatlas.com",
        async () => response(body) as Response
      )).resolves.toMatchObject({
        status: "update_available",
        release: { clientSha: nextClientSha }
      });
    }
  });

  it("requires a client update when the published protocol range is incompatible", async () => {
    const nextProtocol = ASH_ATLAS_MAX_PROTOCOL_VERSION + 1;
    await expect(checkClientRelease(
      clientSha,
      "https://playashatlas.com",
      async () => response(release({ protocol_min: nextProtocol, protocol_max: nextProtocol })) as Response
    )).resolves.toMatchObject({
      status: "update_required",
      requiredRelease: { clientSha }
    });
  });

  it("accepts the legacy release.json aliases and optional presentation fields", async () => {
    await expect(checkClientRelease(
      clientSha,
      "https://playashatlas.com",
      async () => response({
        game_sha: gameSha,
        client_sha: clientSha,
        server_component_sha: serverComponentSha
      }) as Response
    )).resolves.toMatchObject({
      status: "current",
      release: {
        gameGeneration: null,
        publicVersion: null,
        protocolMin: ASH_ATLAS_MIN_PROTOCOL_VERSION,
        protocolMax: ASH_ATLAS_MAX_PROTOCOL_VERSION,
        clients: { web: { clientSha }, ios: null, android: null },
        patchNotes: [],
        patchNoteReleases: []
      }
    });
  });

  it("rejects malformed version identities while remaining nonblocking when release.json is offline", async () => {
    for (const body of [
      null,
      { ...release(), game_sha: "bad" },
      { ...release(), client_sha: "bad", clients: undefined },
      { ...release(), server_version: "bad", server_component_sha: "bad" },
      { ...release(), public_version: "v1" },
      { ...release(), generation: "test/t12" },
      { ...release(), created_at_utc: "2026-09-07T21:16:46" },
      { ...release(), patch_notes: [""] }
    ]) {
      const fetcher = body === null
        ? vi.fn(async () => response({}, false))
        : vi.fn(async () => response(body));
      await expect(checkClientRelease(
        clientSha,
        "https://playashatlas.com",
        fetcher as unknown as typeof fetch
      )).resolves.toEqual({ status: "unavailable" });
    }
    await expect(checkClientRelease(
      clientSha,
      "https://playashatlas.com",
      async () => { throw new Error("offline"); }
    )).resolves.toEqual({ status: "unavailable" });
  });

  it("compares WELCOME server identity to published server component identity", () => {
    const published = parsedRelease();
    expect(serverComponentNeedsReleaseCheck(published, serverComponentSha)).toBe(false);
    expect(serverComponentNeedsReleaseCheck(published, "e".repeat(40))).toBe(true);
    expect(serverComponentNeedsReleaseCheck(published, "invalid")).toBe(false);
  });

  it("provides a stable version snapshot for the update watermark", () => {
    const snapshot = createClientVersionSnapshot({
      currentClientSha: "c".repeat(64),
      publishedRelease: parsedRelease(),
      currentServerSha: "e".repeat(40),
      currentProtocolMin: ASH_ATLAS_MIN_PROTOCOL_VERSION,
      currentProtocolMax: ASH_ATLAS_MAX_PROTOCOL_VERSION,
      nativeShellBuild: "42"
    });
    expect(snapshot).toMatchObject({
      currentClientSha: clientSha,
      publishedClientSha: clientSha,
      currentServerSha: "e".repeat(40),
      publishedServerSha: serverComponentSha,
      publicVersion: "0.1.4",
      generation: "test/t914",
      protocolCompatible: true,
      clientMatchesPublished: true,
      serverMatchesPublished: false,
      nativeShellBuild: "42"
    });
  });

  it("shows native release metadata without treating its hash as an update gate", async () => {
    const publishedNativeSha = "f".repeat(64);
    const result = await checkClientRelease(clientSha, "https://playashatlas.com", async () =>
      response(release({
        clients: {
          web: { client_sha: clientSha, min_protocol: ASH_ATLAS_MIN_PROTOCOL_VERSION },
          ios: { client_sha: publishedNativeSha, min_protocol: ASH_ATLAS_MIN_PROTOCOL_VERSION },
          android: null
        }
      })) as Response
    );
    expect(result.status).toBe("current");
    if (result.status !== "current") return;
    expect(createClientVersionSnapshot({
      currentClientSha: clientSha,
      publishedRelease: result.release,
      nativePlatform: "ios",
      nativeShellBuild: "1.1.0(8)",
      nativeBundleId: "ios-bundle-a"
    })).toMatchObject({
      publishedClientSha: publishedNativeSha,
      clientMatchesPublished: null,
      nativeBundleId: "ios-bundle-a"
    });
  });

  it("keeps a native bundle behind until it runs the build published for its platform", async () => {
    const publishedNativeSha = "b".repeat(64);
    const result = await checkClientRelease(clientSha, "https://playashatlas.com",
      async () => response(release({
        clients: {
          web: { client_sha: clientSha, min_protocol: ASH_ATLAS_MIN_PROTOCOL_VERSION },
          ios: { client_sha: publishedNativeSha, min_protocol: ASH_ATLAS_MIN_PROTOCOL_VERSION },
          android: null
        }
      })) as Response);
    const published = result.status === "unavailable"
      ? null
      : result.status === "update_required" ? result.requiredRelease : result.release;
    expect(published).not.toBeNull();
    // Stays behind on every poll, however many descriptor checks came back empty,
    // until the running bundle is the published one.
    expect(nativeBundleBehindRelease(published, "ios", "9".repeat(64))).toBe(true);
    expect(nativeBundleBehindRelease(published, "ios", null)).toBe(true);
    expect(nativeBundleBehindRelease(published, "ios", publishedNativeSha)).toBe(false);
    // No published build for the platform, or no release yet: unknown.
    expect(nativeBundleBehindRelease(published, "android", "9".repeat(64))).toBeNull();
    expect(nativeBundleBehindRelease(null, "ios", publishedNativeSha)).toBeNull();
  });

  it("counts unread bullets from the last retained release", () => {
    const releases = [
      { gameSha: "a".repeat(40), gameGeneration: "test/t914", createdAt: null, publicVersion: "0.1.4", patchNotes: ["A", "B"] },
      { gameSha: "b".repeat(40), gameGeneration: "test/t913", createdAt: null, publicVersion: "0.1.3", patchNotes: ["C"] },
      { gameSha: "c".repeat(40), gameGeneration: "test/t912", createdAt: null, publicVersion: "0.1.2", patchNotes: ["D", "E"] }
    ];
    expect(countUnreadPatchNotes(releases, releases[0]!.gameSha)).toBe(0);
    expect(countUnreadPatchNotes(releases, releases[1]!.gameSha)).toBe(2);
    expect(countUnreadPatchNotes(releases, null)).toBe(5);
    expect(countUnreadPatchNotes(releases, "d".repeat(40))).toBe(5);
  });
});

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    game_sha: gameSha,
    game_generation: "test/t914",
    created_at_utc: createdAt,
    client_sha: clientSha,
    clients: { web: { client_sha: clientSha, min_protocol: ASH_ATLAS_MIN_PROTOCOL_VERSION }, ios: null, android: null },
    server_component_sha: serverComponentSha,
    server_version: serverComponentSha,
    protocol_min: ASH_ATLAS_MIN_PROTOCOL_VERSION,
    protocol_max: ASH_ATLAS_MAX_PROTOCOL_VERSION,
    public_version: "0.1.4",
    patch_notes: ["Safer release updates."],
    patch_note_releases: [{
      game_sha: gameSha,
      game_generation: "test/t914",
      created_at_utc: createdAt,
      public_version: "0.1.4",
      patch_notes: ["Safer release updates."]
    }],
    ...overrides
  };
}

function parsedRelease() {
  return {
    gameSha,
    gameGeneration: "test/t914",
    createdAt,
    clientSha,
    clients: { web: { clientSha, minProtocol: ASH_ATLAS_MIN_PROTOCOL_VERSION }, ios: null, android: null },
    serverComponentSha,
    serverVersion: serverComponentSha,
    protocolMin: ASH_ATLAS_MIN_PROTOCOL_VERSION,
    protocolMax: ASH_ATLAS_MAX_PROTOCOL_VERSION,
    publicVersion: "0.1.4",
    patchNotes: ["Safer release updates."],
    patchNoteReleases: []
  } as const;
}

function response(body: unknown, ok = true): Pick<Response, "ok" | "json"> {
  return { ok, json: async () => body };
}
