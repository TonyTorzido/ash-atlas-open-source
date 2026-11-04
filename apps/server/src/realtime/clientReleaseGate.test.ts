import { describe, expect, it } from "vitest";

import type { SharedVersionMetadata } from "@ash-atlas/shared";

import {
  CLIENT_RELEASE_LIVE_GRACE_MS,
  clientReleaseIdentityFromQuery,
  createClientReleaseGate
} from "./clientReleaseGate.js";

const published = (web: string, ios: string | null = null): SharedVersionMetadata => ({
  clients: {
    web: { clientSha: web, minProtocol: 1 },
    ios: ios ? { clientSha: ios, minProtocol: 1 } : null,
    android: null
  },
  serverVersion: "d".repeat(40),
  protocolMin: 1,
  protocolMax: 1,
  publicVersion: "1.4.2",
  generation: "test/t1297"
});

describe("client release gate", () => {
  it("admits only the published build for the client's platform", async () => {
    let now = 1_000_000;
    const gate = createClientReleaseGate(async () => published("a".repeat(64), "b".repeat(64)), () => now);
    // Past the grace that lets reconnecting players finish an update.
    await gate.admitsConnection(clientReleaseIdentityFromQuery({ aaClientPlatform: "web" }));
    await gate.admitsConnection(clientReleaseIdentityFromQuery({ aaClientPlatform: "ios" }));
    now += CLIENT_RELEASE_LIVE_GRACE_MS;
    expect(await gate.admitsConnection(clientReleaseIdentityFromQuery({
      aaClientPlatform: "web", aaClientSha: "a".repeat(64)
    }))).toBe(true);
    expect(await gate.admitsConnection(clientReleaseIdentityFromQuery({
      aaClientPlatform: "ios", aaClientSha: "b".repeat(64)
    }))).toBe(true);
    expect(await gate.admitsConnection(clientReleaseIdentityFromQuery({
      aaClientPlatform: "ios", aaClientSha: "a".repeat(64)
    }))).toBe(false);
    // Clients from before this gate send no identity and must update.
    expect(await gate.admitsConnection(clientReleaseIdentityFromQuery({}))).toBe(false);
    // A platform without a published build is not gated.
    expect(await gate.admitsConnection(clientReleaseIdentityFromQuery({
      aaClientPlatform: "android", aaClientSha: "c".repeat(64)
    }))).toBe(true);
  });

  it("lets a reconnecting identified build finish its update within the grace period", async () => {
    let now = 1_000_000;
    const gate = createClientReleaseGate(async () => published("e".repeat(64)), () => now);
    const oldClient = clientReleaseIdentityFromQuery({ aaClientSha: "a".repeat(64) });
    // The deploy restarted the server: the first reconnect starts the grace.
    expect(await gate.admitsConnection(oldClient)).toBe(true);
    now += CLIENT_RELEASE_LIVE_GRACE_MS - 1;
    expect(await gate.admitsConnection(oldClient)).toBe(true);
    // Clients from before the gate send no identity and never get the grace.
    expect(await gate.admitsConnection(clientReleaseIdentityFromQuery({}))).toBe(false);
    now += 1;
    expect(await gate.admitsConnection(oldClient)).toBe(false);
    expect(await gate.admitsConnection(
      clientReleaseIdentityFromQuery({ aaClientSha: "e".repeat(64) })
    )).toBe(true);
  });

  it("admits everyone when no release is published", async () => {
    const gate = createClientReleaseGate(async () => null);
    expect(await gate.admitsConnection(clientReleaseIdentityFromQuery({}))).toBe(true);
  });

  it("keeps a connected outdated client only through the grace period after a new release", async () => {
    let now = 1_000_000;
    let current = published("a".repeat(64));
    const gate = createClientReleaseGate(async () => current, () => now);
    const oldClient = clientReleaseIdentityFromQuery({ aaClientSha: "a".repeat(64) });
    expect(await gate.admitsLiveConnection(oldClient)).toBe(true);

    current = published("e".repeat(64));
    now += 11_000;
    expect(await gate.admitsLiveConnection(oldClient)).toBe(true);
    now += CLIENT_RELEASE_LIVE_GRACE_MS - 1;
    expect(await gate.admitsLiveConnection(oldClient)).toBe(true);
    now += 1;
    expect(await gate.admitsLiveConnection(oldClient)).toBe(false);
    expect(await gate.admitsLiveConnection(
      clientReleaseIdentityFromQuery({ aaClientSha: "e".repeat(64) })
    )).toBe(true);
  });
});
