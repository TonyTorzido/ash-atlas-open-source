import { GPS_RELOCATION_COOLDOWN_MS, HUNGER_BASE_CAPACITY, type PlayerSnapshot } from "@ash-atlas/shared";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { loadConfig, type AppConfig } from "../config.js";
import { PlayerRelocationCooldownError, PlayerService } from "../game/players.js";
import { GameState } from "../game/state.js";

const createdAt = new Date("2026-07-08T09:00:00.000Z");

describe("PlayerService", () => {
  it("does not create a player when the requested player does not exist", async () => {
    const rows = new Map<string, PlayerRowStub>();
    const service = new PlayerService(createPoolStub(rows), createConfig());

    const player = await service.loadPlayer("player-1");

    expect(player).toBeNull();
    expect(rows.size).toBe(0);
  });

  it("reconnect loads the existing identity and location without rewriting it", async () => {
    const rows = new Map<string, PlayerRowStub>([
      [
        "player-1",
        createRow({
          id: "player-1",
          username: "Old Name",
          lat: 35.1,
          lon: -106.7,
          anchor_lat: 35.09,
          anchor_lon: -106.69
        })
      ]
    ]);
    const service = new PlayerService(createPoolStub(rows), createConfig());

    const player = await service.loadPlayer("player-1");

    expect(player).toMatchObject({
      playerId: "player-1",
      username: "Old Name",
      position: {
        lat: 35.1,
        lon: -106.7
      },
      anchor: {
        lat: 35.09,
        lon: -106.69
      },
      moveLeashRadiusM: 900,
      online: true
    });
    expect(rows.get("player-1")?.username).toBe("Old Name");
  });

  it("persists player position snapshots without storing movement targets", async () => {
    const rows = new Map<string, PlayerRowStub>([["player-1", createRow({ id: "player-1" })]]);
    const service = new PlayerService(createPoolStub(rows), createConfig());

    await service.persistPlayerSnapshot(
      createSnapshot({
        lat: 35.2,
        lon: -106.8,
        anchorLat: 35.2,
        anchorLon: -106.8
      })
    );

    expect(rows.get("player-1")).toMatchObject({
      lat: 35.2,
      lon: -106.8,
      anchor_lat: 35.2,
      anchor_lon: -106.8,
      move_leash_radius_m: 900,
      online: true
    });
  });

  it("derives the relocate and outgoing-invite cooldowns from durable state", async () => {
    const lastRelocatedAt = new Date("2026-07-13T11:30:00.000Z");
    const rows = new Map<string, PlayerRowStub>([
      ["player-1", createRow({ id: "player-1", last_relocated_at: lastRelocatedAt })]
    ]);
    const service = new PlayerService(createPoolStub(rows), createConfig());

    await expect(service.relocationStatus("player-1", Date.parse("2026-07-13T12:00:00.000Z")))
      .resolves.toEqual({
        lastRelocatedAt,
        relocationAvailableAt: Date.parse("2026-07-20T11:30:00.000Z"),
        travelInviteAvailableAt: Date.parse("2026-07-13T12:30:00.000Z"),
        serverTime: Date.parse("2026-07-13T12:00:00.000Z")
      });
  });

  it("keeps the relocation status and the durable guard on the same 7-day cooldown", async () => {
    const lastRelocatedAt = new Date("2026-07-13T12:00:00.000Z");
    const rows = new Map<string, PlayerRowStub>([
      ["player-1", createRow({ id: "player-1", last_relocated_at: lastRelocatedAt })]
    ]);
    const service = new PlayerService(createPoolStub(rows), createConfig());
    const justBefore = new Date(lastRelocatedAt.getTime() + GPS_RELOCATION_COOLDOWN_MS - 1);
    const atCooldown = new Date(lastRelocatedAt.getTime() + GPS_RELOCATION_COOLDOWN_MS);
    expect(GPS_RELOCATION_COOLDOWN_MS).toBe(7 * 24 * 60 * 60_000);

    const early = await service.relocationStatus("player-1", justBefore.getTime());
    expect(early.relocationAvailableAt! > early.serverTime).toBe(true);
    await expect(service.persistPlayerSnapshot(
      createSnapshot({ lat: 39.7, lon: -104.9, anchorLat: 39.7, anchorLon: -104.9 }),
      undefined,
      { lastRelocatedAt: justBefore, requireRelocationCooldownAvailable: true }
    )).rejects.toBeInstanceOf(PlayerRelocationCooldownError);

    const due = await service.relocationStatus("player-1", atCooldown.getTime());
    expect(due.relocationAvailableAt).toBe(due.serverTime);
    await service.persistPlayerSnapshot(
      createSnapshot({ lat: 39.7, lon: -104.9, anchorLat: 39.7, anchorLon: -104.9 }),
      undefined,
      { lastRelocatedAt: atCooldown, requireRelocationCooldownAvailable: true }
    );
    expect(rows.get("player-1")?.last_relocated_at).toEqual(atCooldown);
  });

  it("persists a relocation timestamp only with the canonical position snapshot", async () => {
    const rows = new Map<string, PlayerRowStub>([["player-1", createRow({ id: "player-1" })]]);
    const service = new PlayerService(createPoolStub(rows), createConfig());
    const relocatedAt = new Date("2026-07-13T12:00:00.000Z");

    await service.persistPlayerSnapshot(
      createSnapshot({ lat: 39.7, lon: -104.9, anchorLat: 39.7, anchorLon: -104.9 }),
      undefined,
      { lastRelocatedAt: relocatedAt, requireRelocationCooldownAvailable: true }
    );

    expect(rows.get("player-1")).toMatchObject({
      lat: 39.7,
      lon: -104.9,
      anchor_lat: 39.7,
      anchor_lon: -104.9,
      last_relocated_at: relocatedAt
    });
  });

  it("does not clear a newer relocation timestamp during rollback", async () => {
    const newerRelocation = new Date("2026-07-13T12:01:00.000Z");
    const rows = new Map<string, PlayerRowStub>([
      ["player-1", createRow({ id: "player-1", last_relocated_at: newerRelocation })]
    ]);
    const service = new PlayerService(createPoolStub(rows), createConfig());

    await service.persistPlayerSnapshot(
      createSnapshot({ lat: 39.7, lon: -104.9, anchorLat: 39.7, anchorLon: -104.9 }),
      undefined,
      {
        lastRelocatedAt: null,
        restoreRelocationIfCurrent: new Date("2026-07-13T12:00:00.000Z")
      }
    );

    expect(rows.get("player-1")?.last_relocated_at).toEqual(newerRelocation);
  });

  it("loads hunger through reconnect and clamps ordinary writes to the shared capacity", async () => {
    const rows = new Map<string, PlayerRowStub>([["player-1", createRow({
      id: "player-1",
      hunger: 1_337,
      hunger_base_capacity: HUNGER_BASE_CAPACITY
    })]]);
    const service = new PlayerService(createPoolStub(rows), createConfig());

    const persisted = await service.loadPlayer("player-1");
    expect(persisted?.hunger).toEqual({ current: 1_337, baseCapacity: HUNGER_BASE_CAPACITY });

    const state = new GameState(createConfig());
    const connected = state.connectPlayer(persisted!);
    expect(state.snapshotForPlayer(connected.playerId).hunger).toEqual({
      current: 1_337,
      baseCapacity: HUNGER_BASE_CAPACITY
    });

    await service.persistPlayerSnapshot(state.snapshotForPlayer(connected.playerId));
    expect(rows.get("player-1")?.hunger).toBe(1_337);
    await service.persistPlayerSnapshot(createSnapshot({
      hunger: { current: HUNGER_BASE_CAPACITY + 500, baseCapacity: HUNGER_BASE_CAPACITY }
    }));
    expect(rows.get("player-1")?.hunger).toBe(HUNGER_BASE_CAPACITY);
  });

  it("initializes new in-memory characters at the shared capacity", () => {
    const state = new GameState(createConfig());
    const player = state.helloPlayer("player-1", "Ash");

    expect(player.hunger).toEqual({
      current: HUNGER_BASE_CAPACITY,
      baseCapacity: HUNGER_BASE_CAPACITY
    });
    expect(state.snapshotForPlayer("player-1").hunger).toEqual(player.hunger);
  });

  it("repairs a persisted flag view from the authoritative player anchor", async () => {
    const rows = new Map<string, PlayerRowStub>([["player-1", createRow({ id: "player-1" })]]);
    const logger = { warn: vi.fn() };
    const service = new PlayerService(createPoolStub(rows), createConfig(), logger);

    await service.persistPlayerSnapshot(createSnapshot({
      currentFlagId: "11111111-1111-4111-8111-111111111111"
    }));
    const row = rows.get("player-1")!;
    row.current_flag_name = "Mesa Camp";
    row.current_flag_lat = 35.0845;
    row.current_flag_lon = -106.6501;
    row.resource_vision_center_lat = 35.0845;
    row.resource_vision_center_lon = -106.6501;
    row.current_flag_resource_vision_radius_m = 1_600;

    const persisted = await service.loadPlayer("player-1");
    expect(persisted).toMatchObject({
      resourceVision: {
        flagId: "11111111-1111-4111-8111-111111111111",
        flagName: "Mesa Camp",
        center: { lat: 35.0845, lon: -106.6501 },
        movementLeashRadiusM: 900,
        paddingM: 700,
        radiusM: 1_600
      }
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      playerId: "player-1",
      persistedAnchor: { lat: 35.0844, lon: -106.6504 },
      persistedVisionCenter: { lat: 35.0845, lon: -106.6501 }
    }), expect.stringContaining("connection-time anchor repair"));

    const gameState = new GameState(createConfig(), logger);
    const connected = gameState.connectPlayer(persisted!);
    expect(connected.resourceVision?.center).toEqual(connected.anchor);
    expect(gameState.getResourceVisionRevision("player-1")).toBe(1);
    await service.persistPlayerSnapshot(gameState.snapshotForPlayer("player-1"));
    expect(rows.get("player-1")).toMatchObject({
      resource_vision_center_lat: 35.0844,
      resource_vision_center_lon: -106.6504
    });
  });

  it("restores a Castle vision with the configured radius instead of zero", async () => {
    const rows = new Map<string, PlayerRowStub>([[
      "player-1",
      createRow({
        id: "player-1",
        anchor_lat: 35.2,
        anchor_lon: -106.8,
        current_kingdom_seat_id: "22222222-2222-4222-8222-222222222222",
        current_flag_name: "Mesa Castle",
        current_flag_lat: 35.1,
        current_flag_lon: -106.7,
        current_flag_resource_vision_radius_m: null
      })
    ]]);
    const service = new PlayerService(createPoolStub(rows), createConfig());

    const persisted = await service.loadPlayer("player-1");
    expect(persisted).toMatchObject({
      anchor: { lat: 35.2, lon: -106.8 },
      resourceVision: {
        flagId: "22222222-2222-4222-8222-222222222222",
        destinationKind: "kingdom_seat",
        center: { lat: 35.1, lon: -106.7 },
        radiusM: 950
      }
    });
    const connected = new GameState(createConfig()).connectPlayer(persisted!);
    expect(connected.resourceVision?.center).toEqual(connected.anchor);
  });

  it("restores an off-center City Hall/open-area vision at the persisted anchor", async () => {
    const rows = new Map<string, PlayerRowStub>([[
      "player-1",
      createRow({
        id: "player-1",
        lat: 35.21,
        lon: -106.81,
        anchor_lat: 35.2,
        anchor_lon: -106.8,
        current_flag_id: null,
        current_kingdom_seat_id: null,
        current_flag_name: null,
        current_flag_lat: null,
        current_flag_lon: null
      })
    ]]);
    const service = new PlayerService(createPoolStub(rows), createConfig());

    const persisted = await service.loadPlayer("player-1");
    expect(persisted).toMatchObject({
      anchor: { lat: 35.2, lon: -106.8 },
      resourceVision: {
        destinationKind: "area",
        center: { lat: 35.2, lon: -106.8 },
        movementLeashRadiusM: 900,
        radiusM: 950
      }
    });

    const state = new GameState(createConfig());
    const connected = state.connectPlayer(persisted!);
    expect(state.getResourceVision(connected.playerId)?.center)
      .toEqual(connected.anchor);
    expect(state.currentFlagId(connected.playerId)).toBeNull();
  });

  it("marks players online and offline", async () => {
    const rows = new Map<string, PlayerRowStub>([["player-1", createRow({ id: "player-1" })]]);
    const service = new PlayerService(createPoolStub(rows), createConfig());

    await service.markOffline("player-1");
    expect(rows.get("player-1")?.online).toBe(false);

    await service.markOnline("player-1");
    expect(rows.get("player-1")?.online).toBe(true);
  });

  it("preserves a world authority epoch only while the live runtime is retained", async () => {
    const rows = new Map<string, PlayerRowStub>([["player-1", createRow({ id: "player-1" })]]);
    const service = new PlayerService(createPoolStub(rows), createConfig());
    const persisted = await service.loadPlayer("player-1");
    const state = new GameState(createConfig());

    state.connectPlayer(persisted!);
    const firstEpoch = state.worldAuthorityEpoch("player-1");
    state.markOffline("player-1");
    state.markOnlinePreservingView("player-1");

    expect(state.worldAuthorityEpoch("player-1")).toBe(firstEpoch);

    state.connectPlayer(persisted!);
    expect(state.worldAuthorityEpoch("player-1")).not.toBe(firstEpoch);
  });

  it("repairs a missing world authority epoch when retaining a live runtime", async () => {
    const rows = new Map<string, PlayerRowStub>([["player-1", createRow({ id: "player-1" })]]);
    const service = new PlayerService(createPoolStub(rows), createConfig());
    const persisted = await service.loadPlayer("player-1");
    const state = new GameState(createConfig());

    state.connectPlayer(persisted!);
    const epochs = state as unknown as {
      worldAuthorityEpochs: Map<string, string>;
    };
    epochs.worldAuthorityEpochs.delete("player-1");

    expect(state.markOnlinePreservingView("player-1")).not.toBeNull();
    expect(state.worldAuthorityEpoch("player-1")).toEqual(expect.any(String));
  });

  it.each([
    ["#d83a3a", "red"],
    ["#3366cc", "blue"],
    ["#22a447", "green"],
    ["#c58a16", "gold"],
    ["#7C3AED", "purple"]
  ] as const)("accepts the personal flag color %s", async (hex, color) => {
    const rows = new Map<string, PlayerRowStub>([["player-1", createRow({ id: "player-1" })]]);
    const service = new PlayerService(createPoolStub(rows), createConfig());

    const player = await service.updatePlayerColor("player-1", hex);
    const normalizedHex = hex.toLowerCase();

    expect(player.displayColor).toBe(normalizedHex);
    expect(player.personalFlagColor).toBe(color);
    expect(rows.get("player-1")?.display_color).toBe(normalizedHex);
    expect(rows.get("player-1")?.personal_flag_color).toBe(color);
  });

  it.each(["blue", "black", "#000000", "#000", "#abcdef"])(
    "rejects unsupported personal flag color %s",
    async (invalidColor) => {
    const rows = new Map<string, PlayerRowStub>([["player-1", createRow({ id: "player-1" })]]);
    const service = new PlayerService(createPoolStub(rows), createConfig());

      await expect(service.updatePlayerColor("player-1", invalidColor)).rejects.toThrow();
    }
  );

  it("lists online players in the active region", async () => {
    const rows = new Map<string, PlayerRowStub>([
      ["player-1", createRow({ id: "player-1", username: "Ash", online: true })],
      ["player-2", createRow({ id: "player-2", username: "Bex", online: false })],
      ["player-3", createRow({ id: "player-3", username: "Cy", region_code: "CO", online: true })]
    ]);
    const service = new PlayerService(createPoolStub(rows), createConfig());

    await expect(service.listOnlinePlayers()).resolves.toMatchObject([
      {
        playerId: "player-1",
        username: "Ash",
        online: true,
        zoneId: "world:NM"
      }
    ]);
  });
});

