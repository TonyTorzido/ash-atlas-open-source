import { describe, expect, it } from "vitest";

import { ChatValidationError, normalizeChatBody, normalizeChatSenderDisplayName } from "./validation.js";

describe("chat text validation", () => {
  it("normalizes server-owned plain text without treating markup as HTML", () => {
    expect(normalizeChatBody("  hello\r\n<script>alert(1)</script>  ")).toBe(
      "hello\n<script>alert(1)</script>"
    );
    expect(normalizeChatSenderDisplayName("  Ash   Scout ")).toBe("Ash Scout");
  });

  it("rejects blank, controlled, and oversized bodies by Unicode code point", () => {
    expect(() => normalizeChatBody(" \n\t ")).toThrow(ChatValidationError);
    expect(() => normalizeChatBody("unsafe\u0000text")).toThrow(/control/i);
    expect(normalizeChatBody("😀".repeat(400))).toHaveLength(800);
    expect(() => normalizeChatBody("😀".repeat(401))).toThrow(/400/);
  });

  it("rejects C1, bidi, and invisible-only text while preserving normal Unicode", () => {
    expect(() => normalizeChatBody("unsafe\u0085text")).toThrow(/control/i);
    expect(() => normalizeChatBody("spoof\u202etext")).toThrow(/control/i);
    expect(() => normalizeChatBody("isolate\u2066text\u2069")).toThrow(/control/i);
    expect(() => normalizeChatBody("\u200b\u200c\u200d\ufe0f")).toThrow(/blank/i);
    expect(normalizeChatBody("family 👩‍🚀\nready")).toBe("family 👩‍🚀\nready");
  });
});
