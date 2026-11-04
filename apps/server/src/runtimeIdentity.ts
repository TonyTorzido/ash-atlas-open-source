import type { AppConfig } from "./config.js";

export type DevelopmentRuntimeIdentity = {
  label: string;
  branch: string;
  sha: string;
};

export function runtimeIdentity(
  config: Pick<AppConfig, "RUNTIME_LABEL" | "RUNTIME_BRANCH" | "RUNTIME_SHA">
): DevelopmentRuntimeIdentity | null {
  if (!config.RUNTIME_LABEL || !config.RUNTIME_BRANCH || !config.RUNTIME_SHA) return null;
  return {
    label: config.RUNTIME_LABEL,
    branch: config.RUNTIME_BRANCH,
    sha: config.RUNTIME_SHA
  };
}

export function developmentRuntimeIdentity(
  config: Pick<AppConfig, "NODE_ENV" | "RUNTIME_LABEL" | "RUNTIME_BRANCH" | "RUNTIME_SHA">
): DevelopmentRuntimeIdentity | null {
  return config.NODE_ENV === "development" ? runtimeIdentity(config) : null;
}
