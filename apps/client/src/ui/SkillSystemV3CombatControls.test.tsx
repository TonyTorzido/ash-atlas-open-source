// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SkillSystemV3Snapshot } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillSystemV3CombatControls } from "./SkillSystemV3CombatControls.js";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.uiProfile;
});

describe("SkillSystemV3CombatControls", () => {
  it("renders Basic Attack and two authoritative general slots on desktop", () => {
    const view = renderControls();
    expect(screen.getByRole("button", { name: /Basic Attack/ })).not.toBeNull();
    expect(view.container.querySelectorAll(".skill-v3-general-slot")).toHaveLength(2);
    expect(view.container.querySelectorAll("button")).toHaveLength(3);
    expect(view.container.querySelectorAll(".skill-v3-class-technique-slot")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Shield Charge.*Rank 2.*Implemented/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Cleanse.*Rank 1.*Implemented/i })).not.toBeNull();
    expect(view.container.textContent).not.toMatch(/Ultimate|Worldbreaker|Mastery/i);
  });

  it("routes Q and W to the two general slots and ignores U", () => {
    const onUseGeneral = vi.fn();
    renderControls({ onUseGeneral });
    fireEvent.keyDown(window, { key: "q" });
    fireEvent.keyDown(window, { key: "w" });
    fireEvent.keyDown(window, { key: "u" });
    expect(onUseGeneral.mock.calls).toEqual([["shield_charge"], ["cleanse"]]);
  });

  it("keeps the current General slot IDs and fires one callback per click gesture", () => {
    const onUseGeneral = vi.fn();
    const view = renderControls({ onUseGeneral });
    const slots = Array.from(view.container.querySelectorAll<HTMLButtonElement>(".skill-v3-general-slot"));
    expect(slots.map((slot) => slot.dataset.generalActiveSlot)).toEqual(["1", "2"]);
    const firstSlot = slots[0]!;

    fireEvent.pointerDown(firstSlot, { pointerId: 1, isPrimary: true });
    fireEvent.pointerUp(firstSlot, { pointerId: 1 });
    fireEvent.click(firstSlot);
    expect(onUseGeneral).toHaveBeenCalledTimes(1);
    expect(onUseGeneral).toHaveBeenCalledWith("shield_charge");
  });

  it("uses authoritative and fresher live-combat cooldowns for general skills only", () => {
    renderControls({
      snapshot: snapshot({ cooldownEndsAt: { "v3:general:shield_charge": 15_000 } }),
      runtimeCooldownEndsAt: { "v3:general:cleanse": 30_000 },
      synchronizedNow: () => 10_000
    });
    expect((screen.getByRole("button", { name: /Shield Charge.*on cooldown/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Cleanse.*on cooldown/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("5s")).not.toBeNull();
    expect(screen.getByText("20s")).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/Ultimate|Worldbreaker|Mastery/i);
  });

  it("uses exactly two themed general skill controls on phone without the desktop Basic Attack rail", () => {
    document.documentElement.dataset.uiProfile = "phone";
    const onUseGeneral = vi.fn();
    const view = renderControls({
      layout: "phone",
      snapshot: snapshot(),
      onUseGeneral
    });
    const targets = view.container.querySelectorAll<HTMLButtonElement>(".legacy-control-button.legacy-skill-button");
    expect(targets).toHaveLength(2);
    expect(view.container.querySelector(".skill-v3-basic-slot")).toBeNull();
    expect(view.container.querySelector(".skill-v3-combat-controls--phone")).toBeNull();
    expect(targets[0]?.classList.contains("legacy-skill-one-button")).toBe(true);
    expect(targets[1]?.classList.contains("legacy-skill-two-button")).toBe(true);
    Array.from(targets).forEach((target) => {
      expect(getComputedStyle(target).minWidth).toBe("44px");
      expect(getComputedStyle(target).minHeight).toBe("44px");
    });
    fireEvent.click(screen.getByRole("button", { name: /Shield Charge/ }));
    expect(onUseGeneral).toHaveBeenCalledWith("shield_charge");
    expect(view.container.textContent).not.toMatch(/Ultimate|Worldbreaker|Mastery/i);
  });
});

function renderControls(overrides: Partial<React.ComponentProps<typeof SkillSystemV3CombatControls>> = {}) {
  return render(<SkillSystemV3CombatControls snapshot={snapshot()} layout="desktop" disabled={false}
    synchronizedNow={() => 10_000} onUseGeneral={vi.fn()} {...overrides} />);
}

function snapshot(overrides: Partial<SkillSystemV3Snapshot> = {}): SkillSystemV3Snapshot {
  return {
    fullBuildRespecAvailable: false,
    fullClassRosterEnabled: true,
    ultimatesEnabled: false,
    playerId: "p",
    characterLevel: 25,
    pointState: { totalEarned: 50, totalSpent: 20, available: 30, revision: 7 },
    generalSkills: [
      { skillId: "shield_charge", rank: 2, pointsSpent: 2 },
      { skillId: "cleanse", rank: 1, pointsSpent: 1 }
    ],
    specializations: [{ specializationId: "warrior", rank: 5, pointsSpent: 8, grandfathered: false, masteryQuestCompleted: true }],
    committedSpecializationId: "warrior",
    activeSpecializationId: "warrior",
    equippedClassTechniqueId: null,
    generalActiveLoadout: ["shield_charge", "cleanse"],
    ultimate: { id: "warrior_v2_worldbreaker", specializationId: "warrior", status: "ready" },
    cooldownEndsAt: { "ultimate:warrior:warrior_v2_worldbreaker": 30_000 },
    worldKnowledge: [],
    serverTime: 10_000,
    revision: 7,
    ...overrides
  };
}
