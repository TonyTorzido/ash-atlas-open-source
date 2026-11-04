import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";

import {
  assertSquirrelDeltaEntryNames,
  inspectSquirrelReleaseBaseline,
  retainSquirrelReleaseManifest,
  squirrelParserUnsafeEntryNames,
  squirrelReleasePlan,
  squirrelReleasePackageNamesToRemoveAfterPackaging,
  squirrelReleasePackageNamesToRemoveBeforePackaging,
  squirrelReleasePlanMessage,
  squirrelZipEntryNames
} from "./squirrelPackaging.js";

describe("Squirrel release packaging plan", () => {
  it("rejects whitespace in delta ZIP entries before Squirrel can parse them", () => {
    const safeEntry = "lib/net45/AshAtlasAppearanceStudio_ExecutionStub.exe.shasum";
    const unsafeEntry = "lib/net45/Ash Atlas Appearance Studio_ExecutionStub.exe.shasum";
    expect(squirrelParserUnsafeEntryNames([safeEntry, unsafeEntry])).toEqual([unsafeEntry]);
    expect(() => assertSquirrelDeltaEntryNames([safeEntry])).not.toThrow();
    expect(() => assertSquirrelDeltaEntryNames([unsafeEntry])).toThrow(/parser-breaking/u);
  });

  it("reads Squirrel delta ZIP entry names for parser validation", () => {
    const entryNames = [
      "lib/net45/AshAtlasAppearanceStudio_ExecutionStub.exe.diff",
      "lib/net45/AshAtlasAppearanceStudio_ExecutionStub.exe.shasum"
    ];
    expect(squirrelZipEntryNames(zipWithNames(entryNames))).toEqual(entryNames);
  });

  it("falls back to a full-only release without a prior full package", () => {
    const plan = squirrelReleasePlan(
      ["RELEASES", "AshAtlasAppearanceStudio-1.40.2-delta.nupkg"],
      "1.40.2"
    );

    expect(plan).toEqual({
      packageName: null,
      version: null,
      noDelta: true
    });
    expect(squirrelReleasePlanMessage(plan)).toContain("full-only");
  });

  it("uses the newest lower full package as the delta baseline", () => {
    const files = [
      "RELEASES",
      "AshAtlasAppearanceStudio-1.39.0-full.nupkg",
      "AshAtlasAppearanceStudio-1.40.0-full.nupkg",
      "AshAtlasAppearanceStudio-1.40.0-delta.nupkg",
      "AshAtlasAppearanceStudio-1.40.1-full.nupkg",
      "AshAtlasAppearanceStudio-1.41.0-full.nupkg"
    ];

    expect(inspectSquirrelReleaseBaseline(files, "1.40.2")).toEqual({
      packageName: "AshAtlasAppearanceStudio-1.40.1-full.nupkg",
      version: "1.40.1"
    });
    const plan = squirrelReleasePlan(files, "1.40.2");
    expect(plan.noDelta).toBe(false);
    expect(squirrelReleasePlanMessage(plan)).toContain("delta package");
  });

  it("ignores full packages at or above the release being built", () => {
    expect(inspectSquirrelReleaseBaseline(
      [
        "AshAtlasAppearanceStudio-1.40.2-full.nupkg",
        "AshAtlasAppearanceStudio-1.42.0-full.nupkg"
      ],
      "1.40.2"
    )).toEqual({ packageName: null, version: null });
  });

  it("keeps only the newest baseline before packaging and current packages afterward", () => {
    const files = [
      "RELEASES",
      "AshAtlasAppearanceStudio-1.38.0-full.nupkg",
      "AshAtlasAppearanceStudio-1.39.0-full.nupkg",
      "AshAtlasAppearanceStudio-1.39.0-delta.nupkg",
      "AshAtlasAppearanceStudio-1.40.0-full.nupkg",
      "AshAtlasAppearanceStudio-1.40.0-delta.nupkg",
      "AshAtlasAppearanceStudio Setup.exe"
    ];
    const baseline = "AshAtlasAppearanceStudio-1.39.0-full.nupkg";

    expect(squirrelReleasePackageNamesToRemoveBeforePackaging(files, baseline)).toEqual([
      "AshAtlasAppearanceStudio-1.38.0-full.nupkg",
      "AshAtlasAppearanceStudio-1.39.0-delta.nupkg",
      "AshAtlasAppearanceStudio-1.40.0-full.nupkg",
      "AshAtlasAppearanceStudio-1.40.0-delta.nupkg"
    ]);
    expect(squirrelReleasePackageNamesToRemoveAfterPackaging(
      files,
      "1.40.0",
      baseline
    )).toEqual([
      "AshAtlasAppearanceStudio-1.38.0-full.nupkg",
      "AshAtlasAppearanceStudio-1.39.0-delta.nupkg"
    ]);
  });

  it("filters stale package entries from the RELEASES manifest", () => {
    const contents = [
      "hash-old AshAtlasAppearanceStudio-1.38.0-full.nupkg 10",
      "hash-baseline AshAtlasAppearanceStudio-1.39.0-full.nupkg 20",
      "hash-current AshAtlasAppearanceStudio-1.40.0-full.nupkg 30",
      "hash-delta AshAtlasAppearanceStudio-1.40.0-delta.nupkg 5",
      ""
    ].join("\r\n");

    expect(retainSquirrelReleaseManifest(contents, [
      "AshAtlasAppearanceStudio-1.39.0-full.nupkg",
      "AshAtlasAppearanceStudio-1.40.0-full.nupkg",
      "AshAtlasAppearanceStudio-1.40.0-delta.nupkg"
    ])).toBe([
      "hash-baseline AshAtlasAppearanceStudio-1.39.0-full.nupkg 20",
      "hash-current AshAtlasAppearanceStudio-1.40.0-full.nupkg 30",
      "hash-delta AshAtlasAppearanceStudio-1.40.0-delta.nupkg 5",
      ""
    ].join("\r\n"));
  });
});

function zipWithNames(entryNames: readonly string[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entryName of entryNames) {
    const name = Buffer.from(entryName, "utf8");
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(entryNames.length, 8);
  endOfCentralDirectory.writeUInt16LE(entryNames.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
}
