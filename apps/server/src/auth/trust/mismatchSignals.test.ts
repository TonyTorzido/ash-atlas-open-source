import { describe, expect, it } from "vitest";

import { countriesForZones, utcOffsetMinutes, zonesAt } from "./geoZones.js";
import type { IpGeoLookup, IpGeoResult } from "./ipGeo.js";
import { StaticFixTracker, evaluateMismatch, staticFixSignal } from "./mismatchSignals.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DENVER = { lat: 39.74, lon: -104.99 };
const LONDON_POINT = { lat: 51.5, lon: -0.12 };

function geo(result: Partial<IpGeoResult> | null, available = true): IpGeoLookup {
  return {
    isAvailable: () => available,
    lookup: () => result === null ? null : { asn: null, organization: null, country: null, point: null, ...result }
  };
}

function evaluate(
  extra: Partial<Parameters<typeof evaluateMismatch>[0]> = {},
  ipGeo: IpGeoLookup | null = null
) {
  return evaluateMismatch(
    { accountId: "a1", ...DENVER, now: NOW, clientIp: "203.0.113.9", ...extra },
    { ipGeo }
  );
}

const rules = (result: ReturnType<typeof evaluate>) => result.signals.map((signal) => signal.rule);

describe("geo zones", () => {
  it("resolves GPS to zone and country, and multi-country zones pass for each country", () => {
    expect(zonesAt(DENVER.lat, DENVER.lon)).toEqual(["America/Denver"]);
    expect(countriesForZones(["America/Denver"]).has("US")).toBe(true);
    const balkans = countriesForZones(["Europe/Belgrade"]);
    expect(balkans.has("RS")).toBe(true);
    expect(balkans.has("HR")).toBe(true);
    expect(countriesForZones(["Etc/GMT+2"]).size).toBe(0);
  });

  it("computes current UTC offsets", () => {
    expect(utcOffsetMinutes("America/Denver", NOW)).toBe(-360);
    expect(utcOffsetMinutes("Asia/Kolkata", NOW)).toBe(330);
    expect(utcOffsetMinutes("UTC", NOW)).toBe(0);
    expect(utcOffsetMinutes("Not/AZone", NOW)).toBeNull();
  });
});

describe("ip_location_mismatch", () => {
  it("is hard-eligible for a fixed-line ASN more than 500 km away", () => {
    const result = evaluate({}, geo({ asn: 7922, country: "GB", point: LONDON_POINT }));
    expect(rules(result)).toEqual(["ip_location_mismatch"]);
    expect(result.hardIpMismatch).toBe(true);
    expect(result.signals[0]!.weight).toBe(2);
    expect(result.excludeFromSettled).toBe(true);
  });

  it("does not fire for a fixed-line ASN within 500 km", () => {
    const result = evaluate({}, geo({ asn: 7922, country: "US", point: { lat: 40.0, lon: -105.3 } }));
    expect(rules(result)).toEqual([]);
    expect(result.hardIpMismatch).toBe(false);
    expect(result.excludeFromSettled).toBe(false);
  });

  it("uses country level and is never hard for mobile and unknown ASNs", () => {
    const mobile = evaluate({}, geo({ asn: 21928, country: "GB", point: LONDON_POINT }));
    expect(rules(mobile)).toEqual(["ip_location_mismatch"]);
    expect(mobile.hardIpMismatch).toBe(false);
    const unknown = evaluate({}, geo({ asn: 64510, organization: "Regional Telecom", country: "GB" }));
    expect(rules(unknown)).toEqual(["ip_location_mismatch"]);
    expect(unknown.hardIpMismatch).toBe(false);
    // Same country, far city: fine for mobile.
    expect(rules(evaluate({}, geo({ asn: 21928, country: "US", point: { lat: 25.8, lon: -80.2 } })))).toEqual([]);
  });

  it("passes when the IP country is any country of a multi-country GPS zone", () => {
    const belgrade = { lat: 44.8, lon: 20.46 };
    expect(rules(evaluate(belgrade, geo({ asn: 21928, country: "HR" })))).toEqual([]);
    expect(rules(evaluate(belgrade, geo({ asn: 21928, country: "US" })))).toEqual(["ip_location_mismatch"]);
  });
});

