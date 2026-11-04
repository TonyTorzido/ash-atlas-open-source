import { describe, expect, it } from "vitest";

import {
  csrfTokenForSession,
  csrfTokensMatch,
  generateSecureToken,
  hashAuthToken,
  isSecureToken
} from "./tokens.js";
import {
  NetworkTelemetryHasher,
  networkPrefix,
  normalizeIp
} from "./networkTelemetry.js";

describe("authentication tokens", () => {
  it("generates at least 256 bits of random token material", () => {
    const first = generateSecureToken();
    const second = generateSecureToken();
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(isSecureToken(first)).toBe(true);
    expect(isSecureToken("attacker-selected-cookie")).toBe(false);
    expect(first).not.toBe(second);
  });

  it("uses purpose-separated deterministic HMACs", () => {
    const session = hashAuthToken("raw", "a-key-that-is-long-enough-for-tests", "session");
    expect(session).toBe(
      hashAuthToken("raw", "a-key-that-is-long-enough-for-tests", "session")
    );
    expect(session).not.toBe(
      hashAuthToken("raw", "a-key-that-is-long-enough-for-tests", "device")
    );
    expect(session).not.toContain("raw");
  });

  it("derives and timing-safely validates CSRF tokens", () => {
    const token = csrfTokenForSession("session", "a-key-that-is-long-enough-for-tests");
    expect(csrfTokensMatch(token, token)).toBe(true);
    expect(csrfTokensMatch(token, `${token}x`)).toBe(false);
    expect(csrfTokensMatch(token, undefined)).toBe(false);
  });
});

describe("network privacy telemetry", () => {
  it("normalizes mapped IPv4 and derives /24 relationships", () => {
    expect(normalizeIp("::ffff:192.168.4.27")).toBe("192.168.4.27");
    expect(networkPrefix("192.168.4.27")).toBe("192.168.4.0/24");
    expect(networkPrefix("192.168.4.250")).toBe("192.168.4.0/24");
  });

  it("derives equivalent IPv6 /56 relationships", () => {
    const first = normalizeIp("2001:db8:abcd:12ff::1");
    const second = normalizeIp("2001:db8:abcd:1201::9");
    expect(networkPrefix(first)).toBe(networkPrefix(second));
    expect(networkPrefix(first).endsWith("/56")).toBe(true);
  });

  it("stores only versioned HMACs and changes them when keys rotate", () => {
    const first = new NetworkTelemetryHasher("first-key-with-at-least-32-characters", "v1").derive(
      "203.0.113.42"
    );
    const same = new NetworkTelemetryHasher("first-key-with-at-least-32-characters", "v1").derive(
      "203.0.113.42"
    );
    const rotated = new NetworkTelemetryHasher(
      "second-key-with-at-least-32-characters",
      "v2"
    ).derive("203.0.113.42");
    expect(first).toEqual(same);
    expect(first).not.toEqual(rotated);
    expect(JSON.stringify(first)).not.toContain("203.0.113.42");
  });
});
