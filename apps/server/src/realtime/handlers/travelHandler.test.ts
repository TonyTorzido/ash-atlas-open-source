import { describe, expect, it, vi } from "vitest";

import {
  createTravelHandler,
  passivePeriodicFixMinIntervalMs,
  type TravelHandlerContext
} from "./travelHandler.js";
import {
  RELOCATION_NATIVE_ONLY_MESSAGE,
  RELOCATION_RED_REFUSED_MESSAGE
} from "../../auth/trust/relocationGate.js";
import type { RelocationStatus } from "../../game/players.js";

describe("GPS relocation authority", () => {
  it("rejects malformed coordinates without invoking travel or consuming cooldown", async () => {
    const context = gpsContext();
    const handler = createTravelHandler(context);

    await handler({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-malformed",
      lat: Number.NaN,
      lon: -105.27
    });

    expect(context.performAuthoritativeTravel).not.toHaveBeenCalled();
    expect(context.playerService.relocationStatus).not.toHaveBeenCalled();
    expect(context.safeSendServerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "TRAVEL_RESULT",
        kind: "gps_relocate",
        success: false,
        message: "Your device returned an invalid location. Try again."
      }),
      expect.anything(),
      expect.objectContaining({ requestId: "gps-malformed" })
    );
  });

  it("rejects an unauthenticated request before checking durable cooldown", async () => {
    const context = gpsContext({ authenticatedSession: null });
    const handler = createTravelHandler(context);

    await handler({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-unauthorized",
      lat: 40.015,
      lon: -105.27
    });

    expect(context.playerService.relocationStatus).not.toHaveBeenCalled();
    expect(context.performAuthoritativeTravel).not.toHaveBeenCalled();
    expect(context.safeSendServerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "TRAVEL_RESULT",
        kind: "gps_relocate",
        success: false,
        message: "Relocate is available from the World Map only."
      }),
      expect.anything(),
      expect.objectContaining({ requestId: "gps-unauthorized" })
    );
  });

  it("passes validated device coordinates through the canonical travel operation", async () => {
    const context = gpsContext();
    context.playerService.relocationStatus.mockResolvedValue({
      lastRelocatedAt: null,
      relocationAvailableAt: null,
      travelInviteAvailableAt: null,
      serverTime: Date.now()
    });
    context.performAuthoritativeTravel.mockResolvedValue({
      success: true,
      player: {} as never
    });
    const handler = createTravelHandler(context);

    await handler({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-valid",
      lat: 40.015,
      lon: -105.27,
      accuracy: 12
    });

    expect(context.performAuthoritativeTravel).toHaveBeenCalledWith(expect.objectContaining({
      playerId: "player-1",
      requestId: "gps-valid",
      kind: "gps_relocate",
      chargeTravelHunger: false,
      arrivalMode: "ordinary_relocation",
      populationSourceKind: "administrative-relocation",
      destination: {
        kind: "world",
        id: null,
        center: { lat: 40.015, lon: -105.27 }
      }
    }));
  });

  it("rejects a durable relocation cooldown before invoking travel", async () => {
    const relocationAvailableAt = Date.now() + 60_000;
    const context = gpsContext();
    context.playerService.relocationStatus.mockResolvedValue({
      lastRelocatedAt: new Date(),
      relocationAvailableAt,
      travelInviteAvailableAt: Date.now() + 30_000,
      serverTime: Date.now()
    });
    const handler = createTravelHandler(context);

    await handler({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-cooldown",
      lat: 40.015,
      lon: -105.27
    });

    expect(context.performAuthoritativeTravel).not.toHaveBeenCalled();
    expect(context.safeSendServerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "TRAVEL_RESULT",
        kind: "gps_relocate",
        success: false,
        retryAfterMs: expect.any(Number),
        relocationAvailableAt,
        message: "You can relocate again after the 7-day cooldown."
      }),
      expect.anything(),
      expect.objectContaining({ requestId: "gps-cooldown" })
    );
  });

  it("lets a cooldown exemption through and gives a failed free re-pick back", async () => {
    for (const kind of ["return_home", "free_repick"] as const) {
      const release = vi.fn(async () => undefined);
      const relocationExemption = vi.fn(async () => ({ kind, release }));
      const context = { ...gpsContext(), settlement: { relocationExemption } as never };
      const lastRelocatedAt = new Date();
      context.playerService.relocationStatus.mockResolvedValue({
        lastRelocatedAt,
        relocationAvailableAt: Date.now() + 60_000,
        travelInviteAvailableAt: Date.now() + 30_000,
        serverTime: Date.now()
      });
      context.performAuthoritativeTravel.mockResolvedValue({
        success: false,
        reason: { code: "TRAVEL_FAILED", message: "Travel could not be completed." }
      });
      await createTravelHandler(context)({
        type: "RELOCATE_TO_CURRENT_LOCATION",
        requestId: `gps-${kind}`,
        lat: 40.015,
        lon: -105.27
      });
      expect(relocationExemption).toHaveBeenCalledWith(expect.objectContaining({
        lat: 40.015, lon: -105.27, inCooldown: true, lastRelocatedAt
      }));
      expect(context.performAuthoritativeTravel).toHaveBeenCalledWith(expect.objectContaining({
        kind: "gps_relocate",
        relocationCooldown: kind
      }));
      expect(release).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses a red-zone relocation without travel and gives the free re-pick back", async () => {
    const release = vi.fn(async () => undefined);
    const relocationExemption = vi.fn(async () => ({ kind: "free_repick" as const, release }));
    const relocationGate = {
      checkPlatform: vi.fn(async () => null),
      checkDestination: vi.fn(async () => ({ allowed: false as const, message: RELOCATION_RED_REFUSED_MESSAGE }))
    };
    const locationReports = fakeLocationReports("accepted");
    const context = gpsContext({
      settlement: { relocationExemption } as never,
      relocationGate: relocationGate as never,
      locationReports: locationReports as never
    });
    context.playerService.relocationStatus.mockResolvedValue({
      lastRelocatedAt: new Date(),
      relocationAvailableAt: Date.now() + 60_000,
      travelInviteAvailableAt: null,
      serverTime: Date.now()
    });
    await createTravelHandler(context)({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-red",
      lat: -80.5,
      lon: 20.25
    });
    expect(relocationGate.checkDestination).toHaveBeenCalledWith({ accountId: "account-1", lat: -80.5, lon: 20.25 });
    expect(context.performAuthoritativeTravel).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(locationReports.record).toHaveBeenCalledWith(expect.anything(), expect.anything(), "travel_failed");
    expect(context.safeSendServerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "TRAVEL_RESULT", success: false, message: RELOCATION_RED_REFUSED_MESSAGE }),
      expect.anything(),
      expect.objectContaining({ requestId: "gps-red" })
    );
  });

  it("closes a locked account's connections only after answering the red refusal", async () => {
    const release = vi.fn(async () => undefined);
    const relocationExemption = vi.fn(async () => ({ kind: "free_repick" as const, release }));
    const order: string[] = [];
    const afterRefusal = vi.fn(async () => {
      order.push("close");
    });
    const relocationGate = {
      checkPlatform: vi.fn(async () => null),
      checkDestination: vi.fn(async () => ({
        allowed: false as const,
        message: RELOCATION_RED_REFUSED_MESSAGE,
        afterRefusal
      }))
    };
    const context = gpsContext({
      settlement: { relocationExemption } as never,
      relocationGate: relocationGate as never,
      locationReports: fakeLocationReports("accepted") as never
    });
    context.safeSendServerMessage.mockImplementation(() => {
      order.push("answer");
    });
    await createTravelHandler(context)({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-red-new",
      lat: -80.5,
      lon: 20.25
    });
    expect(context.performAuthoritativeTravel).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(afterRefusal).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["answer", "close"]);
  });

  it("refuses web relocation in phone-only enforce before the cooldown check", async () => {
    const relocationGate = {
      checkPlatform: vi.fn(async () => RELOCATION_NATIVE_ONLY_MESSAGE),
      checkDestination: vi.fn()
    };
    const context = gpsContext({ relocationGate: relocationGate as never, clientPlatform: "web" });
    await createTravelHandler(context)({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-web",
      lat: 40.015,
      lon: -105.27
    });
    expect(relocationGate.checkPlatform).toHaveBeenCalledWith({ accountId: "account-1", clientPlatform: "web" });
    expect(context.playerService.relocationStatus).not.toHaveBeenCalled();
    expect(relocationGate.checkDestination).not.toHaveBeenCalled();
    expect(context.performAuthoritativeTravel).not.toHaveBeenCalled();
    expect(context.safeSendServerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ success: false, message: RELOCATION_NATIVE_ONLY_MESSAGE }),
      expect.anything(),
      expect.anything()
    );
  });

  it("applies zone effects after the committed report and refreshes the exemption hint", async () => {
    const order: string[] = [];
    const committed = vi.fn(async () => {
      order.push("committed");
    });
    const zoneRelease = vi.fn(async () => undefined);
    const relocationGate = {
      checkPlatform: vi.fn(async () => null),
      checkDestination: vi.fn(async () => ({ allowed: true as const, release: zoneRelease, committed }))
    };
    const locationReports = fakeLocationReports("accepted");
    locationReports.record.mockImplementation(async () => {
      order.push("record");
      return { reportId: "report-1", seq: 1 };
    });
    const sendTravelInboxForPlayers = vi.fn(async () => undefined);
    const context = gpsContext({
      relocationGate: relocationGate as never,
      locationReports: locationReports as never,
      settlement: { relocationExemption: vi.fn(async () => null) } as never,
      sendTravelInboxForPlayers
    });
    context.performAuthoritativeTravel.mockResolvedValue({ success: true, player: {} as never });
    await createTravelHandler(context)({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-orange",
      lat: 40.015,
      lon: -105.27
    });
    expect(order).toEqual(["record", "committed"]);
    expect(zoneRelease).not.toHaveBeenCalled();
    expect(sendTravelInboxForPlayers).toHaveBeenCalledWith(["player-1"]);

    const failing = gpsContext({ relocationGate: relocationGate as never });
    await createTravelHandler(failing)({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-orange-failed",
      lat: 40.015,
      lon: -105.27
    });
    expect(zoneRelease).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledTimes(1);
  });

  it("tells the client whether an exemption remains when refusing a cooldown", async () => {
    const relocationExemptionAvailable = vi.fn(async () => false);
    const context = gpsContext({
      settlement: { relocationExemption: vi.fn(async () => null), relocationExemptionAvailable } as never
    });
    const lastRelocatedAt = new Date();
    context.playerService.relocationStatus.mockResolvedValue({
      lastRelocatedAt,
      relocationAvailableAt: Date.now() + 60_000,
      travelInviteAvailableAt: null,
      serverTime: Date.now()
    });
    await createTravelHandler(context)({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-cooldown-hint",
      lat: 40.015,
      lon: -105.27
    });
    expect(relocationExemptionAvailable).toHaveBeenCalledWith("account-1", lastRelocatedAt);
    expect(context.safeSendServerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        message: "You can relocate again after the 7-day cooldown.",
        relocationExemptionAvailable: false
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it("does not report or consume a cooldown when canonical travel fails", async () => {
    const context = gpsContext();
    context.performAuthoritativeTravel.mockResolvedValue({
      success: false,
      reason: { code: "TRAVEL_FAILED", message: "Travel could not be completed." }
    });
    const handler = createTravelHandler(context);

    await handler({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-failed",
      lat: 40.015,
      lon: -105.27
    });

    expect(context.performAuthoritativeTravel).toHaveBeenCalledOnce();
    expect(context.playerService.relocationStatus).toHaveBeenCalledTimes(2);
    expect(context.safeSendServerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "TRAVEL_RESULT",
        kind: "gps_relocate",
        success: false,
        relocationAvailableAt: null,
        travelInviteAvailableAt: null,
        message: "Travel could not be completed."
      }),
      expect.anything(),
      expect.objectContaining({ requestId: "gps-failed" })
    );
  });

  it("records an accepted location report after a shadow-mode relocation", async () => {
    const locationReports = fakeLocationReports("shadow_rejected");
    const context = gpsContext({
      locationReports: locationReports as never,
      clientPlatform: "ios",
      connectionNetwork: { networkHash: "v1:net", networkPrefixHash: "v1:prefix", keyVersion: "v1" }
    });
    context.performAuthoritativeTravel.mockResolvedValue({ success: true, player: {} as never });
    const handler = createTravelHandler(context);

    await handler({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-shadow",
      lat: 40.015,
      lon: -105.27,
      accuracy: 12
    });

    expect(context.performAuthoritativeTravel).toHaveBeenCalledOnce();
    expect(locationReports.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account-1",
      playerId: "player-1",
      source: "relocation",
      accuracyM: 12,
      clientPlatform: "ios",
      networkHash: "v1:net",
      networkPrefixHash: "v1:prefix",
      avatarPosition: { lat: 35, lon: -106 }
    }));
    expect(locationReports.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ verdict: "shadow_rejected" }),
      "accepted"
    );
  });

  it("refuses an enforce-mode rejection without traveling", async () => {
    const locationReports = fakeLocationReports("rejected");
    const context = gpsContext({ locationReports: locationReports as never });
    const handler = createTravelHandler(context);

    await handler({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-enforce",
      lat: 40.015,
      lon: -105.27
    });

    expect(context.performAuthoritativeTravel).not.toHaveBeenCalled();
    expect(context.safeSendServerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "TRAVEL_RESULT",
        success: false,
        message: "Your device location could not be confirmed. Try again later."
      }),
      expect.anything(),
      expect.objectContaining({ requestId: "gps-enforce" })
    );
    expect(locationReports.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ verdict: "rejected" }),
      "travel_failed"
    );
  });

  it("still relocates when location trust evaluation and recording fail", async () => {
    const locationReports = {
      evaluate: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
      record: vi.fn()
    };
    const context = gpsContext({ locationReports: locationReports as never });
    context.performAuthoritativeTravel.mockResolvedValue({ success: true, player: {} as never });
    const handler = createTravelHandler(context);

    await handler({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-trust-down",
      lat: 40.015,
      lon: -105.27
    });

    expect(context.performAuthoritativeTravel).toHaveBeenCalledOnce();
    expect(locationReports.record).not.toHaveBeenCalled();

    const recordFails = fakeLocationReports("accepted");
    recordFails.record.mockRejectedValue(new Error("insert failed"));
    const second = gpsContext({ locationReports: recordFails as never });
    second.performAuthoritativeTravel.mockResolvedValue({ success: true, player: {} as never });
    await expect(createTravelHandler(second)({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-record-down",
      lat: 40.015,
      lon: -105.27
    })).resolves.toBeUndefined();
    expect(second.performAuthoritativeTravel).toHaveBeenCalledOnce();
    expect(second.safeSendServerMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ success: false }),
      expect.anything(),
      expect.anything()
    );
  });
});

