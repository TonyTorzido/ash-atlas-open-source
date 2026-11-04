import { describe, expect, it, vi } from "vitest";

import { updatePlayerColor } from "./updatePlayerColor.js";

describe("updatePlayerColor", () => {
  it("returns the updated player on success", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        player: {
          playerId: "player-1",
          displayColor: "#3366cc"
        }
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updatePlayerColor("http://server", "player-1", "#3366cc", "csrf-token")
    ).resolves.toMatchObject({
      ok: true,
      player: {
        displayColor: "#3366cc"
      }
    });
    expect(fetchMock).toHaveBeenCalledWith("http://server/api/players/player-1/color", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "csrf-token"
      },
      credentials: "include",
      body: JSON.stringify({
        color: "#3366cc"
      })
    });

    vi.unstubAllGlobals();
  });

  it("returns an error message on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({
          error: {
            message: "player color must be a #RRGGBB hex color"
          }
        })
      }))
    );

    await expect(
      updatePlayerColor("http://server", "player-1", "red", "csrf-token")
    ).resolves.toEqual({
      ok: false,
      message: "player color must be a #RRGGBB hex color"
    });

    vi.unstubAllGlobals();
  });

  it("returns a stable error when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      })
    );

    await expect(
      updatePlayerColor("http://server", "player-1", "#3366cc", "csrf-token")
    ).resolves.toEqual({
      ok: false,
      message: "failed to update flag color"
    });

    vi.unstubAllGlobals();
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
      updatePlayerColor("http://server", "player-1", "#3366cc", "csrf-token")
    ).resolves.toEqual({
      ok: false,
      message: "failed to update flag color"
    });

    vi.unstubAllGlobals();
  });
});
