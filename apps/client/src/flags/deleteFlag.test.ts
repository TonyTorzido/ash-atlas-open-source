import { describe, expect, it, vi } from "vitest";

import { deleteFlag } from "./deleteFlag.js";

describe("deleteFlag", () => {
  it("returns success when the server deletes a flag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ ok: true, flagId: "flag-1" }, 200))
    );

    await expect(deleteFlag("http://127.0.0.1:3001", "flag-1", "csrf-token")).resolves.toEqual({
      ok: true,
      flagId: "flag-1",
      inventory: null,
      droppedItems: []
    });
  });

  it("returns a readable error when delete fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({ ok: false, error: { message: "you cannot delete this flag" } }, 403)
      )
    );

    await expect(deleteFlag("http://127.0.0.1:3001", "flag-1", "csrf-token")).resolves.toEqual({
      ok: false,
      message: "you cannot delete this flag"
    });
  });

  it("returns a stable error when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      })
    );

    await expect(deleteFlag("http://127.0.0.1:3001", "flag-1", "csrf-token")).resolves.toEqual({
      ok: false,
      message: "delete failed: network error"
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

    await expect(deleteFlag("http://127.0.0.1:3001", "flag-1", "csrf-token")).resolves.toEqual({
      ok: false,
      message: "delete failed: invalid server response"
    });
  });
});

function response(payload: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  } as Response;
}
