import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  HTTP_ROUTE_POLICIES,
  httpAdmissionPolicies,
  routeKey
} from "./routePolicyRegistry.js";

describe("HTTP route policy registry", () => {
  it("owns every registered route exactly once", () => {
    const registered = [
      ...[
        "collectibleRoutes.ts",
        "diagnosticRoutes.ts",
        "flagRoutes.ts",
        "playerRoutes.ts",
        "systemRoutes.ts",
        "worldRoutes.ts"
      ].flatMap((fileName) => ownedRoutesIn(`routes/${fileName}`))
    ].sort();
    const policies = HTTP_ROUTE_POLICIES.map(routeKey).sort();

    expect(new Set(registered).size).toBe(registered.length);
    expect(new Set(policies).size).toBe(policies.length);
    expect(policies).toEqual(registered);
  });

  it("derives admission configuration only from typed route policy", () => {
    const expected = HTTP_ROUTE_POLICIES
      .filter((policy) => policy.admission !== null)
      .map((policy) => [routeKey(policy), policy.admission] as const);

    expect([...httpAdmissionPolicies()]).toEqual(expected);
    expect(HTTP_ROUTE_POLICIES.filter((policy) => policy.developerOnly)
      .every((policy) => policy.authentication === "developer")).toBe(true);
  });
});

function ownedRoutesIn(fileName: string): string[] {
  const source = readFileSync(fileURLToPath(new URL(fileName, import.meta.url)), "utf8");
  return [...source.matchAll(
    /\b(?:collectible|diagnostic|flag|player|system|world)Routes\.(delete|get|patch|post)\(\s*"([^"]+)"/g
  )].map((match) => `${match[1]!.toUpperCase()} ${match[2]!}`);
}
