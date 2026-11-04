import { describe, expect, it } from "vitest";

import {
  authSessionServerMessageSchema,
  clientMessageSchema,
  helloMessageSchema
} from "./protocol.js";

describe("authenticated gameplay protocol", () => {
  it("accepts an identity-free HELLO", () => {
    expect(helloMessageSchema.parse({ type: "HELLO" })).toEqual({ type: "HELLO" });
  });

  it("accepts only an intent-only application suspend frame", () => {
    expect(clientMessageSchema.parse({ type: "APP_SUSPEND" })).toEqual({
      type: "APP_SUSPEND"
    });
    expect(clientMessageSchema.safeParse({
      type: "APP_SUSPEND",
      playerId: "spoofed-player",
      position: { lat: 1, lon: 2 }
    }).success).toBe(false);
  });

  it.each([
    { type: "HELLO", playerId: "spoofed-player" },
    { type: "HELLO", accountId: "spoofed-account" },
    { type: "HELLO", username: "Admin" },
    { type: "HELLO", sessionToken: "raw-session" }
  ])("rejects client-selected identity fields in HELLO", (message) => {
    expect(clientMessageSchema.safeParse(message).success).toBe(false);
  });

  it("validates session replacement and invalidation messages", () => {
    expect(
      authSessionServerMessageSchema.parse({
        type: "SESSION_REPLACED",
        message: "newer connection"
      })
    ).toEqual({ type: "SESSION_REPLACED", message: "newer connection" });
    expect(
      authSessionServerMessageSchema.parse({
        type: "AUTH_SESSION_INVALID",
        code: "SESSION_EXPIRED",
        message: "Session expired"
      })
    ).toMatchObject({ type: "AUTH_SESSION_INVALID", code: "SESSION_EXPIRED" });
  });
});
