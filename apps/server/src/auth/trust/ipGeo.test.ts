import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IPGEO_ASN_FILE, IPGEO_CITY_FILE, MaxmindIpGeo, defaultIpGeoDirectory, unavailableIpGeo } from "./ipGeo.js";

const directories: string[] = [];
function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ipgeo-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MaxmindIpGeo", () => {
  it("is unavailable with one warning when the databases are missing", async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const geo = new MaxmindIpGeo(tempDirectory(), { logger });
    await geo.init();
    expect(geo.isAvailable()).toBe(false);
    expect(geo.lookup("8.8.8.8")).toBeNull();
    geo.isAvailable();
    geo.lookup("1.1.1.1");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(unavailableIpGeo.isAvailable()).toBe(false);
  });

  it("maps city and ASN records through injected readers", async () => {
    const directory = tempDirectory();
    writeFileSync(join(directory, IPGEO_CITY_FILE), "x");
    writeFileSync(join(directory, IPGEO_ASN_FILE), "y");
    const open = vi.fn(async (path: string) => path.endsWith(IPGEO_CITY_FILE)
      ? { get: () => ({ country: { iso_code: "us" }, location: { latitude: 39.7, longitude: -105 } }) }
      : { get: () => ({ autonomous_system_number: 7922, autonomous_system_organization: "Comcast" }) }
    ) as never;
    const geo = new MaxmindIpGeo(directory, { open });
    await geo.init();
    expect(geo.isAvailable()).toBe(true);
    expect(geo.lookup("73.1.2.3")).toEqual({
      asn: 7922,
      organization: "Comcast",
      country: "US",
      point: { lat: 39.7, lon: -105 }
    });
  });

  it("reads TRUST_IPGEO_DIR", () => {
    const custom = join(tmpdir(), "custom-ipgeo");
    expect(defaultIpGeoDirectory({ TRUST_IPGEO_DIR: custom })).toBe(custom);
  });
});
