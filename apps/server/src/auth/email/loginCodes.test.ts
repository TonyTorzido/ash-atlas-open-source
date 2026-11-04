import { describe, expect, it } from "vitest";

import {
  generateEmailLoginCode,
  hashEmailLoginCode,
  normalizeEmailLoginCode
} from "./loginCodes.js";

const KEY = "email-code-test-key-aaaaaaaaaaaaaaaaaaaa";

describe("email login codes", () => {
  it("generates six-digit codes including leading zeros", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(generateEmailLoginCode()).toMatch(/^[0-9]{6}$/);
    }
  });

  it("hashes to a 64-char digest bound to key, email, and code", () => {
    const hash = hashEmailLoginCode(KEY, "player@example.com", "012345");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashEmailLoginCode(KEY, "player@example.com", "012345")).toBe(hash);
    expect(hashEmailLoginCode(KEY, "other@example.com", "012345")).not.toBe(hash);
    expect(hashEmailLoginCode(KEY, "player@example.com", "012346")).not.toBe(hash);
    expect(hashEmailLoginCode(`${KEY}x`, "player@example.com", "012345")).not.toBe(hash);
  });

  it.each([
    ["123456", "123456"],
    [" 123 456 ", "123456"],
    ["123-456", "123456"],
    ["12345", null],
    ["1234567", null],
    ["12a456", null],
    ["", null]
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeEmailLoginCode(input)).toBe(expected);
  });
});
