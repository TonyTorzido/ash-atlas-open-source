import type { HttpAdmissionPolicy } from "./admission.js";

export type HttpRouteMethod = "DELETE" | "GET" | "PATCH" | "POST";
export type HttpRouteFamily =
  | "collectibles"
  | "diagnostics"
  | "flags"
  | "players"
  | "system"
  | "world";
export type HttpAuthenticationPolicy =
  | "developer"
  | "player"
  | "player-or-developer"
  | "public"
  | "trace-owner";
export type HttpDisconnectPolicy =
  | "admission-lifecycle"
  | "admission-signal"
  | "fastify-lifecycle";
export type HttpTimeoutPolicy = "admission-queue" | "world-client" | "none";

export type HttpRoutePolicy = Readonly<{
  method: HttpRouteMethod;
  path: string;
  family: HttpRouteFamily;
  authentication: HttpAuthenticationPolicy;
  admission: HttpAdmissionPolicy | null;
  developerOnly: boolean;
  timeout: HttpTimeoutPolicy;
  disconnect: HttpDisconnectPolicy;
}>;

const route = (
  method: HttpRouteMethod,
  path: string,
  family: HttpRouteFamily,
  authentication: HttpAuthenticationPolicy,
  admission: HttpAdmissionPolicy | null = null,
  overrides: Partial<Pick<HttpRoutePolicy, "timeout" | "disconnect">> = {}
): HttpRoutePolicy => ({
  method,
  path,
  family,
  authentication,
  admission,
  developerOnly: authentication === "developer",
  timeout: overrides.timeout ?? (admission ? "admission-queue" : "none"),
  disconnect: overrides.disconnect ?? (admission ? "admission-lifecycle" : "fastify-lifecycle")
});

/**
 * Authoritative inventory for route ownership and transport policy. Adding a route requires an
 * entry here; routePolicyRegistry.test.ts proves this list remains complete and duplicate-free.
 */
export const HTTP_ROUTE_POLICIES = [
  route("GET", "/health", "system", "public"),
  route("GET", "/ready", "system", "public"),
  route("GET", "/api/world/lookup", "world", "public", "expensive", {
    timeout: "world-client",
    disconnect: "admission-signal"
  }),
  route("POST", "/api/flags/placement-quote", "flags", "player", "standard", {
    disconnect: "admission-signal"
  }),
  route("GET", "/api/flags", "flags", "player", "expensive"),
  route("GET", "/api/map/strategic-vision", "flags", "player", "expensive"),
  route("GET", "/api/flags/atlas-shrines/status", "flags", "player"),
  route("POST", "/api/flags/atlas-shrines/unlock", "flags", "player"),
  route("POST", "/api/flags/:id/upgrade", "flags", "player"),
  route("POST", "/api/flags/:id/repair", "flags", "player"),
  route("GET", "/api/flags/:id/environment", "flags", "public", "expensive"),
  route("GET", "/api/territory/resolve", "flags", "public", "expensive"),
  route("GET", "/api/players/online", "players", "public", "standard"),
  route("GET", "/api/inventory/:id", "players", "player-or-developer", "standard"),
  route("POST", "/api/collectibles/survey", "collectibles", "player", "expensive"),
  route("GET", "/api/collectibles/nearby", "collectibles", "player", "expensive"),
  route("POST", "/api/collectibles/pickup", "collectibles", "player"),
  route("POST", "/api/collectibles/water/collect", "collectibles", "player", "expensive"),
  route("GET", "/api/players/:id", "players", "public", "standard"),
  route("PATCH", "/api/players/:id/color", "players", "player-or-developer"),
  route("POST", "/api/flags", "flags", "player", "expensive"),
  route("DELETE", "/api/flags/:id", "flags", "player-or-developer"),
  route("PATCH", "/api/flags/:id", "flags", "player-or-developer"),
  route("GET", "/api/dev/flags/count", "flags", "developer"),
  route("GET", "/api/dev/diagnostics/database", "diagnostics", "developer"),
  route("GET", "/api/dev/diagnostics/realtime", "diagnostics", "developer"),
  route("GET", "/api/dev/diagnostics/perf", "diagnostics", "developer"),
  route("GET", "/api/dev/diagnostics/perf/samples", "diagnostics", "developer"),
  route("POST", "/api/diagnostics/perf-sample", "diagnostics", "trace-owner", "standard"),
  route("GET", "/api/dev/diagnostics/population", "diagnostics", "developer"),
  route("GET", "/api/diagnostics/gameplay-latency-trace", "diagnostics", "trace-owner"),
  route("POST", "/api/diagnostics/gameplay-latency-trace/start", "diagnostics", "trace-owner"),
  route("POST", "/api/diagnostics/gameplay-latency-trace/stop", "diagnostics", "trace-owner"),
  route("DELETE", "/api/diagnostics/gameplay-latency-trace", "diagnostics", "trace-owner"),
  route("POST", "/api/diagnostics/gameplay-latency-trace/mark", "diagnostics", "trace-owner"),
  route("POST", "/api/diagnostics/gameplay-latency-trace/events", "diagnostics", "trace-owner"),
  route("GET", "/api/dev/permanent-mines", "collectibles", "developer"),
  route("DELETE", "/api/dev/flags", "flags", "developer"),
  route("POST", "/api/dev/flags/environment/refresh", "flags", "developer"),
  route("GET", "/api/dev/flags/:id/environment-diagnostics", "flags", "developer"),
  route("GET", "/api/dev/spawns/count", "diagnostics", "developer"),
  route("POST", "/api/dev/player/teleport", "players", "developer")
] as const satisfies readonly HttpRoutePolicy[];

const duplicateKeys = duplicateRouteKeys(HTTP_ROUTE_POLICIES);
if (duplicateKeys.length > 0) {
  throw new Error(`duplicate HTTP route policies: ${duplicateKeys.join(", ")}`);
}

export function httpAdmissionPolicies(): ReadonlyMap<string, HttpAdmissionPolicy> {
  return new Map(
    HTTP_ROUTE_POLICIES.flatMap((policy) =>
      policy.admission ? [[routeKey(policy), policy.admission] as const] : []
    )
  );
}

export function routeKey(policy: Pick<HttpRoutePolicy, "method" | "path">): string {
  return `${policy.method} ${policy.path}`;
}

function duplicateRouteKeys(policies: readonly HttpRoutePolicy[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const policy of policies) {
    const key = routeKey(policy);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}