describe("passive location fix", () => {
  const passiveConfig = { TRUST_PASSIVE_FIX_ENABLED: true } as never;

  it("rate-limits periodic fixes to max(55 s, min - 5 s) per connection with no reply", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
      const locationReports = fakeLocationReports("accepted");
      const context = gpsContext({
        config: { TRUST_PASSIVE_FIX_ENABLED: true, TRUST_PASSIVE_FIX_MIN_SECONDS: 180 } as never,
        locationReports: locationReports as never
      });
      const handler = createTravelHandler(context);
      const fix = {
        type: "LOCATION_FIX",
        lat: 40.015,
        lon: -105.27,
        accuracy: 25,
        deviceTimeZone: "America/Denver",
        reason: "periodic"
      } as const;

      await handler(fix);
      await handler(fix);
      vi.setSystemTime(new Date("2026-10-01T12:02:54Z"));
      await handler(fix);
      expect(locationReports.evaluate).toHaveBeenCalledOnce();
      expect(locationReports.evaluate).toHaveBeenCalledWith(expect.objectContaining({
        source: "passive",
        lat: 40.015,
        lon: -105.27,
        accuracyM: 25,
        deviceTimeZone: "America/Denver",
        fixReason: "periodic"
      }));

      vi.setSystemTime(new Date("2026-10-01T12:02:55Z"));
      await handler(fix);
      expect(locationReports.record).toHaveBeenCalledTimes(2);

      // A reason-less (legacy) fix shares the periodic window.
      await handler({ type: "LOCATION_FIX", lat: 40, lon: -105 });
      expect(locationReports.record).toHaveBeenCalledTimes(2);

      // A second connection has its own window.
      await createTravelHandler(context)(fix);
      expect(locationReports.record).toHaveBeenCalledTimes(3);

      expect(context.safeSendServerMessage).not.toHaveBeenCalled();
      expect(context.performAuthoritativeTravel).not.toHaveBeenCalled();
      expect(context.playerService.relocationStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("floors the window at 55 s and applies it to legacy pre_action fixes too", async () => {
    expect(passivePeriodicFixMinIntervalMs(60)).toBe(55_000);
    expect(passivePeriodicFixMinIntervalMs(180)).toBe(175_000);
    expect(passivePeriodicFixMinIntervalMs(undefined)).toBe(175_000);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
      const locationReports = fakeLocationReports("accepted");
      const handler = createTravelHandler(gpsContext({
        config: { TRUST_PASSIVE_FIX_ENABLED: true, TRUST_PASSIVE_FIX_MIN_SECONDS: 60 } as never,
        locationReports: locationReports as never
      }));
      const preAction = { type: "LOCATION_FIX", lat: 40, lon: -105, reason: "pre_action" } as const;

      await handler({ type: "LOCATION_FIX", lat: 40, lon: -105, reason: "periodic" });
      // Legacy pre_action shares the window: no 15 s window of its own.
      await handler(preAction);
      vi.setSystemTime(new Date("2026-10-01T12:00:15Z"));
      await handler(preAction);
      expect(locationReports.record).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-10-01T12:00:54.999Z"));
      await handler(preAction);
      expect(locationReports.record).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date("2026-10-01T12:00:55Z"));
      await handler(preAction);
      expect(locationReports.record).toHaveBeenCalledTimes(2);
      expect(locationReports.evaluate).toHaveBeenLastCalledWith(expect.objectContaining({ fixReason: "pre_action" }));
      vi.setSystemTime(new Date("2026-10-01T12:01:49.999Z"));
      await handler({ type: "LOCATION_FIX", lat: 40, lon: -105, reason: "periodic" });
      expect(locationReports.record).toHaveBeenCalledTimes(2);
      vi.setSystemTime(new Date("2026-10-01T12:01:50Z"));
      await handler({ type: "LOCATION_FIX", lat: 40, lon: -105, reason: "periodic" });
      expect(locationReports.record).toHaveBeenCalledTimes(3);

      // An unknown reason is ignored (treated as periodic), never a failure.
      vi.setSystemTime(new Date("2026-10-01T12:05:00Z"));
      await handler({ type: "LOCATION_FIX", lat: 40, lon: -105, reason: "bogus" } as never);
      expect(locationReports.evaluate).toHaveBeenLastCalledWith(expect.not.objectContaining({
        fixReason: expect.anything()
      }));
      expect(locationReports.record).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a transit hold from a passive fix but never a relocation cooldown", async () => {
    const transitUntil = new Date("2026-10-01T13:00:00Z");
    for (const [holdReason, expected] of [
      ["transit", { holdUntil: transitUntil, holdReason: "transit" }],
      ["relocation_cooldown", { holdUntil: null, holdReason: null }]
    ] as const) {
      const locationReports = fakeLocationReports("accepted");
      locationReports.evaluate.mockResolvedValue({
        verdict: "accepted",
        reason: null,
        holdUntil: transitUntil,
        holdReason
      } as never);
      await createTravelHandler(gpsContext({
        config: { TRUST_PASSIVE_FIX_ENABLED: true } as never,
        locationReports: locationReports as never
      }))({ type: "LOCATION_FIX", lat: 40, lon: -105, reason: "pre_action" });
      expect(locationReports.record).toHaveBeenCalledWith(
        expect.objectContaining({ source: "passive" }),
        expect.objectContaining(expected),
        "accepted"
      );
    }
  });

  it("ignores malformed fixes, drops bad time zones, and is off unless enabled", async () => {
    const malformed = [
      { type: "LOCATION_FIX", lat: Number.NaN, lon: -105.27 },
      { type: "LOCATION_FIX", lat: "40", lon: -105.27 },
      { type: "LOCATION_FIX", lat: 91, lon: -105.27 },
      { type: "LOCATION_FIX", lat: 40, lon: -105.27, accuracy: -1 }
    ] as const;
    for (const message of malformed) {
      const locationReports = fakeLocationReports("accepted");
      const context = gpsContext({ config: passiveConfig, locationReports: locationReports as never });
      await expect(createTravelHandler(context)(message as never)).resolves.toBeUndefined();
      expect(locationReports.evaluate).not.toHaveBeenCalled();
      expect(context.safeSendServerMessage).not.toHaveBeenCalled();
    }

    const badZone = fakeLocationReports("accepted");
    await createTravelHandler(gpsContext({ config: passiveConfig, locationReports: badZone as never }))({
      type: "LOCATION_FIX",
      lat: 40,
      lon: -105,
      deviceTimeZone: "x".repeat(65)
    });
    expect(badZone.evaluate).toHaveBeenCalledWith(expect.not.objectContaining({ deviceTimeZone: expect.anything() }));

    const disabled = fakeLocationReports("accepted");
    await createTravelHandler(gpsContext({
      config: { TRUST_PASSIVE_FIX_ENABLED: false } as never,
      locationReports: disabled as never
    }))({ type: "LOCATION_FIX", lat: 40, lon: -105 });
    expect(disabled.evaluate).not.toHaveBeenCalled();
  });

  it("logs and swallows ledger failures", async () => {
    const locationReports = fakeLocationReports("accepted");
    locationReports.record.mockRejectedValue(new Error("insert failed"));
    const context = gpsContext({ config: passiveConfig, locationReports: locationReports as never });
    await expect(createTravelHandler(context)({ type: "LOCATION_FIX", lat: 40, lon: -105 }))
      .resolves.toBeUndefined();
    expect(context.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: "player-1" }),
      "Passive location fix could not be recorded"
    );
    expect(context.safeSendServerMessage).not.toHaveBeenCalled();
  });

  it("passes a valid relocation time zone to the trust ledger", async () => {
    const locationReports = fakeLocationReports("accepted");
    const context = gpsContext({ locationReports: locationReports as never });
    context.performAuthoritativeTravel.mockResolvedValue({ success: true, player: {} as never });
    await createTravelHandler(context)({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "gps-tz",
      lat: 40.015,
      lon: -105.27,
      deviceTimeZone: "America/Denver"
    });
    expect(locationReports.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      source: "relocation",
      deviceTimeZone: "America/Denver"
    }));
  });
});

