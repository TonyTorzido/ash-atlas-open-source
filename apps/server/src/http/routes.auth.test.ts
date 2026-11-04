import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { authoritativePlayerId } from "./routes.js";

describe("HTTP gameplay ownership", () => {
  it("ignores a client-supplied player ID when a session owns the request", () => {
    const request = {
      authSession: {
        player: { id: "session-player" }
      }
    } as unknown as FastifyRequest;

    expect(authoritativePlayerId(request, "spoofed-player")).toBe("session-player");
  });

  it("retains the legacy ID only for unauthenticated test-mode routes", () => {
    const request = { authSession: null } as unknown as FastifyRequest;
    expect(authoritativePlayerId(request, "legacy-test-player")).toBe("legacy-test-player");
  });
});
