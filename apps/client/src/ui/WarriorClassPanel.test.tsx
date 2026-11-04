// @vitest-environment jsdom

import {
  CLASS_DEFINITIONS,
  CLASS_IDS,
  SUBCLASS_CLASS_IDS,
  SUBCLASS_IDS,
  type ClassSnapshot,
  type ClassCombatState,
  type MasterySnapshot,
  type ProgressionSnapshot
} from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { equipClassAbilityToSlot, WarriorClassPanel } from "./WarriorClassPanel.js";

afterEach(cleanup);

describe("launch progression panel", () => {
  it("keeps the phone Classes and Professions destinations strictly separate", () => {
    const classes = renderPhonePanel("warrior");
    expect(classes).toMatch(/id="phone-classes-title"[^>]*>.*<strong[^>]*>Classes<\/strong>/s);
    expect(classes).not.toContain("Current class summary");
    expect(classes).not.toContain("Active loadout");
    expect(classes).not.toContain(">Woodcutter</button>");
    expect(classes).not.toContain(">Miner</button>");
    expect(classes).not.toContain(">Builder</button>");
    expect(classes).not.toContain(">Hunter</button>");
    for (const className of ["Warrior", "Ranger", "Ninja", "Knight", "Druid"]) {
      expect(classes).toContain(`<strong>${className}</strong>`);
    }

    const professions = renderPhonePanel("woodcutter");
    for (const profession of ["Woodcutter", "Miner", "Builder", "Oil Worker", "Metallurgy"]) {
      expect(professions).toContain(`>${profession}</button>`);
    }
    for (const retired of ["Hunter", "Breeder"]) expect(professions).not.toContain(`>${retired}</button>`);
    expect(professions).not.toContain(">Warrior</button>");
    expect(professions).not.toContain("Warrior mastery");
    expect(professions).not.toContain("Master Warrior");
    expect(professions).not.toContain("<progress");
    expect(professions).toContain('role="progressbar"');
    expect(professions).toContain('data-milestone="2"');
    expect(professions).toContain('data-milestone="5"');
    expect(professions).toContain('data-milestone="8"');
  });

  it("shows the Classes destination and all independent professions without subclasses", () => {
    const html = renderPanel("character");
    for (const name of ["Character", "Classes", "Woodcutter", "Miner", "Builder", "Oil Worker", "Metallurgy"]) {
      expect(html).toContain(`>${name}</button>`);
    }
    for (const hidden of ["Reaver", "Warden", "Subclass"]) expect(html).not.toContain(`>${hidden}</button>`);
    expect(html).toContain("Character Level 5/25");
    expect(html).toContain("Character Progression Curve V3");
    expect(html).toContain('aria-valuemax="1000000"');
  });

  it("renders Warrior through the shared class layout with earned mastery ranks", () => {
    const html = renderPanel("warrior");
    expect(html).toContain("Rank 15 / 15");
    expect(html).toContain("Unrelenting Rage");
    expect(html).toContain("Permanent class innate");
    expect(html).toContain("Class Skills");
    expect(html).toContain('aria-label="Warrior details"');
    expect(html).toContain('aria-selected="true">Innate</button>');
    expect(html).not.toContain("Passive Slot 1");
    expect(html).not.toContain("Double Axe Mastery bonuses by rank");
    expect(html).not.toContain("Taunt");
    expect(html).toContain("72,000 total Warrior XP");
    expect(html).toContain('aria-label="Warrior Rank 15 progress"');
    expect(html).toContain('aria-valuemax="1"');
    expect(html).toContain('aria-valuenow="1"');
  });

  it("keeps innates non-selectable and shows authoritative Warrior and Ranger state", () => {
    const warriorCombat = combatState({
      id: "warrior_unrelenting_rage",
      maxHealthBonus: 30,
      damageBonus: 2
    });
    const view = render(<WarriorClassPanel
      open initialSection="warrior" snapshot={classSnapshot()} progression={progression()} masteries={masteries()}
      combat={warriorCombat} synchronizedNow={() => 1_000}
      busy={false} devProgressionVisible={false} devProgressionOpen={false}
      devProgressionPendingType={null} devProgressionError={null} devSubclassPending={null}
      onClose={() => undefined} onLoadout={() => undefined} onClass={() => undefined}
      onSubclass={() => undefined} onSetDevSubclassUnlock={() => undefined}
      onAdjustDevProgression={() => undefined} onToggleDevProgression={() => undefined}
    />);
    expect(screen.getByRole("tab", { name: "Innate" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Unrelenting Rage" })).toBeTruthy();
    expect(screen.getByText("+2 damage tier")).toBeTruthy();
    expect(screen.getByText("+30 maximum HP")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Unrelenting Rage/ })).toBeNull();

    view.unmount();
  });

  it("offers locked classes without a Gold cost", () => {
    const snapshot = classSnapshot();
    snapshot.activeClassId = "knight";
    snapshot.unlockedClassIds = ["warrior"];
    const html = renderPhonePanel("warrior", snapshot);
    expect(html).toContain("No Gold required");
    expect(html).toContain("Unlock at no cost");
    expect(html).toContain(">Free</span>");
    expect(html).not.toContain("50k Gold");
    expect(html).not.toContain("50,000 Gold");
  });

  it("shows current-rank class XP and explicit equipment mastery ranks", () => {
    const snapshot = classSnapshot();
    snapshot.activeClassId = "knight";
    snapshot.unlockedClassIds = ["warrior", "knight"];
    snapshot.classes = snapshot.classes!.map((entry) => entry.classId === "knight"
      ? { ...entry, level: 1, xp: 1_348, nextLevelXp: 2_600 }
      : entry);
    const html = renderPhonePanel("warrior", snapshot);
    expect(html).toContain("155 / 1,407 Rank XP");
    expect(html).toContain("1,252 XP to Rank 2");
    expect(html).toContain('aria-label="Knight Rank 1 progress"');
    expect(html).toContain('aria-valuemax="1407"');
    expect(html).toContain('aria-valuenow="155"');

    const { unmount } = render(<WarriorClassPanel
      open layout="phone" initialSection="warrior" snapshot={snapshot} progression={progression()} masteries={masteries()}
      combatResource={null} busy={false} devProgressionVisible={false} devProgressionOpen={false}
      devProgressionPendingType={null} devProgressionError={null} devSubclassPending={null}
      onClose={() => undefined} onLoadout={() => undefined} onClass={() => undefined}
      onSubclass={() => undefined} onSetDevSubclassUnlock={() => undefined}
      onAdjustDevProgression={() => undefined} onToggleDevProgression={() => undefined}
    />);
    fireEvent.click(screen.getByRole("tab", { name: "Mastery" }));
    for (const milestone of ["Rank 5", "Rank 9", "Rank 13", "Rank 6", "Rank 10", "Rank 14"]) {
      expect(screen.getByText(milestone)).toBeTruthy();
    }
    expect(document.querySelector('[data-earned="true"]')).toBeNull();
    unmount();
  });

  it("lets an unlocked non-current Warrior class become active", () => {
    const onClass = vi.fn();
    const snapshot = classSnapshot();
    snapshot.activeClassId = "knight";
    snapshot.unlockedClassIds = ["warrior", "knight"];
    const { unmount } = render(<WarriorClassPanel
      open layout="phone" initialSection="warrior" snapshot={snapshot} progression={progression()} masteries={masteries()}
      combatResource={null} busy={false} devProgressionVisible={false} devProgressionOpen={false}
      devProgressionPendingType={null} devProgressionError={null} devSubclassPending={null}
      onClose={() => undefined} onLoadout={() => undefined} onClass={onClass}
      onSubclass={() => undefined} onSetDevSubclassUnlock={() => undefined}
      onAdjustDevProgression={() => undefined} onToggleDevProgression={() => undefined}
    />);

    const knight = screen.getByRole("button", { name: /Knight Unlocked Equipped Rank 0/ });
    const warrior = screen.getByRole("button", { name: /Warrior Unlocked Rank 15/ });
    expect(knight.getAttribute("aria-current")).toBe("true");
    expect(knight.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(warrior);
    expect(warrior.getAttribute("aria-pressed")).toBe("true");
    expect(knight.getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Equip Warrior" }));
    expect(onClass).toHaveBeenCalledOnce();
    expect(onClass).toHaveBeenCalledWith("warrior");
    unmount();
  });

  it("equips either class-skill slot explicitly and preserves passive state", () => {
    const initial = classSnapshot().loadout;
    const faultline = equipClassAbilityToSlot(initial, "warrior", "warrior_v2_faultline", 15, 0);
    expect(faultline.resetActives).toEqual([null, null]);
    expect(faultline.normalActives).toEqual(["warrior_v2_faultline", "warrior_v2_iron_reversal"]);
    const roar = equipClassAbilityToSlot(faultline, "warrior", "warrior_v2_rallying_roar", 15, 1);
    expect(roar.normalActives).toEqual(["warrior_v2_faultline", "warrior_v2_rallying_roar"]);
    expect(roar.passiveTiers).toEqual(initial.passiveTiers);
    expect(roar.ultimateActive).toEqual(initial.ultimateActive);
    expect(equipClassAbilityToSlot(initial, "warrior", "warrior_v2_faultline", 3, 1)).toBe(initial);
  });

  it("groups four class skills and offers one passive choice per tier", () => {
    const onLoadout = vi.fn();
    const { unmount } = render(<WarriorClassPanel
      open initialSection="warrior" snapshot={classSnapshot()} progression={progression()} masteries={masteries()}
      combatResource={null} busy={false} devProgressionVisible={false} devProgressionOpen={false}
      devProgressionPendingType={null} devProgressionError={null} devSubclassPending={null}
      onClose={() => undefined} onLoadout={onLoadout} onClass={() => undefined}
      onSubclass={() => undefined} onSetDevSubclassUnlock={() => undefined}
      onAdjustDevProgression={() => undefined} onToggleDevProgression={() => undefined}
    />);

    fireEvent.click(screen.getByRole("tab", { name: "Class Skills" }));
    expect(screen.getByRole("tab", { name: "Class Skills" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Class Skills" })).toBeTruthy();
    for (const name of ["Cleave", "Iron Reversal", "Blood Rush", "Rallying Roar"]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
    const faultlineCard = screen.getByRole("heading", { name: "Blood Rush" }).closest("article")!;
    fireEvent.click(within(faultlineCard).getByRole("button", { name: "Equip 1" }));
    expect(onLoadout).toHaveBeenLastCalledWith({
      resetActives: [null, null],
      normalActives: ["warrior_v2_faultline", "warrior_v2_iron_reversal"],
      passiveTiers: ["warrior_heavy_handed", "warrior_relentless", null],
      ultimateActive: null
    });
    const activeSection = screen.getByRole("heading", { name: "Class Skills" }).closest("section")!;
    const iconIds = Array.from(activeSection.querySelectorAll<SVGElement>("[data-class-ability-icon]"))
      .map((icon) => icon.dataset.classAbilityIcon);
    expect(new Set(iconIds).size).toBe(4);
    expect(activeSection.textContent).not.toMatch(/Replace Key|Assign Key|Equip to Key|Slot [1-4]/);

    fireEvent.click(screen.getByRole("tab", { name: "Passives" }));
    expect(screen.queryByRole("heading", { name: "Class Skills" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Passive Slot 1" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Bloodthirst" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Battle Hardened" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Mastery" }));
    expect(screen.getByText("Axe Mastery")).toBeTruthy();
    expect(screen.getByText("Breastplate Mastery")).toBeTruthy();
    expect(screen.getAllByText("Master Warrior")).toHaveLength(2);
    unmount();
  });

  it("surfaces Ninja's single-level inherent trait without a scaling bonus", () => {
    const snapshot = classSnapshot();
    snapshot.activeClassId = "ninja";
    snapshot.unlockedClassIds = ["warrior", "ninja"];
    snapshot.classes = snapshot.classes!.map((entry) => entry.classId === "ninja"
      ? { ...entry, level: 15, xp: 72_000 }
      : entry);
    const view = render(<WarriorClassPanel
      open initialSection="warrior" snapshot={snapshot} progression={progression()} masteries={masteries()}
      combatResource={null} busy={false} devProgressionVisible={false} devProgressionOpen={false}
      devProgressionPendingType={null} devProgressionError={null} devSubclassPending={null}
      onClose={() => undefined} onLoadout={() => undefined} onClass={() => undefined}
      onSubclass={() => undefined} onSetDevSubclassUnlock={() => undefined}
      onAdjustDevProgression={() => undefined} onToggleDevProgression={() => undefined}
    />);

    fireEvent.click(within(view.container).getByRole("tab", { name: "Mastery" }));
    const inherent = within(view.container).getByText("Close-Quarters Shuriken").closest<HTMLElement>(".class-mastery-trait")!;
    expect(within(inherent).getByText("Inherent trait")).toBeTruthy();
    expect(within(inherent).getByText("Rank 1")).toBeTruthy();
    expect(within(inherent).queryByText("+1")).toBeNull();
    expect(inherent.textContent).toContain("does not automatically switch to a melee weapon");
  });

  it.each([
    ["woodcutter", "8% speed / 8% bonus / 4% instant / 5% rhythm"],
    ["miner", "8% speed / 8% bonus / 3% instant / 3% unbroken"],
    ["builder", "8% general / 8% flag / 8% reinforcement / 3% recovery"]
  ] as const)("renders exact %s profession mastery values", (track, description) => {
    const html = renderPanel(track);
    expect(html).toContain(description);
    expect(html).toContain("Rank 8/8");
    expect(html).toContain("Mastered");
    expect(html).toContain("100,000 / 100,000 XP");
    expect(html).not.toContain("profession-summary-grid");
  });

  it("renders the exact Oil Worker curve and mastery total", () => {
    const html = renderPanel("oil_worker");
    expect(html).toContain("25,000 / 25,000 XP");
    expect(html).toContain("150 capacity and remote harvest");
  });

  it("exposes the Well Gauge at Rank 2 without granting remote monitoring before Rank 4", () => {
    const rankTwo = masteries();
    rankTwo.professions.oil_worker = {
      ...rankTwo.professions.oil_worker,
      xp: 1_804,
      rank: 2,
      mastered: false,
      completedAt: null,
      nextRankXp: 3_262
    };
    const html = renderToStaticMarkup(<WarriorClassPanel
      open initialSection="oil_worker" snapshot={classSnapshot()} progression={progression()} masteries={rankTwo}
      combatResource={null} busy={false} devProgressionVisible={false} devProgressionOpen={false}
      devProgressionPendingType={null} devProgressionError={null} devSubclassPending={null}
      oilWellStructureId="well-1"
      onClose={() => undefined} onLoadout={() => undefined} onClass={() => undefined}
      onSubclass={() => undefined} onSetDevSubclassUnlock={() => undefined}
      onAdjustDevProgression={() => undefined} onToggleDevProgression={() => undefined}
    />);
    expect(html).toContain("Well Gauge");
    expect(html).toContain("Inspect your Oil Well in person for authoritative gauge timing.");
    expect(html).not.toContain("Loading authoritative well status");

    const gauge = renderToStaticMarkup(<WarriorClassPanel
      open initialSection="oil_worker" snapshot={classSnapshot()} progression={progression()} masteries={rankTwo}
      combatResource={null} busy={false} devProgressionVisible={false} devProgressionOpen={false}
      devProgressionPendingType={null} devProgressionError={null} devSubclassPending={null}
      oilWell={{
        structureId: "well-1", ownerPlayerId: "p1", ownerUsername: "p1",
        storedCrudeOil: 17, capacity: 128, productionPerHour: 10, serverTime: 0,
        nextUnitAt: new Date(6 * 60_000).toISOString(),
        fullAt: new Date(111 * 6 * 60_000).toISOString(),
        canHarvest: true, canDestroy: true
      }}
      oilWellStructureId="well-1"
      onClose={() => undefined} onLoadout={() => undefined} onClass={() => undefined}
      onSubclass={() => undefined} onSetDevSubclassUnlock={() => undefined}
      onAdjustDevProgression={() => undefined} onToggleDevProgression={() => undefined}
    />);
    expect(gauge).toContain("17 / 128 Crude");
    expect(gauge).toContain("Full in 11h 6m");
  });

  it("provides Character Level and all five profession controls without class-rank controls", () => {
    const html = renderPanel("builder", true, true, true);
    expect(html).toContain('aria-label="Decrease Character level"');
    expect(html).toContain('aria-label="Increase Character level"');
    expect(html).toContain('aria-label="Character level">5/25');
    for (const track of ["Woodcutter", "Miner", "Builder", "Oil Worker", "Metallurgy"]) {
      expect(html).toContain(`aria-label="Decrease ${track} rank"`);
      expect(html).toContain(`aria-label="Increase ${track} rank"`);
    }
    for (const retired of ["Hunter", "Breeder"]) expect(html).not.toContain(`aria-label="${retired} rank"`);
    for (const className of ["Warrior", "Ranger", "Ninja"]) {
      expect(html).not.toContain(`aria-label="${className} rank"`);
      expect(html).not.toContain(`aria-label="Increase ${className} rank"`);
    }
    expect(html).not.toContain(">Character 25</button>");
  });

  it("shows the equipped mastery title and loading/closed states", () => {
    expect(renderPanel("warrior")).toContain("Master Warrior");
    expect(renderPanel("character", false)).toBe("");
    expect(renderPanel("character", true, false)).toContain("Loading progression");
  });

  it("does not advertise a Warrior maximum-health bonus", () => {
    const warrior = renderPanel("warrior");
    const character = renderPanel("character");
    expect(warrior).not.toContain("Maximum health</span><strong>+");
    expect(character).toContain("Ordinary maximum health is fixed at 100");
  });

  it("adjusts only Character Level and profession ranks and locks only the pending track", () => {
    const onAdjust = vi.fn();
    const masterySnapshot = masteries();
    const snapshot = classSnapshot();
    snapshot.classes = snapshot.classes!.map((entry) => ({ ...entry, level: 8 }));
    masterySnapshot.warrior = { ...masterySnapshot.warrior, xp: 40_000, rank: 8, mastered: false, completedAt: null };
    for (const profession of Object.values(masterySnapshot.professions)) {
      Object.assign(profession, { xp: 1_000, rank: 4, mastered: false, completedAt: null });
    }
    const { rerender } = render(<WarriorClassPanel
      open initialSection="character" snapshot={snapshot} progression={progression()} masteries={masterySnapshot}
      combatResource={null} busy={false} devProgressionVisible devProgressionOpen
      devProgressionPendingType={null} devProgressionError={null} devSubclassPending={null}
      onClose={() => undefined} onLoadout={() => undefined} onClass={() => undefined}
      onSubclass={() => undefined} onSetDevSubclassUnlock={() => undefined}
      onAdjustDevProgression={onAdjust} onToggleDevProgression={() => undefined}
    />);

    const expectations = [
      ["Character", "character_level", 4, 6],
      ["Woodcutter", "woodcutter_level", 3, 5],
      ["Miner", "miner_level", 3, 5],
      ["Builder", "builder_level", 3, 5],
      ["Oil Worker", "oil_worker_level", 3, 5]
    ] as const;
    for (const [label] of expectations) {
      const terminology = label === "Character" ? "level" : "rank";
      fireEvent.click(screen.getByRole("button", { name: `Decrease ${label} ${terminology}` }));
      fireEvent.click(screen.getByRole("button", { name: `Increase ${label} ${terminology}` }));
    }
    expect(onAdjust.mock.calls).toEqual(expectations.flatMap(([, type, decrease, increase]) => [
      [type, decrease], [type, increase]
    ]));

    rerender(<WarriorClassPanel
      open initialSection="character" snapshot={snapshot} progression={progression()} masteries={masterySnapshot}
      combatResource={null} busy={false} devProgressionVisible devProgressionOpen
      devProgressionPendingType="builder_level" devProgressionError={null} devSubclassPending={null}
      onClose={() => undefined} onLoadout={() => undefined} onClass={() => undefined}
      onSubclass={() => undefined} onSetDevSubclassUnlock={() => undefined}
      onAdjustDevProgression={onAdjust} onToggleDevProgression={() => undefined}
    />);
    expect((screen.getByRole("button", { name: "Decrease Builder rank" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Increase Builder rank" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Decrease Miner rank" }) as HTMLButtonElement).disabled).toBe(false);
    for (const className of ["Warrior", "Ranger", "Ninja"]) {
      expect(screen.queryByRole("button", { name: `Increase ${className} rank` })).toBeNull();
    }
  });

  it("scopes development progression controls to Character Level or profession ranks", () => {
    const classes = renderPhonePanel("warrior", classSnapshot(), true);
    expect(classes).toContain('aria-label="Character level"');
    expect(classes).not.toContain('aria-label="Woodcutter rank"');
    expect(classes).not.toContain('aria-label="Warrior rank"');

    const professions = renderPhonePanel("woodcutter", classSnapshot(), true);
    expect(professions).not.toContain('aria-label="Character level"');
    for (const profession of ["Woodcutter", "Miner", "Builder", "Oil Worker", "Metallurgy"]) {
      expect(professions).toContain(`aria-label="${profession} rank"`);
    }
    expect(professions).not.toContain('aria-label="Warrior rank"');
  });

  it("keeps all 14 retained V3 classes in the developer-only progression catalog", () => {
    const developer = renderPanel("character", true, true, true);
    expect(developer).toContain('aria-label="Retained Classes catalog"');
    for (const id of [
      "warrior", "knight", "legionnaire", "ranger", "mercenary", "sentinel",
      "assassin", "ninja", "monk", "rogue", "druid", "merchant", "artificer",
      "voyager"
    ]) {
      expect(developer).toContain(`<code>${id}</code>`);
    }
    expect(developer).not.toMatch(/Ultimate/);
    expect(renderPanel("character")).not.toContain("Retained Classes catalog");
  });
});

function renderPanel(
  initialSection: "character" | "warrior" | "woodcutter" | "miner" | "builder" | "oil_worker",
  open = true,
  loaded = true,
  devTools = false
): string {
  return renderToStaticMarkup(<WarriorClassPanel
    open={open}
    initialSection={initialSection}
    snapshot={loaded ? classSnapshot() : null}
    progression={loaded ? progression() : null}
    masteries={loaded ? masteries() : null}
    combatResource={null}
    busy={false}
    devProgressionVisible={devTools}
    devProgressionOpen={devTools}
    devProgressionPendingType={null}
    devProgressionError={null}
    devSubclassPending={null}
    onClose={() => undefined}
    onLoadout={() => undefined}
    onClass={() => undefined}
    onSubclass={() => undefined}
    onSetDevSubclassUnlock={() => undefined}
    onAdjustDevProgression={() => undefined}
    onToggleDevProgression={() => undefined}
  />);
}

function renderPhonePanel(initialSection: "warrior" | "woodcutter", snapshot = classSnapshot(), devTools = false): string {
  return renderToStaticMarkup(<WarriorClassPanel
    open
    layout="phone"
    initialSection={initialSection}
    snapshot={snapshot}
    progression={progression()}
    masteries={masteries()}
    combatResource={null}
    busy={false}
    devProgressionVisible={devTools}
    devProgressionOpen={devTools}
    devProgressionPendingType={null}
    devProgressionError={null}
    devSubclassPending={null}
    onClose={() => undefined}
    onLoadout={() => undefined}
    onClass={() => undefined}
    onSubclass={() => undefined}
    onSetDevSubclassUnlock={() => undefined}
    onAdjustDevProgression={() => undefined}
    onToggleDevProgression={() => undefined}
  />);
}

function progression(): ProgressionSnapshot {
  return {
    playerId: "p1", totalXp: 20_000, level: 5, curveVersion: 2, persistenceVersion: 1,
    xpIntoLevel: 0, xpForNextLevel: 8_800, nextLevelTotalXp: 28_800, atCap: false,
    pveStats: { maxHealth: 120, attackPower: 11, defense: 1, attackIntervalMs: 1_600, attackRangeM: 75 }
  };
}

function masteries(): MasterySnapshot {
  const complete = (trackId: "warrior" | "woodcutter" | "miner" | "builder" | "oil_worker" | "metallurgy", maximumRank: number, title: string) => ({
    trackId, xp: trackId === "warrior" ? 72_000 : trackId === "oil_worker" ? 25_000 : 100_000, rank: maximumRank, maximumRank, nextRankXp: null,
    completedAt: "2026-01-01T00:00:00.000Z", mastered: true, title
  });
  return {
    playerId: "p1",
    warrior: complete("warrior", 15, "Master Warrior"),
    professions: {
      woodcutter: complete("woodcutter", 8, "Master Woodcutter"),
      miner: complete("miner", 8, "Master Miner"),
      builder: complete("builder", 8, "Master Builder"),
      oil_worker: complete("oil_worker", 8, "Master Oil Worker"),
      metallurgy: complete("metallurgy", 8, "Master Metallurgy")
    },
    achievementIds: ["mastery:warrior"], equippedTitle: "Master Warrior", serverTime: 0
  };
}

function combatState(innate: NonNullable<ClassCombatState["innate"]>): ClassCombatState {
  return {
    activeClassId: innate.id.split("_")[0] as NonNullable<ClassCombatState["activeClassId"]>,
    innate,
    rage: 0,
    maximumRage: 0,
    reservedRage: 0,
    guard: 0,
    bloodlust: 0,
    queuedAbility: null,
    cooldownEndsAt: {}
  };
}

function classSnapshot(): ClassSnapshot {
  const definition = CLASS_DEFINITIONS.warrior;
  const resource = { classId: "warrior" as const, resourceId: "rage" as const, displayName: "Rage" as const, current: 70, maximum: 100, reserved: 0, updatedAt: new Date(0).toISOString() };
  const classes = CLASS_IDS.map((classId) => ({ classId, level: classId === "warrior" ? 15 : 0, xp: classId === "warrior" ? 72_000 : 0, nextLevelXp: null, completedAt: null }));
  return {
    playerId: "p1", characterLevel: 5, activeClassId: "warrior", activeSubclassId: null,
    warrior: classes.find(({ classId }) => classId === "warrior")!,
    druid: classes.find(({ classId }) => classId === "druid")!,
    ranger: classes.find(({ classId }) => classId === "ranger")!,
    hunter: classes.find(({ classId }) => classId === "hunter")!,
    knight: classes.find(({ classId }) => classId === "knight")!,
    ninja: classes.find(({ classId }) => classId === "ninja")!,
    classes,
    subclasses: SUBCLASS_IDS.map((subclassId) => ({ classId: SUBCLASS_CLASS_IDS[subclassId], subclassId, unlocked: false })),
    loadout: { resetActives: [null, null], normalActives: [definition.normals[0]?.id ?? null, definition.normals[1]?.id ?? null], passiveTiers: ["warrior_heavy_handed", "warrior_relentless", null], ultimateActive: null },
    legacyIds: [], resource, resources: [resource], rage: 70, maximumRage: 100, queuedAbility: null,
    cooldownEndsAt: {}, serverTime: 0, revision: 1
  };
}
