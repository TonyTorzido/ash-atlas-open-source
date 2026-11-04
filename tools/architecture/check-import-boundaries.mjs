import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoots = ["apps", "packages"];
const productionFile = /(?<!\.(?:test|spec|integration))\.[cm]?[jt]sx?$/u;
const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/gu;

const temporaryExceptions = new Map();
const baselineDependencyCycles = new Set();
// This retained repair CLI is an explicit operator entry point, not a production composition root.
const sanctionedPopulationOperationalCompositions = new Set([
  "apps/server/src/game/populationStoneConflictRepair.ts"
]);

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const reportOnly = process.argv.includes("--report-only");
  const report = await analyzeArchitecture(repositoryRoot);
  const unexpected = report.violations.filter((violation) => !violation.temporaryException);

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `architecture: ${report.files} files, ${report.edges} imports, `
        + `${report.cycles.length} cycles, ${report.violations.length} boundary findings\n`
    );
    for (const cycle of report.cycles) process.stdout.write(`cycle: ${cycle.join(" -> ")}\n`);
    for (const violation of report.violations) {
      const suffix = violation.temporaryException
        ? ` (temporary: ${violation.temporaryException})`
        : "";
      process.stdout.write(`${violation.rule}: ${violation.file}${suffix}\n`);
    }
  }

  if (!reportOnly && unexpected.length > 0) process.exitCode = 1;
}

