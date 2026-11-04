// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getCurrentDeviceLocation
} from "./deviceGeolocation.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getCurrentDeviceLocation", () => {
  it("does not ask for location until called and returns a valid high-accuracy fix", async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => {
      success({
        coords: {
          latitude: 40.015,
          longitude: -105.27,
          accuracy: 12
        }
      } as GeolocationPosition);
    });
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });

    await expect(getCurrentDeviceLocation()).resolves.toEqual({
      lat: 40.015,
      lon: -105.27,
      accuracy: 12
    });
    expect(getCurrentPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15_000
      }
    );
  });

  it.each([
    [1, "LOCATION_PERMISSION_DENIED", "Location permission is required to relocate."],
    [2, "LOCATION_UNAVAILABLE", "Ash Atlas could not access your current location."],
    [3, "LOCATION_TIMEOUT", "Your device took too long to provide a location. Try again."]
  ] as const)("maps browser error code %i to %s", async (code, expectedCode, message) => {
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: vi.fn((_success: PositionCallback, failure: PositionErrorCallback) => {
          failure({ code, message: "browser failure" } as GeolocationPositionError);
        })
      }
    });

    await expect(getCurrentDeviceLocation()).rejects.toEqual(
      expect.objectContaining({
        code: expectedCode,
        message
      })
    );
  });

  it("rejects malformed browser coordinates instead of sending them", async () => {
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: vi.fn((success: PositionCallback) => {
          success({
            coords: { latitude: Number.NaN, longitude: -105.27, accuracy: 10 }
          } as GeolocationPosition);
        })
      }
    });

    await expect(getCurrentDeviceLocation()).rejects.toEqual(
      expect.objectContaining({
        code: "LOCATION_MALFORMED",
        message: "Your device returned an invalid location. Try again."
      })
    );
  });

  it("reports unavailable when the platform has no geolocation provider", async () => {
    vi.stubGlobal("navigator", {});

    await expect(getCurrentDeviceLocation()).rejects.toEqual(
      expect.objectContaining({
        code: "LOCATION_UNAVAILABLE",
        message: "This device cannot provide a current location."
      })
    );
  });

  it("maps a provider exception to an unavailable error", async () => {
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: vi.fn(() => {
          throw new Error("provider failed");
        })
      }
    });

    await expect(getCurrentDeviceLocation()).rejects.toEqual(
      expect.objectContaining({
        code: "LOCATION_UNAVAILABLE",
        message: "Ash Atlas could not access your current location."
      })
    );
  });
});

describe("getPassiveDeviceLocation (web)", () => {
  it("never touches geolocation before a relocation fix in this session, then respects revoked permission", async () => {
    vi.resetModules();
    const geolocation = await import("./deviceGeolocation.js");
    const getCurrentPosition = vi.fn((success: PositionCallback) => {
      success({ coords: { latitude: 40, longitude: -105, accuracy: 30 } } as GeolocationPosition);
    });
    const query = vi.fn(async () => ({ state: "granted" }));
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition }, permissions: { query } });

    await expect(geolocation.getPassiveDeviceLocation()).resolves.toBeNull();
    expect(getCurrentPosition).not.toHaveBeenCalled();

    await geolocation.getCurrentDeviceLocation();
    getCurrentPosition.mockClear();
    await expect(geolocation.getPassiveDeviceLocation()).resolves.toEqual({ lat: 40, lon: -105, accuracy: 30 });
    expect(getCurrentPosition).toHaveBeenCalledOnce();

    getCurrentPosition.mockClear();
    query.mockResolvedValueOnce({ state: "prompt" });
    await expect(geolocation.getPassiveDeviceLocation()).resolves.toBeNull();
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("reports the device IANA time zone", async () => {
    const { getDeviceTimeZone } = await import("./deviceGeolocation.js");
    expect(getDeviceTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
