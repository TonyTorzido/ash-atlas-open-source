// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import {
  SAPLING_LIST_RESYNC_MOVE_M,
  SAPLING_SLOW_RESYNC_MS,
  type LatLon,
  type SaplingMapItem,
  type SaplingWorldSnapshot
} from "@ash-atlas/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PetClient } from "../../client/domains/petClient.js";
import { useSaplingFeature, type SaplingServerMessage } from "./useSaplingFeature.js";

const ORIGIN: LatLon = { lat: 35, lon: -106 };
const north = (meters: number): LatLon => ({ lat: ORIGIN.lat + meters / 111_195, lon: ORIGIN.lon });
const item = (id: string, position: LatLon, overrides: Partial<SaplingMapItem> = {}): SaplingMapItem => ({
  id, lat: position.lat, lon: position.lon, state: "sapling", growth: 3, phase: "healthy", berryAvailable: false, ...overrides
});

function fakeCommands() {
  let counter = 0;
  const calls: string[] = [];
  const commands = {
    requestSaplings: vi.fn(() => { calls.push("list"); return `list-${counter += 1}`; }),
    requestSaplingDetail: vi.fn((id: string) => { calls.push(`detail:${id}`); return `detail-${counter += 1}`; }),
    plantSapling: vi.fn(() => `plant-${counter += 1}`),
    tendSapling: vi.fn(() => `tend-${counter += 1}`),
    pullSapling: vi.fn(() => `pull-${counter += 1}`),
    gatherSaplingBerry: vi.fn(() => `gather-${counter += 1}`)
  };
  return { commands, calls, asClient: commands as unknown as PetClient };
}

function setup(initial: { online: boolean; position: LatLon | null }) {
  const fake = fakeCommands();
  const getCommands = (): PetClient => fake.asClient;
  const onNotice = vi.fn();
  const onError = vi.fn();
  const hook = renderHook((props: { online: boolean; position: LatLon | null }) =>
    useSaplingFeature({ getCommands, ...props, onNotice, onError }), { initialProps: initial });
  const send = (message: SaplingServerMessage): void => { act(() => hook.result.current.handleServerMessage(message)); };
  return { ...fake, hook, send };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("useSaplingFeature", () => {
  it("asks for the full list once on connect, never polls, and only resyncs slowly", () => {
    const t = setup({ online: true, position: ORIGIN });
    expect(t.calls).toEqual(["list"]);
    t.send({ type: "SAPLINGS_STATE", requestId: "list-1", saplings: [item("a", ORIGIN)], serverNowMs: 0 });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(t.calls).toEqual(["list"]);
    act(() => { vi.advanceTimersByTime(SAPLING_SLOW_RESYNC_MS); });
    expect(t.calls).toEqual(["list", "list"]);
  });

  it("re-lists after a reconnect, and drops the stale view while offline", () => {
    const t = setup({ online: true, position: ORIGIN });
    t.send({ type: "SAPLINGS_STATE", requestId: "list-1", saplings: [item("a", ORIGIN)], serverNowMs: 0 });
    expect(t.hook.result.current.renderItems).toHaveLength(1);
    t.hook.rerender({ online: false, position: ORIGIN });
    expect(t.hook.result.current.renderItems).toHaveLength(0);
    t.hook.rerender({ online: true, position: ORIGIN });
    expect(t.calls).toEqual(["list", "list"]);
  });

  it("re-lists only after moving far from where the last list was taken", () => {
    const t = setup({ online: true, position: ORIGIN });
    t.send({ type: "SAPLINGS_STATE", requestId: "list-1", saplings: [], serverNowMs: 0 });
    t.hook.rerender({ online: true, position: north(SAPLING_LIST_RESYNC_MOVE_M - 20) });
    expect(t.calls).toEqual(["list"]);
    t.hook.rerender({ online: true, position: north(SAPLING_LIST_RESYNC_MOVE_M + 20) });
    expect(t.calls).toEqual(["list", "list"]);
  });

  it("applies pushed deltas: upserts add and update one tree, removals drop it", () => {
    const t = setup({ online: true, position: ORIGIN });
    t.send({ type: "SAPLINGS_STATE", requestId: "list-1", saplings: [item("a", ORIGIN), item("b", north(10))], serverNowMs: 0 });
    t.send({ type: "SAPLING_DELTA", upserts: [item("a", ORIGIN, { phase: "needs_tending" }), item("c", north(30))], removed: ["b"], serverNowMs: 0 });
    const ids = t.hook.result.current.renderItems.map((entry) => [entry.id, entry.phase]);
    expect(ids).toEqual([["a", "needs_tending"], ["c", "healthy"]]);
    expect(t.calls).toEqual(["list"]);
  });

  it("serves the tap from one detail request and closes it when the tree is removed", () => {
    const t = setup({ online: true, position: ORIGIN });
    t.send({ type: "SAPLINGS_STATE", requestId: "list-1", saplings: [item("a", ORIGIN)], serverNowMs: 0 });
    act(() => t.hook.result.current.loadDetail("a"));
    expect(t.calls).toEqual(["list", "detail:a"]);
    expect(t.hook.result.current.detailState).toBe("loading");
    const sapling: SaplingWorldSnapshot = {
      saplingId: "a", stateRevision: 0, ownerPlayerId: "p1", ownerUsername: "Planter", lat: ORIGIN.lat, lon: ORIGIN.lon,
      state: "sapling", plantedAt: new Date(0).toISOString(), lastTendedAt: new Date(0).toISOString(),
      tendReadyAt: new Date(86_400_000).toISOString(), diesAt: new Date(172_800_000).toISOString(),
      maturesAt: new Date(432_000_000).toISOString(), fastGrowth: false, berryReadyAt: null, berryAvailable: false
    };
    t.send({ type: "SAPLING_DETAIL", requestId: "detail-2", saplingId: "a", sapling, serverNowMs: 3_600_000 });
    expect(t.hook.result.current.detailState).toBe("ready");
    expect(t.hook.result.current.selected).toMatchObject({ inRange: true, phase: "healthy" });
    t.send({ type: "SAPLING_DELTA", upserts: [], removed: ["a"], serverNowMs: 0 });
    expect(t.hook.result.current.detailState).toBe("gone");
    expect(t.hook.result.current.selected).toBeNull();
  });

  it("exposes grown trees as choppable nodes", () => {
    const t = setup({ online: true, position: ORIGIN });
    t.send({ type: "SAPLINGS_STATE", requestId: "list-1", saplings: [item("a", ORIGIN, { state: "grown", growth: 10, berryAvailable: true })], serverNowMs: 0 });
    expect(t.hook.result.current.grownCollectibles).toMatchObject([{ id: "sapling:a", type: "wood", treeLifeRevision: 0 }]);
  });
});