export async function analyzeArchitecture(root) {
  const absoluteFiles = [];
  for (const sourceRoot of sourceRoots) {
    absoluteFiles.push(...await walk(path.join(root, sourceRoot)));
  }
  const files = absoluteFiles
    .filter((file) => productionFile.test(file.replaceAll("\\", "/")))
    .map((file) => normalize(path.relative(root, file)))
    .sort();
  const knownFiles = new Set(files);
  const sources = new Map();
  const graph = new Map(files.map((file) => [file, []]));
  const violations = [];

  for (const file of files) {
    const source = await readFile(path.join(root, file), "utf8");
    sources.set(file, source);
    for (const specifier of importSpecifiers(source)) {
      const target = resolveImport(file, specifier, knownFiles);
      if (!target) continue;
      graph.get(file).push(target);
      if (file.startsWith("packages/shared/") && target.startsWith("apps/")) {
        addViolation(violations, "shared-cannot-import-apps", file, target);
      }
      if (
        file.startsWith("apps/server/src/game/")
        && (target.startsWith("apps/server/src/http/") || target.startsWith("apps/server/src/realtime/"))
      ) {
        addViolation(violations, "domain-cannot-import-transport", file, target);
      }
      if (
        file.startsWith("apps/client/src/client/domains/")
        && target.startsWith("apps/client/src/client/domains/")
      ) {
        addViolation(violations, "client-domain-cannot-import-domain", file, target);
      }
      if (
        file.startsWith("apps/client/src/features/")
        && target === "apps/client/src/browserWebSocketTransport.ts"
      ) {
        addViolation(violations, "client-feature-cannot-import-transport", file, target);
      }
      if (file.startsWith("apps/server/") && target.startsWith("apps/client/")) {
        addViolation(violations, "server-cannot-import-client", file, target);
      }
    }
  }

  for (const file of ["apps/server/src/index.ts", "apps/server/src/application.ts"]) {
    const source = sources.get(file) ?? "";
    if (/environmentalPopulation/iu.test(source)) {
      addViolation(violations, "production-composition-v2-only", file);
    }
    if (/createDisabledDevelopmentPopulationZonesV2Composition/u.test(source)) {
      addViolation(violations, "production-cannot-use-disabled-population-backend", file);
    }
  }

  const populationConstructors = [
    "PostgresPopulationZonesV2Store",
    "PopulationZoneV3HabitatCompiler",
    "PopulationZonesV2Planner",
    "PopulationZonesV2Backend",
    "PopulationZonesV2Runtime"
  ];
  for (const [file, source] of sources) {
    if (
      file === "apps/server/src/game/populationZonesV2Composition.ts"
      || file === "apps/server/src/game/populationZonesV2DiagnosticComposition.ts"
      || sanctionedPopulationOperationalCompositions.has(file)
    ) continue;
    if (populationConstructors.some((name) => new RegExp(`new\\s+${name}\\s*\\(`, "u").test(source))) {
      addViolation(violations, "population-authority-single-composition", file);
    }
  }

  const portalHandlerFile = "apps/server/src/realtime/handlers/portalHandler.ts";
  const portalHandlerSource = sources.get(portalHandlerFile) ?? "";
  if (
    /\b(?:manorHandler|salonHandler)\s*\(|\bas\s+never\b|\brestoreWorldPosition\s*\(|\bupdateSpatialMembership\s*\(|\bsetPlayerLocationKind\s*\(|\breplication\.(?:resetPlayer|removePlayer)\s*\(/u
      .test(portalHandlerSource)
  ) {
    addViolation(
      violations,
      "portal-handler-must-delegate-generic-effects",
      portalHandlerFile
    );
  }
  for (const file of [
    "apps/server/src/realtime/handlers/manorHandler.ts",
    "apps/server/src/realtime/handlers/salonHandler.ts"
  ]) {
    const source = sources.get(file) ?? "";
    if (/\bisPortalDomainCommit\b|\bcoordinateManorExit\b/u.test(source)) {
      addViolation(
        violations,
        "interior-handler-cannot-own-portal-transition",
        file
      );
    }
  }

  const diagnosticCompositionFile =
    "apps/server/src/game/populationZonesV2DiagnosticComposition.ts";
  const diagnosticComposition = sources.get(diagnosticCompositionFile);
  if (
    diagnosticComposition !== undefined
    && !diagnosticComposition.includes('mode: "explicit-diagnostic-fake"')
  ) {
    addViolation(
      violations,
      "population-diagnostic-must-be-explicit",
      diagnosticCompositionFile
    );
  }
  if ((sources.get("apps/server/src/application.ts") ?? "").includes(
    "populationZonesV2DiagnosticComposition"
  )) {
    addViolation(
      violations,
      "production-cannot-use-population-diagnostic-composition",
      "apps/server/src/application.ts"
    );
  }

  for (const file of [
    "apps/server/src/http/routes.ts",
    "apps/server/src/http/registerRoutes.ts",
    "apps/server/src/realtime/websocket.ts",
    "apps/server/src/realtime/realtimeApplication.ts"
  ]) {
    const source = sources.get(file) ?? "";
    if (/\b(?:createPlan|createSlot|spawnMob)\s*\(/u.test(source)) {
      addViolation(violations, "transport-cannot-create-population-authority", file);
    }
  }

  const websocketFile = "apps/server/src/realtime/websocket.ts";
  const websocketSource = sources.get(websocketFile) ?? "";
  if (
    websocketSource.split(/\r?\n/u).filter((line) => line.trim().length > 0).length > 4
    || /parseClientMessage|switch\s*\(|\.send\s*\(|\.register\s*\(/u.test(websocketSource)
  ) {
    addViolation(violations, "websocket-entry-must-remain-thin", websocketFile);
  }

  const browserWebSocketTransportFile = "apps/client/src/browserWebSocketTransport.ts";
  const browserWebSocketTransportSource = sources.get(browserWebSocketTransportFile) ?? "";
  for (const [file, source] of sources) {
    if (
      file.startsWith("apps/client/src/")
      && file !== browserWebSocketTransportFile
      && /\bnew\s+WebSocket\s*\(/u.test(source)
    ) {
      addViolation(violations, "client-websocket-single-owner", file);
    }
    if (
      file.startsWith("apps/client/src/")
      && file !== browserWebSocketTransportFile
      && /\b(?:socket|webSocket|ws)\s*\.\s*send\s*\(/iu.test(source)
    ) {
      addViolation(violations, "client-websocket-send-single-owner", file);
    }
    if (
      file.startsWith("apps/client/src/")
      && /JSON\.parse\s*\(\s*(?:String\s*\(\s*)?(?:event|messageEvent)\.data/iu.test(source)
    ) {
      addViolation(violations, "client-raw-frame-parser-single-owner", file);
    }
    if (
      file.startsWith("apps/client/src/")
      && !file.endsWith(".test.ts")
      && !file.endsWith(".test.tsx")
      && /\bas\s+[A-Za-z0-9_]*ServerMessage\b/u.test(source)
    ) {
      addViolation(violations, "client-server-message-cast-forbidden", file);
    }
    if (
      file.startsWith("apps/client/src/")
      && file !== "apps/client/src/gameClient.ts"
      && /\b(?:scheduleReconnect|reconnectTimer|RECONNECT_(?:BASE|MAX)_DELAY_MS)\b/u.test(source)
    ) {
      addViolation(violations, "client-reconnect-policy-single-owner", file);
    }
  }
  if (sources.has(browserWebSocketTransportFile)) {
    // Optional native protocols use mutually exclusive constructors in this same owner.
    if (!/\bnew\s+WebSocket\s*\(/u.test(browserWebSocketTransportSource)) {
      addViolation(violations, "client-websocket-owner-contract", browserWebSocketTransportFile);
    }
    if ((browserWebSocketTransportSource.match(/\bsocket\s*\.\s*send\s*\(/gu) ?? []).length !== 1) {
      addViolation(violations, "client-websocket-send-owner-contract", browserWebSocketTransportFile);
    }
  }
  const gameClientSource = sources.get("apps/client/src/gameClient.ts") ?? "";
  if (/JSON\.parse\s*\(\s*String\s*\(\s*event\.data|\bas\s+ServerMessage\b/u.test(gameClientSource)) {
    addViolation(
      violations,
      "game-client-must-parse-server-frames",
      "apps/client/src/gameClient.ts"
    );
  }
  const sharedProtocolFile = "packages/shared/src/protocol.ts";
  const sharedProtocolSource = sources.get(sharedProtocolFile) ?? "";
  const serverMessageValidationFile =
    "packages/shared/src/protocol/serverMessageValidation.ts";
  const serverMessageParserFile =
    "packages/shared/src/protocol/serverMessageParser.ts";
  const serverMessageValidationSource = sources.get(serverMessageValidationFile) ?? "";
  const serverMessageParserSource = sources.get(serverMessageParserFile) ?? "";
  if (
    sources.has(serverMessageValidationFile)
    && (
      !/export\s+const\s+SERVER_MESSAGE_VALIDATION_ROUTES\s*=\s*\{/u.test(
        serverMessageValidationSource
      )
      || !/satisfies\s+Record<ServerMessage\["type"\],\s*z\.ZodTypeAny>/u.test(
        serverMessageValidationSource
      )
      || !/SERVER_MESSAGE_VALIDATION_ROUTES\[\s*envelope\.data\.type/u.test(
        serverMessageParserSource
      )
    )
  ) {
    addViolation(
      violations,
      "server-message-parser-ownership-exhaustive",
      serverMessageValidationFile
    );
  }
  if (sources.has(sharedProtocolFile)) {
    const protocolSyntax = ts.createSourceFile(
      sharedProtocolFile, sharedProtocolSource, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS
    );
    // The compatibility boundary may grow with domains, but must contain only re-exports.
    if (
      protocolSyntax.parseDiagnostics.length > 0
      || protocolSyntax.statements.some((statement) =>
        !ts.isExportDeclaration(statement)
        || !statement.moduleSpecifier
        || !ts.isStringLiteral(statement.moduleSpecifier)
      )
    ) {
      addViolation(
        violations,
        "shared-protocol-must-be-compatibility-boundary",
        sharedProtocolFile
      );
    }
  }
  const gameClientPayloadTypes = [...gameClientSource.matchAll(
    /(?:\{|,)\s*type\s*:\s*["']([A-Z][A-Z0-9_]+)["']/gu
  )].map((match) => match[1]);
  const gameClientCorePayloadTypes = new Set([
    "HELLO",
    "PING",
    "APP_SUSPEND",
    "TELEMETRY_BATCH",
    "STARTUP_TERMINAL_TELEMETRY"
  ]);
  if (gameClientPayloadTypes.some((type) => !gameClientCorePayloadTypes.has(type))) {
    addViolation(
      violations,
      "game-client-facade-cannot-construct-payloads",
      "apps/client/src/gameClient.ts"
    );
  }

  const appFile = "apps/client/src/App.tsx";
  const appSource = sources.get(appFile) ?? "";
  if (/\bnew\s+WebSocket\s*\(|JSON\.parse\s*\(|BrowserWebSocketTransport|ClientCommandPort/u.test(appSource)) {
    addViolation(violations, "client-app-cannot-own-transport", appFile);
  }
  if (/\b(?:createMap|bindMapMovementInput|subscribeWorldOverlayRelease)\s*\(|\bmap\.on\s*\(|\bmap\.off\s*\(/u.test(appSource)) {
    addViolation(violations, "client-app-cannot-register-map-runtime", appFile);
  }
  if (
    /\b(?:pendingCityBuildAction|cityHouseConfirmationOpen|pendingCityDestruction)\b/u.test(appSource)
    || /\b(?:buildCityHouse|buildOilWell|buildCityFacility|upgradeCityFacility|buildCityMarket|buildCityMonument|upgradeCityMonument|destroyCityHouse|destroyOilWell|destroyCityFacility)\s*\(/u.test(appSource)
  ) {
    addViolation(
      violations,
      "client-app-cannot-own-city-construction-workflow",
      appFile
    );
  }
  for (const [file, source] of sources) {
    if (
      !file.startsWith("apps/client/src/")
      || !(
        file === appFile
        || /(?:Application|Composition|Root)\.(?:ts|tsx)$/u.test(file)
      )
    ) {
      continue;
    }
    if (
      /switch\s*\(\s*(?:message|frame)\.type\s*\)/u.test(source)
      || /\bcase\s+["'][A-Z][A-Z0-9_]+["']\s*:/u.test(source)
    ) {
      addViolation(
        violations,
        "client-composition-cannot-own-server-message-cases",
        file
      );
    }
  }

  for (const [file, source] of sources) {
    if (file.startsWith("apps/client/src/client/domains/")) {
      if (/browserWebSocketTransport|BrowserWebSocketTransport/u.test(source)) {
        addViolation(violations, "client-domain-cannot-import-transport", file);
      }
    }
    if (file.startsWith("apps/client/src/ui/") && /browserWebSocketTransport|ClientCommandPort|parseServerMessage/u.test(source)) {
      addViolation(violations, "client-ui-cannot-import-network-internals", file);
    }
    if (file.startsWith("apps/client/src/features/")) {
      const nonblankLines = source.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
      if (nonblankLines > 800) addViolation(violations, "client-feature-cannot-be-monolith", file);
    }
    if (
      file.startsWith("apps/client/src/")
      && /\bwindow\s*\.\s*(?:alert|confirm|prompt)\s*\(/u.test(source)
    ) {
      addViolation(violations, "client-production-browser-dialog-forbidden", file);
    }
  }

  for (const [file, source] of sources) {
    if (!file.startsWith("apps/server/src/realtime/handlers/")) continue;
    if (/\bRealtimeMessageDispatch\b/u.test(source)) {
      addViolation(violations, "realtime-handler-must-use-family-type", file);
    }
    if (/\bsocket\.send\s*\(|serializeServerMessage/u.test(source)) {
      addViolation(violations, "realtime-handler-cannot-send-raw-frame", file);
    }
    if (/\bnew\s+[A-Za-z0-9_]*(?:Store|Service|Runtime|Backend)\s*\(/u.test(source)) {
      addViolation(violations, "realtime-handler-cannot-construct-authority", file);
    }
  }

  const realtimeApplicationFile = "apps/server/src/realtime/realtimeApplication.ts";
  const realtimeApplicationSource = sources.get(realtimeApplicationFile) ?? "";
  if (/serializeServerMessage|\bsocket\.send\s*\(/u.test(realtimeApplicationSource)) {
    addViolation(violations, "realtime-application-must-use-publisher", realtimeApplicationFile);
  }
  if (/\bportalDomainCommitActive\b|\bas\s+never\b/u.test(realtimeApplicationSource)) {
    addViolation(
      violations,
      "realtime-application-cannot-bridge-portal-handlers",
      realtimeApplicationFile
    );
  }
  if (/switch\s*\(\s*message\.type\s*\)|\bcase\s+["'][A-Z][A-Z0-9_]+["']\s*:/u.test(
    realtimeApplicationSource
  )) {
    addViolation(
      violations,
      "realtime-application-cannot-own-message-cases",
      realtimeApplicationFile
    );
  }
  if (
    /\bnew\s+(?:FlagBuildCoordinator|FlagArrivalReservations)\s*\(/u
      .test(realtimeApplicationSource)
    || /\bfunction\s+(?:applyAuthoritativeTravelPhase1|applyLiveClassMutationState|beginManorApproach|cancelPendingManorEntry|enterManorNow|performAuthoritativeTravel|sendCollectiblesForPlayer)\b/u
      .test(realtimeApplicationSource)
    || /\bconst\s+(?:applyAuthoritativeTravelPhase1|applyLiveClassMutationState|beginManorApproach|cancelPendingManorEntry|enterManorNow|performAuthoritativeTravel|sendCollectiblesForPlayer)\s*=\s*(?:async\s*)?\(/u
      .test(realtimeApplicationSource)
  ) {
    addViolation(
      violations,
      "realtime-application-must-remain-composition",
      realtimeApplicationFile
    );
  }

  const registerRoutesFile = "apps/server/src/http/registerRoutes.ts";
  const registerRoutesSource = sources.get(registerRoutesFile) ?? "";
  if (
    /\b(?:collectible|diagnostic|flag|player|system|world)Routes\.(?:delete|get|patch|post)\s*\(/u
      .test(registerRoutesSource)
    || /\bz\.(?:object|array|enum)\s*\(/u.test(registerRoutesSource)
  ) {
    addViolation(
      violations,
      "http-register-routes-must-remain-composition",
      registerRoutesFile
    );
  }
  const registrySource = sources.get("apps/server/src/realtime/connectionRegistry.ts") ?? "";
  if (
    sources.has("apps/server/src/realtime/connectionRegistry.ts")
    && !/new\s+RealtimePublisher\s*\(/u.test(registrySource)
  ) {
    addViolation(
      violations,
      "connection-registry-must-use-publisher",
      "apps/server/src/realtime/connectionRegistry.ts"
    );
  }

  const resourceContractsFile = "apps/server/src/game/resourceVisionJobContracts.ts";
  const resourceStoreSource = sources.get("apps/server/src/game/resourceVisionJobsStore.ts") ?? "";
  if (
    sources.has(resourceContractsFile)
    && /resourceVisionJobs(?:\.js)?["']/u.test(resourceStoreSource)
  ) {
    addViolation(
      violations,
      "resource-job-store-must-use-neutral-contracts",
      "apps/server/src/game/resourceVisionJobsStore.ts"
    );
  }

  for (const [file, source] of sources) {
    if (!file.startsWith("apps/server/src/http/routes/")) continue;
    if (/\bnew\s+[A-Za-z0-9_]*(?:Store|Service|Runtime|Backend|Planner)\s*\(/u.test(source)) {
      addViolation(violations, "http-route-family-cannot-construct-authority", file);
    }
  }

  for (const [file, source] of sources) {
    if (file === "apps/server/src/runtime/authorityIdentity.ts") continue;
    if (/config\/world-runtime\.lock\.json/u.test(source)) {
      addViolation(violations, "world-lock-single-boundary", file);
    }
  }

  const cityAggregateFile = "apps/server/src/game/cities.ts";
  const cityAggregateSource = sources.get(cityAggregateFile) ?? "";
  if (
    /from\s+["']\.\/kingdoms\.js["']/u.test(cityAggregateSource)
    && /\b(?:FLAG_CONTROL_TOUCH_TOLERANCE_M|KINGDOM_FLAG_TOUCH_TOLERANCE_M|findForeignOrganizationConnection|isPersonalFlagControlledByPlayer|lockFlagControlGeometry)\b/u
      .test(cityAggregateSource)
  ) {
    addViolation(
      violations,
      "city-cannot-import-neutral-flag-geometry-from-kingdom",
      cityAggregateFile
    );
  }

  const landFootprintFile = "apps/server/src/game/landFootprintAuthority.ts";
  const landFootprintSource = sources.get(landFootprintFile);
  if (
    landFootprintSource !== undefined
    && (
      !/WORLD_RUNTIME_CONTRACT\.surfaceCellSizeM/u.test(landFootprintSource)
      || /\b(?:RIVER|LAKE|OCEAN|SURFACE)_CELL_SIZE_M\s*=\s*\d/u.test(landFootprintSource)
    )
  ) {
    addViolation(
      violations,
      "land-footprint-must-use-locked-world-cell-geometry",
      landFootprintFile
    );
  }

  const cycles = stronglyConnectedCycles(graph);
  for (const cycle of cycles) {
    const signature = cycle.join(" -> ");
    if (!baselineDependencyCycles.has(signature)) {
      addViolation(violations, "dependency-cycle", cycle[0], signature);
    }
  }

  return {
    files: files.length,
    edges: [...graph.values()].reduce((count, targets) => count + targets.length, 0),
    cycles,
    violations: violations.sort((left, right) =>
      `${left.rule}:${left.file}`.localeCompare(`${right.rule}:${right.file}`)
    )
  };
}

function addViolation(violations, rule, file, target) {
  const key = `${rule}:${file}`;
  violations.push({
    rule,
    file,
    ...(target ? { target } : {}),
    ...(temporaryExceptions.has(key)
      ? { temporaryException: temporaryExceptions.get(key) }
      : {})
  });
}

function importSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(importPattern)) specifiers.push(match[1] ?? match[2]);
  return specifiers;
}

function resolveImport(source, specifier, knownFiles) {
  if (!specifier.startsWith(".")) return null;
  const sourceDirectory = path.posix.dirname(source);
  const unresolved = path.posix.normalize(path.posix.join(sourceDirectory, specifier));
  const withoutJavaScript = unresolved.replace(/\.[cm]?js$/u, "");
  const candidates = [
    unresolved,
    withoutJavaScript,
    `${withoutJavaScript}.ts`,
    `${withoutJavaScript}.tsx`,
    `${withoutJavaScript}/index.ts`,
    `${withoutJavaScript}/index.tsx`
  ];
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? null;
}

function stronglyConnectedCycles(graph) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowLinks = new Map();
  const cycles = [];

  const visit = (node) => {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of graph.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) {
      cycles.push(component.sort());
    }
  };

  for (const node of [...graph.keys()].sort()) if (!indices.has(node)) visit(node);
  return cycles.sort((left, right) => left[0].localeCompare(right[0]));
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && !["dist", "node_modules", "coverage", ".cache"].includes(entry.name)) {
      files.push(...await walk(absolute));
    }
    else if (entry.isFile() && (await stat(absolute)).isFile()) files.push(absolute);
  }
  return files;
}

function normalize(value) {
  return value.replaceAll("\\", "/");
}