function fakeLocationReports(verdict: "accepted" | "shadow_rejected" | "rejected") {
  return {
    evaluate: vi.fn(async () => ({
      verdict,
      reason: verdict === "accepted" ? null : "speed_impossible"
    })),
    record: vi.fn(async () => ({ reportId: "report-1", seq: 1 }))
  };
}

function gpsContext(overrides: Partial<TravelHandlerContext> = {}) {
  const player = {
    playerId: "player-1",
    online: true,
    position: { lat: 35, lon: -106 },
    anchor: { lat: 35, lon: -106 },
    lat: 35,
    lon: -106,
    moveLeashRadiusM: 900,
    regionCode: "NM",
    zoneId: "world:NM"
  };
  const playerService = {
    relocationStatus: vi.fn(async (): Promise<RelocationStatus> => ({
      lastRelocatedAt: null,
      relocationAvailableAt: null,
      travelInviteAvailableAt: null,
      serverTime: Date.now()
    }))
  };
  const performAuthoritativeTravel = vi.fn(async (): Promise<{
    success: boolean;
    player?: unknown;
    reason?: { code: string; message: string; retryAfterMs?: number };
  }> => ({
    success: false,
    reason: { code: "TRAVEL_FAILED", message: "Travel could not be completed." }
  }));
  const safeSendServerMessage = vi.fn();
  return {
    state: { playerId: player.playerId, connectionId: "connection-1" },
    socket: {},
    authenticatedSession: { account: { id: "account-1" } },
    logger: { warn: vi.fn(), info: vi.fn() },
    registry: {},
    gameState: {
      isMovementBlocked: vi.fn(() => false),
      isWorldPresent: vi.fn(() => true),
      getPlayer: vi.fn(() => player)
    },
    playerService,
    worldRuntime: {},
    performAuthoritativeTravel,
    safeSendServerMessage,
    ...overrides
  } as unknown as TravelHandlerContext & {
    playerService: typeof playerService;
    performAuthoritativeTravel: typeof performAuthoritativeTravel;
    safeSendServerMessage: typeof safeSendServerMessage;
  };
}

