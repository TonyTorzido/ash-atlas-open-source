import { describe, expect, it } from "vitest";

import {
  ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_CODE,
  ASH_ATLAS_PROTOCOL_QUERY_KEYS,
  addAshAtlasProtocolQuery,
  createAshAtlasProtocolSupportMetadata,
  negotiateAshAtlasProtocol,
  protocolSupportMetadataFromQuery
} from "./protocolCompatibility.js";

describe("Ash Atlas protocol compatibility", () => {
  it("preserves the metadata-free legacy boundary", () => {
    expect(negotiateAshAtlasProtocol()).toMatchObject({
      status: "compatible-legacy",
      protocol: { version: 1, capabilities: [] }
    });
  });

  it("negotiates current metadata and intersects additive capabilities", () => {
    expect(negotiateAshAtlasProtocol({
      ...createAshAtlasProtocolSupportMetadata(),
      capabilities: ["welcome-protocol-metadata", "future-capability"]
    })).toEqual({
      status: "compatible-current",
      protocol: {
        protocolId: "ash-atlas",
        minVersion: 3,
        maxVersion: 3,
        version: 3,
        capabilities: ["welcome-protocol-metadata"]
      }
    });
  });

  it("classifies old, future, and invalid metadata without guessing", () => {
    expect(negotiateAshAtlasProtocol({
      protocolId: "ash-atlas",
      minVersion: 1,
      maxVersion: 1,
      capabilities: []
    })).toEqual({ status: "incompatible-peer-too-old", reason: "protocol-range" });
    expect(negotiateAshAtlasProtocol({
      protocolId: "ash-atlas",
      minVersion: 4,
      maxVersion: 4,
      capabilities: []
    })).toEqual({ status: "incompatible-peer-too-new", reason: "protocol-range" });
    expect(negotiateAshAtlasProtocol({
      protocolId: "ash-atlas",
      minVersion: 3,
      maxVersion: 3,
      version: 4,
      capabilities: []
    })).toEqual({ status: "invalid-metadata", reason: "metadata-shape" });
    expect(negotiateAshAtlasProtocol({
      protocolId: "another-game",
      minVersion: 1,
      maxVersion: 1,
      capabilities: []
    })).toEqual({ status: "invalid-metadata", reason: "protocol-id" });
  });

  it("round-trips bounded legacy-safe query metadata", () => {
    const searchParams = new URLSearchParams();
    addAshAtlasProtocolQuery(searchParams);
    const query = Object.fromEntries(searchParams.entries());
    expect(protocolSupportMetadataFromQuery(query)).toEqual(
      createAshAtlasProtocolSupportMetadata()
    );
    expect(searchParams.get(ASH_ATLAS_PROTOCOL_QUERY_KEYS.id)).toBe("ash-atlas");
  });

  it("uses one valid private incompatibility close code", () => {
    expect(ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_CODE).toBeGreaterThanOrEqual(4000);
    expect(ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_CODE).toBeLessThanOrEqual(4999);
  });
});
