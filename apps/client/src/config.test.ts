import { describe, expect, it } from "vitest";

import { clientConfig, sameOriginServiceBases } from "./config.js";

describe("same-origin development networking", () => {
  it("derives HTTP and WebSocket endpoints from an IPv4 LAN page origin", () => {
    expect(sameOriginServiceBases({ origin: "http://192.168.1.10:5300" })).toEqual({
      http: "http://192.168.1.10:5300",
      websocket: "ws://192.168.1.10:5300"
    });
  });

  it("uses secure WebSockets when the page is served over HTTPS", () => {
    expect(sameOriginServiceBases({ origin: "https://game.example" }).websocket).toBe(
      "wss://game.example"
    );
  });

  it("keeps population frame batching disabled by default", () => {
    expect(clientConfig.populationFrameBatchingEnabled).toBe(false);
  });
});
