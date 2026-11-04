import { describe, expect, it } from "vitest";

import { FIXED_ASNS, HOSTING_ASNS, MOBILE_ASNS, SATELLITE_ASNS, classifyAsn } from "./asnClasses.js";

describe("classifyAsn", () => {
  it("classifies curated ASNs", () => {
    expect(classifyAsn(14593, "SpaceX Services, Inc.")).toBe("satellite");
    expect(classifyAsn(21928, "T-Mobile USA, Inc.")).toBe("mobile");
    expect(classifyAsn(7922, "Comcast Cable Communications, LLC")).toBe("fixed");
    expect(classifyAsn(16509, "Amazon.com, Inc.")).toBe("hosting_vpn");
  });

  it("keeps the curated tables disjoint", () => {
    const seen = new Set<number>();
    for (const table of [SATELLITE_ASNS, MOBILE_ASNS, FIXED_ASNS, HOSTING_ASNS]) {
      for (const asn of table) {
        expect(seen.has(asn)).toBe(false);
        seen.add(asn);
      }
    }
  });

  it("falls back to org-name heuristics for hosting, VPN and satellite", () => {
    expect(classifyAsn(64500, "Example Hosting Ltd")).toBe("hosting_vpn");
    expect(classifyAsn(64501, "Acme Cloud Services")).toBe("hosting_vpn");
    expect(classifyAsn(64502, "Some Data Center GmbH")).toBe("hosting_vpn");
    expect(classifyAsn(64503, "SuperVPN Inc")).toBe("hosting_vpn");
    expect(classifyAsn(64504, "Hughes Network Systems")).toBe("satellite");
    expect(classifyAsn(null, "Starlink Internet")).toBe("satellite");
  });

  it("returns unknown for unlisted ASNs without a hosting-looking name", () => {
    expect(classifyAsn(64510, "Regional Telecom Cooperative")).toBe("unknown");
    expect(classifyAsn(null, null)).toBe("unknown");
    expect(classifyAsn(undefined, "  ")).toBe("unknown");
  });

  it("lets curated mobile ASNs win over a hosting-looking organisation name", () => {
    expect(classifyAsn(21928, "Cloud Mobile Services")).toBe("mobile");
  });
});
