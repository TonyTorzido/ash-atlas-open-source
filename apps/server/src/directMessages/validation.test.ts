import { describe, expect, it } from "vitest";

import { DirectMessageError } from "./types.js";
import { normalizeDirectMessageBody } from "./validation.js";

describe("direct-message plain-text validation", () => {
  it("normalizes text without interpreting markup", () => {
    expect(normalizeDirectMessageBody("  <b>plain</b>\r\nnext  ")).toBe("<b>plain</b>\nnext");
  });

  it("rejects blanks, controls, bidi overrides, and overlong text with transport-safe errors", () => {
    for (const body of [" \n\t ", "bad\u0000text", "safe\u202eunsafe"]) {
      expect(() => normalizeDirectMessageBody(body)).toThrow(DirectMessageError);
    }
    expect(() => normalizeDirectMessageBody("x".repeat(401))).toThrowError(
      expect.objectContaining({ code: "message_too_long", message: "Message is too long." })
    );
  });

  it("counts Unicode code points rather than UTF-16 code units", () => {
    expect(normalizeDirectMessageBody("😀".repeat(400))).toHaveLength(800);
    expect(() => normalizeDirectMessageBody("😀".repeat(401))).toThrowError(
      expect.objectContaining({ code: "message_too_long" })
    );
  });
});
