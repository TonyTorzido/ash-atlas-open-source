import type { PlayerAnnouncement, PlayerAnnouncementListResponse } from "@ash-atlas/shared";

export function compareAnnouncements(left: PlayerAnnouncement, right: PlayerAnnouncement): number {
  const publishedAt = Date.parse(left.publishedAt) - Date.parse(right.publishedAt);
  return publishedAt === 0 ? left.id.localeCompare(right.id) : publishedAt;
}

export function mergeAnnouncementHistory(
  current: readonly PlayerAnnouncement[],
  incoming: readonly PlayerAnnouncement[]
): PlayerAnnouncement[] {
  const byId = new Map(current.map((announcement) => [announcement.id, announcement]));
  for (const announcement of incoming) byId.set(announcement.id, announcement);
  return [...byId.values()]
    .sort((left, right) => compareAnnouncements(right, left))
    .slice(0, 50);
}

export function announcementListPresentation(
  currentNewest: PlayerAnnouncement | null,
  result: PlayerAnnouncementListResponse,
  locallyDismissedIds: ReadonlySet<string>
): { newest: PlayerAnnouncement | null; hud: PlayerAnnouncement | null } | null {
  const newest = result.announcements[0] ?? null;
  if (currentNewest && (!newest || compareAnnouncements(newest, currentNewest) < 0)) return null;
  return {
    newest,
    hud: newest && !result.latestAnnouncementDismissed && !locallyDismissedIds.has(newest.id)
      ? newest
      : null
  };
}

export function shouldRestoreFailedDismissal(
  dismissedAnnouncementId: string,
  currentNewest: PlayerAnnouncement | null
): boolean {
  return currentNewest?.id === dismissedAnnouncementId;
}
