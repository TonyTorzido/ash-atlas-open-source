// @vitest-environment jsdom

import type {
  CityMembershipSnapshot,
  FlagAccessSnapshot,
  FlagSnapshot,
  KingdomStateSnapshot,
  PlayerSnapshot
} from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileFlagActionSheet, mobileFlagActionLabel } from "./MobileFlagActionSheet.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mobile flag quick actions", () => {
  it("shows the authoritative toll in the compact Visit action", () => {
    expect(mobileFlagActionLabel(access({
      allowed: true,
      requestable: false,
      tollGold: "5"
    }), false, 0)).toBe("Travel \u00b7 5 Gold");
  });

  it("offers request access or a concise blocked state", () => {
    expect(mobileFlagActionLabel(access({
      allowed: false,
      requestable: true,
      reasonCode: "NORMAL_PASSAGE_REQUIRED"
    }), false, 0)).toBe("Request Access");
    expect(mobileFlagActionLabel(access({
      allowed: false,
      requestable: false,
      reasonCode: "PRIVATE_OWNER_ONLY"
    }, "private"), false, 0)).toBe("Private Flag");
  });

  it("offers Visit for a Kingdom Flag instead of applying personal-flag access denial", () => {
    const flag = {
      ...personalFlag(),
      controlType: "kingdom" as const,
      kingdomId: "kingdom-1",
      kingdomName: "Mesa Wardens"
    };
    const onVisit = vi.fn(() => true);
    render(createElement(MobileFlagActionSheet, {
      ...baseProps(),
      flag,
      access: access({
        allowed: false,
        requestable: false,
        reasonCode: "FLAG_TYPE_UNSUPPORTED"
      }, "private"),
      onVisit
    }));

    expect(screen.queryByRole("button", { name: "Private Flag" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Travel" }));

    expect(onVisit).toHaveBeenCalledWith(flag.id, undefined);
  });

  it("keeps the burn action available while passage access is unresolved", () => {
    const onBurn = vi.fn(() => true);
    const props = {
      ...baseProps(),
      flag: { ...personalFlag(), health: 40 },
      access: null,
      player: { ...player(), playerId: "burner-1" },
      onBurn
    };
    const view = render(createElement(MobileFlagActionSheet, props));
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    view.rerender(createElement(MobileFlagActionSheet, { ...props, managementOpen: true }));
    expect(screen.getByRole("button", { name: "Burn Flag · 1 Torch" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Burn Flag · 1 Torch" }));
    expect(onBurn).toHaveBeenCalledWith(personalFlag().id);
    expect(onBurn).toHaveBeenCalledTimes(1);
    expect(props.onReturnToGame).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Burn Flag" })).toBeNull();
  });

  it("keeps the sheet open after a failed send and never forwards the access trace", () => {
    const onVisit = vi.fn(() => false);
    const onClose = vi.fn();
    render(createElement(MobileFlagActionSheet, {
      ...baseProps(),
      onVisit,
      onClose
    }));

    fireEvent.click(screen.getByRole("button", { name: "Travel" }));

    expect(onVisit).toHaveBeenCalledWith(personalFlag().id, "0");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("orders Visit, Harden, and More and routes hardening through realtime", () => {
    const onHarden = vi.fn(() => true);
    const view = render(createElement(MobileFlagActionSheet, { ...baseProps(), onHarden }));

    const actionLabels = screen.getAllByRole("button").map((button) => button.textContent);
    expect(actionLabels.slice(0, 3)).toEqual(["Travel", "Harden", "More"]);
    const harden = screen.getByRole("button", { name: "Harden" });
    fireEvent.click(harden);
    expect(onHarden).toHaveBeenCalledWith(personalFlag().id);
    const hardenedProps = {
      ...baseProps(),
      onHarden,
      flag: { ...personalFlag(), reinforcementLevel: 1, upgradeTier: "stone" as const }
    };
    view.rerender(createElement(MobileFlagActionSheet, hardenedProps));
    expect(screen.queryByRole("button", { name: "Harden" })).toBeNull();
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
    view.rerender(createElement(MobileFlagActionSheet, { ...hardenedProps, managementOpen: true }));
    expect(screen.queryByRole("button", { name: "Upgrade to Atlas Shrine" })).toBeNull();
  });

  it("keeps Tower upgrade out of contextual More", () => {
    const onUpgrade = vi.fn(() => true);
    const view = render(createElement(MobileFlagActionSheet, {
      ...baseProps(), upgradeApproachReachable: false, onUpgrade
    }));
    expect(screen.queryByRole("button", { name: "Harden" })).toBeNull();
    const stoneProps = {
      ...baseProps(), onUpgrade, upgradeApproachReachable: false,
      flag: { ...personalFlag(), reinforcementLevel: 1, upgradeTier: "stone" as const }
    };
    view.rerender(createElement(MobileFlagActionSheet, stoneProps));
    expect(screen.queryByRole("button", { name: "Upgrade to Tower · 25 Stone" })).toBeNull();
    view.rerender(createElement(MobileFlagActionSheet, { ...stoneProps, managementOpen: true }));
    expect(screen.queryByRole("button", { name: "Upgrade to Tower · 25 Stone" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upgrade to Atlas Shrine" })).toBeNull();
  });

  it("orders Visit, Repair, and More and applies the returned Stone Flag snapshot", async () => {
    const repairedFlag = {
      ...personalFlag(),
      reinforcementLevel: 1,
      upgradeTier: "stone" as const,
      burning: false
    };
    const fetchMock = vi.fn(async () => flagJsonResponse({ flag: repairedFlag, replayed: false }));
    vi.stubGlobal("fetch", fetchMock);
    const onFlagSnapshot = vi.fn();
    const props = {
      ...baseProps(),
      flag: { ...repairedFlag, burning: true },
      onFlagSnapshot
    };
    const view = render(createElement(MobileFlagActionSheet, props));

    expect(screen.getAllByRole("button").slice(0, 3).map((button) => button.textContent))
      .toEqual(["Travel", "Repair Flag", "More"]);
    fireEvent.click(screen.getByRole("button", { name: /^Repair Flag$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Repair Flag" }));

    await waitFor(() => expect(onFlagSnapshot).toHaveBeenCalledWith(repairedFlag));
    expect(fetchMock).toHaveBeenCalledWith(
      `https://game.example/api/flags/${repairedFlag.id}/repair`,
      expect.objectContaining({ method: "POST", credentials: "include" })
    );

    view.rerender(createElement(MobileFlagActionSheet, {
      ...props,
      connected: false
    }));
    expect(screen.queryByRole("button", { name: /^Repair Flag$/ })).toBeNull();
    expect(screen.queryByText("Cannot repair a flag while disconnected.")).toBeNull();
    view.rerender(createElement(MobileFlagActionSheet, {
      ...props,
      flag: { ...props.flag, controlType: "kingdom" as const }
    }));
    expect(screen.queryByRole("button", { name: /^Repair Flag$/ })).toBeNull();
    view.rerender(createElement(MobileFlagActionSheet, {
      ...props,
      flag: { ...personalFlag(), reinforcementLevel: 1, upgradeTier: "stone" as const, burning: true }
    }));
    expect(screen.getByRole("button", { name: /^Repair Flag$/ })).toBeTruthy();
    view.rerender(createElement(MobileFlagActionSheet, {
      ...props,
      flag: { ...props.flag, anchorKind: "buoy" }
    }));
    expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
  });

  it("hides hardening while disconnected", () => {
    const view = render(createElement(MobileFlagActionSheet, baseProps()));
    view.rerender(createElement(MobileFlagActionSheet, { ...baseProps(), connected: false }));
    expect(screen.queryByRole("button", { name: "Harden" })).toBeNull();
    expect(screen.queryByText("Cannot harden a flag while disconnected.")).toBeNull();
  });

  it("blocks the mobile Travel action while another travel operation is pending", () => {
    render(createElement(MobileFlagActionSheet, {
      ...baseProps(),
      travelPending: true
    }));
    const jump = screen.getByRole("button", { name: "Traveling..." });
    expect((jump as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Travel is already in progress.")).toBeNull();
  });

  it("requires confirmation before destroying an owned flag from More", () => {
    const onDestroy = vi.fn();
    const props = { ...baseProps(), managementOpen: true, onDestroy };
    render(createElement(MobileFlagActionSheet, props));

    fireEvent.click(screen.getByRole("button", { name: "Destroy Flag" }));

    expect(onDestroy).not.toHaveBeenCalled();
    expect(screen.getByText("Destroy this flag?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDestroy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Destroy Flag" }));
    fireEvent.click(screen.getByRole("button", { name: "Destroy Flag" }));
    expect(onDestroy).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Destroying…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("labels a buoy and excludes land-anchor progression on phone", () => {
    render(createElement(MobileFlagActionSheet, {
      ...baseProps(),
      flag: { ...personalFlag(), anchorKind: "buoy" },
      managementOpen: true,
      cityMembership: membership(),
      onConvertCityFlag: vi.fn(),
      kingdomState: kingdomState(),
      onDestroy: vi.fn()
    }));

    expect(screen.getByRole("button", { name: "Destroy Buoy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Contribute to Albuquerque" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Contribute to Mesa Wardens" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Atlas Shrines" })).toBeNull();
  });

  it("keeps contribution and other management actions out of contextual More", () => {
    render(createElement(MobileFlagActionSheet, {
      ...baseProps(),
      managementOpen: true,
      cityMembership: membership(),
      onConvertCityFlag: vi.fn(),
      kingdomState: kingdomState(),
      onRename: vi.fn(),
      onUpgrade: vi.fn()
    }));

    expect(screen.queryByRole("button", { name: /Contribute to/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Rename/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Tower/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Player Details" })).toBeNull();
  });

  it("wires the phone sheet to the shared city conversion flow", () => {
    const app = readFileSync(resolve(process.cwd(), "src", "App.tsx"), "utf8");
    const sheetStart = app.indexOf("<MobileFlagActionSheet");
    const sheetEnd = app.indexOf("/> : null", sheetStart);
    const phoneSheet = app.slice(sheetStart, sheetEnd);
    const callbackStart = app.indexOf("const requestCityFlagConversion");
    const callbackEnd = app.indexOf("const requestClaimCityMayor", callbackStart);
    const callback = app.slice(callbackStart, callbackEnd);

    expect(phoneSheet).toContain("cityMembership={cityMembership}");
    expect(phoneSheet).toContain("cityBusy={foundingCity || cityActionBusy}");
    expect(phoneSheet).toContain("onConvertCityFlag={requestCityFlagConversion}");
    expect(phoneSheet).toContain("kingdomState={kingdomState}");
    expect(phoneSheet).toContain("onKingdomSnapshot={settlementFeature.applyKingdomSnapshot}");
    expect(phoneSheet).toContain("onKingdomRefresh={() => clientRef.current?.requestKingdomState()}");
    expect(phoneSheet).toContain('connected={connectionStatus === "online"}');
    expect(phoneSheet).toContain("onReturnToGame={closeFlagInteraction}");
    expect(phoneSheet).toContain("onClose={closeFlagInteraction}");
    expect(callback).toContain("convertCityFlag(flagId)");
    expect(app).toMatch(
      /const closeFlagInteraction = useCallback\(\(\): void => \{\s*setSelectedFlagId\(null\);\s*setManagedFlagId\(null\);/
    );
    expect(app).toMatch(
      /managedFlagId &&[\s\S]*?flag\.controlType === "personal"[\s\S]*?flag\.ownerId === playerId/
    );
    expect(app).toMatch(
      /setFlags\(\(current\) => removeFlagById[\s\S]*?closeFlagInteraction\(\);/
    );
  });

  it("shows only Public and Private for a Normal owner's More action", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const savedMode = init?.method === "PATCH"
        ? JSON.parse(String(init.body)).mode as FlagAccessSnapshot["mode"]
        : "normal";
      return new Response(JSON.stringify({
        access: access({ allowed: true, requestable: false }, savedMode)
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = {
      flag: personalFlag(),
      player: player(),
      walletGold: "20",
      serverHttpBase: "https://game.example",
      csrfToken: "csrf",
      access: access({ allowed: true, requestable: false }, "normal"),
      aggressiveRemainingMs: 0,
      connected: true,
      managementOpen: false,
      onVisit: vi.fn(() => true),
      onManage: vi.fn(),
      onReturnToGame: vi.fn(),
      onClose: vi.fn(),
      onAccessChange: vi.fn(),
      onAccessSaved: vi.fn()
    };
    const view = render(createElement(MobileFlagActionSheet, props));

    expect(screen.getByRole("heading", { name: "Ash's Flag (Normal) · Free" })).toBeTruthy();
    expect(screen.queryByText("Flag 1")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect(props.onManage).toHaveBeenCalledTimes(1);
    view.rerender(createElement(MobileFlagActionSheet, { ...props, managementOpen: true }));
    const accessOptions = screen.getByRole("group", { name: "Access" });
    expect(Array.from(accessOptions.querySelectorAll("button"), (button) => button.textContent)).toEqual([
      "Public", "Private"
    ]);
    expect(screen.queryByRole("button", { name: "Normal" })).toBeNull();
    expect(screen.queryByText("Custom")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Private" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) =>
      init?.method === "PATCH"
    )).toBe(true));
    const saveCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(saveCall?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ mode: "private", jumpTollGold: "0" })
    });
    await waitFor(() => expect(props.onAccessSaved).toHaveBeenCalledTimes(1));
    expect(props.onAccessChange).not.toHaveBeenCalled();
    expect(props.onReturnToGame).toHaveBeenCalledOnce();
  });

  it("transitions from the flag interaction to the compact More prompt", () => {
    function FlagFlow(): React.JSX.Element {
      const [view, setView] = useState<"closed" | "interaction" | "management">("interaction");
      return view === "closed"
        ? createElement("button", { type: "button" }, "Select Flag")
        : createElement(MobileFlagActionSheet, {
            ...baseProps(),
            managementOpen: view === "management",
            onManage: () => setView("management"),
            onReturnToGame: () => setView("closed"),
            onClose: () => setView("closed")
          });
    }

    const view = render(createElement(FlagFlow));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("button", { name: "Travel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(view.container.querySelectorAll(".mobile-world-action-sheet")).toHaveLength(1);
    expect(view.container.querySelectorAll(".phone-menu-layer")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Select Flag" })).toBeTruthy();
  });
});

function access(
  decision: Partial<FlagAccessSnapshot["decision"]>,
  mode: FlagAccessSnapshot["mode"] = "public"
): FlagAccessSnapshot {
  return {
    flagId: "flag-1",
    ownerPlayerId: "owner-1",
    mode,
    jumpTollGold: decision.tollGold ?? "0",
    accessRevision: "1",
    requestPending: false,
    decision: {
      allowed: true,
      requestable: false,
      reasonCode: "ALLOWED_PUBLIC",
      tollGold: "0",
      ...decision
    },
    management: null
  };
}

function baseProps() {
  return {
    flag: personalFlag(),
    player: player(),
    walletGold: "20",
    serverHttpBase: "https://game.example",
    csrfToken: "csrf",
    access: access({ allowed: true, requestable: false }, "normal"),
    aggressiveRemainingMs: 0,
    connected: true,
    managementOpen: false,
    onVisit: vi.fn(() => true),
    onManage: vi.fn(),
    onReturnToGame: vi.fn(),
    onClose: vi.fn(),
    onAccessChange: vi.fn()
  };
}

function membership(
  overrides: Partial<CityMembershipSnapshot> = {}
): CityMembershipSnapshot {
  return {
    cityId: "22222222-2222-4222-8222-222222222222",
    cityName: "Albuquerque",
    role: "member",
    joinedAt: "2026-07-18T00:00:00.000Z",
    houseStructureId: "house-1",
    expansionFlagCount: 0,
    expansionFlagLimit: 6,
    ...overrides
  };
}

function kingdomState(): KingdomStateSnapshot {
  const kingdomMembership = {
    membershipId: "membership-1",
    playerId: "owner-1",
    displayName: "Ash",
    role: "leader" as const,
    status: "active" as const,
    joinedAt: "2026-07-10T00:00:00.000Z",
    endedAt: null,
    perkQualifiedAt: "2026-07-10T00:00:00.000Z",
    chatMutedUntil: null,
    chatMute: { state: "not_muted" as const }
  };
  return {
    spatialRevision: "4",
    membership: kingdomMembership,
    kingdom: {
      id: "00000000-0000-4000-8000-000000000010",
      displayName: "Mesa Wardens",
      displayColor: "#7c3aed",
      description: null,
      emblemKey: null,
      founderPlayerId: kingdomMembership.playerId,
      leaderPlayerId: kingdomMembership.playerId,
      level: 1,
      memberCount: 1,
      kingdomFlagCount: 0,
      spatialRevision: "4",
      status: "active",
      seat: null,
      createdAt: "2026-07-10T00:00:00.000Z"
    },
    permissions: ["contribute_kingdom_flags"], roster: [kingdomMembership], invitations: [],
    chatHistory: [], treasury: [], donationHistory: null, treasuryExpenditureHistory: null,
    progression: null, advancementProject: null, activityHistory: [], cots: [], decorations: [],
    kingdomFlags: [], decorationCatalog: [], nearbyKingdoms: [], freeConstruction: true,
    perkQualificationSeconds: 0
  };
}

function personalFlag(): FlagSnapshot {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    controlType: "personal",
    ownerId: "owner-1",
    ownerUsername: "Ash",
    ownerColor: "#38bdf8",
    health: 110,
    maximumHealth: 100,
    name: "Flag 1",
    lat: 53.3498,
    lon: -6.2603,
    packageId: "world_v1_lat53_lon-7",
    elevationM: 0,
    terrainClass: "flat",
    biome: "Temperate Broadleaf & Mixed Forests",
    ecoregion: "Celtic broadleaf forests",
    claimRadiusM: 1000,
    cityId: null,
    createdAt: "2026-07-13T08:00:00.000Z"
  };
}

function player(): PlayerSnapshot {
  return {
    playerId: "owner-1",
    username: "Ash",
    displayColor: "#38bdf8",
    regionCode: "GLOBAL",
    zoneId: "world",
    lat: 53.3498,
    lon: -6.2603,
    anchorLat: 53.3498,
    anchorLon: -6.2603,
    moveLeashRadiusM: 1250,
    movementRevision: 0,
    targetLat: null,
    targetLon: null,
    moving: false,
    online: true,
    updatedAt: "2026-07-13T08:00:00.000Z"
  };
}


function flagJsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
