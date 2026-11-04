// @vitest-environment jsdom

import type { FlagSnapshot } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AtlasShrineControls } from "./AtlasShrineControls.js";

describe("AtlasShrineControls", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows requirements and permanently unlocks exactly the next slot", async () => {
    const onMutation = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ progression: progression() }))
      .mockResolvedValueOnce(jsonResponse({
        progression: progression({ unlockedSlots: 1, nextSlot: 2 }),
        inventory: inventory(0),
        replayed: false
      }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AtlasShrineControls
      serverHttpBase="http://game.test"
      csrfToken="csrf"
      onMutation={onMutation}
    />);
    expect(await screen.findByText(/Atlas Shrines unlocked: 0 \/ 25/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unlock Slot 1" }));
    const prompt = screen.getByText("Permanently unlock Atlas Shrine slot 1?").closest("aside")!;
    expect(fetchMock).toHaveBeenCalledOnce();
    fireEvent.click(within(prompt).getByRole("button", { name: "Unlock Slot 1" }));
    await waitFor(() => expect(onMutation).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      credentials: "include"
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/atlas-shrines/unlock");
  });

  it("keeps a requirement-locked unlock disabled without a wait cursor", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      progression: progression({
        nextSlot: 2,
        requiredLevel: 2,
        playerLevel: 1,
        requiredShards: 2,
        currentShards: 0,
        levelRequirementMet: false,
        shardRequirementMet: false
      })
    })));
    render(<AtlasShrineControls serverHttpBase="http://game.test" csrfToken="csrf" />);

    const locked = await screen.findByRole("button", { name: "Unlock Slot 2" });
    expect((locked as HTMLButtonElement).disabled).toBe(true);
    const css = readFileSync(join(process.cwd(), "src", "ashAtlasTheme.css"), "utf8");
    expect(css).toMatch(
      /\.atlas-shrine-controls button:disabled\s*\{\s*cursor:\s*not-allowed;\s*\}/
    );
    expect(css).not.toMatch(
      /\.atlas-shrine-controls[^{]*\{[^}]*cursor:\s*(?:wait|progress)/s
    );
  });

  it("labels only an active unlock request as Unlocking", async () => {
    let finishUnlock!: (response: Response) => void;
    const pendingUnlock = new Promise<Response>((resolve) => {
      finishUnlock = resolve;
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ progression: progression() }))
      .mockReturnValueOnce(pendingUnlock));
    render(<AtlasShrineControls serverHttpBase="http://game.test" csrfToken="csrf" />);

    fireEvent.click(await screen.findByRole("button", { name: "Unlock Slot 1" }));
    fireEvent.click(within(
      screen.getByText("Permanently unlock Atlas Shrine slot 1?").closest("aside")!
    ).getByRole("button", { name: "Unlock Slot 1" }));
    expect(await screen.findByRole("button", { name: "Unlocking…" })).toBeTruthy();
    finishUnlock(jsonResponse({
      progression: progression({ unlockedSlots: 1, nextSlot: 2 }),
      inventory: inventory(0),
      replayed: false
    }));
    await waitFor(() => expect(
      screen.getByRole("button", { name: "Unlock Slot 2" })
    ).toBeTruthy());
  });

  it("offers the correct stone and shrine upgrades without spending shards in the request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ progression: progression() }))
      .mockResolvedValueOnce(jsonResponse({
        progression: progression(),
        inventory: inventory(1),
        replayed: false,
        flag: flag("stone")
      }))
      .mockResolvedValueOnce(jsonResponse({ progression: progression() }))
      .mockResolvedValueOnce(jsonResponse({
        progression: progression({ builtShrines: 1, availableCapacity: 0 }),
        inventory: inventory(1),
        replayed: false,
        flag: flag("atlas_shrine")
      }));
    vi.stubGlobal("fetch", fetchMock);
    const onHarden = vi.fn(() => true);
    const view = render(<AtlasShrineControls
      serverHttpBase="http://game.test"
      csrfToken="csrf"
      flag={flag("base")}
      canUpgrade
      onHarden={onHarden}
    />);
    fireEvent.click(await screen.findByRole("button", { name: "Build Stone Flag · 5 Stone" }));
    expect(onHarden).toHaveBeenCalledWith(flag("base").id);

    view.rerender(<AtlasShrineControls
      serverHttpBase="http://game.test"
      csrfToken="csrf"
      flag={flag("stone")}
      canUpgrade
    />);
    fireEvent.click(await screen.findByRole("button", { name: "Build Atlas Shrine · 12 Wood + 8 Stone" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const body = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(body).toMatchObject({ targetTier: "atlas_shrine" });
    expect(body).not.toHaveProperty("shards");
  });

  it("explains that a stone city flag cannot become a shrine", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse({ progression: progression() })
    ));
    render(<AtlasShrineControls
      serverHttpBase="http://game.test"
      csrfToken="csrf"
      flag={{ ...flag("stone"), controlType: "city", cityId: "city-a" }}
      canUpgrade
    />);
    expect(await screen.findByText(/City and Kingdom Flags remain stone flags/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Build Atlas Shrine/ })).toBeNull();
  });
});

function progression(overrides: Record<string, unknown> = {}) {
  return {
    unlockedSlots: 0,
    builtShrines: 0,
    availableCapacity: 1,
    nextSlot: 1,
    requiredLevel: 1,
    playerLevel: 1,
    requiredShards: 1,
    currentShards: 1,
    levelRequirementMet: true,
    shardRequirementMet: true,
    ...overrides
  };
}

function inventory(shards: number) {
  return {
    playerId: "owner",
    items: [],
    totals: {
      wood: 0,
      stone: 10,
      food: 0,
      ore: 0,
      water: 0,
      leather: 0,
      giving_berry: 0,
      balsam_resin: 0,
      atlas_shrine_shard: shards
    }
  };
}

function flag(upgradeTier: "base" | "stone" | "atlas_shrine"): FlagSnapshot {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    controlType: "personal",
    ownerId: "owner",
    ownerUsername: "Ash",
    name: "North Flag",
    lat: 35,
    lon: -106,
    packageId: null,
    elevationM: null,
    terrainClass: null,
    biome: null,
    ecoregion: null,
    claimRadiusM: 1000,
    resourceVisionRadiusM: 1250,
    accessMode: "private",
    jumpTollGold: "0",
    reinforcementLevel: upgradeTier === "base" ? 0 : upgradeTier === "stone" ? 1 : 2,
    upgradeTier,
    cityId: null,
    createdAt: "2026-07-26T00:00:00.000Z"
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}
