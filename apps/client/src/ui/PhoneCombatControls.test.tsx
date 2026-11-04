// @vitest-environment jsdom

import { WARRIOR_LEVEL_XP, type ClassCombatState, type ClassSnapshot, type EquipmentSnapshot, type PveCombatSessionSnapshot } from "@ash-atlas/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PhoneCombatControls } from "./PhoneCombatControls.js";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("Warrior phone combat controls", () => {
  it("renders exactly two class skills with no Ultimate or Taunt", () => {
    const view = renderControls();
    expect(screen.getByRole("button", { name: "Empowered Hit, class skill, ready" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Anger Explosion, class skill, ready" })).toBeTruthy();
    expect(view.container.querySelectorAll(".legacy-skill-button")).toHaveLength(2);
    expect(view.container.querySelector(".legacy-ultimate-button")).toBeNull();
    expect(view.container.querySelector(".legacy-taunt-button")).toBeNull();
    expect(view.container.querySelector(".legacy-resource-perimeter")).toBeNull();
    expect(view.container.querySelector('[data-class-ability-icon="warrior_empowered_hit"]')).toBeTruthy();
    expect(view.container.querySelector('[data-class-ability-icon="warrior_anger_explosion"]')).toBeTruthy();
    expect(view.container.textContent).not.toContain("Rage");
    expect(view.container.textContent).not.toMatch(/Ultimate|Worldbreaker|Mastery/i);
  });

  it("executes both Warrior skills through the unified normal-skill intent", () => {
    const onUseNormal = vi.fn();
    renderControls({ onUseNormal });
    fireEvent.click(screen.getByRole("button", { name: "Empowered Hit, class skill, ready" }));
    fireEvent.click(screen.getByRole("button", { name: "Anger Explosion, class skill, ready" }));
    expect(onUseNormal.mock.calls).toEqual([
      ["warrior_empowered_hit", { mode: "self", targetEntityId: "p" }],
      ["warrior_anger_explosion", { mode: "self", targetEntityId: "p" }]
    ]);
  });

  it("shows the second slot locked until Warrior Rank 4", () => {
    renderControls({ snapshot: warriorSnapshot(3, ["warrior_empowered_hit", null]) });
    expect(screen.getByRole("button", { name: "Class Skill, unlocks at Warrior Rank 4" }).dataset.locked).toBe("true");
  });

  it("derives a stable remaining cooldown from one authoritative expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const snapshot = warriorSnapshot(15);
    snapshot.serverTime = 5_000;
    renderControls({ snapshot, synchronizedNow: () => 5_000, combat: warriorCombat({ warrior_empowered_hit: 20_000 }) });
    expect(screen.getByRole("button", { name: "Empowered Hit, class skill, cooldown 15 seconds" })
      .querySelector(".legacy-cooldown-overlay")?.textContent).toBe("15");
    vi.useRealTimers();
  });

  it("does not inflate cooldowns when the local wall clock moves backward", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let serverNow = 5_000;
    const snapshot = warriorSnapshot(15);
    snapshot.serverTime = 5_000;
    renderControls({
      snapshot,
      synchronizedNow: () => serverNow,
      combat: warriorCombat({
        warrior_empowered_hit: 20_000,
        warrior_anger_explosion: 25_000
      })
    });
    expect(screen.getByRole("button", { name: "Empowered Hit, class skill, cooldown 15 seconds" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Anger Explosion, class skill, cooldown 20 seconds" })).toBeTruthy();

    vi.setSystemTime(-119_000);
    serverNow = 6_000;
    act(() => { vi.advanceTimersByTime(100); });

    expect(screen.getByRole("button", { name: "Empowered Hit, class skill, cooldown 14 seconds" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Anger Explosion, class skill, cooldown 19 seconds" })).toBeTruthy();
  });

  it("glows for the selected ally, clicks that ally, and long-presses self for 500 ms", () => {
    vi.useFakeTimers();
    const onUseNormal = vi.fn();
    renderControls({
      snapshot: druidSnapshot(),
      combat: druidCombat(),
      pveCombat: null,
      targetSelection: {
        mode: "friendly",
        targetEntityId: "ally",
        friendlyTargetEntityId: "ally"
      },
      friendlyTargets: [{
        entityId: "ally",
        label: "Ally",
        available: false,
        unavailableReason: "Selected party member is out of range"
      }],
      onUseNormal
    });
    const heal = screen.getByRole("button", {
      name: "Regrowth, active technique, targeting selected party member, hold for self"
    });
    expect(heal.className).toContain("is-friendly-targeted");
    expect(heal.getAttribute("aria-disabled")).toBe("false");

    fireEvent.click(heal);
    expect(onUseNormal).toHaveBeenLastCalledWith("druid_regrowth", {
      mode: "friendly",
      targetEntityId: "ally"
    });

    onUseNormal.mockClear();
    fireEvent.pointerDown(heal);
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerUp(heal);
    fireEvent.click(heal);
    expect(onUseNormal).toHaveBeenCalledOnce();
    expect(onUseNormal).toHaveBeenCalledWith("druid_regrowth", {
      mode: "self",
      targetEntityId: "p"
    });
  });

  it("defaults click and hold to self without a selected party member", () => {
    vi.useFakeTimers();
    const onUseNormal = vi.fn();
    renderControls({
      snapshot: druidSnapshot(),
      combat: druidCombat(),
      pveCombat: null,
      targetSelection: null,
      friendlyTargets: [],
      onUseNormal
    });
    const heal = screen.getByRole("button", {
      name: "Regrowth, active technique, targeting self"
    });
    expect(heal.className).not.toContain("is-friendly-targeted");
    expect(heal.getAttribute("aria-disabled")).toBe("false");

    fireEvent.click(heal);
    expect(onUseNormal).toHaveBeenLastCalledWith("druid_regrowth", {
      mode: "self",
      targetEntityId: "p"
    });

    onUseNormal.mockClear();
    fireEvent.pointerDown(heal);
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerUp(heal);
    fireEvent.click(heal);
    expect(onUseNormal).toHaveBeenCalledOnce();
    expect(onUseNormal).toHaveBeenCalledWith("druid_regrowth", {
      mode: "self",
      targetEntityId: "p"
    });
  });

  it("uses a hostile PvP selection without PvE and stays disabled with no target", () => {
    const onUseNormal = vi.fn();
    const view = renderControls({
      snapshot: ninjaSnapshot(),
      combat: ninjaCombat(),
      equipment: shurikenEquipment(),
      pveCombat: null,
      targetSelection: { mode: "hostile", targetEntityId: "player:rival" },
      onUseNormal
    });
    fireEvent.click(screen.getByRole("button", { name: "Steel Tempest, active technique, ready" }));
    expect(onUseNormal).toHaveBeenCalledWith("ninja_v2_twin_fang", {
      mode: "hostile",
      targetEntityId: "player:rival"
    });
    view.rerender(<PhoneCombatControls
      snapshot={ninjaSnapshot()} combat={ninjaCombat()} equipment={shurikenEquipment()} pveCombat={null}
      disabled={false} synchronizedNow={Date.now} targetSelection={null}
      onUseNormal={vi.fn()} onUseReset={vi.fn()} onTaunt={vi.fn()}
    />);
    expect(screen.queryByRole("button", { name: /Thousand Shadows|Ultimate/i })).toBeNull();
  });

  it("routes a phone hardware drag hotkey into precision targeting", () => {
    const onBeginDragTarget = vi.fn();
    const onUseNormal = vi.fn();
    renderControls({
      snapshot: ninjaSnapshot(),
      combat: ninjaCombat(),
      equipment: shurikenEquipment(),
      pveCombat: null,
      onBeginDragTarget,
      onUseNormal
    });

    const shadowstep = screen.getByRole("button", { name: "Ghost Step, active technique, ready" });
    expect(shadowstep.getAttribute("aria-disabled")).toBe("false");
    fireEvent.keyDown(document.body, { key: "w", code: "KeyW" });

    expect(onBeginDragTarget).toHaveBeenCalledWith(
      "normal",
      expect.objectContaining({ id: "ninja_v2_shadowstep", activation: "drag" }),
      null
    );
    expect(onUseNormal).not.toHaveBeenCalled();
  });

  it("does not map E or U to a hidden Ultimate control", () => {
    const onUseNormal = vi.fn();
    renderControls({ onUseNormal });

    fireEvent.keyDown(document.body, { key: "e", code: "KeyE" });
    expect(onUseNormal).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "u", code: "KeyU" });
    expect(onUseNormal).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Worldbreaker|Ultimate/i })).toBeNull();
  });
});

