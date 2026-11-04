import { describe, expect, it } from "vitest";

import { broadClientProfile } from "./userAgent.js";

describe("broad device telemetry", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/135.0", "Chrome", "Windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/18 Safari/605.1", "Safari", "macOS"],
    ["Mozilla/5.0 (Android 15) Firefox/136.0", "Firefox", "Android"],
    [undefined, "Other", "Other"]
  ])("reduces a normal user agent to broad families", (userAgent, browserFamily, osFamily) => {
    expect(broadClientProfile(userAgent)).toEqual({ browserFamily, osFamily });
  });

  it("returns no fingerprint-like fields", () => {
    expect(Object.keys(broadClientProfile("Chrome Windows"))).toEqual([
      "browserFamily",
      "osFamily"
    ]);
  });
});