describe("City House travel authority", () => {
  it("resolves an active house by structure ID and relocates to its exact coordinates", async () => {
    const house = {
      structureId: "00000000-0000-4000-8000-000000000002",
      cityId: "00000000-0000-4000-8000-000000000001",
      type: "city_house",
      state: "active",
      lat: 35.085,
      lon: -106.65
    };
    const player = {
      playerId: "player-1",
      online: true,
      moveLeashRadiusM: 900,
      anchor: { lat: 35, lon: -106 },
      position: { lat: 35, lon: -106 },
      lat: 35,
      lon: -106,
      regionCode: "US-NM",
      zoneId: "world:US-NM"
    };
    const applyAuthoritativeRelocation = vi.fn(({ anchor }) => {
      player.anchor = anchor;
      player.position = anchor;
      player.lat = anchor.lat;
      player.lon = anchor.lon;
    });
    const getActiveHouse = vi.fn(async () => house);
    const sent: unknown[] = [];
    const performAuthoritativeTravel = vi.fn(async (input: {
      destination: { center: { lat: number; lon: number }; id: string | null };
      requestId: string;
    }) => {
      applyAuthoritativeRelocation({
        playerId: player.playerId,
        anchor: input.destination.center
      });
      sent.push({
        type: "CITY_VISITED",
        requestId: input.requestId,
        cityId: input.destination.id
      });
      return { success: true as const, player };
    });
    const context = {
      state: { playerId: player.playerId, connectionId: "connection-1" },
      socket: {},
      authenticatedSession: { account: { id: "account-1" } },
      config: { FLAG_RESOURCE_VISION_RADIUS_M: 1_000 },
      logger: { warn: vi.fn() },
      registry: {
        isActiveConnection: vi.fn(() => true),
        isActivePlayerConnection: vi.fn(() => true),
        updateSpatialMembership: vi.fn(),
        send: vi.fn()
      },
      gameState: {
        getPlayer: vi.fn(() => player),
        isMovementBlocked: vi.fn(() => false),
        isWorldPresent: vi.fn(() => true),
        capturePlayerViewTransition: vi.fn(() => ({ player })),
        restorePlayerViewTransition: vi.fn(),
        getAuthoritativeTravelAnchor: vi.fn(() => null),
        stopPlayer: vi.fn(),
        applyAuthoritativeRelocation,
        snapshotForPlayer: vi.fn(() => player),
        getResourceVisionRevision: vi.fn(() => 4)
      },
      flagService: {},
      playerService: { persistPlayerSnapshot: vi.fn(async () => undefined) },
      worldRuntime: {
        hasPlayerWorldTransition: vi.fn(() => false),
        hasPendingCommand: vi.fn(() => false),
        beginPlayerWorldTransition: vi.fn(() => Symbol("transition")),
        endPlayerWorldTransition: vi.fn(),
        replication: { resetPlayer: vi.fn() }
      },
      cities: {
        structures: { getActiveHouse },
        getCity: vi.fn(async () => ({
          id: house.cityId,
          lat: 35.0844,
          lon: -106.6504,
          jumpable: true
        }))
      },
      classRealtimeState: { hasActiveMutation: vi.fn(() => false) },
      flagBuilds: null,
      activeHarvestSessionForPlayer: vi.fn(async () => null),
      beginSmoothTravelTransition: vi.fn(() => Symbol("transition")),
      endSmoothTravelTransition: vi.fn(),
      followPartyLeader: vi.fn(async () => undefined),
      gameplayInterestCenter: vi.fn((_playerId, fallback) => fallback),
      gameplayInterestZoneIds: vi.fn(() => []),
      performAuthoritativeTravel,
      runMovementLifecycle: vi.fn(async (operation) => operation()),
      safeSendServerMessage: vi.fn((_socket, message) => {
        sent.push(message);
        return true;
      }),
      schedulePopulationV2RelocationForActivePlayer: vi.fn(() => null),
      sendCityScopeForPlayer: vi.fn(async () => undefined),
      sendCollectiblesForPlayer: vi.fn(async () => undefined),
      sendCombatError: vi.fn(),
      sendCombatScopeSnapshot: vi.fn(),
      sendDroppedItemsToSocket: vi.fn(async () => undefined),
      sendManorsForPlayer: vi.fn(async () => undefined),
      sendTravelInboxForPlayers: vi.fn(async () => undefined),
      syncCombatPlayerAfterRelocation: vi.fn(),
      waitForRelocationPopulationV2: vi.fn(async () => ({ ready: true }))
    } as unknown as TravelHandlerContext;
    const handler = createTravelHandler(context);

    await handler({
      type: "VISIT_CITY_HOUSE",
      requestId: "visit-house-1",
      structureId: house.structureId
    });

    expect(getActiveHouse).toHaveBeenCalledWith(house.structureId);
    expect(performAuthoritativeTravel).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: player.playerId,
        requestId: "visit-house-1",
        arrivalMode: "protected_jump",
        kind: "city",
        chargeTravelHunger: false,
        populationSourceKind: "city-travel",
        destination: expect.objectContaining({
          kind: "city",
          id: house.cityId,
          center: { lat: house.lat, lon: house.lon }
        })
      })
    );
    expect(applyAuthoritativeRelocation).toHaveBeenCalledWith(expect.objectContaining({
      playerId: player.playerId,
      anchor: { lat: house.lat, lon: house.lon }
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      type: "CITY_VISITED",
      requestId: "visit-house-1",
      cityId: house.cityId
    }));
  });
});

