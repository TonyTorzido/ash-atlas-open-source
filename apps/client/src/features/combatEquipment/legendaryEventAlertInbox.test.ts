import { describe, expect, it } from "vitest";

import {
  legendaryEventAlertInboxReadTarget,
  shouldPresentLegendaryEventAlert
} from "./legendaryEventAlertInbox.js";

describe("legendary event alert inbox target", () => {
  it("maps the dismissed alert to its canonical durable notice revision", () => {
    expect(legendaryEventAlertInboxReadTarget({
      type: "LEGENDARY_EVENT_ALERT",
      eventId: "00000000-0000-4000-8000-000000000099",
      birdSpecies: "ice",
      flagId: "flag-1",
      message: "An Ice Phoenix is attacking your flag!",
      selectedAt: "2099-01-01T00:00:00.000Z",
      expiresAt: "2099-01-02T00:00:00.000Z"
    })).toEqual({
      entryKey: "game:legendary_bird_event:00000000-0000-4000-8000-000000000099",
      revision: "2099-01-01T00:00:00.000Z"
    });
  });

  it("suppresses only the dismissed alert occurrence", () => {
    const alert = {
      type: "LEGENDARY_EVENT_ALERT" as const,
      eventId: "00000000-0000-4000-8000-000000000099",
      birdSpecies: "ice" as const,
      flagId: "flag-1",
      message: "An Ice Phoenix is attacking your flag!",
      selectedAt: "2099-01-01T00:00:00.000Z",
      expiresAt: "2099-01-02T00:00:00.000Z"
    };
    const target = legendaryEventAlertInboxReadTarget(alert);

    expect(shouldPresentLegendaryEventAlert(alert, new Set([alert.eventId]), {})).toBe(false);
    expect(shouldPresentLegendaryEventAlert({
      ...alert,
      eventId: "00000000-0000-4000-8000-000000000100"
    }, new Set([alert.eventId]), {})).toBe(true);
    expect(shouldPresentLegendaryEventAlert(
      alert,
      new Set(),
      { [target.entryKey]: target.revision }
    )).toBe(false);
    expect(shouldPresentLegendaryEventAlert(
      alert,
      new Set(),
      { [target.entryKey]: "stale-revision" }
    )).toBe(true);
  });
});
