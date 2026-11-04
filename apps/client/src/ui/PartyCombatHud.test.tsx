// @vitest-environment jsdom

import type {
  PartyCombatMemberSnapshot,
  PartyInviteSnapshot,
  PartySnapshot
} from "@ash-atlas/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PartyCombatStore } from "../party/partyCombatStore.js";
import { PartyCombatHud, PartyInviteBanner } from "./PartyCombatHud.js";

const party: PartySnapshot = {
  partyId: "party:00000000-0000-4000-8000-000000000001",
  leaderPlayerId: "self",
  memberPlayerIds: ["ally-1", "ally-2", "ally-3", "ally-4", "self"],
  memberSlots: [
    { playerId: "self", slotIndex: 0 },
    { playerId: "ally-1", slotIndex: 1 },
    { playerId: "ally-2", slotIndex: 2 },
    { playerId: "ally-3", slotIndex: 3 },
    { playerId: "ally-4", slotIndex: 4 }
  ],
  membershipRevision: 5,
  allowTravel: false,
  autoFollowPlayerIds: [],
  revision: 5
};

describe("PartyCombatHud", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("renders only the four other party members and keeps the total party count", () => {
    const onSelectPlayer = vi.fn();
    renderHud({ onSelectPlayer });

    const rows = screen.getAllByRole("button", { name: /^Target / });
    expect(rows).toHaveLength(4);
    expect(rows[0]?.getAttribute("aria-label")).toContain("Ally 1");
    expect(rows[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Self")).toBeNull();
    expect(screen.getByLabelText("5 of 5 party members").textContent).toBe("5/5");
    expect(screen.queryByText("80%")).toBeNull();
    expect(screen.queryByText("Warrior")).toBeNull();
    expect(screen.queryByText("damage")).toBeNull();
    expect(rows[0]?.getAttribute("aria-label")).toContain("Warrior, Damage, 90% health");
    expect(Array.from(document.querySelectorAll(".party-class-sigil")).map((seal) => seal.textContent))
      .toEqual(["W", "K", "H", "A"]);

    fireEvent.click(rows[3]!);
    expect(onSelectPlayer).toHaveBeenCalledWith("ally-4");
  });

  it("places a visible leader first so the three-member layout can keep that row full width", () => {
    renderHud({
      store: combatStore(["self", "ally-1", "ally-2", "ally-3"]),
      partySnapshot: {
        ...party,
        leaderPlayerId: "ally-3",
        memberPlayerIds: ["ally-1", "ally-2", "ally-3", "self"]
      }
    });

    const rows = screen.getAllByRole("button", { name: /^Target / });
    expect(rows[0]?.getAttribute("aria-label")).toContain("Ally 3");
    expect(document.querySelector(".party-combat-roster")?.getAttribute("data-member-count")).toBe("3");
  });

  it("keeps unavailable members selectable with explicit non-color state text", () => {
    const store = combatStore();
    store.applyDelta({
      type: "PARTY_COMBAT_DELTA",
      partyId: party.partyId,
      membershipRevision: 5,
      sequence: 2,
      serverTime: 2,
      members: [{
        playerId: "ally-2",
        presence: "offline",
        lifeState: "defeated",
        worldRelation: "different_area"
      }]
    });
    renderHud({ store });

    const row = screen.getByRole("button", { name: /Target Ally 2.*Offline/i });
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(row.className).toContain("is-offline");
    expect(row.className).toContain("is-dead");
  });

  it("shows authoritative Downed time and blue Ward on the party health track", () => {
    const store = combatStore();
    store.applyDelta({
      type: "PARTY_COMBAT_DELTA",
      partyId: party.partyId,
      membershipRevision: 5,
      sequence: 2,
      serverTime: 1_000,
      members: [{ playerId: "ally-1", lifeState: "downed", downedUntil: 10_000, ward: 8 }]
    });
    const view = renderHud({ store, synchronizedNow: () => 1_000 });
    const row = screen.getByRole("button", { name: /Target Ally 1.*8 Ward.*Downed · 9s/i });
    expect(row.className).toContain("is-downed");
    const ward = view.container.querySelector<HTMLElement>(".party-ward-fill")!;
    expect(ward.style.width).toBe("8%");
    expect(ward.style.left).toBe("90%");
  });

  it("marks same-layer members beyond friendly ability range as out", () => {
    const store = combatStore();
    store.applyDelta({
      type: "PARTY_COMBAT_DELTA",
      partyId: party.partyId,
      membershipRevision: 5,
      sequence: 2,
      serverTime: 2,
      members: [{ playerId: "ally-1", distanceMeters: 121 }]
    });
    renderHud({ store });

    const row = screen.getByRole("button", { name: /Target Ally 1.*Out/i });
    expect(row.className).toContain("is-out-of-range");
  });

  it("is removed from interaction when an exclusive surface hides it", () => {
    const { container } = renderHud({ hidden: true });
    const hud = container.querySelector(".party-combat-hud");
    expect(hud?.hasAttribute("hidden")).toBe(true);
    expect(hud?.hasAttribute("inert")).toBe(true);
  });

  it("deselects the active member when their row is clicked again", () => {
    const onSelectPlayer = vi.fn();
    renderHud({ onSelectPlayer });

    fireEvent.click(screen.getByRole("button", { name: /Target Ally 2/ }));
    expect(onSelectPlayer).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: /Target Ally 1/ }));
    expect(onSelectPlayer).toHaveBeenCalledWith("ally-1");
    expect(screen.queryByText(/select an eligible ally/i)).toBeNull();
  });

  it("collapses to only the persisted themed launcher and opens and closes", () => {
    localStorage.setItem("ash-atlas:party-hud-collapsed:self", "1");
    renderHud();

    const launcher = screen.getByRole("button", { name: "Expand party HUD, 4 other members" });
    const panel = document.querySelector(".party-hud-panel");
    expect(launcher.querySelector("svg")).toBeTruthy();
    expect(panel?.getAttribute("aria-hidden")).toBe("true");
    expect(panel?.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Target / })).toBeNull();

    fireEvent.click(launcher);
    expect(screen.getByText("Party")).toBeTruthy();
    const collapse = screen.getByRole("button", { name: "Collapse party HUD" });
    expect(collapse.className).toContain("legacy-control-button");
    expect(collapse.className).toContain("is-panel-open");
    expect(collapse.querySelector("svg")).toBeTruthy();
    expect(collapse.querySelector(".party-hud-close-glyph")).toBeNull();
    fireEvent.click(collapse);
    expect(localStorage.getItem("ash-atlas:party-hud-collapsed:self")).toBe("1");
    expect(screen.getByRole("button", { name: "Expand party HUD, 4 other members" })).toBeTruthy();
  });

  it("uses authoritative leader travel state and blocks duplicate pending updates", () => {
    const onSetTravelAllowed = vi.fn(() => true);
    const rendered = renderHud({ onSetTravelAllowed });
    const travelSwitch = screen.getByRole("switch", {
      name: "Allow party members to jump to you"
    });
    expect(screen.getByText("ALLOW JUMP")).toBeTruthy();
    expect((travelSwitch as HTMLInputElement).checked).toBe(false);

    fireEvent.click(travelSwitch);
    fireEvent.click(travelSwitch);
    expect(onSetTravelAllowed).toHaveBeenCalledOnce();
    expect(onSetTravelAllowed).toHaveBeenCalledWith(true);
    expect((travelSwitch as HTMLInputElement).checked).toBe(false);
    expect((travelSwitch as HTMLInputElement).disabled).toBe(true);

    rendered.rerender(hud({
      onSetTravelAllowed,
      partySnapshot: { ...party, allowTravel: true, revision: 6 }
    }));
    expect((screen.getByRole("switch", {
      name: "Allow party members to jump to you"
    }) as HTMLInputElement).checked).toBe(true);
  });

  it("recovers a pending travel switch when no authoritative update arrives", async () => {
    vi.useFakeTimers();
    renderHud({ onSetTravelAllowed: vi.fn(() => true) });
    const travelSwitch = screen.getByRole("switch", {
      name: "Allow party members to jump to you"
    }) as HTMLInputElement;
    fireEvent.click(travelSwitch);
    expect(travelSwitch.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(5_001));
    expect(travelSwitch.disabled).toBe(false);
  });

  it("shows the follower AUTO shortcut from authoritative state", () => {
    const onSetAutoFollow = vi.fn(() => true);
    const followerParty = {
      ...party,
      leaderPlayerId: "ally-1",
      allowTravel: true,
      autoFollowPlayerIds: ["self"],
      revision: 6
    };
    renderHud({ partySnapshot: followerParty, onSetAutoFollow });

    const autoSwitch = screen.getByRole("switch", {
      name: "Automatically jump to the party leader"
    });
    expect((autoSwitch as HTMLInputElement).checked).toBe(true);
    expect(screen.getByLabelText("Double-tap the leader to jump")).toBeTruthy();
    fireEvent.click(autoSwitch);
    expect(onSetAutoFollow).toHaveBeenCalledWith(false);
  });

  it("double-taps the full leader row to travel once while single taps still select", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const onSelectPlayer = vi.fn();
    const onTravelToLeader = vi.fn(() => true);
    renderHud({
      partySnapshot: { ...party, leaderPlayerId: "ally-1", allowTravel: true },
      onSelectPlayer,
      onTravelToLeader
    });
    const leaderRow = screen.getByRole("button", { name: /Target Ally 1/ });

    tap(leaderRow, 12, 12);
    fireEvent.click(leaderRow);
    expect(onSelectPlayer).toHaveBeenCalledWith("ally-1");
    expect(onTravelToLeader).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-01-01T00:00:00.250Z"));
    tap(leaderRow, 13, 12);
    fireEvent.click(leaderRow);
    expect(onTravelToLeader).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date("2026-01-01T00:00:00.300Z"));
    tap(leaderRow, 13, 12);
    vi.setSystemTime(new Date("2026-01-01T00:00:00.500Z"));
    tap(leaderRow, 13, 12);
    expect(onTravelToLeader).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it.each([
    ["local leader", party, true],
    ["travel disabled", { ...party, leaderPlayerId: "ally-1" }, true],
    ["disconnected", { ...party, leaderPlayerId: "ally-1", allowTravel: true }, false]
  ] as const)("suppresses double-tap travel when %s", (_case, partySnapshot, connected) => {
    const onTravelToLeader = vi.fn(() => true);
    renderHud({ partySnapshot, connected, onTravelToLeader });
    const leaderRow = screen.getByRole("button", { name: /Target Ally 1/ });
    tap(leaderRow, 10, 10);
    tap(leaderRow, 10, 10);
    expect(onTravelToLeader).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Double-tap the leader to jump")).toBeNull();
  });
});

