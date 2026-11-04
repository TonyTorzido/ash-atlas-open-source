import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadConfig, publicConfigSummary } from "../config.js";
import { createLogger } from "../logger.js";
import { ClosedTestTelemetryService } from "./service.js";

describe("closed-test telemetry privacy architecture", () => {
  it("is disabled by default and never publishes its database URL", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.TELEMETRY_ENABLED).toBe(false);
    expect(config.BUG_REPORTS_ENABLED).toBe(false);
    expect(config.TELEMETRY_HOST_ENABLED).toBe(false);
    expect(config.TELEMETRY_EXPORT_ENABLED).toBe(false);
    expect(publicConfigSummary(config)).not.toHaveProperty("telemetryDatabaseUrl");
    expect(JSON.stringify(publicConfigSummary(config))).not.toContain("postgres");
    const service = new ClosedTestTelemetryService(config, createLogger("test"));
    service.start();
    expect(service.metricsSnapshot()).toMatchObject({
      enabled: false,
      activeRunId: null,
      pool: null,
      queue: { depth: 0 }
    });
  });

  it("has no telemetry HTTP route or player-facing server frame", () => {
    const application = readFileSync(new URL("../application.ts", import.meta.url), "utf8");
    const routes = readFileSync(new URL("../http/routes.ts", import.meta.url), "utf8");
    expect(application).not.toMatch(/app\.(?:get|post|put|delete)\([^)]*telemetry/i);
    expect(routes).not.toMatch(/["'`]\/[^"'`]*telemetry/i);
  });

  it("keeps writer and exporter grants out of the public schema", () => {
    const roles = readFileSync(
      new URL("../../../../db/admin/telemetry_roles.sql", import.meta.url),
      "utf8"
    );
    expect(roles).toContain("REVOKE ALL ON SCHEMA public");
    expect(roles).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE).*SCHEMA public/is);
    expect(roles).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA telemetry");
  });

  it("keeps exports outside web roots and adds no public listener", () => {
    const exporter = readFileSync(
      new URL("../../../../tools/release/vps/export-closed-test-telemetry.sh", import.meta.url),
      "utf8"
    );
    const hostUnit = readFileSync(
      new URL("../../../../tools/release/vps/ash-atlas-telemetry-host.service", import.meta.url),
      "utf8"
    );
    expect(exporter).toContain("/var/lib/ash-atlas/telemetry-exports");
    expect(exporter).not.toMatch(/\/var\/www|client\/dist|ListenStream/i);
    expect(hostUnit).not.toMatch(/ListenStream|5432|0\.0\.0\.0/);
    const hostSampler = readFileSync(
      new URL("../../../../tools/release/vps/host-telemetry-sample.sh", import.meta.url),
      "utf8"
    );
    expect(hostSampler).toContain(
      "segment_end_at IS NULL OR clock_timestamp() < segment_end_at"
    );
  });

  it("defines no server-to-player telemetry message", () => {
    const serverMessages = readFileSync(
      new URL("../../../../packages/shared/src/protocol/serverMessages.ts", import.meta.url),
      "utf8"
    );
    expect(serverMessages).not.toMatch(/TELEMETRY/i);
  });

  it("keeps report transport private and excludes forbidden diagnostic content", () => {
    const service = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
    const clientDiagnostics = readFileSync(
      new URL("../../../../apps/client/src/diagnostics/bugReportDiagnostics.ts", import.meta.url),
      "utf8"
    );
    expect(service).toMatch(/FORBIDDEN_BUG_REPORT_KEY/);
    expect(service).toContain("chat|direct_?message|dm_?content");
    expect(service).toContain("oauth|access_?token|refresh_?token|cookie");
    expect(service).toContain("device_?gps|geolocation");
    expect(clientDiagnostics).not.toMatch(/pointermove|touchmove|localStorage|sessionStorage/);
    expect(clientDiagnostics).not.toMatch(/message\.content|message\.body|rawPayload/);
  });
});
