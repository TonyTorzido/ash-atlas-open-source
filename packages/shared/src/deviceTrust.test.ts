import { describe, expect, it } from "vitest";

import {
  LOCATION_FIX_ASSURANCES,
  NATIVE_LOCATION_SIGNALS_MAX_BYTES,
  attestationRefFromWire,
  buildAttestClientData,
  parseDeviceEnvironment,
  parseNativeLocationSignals
} from "./deviceTrust.js";
import { LOCATION_FIX_REASONS, clientMessageSchema } from "./protocol.js";

const requestId = "00000000-0000-4000-8000-000000000001";

describe("buildAttestClientData", () => {
  it("builds the session form", () => {
    expect(buildAttestClientData("session", "abc_DEF-123"))
      .toBe("ashatlas-attest-v1\nsession\nabc_DEF-123");
  });

  it("binds a relocation fix with fixed-precision strings", () => {
    expect(buildAttestClientData("relocation", "c", {
      lat: 40.0150004,
      lon: -105.27,
      accuracy: 12.345,
      fixTimestampMs: 1_790_000_000_123
    })).toBe("ashatlas-attest-v1\nrelocation\nc\n40.015000\n-105.270000\n12.3\n1790000000123");
  });

  it("leaves accuracy empty when the device gave none", () => {
    expect(buildAttestClientData("relocation", "c", { lat: 0, lon: 0, fixTimestampMs: 5 }))
      .toBe("ashatlas-attest-v1\nrelocation\nc\n0.000000\n0.000000\n\n5");
  });
});

describe("parseNativeLocationSignals", () => {
  it("treats a missing block as absent", () => {
    expect(parseNativeLocationSignals(undefined)).toEqual({ status: "absent", signals: null });
    expect(parseNativeLocationSignals(null)).toEqual({ status: "absent", signals: null });
  });

  it("parses a legacy shell block and strips unknown keys", () => {
    expect(parseNativeLocationSignals({ v: 1, shellBuild: 8, plugin: false, extra: "x" }))
      .toEqual({ status: "ok", signals: { v: 1, shellBuild: 8, plugin: false } });
  });

  it("keeps good fields and drops malformed ones one by one", () => {
    const parsed = parseNativeLocationSignals({
      v: 1,
      plugin: true,
      provider: "fused",
      mock: "yes",
      simulated: false,
      networkCountryIso: "us",
      fixTimestampMs: Number.NaN,
      fixAgeMs: 250
    });
    expect(parsed).toEqual({
      status: "ok",
      signals: { v: 1, plugin: true, provider: "fused", simulated: false, networkCountryIso: "us", fixAgeMs: 250 }
    });
  });

  it("rejects non-objects and oversized blocks", () => {
    expect(parseNativeLocationSignals("native").status).toBe("malformed");
    expect(parseNativeLocationSignals([1]).status).toBe("malformed");
    const big = { v: 1, provider: "x".repeat(NATIVE_LOCATION_SIGNALS_MAX_BYTES) };
    expect(parseNativeLocationSignals(big).status).toBe("malformed");
  });
});

describe("device trust wire fields", () => {
  it("lists every assurance the database accepts", () => {
    expect(LOCATION_FIX_ASSURANCES).toEqual([
      "attested", "device_checked", "unverified", "native_legacy", "web", "flagged"
    ]);
  });

  it("accepts optional native and attestationRef on both location messages", () => {
    const relocation = {
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId,
      lat: 40,
      lon: -105,
      native: { v: 1, shellBuild: 9, plugin: true },
      attestationRef: "ref_0123456789abcdef"
    };
    expect(clientMessageSchema.parse(relocation)).toEqual(relocation);
    const fix = { type: "LOCATION_FIX", lat: 40, lon: -105, native: "garbage", attestationRef: 7 };
    expect(clientMessageSchema.parse(fix)).toEqual(fix);
  });

  it("adds the action fix reasons", () => {
    expect(LOCATION_FIX_REASONS).toEqual([
      "periodic", "pre_action", "action_flag_place", "action_flag_attack", "action_city_found"
    ]);
  });

  it("only passes well-formed attestation refs", () => {
    expect(attestationRefFromWire("ref_0123456789abcdef")).toBe("ref_0123456789abcdef");
    expect(attestationRefFromWire("short")).toBeUndefined();
    expect(attestationRefFromWire({ ref: "x" })).toBeUndefined();
  });
});

