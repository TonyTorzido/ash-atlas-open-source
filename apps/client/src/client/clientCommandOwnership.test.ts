import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CLIENT_COMMAND_OWNERS,
  NON_SENDABLE_CLIENT_COMMANDS,
  type ClientCommandOwner
} from "./clientCommandOwnership.js";

const clientDirectory = fileURLToPath(new URL(".", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const ownerFiles = {
  core: [
    fileURLToPath(new URL("../gameClient.ts", import.meta.url)),
    fileURLToPath(new URL("../diagnostics/bugReportDiagnostics.ts", import.meta.url))
  ],
  world: [fileURLToPath(new URL("./domains/worldGameplayClient.ts", import.meta.url))],
  flag: [fileURLToPath(new URL("./domains/flagClient.ts", import.meta.url))],
  settlement: [fileURLToPath(new URL("./domains/settlementClient.ts", import.meta.url))],
  travel: [fileURLToPath(new URL("./domains/travelClient.ts", import.meta.url))],
  party: [fileURLToPath(new URL("./domains/partyClient.ts", import.meta.url))],
  manor: [fileURLToPath(new URL("./domains/manorClient.ts", import.meta.url))],
  salon: [fileURLToPath(new URL("./domains/salonClient.ts", import.meta.url))],
  dungeon: [fileURLToPath(new URL("./domains/dungeonClient.ts", import.meta.url))],
  harvesting: [fileURLToPath(new URL("./domains/harvestingClient.ts", import.meta.url))],
  combat: [fileURLToPath(new URL("./domains/combatEquipmentClient.ts", import.meta.url))],
  backpack: [fileURLToPath(new URL("./domains/backpackClient.ts", import.meta.url))],
  social: [fileURLToPath(new URL("./domains/socialClient.ts", import.meta.url))],
  market: [fileURLToPath(new URL("./domains/marketClient.ts", import.meta.url))],
  pet: [fileURLToPath(new URL("./domains/petClient.ts", import.meta.url))],
  packages: [fileURLToPath(new URL("./domains/playerPackageClient.ts", import.meta.url))],
  gifts: [fileURLToPath(new URL("./domains/playerGiftClient.ts", import.meta.url))],
  developer: [fileURLToPath(new URL("./domains/developerClient.ts", import.meta.url))],
  portal: [fileURLToPath(new URL("./domains/portalClient.ts", import.meta.url))]
} as const satisfies Record<ClientCommandOwner, readonly string[]>;

describe("client command ownership", () => {
  it("owns every client command exactly once and matches every physical command", () => {
    const entries = Object.entries(CLIENT_COMMAND_OWNERS);
    expect(new Set(entries.map(([type]) => type)).size).toBe(entries.length);

    const physicalOwners = new Map<string, ClientCommandOwner[]>();
    const sources = Object.fromEntries(Object.entries(ownerFiles).map(
      ([owner, files]) => [owner, files.map((file) => readFileSync(file, "utf8"))]
    ));
    for (const [owner, ownerSources] of Object.entries(sources)) {
      for (const source of ownerSources) for (const match of source.matchAll(/type:\s*"([A-Z0-9_]+)"/gu)) {
        const type = match[1] as keyof typeof CLIENT_COMMAND_OWNERS;
        if (!(type in CLIENT_COMMAND_OWNERS)) continue;
        expect(CLIENT_COMMAND_OWNERS[type], `${type} is physically owned by ${owner}`).toBe(owner);
        const owners = physicalOwners.get(type) ?? [];
        owners.push(owner as ClientCommandOwner);
        physicalOwners.set(type, owners);
      }
    }
    for (const [type] of entries) {
      const owners = physicalOwners.get(type) ?? [];
      if (type in NON_SENDABLE_CLIENT_COMMANDS) {
        expect(owners, `${type} is declared non-sendable but has a physical sender`).toEqual([]);
      } else {
        expect(owners, `${type} must have exactly one physical sender`).toHaveLength(1);
      }
    }
  });

  it("keeps domain commands and the neutral port outside raw network and application authority", () => {
    const domainSources = Object.entries(ownerFiles)
      .filter(([owner]) => owner !== "core")
      .flatMap(([, files]) => files.map((file) => readFileSync(file, "utf8")));
    const forbidden = [
      "new WebSocket",
      "BrowserWebSocketTransport",
      "JSON.parse",
      "setInterval(",
      "setTimeout(",
      "App.tsx",
      'from "react"',
      "from './"
    ];

    for (const source of domainSources) {
      for (const token of forbidden) expect(source).not.toContain(token);
    }
    const portSource = readFileSync(`${clientDirectory}clientCommandPort.ts`, "utf8");
    expect(portSource).not.toMatch(/WebSocket|Transport|JSON\.parse|setInterval|setTimeout/u);
    expect(readFileSync(`${sourceRoot}gameClient.ts`, "utf8")).toContain(
      "createGameClientDomains(this.commandPort)"
    );
  });
});