type PlayerRowStub = {
  id: string;
  username: string;
  display_color: string | null;
  personal_flag_color: "red" | "blue" | "green" | "gold" | "purple";
  region_code: string;
  lat: number;
  lon: number;
  anchor_lat: number;
  anchor_lon: number;
  move_leash_radius_m: number;
  online: boolean;
  updated_at: Date;
  last_relocated_at: Date | null;
  current_flag_id: string | null;
  current_kingdom_seat_id: string | null;
  current_flag_name: string | null;
  current_flag_lat: number | null;
  current_flag_lon: number | null;
  current_flag_resource_vision_radius_m: number | null;
  resource_vision_center_lat: number | null;
  resource_vision_center_lon: number | null;
  hunger: number;
  hunger_base_capacity: number;
};

function createPoolStub(rows: Map<string, PlayerRowStub>): pg.Pool {
  return {
    query: async <T>(text: string, values?: readonly unknown[]) => {
      const statement = text.trimStart();
      if (statement.startsWith("SELECT") &&
          text.includes("SELECT last_relocated_at FROM players") &&
          text.includes("WHERE id = $1")) {
        const row = rows.get(String(values?.[0]));
        return {
          rows: (row ? [{ last_relocated_at: row.last_relocated_at }] : []) as T[],
          rowCount: row ? 1 : 0
        };
      }
      if (statement.startsWith("SELECT") &&
          (text.includes("SELECT id") || text.includes("SELECT p.id")) &&
          (text.includes("WHERE id = $1") || text.includes("WHERE p.id = $1"))) {
        const row = rows.get(String(values?.[0]));
        return {
          rows: (row ? [row] : []) as T[],
          rowCount: row ? 1 : 0
        };
      }
      if (text.includes("INSERT INTO players")) {
        const row = createRow({
          id: String(values?.[0]),
          username: String(values?.[1]),
          display_color: nullableString(values?.[2]),
          region_code: String(values?.[3]),
          lat: Number(values?.[4]),
          lon: Number(values?.[5]),
          anchor_lat: Number(values?.[6]),
          anchor_lon: Number(values?.[7]),
          move_leash_radius_m: Number(values?.[8]),
          online: true
        });
        rows.set(row.id, row);
        return {
          rows: [row] as T[],
          rowCount: 1
        };
      }
      if (text.includes("SET username = $2")) {
        const row = requireRow(rows, String(values?.[0]));
        row.username = String(values?.[1]);
        row.move_leash_radius_m = Number(values?.[3]);
        row.online = true;
        return {
          rows: [row] as T[],
          rowCount: 1
        };
      }
      if (text.includes("SET display_color = $2")) {
        const row = requireRow(rows, String(values?.[0]));
        row.display_color = String(values?.[1]);
        row.personal_flag_color = String(values?.[2]) as PlayerRowStub["personal_flag_color"];
        return {
          rows: [row] as T[],
          rowCount: 1
        };
      }
      if (text.includes("SET online = true")) {
        requireRow(rows, String(values?.[0])).online = true;
        return { rows: [] as T[], rowCount: 1 };
      }
      if (text.includes("SET online = false") && text.includes("ANY")) {
        for (const id of values?.[0] as string[]) {
          requireRow(rows, id).online = false;
        }
        return { rows: [] as T[], rowCount: (values?.[0] as string[]).length };
      }
      if (text.includes("SET online = false")) {
        requireRow(rows, String(values?.[0])).online = false;
        return { rows: [] as T[], rowCount: 1 };
      }
      if (text.includes("SET lat = $2")) {
        const row = requireRow(rows, String(values?.[0]));
        const marksRelocation = Boolean(values?.[10]);
        // Mirrors the SQL guard: the cooldown interval is bound as $17 (milliseconds).
        expect(text).not.toMatch(/interval '\d+ hours'/u);
        expect(text).toContain("$17::bigint * interval '1 millisecond'");
        if (
          Boolean(values?.[12]) &&
          row.last_relocated_at !== null &&
          row.last_relocated_at.getTime() >
            new Date(String(values?.[11])).getTime() - Number(values?.[16])
        ) {
          return { rows: [] as T[], rowCount: 0 };
        }
        row.lat = Number(values?.[1]);
        row.lon = Number(values?.[2]);
        row.anchor_lat = Number(values?.[3]);
        row.anchor_lon = Number(values?.[4]);
        row.move_leash_radius_m = Number(values?.[5]);
        row.online = Boolean(values?.[6]);
        row.current_flag_id = nullableString(values?.[8]);
        row.current_kingdom_seat_id = nullableString(values?.[9]);
        row.hunger = Number(values?.[15]);
        const hasAttachedVision = row.current_flag_id !== null ||
          row.current_kingdom_seat_id !== null;
        row.resource_vision_center_lat = hasAttachedVision ? row.anchor_lat : null;
        row.resource_vision_center_lon = hasAttachedVision ? row.anchor_lon : null;
        if (marksRelocation) {
          row.last_relocated_at = values?.[11] == null
            ? null
            : new Date(String(values[11]));
        } else if (
          Boolean(values?.[13]) &&
          row.last_relocated_at !== null &&
          row.last_relocated_at.getTime() === new Date(String(values?.[14])).getTime()
        ) {
          row.last_relocated_at = values?.[11] == null
            ? null
            : new Date(String(values[11]));
        }
        return { rows: [] as T[], rowCount: 1 };
      }
      if (text.includes("WHERE region_code = $1")) {
        const regionCode = String(values?.[0]);
        return {
          rows: [...rows.values()]
            .filter((row) => row.region_code === regionCode && row.online)
            .sort((left, right) => left.username.localeCompare(right.username)) as T[],
          rowCount: rows.size
        };
      }
      return {
        rows: [] as T[],
        rowCount: 0
      };
    }
  } as unknown as pg.Pool;
}

