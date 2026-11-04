import type { FlagSnapshot } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { FlagService } from "./flags.js";

describe("FlagService global snapshot pagination", () => {
  it.each([0, 1, 1_000, 1_001, 4_321])(
    "publishes %i flags exactly once with bounded keyset pages",
    async (count) => {
      const flags = Array.from({ length: count }, (_, index) =>
        flag(`flag-${String(index).padStart(5, "0")}`)
      );
      const client = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("flag_set_revision_sequence")) {
            return { rows: [{ revision: "42" }], rowCount: 1 };
          }
          if (sql.includes("SELECT revision")) {
            return { rows: [{ revision: "0" }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
        release: vi.fn()
      };
      const pool = { connect: vi.fn(async () => client) };
      const service = new FlagService(
        pool as never,
        {} as never,
        {} as never,
        { warn: vi.fn() } as never
      );
      const pageSize = 250;
      const list = vi.spyOn(service, "listFlags").mockImplementation(
        async (_bbox, limit, afterId) => {
          const start = afterId
            ? flags.findIndex((entry) => entry.id === afterId) + 1
            : 0;
          return flags.slice(start, start + (limit ?? 500));
        }
      );
      const published: FlagSnapshot[] = [];
      const chunkSizes: number[] = [];

      const result = await service.streamFlagSnapshot(
        (chunk) => {
          expect(client.release).toHaveBeenCalledTimes(1);
          published.push(...chunk.flags);
          chunkSizes.push(chunk.flags.length);
          return true;
        },
        pageSize
      );

      expect(result).toEqual({
        flagSetRevision: 42,
        chunksPublished: Math.max(1, Math.ceil(count / pageSize)),
        flagsPublished: count,
        completed: true
      });
      expect(new Set(published.map((entry) => entry.id)).size).toBe(count);
      expect(published.map((entry) => entry.id)).toEqual(
        flags.map((entry) => entry.id)
      );
      expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(pageSize);
      expect(list.mock.calls.every((call) => call[2] === undefined
        || typeof call[2] === "string")).toBe(true);
      expect(list.mock.calls.every((call) => call[0] === undefined)).toBe(true);
      expect(client.query).toHaveBeenCalledWith(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
      );
      expect(client.query).toHaveBeenCalledWith("COMMIT");
    }
  );

  it("paginates a gameplay circle without calling the global listing", async () => {
    const client = snapshotClient();
    const service = new FlagService(
      { connect: vi.fn(async () => client) } as never,
      {} as never,
      {} as never,
      { warn: vi.fn() } as never
    );
    const nearby = [flag("flag-near-a"), flag("flag-near-b")];
    const global = vi.spyOn(service, "listFlags");
    const scoped = vi.spyOn(service, "listFlagsInGameplayCircle")
      .mockResolvedValueOnce(nearby)
      .mockResolvedValueOnce([]);
    const published: FlagSnapshot[] = [];

    await expect(service.streamFlagSnapshot(
      (chunk) => {
        published.push(...chunk.flags);
        return true;
      },
      2,
      { center: { lat: 66, lon: -147 }, radiusM: 650 }
    )).resolves.toMatchObject({ completed: true, flagsPublished: 2 });

    expect(global).not.toHaveBeenCalled();
    expect(scoped).toHaveBeenNthCalledWith(
      1,
      { center: { lat: 66, lon: -147 }, radiusM: 650 },
      2,
      undefined,
      client
    );
    expect(scoped).toHaveBeenNthCalledWith(
      2,
      { center: { lat: 66, lon: -147 }, radiusM: 650 },
      2,
      "flag-near-b",
      client
    );
    expect(published).toEqual(nearby);
  });

  it("shares recent scoped snapshot data without coupling socket delivery", async () => {
    const client = snapshotClient();
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({
        rows: [{ revision: "42" }],
        rowCount: 1
      }))
    };
    const service = new FlagService(
      pool as never,
      {} as never,
      {} as never,
      { warn: vi.fn() } as never
    );
    const nearby = [flag("flag-near-a"), flag("flag-near-b")];
    const scoped = vi.spyOn(service, "listFlagsInGameplayCircle")
      .mockResolvedValueOnce(nearby)
      .mockResolvedValueOnce([]);
    const firstDelivery = deferred<void>();
    const firstStarted = deferred<void>();
    const scope = { center: { lat: 66, lon: -147 }, radiusM: 650 };

    const first = service.streamFlagSnapshot(async () => {
      firstStarted.resolve();
      await firstDelivery.promise;
      return true;
    }, 2, scope);
    await firstStarted.promise;
    const secondPublished: FlagSnapshot[] = [];
    await expect(service.streamFlagSnapshot((chunk) => {
      secondPublished.push(...chunk.flags);
      return true;
    }, 2, scope)).resolves.toMatchObject({
      completed: true,
      flagsPublished: 2
    });

    expect(secondPublished).toEqual(nearby);
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledOnce();
    expect(scoped).toHaveBeenCalledTimes(2);
    firstDelivery.resolve();
    await expect(first).resolves.toMatchObject({ completed: true });
  });

  it("reuses scoped snapshot data for a delayed party follower", async () => {
    let nowMs = 10_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      const client = snapshotClient();
      const pool = {
        connect: vi.fn(async () => client),
        query: vi.fn(async () => ({
          rows: [{ revision: "42" }],
          rowCount: 1
        }))
      };
      const service = new FlagService(
        pool as never,
        {} as never,
        {} as never,
        { warn: vi.fn() } as never
      );
      const nearby = [flag("flag-near-a"), flag("flag-near-b")];
      const scoped = vi.spyOn(service, "listFlagsInGameplayCircle")
        .mockResolvedValueOnce(nearby)
        .mockResolvedValueOnce([]);
      const scope = { center: { lat: 66, lon: -147 }, radiusM: 650 };

      await service.streamFlagSnapshot(() => true, 2, scope);
      nowMs += 4_000;
      const followerFlags: FlagSnapshot[] = [];
      await service.streamFlagSnapshot((chunk) => {
        followerFlags.push(...chunk.flags);
        return true;
      }, 2, scope);

      expect(followerFlags).toEqual(nearby);
      expect(pool.connect).toHaveBeenCalledOnce();
      expect(pool.query).toHaveBeenCalledOnce();
      expect(scoped).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it("does not reuse scoped snapshot data after the flag revision changes", async () => {
    const firstClient = snapshotClient(42);
    const secondClient = snapshotClient(43);
    const pool = {
      connect: vi.fn()
        .mockResolvedValueOnce(firstClient)
        .mockResolvedValueOnce(secondClient),
      query: vi.fn(async () => ({
        rows: [{ revision: "43" }],
        rowCount: 1
      }))
    };
    const service = new FlagService(
      pool as never,
      {} as never,
      {} as never,
      { warn: vi.fn() } as never
    );
    const scoped = vi.spyOn(service, "listFlagsInGameplayCircle")
      .mockResolvedValueOnce([flag("before")])
      .mockResolvedValueOnce([flag("after")]);
    const scope = { center: { lat: 66, lon: -147 }, radiusM: 650 };

    await service.streamFlagSnapshot(() => true, 2, scope);
    const published: FlagSnapshot[] = [];
    await service.streamFlagSnapshot((chunk) => {
      published.push(...chunk.flags);
      return true;
    }, 2, scope);

    expect(published.map((flag) => flag.id)).toEqual(["after"]);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(scoped).toHaveBeenCalledTimes(2);
  });

  it("uses exact geography intersections for flag and kingdom-seat territory", async () => {
    const query = vi.fn(async (
      sql: string,
      parameters?: readonly unknown[]
    ) => {
      void sql;
      void parameters;
      return { rows: [], rowCount: 0 };
    });
    const service = new FlagService(
      { query } as never,
      {} as never,
      {} as never,
      { warn: vi.fn() } as never
    );

    await service.listFlagsInGameplayCircle({
      center: { lat: 66, lon: 179.99 },
      radiusM: 650
    }, 250, "00000000-0000-0000-0000-000000000001");

    const [sql, parameters] = query.mock.calls[0]!;
    expect(sql).toContain("ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography");
    expect(sql).toContain("query_circle.radius_m + f.claim_radius_m");
    expect(sql).toContain("query_circle.radius_m + seat.territory_radius_m");
    expect(parameters).toEqual([
      179.99,
      66,
      650,
      250,
      "#d83a3a",
      "00000000-0000-0000-0000-000000000001",
      10_000
    ]);
  });
});

function snapshotClient(revision = 42) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("flag_set_revision_sequence")) {
        return { rows: [{ revision: String(revision) }], rowCount: 1 };
      }
      if (sql.includes("SELECT revision")) {
        return { rows: [{ revision: "0" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn()
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function flag(id: string): FlagSnapshot {
  return {
    controlType: "personal",
    id,
    ownerId: "owner",
    name: id,
    lat: 39,
    lon: -105,
    packageId: null,
    elevationM: null,
    terrainClass: null,
    biome: null,
    ecoregion: null,
    claimRadiusM: 500,
    cityId: null,
    createdAt: new Date(0).toISOString()
  };
}
