// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { GENERAL_SKILL_DEFINITIONS, TRADE_SKILL_IDS, VISIBLE_GENERAL_SKILL_IDS, dungeonDefinition, type MasterySnapshot, type PlayerInventorySnapshot, type SkillSystemV3Snapshot } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISCIPLINE_IDS, LEDGER_TIERS, SkillTreeV3Panel, classRuleCopy, effectLines, type SkillTreeV3PanelProps, type SkillTreeV3Selection } from "./SkillTreeV3Panel.js";

afterEach(() => {
  window.localStorage.clear();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.uiProfile;
  delete document.documentElement.dataset.layoutMode;
});

const mastery = (trackId: "warrior" | "woodcutter" | "miner" | "builder" | "oil_worker" | "metallurgy", maximumRank: number, title: string) => ({
  trackId, xp: 72_000, rank: maximumRank, maximumRank, nextRankXp: null, completedAt: "2026-01-01T00:00:00.000Z", mastered: true, title
});

const masteries: MasterySnapshot = {
  playerId: "player-1",
  warrior: mastery("warrior", 15, "Master Warrior"),
  professions: {
    woodcutter: mastery("woodcutter", 8, "Master Woodcutter"),
    miner: mastery("miner", 8, "Master Miner"),
    builder: mastery("builder", 8, "Master Builder"),
    oil_worker: mastery("oil_worker", 8, "Master Oil Worker"),
    metallurgy: mastery("metallurgy", 8, "Master Metallurgy")
  },
  achievementIds: [],
  equippedTitle: "Master Warrior",
  serverTime: 0
};

const baseSnapshot: SkillSystemV3Snapshot = {
  fullBuildRespecAvailable: false,
  // Most tests cover the ranked class UI, reachable only with the full roster; the launch roster's
  // Ronin/Warrior picker has its own tests (fullClassRosterEnabled: false).
  fullClassRosterEnabled: true,
  ultimatesEnabled: false,
  playerId: "player-1",
  characterLevel: 25,
  pointState: { totalEarned: 25, totalSpent: 3, available: 22, revision: 7 },
  generalSkills: [{ skillId: "cleave", rank: 3, pointsSpent: 3 }],
  specializations: [{ specializationId: "warrior", rank: 2, pointsSpent: 2, grandfathered: false, masteryQuestCompleted: true }],
  committedSpecializationId: "warrior",
  activeSpecializationId: "warrior",
  equippedClassTechniqueId: null,
  generalActiveLoadout: [null, null],
  ultimate: { id: "warrior_v2_worldbreaker", specializationId: "warrior", status: "ready" },
  cooldownEndsAt: {},
  worldKnowledge: [],
  serverTime: 1_000,
  revision: 7
};

/** A fresh character with no skills or class. */
const fresh = (overrides: Partial<SkillSystemV3Snapshot> = {}): SkillSystemV3Snapshot => snapshot({
  pointState: { totalEarned: 25, totalSpent: 0, available: 25, revision: 1 },
  generalSkills: [],
  specializations: [],
  committedSpecializationId: null,
  activeSpecializationId: null,
  ultimate: null,
  ...overrides
});

function snapshot(overrides: Partial<SkillSystemV3Snapshot> = {}): SkillSystemV3Snapshot {
  return { ...baseSnapshot, ...overrides };
}

function renderPanel(selection: SkillTreeV3Selection, overrides: Partial<SkillTreeV3PanelProps> = {}) {
  const props: SkillTreeV3PanelProps = {
    open: true,
    layout: "desktop",
    snapshot: baseSnapshot,
    masteries,
    busy: false,
    error: null,
    selection,
    onSelectionChange: vi.fn(),
    onSpend: vi.fn(),
    onActivate: vi.fn(),
    onEquip: vi.fn(),
    onUse: vi.fn(),
    onRespec: vi.fn(),
    onRequest: vi.fn(),
    onClose: vi.fn(),
    onReturnToGame: vi.fn(),
    ...overrides
  };
  return { ...render(<SkillTreeV3Panel {...props} />), props };
}

/** Renders the panel with selection held in local state, as App.tsx does. */
function renderStateful(initial: SkillTreeV3Selection, overrides: Partial<SkillTreeV3PanelProps> = {}) {
  let selection = initial;
  let current: Partial<SkillTreeV3PanelProps> = overrides;
  const rendered = renderPanel(selection, {
    ...overrides,
    onSelectionChange: (next) => {
      selection = next;
      rendered.rerender(<SkillTreeV3Panel {...rendered.props} {...current} selection={selection} />);
    },
  });
  return {
    ...rendered,
    selection: () => selection,
    update(next: Partial<SkillTreeV3PanelProps>) {
      current = { ...current, ...next };
      rendered.rerender(<SkillTreeV3Panel {...rendered.props} {...current} selection={selection} />);
    },
  };
}