const equipment = { playerId: "p", instances: [], weapon: null, chest: null, totalAttackPowerBonus: 0, totalDefenseBonus: 0 } satisfies EquipmentSnapshot;

function shurikenEquipment(): EquipmentSnapshot {
  return { ...equipment, weapon: { weaponCategory: "shuriken" } as never };
}

function renderControls(overrides: Partial<React.ComponentProps<typeof PhoneCombatControls>> = {}) {
  return render(<PhoneCombatControls
    snapshot={warriorSnapshot(15)} combat={warriorCombat()} equipment={equipment} pveCombat={session()}
    disabled={false} synchronizedNow={Date.now} onUseNormal={vi.fn()} onUseReset={vi.fn()} onTaunt={vi.fn()} {...overrides}
  />);
}

function warriorSnapshot(level: number, normalActives: readonly [string | null, string | null] = ["warrior_empowered_hit", "warrior_anger_explosion"]): ClassSnapshot {
  return {
    playerId: "p", characterLevel: 25, activeClassId: "warrior", activeSubclassId: null,
    warrior: { classId: "warrior", level, xp: WARRIOR_LEVEL_XP[level]!, nextLevelXp: WARRIOR_LEVEL_XP[level + 1] ?? null, completedAt: null },
    classes: [], subclasses: [], loadout: { resetActives: [null, null], normalActives, passiveTiers: ["warrior_heavy_handed", "warrior_relentless", "warrior_desperate_fury"], ultimateActive: "warrior_v2_worldbreaker" },
    legacyIds: [], resource: null, resources: [], rage: 0, maximumRage: 0, queuedAbility: null, cooldownEndsAt: {}, serverTime: Date.now(), revision: 1
  } as unknown as ClassSnapshot;
}