describe("PartyCombatHud feature reachability", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("keeps every widget ability reachable: launcher, count, jump switch, member select, leader jump and ready check", () => {
    const onSelectPlayer = vi.fn();
    const onSetTravelAllowed = vi.fn(() => true);
    const onRespondReadyCheck = vi.fn(() => true);
    const store = combatStore();
    store.applyReadyCheck({
      readyCheckId: "rc-1",
      partyId: party.partyId,
      membershipRevision: 5,
      startedByPlayerId: "ally-1",
      startedAt: 1,
      expiresAt: 30_001,
      status: "pending",
      responses: [
        { playerId: "self", response: "pending" },
        { playerId: "ally-1", response: "ready" }
      ]
    });
    render(
      <PartyCombatHud
        store={store}
        party={party}
        ownPlayerId="self"
        selectedPlayerId="ally-2"
        hidden={false}
        connected
        onSetTravelAllowed={onSetTravelAllowed}
        onSetAutoFollow={vi.fn(() => true)}
        onTravelToLeader={vi.fn(() => true)}
        onSelectPlayer={onSelectPlayer}
        onRespondReadyCheck={onRespondReadyCheck}
      />
    );
    // Launcher collapses and reopens; the collapsed launcher shows the party count.
    fireEvent.click(screen.getByRole("button", { name: "Collapse party HUD" }));
    const launcher = screen.getByRole("button", { name: /Expand party HUD/ });
    expect(launcher.querySelector(".party-hud-launcher-count")?.textContent).toBe("5");
    fireEvent.click(launcher);
    // Count, leader jump switch, member rows, ready check.
    expect(screen.getByLabelText("5 of 5 party members")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Allow party members to jump to you" }));
    expect(onSetTravelAllowed).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getAllByRole("button", { name: /^Target / })[0]!);
    expect(onSelectPlayer).toHaveBeenCalledWith("ally-1");
    fireEvent.click(screen.getByRole("button", { name: "Ready" }));
    expect(onRespondReadyCheck).toHaveBeenCalledWith("rc-1", "ready");
    fireEvent.click(screen.getByRole("button", { name: "Not Ready" }));
    expect(onRespondReadyCheck).toHaveBeenCalledWith("rc-1", "not_ready");
  });

  it("keeps the invite banner accept and decline reachable", () => {
    const onAccept = vi.fn(() => true);
    const onDecline = vi.fn(() => true);
    const banner = (
      <PartyInviteBanner
        invites={[invite("invite-1", "a", "a")]}
        hidden={false}
        playerNames={{ a: "Scout" }}
        connected
        onAccept={onAccept}
        onDecline={onDecline}
      />
    );
    const first = render(banner);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onAccept).toHaveBeenCalledWith("invite-1");
    first.unmount();
    render(banner);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onDecline).toHaveBeenCalledWith("invite-1");
  });
});

