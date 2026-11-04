import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SERVER_MESSAGE_VALIDATION_ROUTES } from "./protocol.js";

const domainFiles = {
  announcements: "announcementMessages.ts",
  bugReports: "../bugReports.ts",
  combatEquipment: "combatEquipmentMessages.ts",
  developer: "developerMessages.ts",
  dungeon: "dungeonMessages.ts",
  flags: "flagMessages.ts",
  harvesting: "harvestingMessages.ts",
  manor: "manorMessages.ts",
  backpack: "backpackMessages.ts",
  portal: "portalMessages.ts",
  salon: "salonMessages.ts",
  party: "partyMessages.ts",
  packages: "playerPackageMessages.ts",
  gifts: "playerGiftMessages.ts",
  shop: "shopMessages.ts",
  pets: "petMessages.ts",
  session: "sessionMessages.ts",
  skills: "skillSystemV3Messages.ts",
  settlements: "settlementMessages.ts",
  social: "socialMessages.ts",
  travel: "travelMessages.ts",
  world: "worldMessages.ts"
} as const;

const runtimeSchemaFiles = {
  announcements: "announcementServerSchemas.ts",
  combatEquipment: "combatEquipmentServerMessageSchemas.ts",
  developer: "developerServerSchemas.ts",
  dungeon: "dungeonServerSchemas.ts",
  flags: "flagServerSchemas.ts",
  harvesting: "harvestingServerSchemas.ts",
  manor: "manorServerSchemas.ts",
  backpack: "backpackServerSchemas.ts",
  portal: "portalServerSchemas.ts",
  salon: "salonServerSchemas.ts",
  market: "marketServerSchemas.ts",
  party: "partyServerMessageSchemas.ts",
  packages: "playerPackageServerSchemas.ts",
  gifts: "playerGiftServerSchemas.ts",
  shop: "shopServerSchemas.ts",
  pets: "petServerSchemas.ts",
  session: "sessionServerSchemas.ts",
  skills: "skillSystemV3ServerSchemas.ts",
  settlements: "settlementServerSchemas.ts",
  social: "socialServerSchemas.ts",
  travel: "travelServerSchemas.ts",
  world: "worldServerSchemas.ts"
} as const;

describe("ServerMessage protocol domain ownership", () => {
  it("physically owns every non-market and non-DM discriminant exactly once", () => {
    const protocolDirectory = fileURLToPath(new URL("./protocol/", import.meta.url));
    const sources = Object.fromEntries(Object.entries(domainFiles).map(([domain, file]) => [
      domain,
      readFileSync(`${protocolDirectory}${file}`, "utf8")
    ]));
    const routeTypes = Object.keys(SERVER_MESSAGE_VALIDATION_ROUTES);
    expect(routeTypes).toHaveLength(365);

    for (const type of routeTypes) {
      if (type.startsWith("MARKET_") || type.startsWith("DM_")) continue;
      const owners = Object.entries(sources)
        .filter(([, source]) => source.includes(`type: "${type}"`))
        .map(([domain]) => domain);
      expect(owners, `${type} shared type owner`).toHaveLength(1);
    }
  });

  it("physically owns every runtime validation route exactly once", () => {
    const protocolDirectory = fileURLToPath(new URL("./protocol/", import.meta.url));
    const sources = Object.fromEntries(Object.entries(runtimeSchemaFiles).map(([domain, file]) => [
      domain,
      readFileSync(`${protocolDirectory}${file}`, "utf8")
    ]));
    const routeTypes = Object.keys(SERVER_MESSAGE_VALIDATION_ROUTES);

    for (const type of routeTypes) {
      const declaration = new RegExp(`^\\s*${type}:`, "m");
      const owners = Object.entries(sources)
        .filter(([, source]) => declaration.test(source))
        .map(([domain]) => domain);
      expect(owners, `${type} runtime schema owner`).toHaveLength(1);
    }
  });

  it("keeps broad ServerMessage type bodies out of the compatibility protocol host", () => {
    const compatibilitySource = readFileSync(
      fileURLToPath(new URL("./protocol.ts", import.meta.url)),
      "utf8"
    );
    for (const type of Object.keys(SERVER_MESSAGE_VALIDATION_ROUTES)) {
      expect(compatibilitySource).not.toContain(`type: "${type}"`);
    }
    expect(compatibilitySource).toContain(
      'export * from "./protocol/serverMessages.js";'
    );
    expect(compatibilitySource).not.toContain("export type ServerMessage =");
  });
});
