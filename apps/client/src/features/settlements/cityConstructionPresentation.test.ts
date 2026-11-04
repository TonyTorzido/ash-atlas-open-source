import type { CityStructureSnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  cityStructureDisplayName,
  cityStructureWorldLabelParts
} from "./cityConstructionPresentation.js";

describe("city structure presentation", () => {
  it("uses title-cased canonical names and preserves monument district naming", () => {
    expect(cityStructureDisplayName(structure("city_kennel"))).toBe("City Kennel");
    expect(cityStructureDisplayName(structure("oil_well"))).toBe("Oil Well");
    expect(cityStructureDisplayName({
      ...structure("monument"),
      districtType: "forestry"
    })).toBe("Forestry Monument");
  });

  it("splits personal ownership and monument tier into canonical secondary lines", () => {
    expect(cityStructureWorldLabelParts({
      ...structure("city_house"),
      ownerUsername: "Ash"
    })).toEqual({ primary: "City House", secondary: "Ash’s" });
    expect(cityStructureWorldLabelParts({
      ...structure("mayor_house"),
      ownerUsername: null
    })).toEqual({ primary: "Mayor House", secondary: "Unknown Player’s" });
    expect(cityStructureWorldLabelParts({
      ...structure("oil_well"),
      ownerUsername: "Wren"
    })).toEqual({ primary: "Oil Well", secondary: "Wren’s" });
    expect(cityStructureWorldLabelParts({
      ...structure("monument"),
      districtType: "hunting",
      tier: 3
    })).toEqual({ primary: "Hunting Monument", secondary: "Tier 3" });
  });

  it("keeps other current structures to one canonical title-cased line", () => {
    expect(cityStructureWorldLabelParts(structure("city_kennel")))
      .toEqual({ primary: "City Kennel", secondary: null });
    expect(cityStructureWorldLabelParts(structure("market")))
      .toEqual({ primary: "City Market", secondary: null });
  });
});

function structure(type: CityStructureSnapshot["type"]): CityStructureSnapshot {
  return {
    type,
    districtType: null
  } as CityStructureSnapshot;
}
