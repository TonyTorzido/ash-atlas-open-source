// @vitest-environment jsdom

import type { PublicProfile } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlayerTapMenu, playerRelation, type PlayerRelation } from "./PlayerTapMenu.js";

afterEach(cleanup);

function profile(overrides: Partial<PublicProfile> = {}): PublicProfile {
  return {
    playerId: "00000000-0000-4000-8000-000000000002",
    displayName: "Other Player",
    level: 12,
    class: { id: "warrior", name: "Warrior" },
    kingdom: null,
    settlement: null,
    isSelf: false,
    presence: "online",
    relationship: { friendship: "none", enemyMarkedByViewer: false },
    ...overrides
  } as PublicProfile;
}

function renderMenu(relation: PlayerRelation, extra: Partial<React.ComponentProps<typeof PlayerTapMenu>> = {}) {
  const props = { onAttack: vi.fn(), onViewProfile: vi.fn(), onClose: vi.fn() };
  render(<PlayerTapMenu profile={profile()} relation={relation} {...props} {...extra} />);
  return props;
}

const labels = (): (string | null)[] => screen.getAllByRole("button").map((button) => button.textContent);

describe("playerRelation", () => {
  it("ranks enemy over friend and falls back to neutral", () => {
    expect(playerRelation(profile())).toBe("neutral");
    expect(playerRelation(profile(), { partyMember: true })).toBe("friend");
    expect(playerRelation(profile({ kingdom: { id: "k1", name: "K" } }), { viewerKingdomId: "k1" })).toBe("friend");
    expect(playerRelation(profile({ settlement: { id: "c1", name: "C" } }), { viewerSettlementId: "c1" })).toBe("friend");
    expect(playerRelation(profile({ relationship: { friendship: "friends", enemyMarkedByViewer: false } }))).toBe("friend");
    expect(playerRelation(profile({ relationship: { friendship: "none", enemyMarkedByViewer: true } }))).toBe("enemy");
    expect(playerRelation(profile(), { partyMember: true, revenge: true })).toBe("enemy");
    expect(playerRelation(profile(), { atWar: true })).toBe("enemy");
  });
});

describe("PlayerTapMenu", () => {
  it("shows name, level and class plus the PvP status, with no legacy rows or close glyph", () => {
    renderMenu("neutral", { pvpStatusLabel: "Your aggressor · 18h" });
    expect(screen.getByRole("heading", { name: "Other Player" })).toBeTruthy();
    expect(screen.getByText("Level 12 · Warrior")).toBeTruthy();
    expect(screen.getByText("Your aggressor · 18h")).toBeTruthy();
    expect(screen.queryByText("Kingdom")).toBeNull();
    expect(screen.queryByText("Home")).toBeNull();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });

  it("offers no Attack for a friend", () => {
    renderMenu("friend");
    expect(labels()).toEqual(["View Profile", "Cancel"]);
  });

  it("asks before attacking a neutral player, then shows skills", () => {
    const onSkill = vi.fn();
    const props = renderMenu("neutral", {
      skillActions: [{ key: "edict-stride", label: "Edict Stride", onSelect: onSkill }]
    });
    expect(screen.queryByRole("button", { name: "Edict Stride" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Attack" }));
    expect(props.onAttack).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Attack Other Player?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Attack" }));
    expect(props.onAttack).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002");
    fireEvent.click(screen.getByRole("button", { name: "Edict Stride" }));
    expect(onSkill).toHaveBeenCalledOnce();
  });

  it("tells a neutral player's confirm that it is one swing", () => {
    renderMenu("neutral", { attackOneSwing: true });
    fireEvent.click(screen.getByRole("button", { name: "Attack" }));
    expect(screen.getByText("You'll land one hit, then can't attack them for 20h unless they fight back. An Aggressive player fights back at once.")).toBeTruthy();
  });

  it("attacks an enemy immediately and lists skills", () => {
    const props = renderMenu("enemy", {
      skillActions: [{ key: "pet-bite", label: "Bite 4s", enabled: false, cooling: true, onSelect: vi.fn() }, { key: "gone", label: "Hidden Skill", enabled: false, onSelect: vi.fn() }]
    });
    expect(screen.getByRole("button", { name: "Bite 4s" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Hidden Skill" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Attack" }));
    expect(props.onAttack).toHaveBeenCalledOnce();
  });

  it("hides Attack when the client knows the server would refuse", () => {
    renderMenu("neutral", { attackBlocked: true });
    expect(screen.queryByRole("button", { name: "Attack" })).toBeNull();
    expect(labels()).toEqual(["View Profile", "Cancel"]);
  });

  it("routes View Profile and offers no Message", () => {
    const props = renderMenu("friend");
    expect(screen.queryByRole("button", { name: "Message" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View Profile" }));
    expect(props.onViewProfile).toHaveBeenCalledOnce();
  });
});