describe("parseDeviceEnvironment", () => {
  const full = {
    v: 1,
    installId: "a1b2c3d4-e5f6_7890",
    installIdPersistent: true,
    installSource: "store",
    emulatorHints: ["qemu.props", "goldfish"],
    rootHints: [],
    debuggerAttached: false,
    devOptions: true,
    adbEnabled: false,
    autoTimeEnabled: true,
    vpnActive: false,
    simCountryIso: "us",
    networkCountryIso: null,
    cellMccs: ["310", "311"],
    timeZone: "America/Denver",
    locale: "en_US"
  };

  it("accepts the full block and a minimal one (only v + installId); strips unknown keys such as hookingHints", () => {
    expect(parseDeviceEnvironment(full)).toMatchObject({ status: "ok", environment: { installSource: "store", cellMccs: ["310", "311"] } });
    expect(parseDeviceEnvironment({ v: 1, installId: "install-0001" })).toEqual({
      status: "ok",
      environment: { v: 1, installId: "install-0001" }
    });
    expect(parseDeviceEnvironment({ ...full, hookingHints: ["frida"] }).environment).not.toHaveProperty("hookingHints");
    expect(parseDeviceEnvironment({ ...full, unknownField: "x" })).toMatchObject({ status: "ok" });
    expect((parseDeviceEnvironment({ ...full, unknownField: "x" }).environment as Record<string, unknown>).unknownField).toBeUndefined();
    expect(parseDeviceEnvironment(undefined).status).toBe("absent");
  });

  it.each([
    ["missing installId", { v: 1 }],
    ["short installId", { v: 1, installId: "abc" }],
    ["installId charset", { v: 1, installId: "install id with spaces" }],
    ["too many hints", { ...full, emulatorHints: Array.from({ length: 17 }, (_, i) => `h${i}`) }],
    ["hint charset", { ...full, rootHints: ["su binary!"] }],
    ["hint length", { ...full, rootHints: ["x".repeat(49)] }],
    ["bad install source", { ...full, installSource: "beta" }],
    ["bad MCC", { ...full, cellMccs: ["31"] }],
    ["too many MCCs", { ...full, cellMccs: Array.from({ length: 9 }, () => "310") }],
    ["bad country", { ...full, simCountryIso: "U5" }],
    ["time zone charset", { ...full, timeZone: "America/Denver;drop" }],
    ["locale length", { ...full, locale: "x".repeat(36) }],
    ["wrong type", { ...full, vpnActive: "yes" }],
    ["array", [full]],
    ["oversized", { ...full, padding: "x".repeat(5000) }]
  ])("rejects the whole block when out of bounds: %s", (_label, value) => {
    expect(parseDeviceEnvironment(value)).toEqual({ status: "malformed", environment: null });
  });
});

describe("native GNSS fields", () => {
  it("keeps bounded GNSS values and drops out-of-range ones without failing the block", () => {
    expect(parseNativeLocationSignals({ v: 1, gnssSatellitesUsed: 7, gnssSatellitesVisible: 21, gnssAvgCn0: 31.5 }))
      .toMatchObject({ status: "ok", signals: { gnssSatellitesUsed: 7, gnssSatellitesVisible: 21, gnssAvgCn0: 31.5 } });
    const parsed = parseNativeLocationSignals({ v: 1, gnssSatellitesUsed: -1, gnssSatellitesVisible: 300, gnssAvgCn0: 500, mock: true });
    expect(parsed).toMatchObject({ status: "ok", signals: { mock: true } });
    expect(parsed.signals?.gnssSatellitesUsed).toBeUndefined();
    expect(parsed.signals?.gnssAvgCn0).toBeUndefined();
  });
});
