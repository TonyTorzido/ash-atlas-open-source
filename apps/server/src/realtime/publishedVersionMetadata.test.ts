import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ASH_ATLAS_MAX_PROTOCOL_VERSION,
  ASH_ATLAS_MIN_PROTOCOL_VERSION
} from "@ash-atlas/shared";
import { readPublishedVersionMetadata } from "./publishedVersionMetadata.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("published WELCOME version metadata", () => {
  it("reads current web, server, protocol, public version, and generation from the active release file", async () => {
    const path = await writeRelease({
      clients: {
        web: { client_sha: "a".repeat(64), min_protocol: ASH_ATLAS_MIN_PROTOCOL_VERSION },
        ios: null,
        android: null
      },
      server_version: "b".repeat(40),
      protocol_min: ASH_ATLAS_MIN_PROTOCOL_VERSION,
      protocol_max: ASH_ATLAS_MAX_PROTOCOL_VERSION,
      public_version: "1.4.2",
      generation: "test/t10000"
    });

    await expect(readPublishedVersionMetadata(path)).resolves.toEqual({
      clients: {
        web: { clientSha: "a".repeat(64), minProtocol: ASH_ATLAS_MIN_PROTOCOL_VERSION },
        ios: null,
        android: null
      },
      serverVersion: "b".repeat(40),
      protocolMin: ASH_ATLAS_MIN_PROTOCOL_VERSION,
      protocolMax: ASH_ATLAS_MAX_PROTOCOL_VERSION,
      publicVersion: "1.4.2",
      generation: "test/t10000"
    });
  });

  it("parses legacy release.json aliases without reporting a connecting client's identity", async () => {
    const path = await writeRelease({
      client_sha: "c".repeat(64),
      server_component_sha: "d".repeat(40),
      game_generation: "test/t914"
    });

    await expect(readPublishedVersionMetadata(path)).resolves.toMatchObject({
      clients: { web: { clientSha: "c".repeat(64) }, ios: null, android: null },
      serverVersion: "d".repeat(40),
      publicVersion: null,
      generation: "test/t914"
    });
  });

  it("returns null for missing or invalid published metadata", async () => {
    const path = await writeRelease({
      client_sha: "bad",
      server_component_sha: "bad",
      public_version: "v1"
    });
    await expect(readPublishedVersionMetadata(path)).resolves.toBeNull();
    await expect(readPublishedVersionMetadata(join(path, "missing"))).resolves.toBeNull();
  });
});

async function writeRelease(document: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ash-atlas-version-"));
  directories.push(directory);
  const path = join(directory, "release.json");
  await writeFile(path, JSON.stringify(document), "utf8");
  return path;
}
