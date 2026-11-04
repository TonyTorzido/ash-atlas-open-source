import { describe, expect, it, vi } from "vitest";

import { renameFlag } from "./renameFlag.js";

describe("renameFlag", () => {
  it("sends a PATCH request and returns the renamed flag", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        flag: {
          id: "flag-1",
          ownerId: "player-1",
          name: "Renamed",
          lat: 35,
          lon: -106,
          packageId: null,
          elevationM: null,
          terrainClass: null,
          biome: null,
          ecoregion: null,
          claimRadiusM: 700,
          createdAt: "2026-07-08T09:00:00.000Z"
        }
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      renameFlag("http://127.0.0.1:3001", "flag-1", "Renamed", "csrf-token")
    ).resolves.toMatchObject({
      ok: true,
      flag: {
        id: "flag-1",
        name: "Renamed"
      }
    });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3001/api/flags/flag-1", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": "csrf-token"
      },
      credentials: "include",
      body: JSON.stringify({
        name: "Renamed"
      })
    });
  });

  it("returns a readable error on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            message: "you cannot rename this flag"
          }
        })
      }))
    );

    await expect(
      renameFlag("http://127.0.0.1:3001", "flag-1", "Nope", "csrf-token")
    ).resolves.toEqual({
      ok: false,
      message: "you cannot rename this flag"
    });
  });

  it("returns a stable error when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      })
    );

    await expect(
      renameFlag("http://127.0.0.1:3001", "flag-1", "Renamed", "csrf-token")
    ).resolves.toEqual({
      ok: false,
      message: "rename failed: network error"
    });
  });

  it("returns a stable error when the server response is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("unexpected end of JSON input");
        }
      }))
    );

    await expect(
      renameFlag("http://127.0.0.1:3001", "flag-1", "Renamed", "csrf-token")
    ).resolves.toEqual({
      ok: false,
      message: "rename failed: invalid server response"
    });
  });
});
