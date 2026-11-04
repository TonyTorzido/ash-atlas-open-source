import { describe, expect, it } from "vitest";

import { ASH_ATLAS_MAX_PROTOCOL_VERSION, ASH_ATLAS_MIN_PROTOCOL_VERSION } from "./version.js";
import { parseServerMessage } from "./protocol.js";

describe("wallet bootstrap protocol", () => {
  it("accepts the authoritative wallet snapshot on WELCOME", () => {
    const message = parseServerMessage(JSON.stringify({
      type: "WELCOME",
      playerId: "player-1",
      username: "Scout",
      spawn: { lat: 35, lon: -106 },
      anchor: { lat: 35, lon: -106 },
      moveLeashRadiusM: 100,
      flagClaimRadiusM: 100,
      playerSpeedMps: 4,
      serverTickHz: 20,
      regionCode: "US-NM",
      zoneId: "zone-1",
      developerCapabilities: [],
      wallet: {
        playerId: "player-1",
        gold: "321",
        revision: "7"
      },
      serverTime: 1
    }));

    expect(message).toMatchObject({
      type: "WELCOME",
      wallet: {
        playerId: "player-1",
        gold: "321",
        revision: "7"
      }
    });
  });

  it("accepts both epoch-aware and legacy WELCOME frames", () => {
    const welcome = {
      type: "WELCOME",
      playerId: "player-1",
      username: "Scout",
      spawn: { lat: 35, lon: -106 },
      anchor: { lat: 35, lon: -106 },
      moveLeashRadiusM: 100,
      flagClaimRadiusM: 100,
      playerSpeedMps: 4,
      serverTickHz: 20,
      regionCode: "US-NM",
      zoneId: "zone-1",
      developerCapabilities: [],
      serverTime: 1
    };

    expect(parseServerMessage(JSON.stringify(welcome))).not.toHaveProperty(
      "worldAuthorityEpoch"
    );
    expect(parseServerMessage(JSON.stringify({
      ...welcome,
      worldAuthorityEpoch: "00000000-0000-4000-8000-000000900018"
    }))).toMatchObject({
      worldAuthorityEpoch: "00000000-0000-4000-8000-000000900018"
    });
    expect(parseServerMessage(JSON.stringify({
      ...welcome,
      releaseSha: "a".repeat(40)
    }))).toMatchObject({ releaseSha: "a".repeat(40) });
    expect(() => parseServerMessage(JSON.stringify({
      ...welcome,
      releaseSha: "malformed"
    }))).toThrow();
  });

  it("accepts optional release version metadata while older WELCOME frames remain valid", () => {
    const welcome = {
      type: "WELCOME",
      playerId: "player-1",
      username: "Scout",
      spawn: { lat: 35, lon: -106 },
      anchor: { lat: 35, lon: -106 },
      moveLeashRadiusM: 100,
      flagClaimRadiusM: 100,
      playerSpeedMps: 4,
      serverTickHz: 20,
      regionCode: "US-NM",
      zoneId: "zone-1",
      developerCapabilities: [],
      serverTime: 1
    };
    expect(parseServerMessage(JSON.stringify(welcome))).toMatchObject({ type: "WELCOME" });
    expect(parseServerMessage(JSON.stringify({
      ...welcome,
      clients: {
        web: { clientSha: "a".repeat(64), minProtocol: ASH_ATLAS_MIN_PROTOCOL_VERSION },
        ios: null,
        android: null
      },
      serverVersion: "b".repeat(40),
      protocolMin: ASH_ATLAS_MIN_PROTOCOL_VERSION,
      protocolMax: ASH_ATLAS_MAX_PROTOCOL_VERSION,
      publicVersion: "1.4.2",
      generation: "test/t10000"
    }))).toMatchObject({
      type: "WELCOME",
      clients: { web: { clientSha: "a".repeat(64) }, ios: null, android: null },
      serverVersion: "b".repeat(40),
      protocolMin: ASH_ATLAS_MIN_PROTOCOL_VERSION,
      protocolMax: ASH_ATLAS_MAX_PROTOCOL_VERSION,
      publicVersion: "1.4.2",
      generation: "test/t10000"
    });
  });
});