describe("City Market and Warehouse travel authority", () => {
  it.each([
    ["market", "VISIT_CITY_MARKET"],
    ["warehouse", "VISIT_CITY_WAREHOUSE"]
  ] as const)("resolves an active %s outside its footprint", async (type, messageType) => {
    const structure = {
      structureId: `00000000-0000-4000-8000-00000000000${type === "market" ? "3" : "4"}`,
      cityId: "00000000-0000-4000-8000-000000000001",
      type,
      state: "active" as const,
      placementRevision: "7",
      lat: 35.085,
      lon: -106.65,
      footprintRadiusM: type === "market" ? 20 : 18
    };
    const sent: unknown[] = [];
    const getActiveJumpableStructure = vi.fn(
      async (): Promise<typeof structure | null> => structure
    );
    const performAuthoritativeTravel = vi.fn(async (input: {
      destination: { center: { lat: number; lon: number }; id: string | null };
      requestId: string;
      validatePreCommit?: () => Promise<unknown>;
    }) => {
      sent.push({
        type: "CITY_VISITED",
        requestId: input.requestId,
        cityId: input.destination.id
      });
      return { success: true as const, player: {} as never };
    });
    const context = structureTravelContext(
      structure,
      getActiveJumpableStructure,
      performAuthoritativeTravel,
      sent
    );
    const handler = createTravelHandler(context);

    await handler({
      type: messageType,
      requestId: `visit-${type}`,
      structureId: structure.structureId,
      expectedPlacementRevision: structure.placementRevision
    });

    expect(getActiveJumpableStructure).toHaveBeenCalledWith(
      structure.structureId,
      structure.placementRevision,
      type
    );
    expect(performAuthoritativeTravel).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: `visit-${type}`,
        arrivalMode: "protected_jump",
        kind: "city",
        chargeTravelHunger: false,
        populationSourceKind: "city-travel",
        requireDestinationReady: true,
        destination: expect.objectContaining({
          kind: "city",
          id: structure.cityId
        }),
        validatePreCommit: expect.any(Function)
      })
    );
    const travelInput = performAuthoritativeTravel.mock.calls[0]![0];
    expect(travelInput.destination.center).not.toEqual({
      lat: structure.lat,
      lon: structure.lon
    });
    expect(context.beginSmoothTravelTransition).not.toHaveBeenCalled();
    expect(sent).toContainEqual({
      type: "CITY_VISITED",
      requestId: `visit-${type}`,
      cityId: structure.cityId
    });

    const preCommit = travelInput.validatePreCommit;
    expect(preCommit).toBeDefined();
    await expect(preCommit!()).resolves.toBeNull();
    getActiveJumpableStructure.mockResolvedValueOnce(null);
    await expect(preCommit!()).resolves.toMatchObject({
      code: "CITY_STRUCTURE_STALE"
    });
  });

  it.each([
    ["market", "VISIT_CITY_MARKET", "CITY_MARKET_NOT_ACTIVE"],
    ["warehouse", "VISIT_CITY_WAREHOUSE", "CITY_WAREHOUSE_NOT_ACTIVE"]
  ] as const)("returns %s inactive with the request ID", async (type, messageType, code) => {
    const structure = {
      structureId: "00000000-0000-4000-8000-000000000005",
      cityId: "00000000-0000-4000-8000-000000000001",
      type,
      state: "active" as const,
      placementRevision: "7",
      lat: 35.085,
      lon: -106.65,
      footprintRadiusM: 20
    };
    const sent: unknown[] = [];
    const getActiveJumpableStructure = vi.fn(
      async (): Promise<typeof structure | null> => null
    );
    const performAuthoritativeTravel = vi.fn(async () => ({
      success: true as const,
      player: {} as never
    }));
    const context = structureTravelContext(
      structure,
      getActiveJumpableStructure,
      performAuthoritativeTravel,
      sent
    );
    const handler = createTravelHandler(context);

    await handler({
      type: messageType,
      requestId: `inactive-${type}`,
      structureId: structure.structureId,
      expectedPlacementRevision: structure.placementRevision
    });

    expect(sent).toContainEqual(expect.objectContaining({
      type: "ERROR",
      requestId: `inactive-${type}`,
      code
    }));
    expect(performAuthoritativeTravel).not.toHaveBeenCalled();
  });
});

