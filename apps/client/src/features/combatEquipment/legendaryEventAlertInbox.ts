import {
  gameInboxEntryKey,
  LEGENDARY_BIRD_INBOX_EVENT_KIND,
  type CombatEquipmentServerMessage,
  type InboxReadTarget
} from "@ash-atlas/shared";

export type LegendaryEventAlert = Extract<
  CombatEquipmentServerMessage,
  { type: "LEGENDARY_EVENT_ALERT" }
>;

export function legendaryEventAlertInboxReadTarget(
  alert: LegendaryEventAlert
): InboxReadTarget {
  return {
    entryKey: gameInboxEntryKey(LEGENDARY_BIRD_INBOX_EVENT_KIND, alert.eventId),
    revision: alert.selectedAt
  };
}

export function shouldPresentLegendaryEventAlert(
  alert: LegendaryEventAlert,
  dismissedEventIds: ReadonlySet<string>,
  readReceipts: Readonly<Record<string, string>>
): boolean {
  if (dismissedEventIds.has(alert.eventId)) return false;
  const target = legendaryEventAlertInboxReadTarget(alert);
  return readReceipts[target.entryKey] !== target.revision;
}
