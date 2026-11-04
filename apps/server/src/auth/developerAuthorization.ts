import {
  type DeveloperCapability
} from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import type { AuthenticatedSession } from "./types.js";

export type DeveloperCommandTransport = "http" | "websocket";
export type DeveloperCommandOutcome = "authorized" | "rejected" | "succeeded" | "failed";

export type DeveloperCommandAudit = {
  capability: DeveloperCapability;
  command: string;
  transport: DeveloperCommandTransport;
  outcome: DeveloperCommandOutcome;
  target?: string | null;
  operationKey?: string | null;
  reason?: string | null;
};

export class DeveloperAuthorizationError extends Error {
  readonly code = "DEVELOPER_COMMAND_FORBIDDEN";
  readonly statusCode = 403;

  constructor() {
    super("Developer command is unavailable");
    this.name = "DeveloperAuthorizationError";
  }
}

export function developerCapabilitiesForSession(
  config: AppConfig,
  session: AuthenticatedSession | null
): DeveloperCapability[] {
  const subject = session?.verifiedGoogleSubject;
  if (!subject) return [];

  const capabilities: DeveloperCapability[] = [];
  if (config.DEV_AUTHORIZED_GOOGLE_SUBJECTS.includes(subject)) {
    capabilities.push("developer:wiki-manage");
  }
  if (config.TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS.includes(subject)) {
    capabilities.push(
      "developer:test-access-manage",
      "developer:announcements-manage"
    );
  }
  if (
    config.DEV_TOOLS_ENABLED &&
    config.DEV_AUTHORIZED_GOOGLE_SUBJECTS.includes(subject)
  ) {
    capabilities.push("developer:observe", "developer:appearance-studio");
  }
  if (
    capabilities.includes("developer:observe") &&
    config.DEV_PRIVATE_LEADERBOARD_GOOGLE_SUBJECTS.includes(subject)
  ) {
    capabilities.push("developer:leaderboards-private");
  }
  if (
    capabilities.includes("developer:observe") &&
    config.DEV_ADMIN_TOOLS_ENABLED
  ) {
    capabilities.push(
      "developer:world-mutate",
      "developer:assets-grant",
      "developer:packages-send"
    );
    if (isDeveloperEconomyMode(config)) {
      capabilities.push("developer:economy-mutate");
    }
  }
  return capabilities;
}

/**
 * Dev test-access mode always admits these verified Google subjects, so the
 * administrator can never lock themselves out of switching the mode back.
 */
export function developerAccessSubjects(
  config: Pick<AppConfig, "DEV_AUTHORIZED_GOOGLE_SUBJECTS" | "TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS">
): string[] {
  return [
    ...new Set([
      ...config.DEV_AUTHORIZED_GOOGLE_SUBJECTS,
      ...config.TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS
    ])
  ];
}

export function isDeveloperAccessSession(
  config: Pick<AppConfig, "DEV_AUTHORIZED_GOOGLE_SUBJECTS" | "TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS">,
  session: Pick<AuthenticatedSession, "verifiedGoogleSubject"> | null
): boolean {
  const subject = session?.verifiedGoogleSubject;
  return Boolean(subject) && developerAccessSubjects(config).includes(subject!);
}

export function hasDeveloperCapability(
  config: AppConfig,
  session: AuthenticatedSession | null,
  capability: DeveloperCapability
): boolean {
  return developerCapabilitiesForSession(config, session).includes(capability);
}

export function isDeveloperEconomyMode(config: AppConfig): boolean {
  return (
    isPrivateDeveloperEconomyMode(config) ||
    isProductionDeveloperEconomyMode(config)
  );
}

export function isPrivateDeveloperEconomyMode(config: AppConfig): boolean {
  return (
    config.AUTH_RUNTIME_MODE !== "public" &&
    config.NODE_ENV === "development" &&
    config.AUTH_MODE === "dev" &&
    config.AUTH_DEV_LOGIN_ENABLED &&
    config.DEV_ADMIN_TOOLS_ENABLED
  );
}

export function isProductionDeveloperEconomyMode(config: AppConfig): boolean {
  return (
    config.NODE_ENV === "production" &&
    config.AUTH_RUNTIME_MODE === "public" &&
    config.AUTH_MODE === "google" &&
    !config.AUTH_DEV_LOGIN_ENABLED &&
    config.DEV_TOOLS_ENABLED &&
    config.DEV_ADMIN_TOOLS_ENABLED &&
    config.DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED &&
    config.DEV_AUTHORIZED_GOOGLE_SUBJECTS.length > 0
  );
}

export function developmentAssetGrantCapability(
  grant: {
    gold?: string | undefined;
    cityCoins?: string | undefined;
    glimmer?: string | undefined;
    lumen?: string | undefined;
    materials?: unknown;
  }
): DeveloperCapability {
  return grant.gold === undefined &&
    grant.cityCoins === undefined &&
    grant.glimmer === undefined &&
    grant.lumen === undefined
    ? "developer:assets-grant"
    : "developer:economy-mutate";
}

export function developerAuditMetadata(
  config: AppConfig,
  input: DeveloperCommandAudit
): Record<string, unknown> {
  return {
    capability: input.capability,
    command: input.command,
    transport: input.transport,
    outcome: input.outcome,
    target: input.target ?? null,
    operationKey: input.operationKey ?? null,
    reason: input.reason ?? null,
    releaseSha: config.RUNTIME_SHA ?? null
  };
}