describe("Visible flag travel authority", () => {
  it("does not send the new preparation frame to an older client", async () => {
    const harness = visibleFlagTravelContext();
    vi.mocked(harness.context.registry.connectionSupports).mockReturnValue(false);
    const handler = createTravelHandler(harness.context);

    await handler({
      type: "PREPARE_VISIBLE_FLAG_VISIT",
      requestId: "legacy-client-preparation",
      flagId: harness.flag.id,
      expectedConnectionGeneration: 1,
      expectedGameplayViewGeneration: 4,
      expectedResourceVisionRevision: 7,
      expectedFlagSetRevision: 1
    });

    expect(harness.prepareVisibleFlagVisitPopulation).toHaveBeenCalledOnce();
    expect(harness.sent).not.toContainEqual(expect.objectContaining({
      type: "VISIBLE_FLAG_VISIT_PREPARED"
    }));
    expect(harness.sendCombatError).not.toHaveBeenCalled();
  });

  it("uses the exact prepared arrival slot for the committed relocation", async () => {
    const harness = visibleFlagTravelContext();
    const handler = createTravelHandler(harness.context);
    const authority = {
      expectedConnectionGeneration: 1,
      expectedGameplayViewGeneration: 4,
      expectedResourceVisionRevision: 7,
      expectedFlagSetRevision: 1
    };

    await handler({
      type: "PREPARE_VISIBLE_FLAG_VISIT",
      requestId: "prepared-arrival",
      flagId: harness.flag.id,
      ...authority
    });
    await handler({
      type: "COMMIT_VISIBLE_FLAG_VISIT",
      requestId: "commit-prepared-arrival",
      preparationId: "prepared-arrival",
      flagId: harness.flag.id,
      ...authority
    });

    expect(harness.sent).toContainEqual({
      type: "VISIBLE_FLAG_VISIT_PREPARED",
      requestId: "prepared-arrival",
      flagId: harness.flag.id,
      playerSpawnPosition: harness.preparedSpawnPosition,
      expiresInMs: 15_000
    });
    expect(harness.performAuthoritativeTravel).toHaveBeenCalledWith(
      expect.objectContaining({
        playerSpawnPosition: harness.preparedSpawnPosition
      })
    );
    expect(harness.releaseArrivalReservation).toHaveBeenCalledOnce();
  });

  it("accepts a selection when only population view generation advanced", async () => {
    const harness = visibleFlagTravelContext();
    const handler = createTravelHandler(harness.context);

    await handler({
      type: "PREPARE_VISIBLE_FLAG_VISIT",
      requestId: "population-generation-advanced",
      flagId: harness.flag.id,
      expectedConnectionGeneration: 1,
      expectedGameplayViewGeneration: 3,
      expectedResourceVisionRevision: 7,
      expectedFlagSetRevision: 1
    });

    expect(harness.prepareVisibleFlagVisitPopulation).toHaveBeenCalledOnce();
    expect(harness.sendCombatError).not.toHaveBeenCalled();
  });

  it("returns current authority for a retryable stale resource view", async () => {
    const harness = visibleFlagTravelContext();
    harness.setResourceVisionRevision(8);
    const handler = createTravelHandler(harness.context);

    await handler({
      type: "PREPARE_VISIBLE_FLAG_VISIT",
      requestId: "stale-resource-view",
      flagId: harness.flag.id,
      expectedConnectionGeneration: 1,
      expectedGameplayViewGeneration: 4,
      expectedResourceVisionRevision: 7,
      expectedFlagSetRevision: 1
    });

    expect(harness.prepareVisibleFlagVisitPopulation).not.toHaveBeenCalled();
    expect(harness.sendCombatError).toHaveBeenCalledWith(
      expect.anything(),
      "stale-resource-view",
      "VISIBLE_FLAG_RESOURCE_VISION_STALE",
      "The map updated before travel completed.",
      {
        retryable: true,
        relocationRevision: 0,
        resourceVisionRevision: 8,
        gameplayViewGeneration: 4
      }
    );
  });

  it("ignores unrelated global revision advances after exact destination acceptance", async () => {
    const harness = visibleFlagTravelContext();
    const handler = createTravelHandler(harness.context);
    const authority = {
      expectedConnectionGeneration: 1,
      expectedGameplayViewGeneration: 4,
      expectedResourceVisionRevision: 7,
      expectedFlagSetRevision: 1
    };

    await handler({
      type: "PREPARE_VISIBLE_FLAG_VISIT",
      requestId: "prepare-visible-flag",
      flagId: harness.flag.id,
      ...authority
    });
    harness.setFlagSetRevision(3);
    await handler({
      type: "COMMIT_VISIBLE_FLAG_VISIT",
      requestId: "commit-visible-flag",
      preparationId: "prepare-visible-flag",
      flagId: harness.flag.id,
      ...authority
    });

    expect(harness.prepareVisibleFlagVisitPopulation).toHaveBeenCalledOnce();
    expect(harness.performAuthoritativeTravel).toHaveBeenCalledOnce();
    expect(harness.sendCombatError).not.toHaveBeenCalled();
  });

  it("rejects selected destination geometry changes after preparation", async () => {
    const harness = visibleFlagTravelContext();
    const handler = createTravelHandler(harness.context);
    const authority = {
      expectedConnectionGeneration: 1,
      expectedGameplayViewGeneration: 4,
      expectedResourceVisionRevision: 7,
      expectedFlagSetRevision: 1
    };

    await handler({
      type: "PREPARE_VISIBLE_FLAG_VISIT",
      requestId: "prepare-before-move",
      flagId: harness.flag.id,
      ...authority
    });
    harness.setFlag({ ...harness.flag, lat: harness.flag.lat + 0.01 });
    harness.setFlagSetRevision(2);
    await handler({
      type: "COMMIT_VISIBLE_FLAG_VISIT",
      requestId: "commit-after-move",
      preparationId: "prepare-before-move",
      flagId: harness.flag.id,
      ...authority
    });

    expect(harness.performAuthoritativeTravel).not.toHaveBeenCalled();
    expect(harness.sendCombatError).toHaveBeenCalledWith(
      expect.anything(),
      "commit-after-move",
      "VISIBLE_FLAG_DESTINATION_STALE",
      "That flag changed while destination preparation was pending.",
      {}
    );
  });

  it("rejects access lost after destination preparation", async () => {
    const harness = visibleFlagTravelContext();
    const handler = createTravelHandler(harness.context);
    const authority = {
      expectedConnectionGeneration: 1,
      expectedGameplayViewGeneration: 4,
      expectedResourceVisionRevision: 7,
      expectedFlagSetRevision: 1
    };

    await handler({
      type: "PREPARE_VISIBLE_FLAG_VISIT",
      requestId: "prepare-before-access-loss",
      flagId: harness.flag.id,
      ...authority
    });
    harness.setAccessAllowed(false);
    harness.setFlagSetRevision(2);
    await handler({
      type: "COMMIT_VISIBLE_FLAG_VISIT",
      requestId: "commit-after-access-loss",
      preparationId: "prepare-before-access-loss",
      flagId: harness.flag.id,
      ...authority
    });

    expect(harness.performAuthoritativeTravel).not.toHaveBeenCalled();
    expect(harness.sendCombatError).toHaveBeenCalledWith(
      expect.anything(),
      "commit-after-access-loss",
      "PRIVATE_OWNER_ONLY",
      "You do not currently have access to that flag.",
      {}
    );
  });

  it("accepts an unchanged selected flag when only the global flag revision advanced", async () => {
    const harness = visibleFlagTravelContext();
    harness.setFlagSetRevision(2);
    const handler = createTravelHandler(harness.context);

    await handler({
      type: "PREPARE_VISIBLE_FLAG_VISIT",
      requestId: "stale-initial-selection",
      flagId: harness.flag.id,
      expectedConnectionGeneration: 1,
      expectedGameplayViewGeneration: 4,
      expectedResourceVisionRevision: 7,
      expectedFlagSetRevision: 1,
      expectedDestination: {
        lat: harness.flag.lat,
        lon: harness.flag.lon,
        claimRadiusM: harness.flag.claimRadiusM,
        resourceVisionRadiusM: harness.flag.resourceVisionRadiusM,
        personalFlagId: harness.flag.id
      }
    });

    expect(harness.prepareVisibleFlagVisitPopulation).toHaveBeenCalledOnce();
    expect(harness.sendCombatError).not.toHaveBeenCalled();
  });

  it("rejects a selected flag whose destination authority changed", async () => {
    const harness = visibleFlagTravelContext();
    harness.setFlagSetRevision(2);
    const handler = createTravelHandler(harness.context);

    await handler({
      type: "PREPARE_VISIBLE_FLAG_VISIT",
      requestId: "changed-initial-selection",
      flagId: harness.flag.id,
      expectedConnectionGeneration: 1,
      expectedGameplayViewGeneration: 4,
      expectedResourceVisionRevision: 7,
      expectedFlagSetRevision: 1,
      expectedDestination: {
        lat: harness.flag.lat + 0.01,
        lon: harness.flag.lon,
        claimRadiusM: harness.flag.claimRadiusM,
        resourceVisionRadiusM: harness.flag.resourceVisionRadiusM,
        personalFlagId: harness.flag.id
      }
    });

    expect(harness.prepareVisibleFlagVisitPopulation).not.toHaveBeenCalled();
    expect(harness.sendCombatError).toHaveBeenCalledWith(
      expect.anything(),
      "changed-initial-selection",
      "VISIBLE_FLAG_DESTINATION_STALE",
      "That flag changed after it was selected. Select it again.",
      {}
    );
  });

  it("keeps the global revision check for legacy selections", async () => {
    const harness = visibleFlagTravelContext();
    harness.setFlagSetRevision(2);
    const handler = createTravelHandler(harness.context);

    await handler({
      type: "PREPARE_VISIBLE_FLAG_VISIT",
      requestId: "legacy-stale-selection",
      flagId: harness.flag.id,
      expectedConnectionGeneration: 1,
      expectedGameplayViewGeneration: 4,
      expectedResourceVisionRevision: 7,
      expectedFlagSetRevision: 1
    });

    expect(harness.prepareVisibleFlagVisitPopulation).not.toHaveBeenCalled();
    expect(harness.sendCombatError).toHaveBeenCalledWith(
      expect.anything(),
      "legacy-stale-selection",
      "VISIBLE_FLAG_SET_STALE",
      "The visible flag set changed. Select the flag again.",
      {}
    );
  });
});