describe("PartyInviteBanner", () => {
  afterEach(cleanup);
  it("shows inviter, distinct leader, and additional incoming invite count", () => {
    const invites = [
      invite("invite-1", "inviter", "leader"),
      invite("invite-2", "other", "other")
    ];
    render(
      <PartyInviteBanner
        invites={invites}
        hidden={false}
        playerNames={{ inviter: "Scout", leader: "Captain" }}
        connected
        onAccept={vi.fn(() => true)}
        onDecline={vi.fn(() => true)}
      />
    );

    expect(screen.getByText("From Scout · led by Captain · +1 more")).toBeTruthy();
  });

  it("lets a grouped non-leader send the invitation to their leader", () => {
    const onForward = vi.fn(() => true);
    render(
      <PartyInviteBanner
        invites={[invite("invite-1", "inviter", "leader")]}
        hidden={false}
        playerNames={{ inviter: "Scout", leader: "Captain" }}
        connected
        forwardToLeader
        onAccept={vi.fn(() => true)}
        onForward={onForward}
        onDecline={vi.fn(() => true)}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Send to Leader" }));
    expect(onForward).toHaveBeenCalledWith("invite-1");
  });
});

type HudOptions = {
  store?: PartyCombatStore;
  partySnapshot?: PartySnapshot;
  hidden?: boolean;
  connected?: boolean;
  synchronizedNow?: () => number;
  onSelectPlayer?: (playerId: string | null) => void;
  onSetTravelAllowed?: (allowed: boolean) => boolean;
  onSetAutoFollow?: (enabled: boolean) => boolean;
  onTravelToLeader?: () => boolean;
};

function hud(options: HudOptions = {}): React.JSX.Element {
  return (
    <PartyCombatHud
      store={options.store ?? combatStore()}
      party={options.partySnapshot ?? party}
      ownPlayerId="self"
      selectedPlayerId="ally-2"
      hidden={options.hidden ?? false}
      connected={options.connected ?? true}
      {...(options.synchronizedNow ? { synchronizedNow: options.synchronizedNow } : {})}
      onSetTravelAllowed={options.onSetTravelAllowed ?? vi.fn(() => true)}
      onSetAutoFollow={options.onSetAutoFollow ?? vi.fn(() => true)}
      onTravelToLeader={options.onTravelToLeader ?? vi.fn(() => true)}
      onSelectPlayer={options.onSelectPlayer ?? vi.fn()}
      onRespondReadyCheck={vi.fn(() => true)}
    />
  );
}

function renderHud(options: HudOptions = {}) {
  return render(hud(options));
}

function tap(element: Element, x: number, y: number): void {
  fireEvent.pointerDown(element, { pointerId: 1, clientX: x, clientY: y });
  fireEvent.pointerUp(element, { pointerId: 1, clientX: x, clientY: y });
}

function combatStore(
  playerIds: readonly string[] = ["self", "ally-1", "ally-2", "ally-3", "ally-4"]
): PartyCombatStore {
  const activePlayerIds = new Set(playerIds);
  const store = new PartyCombatStore();
  store.applySnapshot({
    type: "PARTY_COMBAT_SNAPSHOT",
    partyId: party.partyId,
    membershipRevision: 5,
    sequence: 1,
    serverTime: 1,
    members: [
      member("self", 0, "Self"),
      member("ally-1", 1, "Ally 1"),
      member("ally-2", 2, "Ally 2"),
      member("ally-3", 3, "Ally 3"),
      member("ally-4", 4, "Ally 4")
    ].filter(({ playerId }) => activePlayerIds.has(playerId))
  });
  return store;
}

function member(
  playerId: string,
  slotIndex: number,
  displayName: string
): PartyCombatMemberSnapshot {
  return {
    playerId,
    slotIndex,
    displayName,
    classId: (["druid", "warrior", "knight", "hunter", null] as const)[slotIndex] ?? null,
    role: slotIndex === 0 ? "healer" : "damage",
    currentHealth: 100 - slotIndex * 10,
    maxHealth: 100,
    lifeState: "alive",
    presence: "online",
    worldRelation: "same_layer",
    distanceMeters: slotIndex * 5
  };
}

function invite(
  invitationId: string,
  inviterPlayerId: string,
  leaderPlayerId: string
): PartyInviteSnapshot {
  return {
    invitationId,
    partyId: party.partyId,
    leaderPlayerId,
    inviterPlayerId,
    targetPlayerId: "self",
    perspective: "incoming",
    status: "pending",
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(1).toISOString(),
    respondedAt: null,
    updatedAt: new Date(0).toISOString()
  };
}
