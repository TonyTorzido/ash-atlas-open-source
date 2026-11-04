import type { FlagAccessSnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { resolveFlagVisitAction } from "./flagVisitAction.js";

describe("resolveFlagVisitAction", () => {
  it("gives a Kingdom Flag the same action with or without a personal-access response", () => {
    const options = {
      flag: { controlType: "kingdom" as const },
      connected: true,
      travelPending: false,
      aggressiveRemainingMs: 0
    };

    expect(resolveFlagVisitAction({
      ...options,
      access: unsupportedKingdomAccess()
    })).toEqual(resolveFlagVisitAction(options));
    expect(resolveFlagVisitAction(options)).toEqual({
      kind: "visit",
      label: "Travel",
      enabled: true,
      busy: false
    });
  });

  it("preserves an authoritative private personal-flag denial", () => {
    expect(resolveFlagVisitAction({
      flag: { controlType: "personal" },
      access: privatePersonalAccess(),
      connected: true,
      travelPending: false,
      aggressiveRemainingMs: 0
    })).toEqual({
      kind: "visit",
      label: "Private Flag",
      enabled: false,
      disabledReason: "You do not have access to this flag.",
      busy: false,
      expectedTollGold: "0"
    });
  });

  it("never offers travel for a marked developer warfare fixture", () => {
    expect(resolveFlagVisitAction({
      flag: { controlType: "personal", developerTestTarget: true },
      access: {
        ...privatePersonalAccess(),
        mode: "normal",
        decision: {
          allowed: true,
          requestable: false,
          reasonCode: "ALLOWED_OWNER",
          tollGold: "0"
        }
      },
      connected: true,
      travelPending: false,
      aggressiveRemainingMs: 0
    })).toMatchObject({
      enabled: false,
      disabledReason: "Test fortifications are hostile targets and cannot be visited."
    });
  });

  it("applies the same common travel locks to non-personal flags", () => {
    expect(resolveFlagVisitAction({
      flag: { controlType: "kingdom" },
      connected: true,
      travelPending: true,
      aggressiveRemainingMs: 0
    })).toMatchObject({
      label: "Traveling...",
      enabled: false,
      disabledReason: "Travel is already in progress.",
      busy: true
    });
    expect(resolveFlagVisitAction({
      flag: { controlType: "kingdom" },
      connected: true,
      travelPending: false,
      aggressiveRemainingMs: 5_000
    })).toMatchObject({
      enabled: false,
      disabledReason: "Flag travel is locked while Aggressive."
    });
  });
});

function unsupportedKingdomAccess(): FlagAccessSnapshot {
  return access("FLAG_TYPE_UNSUPPORTED");
}

function privatePersonalAccess(): FlagAccessSnapshot {
  return access("PRIVATE_OWNER_ONLY");
}

function access(reasonCode: "FLAG_TYPE_UNSUPPORTED" | "PRIVATE_OWNER_ONLY"): FlagAccessSnapshot {
  return {
    flagId: "flag-1",
    ownerPlayerId: "owner-1",
    mode: "private",
    jumpTollGold: "0",
    accessRevision: "1",
    requestPending: false,
    decision: {
      allowed: false,
      requestable: false,
      reasonCode,
      tollGold: "0"
    },
    management: null
  };
}
