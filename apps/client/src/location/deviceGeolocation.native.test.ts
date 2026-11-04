import { afterEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ platform: "android", checkPermissions: vi.fn(), requestPermissions: vi.fn(), getCurrentPosition: vi.fn() }));
const trust = vi.hoisted(() => ({ available: false, getCapabilities: vi.fn(), getCurrentFix: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => native.platform,
    isPluginAvailable: (name: string) => name === "DeviceTrust" && trust.available
  },
  registerPlugin: () => ({ getCapabilities: trust.getCapabilities, getCurrentFix: trust.getCurrentFix })
}));
vi.mock("@capacitor/geolocation", () => ({ Geolocation: native }));
vi.mock("@capacitor/app", () => ({ App: { getInfo: async () => ({ version: "1.0", build: "42" }) } }));
import { getCurrentDeviceLocation, getPassiveDeviceLocation } from "./deviceGeolocation.js";
import { resetDeviceTrustForTests } from "../native/nativeDeviceTrust.js";
const LEGACY = { v: 1, shellBuild: 42, plugin: false };
afterEach(() => {
  vi.clearAllMocks();
  native.platform = "android";
  trust.available = false;
  resetDeviceTrustForTests();
});
describe("native location authority", () => {
  it("accepts Android approximate permission without prompting again and retains measured accuracy", async () => {
    native.checkPermissions.mockResolvedValue({ location: "denied", coarseLocation: "granted" });
    native.getCurrentPosition.mockResolvedValue({ coords: { latitude: 40, longitude: -105, accuracy: 3500 } });
    await expect(getCurrentDeviceLocation()).resolves.toEqual({ lat: 40, lon: -105, accuracy: 3500, native: LEGACY });
    expect(native.requestPermissions).not.toHaveBeenCalled();
    expect(native.getCurrentPosition).toHaveBeenCalledWith(expect.objectContaining({ enableHighAccuracy: false }));
  });
  it("does not interpret the Android-only coarse grant as iOS permission", async () => {
    native.platform = "ios";
    native.checkPermissions.mockResolvedValue({ location: "denied", coarseLocation: "granted" });
    await expect(getCurrentDeviceLocation()).rejects.toMatchObject({ code: "LOCATION_PERMISSION_DENIED" });
    expect(native.getCurrentPosition).not.toHaveBeenCalled();
  });
});
describe("native passive location", () => {
  it("never requests permission and reads nothing unless precise location is already granted", async () => {
    for (const permissions of [
      { location: "prompt", coarseLocation: "prompt" },
      { location: "prompt-with-rationale", coarseLocation: "prompt" },
      { location: "denied", coarseLocation: "granted" }
    ]) {
      native.checkPermissions.mockResolvedValueOnce(permissions);
      await expect(getPassiveDeviceLocation()).resolves.toBeNull();
    }
    expect(native.requestPermissions).not.toHaveBeenCalled();
    expect(native.getCurrentPosition).not.toHaveBeenCalled();
  });
  it("returns a fix when granted and swallows plugin failures", async () => {
    native.checkPermissions.mockResolvedValue({ location: "granted", coarseLocation: "granted" });
    native.getCurrentPosition.mockResolvedValueOnce({ coords: { latitude: 40, longitude: -105, accuracy: 20 } });
    await expect(getPassiveDeviceLocation()).resolves.toEqual({ lat: 40, lon: -105, accuracy: 20, native: LEGACY });
    native.getCurrentPosition.mockRejectedValueOnce(new Error("location services off"));
    await expect(getPassiveDeviceLocation()).resolves.toBeNull();
    expect(native.requestPermissions).not.toHaveBeenCalled();
  });
});
describe("DeviceTrust plugin path", () => {
  it("treats an UNIMPLEMENTED getCapabilities as a legacy shell", async () => {
    trust.available = true;
    trust.getCapabilities.mockRejectedValue(Object.assign(new Error("not implemented"), { code: "UNIMPLEMENTED" }));
    native.checkPermissions.mockResolvedValue({ location: "granted", coarseLocation: "granted" });
    native.getCurrentPosition.mockResolvedValue({ coords: { latitude: 40, longitude: -105, accuracy: 20 } });
    await expect(getCurrentDeviceLocation()).resolves.toEqual({ lat: 40, lon: -105, accuracy: 20, native: LEGACY });
    expect(trust.getCurrentFix).not.toHaveBeenCalled();
  });
  it("reads the plugin fix with mock flags and its fix time", async () => {
    trust.available = true;
    trust.getCapabilities.mockResolvedValue({ v: 1, platform: "android", location: true, playIntegrity: true, appAttest: false, deviceCheck: false });
    trust.getCurrentFix.mockResolvedValue({
      lat: 40.1, lon: -105.2, accuracy: 12.5, timestampMs: 1_700_000_000_000.7,
      provider: "fused", mock: true, devOptions: false, networkCountryIso: "us", junk: "x"
    });
    native.checkPermissions.mockResolvedValue({ location: "granted", coarseLocation: "granted" });
    const location = await getCurrentDeviceLocation();
    expect(location).toMatchObject({ lat: 40.1, lon: -105.2, accuracy: 12.5 });
    expect(location.native).toMatchObject({
      v: 1, shellBuild: 42, plugin: true, provider: "fused", mock: true, devOptions: false,
      networkCountryIso: "us", fixTimestampMs: 1_700_000_000_000
    });
    expect(location.native).not.toHaveProperty("junk");
    expect(native.getCurrentPosition).not.toHaveBeenCalled();
    expect(trust.getCurrentFix).toHaveBeenCalledWith({ enableHighAccuracy: true, maximumAgeMs: 0, timeoutMs: 15_000 });
  });
  it("relocation falls back to Capacitor on a plugin read failure; passive does not", async () => {
    trust.available = true;
    trust.getCapabilities.mockResolvedValue({ v: 1, platform: "ios", location: true, playIntegrity: false, appAttest: true, deviceCheck: true });
    trust.getCurrentFix.mockRejectedValue(Object.assign(new Error("boom"), { code: "LOCATION_UNAVAILABLE" }));
    native.checkPermissions.mockResolvedValue({ location: "granted", coarseLocation: "granted" });
    native.getCurrentPosition.mockResolvedValue({ coords: { latitude: 1, longitude: 2 }, timestamp: 1234 });
    await expect(getCurrentDeviceLocation()).resolves.toEqual({
      lat: 1, lon: 2, native: { v: 1, shellBuild: 42, plugin: true, fixTimestampMs: 1234 }
    });
    await expect(getPassiveDeviceLocation()).resolves.toBeNull();
    trust.getCurrentFix.mockRejectedValue(Object.assign(new Error("denied"), { code: "PERMISSION_DENIED" }));
    await expect(getCurrentDeviceLocation()).rejects.toMatchObject({ code: "LOCATION_PERMISSION_DENIED" });
  });
});
