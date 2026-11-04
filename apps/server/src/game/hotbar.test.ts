import {
  HOTBAR_LEGACY_PLAYER_SLOT_IDS,
  HOTBAR_PLAYER_SLOT_IDS,
  HOTBAR_DEFAULT_ROW_POSITIONS,
  defaultHotbarSettings,
  type HotbarUpdate
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { HotbarService } from "./hotbar.js";

function update(revision = 0): HotbarUpdate {
  return {
    revision,
    slots: HOTBAR_PLAYER_SLOT_IDS.map((slotId) => ({ slotId, binding: null }))
  };
}

function serviceWith(clientQuery: ReturnType<typeof vi.fn>) {
  const release = vi.fn();
  const client = { query: clientQuery, release };
  const connect = vi.fn().mockResolvedValue(client);
  const pool = { query: vi.fn(), connect };
  return { service: new HotbarService(pool as never), pool, connect, release };
}

describe("HotbarService", () => {
  it("returns ten empty slots for a player without a persisted row", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const service = new HotbarService(pool as never);
    await expect(service.get("player-1")).resolves.toEqual(defaultHotbarSettings());
  });

  it("decodes durable JSON rows and preserves their revision", async () => {
    const settings = defaultHotbarSettings();
    settings.revision = 4;
    settings.slots[0] = {
      slotId: "left-1",
      binding: { kind: "fishing_rod", rodId: "rod-1" }
    };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ revision: "4", slots: JSON.stringify(settings.slots) }] }) };
    const service = new HotbarService(pool as never);
    await expect(service.get("player-1")).resolves.toEqual(settings);
  });

  it("normalizes legacy six-slot rows and fills the new outer slots", async () => {
    const legacySlots = HOTBAR_LEGACY_PLAYER_SLOT_IDS.map((slotId) => ({
      slotId,
      binding: slotId === "left-1"
        ? { kind: "fishing_rod" as const, rodId: "rod-legacy" }
        : null
    }));
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ revision: "7", slots: legacySlots }] })
    };
    const service = new HotbarService(pool as never);
    await expect(service.get("player-1")).resolves.toEqual({
      revision: 7,
      slots: [
        legacySlots[0], legacySlots[1], legacySlots[2],
        { slotId: "left-4", binding: null },
        { slotId: "left-5", binding: null },
        legacySlots[3], legacySlots[4], legacySlots[5],
        { slotId: "right-4", binding: null },
        { slotId: "right-5", binding: null }
      ],
      rowCount: 4,
      rowPositions: [44, 58, 72, 86, 100]
    });
  });

  it("creates the first row at revision one and releases the transaction client", async () => {
    const clientQuery = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT revision")) return { rows: [] };
      if (sql.includes("INSERT INTO")) return { rows: [{ revision: 1, slots: update().slots }] };
      return { rows: [] };
    });
    const { service, release } = serviceWith(clientQuery);
    await expect(service.update("player-1", update())).resolves.toMatchObject({ revision: 1, slots: update().slots });
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", expect.stringContaining("SELECT revision"), expect.stringContaining("INSERT INTO"), "COMMIT"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("persists Off through five visible rows without applying desktop geometry", async () => {
    for (const rowCount of [0, 1, 2, 3, 4, 5]) {
      const rowPositions = [60, 68, 76, 85, 93];
      const clientQuery = vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT revision")) {
          return { rows: [{ revision: 0, slots: update().slots, row_count: 4, row_positions: HOTBAR_DEFAULT_ROW_POSITIONS }] };
        }
        if (sql.includes("UPDATE player_hotbar_settings")) {
          return { rows: [{ revision: 1, slots: update().slots, row_count: rowCount, row_positions: rowPositions }] };
        }
        return { rows: [] };
      });
      const { service } = serviceWith(clientQuery);
      const result = await service.update("player-1", {
        ...update(),
        rowCount,
        rowPositions
      });
      expect(result.rowCount).toBe(rowCount);
      expect(result.rowPositions).toEqual(rowPositions);
    }
  });

  it("keeps the saved layout when an older client sends only slots", async () => {
    const clientQuery = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT revision")) {
        return { rows: [{ revision: 2, slots: update(2).slots, row_count: 2, row_positions: [10, 30, 42, 63, 84] }] };
      }
      if (sql.includes("UPDATE player_hotbar_settings")) {
        return { rows: [{ revision: 3, slots: update(2).slots, row_count: 2, row_positions: [10, 30, 42, 63, 84] }] };
      }
      return { rows: [] };
    });
    const { service } = serviceWith(clientQuery);
    const result = await service.update("player-1", update(2));
    expect(result.rowCount).toBe(2);
    expect(result.rowPositions).toEqual([10, 30, 42, 63, 84]);
  });

  it("rejects stale writes and rolls back without overwriting another revision", async () => {
    const clientQuery = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT revision")) return { rows: [{ revision: 3, slots: update(3).slots }] };
      return { rows: [] };
    });
    const { service, release } = serviceWith(clientQuery);
    await expect(service.update("player-1", update(2))).rejects.toMatchObject({
      code: "HOTBAR_CHANGED",
      statusCode: 409
    });
    expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(clientQuery).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE player_hotbar_settings"), expect.anything());
    expect(release).toHaveBeenCalledOnce();
  });

  it("turns a concurrent first-write race into the same stale response", async () => {
    let selectCount = 0;
    const clientQuery = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT revision")) {
        selectCount += 1;
        return selectCount === 1 ? { rows: [] } : { rows: [{ revision: 1, slots: update(1).slots }] };
      }
      if (sql.includes("INSERT INTO")) return { rows: [] };
      return { rows: [] };
    });
    const { service } = serviceWith(clientQuery);
    await expect(service.update("player-1", update())).rejects.toMatchObject({ code: "HOTBAR_CHANGED", statusCode: 409 });
    expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
  });

  it("rejects reserved-slot updates before opening a database transaction", async () => {
    const connect = vi.fn();
    const pool = { query: vi.fn(), connect };
    const service = new HotbarService(pool as never);
    const invalid = {
      revision: 0,
      slots: [...update().slots.slice(0, 7), { slotId: "core", binding: null }]
    } as unknown as HotbarUpdate;
    await expect(service.update("player-1", invalid)).rejects.toMatchObject({ code: "HOTBAR_INVALID", statusCode: 400 });
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects legacy six-slot updates before opening a database transaction", async () => {
    const connect = vi.fn();
    const pool = { query: vi.fn(), connect };
    const service = new HotbarService(pool as never);
    const legacy = {
      revision: 0,
      slots: HOTBAR_LEGACY_PLAYER_SLOT_IDS.map((slotId) => ({ slotId, binding: null }))
    } as never;
    await expect(service.update("player-1", legacy)).rejects.toMatchObject({
      code: "HOTBAR_INVALID",
      statusCode: 400
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("fails closed on malformed persisted rows", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ revision: "not-a-number", slots: "{}" }] }) };
    const service = new HotbarService(pool as never);
    await expect(service.get("player-1")).rejects.toMatchObject({
      code: "HOTBAR_UNAVAILABLE",
      statusCode: 503
    });
  });
});
