import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { LEGENDARY_BIRD_INBOX_EVENT_KIND } from "@ash-atlas/shared";
import type { CombatDefeatSettlementCandidate } from "./combat/combatEngine.js";
import {
  LEGENDARY_EVENT_CYCLE_MS,
  LEGENDARY_EVENT_QUOTAS,
  LEGENDARY_FLAG_MAX_HEALTH,
  LEGENDARY_FLAG_SELECTED_HEALTH,
  LegendaryBirdEventService,
  alertMessage,
  selectDailyLegendaryAssignments
} from "./legendaryBirdEvents.js";

describe("legendary bird daily rules", () => {
  it("requires explicit ownership when production supplies the shared manager", () => {
    const service = new LegendaryBirdEventService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      Math.random,
      () => new Date(),
      {} as never
    );
    expect(service.ownsDefeatCandidate({
      settlementKey: "legendary-explicit-owner",
      defeatedEntityId: "legendary-fire",
      defeatGeneration: 1,
      eligibleParticipantIds: [],
      contributions: [],
      serverTick: 1,
      mobArchetype: "fire_bird"
    })).toBe(false);
  });

  it("rejects missing physical-loot authority before opening a transaction", async () => {
    const connect = vi.fn();
    const service = new LegendaryBirdEventService(
      { connect } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const candidate: CombatDefeatSettlementCandidate = {
      settlementKey: "legendary-authority-test",
      defeatedEntityId: "legendary-authority-entity",
      defeatGeneration: 1,
      eligibleParticipantIds: ["eligible-player"],
      contributions: [{ entityId: "ineligible-player", damage: 100 }],
      serverTick: 1,
      mobArchetype: "fire_bird",
      bossOwnership: {
        bossId: "legendary_fire",
        bossRevision: 1,
        encounterHandlerId: "legendary-bird",
        hostKind: "overworld",
        hostInstanceId: "legendary-event",
        encounterInstanceId: "legendary-event",
        lifeGeneration: 1
      },
      lootLocation: {
        regionCode: "test",
        zoneId: "test-zone",
        position: { lat: 0, lon: 0 }
      }
    };

    await expect(service.acceptDefeat(candidate)).rejects.toThrow(
      "Legendary bird defeat has no physical loot authority"
    );
    const missingLoot: CombatDefeatSettlementCandidate = {
      ...candidate,
      contributions: [{ entityId: "eligible-player", damage: 100 }]
    };
    delete missingLoot.lootLocation;
    await expect(service.acceptDefeat(missingLoot)).rejects.toThrow(
      "Legendary bird defeat has no physical loot authority"
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("releases the scheduler latch when acquiring a database client fails", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const service = new LegendaryBirdEventService(
      { connect } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(service.rotateCycle()).rejects.toThrow("database unavailable");
    await expect(service.rotateCycle()).rejects.toThrow("database unavailable");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("selects distinct flags with the exact one/one/three daily quota", () => {
    const assignments = selectDailyLegendaryAssignments(
      ["a", "b", "c", "d", "e", "f"],
      () => 0.5
    );
    expect(assignments).toHaveLength(5);
    expect(new Set(assignments.map(({ flag }) => flag)).size).toBe(5);
    expect(assignments.filter(({ bird }) => bird === "fire")).toHaveLength(LEGENDARY_EVENT_QUOTAS.fire);
    expect(assignments.filter(({ bird }) => bird === "lightning")).toHaveLength(LEGENDARY_EVENT_QUOTAS.lightning);
    expect(assignments.filter(({ bird }) => bird === "ice")).toHaveLength(LEGENDARY_EVENT_QUOTAS.ice);
  });

  it("uses a partial shortfall without duplicating an eligible flag", () => {
    const assignments = selectDailyLegendaryAssignments(["only", "second"], () => 0);
    expect(assignments).toHaveLength(2);
    expect(new Set(assignments.map(({ flag }) => flag)).size).toBe(2);
  });

  it("omits cooling species without substituting another species quota", () => {
    const assignments = selectDailyLegendaryAssignments(
      ["a", "b", "c", "d", "e"],
      () => 0,
      ["ice"]
    );
    expect(assignments).toHaveLength(LEGENDARY_EVENT_QUOTAS.ice);
    expect(assignments.every(({ bird }) => bird === "ice")).toBe(true);
  });

  it("locks the 24-hour hard expiry and selected flag health contract", () => {
    expect(LEGENDARY_EVENT_CYCLE_MS).toBe(86_400_000);
    expect(LEGENDARY_FLAG_MAX_HEALTH).toBe(200);
    expect(LEGENDARY_FLAG_SELECTED_HEALTH).toBe(100);
  });

  it("admits stone and tower flags while excluding Atlas Shrines in every selection path", () => {
    const source = readFileSync(new URL("./legendaryBirdEvents.ts", import.meta.url), "utf8");
    expect(source.match(/reinforcement_level IN \(1,3\)/g)).toHaveLength(3);
    expect(source).not.toMatch(/reinforcement_level\s*=\s*1/);
  });

  it.each([
    ["fire", "A Phoenix"],
    ["lightning", "A Thunderbird"],
    ["ice", "An Ice Phoenix"]
  ] as const)("names the %s bird and gives the exact flag location", (species, name) => {
    expect(alertMessage(species, {
      flag_id: "flag-1", owner_player_id: "player-1", lat: 0.001, lon: 0,
      region_code: null, city_name: "Test City", city_lat: 0, city_lon: 0
    }, true)).toBe(`${name} is attacking your flag! The flag is around 111 meters north of Test City!`);
  });

  it("does not invent a nearby city and preserves the species on reconnect", () => {
    const flag = { flag_id: "flag-1", owner_player_id: "player-1", lat: 0, lon: 0, region_code: null, city_name: null, city_lat: null, city_lon: null };
    expect(alertMessage("fire", flag, true)).toBe("A Phoenix is attacking your flag!");
    expect(alertMessage("ice", flag, true)).toBe("An Ice Phoenix is attacking your flag!");
    expect(alertMessage("lightning", flag, false)).toBe("Your flag is no longer burning. The Thunderbird encounter remains available until the current legendary event cycle ends.");
  });

  it("suppresses only the reconnect alert with an exact durable notice receipt", async () => {
    const now = new Date("2099-01-01T12:00:00.000Z");
    const selectedAt = "2099-01-01T00:00:00.000Z";
    const dismissedEvent = alertRow({
      event_id: "event-dismissed",
      selected_at: selectedAt,
      read_revision: selectedAt
    });
    const newEvent = alertRow({
      event_id: "event-new",
      selected_at: "2099-01-01T01:00:00.000Z",
      read_revision: null
    });
    const query = vi.fn().mockResolvedValue({ rows: [dismissedEvent, newEvent] });
    const send = vi.fn();
    const service = new LegendaryBirdEventService(
      { query } as never,
      {} as never,
      {} as never,
      {} as never,
      { send } as never,
      {} as never,
      Math.random,
      () => now
    );

    await service.sendCurrentAlerts("player-1");

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("LEFT JOIN player_inbox_read_receipts"),
      ["player-1", now, LEGENDARY_BIRD_INBOX_EVENT_KIND]
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("player-1", expect.objectContaining({
      eventId: "event-new",
      selectedAt: "2099-01-01T01:00:00.000Z"
    }));
  });
});

function alertRow(overrides: Record<string, unknown>) {
  return {
    event_id: "event-1",
    bird_species: "fire",
    flag_id: "flag-1",
    owner_player_id: "player-1",
    status: "pending",
    selected_at: "2099-01-01T00:00:00.000Z",
    expires_at: "2099-01-02T00:00:00.000Z",
    combat_entity_id: "entity-1",
    defeat_settlement_key: null,
    lat: 0,
    lon: 0,
    region_code: null,
    event_source: "daily",
    burning_reason: "legendary_event",
    burning_until: "2099-01-02T00:00:00.000Z",
    read_revision: null,
    city_name: null,
    city_lat: null,
    city_lon: null,
    ...overrides
  };
}
