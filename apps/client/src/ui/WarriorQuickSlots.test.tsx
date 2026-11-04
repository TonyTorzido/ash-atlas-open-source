import { WARRIOR_LEVEL_XP, type ClassCombatState, type ClassSnapshot, type EquipmentSnapshot, type PveCombatSessionSnapshot } from "@ash-atlas/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { warriorShortcutAction, WarriorQuickSlots } from "./WarriorQuickSlots.js";

describe("Warrior desktop combat quick slots", () => {
  it("renders exactly two unified class skills without Rage, reset controls, or Taunt", () => {
    const html = renderSlots(warriorSnapshot(15));
    expect(html).toContain('aria-label="Warrior class skills"');
    expect((html.match(/class="warrior-quick-slot/g) ?? [])).toHaveLength(2);
    expect(html).toContain("Empowered Hit");
    expect(html).toContain("Anger Explosion");
    expect(html).not.toContain("Next-attack empowers");
    expect(html).not.toContain("class-resource-meter");
    expect(html).not.toContain("universal-taunt-button");
    expect(html).not.toContain("Rage");
  });

  it("shows the second class-skill slot locked until Rank 4", () => {
    const html = renderSlots(warriorSnapshot(3, ["warrior_empowered_hit", null]));
    expect(html).toContain("Class Skill, unlocks at Warrior Rank 4");
    expect(html).toContain("Rank 4</strong><small>Locked");
  });

  it("renders a 15-second cooldown from the single authoritative expiry", () => {
    const now = 5_000;
    const snapshot = warriorSnapshot(15);
    snapshot.serverTime = -115_000;
    const html = renderSlots(snapshot, warriorCombat({ warrior_empowered_hit: now + 15_000 }), () => now);
    expect(html).toContain('class="cooldown-overlay">15');
    expect(html).toContain("Empowered Hit");
  });

  it("maps only keys 1 and 2 to the two unified normal skills", () => {
    const snapshot = warriorSnapshot(15);
    expect(warriorShortcutAction("1", snapshot)).toEqual({ kind: "normal", abilityId: "warrior_empowered_hit" });
    expect(warriorShortcutAction("2", snapshot)).toEqual({ kind: "normal", abilityId: "warrior_anger_explosion" });
    expect(warriorShortcutAction("3", snapshot)).toBeNull();
    expect(warriorShortcutAction("5", snapshot)).toBeNull();
  });
});

const equipment = { playerId: "p", instances: [], weapon: null, chest: null, totalAttackPowerBonus: 0, totalDefenseBonus: 0 } satisfies EquipmentSnapshot;

function renderSlots(snapshot: ClassSnapshot, combat: ClassCombatState = warriorCombat(), synchronizedNow = Date.now): string {
  return renderToStaticMarkup(<WarriorQuickSlots snapshot={snapshot} combat={combat} equipment={equipment} pveCombat={session()} disabled={false} synchronizedNow={synchronizedNow} onUseNormal={() => undefined} onUseReset={() => undefined} onTaunt={() => undefined} />);
}

function warriorSnapshot(level: number, normalActives: readonly [string | null, string | null] = ["warrior_empowered_hit", "warrior_anger_explosion"]): ClassSnapshot {
  return {
    playerId: "p", characterLevel: 25, activeClassId: "warrior", activeSubclassId: null,
    warrior: { classId: "warrior", level, xp: WARRIOR_LEVEL_XP[level]!, nextLevelXp: WARRIOR_LEVEL_XP[level + 1] ?? null, completedAt: null },
    classes: [], subclasses: [], loadout: { resetActives: [null, null], normalActives, passiveTiers: ["warrior_heavy_handed", "warrior_relentless", "warrior_desperate_fury"] },
    legacyIds: [], resource: null, resources: [], rage: 0, maximumRage: 0, queuedAbility: null, cooldownEndsAt: {}, serverTime: Date.now(), revision: 1
  } as unknown as ClassSnapshot;
}

function warriorCombat(cooldownEndsAt: Record<string, number> = {}): ClassCombatState {
  return { activeClassId: "warrior", rage: 0, maximumRage: 0, reservedRage: 0, guard: 0, bloodlust: 0, queuedAbility: null, cooldownEndsAt };
}

function session(): PveCombatSessionSnapshot {
  return { sessionId: "s", focusTargetEntityId: "mob:1", enemyQueue: ["mob:1"], pursuingEnemyIds: [], queueCursor: 0, phase: "waiting_player", nextBasicAttackAt: null, resetWindowEndsAt: null, pendingNormalAbilityId: null, pendingResetAbilityId: null, tauntCooldownEndsAt: 0, activeViewCenter: { lat: 35, lon: -106 }, activeViewRadiusM: 950, activeViewGeneration: 1, lastTauntExcludedByCap: 0 };
}
