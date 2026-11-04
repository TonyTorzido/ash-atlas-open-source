import { describe, expect, it } from "vitest";

import type { CombatEntitySnapshot } from "@ash-atlas/shared";

import {
  PERSISTENT_WORLD_DETAIL_FULL_OPACITY_ZOOM,
  PERSISTENT_WORLD_DETAIL_HIDDEN_ZOOM,
  mobAiPresentationText,
  mobBuffPresentation,
  persistentWorldDetailAlphaForZoom,
  playerInvisibilityPresentation,
  rootedControlEffectPresentation,
  shouldRenderMilitaryGroupHealthBar,
  shouldRenderOverheadHealthBar
} from "./pixiOverlay.js";
import { worldHealthBarTone } from "../combat/healthBarPresentation.js";

describe("Pixi combat feedback", () => {
  it("derives persistent world detail opacity purely from map zoom", () => {
    expect(PERSISTENT_WORLD_DETAIL_HIDDEN_ZOOM).toBe(13);
    expect(PERSISTENT_WORLD_DETAIL_FULL_OPACITY_ZOOM).toBe(13.5);
    expect(persistentWorldDetailAlphaForZoom(12.5)).toBe(0);
    expect(persistentWorldDetailAlphaForZoom(13)).toBe(0);
    expect(persistentWorldDetailAlphaForZoom(13.1))
      .toBeLessThan(persistentWorldDetailAlphaForZoom(13.25));
    expect(persistentWorldDetailAlphaForZoom(13.25)).toBe(0.5);
    expect(persistentWorldDetailAlphaForZoom(13.25))
      .toBeLessThan(persistentWorldDetailAlphaForZoom(13.4));
    expect(persistentWorldDetailAlphaForZoom(13.5)).toBe(1);
    expect(persistentWorldDetailAlphaForZoom(14)).toBe(1);
    expect(persistentWorldDetailAlphaForZoom(13.25)).toBe(0.5);
  });

  it("only renders world health bars for damaged or context-active remote combatants", () => {
    expect(shouldRenderOverheadHealthBar("player", true)).toBe(false);
    expect(shouldRenderOverheadHealthBar("player", false)).toBe(false);
    const passive = {
      entityId: "deer",
      currentHealth: 100,
      maxHealth: 100,
      targetEntityId: null,
      activityState: "idle" as const
    };
    expect(shouldRenderOverheadHealthBar("player", true, { ...passive, currentHealth: 1 })).toBe(false);
    expect(shouldRenderOverheadHealthBar("mob", false, passive)).toBe(false);
    expect(shouldRenderOverheadHealthBar("mob", false, { ...passive, currentHealth: 90 })).toBe(false);
    expect(shouldRenderOverheadHealthBar("mob", false, { ...passive, targetEntityId: "other" }, new Set(), "me")).toBe(false);
    expect(shouldRenderOverheadHealthBar("mob", false, { ...passive, activityState: "attacking" })).toBe(false);
    expect(shouldRenderOverheadHealthBar("mob", false, { ...passive, targetEntityId: "me" }, new Set(), "me")).toBe(true);
    expect(shouldRenderOverheadHealthBar("mob", false, passive, new Set(["deer"]))).toBe(true);
    expect(shouldRenderOverheadHealthBar("player", false, { ...passive, currentHealth: 90 })).toBe(true);
  });

  it("always shows Revenant Metal skeleton and Lich health bars to every viewer", () => {
    const skeleton = {
      entityId: "undead-skeleton:1",
      currentHealth: 40,
      maxHealth: 40,
      targetEntityId: null,
      activityState: "idle" as const,
      undead: { ownerPlayerId: "owner", kind: "skeleton" as const, level: 1, expiresAt: 0 }
    };
    const lich = { ...skeleton, entityId: "revenant-lich:1", undead: { ...skeleton.undead, kind: "lich" as const } };
    for (const undead of [skeleton, lich]) {
      expect(shouldRenderOverheadHealthBar("mob", false, undead, new Set(), "owner")).toBe(true);
      expect(shouldRenderOverheadHealthBar("mob", false, undead, new Set(), "stranger")).toBe(true);
      expect(shouldRenderOverheadHealthBar("mob", false, undead)).toBe(true);
    }
    expect(worldHealthBarTone("mob", { ...skeleton, aiPresentation: null, companion: null, hostility: "passive" }, "owner"))
      .toBe("friendly");
    expect(worldHealthBarTone("mob", { ...skeleton, aiPresentation: null, companion: null, hostility: "passive" }, "stranger"))
      .toBe("hostile");
  });

  it("keeps full-health passive military groups quiet while retaining active context", () => {
    const passive = {
      groupId: "group-1",
      currentHp: 100,
      maxHp: 100,
      targetFlagId: null,
      nextFireAt: null
    };
    expect(shouldRenderMilitaryGroupHealthBar(passive)).toBe(false);
    expect(shouldRenderMilitaryGroupHealthBar({ ...passive, currentHp: 90 })).toBe(true);
    expect(shouldRenderMilitaryGroupHealthBar({ ...passive, targetFlagId: "flag-1" })).toBe(true);
    expect(shouldRenderMilitaryGroupHealthBar({ ...passive, nextFireAt: "2026-09-13T00:00:00Z" })).toBe(true);
    expect(shouldRenderMilitaryGroupHealthBar(passive, "group-1")).toBe(true);
  });

  it("hides and removes picking for an authoritative remote Invisible player", () => {
    const invisible = { invisibleUntil: 20_000 } as CombatEntitySnapshot;
    expect(playerInvisibilityPresentation(invisible, false, 10_000)).toEqual({
      visible: false,
      pickable: false,
      alpha: 0
    });
    expect(playerInvisibilityPresentation(invisible, true, 10_000)).toEqual({
      visible: true,
      pickable: true,
      alpha: 0.62
    });
    expect(playerInvisibilityPresentation(invisible, false, 20_000)).toEqual({
      visible: true,
      pickable: true,
      alpha: 1
    });
  });

  it("no longer renders floating mob AI countdown text", () => {
    const entity = {
      aiPresentation: {
        phase: "acquiring",
        intent: "combat",
        deadlineAt: 15_000
      }
    } as CombatEntitySnapshot;
    expect(mobAiPresentationText(entity, 10_001)).toBeNull();
    expect(mobAiPresentationText({
      ...entity,
      aiPresentation: { phase: "observing", intent: "observe", deadlineAt: null }
    }, 10_500)).toBeNull();
  });

  it("prioritizes active ambient speech and falls back after authoritative expiry", () => {
    const entity = {
      ambientSpeech: { text: "Stinky human.", expiresAt: 14_000 },
      aiPresentation: { phase: "observing", intent: "observe", deadlineAt: null }
    } as CombatEntitySnapshot;
    expect(mobAiPresentationText(entity, 13_999)).toBe("Stinky human.");
    expect(mobAiPresentationText(entity, 14_000)).toBeNull();
  });

  it("renders and expires the authoritative rooted countdown", () => {
    const entity = {
      controlEffects: [{ kind: "rooted", endsAt: 13_000 }]
    } as unknown as CombatEntitySnapshot;

    expect(rootedControlEffectPresentation(entity, 10_050)).toEqual({
      remainingMs: 2_950,
      timerText: "Rooted 3.0s"
    });
    expect(rootedControlEffectPresentation(entity, 13_000)).toBeNull();
  });

  it("shows mob buffs as a glow label, naming open-ended ones without a countdown", () => {
    const entity = {
      mobBuffs: [{ kind: "shell", endsAt: 12_500 }, { kind: "enraged", endsAt: 10_000 + 600_000 }]
    } as unknown as CombatEntitySnapshot;
    expect(mobBuffPresentation(entity, 10_000)).toEqual({ kind: "shell", remainingMs: 2_500, timerText: "Shelled 2.5s" });
    expect(mobBuffPresentation(entity, 12_500)).toEqual({ kind: "enraged", remainingMs: 597_500, timerText: "Enraged" });
    expect(mobBuffPresentation({} as unknown as CombatEntitySnapshot, 0)).toBeNull();
  });
});