describe("hosting/VPN and satellite", () => {
  it("flags hosting/VPN, suppresses the distance rule and excludes the fix from Settled", () => {
    const result = evaluate({}, geo({ asn: 16509, country: "GB", point: LONDON_POINT }));
    expect(rules(result)).toEqual(["ip_hosting_or_vpn"]);
    expect(result.signals[0]!.weight).toBe(1);
    expect(result.hardIpMismatch).toBe(false);
    expect(result.excludeFromSettled).toBe(true);
    expect(result.signals[0]!.metadata?.dedupeKey).toBe("ip_hosting_or_vpn:a1:2026-10-01");
  });

  it("treats satellite as neutral: feature only, no mismatch, still counts", () => {
    const result = evaluate({}, geo({ asn: 14593, country: "GB", point: LONDON_POINT }));
    expect(rules(result)).toEqual([]);
    expect(result.features).toMatchObject({ ipAsnClass: "satellite", ipSatellite: true });
    expect(result.excludeFromSettled).toBe(false);
  });
});

describe("missing database and privacy", () => {
  it("skips every IP signal without a database or address", () => {
    expect(rules(evaluate({}, null))).toEqual([]);
    expect(rules(evaluate({}, geo({ asn: 7922, country: "GB", point: LONDON_POINT }, false)))).toEqual([]);
    expect(rules(evaluate({ clientIp: null }, geo({ asn: 7922, country: "GB", point: LONDON_POINT })))).toEqual([]);
  });

  it("stores only ASN, class, country and a 0.1 degree point, never the IP", () => {
    const result = evaluate({}, geo({ asn: 7922, country: "GB", point: { lat: 51.5074, lon: -0.1278 } }));
    expect(result.features).toMatchObject({
      ipAsn: 7922,
      ipAsnClass: "fixed",
      ipCountry: "GB",
      ipPoint: { lat: 51.5, lon: -0.1 }
    });
    expect(JSON.stringify(result)).not.toContain("203.0.113.9");
  });
});

describe("carrier_country_mismatch", () => {
  it("fires and is hard-eligible when the carrier country differs from the GPS country", () => {
    const result = evaluate({ networkCountryIso: "gb" });
    expect(rules(result)).toEqual(["carrier_country_mismatch"]);
    expect(result.hardCarrierMismatch).toBe(true);
  });

  it("skips empty and matching values", () => {
    expect(rules(evaluate({ networkCountryIso: "" }))).toEqual([]);
    expect(rules(evaluate({ networkCountryIso: "US" }))).toEqual([]);
    expect(rules(evaluate({}))).toEqual([]);
  });

  it("accepts any country of a multi-country zone", () => {
    expect(rules(evaluate({ lat: 44.8, lon: 20.46, networkCountryIso: "BA" }))).toEqual([]);
  });
});

describe("timezone_mismatch", () => {
  it("fires beyond one hour and is never hard", () => {
    const result = evaluate({ deviceTimeZone: "Asia/Tokyo" });
    expect(rules(result)).toEqual(["timezone_mismatch"]);
    expect(result.signals[0]!.weight).toBe(1);
    expect(result.excludeFromSettled).toBe(false);
  });

  it("passes the same zone, within one hour and unknown device zones", () => {
    expect(rules(evaluate({ deviceTimeZone: "America/Denver" }))).toEqual([]);
    expect(rules(evaluate({ deviceTimeZone: "America/Chicago" }))).toEqual([]);
    expect(rules(evaluate({ deviceTimeZone: "Nope/Nope" }))).toEqual([]);
    expect(rules(evaluate({}))).toEqual([]);
  });
});

describe("gps_static", () => {
  it("emits +0.5 once per full run of 10 identical fixes and never marks hard", () => {
    const tracker = new StaticFixTracker();
    const key = StaticFixTracker.keyFor(40.123456, -105.123456, 12);
    const input = { accountId: "a1", lat: 40.123456, lon: -105.123456, now: NOW };
    const emitted: number[] = [];
    for (let index = 1; index <= 20; index += 1) {
      const run = tracker.peek("a1", key);
      const signal = staticFixSignal(input, run);
      if (signal) {
        emitted.push(run);
        expect(signal.weight).toBe(0.5);
        expect(signal.rule).toBe("gps_static");
      }
      tracker.commit("a1", key);
    }
    expect(emitted).toEqual([10, 20]);
    const result = evaluateMismatch(input);
    expect(result.hardIpMismatch || result.hardCarrierMismatch || result.excludeFromSettled).toBe(false);
  });

  it("restarts the run when the position or accuracy changes", () => {
    const tracker = new StaticFixTracker();
    const a = StaticFixTracker.keyFor(40.123456, -105.123456, 12);
    for (let index = 0; index < 9; index += 1) tracker.commit("a1", a);
    expect(tracker.peek("a1", StaticFixTracker.keyFor(40.123456, -105.123456, 13))).toBe(1);
    expect(tracker.peek("a1", StaticFixTracker.keyFor(40.123457, -105.123456, 12))).toBe(1);
    expect(tracker.peek("a1", a)).toBe(10);
  });
});