function structureTravelContext(
  structure: {
    structureId: string;
    cityId: string;
    type: "market" | "warehouse";
    state: "active";
    placementRevision: string;
    lat: number;
    lon: number;
    footprintRadiusM: number;
  },
  getActiveJumpableStructure: ReturnType<typeof vi.fn>,
  performAuthoritativeTravel: ReturnType<typeof vi.fn>,
  sent: unknown[]
): TravelHandlerContext {
  const player = {
    playerId: "player-1",
    online: true,
    moveLeashRadiusM: 900,
    anchor: { lat: 35, lon: -106 },
    position: { lat: 35, lon: -106 },
    lat: 35,
    lon: -106,
    regionCode: "US-NM",
    zoneId: "world:US-NM"
  };
  return {
    state: { playerId: player.playerId, connectionId: "connection-1" },
    socket: {},
    authenticatedSession: { account: { id: "account-1" } },
    config: { FLAG_RESOURCE_VISION_RADIUS_M: 1_000 },
    logger: { warn: vi.fn() },
    registry: {
      isActiveConnection: vi.fn(() => true),
      isActivePlayerConnection: vi.fn(() => true),
      connectionSupports: vi.fn(() => true),
      updateSpatialMembership: vi.fn(),
      send: vi.fn()
    },
    gameState: {
      getPlayer: vi.fn(() => player),
      isMovementBlocked: vi.fn(() => false),
      isWorldPresent: vi.fn(() => true),
      getAuthoritativeTravelAnchor: vi.fn(() => null),
      getResourceVisionRevision: vi.fn(() => 4)
    },
    flagService: {},
    playerService: { persistPlayerSnapshot: vi.fn(async () => undefined) },
    worldRuntime: {
      hasPlayerWorldTransition: vi.fn(() => false),
      hasPendingCommand: vi.fn(() => false),
      beginPlayerWorldTransition: vi.fn(() => Symbol("transition")),
      endPlayerWorldTransition: vi.fn(),
      replication: { resetPlayer: vi.fn() }
    },
    cities: {
      structures: { getActiveJumpableStructure },
      getCity: vi.fn(async () => ({
        id: structure.cityId,
        lat: 35.0844,
        lon: -106.6504,
        jumpable: true
      }))
    },
    classRealtimeState: { hasActiveMutation: vi.fn(() => false) },
    flagBuilds: null,
    activeHarvestSessionForPlayer: vi.fn(async () => null),
    beginSmoothTravelTransition: vi.fn(() => Symbol("transition")),
    endSmoothTravelTransition: vi.fn(),
    followPartyLeader: vi.fn(async () => undefined),
    gameplayInterestCenter: vi.fn((_playerId, fallback) => fallback),
    gameplayInterestZoneIds: vi.fn(() => []),
    performAuthoritativeTravel,
    safeSendServerMessage: vi.fn((_socket, message) => {
      sent.push(message);
      return true;
    }),
    schedulePopulationV2RelocationForActivePlayer: vi.fn(() => null),
    sendCityScopeForPlayer: vi.fn(async () => undefined),
    sendCollectiblesForPlayer: vi.fn(async () => undefined),
    sendCombatError: vi.fn(),
    sendCombatScopeSnapshot: vi.fn(),
    sendDroppedItemsToSocket: vi.fn(async () => undefined),
    sendManorsForPlayer: vi.fn(async () => undefined),
    sendTravelInboxForPlayers: vi.fn(async () => undefined),
    syncCombatPlayerAfterRelocation: vi.fn(),
    waitForRelocationPopulationV2: vi.fn(async () => ({ ready: true }))
  } as unknown as TravelHandlerContext;
}