function createRow(overrides: Partial<PlayerRowStub>): PlayerRowStub {
  return {
    id: "player-1",
    username: "Ash",
    display_color: "#38bdf8",
    personal_flag_color: "blue",
    region_code: "NM",
    lat: 35.0844,
    lon: -106.6504,
    anchor_lat: 35.0844,
    anchor_lon: -106.6504,
    move_leash_radius_m: 900,
    online: true,
    current_flag_id: null,
    current_kingdom_seat_id: null,
    current_flag_name: null,
    current_flag_lat: null,
    current_flag_lon: null,
    current_flag_resource_vision_radius_m: null,
    resource_vision_center_lat: null,
    resource_vision_center_lon: null,
    hunger: 2000,
    hunger_base_capacity: 2000,
    updated_at: createdAt,
    last_relocated_at: null,
    ...overrides
  };
}

function createSnapshot(overrides: Partial<PlayerSnapshot>): PlayerSnapshot {
  return {
    playerId: "player-1",
    username: "Ash",
    displayColor: "#38bdf8",
    regionCode: "NM",
    zoneId: "world:NM",
    lat: 35.0844,
    lon: -106.6504,
    anchorLat: 35.0844,
    anchorLon: -106.6504,
    moveLeashRadiusM: 900,
    movementRevision: 0,
    targetLat: null,
    targetLon: null,
    moving: false,
    online: true,
    updatedAt: createdAt.toISOString(),
    ...overrides
  };
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({ NODE_ENV: "test", REGION_CODE: "NM" }),
    ...overrides
  };
}

function requireRow(rows: Map<string, PlayerRowStub>, id: string): PlayerRowStub {
  const row = rows.get(id);
  if (!row) {
    throw new Error(`expected row ${id}`);
  }
  return row;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
