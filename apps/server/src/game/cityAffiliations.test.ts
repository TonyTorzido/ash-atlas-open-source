import type pg from "pg";
import { describe, expect, it } from "vitest";

import { CityProfileAffiliationsResolver } from "./cityAffiliations.js";

describe("CityProfileAffiliationsResolver", () => {
  it("derives Home Settlement only from an active authoritative membership", async () => {
    const queries: string[] = [];
    const pool = {
      query: async (text: string) => {
        queries.push(text);
        return {
          rows: text.includes("kingdom_memberships") ? [] : [{
            city_id: "00000000-0000-4000-8000-000000900005",
            city_name: "Albuquerque", role: "mayor", joined_at: "2026-01-01T00:00:00.000Z"
          }]
        };
      }
    } as unknown as pg.Pool;
    await expect(new CityProfileAffiliationsResolver(pool).resolve("player-1")).resolves.toEqual({
      class: null,
      kingdom: null,
      settlement: {
        id: "00000000-0000-4000-8000-000000900005",
        name: "Albuquerque",
        tier: "city",
        memberRole: "mayor",
        joinedAt: "2026-01-01T00:00:00.000Z"
      }
    });
    expect(queries[0]).toContain("membership.left_at IS NULL");
    expect(queries[0]).toContain("c.active");
    expect(queries[0]).toContain("c.mayor_player_id");
  });

  it("returns no Home Settlement without membership", async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    await expect(new CityProfileAffiliationsResolver(pool).resolve("player-1")).resolves.toEqual({
      class: null,
      kingdom: null,
      settlement: null
    });
  });

  it("derives Kingdom and city affiliations independently", async () => {
    const pool = {
      query: async (text: string) => ({
        rows: text.includes("kingdom_memberships")
          ? [{
              kingdom_id: "00000000-0000-4000-8000-000000900006",
              kingdom_name: "Mesa Wardens",
              emblem_key: "sun",
              role: "officer"
            }]
          : [{
              city_id: "00000000-0000-4000-8000-000000900005",
              city_name: "Albuquerque",
              role: "member",
              joined_at: "2026-01-01T00:00:00.000Z"
            }]
      })
    } as unknown as pg.Pool;
    await expect(new CityProfileAffiliationsResolver(pool).resolve("player-1")).resolves.toMatchObject({
      kingdom: {
        id: "00000000-0000-4000-8000-000000900006",
        name: "Mesa Wardens",
        emblemKey: "sun",
        memberRole: "officer"
      },
      settlement: {
        id: "00000000-0000-4000-8000-000000900005",
        name: "Albuquerque",
        memberRole: "member"
      }
    });
  });
});
