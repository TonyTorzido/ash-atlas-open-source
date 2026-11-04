// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  WARRIOR_LEVEL_XP,
  type ClassCombatState,
  type ClassSnapshot,
  type EquipmentSnapshot,
  type PveCombatSessionSnapshot
} from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClassQuickSlots, ownedLegacyClassShortcutAction, skillHotkeySlot } from "./WarriorQuickSlots.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ClassQuickSlots skill hotkeys", () => {
  it("maps the displayed Q/W keys to the same canonical click actions", () => {
    const onUseNormal = vi.fn();
    const onTaunt = vi.fn();
    render(<ClassQuickSlots {...props()} onUseNormal={onUseNormal} onTaunt={onTaunt} />);
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-keyshortcuts"))).toEqual(["1 Q", "2 W"]);
    expect(screen.queryByRole("button", { name: /Worldbreaker|Ultimate/ })).toBeNull();
    const explosion = screen.getByRole("button", { name: /Anger Explosion/ });
    expect(explosion.getAttribute("aria-keyshortcuts")).toBe("2 W");
    expect(explosion.textContent).toContain("W");

    fireEvent.click(explosion);
    const clickArguments = onUseNormal.mock.calls[0];
    onUseNormal.mockClear();
    fireEvent.keyDown(window, { key: "w", code: "KeyW" });
    expect(onUseNormal).toHaveBeenCalledTimes(1);
    expect(onUseNormal.mock.calls[0]).toEqual(clickArguments);

    fireEvent.keyDown(window, { key: "u", code: "KeyU" });
    expect(screen.queryByRole("button", { name: /Worldbreaker|Ultimate/i })).toBeNull();

    fireEvent.keyDown(window, { key: "t", code: "KeyT" });
    expect(onTaunt).not.toHaveBeenCalled();
    expect(skillHotkeySlot({ key: "t", code: "KeyT" })).toBe(4);
    expect(ownedLegacyClassShortcutAction("1", snapshot(), true)).toBeNull();
  });

  it("routes a retained drag-loadout hotkey through the existing normal-use fallback", () => {
    const onUseNormal = vi.fn();
    const onBeginDragTarget = vi.fn();
    render(<ClassQuickSlots
      {...props({ snapshot: dragSnapshot(), equipment: axeEquipment() })}
      onUseNormal={onUseNormal}
      onBeginDragTarget={onBeginDragTarget}
    />);

    fireEvent.keyDown(window, { key: "q", code: "KeyQ" });

    expect(onBeginDragTarget).not.toHaveBeenCalled();
    expect(onUseNormal).toHaveBeenCalledWith("warrior_v2_faultline", expect.objectContaining({ mode: "hostile" }));
  });

  it("ignores typing, modifiers, key repeat, and duplicate handling from one keydown", () => {
    const onUseNormal = vi.fn();
    render(<><input aria-label="Chat message" /><ClassQuickSlots {...props()} onUseNormal={onUseNormal} /></>);
    const input = screen.getByRole("textbox", { name: "Chat message" });
    input.focus();
    fireEvent.keyDown(input, { key: "w", code: "KeyW" });
    fireEvent.keyDown(window, { key: "w", code: "KeyW", ctrlKey: true });
    expect(onUseNormal).not.toHaveBeenCalled();

    input.blur();
    fireEvent.keyDown(window, { key: "w", code: "KeyW" });
    fireEvent.keyDown(window, { key: "w", code: "KeyW", repeat: true });
    expect(onUseNormal).toHaveBeenCalledTimes(1);
  });

  it("cannot bypass disabled, unavailable, pending, or cooldown guards", () => {
    const onUseNormal = vi.fn();
    const view = render(<ClassQuickSlots {...props({ disabled: true })} onUseNormal={onUseNormal} />);
    fireEvent.keyDown(window, { key: "w", code: "KeyW" });
    expect(onUseNormal).not.toHaveBeenCalled();

    view.rerender(<ClassQuickSlots {...props({ combat: combat({ cooldownEndsAt: { warrior_anger_explosion: Date.now() + 30_000 } }) })} onUseNormal={onUseNormal} />);
    fireEvent.keyDown(window, { key: "w", code: "KeyW" });
    expect(onUseNormal).not.toHaveBeenCalled();

    view.rerender(<ClassQuickSlots {...props({ pveCombat: session({ pendingNormalAbilityId: "warrior_anger_explosion" }) })} onUseNormal={onUseNormal} />);
    fireEvent.keyDown(window, { key: "w", code: "KeyW" });
    expect(onUseNormal).not.toHaveBeenCalled();
  });

  it("yields only to a real modal or the open Game Menu, not to non-modal windows such as chat", () => {
    const visible = (element: HTMLElement | null): void => {
      if (element) element.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 100, top: 0, left: 0, right: 200, bottom: 100, toJSON: () => ({}) });
    };
    const onUseNormal = vi.fn();
    // Chat (a non-modal dialog) is open: the skill key still works.
    const view = render(<><div role="dialog" aria-label="Chat" ref={visible} /><ClassQuickSlots {...props()} onUseNormal={onUseNormal} /></>);
    fireEvent.keyDown(window, { key: "w", code: "KeyW" });
    expect(onUseNormal).toHaveBeenCalledTimes(1);
    onUseNormal.mockClear();
    // A real modal owns the keyboard.
    view.rerender(<><div role="dialog" aria-modal="true" aria-label="Modal" ref={visible} /><ClassQuickSlots {...props()} onUseNormal={onUseNormal} /></>);
    fireEvent.keyDown(window, { key: "w", code: "KeyW" });
    expect(onUseNormal).not.toHaveBeenCalled();
    // So does the open Game Menu.
    view.rerender(<><div className="phone-hud phone-hud-menu-open" ref={visible} /><ClassQuickSlots {...props()} onUseNormal={onUseNormal} /></>);
    fireEvent.keyDown(window, { key: "w", code: "KeyW" });
    expect(onUseNormal).not.toHaveBeenCalled();
  });

  it("uses the canonical compact prompt for long-press ability details", () => {
    vi.useFakeTimers();
    const onUseNormal = vi.fn();
    const view = render(<ClassQuickSlots {...props()} onUseNormal={onUseNormal} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /Anger Explosion/ }));
    act(() => {
      vi.advanceTimersByTime(500);
    });

    const close = screen.getByRole("button", { name: "Close" });
    expect(close.closest("aside")?.classList.contains("game-compact-prompt")).toBe(true);
    expect(onUseNormal).not.toHaveBeenCalled();
    act(() => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
      document.body.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 5, clientY: 5 }));
    });
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });
});

