import type { PublicProfile } from "@ash-atlas/shared";

import type { OrganizationWar } from "../../ui/OrganizationWarsSection.js";

/** The viewer's active city/kingdom wars, from the same `/api/wars` snapshot the Organization Wars panel uses. */
export async function fetchViewerWars(serverHttpBase: string, csrfToken: string): Promise<readonly OrganizationWar[]> {
  const response = await fetch(new URL("/api/wars", serverHttpBase), {
    credentials: "include",
    headers: { "x-csrf-token": csrfToken }
  });
  if (!response.ok) return [];
  const payload = await response.json().catch(() => null) as { state?: { wars?: OrganizationWar[] } } | null;
  return payload?.state?.wars ?? [];
}

/** True when any active war has the profile's kingdom or city as the enemy side. */
export function isAtWarWith(
  wars: readonly OrganizationWar[],
  profile: Pick<PublicProfile, "kingdom" | "settlement">
): boolean {
  return wars.some((war) =>
    (war.enemy.kind === "kingdom" && profile.kingdom?.id === war.enemy.id) ||
    (war.enemy.kind === "city" && profile.settlement?.id === war.enemy.id));
}
