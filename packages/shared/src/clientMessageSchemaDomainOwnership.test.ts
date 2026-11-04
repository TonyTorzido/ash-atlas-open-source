import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { clientMessageSchema } from "./protocol.js";

const CLIENT_SCHEMA_OWNER_FILES = [
  "protocol/sessionSchemas.ts",
  "protocol/worldSchemas.ts",
  "protocol/dungeonSchemas.ts",
  "protocol/salonSchemas.ts",
  "protocol/backpackSchemas.ts",
  "protocol/manorSchemas.ts",
  "protocol/flagSchemas.ts",
  "protocol/settlementSchemas.ts",
  "protocol/harvestingSchemas.ts",
  "protocol/combatEquipmentClientSchemas.ts",
  "protocol/developerSchemas.ts",
  "protocol/partySchemas.ts",
  "protocol/petSchemas.ts",
  "protocol/socialSchemas.ts",
  "protocol/skillSystemV3Schemas.ts",
  "protocol/portalSchemas.ts",
  "protocol/relocationSchemas.ts",
  "playerPackages.ts",
  "playerGifts.ts",
  "bugReports.ts",
  "telemetry.ts",
  "marketProtocol.ts",
  "directMessages.ts",
  "kingdoms.ts"
] as const;

describe("ClientMessage physical schema ownership", () => {
  it("gives every discriminant exactly one runtime-schema owner", () => {
    const discriminants = new Set<string>(
      clientMessageSchema.options.map((option) => option.shape.type.value)
    );
    const owners = new Map<string, string[]>();

    for (const relativePath of CLIENT_SCHEMA_OWNER_FILES) {
      const source = readFileSync(
        fileURLToPath(new URL(relativePath, import.meta.url)),
        "utf8"
      );
      for (const match of source.matchAll(/type:\s*z\.literal\("([A-Z0-9_]+)"\)/g)) {
        const discriminant = match[1]!;
        if (!discriminants.has(discriminant)) continue;
        owners.set(discriminant, [...(owners.get(discriminant) ?? []), relativePath]);
      }
    }

    expect(discriminants.size).toBe(407);
    expect([...discriminants].filter((type) => !owners.has(type))).toEqual([]);
    expect(
      [...owners].filter(([, ownerFiles]) => ownerFiles.length !== 1)
    ).toEqual([]);
    expect(owners.size).toBe(discriminants.size);
  });
});
