// @vitest-environment jsdom

import { KINGDOM_PERKS, type KingdomDecorationDefinition, type KingdomStateSnapshot } from "@ash-atlas/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KingdomApiClient } from "../kingdom/kingdomClient.js";
import { KingdomPanel } from "./KingdomPanel.js";

const TEST_DECORATIONS: KingdomDecorationDefinition[] = [{
  typeId: "banner",
  displayName: "Banner",
  footprintRadiusM: 2,
  ownershipType: "choice",
  requiredKingdomLevel: 1,
  capacityCost: 1,
  futureMaterialCost: [{ resourceType: "wood", quantity: 5 }],
  intendedConstructionSeconds: 30,
  membersMayPlace: true,
  officersOnly: false
}];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("KingdomPanel", () => {
  it("requires and displays an authoritative founding quote before confirmation", async () => {
    const onSnapshot = vi.fn();
    const quoteRequest = vi.spyOn(KingdomApiClient.prototype, "getFoundingQuote").mockResolvedValue({
      requestId: "quote-1",
      position: { lat: 35.1, lon: -106.6 },
      seatPosition: { lat: 35.1, lon: -106.6 },
      territoryRadiusM: 200,
      sourceFlag: sourceFlag("00000000-0000-4000-8000-000000000021", "Home Flag", 35.099, -106.599, 200),
      absorbedFlagCount: 0,
      eligible: true,
      affordable: true,
      disabledReason: null,
      blockerCode: null,
      guidance: null,
      affordability: [{
        resourceType: "wood",
        requiredQuantity: 8,
        availableQuantity: 8,
        missingQuantity: 0
      }],
      informational: true,
      reservationNotice: "This quote is informational and reserves nothing.",
      environment: environment(),
      quote: {
        action: "found",
        freeConstruction: true,
        intendedCost: [{ resourceType: "wood", quantity: 10 }],
        intendedConstructionSeconds: 60,
        adjustedCost: [{ resourceType: "wood", quantity: 8 }],
        adjustedConstructionSeconds: 48,
        modifiers: [{
          key: "plains_time",
          label: "Open-ground construction",
          value: 0.9,
          unit: "multiplier",
          applied: true,
          futureSystem: null
        }]
      }
    });
    const foundRequest = vi.spyOn(KingdomApiClient.prototype, "found").mockResolvedValue({
      state: memberState(),
      stateRefreshRequired: false,
      quote: null,
      replayed: false,
      message: "Founded"
    });
    renderPanel({ snapshot: emptyState(), onSnapshot });

    expect(screen.getByLabelText("Kingdom founding requirements")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Wood 100" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Stone 75" })).toBeTruthy();
    expect(screen.queryByText("60 minutes")).toBeNull();
    expect(screen.queryByText(/emblem key/i)).toBeNull();
    expect(screen.queryByText("Description", { selector: "span" })).toBeNull();
    expect(screen.getByText("15 seconds")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Build Kingdom (15s)" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mesa Wardens" } });
    fireEvent.click(screen.getByRole("button", { name: "Check Kingdom location" }));

    expect(await screen.findByLabelText("Authoritative founding quote")).toBeTruthy();
    expect(quoteRequest).toHaveBeenCalledWith(expect.not.objectContaining({
      description: expect.anything(),
      emblemKey: expect.anything()
    }));
    expect(screen.getByText("Validated land")).toBeTruthy();
    expect(screen.getByText("Free testing mode")).toBeTruthy();
    expect(screen.getByText("8 wood")).toBeTruthy();
    expect(screen.getByText("Home Flag")).toBeTruthy();
    expect(screen.getByText("35.10000, -106.60000")).toBeTruthy();
    expect(screen.getByText("35.09900, -106.59900")).toBeTruthy();
    expect(screen.getByText(/Neighboring personal flags remain unchanged/i)).toBeTruthy();
    expect(screen.getAllByRole("img", { name: /8, have 8$/u }).length).toBeGreaterThan(0);
    const confirm = screen.getByRole("button", { name: "Build Kingdom (15s)" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Clear location check" }));
    expect(screen.queryByRole("button", { name: "Build Kingdom (15s)" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check Kingdom location" }));
    const buildButton = await screen.findByRole("button", { name: "Build Kingdom (15s)" });
    vi.useFakeTimers();
    fireEvent.click(buildButton);
    expect(screen.getByLabelText("Kingdom build time remaining").textContent).toBe("15.0s");
    expect(foundRequest).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    vi.useRealTimers();
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ kingdom: expect.objectContaining({ displayName: "Mesa Wardens" }) })
    ));
    expect(foundRequest).toHaveBeenCalledWith(expect.objectContaining({
      sourceFlagId: "00000000-0000-4000-8000-000000000021"
    }));
    expect(foundRequest).toHaveBeenCalledWith(expect.not.objectContaining({
      description: expect.anything(),
      emblemKey: expect.anything()
    }));
  });

  it("keeps an underfunded quote visible and explains the disabled final action", async () => {
    vi.spyOn(KingdomApiClient.prototype, "getFoundingQuote").mockResolvedValue({
      requestId: "underfunded-quote",
      position: { lat: 35.1, lon: -106.6 },
      seatPosition: { lat: 35.1, lon: -106.6 },
      territoryRadiusM: 200,
      sourceFlag: sourceFlag("00000000-0000-4000-8000-000000000024", "Supply Flag", 35.1, -106.6, 200),
      absorbedFlagCount: 0,
      eligible: true,
      affordable: false,
      disabledReason: null,
      blockerCode: null,
      guidance: null,
      affordability: [
        { resourceType: "wood", requiredQuantity: 100, availableQuantity: 42, missingQuantity: 58 },
        { resourceType: "stone", requiredQuantity: 75, availableQuantity: 12, missingQuantity: 63 }
      ],
      informational: true,
      reservationNotice: "This quote is informational and reserves nothing.",
      environment: environment(),
      quote: {
        action: "found",
        freeConstruction: false,
        intendedCost: [{ resourceType: "wood", quantity: 100 }, { resourceType: "stone", quantity: 75 }],
        intendedConstructionSeconds: 0,
        adjustedCost: [{ resourceType: "wood", quantity: 100 }, { resourceType: "stone", quantity: 75 }],
        adjustedConstructionSeconds: 0,
        modifiers: []
      }
    });
    renderPanel({ snapshot: emptyState() });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Supply Realm" } });
    fireEvent.click(screen.getByRole("button", { name: "Check Kingdom location" }));

    expect((await screen.findAllByRole("img", { name: "Wood 100, have 42, missing 58" })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("img", { name: "Stone 75, have 12, missing 63" }).length).toBeGreaterThan(0);
    expect(screen.getByText("Missing 58 wood and 63 stone.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Build Kingdom (15s)" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("keeps the founding color immutable in the management UI", () => {
    renderPanel({ snapshot: memberState() });

    expect(screen.queryByText(/emblem key/i)).toBeNull();
    expect(screen.queryByText("Description", { selector: "span" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save identity" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Identity" })).toBeNull();
  });

  it("cancels the 15-second build manually or when the player moves", async () => {
    vi.spyOn(KingdomApiClient.prototype, "getFoundingQuote").mockResolvedValue({
      requestId: "cancelable-quote",
      position: { lat: 35.1, lon: -106.6 },
      seatPosition: { lat: 35.1, lon: -106.6 },
      territoryRadiusM: 200,
      sourceFlag: sourceFlag("00000000-0000-4000-8000-000000000026", "Build Flag", 35.1, -106.6, 200),
      absorbedFlagCount: 0,
      eligible: true,
      affordable: true,
      disabledReason: null,
      blockerCode: null,
      guidance: null,
      affordability: [],
      informational: true,
      reservationNotice: "This quote is informational and reserves nothing.",
      environment: environment(),
      quote: {
        action: "found",
        freeConstruction: false,
        intendedCost: [],
        intendedConstructionSeconds: 0,
        adjustedCost: [],
        adjustedConstructionSeconds: 0,
        modifiers: []
      }
    });
    const foundRequest = vi.spyOn(KingdomApiClient.prototype, "found").mockResolvedValue({
      state: memberState(),
      stateRefreshRequired: false,
      quote: null,
      replayed: false,
      message: "Founded"
    });
    const options: RenderPanelOptions = {
      snapshot: emptyState(),
      foundingPosition: { lat: 35.1, lon: -106.6 }
    };
    const view = renderPanel(options);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Cancelable Realm" } });
    fireEvent.click(screen.getByRole("button", { name: "Check Kingdom location" }));
    await screen.findByLabelText("Authoritative founding quote");

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Build Kingdom (15s)" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel Kingdom build" }));
    expect(screen.getByText("Kingdom construction canceled. No materials were spent.")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(foundRequest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Build Kingdom (15s)" }));
    view.rerender(panel({
      ...options,
      foundingPosition: { lat: 35.1001, lon: -106.6 }
    }));
    await act(async () => {});
    expect(screen.getAllByRole("status").some((notice) => notice.textContent ===
      "You moved, so any active Kingdom build was canceled. Check the location again before founding."
    )).toBe(true);
    expect(screen.queryByRole("progressbar", { name: "Kingdom construction progress" })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(foundRequest).not.toHaveBeenCalled();
  });

  it("shows a concise map-derived overview and six management sections", () => {
    const onVisitKingdomSeat = vi.fn();
    renderPanel({ snapshot: memberState(), onVisitKingdomSeat });

    expect(screen.getByRole("heading", { level: 2, name: "Mesa Wardens" })).toBeTruthy();
    expect(screen.queryByText(/emblem key/i)).toBeNull();
    expect(screen.queryByText("35.10000, -106.60000")).toBeNull();
    expect(screen.queryByText("2026.07")).toBeNull();
    expect(screen.queryByText("Rules version")).toBeNull();
    expect(screen.getAllByText("Grassland").length).toBeGreaterThan(0);
    expect(screen.getAllByText("High · 1,500 m").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Plains").length).toBeGreaterThan(0);
    expect(screen.queryByText("Stone construction requirement")).toBeNull();
    expect(screen.queryByText(/Kingdom Flags/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Travel to Castle" }));
    expect(onVisitKingdomSeat).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Members" }));
    expect(screen.getByText("Roster")).toBeTruthy();
    expect(screen.getByText("Scout (you)")).toBeTruthy();

    expect(screen.queryByRole("tab", { name: "Chat" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Treasury" }));
    expect(screen.getByText("Treasury totals")).toBeTruthy();
    expect(screen.getByText("Donation ledger")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Progression" }));
    expect(screen.getByRole("heading", { name: "Perks" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Perks" }));
    expect(screen.getByRole("heading", { name: "Level 2" })).toBeTruthy();
    expect(screen.getAllByText("Boundary Writ").length).toBeGreaterThan(0);
    expect(screen.getByText("Perks for this level are coming soon.")).toBeTruthy();
    expect(screen.getByText("Unlocks at kingdom level 6")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Cots & Decorations" }));
    expect(screen.getByText("Cots")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByText("No Kingdom activity recorded.")).toBeTruthy();
  });

  it("shows project progress, spending/refunds, zero-XP donations, and safe activity", () => {
    const state = memberState();
    state.donationHistory = [{
      id: "donation-zero",
      kingdomId: state.kingdom!.id,
      donorPlayerId: state.membership!.playerId,
      donorDisplayName: "Scout",
      resourceType: "wood",
      variant: null,
      quantity: 300,
      playerBalanceBefore: 300,
      playerBalanceAfter: 0,
      treasuryBalanceBefore: 0,
      treasuryBalanceAfter: 300,
      kingdomXpGranted: 0,
      createdAt: "2026-07-10T00:02:00.000Z"
    }];
    state.treasuryExpenditureHistory = [{
      id: "spend-1",
      kingdomId: state.kingdom!.id,
      projectId: "00000000-0000-4000-8000-000000000050",
      projectName: "Fortify the Seat",
      actorPlayerId: state.membership!.playerId,
      actorDisplayName: "Scout",
      resourceType: "wood",
      variant: "default",
      direction: "debit",
      quantity: 300,
      balanceBefore: 300,
      balanceAfter: 0,
      createdAt: "2026-07-10T00:03:00.000Z"
    }];
    state.advancementProject = {
      id: "00000000-0000-4000-8000-000000000050",
      projectType: "advancement",
      rulesVersion: 1,
      targetLevel: 3,
      displayName: "Fortify the Seat",
      status: "pending",
      actorPlayerId: state.membership!.playerId,
      actorDisplayName: "Scout",
      cost: [{
        resourceType: "wood",
        variant: "default",
        quantity: 300,
        availableQuantity: 0,
        missingQuantity: 300
      }],
      xpDelta: 490,
      startedAt: "2026-07-10T00:03:00.000Z",
      completesAt: new Date(Date.now() + 60_000).toISOString(),
      completedAt: null,
      cancelledAt: null,
      failedAt: null,
      failureCode: null
    };
    state.activityHistory = [{
      id: "activity-1",
      eventType: "advancement_project_started",
      summary: "Scout started Fortify the Seat.",
      actorDisplayName: "Scout",
      targetDisplayName: null,
      createdAt: "2026-07-10T00:03:00.000Z"
    }];
    renderPanel({ snapshot: state });

    fireEvent.click(screen.getByRole("tab", { name: "Treasury" }));
    expect(screen.getByText(/Kingdom levels come from the XP members earn/)).toBeTruthy();
    expect(screen.queryByText("+0 Kingdom XP")).toBeNull();
    expect(screen.getByText("Spent 300 wood")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Progression" }));
    expect(screen.getByText("Seat anchor radius")).toBeTruthy();
    expect(screen.queryByText(/Kingdom Flags/i)).toBeNull();
    expect(screen.queryByText("Future construction metadata")).toBeNull();
    // Advancement projects are retired: levels come from member XP only.
    expect(screen.queryByRole("button", { name: /advancement project|Cancel project/ })).toBeNull();
    expect(screen.getByText("260 / 750 XP to level 3.")).toBeTruthy();
    expect(screen.getByText("1,200 / 20,000 XP")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByText("Scout started Fortify the Seat.")).toBeTruthy();
  });

  it("shows an explicitly selected foreign Kingdom as public-only", () => {
    const state = memberState();
    const foreign = {
      ...state.kingdom!,
      id: "00000000-0000-4000-8000-000000000099",
      displayName: "Remote Wardens",
      description: "A different Kingdom",
      founderPlayerId: "00000000-0000-4000-8000-000000000098",
      leaderPlayerId: "00000000-0000-4000-8000-000000000098"
    };
    renderPanel({
      snapshot: state,
      selectedKingdomId: foreign.id,
      publicKingdom: foreign
    });

    expect(screen.getByRole("heading", { level: 2, name: "Remote Wardens" })).toBeTruthy();
    expect(screen.getByText("A different Kingdom")).toBeTruthy();
    expect(screen.queryByText("A social home")).toBeNull();
    expect(screen.queryByText("Found a Kingdom")).toBeNull();
    expect((screen.getByRole("tab", { name: "Members" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("tab", { name: "Chat" })).toBeNull();
  });

  it("exposes Unban for a durable banned roster entry", () => {
    const state = memberState();
    state.roster.push({
      membershipId: "membership-banned",
      playerId: "00000000-0000-4000-8000-000000000077",
      displayName: "Banned Scout",
      role: "member",
      status: "banned",
      joinedAt: "2026-07-10T00:00:00.000Z",
      endedAt: "2026-07-10T01:00:00.000Z",
      perkQualifiedAt: "2026-07-10T00:05:00.000Z",
      chatMutedUntil: null,
      chatMute: { state: "not_muted" }
    });
    renderPanel({ snapshot: state });

    fireEvent.click(screen.getByRole("tab", { name: "Members" }));
    expect(screen.getByText("Banned Scout")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unban" })).toBeTruthy();
  });

  it("retains current state and requests refresh after a degraded committed mutation", async () => {
    const onSnapshot = vi.fn();
    const onRequestRefresh = vi.fn();
    vi.spyOn(KingdomApiClient.prototype, "donate").mockResolvedValue({
      state: null,
      stateRefreshRequired: true,
      quote: null,
      replayed: false,
      message: null
    });
    renderPanel({ snapshot: memberState(), onSnapshot, onRequestRefresh });
    fireEvent.click(screen.getByRole("tab", { name: "Treasury" }));
    fireEvent.click(screen.getByRole("button", { name: "Donate" }));
    await waitFor(() => expect(onRequestRefresh).toHaveBeenCalledOnce());
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(screen.getByText("Action completed. Refreshing Kingdom state.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Mesa Wardens" })).toBeTruthy();
  });

  it("keeps a specific blocker in the scrollable card and marks the quote stale after movement", async () => {
    vi.spyOn(KingdomApiClient.prototype, "getFoundingQuote")
      .mockResolvedValueOnce({
        requestId: "blocked-quote",
        position: { lat: 35.0844, lon: -106.6504 },
        seatPosition: { lat: 35.0844, lon: -106.6504 },
        territoryRadiusM: 200,
        sourceFlag: {
          ...sourceFlag("00000000-0000-4000-8000-000000000023", "City Flag", 35.0844, -106.6504, 200),
          ownerDisplayName: "Founder",
          ownedByPlayer: true,
          personallyControlled: false,
          controlType: "city"
        },
        absorbedFlagCount: 0,
        eligible: false,
        affordable: null,
        disabledReason: "This flag is affiliated with a City",
        blockerCode: "KINGDOM_FLAG_CITY_AFFILIATED",
        guidance: "Select a different personal flag without City or Kingdom connections.",
        affordability: [],
        informational: true,
        reservationNotice: "This quote is informational and reserves nothing.",
        environment: null,
        quote: null
      })
      .mockResolvedValueOnce({
        requestId: "quote-after-move",
        position: { lat: 36.2, lon: -105.2 },
        seatPosition: { lat: 36.2, lon: -105.2 },
        territoryRadiusM: 200,
        sourceFlag: sourceFlag("00000000-0000-4000-8000-000000000022", "Moved Flag", 36.2, -105.2, 200),
        absorbedFlagCount: 0,
        eligible: true,
        affordable: true,
        disabledReason: null,
        blockerCode: null,
        guidance: null,
        affordability: [],
        informational: true,
        reservationNotice: "This quote is informational and reserves nothing.",
        environment: environment(),
        quote: {
          action: "found",
          freeConstruction: true,
          intendedCost: [],
          intendedConstructionSeconds: 0,
          adjustedCost: [],
          adjustedConstructionSeconds: 0,
          modifiers: []
        }
      });
    const initialOptions: RenderPanelOptions = {
      snapshot: emptyState(),
      foundingPosition: { lat: 35.0844, lon: -106.6504 }
    };
    const view = renderPanel(initialOptions);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Recovery Realm" } });
    fireEvent.click(screen.getByRole("button", { name: "Check Kingdom location" }));

    const blocker = await screen.findByText("This flag is affiliated with a City");
    expect(blocker.closest(".kingdom-tab-content")).toBeTruthy();
    expect(screen.getByText("City Flag")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Build Kingdom (15s)" }) as HTMLButtonElement).disabled)
      .toBe(true);

    view.rerender(panel({
      ...initialOptions,
      open: false,
      foundingPosition: { lat: 35.0844, lon: -106.6504 }
    }));
    view.rerender(panel({
      ...initialOptions,
      open: false,
      foundingPosition: { lat: 36.2, lon: -105.2 }
    }));
    view.rerender(panel({
      ...initialOptions,
      open: true,
      foundingPosition: { lat: 36.2, lon: -105.2 }
    }));
    await waitFor(() => {
      expect(screen.queryByText("This flag is affiliated with a City")).toBeNull();
    });
    expect(screen.getByText(
      "You moved, so any active Kingdom build was canceled. Check the location again before founding."
    )).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Build Kingdom (15s)" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Recovery Realm" } });
    fireEvent.click(screen.getByRole("button", { name: "Check Kingdom location" }));
    expect(await screen.findByLabelText("Authoritative founding quote")).toBeTruthy();
    expect(screen.queryByText("This flag is affiliated with a City")).toBeNull();
  });

  it("uses explicit dialogs for destructive Kingdom and roster actions", () => {
    const state = memberState();
    state.roster.push({
      membershipId: "membership-officer",
      playerId: "00000000-0000-4000-8000-000000000002",
      displayName: "Second Scout",
      role: "officer",
      status: "active",
      joinedAt: "2026-07-10T00:00:00.000Z",
      endedAt: null,
      perkQualifiedAt: "2026-07-10T00:05:00.000Z",
      chatMutedUntil: null,
      chatMute: { state: "not_muted" }
    });
    renderPanel({ snapshot: state });

    fireEvent.click(screen.getByRole("button", { name: "Dissolve Kingdom" }));
    expect(screen.getByRole("dialog", { name: "Dissolve Mesa Wardens?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("tab", { name: "Members" }));
    expect(screen.getAllByRole("button", { name: "Transfer leadership" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Transfer leadership" }));
    expect(screen.getByRole("dialog", { name: "Transfer leadership to Second Scout?" })).toBeTruthy();
  });
});

type RenderPanelOptions = {
  snapshot: KingdomStateSnapshot;
  open?: boolean;
  foundingPosition?: { lat: number; lon: number };
  onSnapshot?: (snapshot: KingdomStateSnapshot) => void;
  onSendChat?: (content: string, requestId: string) => Promise<boolean>;
  selectedKingdomId?: string;
  publicKingdom?: NonNullable<KingdomStateSnapshot["kingdom"]>;
  onRequestRefresh?: () => void;
  onVisitKingdomSeat?: (seatId: string) => void;
  onVisitKingdomFlag?: (flagId: string) => void;
  onViewKingdomFlag?: (flagId: string) => void;
};

function renderPanel(options: RenderPanelOptions) {
  return render(panel(options));
}

function panel(options: RenderPanelOptions) {
  return (
    <KingdomPanel
      open={options.open ?? true}
      ownPlayerId="00000000-0000-4000-8000-000000000001"
      serverHttpBase="https://game.example"
      csrfToken="csrf"
      connected
      layout="desktop"
      foundingPosition={options.foundingPosition ?? { lat: 35.0844, lon: -106.6504 }}
      snapshot={options.snapshot}
      {...(options.selectedKingdomId ? { selectedKingdomId: options.selectedKingdomId } : {})}
      {...(options.publicKingdom ? { publicKingdom: options.publicKingdom } : {})}
      onSnapshot={options.onSnapshot ?? (() => undefined)}
      {...(options.onRequestRefresh ? { onRequestRefresh: options.onRequestRefresh } : {})}
      {...(options.onSendChat ? { onSendChat: options.onSendChat } : {})}
      {...(options.onVisitKingdomSeat ? { onVisitKingdomSeat: options.onVisitKingdomSeat } : {})}
      {...(options.onVisitKingdomFlag ? { onVisitKingdomFlag: options.onVisitKingdomFlag } : {})}
      {...(options.onViewKingdomFlag ? { onViewKingdomFlag: options.onViewKingdomFlag } : {})}
      onClose={() => undefined}
    />
  );
}

function emptyState(): KingdomStateSnapshot {
  return {
    spatialRevision: "1",
    membership: null,
    kingdom: null,
    permissions: [],
    roster: [],
    invitations: [],
    chatHistory: [],
    treasury: [],
    donationHistory: null,
    treasuryExpenditureHistory: null,
    progression: null,
    advancementProject: null,
    activityHistory: [],
    cots: [],
    decorations: [],
    decorationCatalog: TEST_DECORATIONS,
    nearbyKingdoms: [],
    freeConstruction: true,
    perkQualificationSeconds: 300
  };
}

function memberState(): KingdomStateSnapshot {
  const membership = {
    membershipId: "membership-1",
    playerId: "00000000-0000-4000-8000-000000000001",
    displayName: "Scout",
    role: "leader" as const,
    status: "active" as const,
    joinedAt: "2026-07-10T00:00:00.000Z",
    endedAt: null,
    perkQualifiedAt: "2026-07-10T00:05:00.000Z",
    chatMutedUntil: null,
    chatMute: { state: "not_muted" as const }
  };
  const kingdom = {
    id: "00000000-0000-4000-8000-000000000010",
    displayName: "Mesa Wardens",
    displayColor: "#7c3aed",
    description: "A social home",
    emblemKey: "sun",
    founderPlayerId: membership.playerId,
    leaderPlayerId: membership.playerId,
    level: 2,
    memberCount: 1,
    spatialRevision: "2",
    status: "active" as const,
    seat: {
      id: "00000000-0000-4000-8000-000000000011",
      kingdomId: "00000000-0000-4000-8000-000000000010",
      lat: 35.1,
      lon: -106.6,
      territoryRadiusM: 225,
      environment: environment(),
      environmentModifiers: [{
        key: "stone_cost",
        label: "Stone construction requirement",
        value: 0.9,
        unit: "multiplier" as const,
        applied: true,
        futureSystem: null
      }],
      environmentRulesVersion: 1,
      constructionState: "complete" as const,
      constructionCompletesAt: null,
      completedUnderFreeConstruction: true,
      status: "active" as const,
      createdAt: "2026-07-10T00:00:00.000Z",
      completedAt: "2026-07-10T00:00:00.000Z"
    },
    createdAt: "2026-07-10T00:00:00.000Z"
  };
  return {
    spatialRevision: "2",
    membership,
    kingdom,
    permissions: [
      "invite_members",
      "cancel_invitations",
      "remove_members",
      "ban_members",
      "manage_roles",
      "mute_chat",
      "manage_identity",
      "manage_cots",
      "place_decorations",
      "move_decorations",
      "remove_decorations",
      "manage_kingdom_decorations",
      "view_treasury_ledger",
      "manage_perks",
      "transfer_leadership",
      "dissolve_kingdom"
    ],
    roster: [membership],
    invitations: [],
    chatHistory: [{
      id: "message-1",
      kingdomId: kingdom.id,
      senderPlayerId: membership.playerId,
      senderDisplayName: "Scout",
      content: "Welcome home",
      createdAt: "2026-07-10T00:01:00.000Z"
    }],
    treasury: [{ resourceType: "wood", variant: null, quantity: 20 }],
    donationHistory: [],
    treasuryExpenditureHistory: [],
    progression: {
      level: 2,
      currentXp: 10,
      lifetimeXp: 260,
      levelDefinitionVersion: 1,
      nextLevelXp: 750,
      dailyXp: 1_200,
      dailyXpCap: 20_000,
      capacities: {
        memberCapacity: 15,
        cotCapacity: 15,
        decorationCapacity: 35,
        seatAnchorRadiusM: 225
      },
      perks: [{
        ...KINGDOM_PERKS.boundary_writ,
        unlocked: true,
        qualified: true,
        selected: true,
        active: true
      }],
      perkSelections: [{
        level: 2,
        perkId: "boundary_writ",
        selectedAt: "2026-07-10T00:00:00.000Z",
        activeUntil: null,
        nextActivationAt: null
      }],
      futureBuildingUnlocks: ["social_hall_tier_1"]
    },
    advancementProject: null,
    activityHistory: [],
    cots: [],
    decorations: [],
    kingdomFlags: [{
      flagId: "00000000-0000-4000-8000-000000000012",
      kingdomId: kingdom.id,
      flagName: "Eastern Watch",
      ownerPlayerId: membership.playerId,
      ownerDisplayName: "Scout",
      contributedByPlayerId: membership.playerId,
      contributedByDisplayName: "Scout",
      kingdomColor: "#7c3aed",
      lat: 35.101,
      lon: -106.59,
      claimRadiusM: 700,
      constructionState: "complete",
      connected: true,
      directlyTouchesSeat: true,
      connectionAnchor: { kind: "seat", id: kingdom.seat.id, name: "Mesa Wardens Castle" },
      affiliatedAt: "2026-07-10T00:02:00.000Z"
    }],
    decorationCatalog: TEST_DECORATIONS,
    nearbyKingdoms: [kingdom],
    freeConstruction: true,
    perkQualificationSeconds: 300
  };
}

function environment() {
  return {
    terrainClass: "plains",
    biome: "grassland",
    ecoregion: "test",
    elevationM: 1_500,
    elevationBand: "high",
    slope: 2,
    slopeBand: "gentle",
    isLand: true,
    isSaltwater: false,
    insideMajorLake: false,
    worldReleaseId: "release-1",
    worldReleaseVersion: "2026.07",
    worldPackageId: "nm",
    environmentSchemaVersion: "1",
    environmentRulesVersion: 1,
    sourceVersions: {},
    lookedUpAt: "2026-07-10T00:00:00.000Z"
  };
}

function sourceFlag(id: string, name: string, lat: number, lon: number, claimRadiusM: number) {
  return { id, name, ownerColor: "#38bdf8", lat, lon, claimRadiusM };
}
