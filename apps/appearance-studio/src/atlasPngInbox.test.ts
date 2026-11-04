import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  atlasPngFileStem,
  discoverAtlasPngSourceAssets,
  resolveAtlasPngDestination
} from "./atlasPngInbox.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AtlasPNGS inbox discovery", () => {
  it("discovers valid top-level PNGs with a safe canonical target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ash-atlas-inbox-"));
    createdRoots.push(root);
    await writeFile(path.join(root, "WildFlax.png"), ONE_PIXEL_PNG);
    await writeFile(path.join(root, "notes.txt"), "not an image");
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "SulfurMine.png"), ONE_PIXEL_PNG);

    const assets = await discoverAtlasPngSourceAssets(root);

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      sourceFile: "WildFlax.png",
      label: "Wild Flax",
      destinationFile: "apps/client/src/assets/wild-flax.png",
      width: 1,
      height: 1,
      bytes: ONE_PIXEL_PNG.length
    });
    expect(await readFile(assets[0]!.sourcePath)).toEqual(ONE_PIXEL_PNG);
  });

  it("normalizes camel case and rejects unusable names", () => {
    expect(atlasPngFileStem("SulfurMine.PNG")).toBe("sulfur-mine");
    expect(atlasPngFileStem("  ...PNG")).toBeNull();
  });

  it("maps uniquely registered top-level names to their nested production slots", () => {
    expect(resolveAtlasPngDestination("loom")).toEqual({
      destinationFile: "apps/client/src/assets/structures/loom.png",
      destinationCandidates: ["apps/client/src/assets/structures/loom.png"],
      mappingStatus: "registered"
    });
    expect(resolveAtlasPngDestination("barracks").destinationFile)
      .toBe("apps/client/src/assets/structures/barracks.png");
    expect(resolveAtlasPngDestination("wild-flax").mappingStatus).toBe("generic");
  });

  it("fails closed when a normalized name matches multiple registered slots", () => {
    const resolution = resolveAtlasPngDestination("shared", [
      { relativeFile: "apps/client/src/assets/structures/shared.png" },
      { relativeFile: "apps/client/src/assets/military/shared.png" }
    ]);
    expect(resolution).toEqual({
      destinationFile: "apps/client/src/assets/shared.png",
      destinationCandidates: [
        "apps/client/src/assets/structures/shared.png",
        "apps/client/src/assets/military/shared.png"
      ],
      mappingStatus: "ambiguous"
    });
  });
});