function visibleFlagTravelContext() {
  const originalFlag = {
    id: "00000000-0000-4000-8000-000000000010",
    controlType: "personal" as const,
    name: "North Shrine",
    lat: 39.7392,
    lon: -104.9903,
    claimRadiusM: 700,
    resourceVisionRadiusM: 1_000,
    jumpTollGold: "0"
  };
  let currentFlag = originalFlag;
  let flagSetRevision = 1;
  let resourceVisionRevision = 7;
  let accessAllowed = true;
  const sendCombatError = vi.fn();
  const sent: unknown[] = [];
  const preparedSpawnPosition = { lat: 39.7397, lon: -104.9903 };
  const releaseArrivalReservation = vi.fn();
  const reserveTravelArrivals = vi.fn(() => ({
    positions: new Map([["player-1", preparedSpawnPosition]]),
    release: releaseArrivalReservation
  }));
  const prepareVisibleFlagVisitPopulation = vi.fn(() => "admitted" as const);
  const performAuthoritativeTravel = vi.fn(async (input: {
    validatePreCommit?: () => Promise<unknown>;
  }) => {
    const reason = await input.validatePreCommit?.();
    return reason
      ? { success: false as const, reason }
      : { success: true as const, player: {} as never };
  });
  const flagDestination = () => ({
    kind: "flag" as const,
    id: currentFlag.id,
    center: { lat: currentFlag.lat, lon: currentFlag.lon },
    flagName: currentFlag.name,
    flagCenter: { lat: currentFlag.lat, lon: currentFlag.lon },
    claimRadiusM: currentFlag.claimRadiusM,
    resourceVisionRadiusM: currentFlag.resourceVisionRadiusM,
    personalFlagId: currentFlag.id,
    jumpTollGold: currentFlag.jumpTollGold
  });
  const base = structureTravelContext(
    {
      structureId: "unused",
      cityId: "unused",
      type: "market",
      state: "active",
      placementRevision: "1",
      lat: 0,
      lon: 0,
      footprintRadiusM: 1
    },
    vi.fn(),
    performAuthoritativeTravel,
    []
  );
  const context = {
    ...base,
    state: {
      ...base.state,
      connectionGeneration: 1
    },
    config: {
      FLAG_RESOURCE_VISION_RADIUS_M: 1_000,
      FLAG_VISIBLE_VISIT_PREPARATION_TTL_MS: 15_000
    },
    gameState: {
      ...base.gameState,
      getGameplayViewCircle: vi.fn(() => ({ generation: 4 })),
      getResourceVisionRevision: vi.fn(() => resourceVisionRevision)
    },
    flagService: {
      getFlag: vi.fn(async () => currentFlag),
      currentFlagSetRevision: vi.fn(async () => flagSetRevision)
    },
    flagAccess: {
      authorize: vi.fn(async () => ({
        decision: {
          allowed: accessAllowed,
          reasonCode: accessAllowed
            ? "ALLOWED_PUBLIC"
            : "PRIVATE_OWNER_ONLY",
          tollGold: "0"
        }
      }))
    },
    cities: undefined,
    performAuthoritativeTravel,
    resolveFlagTravelDestination: vi.fn(async () => flagDestination()),
    reserveTravelArrivals,
    prepareVisibleFlagVisitPopulation,
    cancelVisibleFlagVisitPopulation: vi.fn(() => true),
    prepareWorldMapTravelPopulation: vi.fn(() => "skipped" as const),
    cancelWorldMapTravelPopulation: vi.fn(() => true),
    safeSendServerMessage: vi.fn((_socket, message) => {
      sent.push(message);
      return true;
    }),
    sendCombatError
  } as unknown as TravelHandlerContext;
  return {
    context,
    flag: originalFlag,
    prepareVisibleFlagVisitPopulation,
    performAuthoritativeTravel,
    sent,
    preparedSpawnPosition,
    releaseArrivalReservation,
    sendCombatError,
    setFlag(flag: typeof originalFlag) {
      currentFlag = flag;
    },
    setFlagSetRevision(revision: number) {
      flagSetRevision = revision;
    },
    setResourceVisionRevision(revision: number) {
      resourceVisionRevision = revision;
    },
    setAccessAllowed(allowed: boolean) {
      accessAllowed = allowed;
    }
  };
}