const ledger = () => screen.getByRole("region", { name: "Skill ledger" });
const cell = (id: string) => ledger().querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
const knowledgeCard = (id: string) => screen.getByRole("region", { name: "Knowledge" }).querySelector<HTMLElement>(`[data-knowledge-id="${id}"]`)!;
const inventoryWith = (items: Record<string, number>): PlayerInventorySnapshot => ({ playerId: "player-1", revision: 1, totals: {}, items: Object.entries(items).map(([resourceType, quantity]) => ({ playerId: "player-1", resourceType, variant: null, quantity })) } as unknown as PlayerInventorySnapshot);
const pickDiscipline = (name: string): void => { fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${name}, discipline rank`) })); };
const detail = (label: string) => screen.getByRole("complementary", { name: label });

describe("SkillTreeV3Panel shell", () => {
  it("offers Class, Skills, Knowledge, Professions and Achievements as one housed icon rail with the SP summary in the body", () => {
    const { props } = renderPanel({ section: "class" });
    const rail = screen.getByRole("tablist", { name: "Progression sections" });
    expect(rail.classList.contains("game-app-tabs-housed")).toBe(true);
    const tabs = within(rail).getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual(["Class", "Skills", "Knowledge", "Professions", "Achievements"]);
    expect(tabs.every((tab) => tab.querySelector(".game-app-tab-icon svg"))).toBe(true);
    expect(screen.getByRole("tab", { name: "Class" }).getAttribute("aria-selected")).toBe("true");
    const header = document.querySelector(".skill-v3-shell .destination-shell-header")!;
    const status = document.querySelector<HTMLElement>(".skill-v3-app .skill-v3-summary")!;
    expect(header.querySelector(".skill-v3-summary")).toBeNull();
    for (const label of ["SP available", "Spent", "Level"]) expect(status.textContent).toContain(label);
    expect(document.querySelector(".skill-v3-active-class-chip")).toBeNull();
    expect(document.querySelector(".skill-v3-shell")!.textContent).toContain("Progression");

    for (const [name, section] of [["Skills", "general"], ["Knowledge", "knowledge"], ["Professions", "professions"], ["Achievements", "achievements"]] as const) {
      fireEvent.click(screen.getByRole("tab", { name }));
      expect(props.onSelectionChange).toHaveBeenLastCalledWith({ section });
    }
  });

  it("keeps the skill-point summary in the phone body rather than the header", () => {
    renderPanel({ section: "general" }, { layout: "phone" });
    const header = document.querySelector(".skill-v3-shell .phone-menu-header")!;
    expect(header.querySelector(".skill-v3-summary")).toBeNull();
    expect(document.querySelector(".skill-v3-app .skill-v3-summary")?.textContent).toContain("SP available");
    expect(screen.getAllByRole("tab").filter((tab) => tab.closest(".skill-v3-section-tabs"))).toHaveLength(5);
  });

  it("remembers the last tab per player and reopens on it, and survives blocked storage", () => {
    renderStateful({ section: "class" });
    fireEvent.click(screen.getByRole("tab", { name: "Knowledge" }));
    expect(window.localStorage.getItem("ash-atlas:progression-tab:player-1")).toBe("knowledge");
    cleanup();
    // Reopening on the default (Class, no sheet) restores the last tab; an explicit selection is never overridden.
    const reopened = renderPanel({ section: "class" });
    expect(reopened.props.onSelectionChange).toHaveBeenCalledWith({ section: "knowledge" });
    cleanup();
    const explicit = renderPanel({ section: "professions" });
    expect(explicit.props.onSelectionChange).not.toHaveBeenCalled();
    cleanup();
    window.localStorage.clear();
    expect(renderPanel({ section: "class" }).props.onSelectionChange).not.toHaveBeenCalled();

    cleanup();
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    try {
      renderStateful({ section: "class" });
      fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
      expect(screen.getByRole("tab", { name: "Skills" }).getAttribute("aria-selected")).toBe("true");
    } finally {
      Object.defineProperty(window, "localStorage", original);
    }
  });

  it("keeps each top-level tab rooted at Main Menu with the canonical footer actions", () => {
    const onClose = vi.fn();
    const rendered = renderStateful({ section: "general" }, { onClose });
    for (const tab of ["Skills", "Professions", "Achievements"] as const) {
      const back = screen.getByRole("button", { name: "Back to Game Menu" });
      expect(back.closest(".game-app-footer")).toBeTruthy();
      expect(back.classList.contains("phone-menu-back")).toBe(true);
      expect(screen.getByRole("button", { name: "Return to Game" }).classList.contains("phone-menu-return")).toBe(true);
      expect(back.closest(".game-app-footer")?.querySelector(".game-app-action-bar")).toBeNull();
      fireEvent.click(back);
      expect(onClose).toHaveBeenCalledTimes(tab === "Skills" ? 1 : tab === "Professions" ? 2 : 3);
      if (tab !== "Achievements") {
        fireEvent.click(screen.getByRole("tab", { name: tab === "Skills" ? "Professions" : "Achievements" }));
        expect(document.querySelector(".skill-v3-summary")?.textContent ?? "").not.toContain("SP available");
      }
    }
    expect(rendered.selection()).toEqual({ section: "achievements" });
  });

  it("preserves loading and retry behavior without coupling professions to the skill snapshot", () => {
    const { props } = renderPanel({ section: "general" }, { snapshot: null, error: "Unable to load" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Request Skills" }));
    expect(props.onRequest).toHaveBeenCalledTimes(2);

    cleanup();
    renderPanel({ section: "professions" }, { snapshot: null });
    expect(screen.getByRole("button", { name: /Woodcutter/ })).toBeTruthy();
  });
});

describe("SkillTreeV3Panel skill ledger", () => {
  it("shows one discipline at a time behind a picker", () => {
    renderPanel({ section: "general" });
    const tabs = within(screen.getByRole("tablist", { name: "Disciplines" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label")?.replace(/, \d+ ready$/, ""))).toEqual([
      "Cleave, discipline rank 3 of 3", "Archery, discipline rank 0 of 3", "Martial Arts, discipline rank 0 of 3", "Tactics, discipline rank 0 of 3",
      "Trades, 0 of 15 ranks learned",
    ]);
    expect(tabs.map((tab) => tab.querySelector(".game-app-tab-detail")?.textContent)).toEqual(["3/3", "0/3", "0/3", "0/3", "0/15"]);
    expect(tabs.map((tab) => tab.querySelector(":scope > span:not(.game-app-tab-icon):not(.game-app-tab-badge)")?.textContent)).toEqual(["Cleave", "Archery", "Martial", "Tactics", "Trades"]);
    expect(tabs.every((tab) => tab.querySelector(".game-app-tab-icon .progression-icon-sprite"))).toBe(true);
    expect(DISCIPLINE_IDS).toEqual(["cleave", "archery", "martial_arts", "tactics"]);
    const skillsOf = (discipline: string, tier: number) => Array.from(ledger().querySelectorAll(`[data-discipline="${discipline}"] .skill-v3-ledger-grid[data-tier="${tier}"] [data-node-id]`), (node) => node.getAttribute("data-node-id"));
    const expected: Record<string, readonly (readonly string[])[]> = {
      cleave: [["second_wind", "pierce_armor"], ["shield_charge", "provoke"], ["pursuit"], ["blight_strike", "deathburst"]],
      archery: [["ricochet"], ["quarry_sense"], ["huntsmans_edge"], ["concentration"]],
      martial_arts: [[], [], ["perfect_strike"], []],
      tactics: [["taunt", "calm_mind", "scavenge"], ["cleanse", "companion_bond", "delvers_lore"], ["war_standard"], ["heroism"]],
    };
    const placed: string[] = [];
    for (const [discipline, tiers] of Object.entries(expected)) {
      pickDiscipline(discipline === "martial_arts" ? "Martial Arts" : discipline[0]!.toUpperCase() + discipline.slice(1));
      expect(Array.from(ledger().querySelectorAll<HTMLElement>(".skill-v3-discipline"), (node) => node.dataset.discipline)).toEqual([discipline]);
      expect(ledger().querySelector(":scope .skill-v3-discipline > [data-node-id]")?.getAttribute("data-node-id")).toBe(discipline);
      tiers.forEach((ids, index) => { expect(skillsOf(discipline, index + 1)).toEqual(ids); placed.push(...ids); });
      expect(screen.getByRole("tab", { name: new RegExp(`^${discipline === "martial_arts" ? "Martial Arts" : discipline[0]!.toUpperCase() + discipline.slice(1)}, `) }).getAttribute("aria-selected")).toBe("true");
    }
    // Each tier states its requirement once, in its header.
    pickDiscipline("Cleave");
    expect(ledger().querySelector('.skill-v3-ledger-tier[data-tier="2"] h4')?.textContent).toContain("Needs discipline Rank 2");
    // Every ledger skill is reachable exactly once; class and knowledge live on their own tabs.
    expect(placed.sort()).toEqual([...LEDGER_TIERS.slice(1).flat()].sort());
    expect(ledger().querySelector("[data-class-rank], [data-discovery-id]")).toBeNull();
    expect(Array.from(ledger().children, (child) => child.getAttribute("aria-label") ?? child.className)).toEqual(["Disciplines", "Cleave skills"]);
    expect(document.querySelector(".skill-v3-app > .skill-v3-summary")).toBeTruthy();
    expect(ledger().closest(".skill-v3-summary")).toBeNull();
  });

  it("defaults to the most-invested discipline and remembers the pick per player", () => {
    const spent = snapshot({ generalSkills: [{ skillId: "cleave", rank: 1, pointsSpent: 1 }, { skillId: "tactics", rank: 2, pointsSpent: 2 }, { skillId: "taunt", rank: 1, pointsSpent: 1 }] });
    renderPanel({ section: "general" }, { snapshot: spent });
    expect(screen.getByRole("tab", { name: /^Tactics, / }).getAttribute("aria-selected")).toBe("true");
    pickDiscipline("Archery");
    expect(window.localStorage.getItem(`ash-atlas:skills-discipline:${spent.playerId}`)).toBe("archery");
    cleanup();
    renderPanel({ section: "general" }, { snapshot: spent });
    expect(screen.getByRole("tab", { name: /^Archery, / }).getAttribute("aria-selected")).toBe("true");
    cleanup();
    window.localStorage.clear();
    renderPanel({ section: "general" }, { snapshot: fresh() });
    expect(screen.getByRole("tab", { name: /^Cleave, / }).getAttribute("aria-selected")).toBe("true");
  });

  it("still works when localStorage throws", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    try {
      renderPanel({ section: "general" }, { snapshot: fresh() });
      pickDiscipline("Tactics");
      expect(screen.getByRole("tab", { name: /^Tactics, / }).getAttribute("aria-selected")).toBe("true");
    } finally {
      Object.defineProperty(window, "localStorage", original);
    }
  });

  it("keeps every prerequisite in a strictly lower tier and places every visible skill once", () => {
    const tierOf = new Map<string, number>(LEDGER_TIERS.flatMap((ids, tier) => ids.map((id) => [id, tier] as const)));
    expect(tierOf.size).toBe(LEDGER_TIERS.flat().length);
    for (const id of LEDGER_TIERS.flat()) {
      for (const prerequisite of GENERAL_SKILL_DEFINITIONS[id].prerequisites) {
        expect(tierOf.get(prerequisite.skillId), `${id} needs ${prerequisite.skillId}`).toBeLessThan(tierOf.get(id)!);
      }
    }
    // The trade skills sit on their own Trades tab, outside the prerequisite tiers.
    expect(new Set([...VISIBLE_GENERAL_SKILL_IDS].filter((id) => !(TRADE_SKILL_IDS as readonly string[]).includes(id)))).toEqual(new Set(tierOf.keys()));
  });

  it("shows provoke as a locked cell that cannot be bought", () => {
    renderStateful({ section: "general" }, { snapshot: fresh() });
    expect(cell("provoke").dataset.state).toBe("locked");
    fireEvent.click(cell("provoke"));
    const provoke = detail("Provoke details");
    expect((within(provoke).getByRole("button", { name: /^Level Up/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(provoke.textContent).toContain("Needs Cleave 2");
  });

  it("groups Knowledge by token dungeon with token progress, states and Coming soon entries", () => {
    const rendered = renderStateful({ section: "knowledge" }, { snapshot: fresh({ worldKnowledge: [{ skillId: "grove_lore", revealed: true, rank: 1, pointsSpent: 1 }] }), inventory: inventoryWith({ raptor_scale: 2, giant_egg: 9, cached_nuts: 10, small_egg: 2, dryad_heartwood: 2, beaver_pelt: 1 }) });
    const groups = Array.from(screen.getByRole("region", { name: "Knowledge" }).querySelectorAll<HTMLElement>(".skill-v3-knowledge-group"), (group) => group.getAttribute("aria-label"));
    expect(groups).toEqual(["Drowned City sites (open sea)", dungeonDefinition("the_eyrie")!.name, dungeonDefinition("fangrock_cavern")!.name, dungeonDefinition("blightwood_grove")!.name, dungeonDefinition("fallen_prison")!.name, "Coming soon"]);
    // Locked with progress: "Raptor Scale 2/6", sourced from its dungeon.
    const deepstone = knowledgeCard("deepstone_lore");
    expect(deepstone.dataset.state).toBe("locked");
    expect(deepstone.textContent).toContain("Raptor Scale");
    expect(deepstone.textContent).toContain("2/6");
    expect(deepstone.textContent).toContain(`from ${dungeonDefinition("fangrock_cavern")!.name}`);
    expect(deepstone.querySelector(".skill-v3-knowledge-chip")?.textContent).toBe("Locked");
    // Enough tokens: ready to turn in (progress is capped at the cost).
    expect(knowledgeCard("wildkin_lore").textContent).toContain("6/6");
    expect(knowledgeCard("wildkin_lore").querySelector(".skill-v3-knowledge-chip")?.textContent).toBe("Ready to turn in");
    // Learned.
    expect(knowledgeCard("grove_lore").querySelector(".skill-v3-knowledge-chip")?.textContent).toBe("Learned · 1/3");
    expect(knowledgeCard("grove_lore").textContent).not.toContain("Elder Acorn");
    // Future content: dimmed, not a button, no numbers; it still shows its own icon and never a monogram.
    for (const id of ["rare_beast_mastery"]) {
      const soon = knowledgeCard(id);
      expect(soon.tagName).toBe("DIV");
      expect(soon.dataset.state).toBe("soon");
      expect(soon.textContent).toContain("Coming soon");
      expect(soon.textContent).not.toMatch(/\d/);
      expect(soon.querySelector(".skill-v3-knowledge-icon")?.getAttribute("data-empty")).toBeNull();
      expect(soon.querySelector(".progression-icon-fallback")).toBeNull();
    }
    expect(rendered.props.onSpend).not.toHaveBeenCalled();
  });

  it("opens a Knowledge entry and ranks it up for 1 Skill Point per rank", () => {
    const withKnowledge = (rank: number, available = 25) => fresh({
      pointState: { totalEarned: 25, totalSpent: 25 - available, available, revision: 1 },
      worldKnowledge: [{ skillId: "deepstone_lore", revealed: true, rank, pointsSpent: rank }]
    });
    const rendered = renderStateful({ section: "knowledge" }, { snapshot: withKnowledge(0) });
    expect(knowledgeCard("deepstone_lore").querySelector(".skill-v3-knowledge-chip")?.textContent).toBe("Can learn · 1 SP");
    fireEvent.click(knowledgeCard("deepstone_lore"));
    expect(rendered.selection()).toEqual({ section: "knowledge", worldKnowledgeSkillId: "deepstone_lore" });
    const sheet = detail("Deepstone Lore details");
    expect(sheet.textContent).toContain("Pending: See caves and mines outside your active circle");
    const spend = within(sheet).getByRole("button", { name: "Level Up · 1 SP" });
    expect((spend as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(spend);
    expect(rendered.props.onSpend).toHaveBeenCalledWith({ kind: "knowledge", id: "deepstone_lore" });
    fireEvent.click(screen.getByRole("button", { name: "Back to Knowledge" }));
    expect(rendered.selection()).toEqual({ section: "knowledge" });
  });

  it("blocks world-knowledge ranks without points and at maximum rank", () => {
    const broke = renderStateful({ section: "knowledge", worldKnowledgeSkillId: "grove_lore" }, { snapshot: fresh({
      pointState: { totalEarned: 25, totalSpent: 25, available: 0, revision: 1 },
      worldKnowledge: [{ skillId: "grove_lore", revealed: true, rank: 1, pointsSpent: 1 }]
    }) });
    expect((within(detail("Grove Lore details")).getByRole("button", { name: "Level Up · 1 SP" }) as HTMLButtonElement).disabled).toBe(true);
    expect(broke.props.onSpend).not.toHaveBeenCalled();
  });

  it("marks learned, purchasable, and locked skills and shows rank and equipped badges", () => {
    renderPanel({ section: "general" }, { snapshot: fresh({ generalSkills: [{ skillId: "archery", rank: 1, pointsSpent: 1 }, { skillId: "cleave", rank: 1, pointsSpent: 1 }, { skillId: "shield_charge", rank: 2, pointsSpent: 2 }], generalActiveLoadout: ["shield_charge", null] }) });
    expect(cell("cleave").dataset.state).toBe("learned");
    expect(cell("shield_charge").textContent).toContain("Equipped 1");
    pickDiscipline("Archery");
    expect(cell("archery").dataset.state).toBe("learned");
    expect(cell("archery").querySelector(".skill-v3-ledger-rank")?.textContent).toBe("1");
    expect(cell("ricochet").dataset.state).toBe("purchasable");
    expect(cell("ricochet").querySelector(".skill-v3-ledger-rank")).toBeNull();
    expect(cell("quarry_sense").dataset.state).toBe("locked");
    expect(cell("quarry_sense").querySelector(".skill-v3-ledger-lock")).toBeTruthy();
    expect(cell("quarry_sense").getAttribute("aria-label")).toContain("Requires Ricochet 0/1");
  });

  it("shows prerequisite chips, highlights skills you can buy now and counts them on the discipline tab", () => {
    renderPanel({ section: "general" });
    expect(Array.from(cell("shield_charge").querySelectorAll(".skill-v3-prereq"), (chip) => chip.textContent)).toEqual(["Needs Cleave 2"]);
    expect(cell("shield_charge").dataset.ready).toBe("true");
    expect(cell("cleave").querySelector(".skill-v3-prereq")).toBeNull();
    expect(cell("cleave").dataset.ready).toBe("false");
    expect(cell("provoke").dataset.ready).toBe("true");
    const tab = screen.getByRole("tab", { name: /^Cleave, discipline rank 3 of 3, \d+ ready$/ });
    const ready = ledger().querySelectorAll('[data-discipline="cleave"] [data-ready="true"]').length;
    expect(ready).toBeGreaterThan(0);
    expect(tab.querySelector(".game-app-tab-badge")?.textContent).toBe(String(ready));
    // No badge when nothing is buyable (Martial Arts is locked behind its gateway for a fresh character with no points).
    cleanup();
    renderPanel({ section: "general" }, { snapshot: fresh({ pointState: { totalEarned: 0, totalSpent: 0, available: 0, revision: 1 } }) });
    expect(screen.getByRole("tab", { name: /^Archery, discipline rank 0 of 3$/ }).querySelector(".game-app-tab-badge")).toBeNull();
  });

  it("shows the Class tab hero for the active class with its rank track, next rank gate and rank effects", () => {
    const rendered = renderStateful({ section: "class" });
    const hero = screen.getByLabelText("Warrior, Rank 2 of 5");
    expect(hero.textContent).toContain("Level 25");
    expect(hero.querySelector(".progression-icon-sprite")).toBeTruthy();
    expect(Array.from(hero.querySelectorAll(".skill-v3-rank-track li"), (item) => (item as HTMLElement).dataset.state)).toEqual(["earned", "earned", "next", "locked", "locked"]);
    expect(within(hero).getByLabelText("Next rank").textContent).toContain("Level 21");
    expect(within(hero).getByLabelText("Next rank").textContent).toContain("Rank 3");
    const effects = screen.getByRole("region", { name: "Rank effects" });
    expect(effects.querySelectorAll(":scope > ol > li")).toHaveLength(5);
    expect(effects.querySelector('li[data-earned="true"]')).toBeTruthy();
    expect(effects.querySelector('li[data-next="true"] strong')?.textContent).toBe("Rank 3");
    for (const dormant of Array.from(effects.querySelectorAll('[data-live="false"]'))) expect(dormant.textContent).toContain("Coming soon");
    // The retired launch kits are not shown.
    expect(screen.queryByText(/Nature Bolt|Heavy Slash|Steel Tempest|Piercing Arrow/)).toBeNull();
    fireEvent.click(within(hero).getByRole("button", { name: "Rank up" }));
    expect(rendered.selection()).toEqual({ section: "class", specializationId: "warrior" });
    expect(detail("Warrior class details")).toBeTruthy();
  });

  it("names a mastered class by its title and opens the class change flow", () => {
    const rendered = renderStateful({ section: "class" }, { snapshot: snapshot({ specializations: [{ specializationId: "warrior", rank: 5, pointsSpent: 5, grandfathered: false, masteryQuestCompleted: true }] }) });
    const hero = screen.getByLabelText("Master Warrior, Rank 5 of 5");
    expect(hero.textContent).toContain("Warrior mastered");
    expect(within(hero).getByLabelText("Next rank").textContent).toContain("Every rank of this class is earned");
    fireEvent.click(within(hero).getByRole("button", { name: "Change class" }));
    expect(rendered.selection()).toEqual({ section: "class", classOverview: true });
    expect(detail("All classes")).toBeTruthy();
  });

  it("offers Druid Replenish on the Class tab only for an active druid", () => {
    const druid = snapshot({ committedSpecializationId: "druid", activeSpecializationId: "druid", specializations: [{ specializationId: "druid", rank: 1, pointsSpent: 1, grandfathered: false, masteryQuestCompleted: false }] });
    const { props } = renderPanel({ section: "class" }, { snapshot: druid });
    fireEvent.click(screen.getByRole("button", { name: "Use Replenish" }));
    expect(props.onUse).toHaveBeenCalledWith("v3_druid_replenish");
    cleanup();
    renderPanel({ section: "class" });
    expect(screen.queryByRole("button", { name: "Use Replenish" })).toBeNull();
  });

  it("writes the Class tab empty state with the path to pick a class", () => {
    const rendered = renderStateful({ section: "class" }, { snapshot: fresh({ generalSkills: [{ skillId: "cleave", rank: 3, pointsSpent: 3 }] }) });
    expect(screen.getByRole("heading", { name: "Choose your class" })).toBeTruthy();
    expect(screen.getByText(/reach Rank 3 in a discipline/)).toBeTruthy();
    // The Class tab no longer repeats the Skills tab; each discipline says which classes it opens instead.
    expect(screen.queryByRole("region", { name: "Class paths" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Skills" }));
    expect(rendered.selection()).toEqual({ section: "general" });
    expect(document.querySelector(".skill-v3-discipline-classes")?.textContent).toMatch(/^Classes open: /);
    fireEvent.click(screen.getAllByRole("tab").find((tab) => tab.textContent?.startsWith("Class"))!);
    fireEvent.click(screen.getByRole("button", { name: "Browse classes" }));
    expect(rendered.selection()).toEqual({ section: "class", classOverview: true });
    expect(detail("All classes")).toBeTruthy();
  });

  it("opens skill and discipline details over the ledger and backs out to Skills", () => {
    const rendered = renderStateful({ section: "general" }, { snapshot: snapshot({ generalSkills: [{ skillId: "cleave", rank: 3, pointsSpent: 3 }, { skillId: "shield_charge", rank: 1, pointsSpent: 1 }], generalActiveLoadout: ["shield_charge", null] }) });
    const scroller = ledger();
    scroller.scrollTop = 120;
    fireEvent.click(cell("shield_charge"));
    expect(rendered.selection()).toEqual({ section: "general", generalSkillId: "shield_charge" });
    const sheet = detail("Shield Charge details");
    expect(sheet.closest(".skill-v3-sheet")?.getAttribute("data-layout")).toBe("desktop");
    expect(ledger()).toBe(scroller);
    expect(scroller.scrollTop).toBe(120);
    expect(within(sheet).queryByRole("heading", { name: "Requirements" })).toBeNull();
    expect(sheet.textContent).not.toContain("Needs Cleave");
    fireEvent.click(within(sheet).getByRole("button", { name: "Equip Slot 2" }));
    expect(rendered.props.onEquip).toHaveBeenCalledWith(2, "shield_charge");
    fireEvent.click(screen.getByRole("button", { name: "Back to Skills" }));
    expect(rendered.selection()).toEqual({ section: "general" });
    expect(screen.queryByRole("complementary", { name: "Shield Charge details" })).toBeNull();
  });

  it("lays ranks out as Level columns with earned levels lit and future levels muted", () => {
    renderPanel({ section: "general", generalSkillId: "archery" }, { snapshot: fresh({ generalSkills: [{ skillId: "archery", rank: 1, pointsSpent: 1 }] }) });
    const gateway = detail("Archery details");
    const ledgerColumns = gateway.querySelector<HTMLElement>(".skill-v3-rank-ledger")!;
    expect(ledgerColumns.dataset.layout).toBe("columns");
    const rows = Array.from(ledgerColumns.querySelectorAll<HTMLElement>(".skill-v3-rank-row"));
    expect(rows.map((row) => row.querySelector(".skill-v3-rank-title")?.textContent)).toEqual(["Level 1", "Level 2", "Level 3"]);
    expect(rows.map((row) => row.dataset.earned)).toEqual(["true", "false", "false"]);
  });

  it("levels a discipline from its detail and explains why it cannot", () => {
    const { props } = renderPanel({ section: "general", generalSkillId: "archery" }, { snapshot: fresh() });
    const gateway = detail("Archery details");
    fireEvent.click(within(gateway).getByRole("button", { name: /^Level Up · \d+ SP$/ }));
    expect(props.onSpend).toHaveBeenCalledWith({ kind: "general", id: "archery" });

    cleanup();
    renderPanel({ section: "general", generalSkillId: "cleave" }, { snapshot: fresh({ pointState: { totalEarned: 0, totalSpent: 0, available: 0, revision: 1 } }) });
    const levelUp = within(detail("Cleave details")).getByRole("button", { name: /^Level Up · \d+ SP$/ }) as HTMLButtonElement;
    expect(levelUp.disabled).toBe(true);
    expect(document.getElementById(levelUp.getAttribute("aria-describedby")!)?.textContent).toBe("Requires 1 available SP.");
  });
});

describe("SkillTreeV3Panel detail sheet", () => {
  it("opens the full gateway rank list as a bottom sheet on phone and closes it on Escape", () => {
    document.documentElement.dataset.uiProfile = "phone";
    document.documentElement.dataset.layoutMode = "compact";
    const rendered = renderStateful({ section: "general" }, { layout: "phone", snapshot: fresh() });
    pickDiscipline("Tactics");
    fireEvent.click(screen.getByRole("button", { name: /^Tactics, Rank 0 of 3/ }));
    const gateway = detail("Tactics details");
    expect(gateway.closest(".skill-v3-sheet")?.getAttribute("data-layout")).toBe("phone");
    expect(gateway.querySelectorAll(".skill-v3-rank-row")).toHaveLength(GENERAL_SKILL_DEFINITIONS.tactics.rankDefinitions.length);
    expect(within(gateway).queryByRole("button", { name: "Classes" })).toBeNull();
    fireEvent.click(within(gateway).getByRole("button", { name: "Level Up · 1 SP" }));
    expect(rendered.props.onSpend).toHaveBeenCalledWith({ kind: "general", id: "tactics" });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(rendered.selection()).toEqual({ section: "general" });
    expect(ledger()).toBeTruthy();
  });

  it("confirms the first class rank with copy that says exactly what locks", () => {
    renderPanel({ section: "general", specializationId: "warrior" }, { snapshot: fresh({ generalSkills: [{ skillId: "cleave", rank: 3, pointsSpent: 3 }], pointState: { totalEarned: 25, totalSpent: 3, available: 22, revision: 1 }, fullBuildRespecAvailable: true }) });
    const warrior = detail("Warrior class details");
    expect(warrior.querySelectorAll(".skill-v3-rank-row")).toHaveLength(5);
    for (const gate of ["Level 1", "Level 14", "Level 21", "Level 27", "Level 33"]) expect(warrior.textContent).toContain(gate);
    expect(warrior.textContent).toContain("Rank 1 · Becomes your class");
    expect(warrior.textContent).not.toContain("commits this build");
    fireEvent.click(within(warrior).getByRole("button", { name: "Spend 1 SP" }));
    expect(screen.getByText(/Warrior becomes your active class and every other class locks\. General skills are not affected\. Respec build undoes this/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose Warrior" })).toBeTruthy();
  });

  it("offers Warrior and Ranger without their gateway and keeps the other roster classes locked", () => {
    renderPanel({ section: "general", classOverview: true }, { snapshot: fresh({ committedSpecializationId: null, activeSpecializationId: null, generalSkills: [] }) });
    const all = detail("All classes");
    for (const id of ["warrior", "ranger"]) expect(all.querySelector(`[data-class-id="${id}"]`)?.getAttribute("data-class-state")).toBe("available");
    for (const id of ["knight", "sentinel", "monk", "ninja", "druid", "mercenary", "legionnaire", "assassin", "rogue", "merchant", "artificer", "voyager"]) expect(all.querySelector(`[data-class-id="${id}"]`)?.getAttribute("data-class-state")).toBe("locked");
  });

  it("opens an all-classes overview from Change class that reaches every class", () => {
    const rendered = renderStateful({ section: "class" });
    fireEvent.click(screen.getByRole("button", { name: "Change class" }));
    expect(rendered.selection()).toEqual({ section: "class", classOverview: true });
    const all = detail("All classes");
    for (const discipline of ["Cleave", "Archery", "Martial Arts", "Tactics"]) expect(within(all).getByRole("region", { name: `${discipline} classes` })).toBeTruthy();
    expect(all.textContent).toContain(classRuleCopy(false));
    expect(all.querySelectorAll("[data-class-id]")).toHaveLength(14);
    fireEvent.click(within(all).getByRole("button", { name: /^Ninja, Class Locked/ }));
    expect(rendered.selection()).toEqual({ section: "class", specializationId: "ninja" });
    expect(detail("Ninja class details")).toBeTruthy();
  });

  it("states that respec undoes the class choice only where respec exists", () => {
    renderPanel({ section: "general", classOverview: true }, { snapshot: snapshot({ fullBuildRespecAvailable: true }) });
    const all = detail("All classes");
    expect(all.textContent).toContain("Respec build resets all skills and classes so you can choose again.");
    expect(all.textContent).not.toContain("permanent");
    expect(within(all).getByRole("button", { name: /^Warrior, Active Class, Rank 2 of 5/ }).textContent).toContain("★ Warrior");
    expect(within(all).getByRole("button", { name: /^Knight, Class Locked, Rank 0 of 5, Warrior is your active class\. Use Respec build/ }).textContent).toContain("Locked while Warrior is active");
  });

  it("preserves respec", () => {
    const { props } = renderPanel({ section: "general" }, { snapshot: snapshot({ fullBuildRespecAvailable: true }) });
    fireEvent.click(screen.getByRole("button", { name: "Respec build" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset build" }));
    expect(props.onRespec).toHaveBeenCalledOnce();
  });
});

describe("SkillTreeV3Panel launch class picker (Ronin, Warrior)", () => {
  const picker = () => screen.getByRole("group", { name: "Choose a class" });
  const option = (name: string) => within(picker()).getByRole("button", { name: new RegExp(`^${name}`) });

  it("lists only Ronin, Warrior and No class and equips each with one tap", () => {
    const onActivate = vi.fn();
    const { rerender, props } = renderPanel({ section: "class" }, { snapshot: fresh({ fullClassRosterEnabled: false }), onActivate });
    expect(within(picker()).getAllByRole("button").map((button) => button.getAttribute("data-class-id"))).toEqual(["ronin", "warrior", "none"]);
    expect(screen.getByRole("heading", { name: "No class" })).toBeTruthy();
    expect(option("No class").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(option("Ronin"));
    expect(onActivate).toHaveBeenLastCalledWith("ronin");

    rerender(<SkillTreeV3Panel {...props} snapshot={snapshot({ fullClassRosterEnabled: false, committedSpecializationId: "ronin", activeSpecializationId: "ronin" })} />);
    expect(screen.getByRole("heading", { name: "Ronin" })).toBeTruthy();
    expect(option("Ronin").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(option("Ronin"));
    expect(onActivate).toHaveBeenCalledTimes(1);
    fireEvent.click(option("Warrior"));
    expect(onActivate).toHaveBeenLastCalledWith("warrior");
    fireEvent.click(option("No class"));
    expect(onActivate).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText(/Knight|Ranger|Druid/u)).toBeNull();
  });

  it("shows a player still stored on a hidden class as having no class, and disables taps while busy", () => {
    renderPanel({ section: "class" }, { busy: true, snapshot: snapshot({ fullClassRosterEnabled: false, committedSpecializationId: "knight", activeSpecializationId: null }) });
    expect(screen.getByRole("heading", { name: "No class" })).toBeTruthy();
    expect(within(picker()).getAllByRole("button").every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe("SkillTreeV3Panel hidden old combat skills", () => {
  it("keeps the Skills tabs with a New skills coming soon Combat tab and the Trades, and no old discipline", () => {
    window.localStorage.setItem("ash-atlas:skills-discipline:player-1", "martial_arts");
    renderPanel({ section: "general" }, { snapshot: snapshot({ fullClassRosterEnabled: false }) });
    const tabs = screen.getByRole("tablist", { name: "Disciplines" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([expect.stringContaining("Combat"), expect.stringContaining("Trades")]);
    expect(screen.getByText("New skills coming soon")).toBeTruthy();
    expect(screen.queryByText(/Cleave|Archery|Martial|Tactics|Second Wind|Pierce Armor|Shield Charge|Provoke/u)).toBeNull();

    fireEvent.click(within(tabs).getByRole("tab", { name: /^Trades/ }));
    expect(screen.getByRole("button", { name: /^Alchemy, Rank 0 of 3/ })).toBeTruthy();
    expect(screen.queryByText("New skills coming soon")).toBeNull();
  });
});

describe("SkillTreeV3Panel developer class reveal", () => {
  it("shows all 14 classes", () => {
    renderPanel({ section: "general", classOverview: true }, { snapshot: fresh(), revealAllClasses: true });
    const classes = within(detail("All classes")).getByRole("region", { name: "Cleave classes" });
    expect(Array.from(classes.querySelectorAll("[data-class-id]")).map((node) => node.getAttribute("data-class-id"))).toEqual(["warrior", "knight", "legionnaire"]);
    expect(within(classes).getByRole("button", { name: /^Legionnaire, Locked, Rank 0 of 5/ })).toBeTruthy();
  });

  it("applies the level gate, not the launch spent gate, to full-roster classes", () => {
    renderPanel({ section: "general", specializationId: "legionnaire" }, { snapshot: fresh({ fullClassRosterEnabled: true, characterLevel: 5, generalSkills: [{ skillId: "cleave", rank: 3, pointsSpent: 3 }] }), revealAllClasses: true });
    const mercenary = detail("Legionnaire class details");
    expect(mercenary.textContent).toContain("Needs Level 9");
    expect(mercenary.textContent).not.toContain("3 spent SP");
  });
});

describe("SkillTreeV3Panel Archery to Ranger walkthrough", () => {
  it("levels Archery, unlocks Ricochet, tracks Ranger progress, and updates the Class tab hero", () => {
    let state = fresh();
    const rendered = renderStateful({ section: "general" }, { snapshot: state });
    const levelArchery = (rank: number): void => {
      state = { ...state, generalSkills: [{ skillId: "archery", rank, pointsSpent: rank }], pointState: { totalEarned: 25, totalSpent: rank, available: 25 - rank, revision: rank + 1 } };
      rendered.update({ snapshot: state });
    };

    pickDiscipline("Archery");
    expect(cell("ricochet").dataset.state).toBe("locked");
    expect(cell("ricochet").getAttribute("aria-label")).toContain("Requires Archery 0/1");
    expect(cell("archery").dataset.state).toBe("purchasable");

    fireEvent.click(cell("archery"));
    fireEvent.click(within(detail("Archery details")).getByRole("button", { name: /^Level Up · \d+ SP$/ }));
    expect(rendered.props.onSpend).toHaveBeenLastCalledWith({ kind: "general", id: "archery" });
    levelArchery(1);
    expect(cell("archery").dataset.state).toBe("learned");
    expect(cell("ricochet").dataset.state).toBe("purchasable");
    expect(cell("ricochet").getAttribute("aria-label")).toMatch(/^Ricochet, Rank 0 of 3, Available, 1 SP/);

    levelArchery(3);
    expect(within(detail("Archery details")).getByRole("button", { name: "Maximum Rank" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to Skills" }));
    fireEvent.click(screen.getByRole("tab", { name: "Class" }));
    fireEvent.click(screen.getByRole("button", { name: "Browse classes" }));
    const ranger = within(detail("All classes")).getByRole("button", { name: /^Ranger, Available, Rank 0 of 5$/ });
    expect(ranger.textContent).toContain("Ready to choose");

    fireEvent.click(ranger);
    const rangerDetail = detail("Ranger class details");
    expect(rangerDetail.textContent).not.toContain("Needs");
    fireEvent.click(within(rangerDetail).getByRole("button", { name: "Spend 1 SP" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose Ranger" }));
    expect(rendered.props.onSpend).toHaveBeenLastCalledWith({ kind: "specialization", id: "ranger" });

    state = { ...state, specializations: [{ specializationId: "ranger", rank: 1, pointsSpent: 1, grandfathered: false, masteryQuestCompleted: false }], committedSpecializationId: "ranger", activeSpecializationId: "ranger" };
    rendered.update({ snapshot: state });
    expect(detail("Ranger class details").querySelector(".skill-v3-detail-state small")?.textContent).toBe("Active Class");
    fireEvent.click(screen.getByRole("button", { name: "Back to Class" }));
    const hero = screen.getByLabelText("Ranger, Rank 1 of 5");
    expect(Array.from(hero.querySelectorAll(".skill-v3-rank-track li"), (item) => (item as HTMLElement).dataset.state)).toEqual(["earned", "next", "locked", "locked", "locked"]);
    expect(within(hero).getByLabelText("Next rank").textContent).toContain("Level 14");
  });
});

describe("effectLines", () => {
  it("puts each perk on its own line without splitting plain phrases", () => {
    expect(effectLines("+10 Max HP and +1 Axe Attack.")).toEqual(["+10 Max HP", "+1 Axe Attack"]);
    expect(effectLines("Total +3 flat Attack with Longbow and Crossbow; +150m range; unlocks eligible Archery specializations.")).toEqual([
      "Total +3 flat Attack with Longbow and Crossbow", "+150m range", "Unlocks eligible Archery specializations"
    ]);
    expect(effectLines("Total +3 Sword Attack, +3 Heavy/Breastplate Defense, and +3 ranged Shield Defense.")).toEqual([
      "Total +3 Sword Attack", "+3 Heavy/Breastplate Defense", "+3 ranged Shield Defense"
    ]);
    expect(effectLines("10% proc; pool adds Leather and Iron Ore.")).toEqual(["10% proc", "Pool adds Leather and Iron Ore"]);
    expect(effectLines("Remove harmful statuses and gain 3 seconds of immunity.")).toEqual(["Remove harmful statuses and gain 3 seconds of immunity"]);
  });
});