function props(overrides: {
  disabled?: boolean;
  combat?: ClassCombatState;
  pveCombat?: PveCombatSessionSnapshot | null;
  snapshot?: ClassSnapshot;
  equipment?: EquipmentSnapshot;
} = {}) {
  return {
    snapshot: overrides.snapshot ?? snapshot(),
    combat: overrides.combat ?? combat(),
    equipment: overrides.equipment ?? equipment(),
    pveCombat: overrides.pveCombat === undefined ? session() : overrides.pveCombat,
    disabled: overrides.disabled ?? false,
    synchronizedNow: Date.now,
    onUseNormal: vi.fn(),
    onUseReset: vi.fn(),
    onTaunt: vi.fn()
  };
}

function dragSnapshot(): ClassSnapshot {
  const value = snapshot();
  value.loadout = {
    ...value.loadout,
    normalActives: ["warrior_v2_faultline", "warrior_v2_iron_reversal"],
    ultimateActive: "warrior_v2_worldbreaker"
  };
  return value;
}

function axeEquipment(): EquipmentSnapshot {
  return { ...equipment(), weapon: { weaponCategory: "axe" } as never };
}

function snapshot(): ClassSnapshot {
  return {
    playerId: "p1", characterLevel: 25, activeClassId: "warrior", activeSubclassId: null,
    warrior: { classId: "warrior", level: 25, xp: WARRIOR_LEVEL_XP[25]!, nextLevelXp: null, completedAt: null },
    subclasses: [{ subclassId: "reaver", unlocked: false }, { subclassId: "warden", unlocked: false }],
    loadout: {
      resetActives: [null, null],
      normalActives: ["warrior_empowered_hit", "warrior_anger_explosion"],
      passiveTiers: ["warrior_heavy_handed", "warrior_relentless", "warrior_last_stand"],
      ultimateActive: "warrior_v2_worldbreaker"
    },
    legacyIds: [], rage: 100, maximumRage: 100, queuedAbility: null, cooldownEndsAt: {},
    serverTime: Date.now(), revision: 1
  };
}

function combat(overrides: Partial<ClassCombatState> = {}): ClassCombatState {
  return {
    rage: 100, maximumRage: 100, reservedRage: 0, guard: 0, bloodlust: 0,
    queuedAbility: null, cooldownEndsAt: {}, ...overrides
  };
}

function equipment(): EquipmentSnapshot {
  return { playerId: "p1", instances: [], weapon: null, chest: null, totalAttackPowerBonus: 0, totalDefenseBonus: 0 };
}

function session(overrides: Partial<PveCombatSessionSnapshot> = {}): PveCombatSessionSnapshot {
  return {
    sessionId: "session-1", focusTargetEntityId: "mob:1", enemyQueue: ["mob:1"], pursuingEnemyIds: [],
    queueCursor: 0, phase: "enemy_pending", nextBasicAttackAt: null, resetWindowEndsAt: Date.now() + 400,
    pendingNormalAbilityId: null, pendingResetAbilityId: null, tauntCooldownEndsAt: 0,
    activeViewCenter: { lat: 35, lon: -106 }, activeViewRadiusM: 950, activeViewGeneration: 1,
    lastTauntExcludedByCap: 0, ...overrides
  };
}
