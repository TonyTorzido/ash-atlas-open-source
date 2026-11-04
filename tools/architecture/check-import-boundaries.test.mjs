import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeArchitecture } from "./check-import-boundaries.mjs";

test("reports shared-to-app and domain-to-transport imports", async () => {
  const root = await fixture({
    "packages/shared/src/index.ts": 'export { value } from "../../../apps/server/src/http/routes.js";\n',
    "apps/server/src/http/routes.ts": "export const value = 1;\n",
    "apps/server/src/game/domain.ts": 'import { value } from "../http/routes.js";\nvoid value;\n'
  });
  try {
    const report = await analyzeArchitecture(root);
    assert.deepEqual(
      report.violations.map(({ rule }) => rule).sort(),
      ["domain-cannot-import-transport", "shared-cannot-import-apps"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports dependency cycles", async () => {
  const root = await fixture({
    "apps/server/src/one.ts": 'import "./two.js";\n',
    "apps/server/src/two.ts": 'import "./one.js";\n'
  });
  try {
    const report = await analyzeArchitecture(root);
    assert.deepEqual(report.cycles, [["apps/server/src/one.ts", "apps/server/src/two.ts"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows only the sanctioned Population stone-conflict repair composition", async () => {
  const root = await fixture({
    "apps/server/src/game/populationStoneConflictRepair.ts":
      "const store = new PostgresPopulationZonesV2Store();\nvoid store;\n",
    "apps/server/src/game/roguePopulationTool.ts":
      "const store = new PostgresPopulationZonesV2Store();\nvoid store;\n"
  });
  try {
    const report = await analyzeArchitecture(root);
    assert.deepEqual(report.violations, [{
      rule: "population-authority-single-composition",
      file: "apps/server/src/game/roguePopulationTool.ts"
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports transport ownership regressions", async () => {
  const root = await fixture({
    "apps/server/src/realtime/websocket.ts": "switch (message.type) { default: break; }\n",
    "apps/server/src/realtime/realtimeApplication.ts": "socket.send(payload);\n",
    "apps/server/src/realtime/connectionRegistry.ts": "export class ConnectionRegistry {}\n",
    "apps/server/src/realtime/handlers/flagHandler.ts":
      "type Handler = RealtimeMessageDispatch;\nsocket.send(payload);\n"
  });
  try {
    const report = await analyzeArchitecture(root);
    assert.deepEqual(
      report.violations.map(({ rule }) => rule).sort(),
      [
        "connection-registry-must-use-publisher",
        "realtime-application-must-use-publisher",
        "realtime-handler-cannot-send-raw-frame",
        "realtime-handler-must-use-family-type",
        "websocket-entry-must-remain-thin"
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports compatibility-host implementation regressions", async () => {
  const root = await fixture({
    "apps/server/src/realtime/realtimeApplication.ts":
      'switch (message.type) { case "PING": break; }\nconst enterManorNow = () => {};\n',
    "apps/server/src/http/registerRoutes.ts":
      'const schema = z.object({});\nsystemRoutes.get("/health", handler);\n'
  });
  try {
    const report = await analyzeArchitecture(root);
    assert.deepEqual(
      report.violations.map(({ rule }) => rule).sort(),
      [
        "http-register-routes-must-remain-composition",
        "realtime-application-cannot-own-message-cases",
        "realtime-application-must-remain-composition"
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports portal transition ownership regressions", async () => {
  const root = await fixture({
    "apps/server/src/realtime/handlers/portalHandler.ts":
      "manorHandler(message);\ngameState.restoreWorldPosition(playerId, position);\n",
    "apps/server/src/realtime/handlers/manorHandler.ts":
      "coordinateManorExit(steps);\n",
    "apps/server/src/realtime/handlers/salonHandler.ts":
      "if (isPortalDomainCommit()) project();\n",
    "apps/server/src/realtime/realtimeApplication.ts":
      "let portalDomainCommitActive = false;\n"
  });
  try {
    const report = await analyzeArchitecture(root);
    assert.deepEqual(
      report.violations.map(({ rule }) => rule).sort(),
      [
        "interior-handler-cannot-own-portal-transition",
        "interior-handler-cannot-own-portal-transition",
        "portal-handler-must-delegate-generic-effects",
        "realtime-application-cannot-bridge-portal-handlers"
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports browser WebSocket ownership and unchecked server-frame regressions", async () => {
  const root = await fixture({
    "apps/client/src/browserWebSocketTransport.ts":
      'const socket = new WebSocket("ws://owner");\nsocket.send(payload);\n',
    "apps/client/src/rogueSocket.ts":
      'const socket = new WebSocket("ws://example");\nsocket.send(payload);\nconst reconnectTimer = 1;\nconst frame = value as PetServerMessage;\n',
    "apps/client/src/gameClient.ts":
      "const parsed = JSON.parse(String(event.data));\nvoid parsed;\n"
  });
  try {
    const report = await analyzeArchitecture(root);
    assert.deepEqual(
      report.violations.map(({ rule }) => rule).sort(),
      [
        "client-raw-frame-parser-single-owner",
        "client-reconnect-policy-single-owner",
        "client-server-message-cast-forbidden",
        "client-websocket-send-single-owner",
        "client-websocket-single-owner",
        "game-client-must-parse-server-frames"
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows optional WebSocket protocols and startup telemetry in their canonical owners", async () => {
  const root = await fixture({
    "apps/client/src/browserWebSocketTransport.ts":
      'const socket = protocols.length ? new WebSocket(url, [...protocols]) : new WebSocket(url);\nsocket.send(payload);\n',
    "apps/client/src/gameClient.ts":
      'const payload = { type: "STARTUP_TERMINAL_TELEMETRY" };\n'
  });
  try {
    assert.deepEqual((await analyzeArchitecture(root)).violations, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports an owner missing WebSocket construction or sending", async () => {
  const root = await fixture({
    "apps/client/src/browserWebSocketTransport.ts": "export class BrowserWebSocketTransport {}\n"
  });
  try {
    assert.deepEqual((await analyzeArchitecture(root)).violations.map(({ rule }) => rule), [
      "client-websocket-owner-contract",
      "client-websocket-send-owner-contract"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports missing exhaustive ServerMessage parser ownership", async () => {
  const root = await fixture({
    "packages/shared/src/protocol.ts":
      'export * from "./protocol/serverMessageParser.js";\n',
    "packages/shared/src/protocol/serverMessageValidation.ts":
      "export const routes = {};\n",
    "packages/shared/src/protocol/serverMessageParser.ts":
      "export function parseServerMessage() { return null; }\n"
  });
  try {
    const report = await analyzeArchitecture(root);
    assert.deepEqual(
      report.violations.map(({ rule }) => rule),
      ["server-message-parser-ownership-exhaustive"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports implementation bodies in the shared protocol compatibility host", async () => {
  const root = await fixture({
    "packages/shared/src/protocol.ts":
      'export * from "./protocol/serverMessages.js";\nconst hiddenSchema = {};\n'
  });
  try {
    const report = await analyzeArchitecture(root);
    assert.deepEqual(
      report.violations.map(({ rule }) => rule),
      ["shared-protocol-must-be-compatibility-boundary"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows a growing protocol boundary with multiline type and value re-exports", async () => {
  const root = await fixture({
    "packages/shared/src/protocol.ts":
      Array.from({ length: 50 }, (_, index) => `export * from "./domain${index}.js";`).join("\n")
      + '\n/* Compatibility names. */\nexport type {\n  PlayerSnapshot\n} from "./player.js";\n'
      + 'export { schema } from "./schema.js"; export * as domain from "./domain.js";\n'
  });
  try {
    assert.deepEqual((await analyzeArchitecture(root)).violations, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const source of [
  "export const hiddenSchema = {};\n",
  "export function parseMessage() { return null; }\n",
  'export * from "./domain.js"; initialize();\n',
  'import "./initialize.js";\n',
  'export * from "./domain.js"; export { localSchema };\n'
]) {
  test(`rejects protocol implementation or local ownership: ${source.trim()}`, async () => {
    const root = await fixture({ "packages/shared/src/protocol.ts": source });
    try {
      assert.deepEqual((await analyzeArchitecture(root)).violations.map(({ rule }) => rule), [
        "shared-protocol-must-be-compatibility-boundary"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("reports neutral flag geometry and World cell-identity ownership regressions", async () => {
  const root = await fixture({
    "apps/server/src/game/cities.ts":
      'import { lockFlagControlGeometry } from "./kingdoms.js";\nvoid lockFlagControlGeometry;\n',
    "apps/server/src/game/kingdoms.ts":
      "export function lockFlagControlGeometry() {}\n",
    "apps/server/src/game/landFootprintAuthority.ts":
      "const RIVER_CELL_SIZE_M = 125;\nvoid RIVER_CELL_SIZE_M;\n"
  });
  try {
    const report = await analyzeArchitecture(root);
    assert.deepEqual(
      report.violations.map(({ rule }) => rule).sort(),
      [
        "city-cannot-import-neutral-flag-geometry-from-kingdom",
        "land-footprint-must-use-locked-world-cell-geometry"
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports client decomposition ownership regressions", async () => {
  const root = await fixture({
    "apps/client/src/App.tsx":
      'import { ClientCommandPort } from "./client/clientCommandPort.js";\nmap.on("load", handler);\nswitch (message.type) { case "WELCOME": break; }\nconst pendingCityBuildAction = client.buildCityHouse();\nvoid pendingCityBuildAction;\n',
    "apps/client/src/gameClient.ts":
      'const suspend = { type: "APP_SUSPEND" };\nconst telemetry = { type: "TELEMETRY_BATCH" };\nconst payload = { type: "MOVE_TO" };\nvoid suspend; void telemetry; void payload;\n',
    "apps/client/src/client/domains/worldClient.ts":
      'import "./socialClient.js";\n',
    "apps/client/src/client/domains/socialClient.ts": "export class SocialClient {}\n",
    "apps/client/src/features/world/useWorld.ts":
      'import { BrowserWebSocketTransport } from "../../browserWebSocketTransport.js";\nvoid BrowserWebSocketTransport;\n',
    "apps/client/src/browserWebSocketTransport.ts":
      'const socket = new WebSocket("ws://owner");\nsocket.send(payload);\n',
    "apps/client/src/ui/Panel.tsx":
      'import { parseServerMessage } from "@ash-atlas/shared";\nvoid parseServerMessage;\n'
  });
  try {
    const report = await analyzeArchitecture(root);
    assert.deepEqual(
      report.violations.map(({ rule }) => rule).sort(),
      [
        "client-app-cannot-own-city-construction-workflow",
        "client-app-cannot-own-transport",
        "client-app-cannot-register-map-runtime",
        "client-composition-cannot-own-server-message-cases",
        "client-domain-cannot-import-domain",
        "client-feature-cannot-import-transport",
        "client-ui-cannot-import-network-internals",
        "game-client-facade-cannot-construct-payloads"
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports production browser dialogs in client code", async () => {
  const root = await fixture({
    "apps/client/src/ui/LegacyConfirmation.tsx":
      'export const confirmLegacy = () => window.confirm("Continue?");\n',
    "apps/client/src/ui/CanonicalConfirmation.tsx":
      'export const canonical = "GameConfirmationPrompt";\n',
    "apps/client/src/ui/LegacyConfirmation.test.tsx":
      'window.alert("fixture");\n'
  });
  try {
    const report = await analyzeArchitecture(root);
    assert.deepEqual(report.violations, [{
      rule: "client-production-browser-dialog-forbidden",
      file: "apps/client/src/ui/LegacyConfirmation.tsx"
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), "ash-atlas-architecture-"));
  await mkdir(path.join(root, "apps"), { recursive: true });
  await mkdir(path.join(root, "packages"), { recursive: true });
  for (const [file, contents] of Object.entries(files)) {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
  return root;
}
