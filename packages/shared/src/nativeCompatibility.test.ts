import { describe, expect, it } from "vitest";

import {
  evaluateNativeCompatibility,
  nativeCompatibilityRequestSchema
} from "./nativeCompatibility.js";

const request = {
  platform: "android" as const,
  version: "1.0.0",
  build: 42,
  wsMin: 3,
  wsMax: 3
};

describe("native compatibility contract", () => {
  it("reports a supported bundle without applying an exact SHA gate", () => {
    const response = evaluateNativeCompatibility(request, {
      latest: { version: "2.0.0", build: 1 },
      serverSha: "a".repeat(40)
    });
    expect(response).toMatchObject({
      contractVersion: 1,
      platform: "android",
      build: "42",
      minVersion: "0.0.0",
      currentVersion: "2.0.0",
      status: "supported",
      serverSha: "a".repeat(40)
    });
  });

  it("distinguishes recommended and required updates", () => {
    expect(evaluateNativeCompatibility({ ...request, version: "1.1.0" }, {
      hardMinimum: { version: "1.0.0", build: 1 },
      recommendedMinimum: { version: "1.2.0", build: 1 }
    }).status).toBe("recommended");
    expect(evaluateNativeCompatibility({ ...request, version: "0.9.0" }, {
      hardMinimum: { version: "1.0.0", build: 1 }
    }).status).toBe("required");
  });

  it("compares build numbers when marketing versions match", () => {
    expect(evaluateNativeCompatibility({ ...request, build: 41 }, {
      hardMinimum: { version: "1.0.0", build: 40 },
      recommendedMinimum: { version: "1.0.0", build: 42 },
      latest: { version: "1.0.0", build: 43 }
    }).status).toBe("recommended");
    expect(evaluateNativeCompatibility({ ...request, build: 39 }, {
      hardMinimum: { version: "1.0.0", build: 40 }
    }).status).toBe("required");
  });

  it("keeps forced updates disabled by default", () => {
    expect(evaluateNativeCompatibility({ ...request, version: "0.1.0", build: 0 }).status)
      .toBe("recommended");
  });

  it("requires a bundle whose WebSocket range cannot speak to the server", () => {
    expect(evaluateNativeCompatibility({ ...request, wsMin: 4, wsMax: 4 }, {
      wsMin: 3,
      wsMax: 3
    }).status).toBe("required");
  });

  it("reports shell, bundle, and no-update requirements independently of the v1 status", () => {
    expect(evaluateNativeCompatibility({ ...request, build: 7 }).updateStatus)
      .toBe("shell_update_required");
    expect(evaluateNativeCompatibility({ ...request, wsMin: 4, wsMax: 4 }).updateStatus)
      .toBe("bundle_update_required");
    expect(evaluateNativeCompatibility(request).updateStatus).toBe("ok");
    expect(evaluateNativeCompatibility({ ...request, build: 7 }).status).toBe("supported");
  });

  it("rejects an inverted client WebSocket range", () => {
    expect(nativeCompatibilityRequestSchema.safeParse({
      ...request,
      wsMin: 4,
      wsMax: 3
    }).success).toBe(false);
  });
});
