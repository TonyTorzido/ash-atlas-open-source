// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FlagAccessSnapshot, FlagSnapshot, PlayerSnapshot } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FlagAccessControls } from "./FlagAccessControls.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FlagAccessControls", () => {
  it("renders the resolved owner action without a checking state", () => {
    const onVisitFlag = vi.fn();
    renderControls({
      playerId: "owner",
      onVisitFlag,
      access: snapshot({
        ownerPlayerId: "owner",
        decision: {
          allowed: true,
          requestable: false,
          reasonCode: "ALLOWED_OWNER",
          tollGold: "0"
        }
      })
    });
    expect(screen.queryByText(/checking access/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Travel" }));
    expect(onVisitFlag).toHaveBeenCalledWith(flag().id, "0");
  });

  it("never forwards the cached access trace as a desktop travel operation ID", () => {
    const onVisitFlag = vi.fn(() => true);
    const allowedAccess = snapshot({
      ownerPlayerId: "owner",
      decision: {
        allowed: true,
        requestable: false,
        reasonCode: "ALLOWED_OWNER",
        tollGold: "0"
      }
    });
    const view = renderControls({
      playerId: "owner",
      onVisitFlag,
      travelPending: false,
      access: allowedAccess
    });
    fireEvent.click(screen.getByRole("button", { name: "Travel" }));
    view.rerender(<FlagAccessControls
      flag={flag()}
      player={player("owner")}
      walletGold="100"
      serverHttpBase="https://game.example"
      csrfToken="csrf"
      access={allowedAccess}
      aggressiveRemainingMs={0}
      travelPending={false}
      onVisitFlag={onVisitFlag}
      onAccessChange={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Travel" }));
    expect(onVisitFlag.mock.calls).toEqual([
      [flag().id, "0"],
      [flag().id, "0"]
    ]);
  });

  it("renders exactly Public, Normal, and Private for an owner", () => {
    renderControls({ playerId: "owner", access: snapshot({
      ownerPlayerId: "owner",
      mode: "normal",
      jumpTollGold: "4",
      decision: {
        allowed: true,
        requestable: false,
        reasonCode: "ALLOWED_OWNER",
        tollGold: "0"
      },
      management: { pendingRequests: [] }
    }) });
    expect(screen.getByRole("button", { name: /Public/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Normal/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Private/ })).toBeTruthy();
    expect(screen.queryByText(/Custom/i)).toBeNull();
  });

  it("saves the selected mode without a generic success toast", async () => {
    const onAccessChange = vi.fn();
    const onAccessSaved = vi.fn();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({
          mode: "public",
          jumpTollGold: "4"
        });
        return response({ access: snapshot({
          ownerPlayerId: "owner",
          mode: "public",
          jumpTollGold: "4",
          decision: {
            allowed: true,
            requestable: false,
            reasonCode: "ALLOWED_OWNER",
            tollGold: "0"
          },
          management: { pendingRequests: [] }
        }) });
      }
      return response({ access: snapshot({
        ownerPlayerId: "owner",
        mode: "normal",
        jumpTollGold: "4",
        decision: {
          allowed: true,
          requestable: false,
          reasonCode: "ALLOWED_OWNER",
          tollGold: "0"
        },
        management: { pendingRequests: [] }
      }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderControls({ playerId: "owner", onAccessChange, onAccessSaved, access: snapshot({
      ownerPlayerId: "owner",
      mode: "normal",
      jumpTollGold: "4",
      decision: {
        allowed: true,
        requestable: false,
        reasonCode: "ALLOWED_OWNER",
        tollGold: "0"
      },
      management: { pendingRequests: [] }
    }) });
    fireEvent.click(screen.getByRole("button", { name: /Public/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save Access" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onAccessSaved).toHaveBeenCalledTimes(1));
    expect(onAccessChange).not.toHaveBeenCalled();
    expect(screen.queryByText(/settings saved/i)).toBeNull();
  });

  it("does not publish a presentation update when the access save fails", async () => {
    const onAccessSaved = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { message: "Save rejected." }
    }), {
      status: 500,
      headers: { "content-type": "application/json" }
    })));
    renderControls({
      playerId: "owner",
      onAccessSaved,
      access: snapshot({ ownerPlayerId: "owner", mode: "normal", jumpTollGold: "4" })
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Access" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Save rejected.");
    expect(onAccessSaved).not.toHaveBeenCalled();
  });

  it("offers an idempotent Normal passage request and then shows Pending", async () => {
    const onAccessChange = vi.fn();
    const onAccessSaved = vi.fn();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? response({ request: { id: "request-1" } })
        : response({ access: snapshot({
            mode: "normal",
            decision: {
              allowed: false,
              requestable: true,
              reasonCode: "NORMAL_PASSAGE_REQUIRED",
              tollGold: "0"
            }
          }) }));
    vi.stubGlobal("fetch", fetchMock);
    renderControls({ onAccessChange, onAccessSaved, access: snapshot({
      mode: "normal",
      decision: {
        allowed: false,
        requestable: true,
        reasonCode: "NORMAL_PASSAGE_REQUIRED",
        tollGold: "0"
      }
    }) });
    fireEvent.click(screen.getByRole("button", { name: "Request Access" }));
    expect(await screen.findByRole("button", { name: "Request Pending" })).toBeTruthy();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: expect.objectContaining({ "x-csrf-token": "csrf" })
    });
    expect(onAccessChange).toHaveBeenCalledTimes(1);
    expect(onAccessSaved).not.toHaveBeenCalled();
  });

  it("keeps owner settings hidden in compact mode", () => {
    renderControls({ compact: true, playerId: "owner", access: snapshot({
      ownerPlayerId: "owner",
      mode: "private",
      decision: {
        allowed: true,
        requestable: false,
        reasonCode: "ALLOWED_OWNER",
        tollGold: "0"
      },
      management: { pendingRequests: [] }
    }) });
    expect(screen.getByRole("button", { name: "Travel" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Access" })).toBeNull();
  });
});

function renderControls(options: {
  compact?: boolean;
  playerId?: string;
  onVisitFlag?: ReturnType<typeof vi.fn>;
  onAccessChange?: ReturnType<typeof vi.fn>;
  onAccessSaved?: ReturnType<typeof vi.fn>;
  access?: FlagAccessSnapshot;
  travelPending?: boolean;
} = {}): ReturnType<typeof render> {
  return render(<FlagAccessControls
    flag={flag()}
    player={player(options.playerId)}
    walletGold="100"
    serverHttpBase="https://game.example"
    csrfToken="csrf"
    access={options.access ?? snapshot({})}
    aggressiveRemainingMs={0}
    travelPending={options.travelPending ?? false}
    {...(options.compact === undefined ? {} : { compact: options.compact })}
    onVisitFlag={options.onVisitFlag ?? vi.fn(() => true)}
    onAccessChange={options.onAccessChange ?? vi.fn()}
    {...(options.onAccessSaved ? { onAccessSaved: options.onAccessSaved } : {})}
  />);
}

function snapshot(changes: Partial<FlagAccessSnapshot>): FlagAccessSnapshot {
  return {
    flagId: flag().id,
    ownerPlayerId: "owner",
    mode: "private",
    jumpTollGold: "0",
    accessRevision: "0",
    requestPending: false,
    decision: {
      allowed: false,
      requestable: false,
      reasonCode: "PRIVATE_OWNER_ONLY",
      tollGold: "0"
    },
    management: null,
    ...changes
  };
}

function flag(): FlagSnapshot {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    controlType: "personal",
    ownerId: "owner",
    name: "Passage Flag",
    lat: 35,
    lon: -106,
    packageId: null,
    elevationM: null,
    terrainClass: null,
    biome: null,
    ecoregion: null,
    claimRadiusM: 500,
    cityId: null,
    createdAt: "2026-07-20T00:00:00.000Z"
  };
}

function player(playerId = "traveler"): PlayerSnapshot {
  return {
    playerId,
    username: playerId,
    displayColor: null,
    regionCode: "NM",
    zoneId: "zone",
    lat: 35,
    lon: -106,
    anchorLat: 35,
    anchorLon: -106,
    moveLeashRadiusM: 500,
    movementRevision: 0,
    targetLat: null,
    targetLon: null,
    moving: false,
    currentFlagId: null,
    online: true,
    updatedAt: "2026-07-20T00:00:00.000Z"
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