function warriorCombat(cooldownEndsAt: Record<string, number> = {}): ClassCombatState {
  return { activeClassId: "warrior", rage: 0, maximumRage: 0, reservedRage: 0, guard: 0, bloodlust: 0, queuedAbility: null, cooldownEndsAt };
}

function druidSnapshot(): ClassSnapshot {
  return {
    ...warriorSnapshot(15),
    activeClassId: "druid",
    classes: [{ classId: "druid", level: 15, xp: 0, nextLevelXp: 1, completedAt: null }],
    loadout: {
      resetActives: [null, null],
      normalActives: ["druid_regrowth", null],
      passiveTiers: [null, null, null],
      ultimateActive: null
    }
  } as unknown as ClassSnapshot;
}

function druidCombat(): ClassCombatState {
  return {
    ...warriorCombat(),
    activeClassId: "druid"
  };
}

function ninjaSnapshot(): ClassSnapshot {
  return {
    ...warriorSnapshot(15),
    activeClassId: "ninja",
    classes: [{ classId: "ninja", level: 15, xp: 0, nextLevelXp: null, completedAt: null }],
    loadout: {
      resetActives: [null, null],
      normalActives: ["ninja_v2_twin_fang", "ninja_v2_shadowstep"],
      passiveTiers: [null, null, null],
      ultimateActive: "ninja_v2_thousand_shadows"
    }
  } as unknown as ClassSnapshot;
}

function ninjaCombat(): ClassCombatState {
  return { ...warriorCombat(), activeClassId: "ninja" };
}

function session(): PveCombatSessionSnapshot {
  return { sessionId: "s", focusTargetEntityId: "mob:1", enemyQueue: ["mob:1"], pursuingEnemyIds: [], queueCursor: 0, phase: "waiting_player", nextBasicAttackAt: null, resetWindowEndsAt: null, pendingNormalAbilityId: null, pendingResetAbilityId: null, tauntCooldownEndsAt: 0, activeViewCenter: { lat: 35, lon: -106 }, activeViewRadiusM: 950, activeViewGeneration: 1, lastTauntExcludedByCap: 0 };
}
