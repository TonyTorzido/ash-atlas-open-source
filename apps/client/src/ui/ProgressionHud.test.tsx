// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { CombatEntitySnapshot, ProgressionSnapshot } from "@ash-atlas/shared";
import { afterEach, describe, expect, it } from "vitest";

import { ProgressionHud } from "./ProgressionHud.js";

afterEach(cleanup);

const progression = {
  playerId: "p", totalXp: 6_397, level: 4, curveVersion: 1, persistenceVersion: 1,
  xpIntoLevel: 397, xpForNextLevel: 800, nextLevelTotalXp: 6_800, atCap: false,
  pveStats: { maxHealth: 100, attackPower: 10, defense: 5, attackIntervalMs: 1_000, attackRangeM: 2 }
} satisfies ProgressionSnapshot;

const combat = {
  entityId: "p", kind: "player", archetypeKey: null, name: "Player", level: 4,
  regionCode: "NM", zoneId: "world:NM", lat: 35, lon: -106, maxHealth: 100,
  currentHealth: 94, lifeState: "alive", activityState: "idle", targetEntityId: null, revision: 1,
  classCombat: {
    activeClassId: "warrior",
    resource: { resourceId: "rage", displayName: "Rage", current: 0, maximum: 100, reserved: 0 },
    rage: 0, maximumRage: 100, reservedRage: 0, guard: 0, bloodlust: 0,
    queuedAbility: null, cooldownEndsAt: {}
  }
} satisfies CombatEntitySnapshot;

describe("ProgressionHud", () => {
  it("renders icon-only phone rows with accessible labels and values", () => {
    const view = render(
      <ProgressionHud progression={progression} combat={combat} classSnapshot={null} variant="phoneDock" />
    );

    expect(screen.getAllByText("HP", { exact: true })).toHaveLength(1);
    expect(screen.queryByText("Health", { exact: true })).toBeNull();
    expect(view.container.querySelector(".status-bar-health .status-bar-compact-value")?.textContent).toBe("94/100");
    expect(view.container.querySelector(".status-bar-health .status-bar-track > .status-bar-compact-value")).toBeNull();
    expect(screen.getAllByText("RAGE", { exact: true })).toHaveLength(1);
    expect(view.container.querySelector(".status-bar-rage .status-bar-compact-value")?.textContent).toBe("0/100");
    expect(screen.getAllByText("EXP", { exact: true })).toHaveLength(1);
    expect(view.container.querySelector(".status-bar-experience .status-bar-compact-value")?.textContent).toBe("397/800");
    expect(view.container.querySelector(".status-bar-experience .status-bar-track > .status-bar-compact-value")).toBeNull();
    expect(Array.from(view.container.querySelectorAll(".status-bar-compact-label"), (label) => label.textContent)).toEqual([
      "HP",
      "EXP",
      "RAGE"
    ]);
    expect(view.container.querySelectorAll(".status-bar-compact-icon")).toHaveLength(2);
    expect(view.container.querySelectorAll(".status-bar-compact-label .sr-only")).toHaveLength(3);
    expect(view.container.textContent).not.toContain("94 / 10094");
    expect(view.container.querySelectorAll("[data-phone-label], [data-phone-value]")).toHaveLength(0);
  });

  it("uses the authoritative Hunger snapshot after HP and EXP on the phone dock", () => {
    const view = render(
      <ProgressionHud
        progression={progression}
        combat={combat}
        classSnapshot={null}
        hunger={{ current: 1_200, baseCapacity: 2_000 }}
        variant="phoneDock"
      />
    );

    expect(screen.getAllByText("HP", { exact: true })).toHaveLength(1);
    expect(screen.getAllByText("Hunger", { exact: true })).toHaveLength(1);
    expect(view.container.querySelector(".status-bar-hunger .status-bar-compact-value")?.textContent).toBe("1,200/2,000");
    expect(view.container.querySelector(".status-bar-hunger .status-bar-track > .status-bar-compact-value")).toBeNull();
    expect(screen.getAllByText("EXP", { exact: true })).toHaveLength(1);
    expect(screen.queryByText("RAGE", { exact: true })).toBeNull();
    expect(view.container.querySelectorAll(".status-bar-compact-label .sr-only")).toHaveLength(3);

    const bars = Array.from(view.container.querySelectorAll<HTMLElement>(".status-bar-phone-dock"));
    expect(bars.map((bar) => bar.querySelector(".status-bar-compact-label")?.textContent)).toEqual([
      "HP",
      "EXP",
      "Hunger"
    ]);
  });

  it("keeps phone numeric values as direct siblings above their progress tracks", () => {
    const view = render(
      <ProgressionHud progression={progression} combat={combat} classSnapshot={null} variant="phoneDock" />
    );

    for (const kind of ["health", "experience", "rage"]) {
      const row = view.container.querySelector<HTMLElement>(`.status-bar-${kind}`);
      if (!row) throw new Error(`Missing ${kind} status row`);
      const value = row.querySelector<HTMLElement>(".status-bar-compact-value");
      const track = row.querySelector<HTMLElement>(".status-bar-track");
      if (!value || !track) throw new Error(`Missing ${kind} compact value or track`);
      expect(value.parentElement).toBe(row);
      expect(track.parentElement).toBe(row);
      expect(track.contains(value)).toBe(false);
      expect(value.compareDocumentPosition(track) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("keeps the default desktop labels and spaced values unchanged", () => {
    render(<ProgressionHud progression={progression} combat={combat} classSnapshot={null} />);

    expect(screen.getByText("Health", { exact: true })).toBeTruthy();
    expect(screen.getByText("Rage", { exact: true })).toBeTruthy();
    expect(screen.getByText("Experience", { exact: true })).toBeTruthy();
    expect(screen.getByText("94 / 100", { exact: true })).toBeTruthy();
    expect(screen.getByText("0 / 100", { exact: true })).toBeTruthy();
    expect(screen.getByText("397 / 800", { exact: true })).toBeTruthy();
  });

  it("rounds phone track readouts to whole numbers while retaining the authoritative range", () => {
    const view = render(
      <ProgressionHud
        progression={{ ...progression, xpIntoLevel: 397.4, xpForNextLevel: 800.6 }}
        combat={{ ...combat, currentHealth: 93.6, maxHealth: 100.4 }}
        classSnapshot={null}
        hunger={{ current: 1_200.4, baseCapacity: 2_000.6 }}
        variant="phoneDock"
      />
    );

    expect(view.container.querySelector(".status-bar-health .status-bar-compact-value")?.textContent).toBe("94/100");
    expect(view.container.querySelector(".status-bar-experience .status-bar-compact-value")?.textContent).toBe("397/801");
    expect(view.container.querySelector(".status-bar-hunger .status-bar-compact-value")?.textContent).toBe("1,200/2,001");
    expect(view.container.querySelector(".status-bar-health")?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("93.6");
    expect(view.container.querySelector(".status-bar-experience")?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("397.4");
  });

  it("labels an empty active weapon slot as unarmed", () => {
    render(<ProgressionHud progression={progression} combat={{
      ...combat,
      weaponCombat: {
        activeWeaponSlot: "melee",
        activeWeaponInstanceId: null,
        activeWeaponCategory: null,
        switchPolicy: "ranged_only",
        switchingToSlot: null,
        switchStartedAtTick: null,
        switchCompletesAtTick: null
      }
    }} classSnapshot={null} />);

    expect(screen.getByText("Auto · Unarmed", { exact: true })).toBeTruthy();
  });

  it("shows the resetting post-cap reward bar at Level 25", () => {
    render(<ProgressionHud progression={{
      ...progression,
      totalXp: 1_075_000,
      level: 25,
      xpIntoLevel: 75_000,
      xpForNextLevel: 250_000,
      nextLevelTotalXp: null,
      atCap: true
    }} combat={combat} classSnapshot={null} />);

    expect(screen.getByText("Level 25", { exact: true })).toBeTruthy();
    expect(screen.getByText("75,000 / 250,000", { exact: true })).toBeTruthy();
  });

  it("shows the arrival protection countdown with its cancellation rule", () => {
    render(
      <ProgressionHud
        progression={progression}
        combat={combat}
        classSnapshot={null}
        flagArrivalProtectionRemainingMs={9_400}
      />
    );

    expect(screen.getByRole("status", {
      name: "Arrival protection · 10s · Move or attack to end"
    })).toBeTruthy();
  });

  it("mounts first combat health at its authoritative value without fake damage", () => {
    const view = render(
      <ProgressionHud progression={progression} combat={null} classSnapshot={null} />
    );

    view.rerender(
      <ProgressionHud progression={progression} combat={combat} classSnapshot={null} />
    );

    expect(view.container.querySelector(".hp-bar-damage-trail")?.getAttribute("data-active"))
      .toBe("false");
  });

  it("keeps Aggro out of the phone EXP track while retaining the desktop status", () => {
    const view = render(
      <ProgressionHud
        progression={progression}
        combat={combat}
        classSnapshot={null}
        aggressiveRemainingMs={90_000}
        variant="phoneDock"
      />
    );

    expect(view.container.querySelector(".status-bar-experience .status-bar-compact-value")?.textContent).toBe("397/800");
    expect(screen.queryByRole("status", { name: "Aggressive for 90.0s" })).toBeNull();
    expect(view.container.querySelector(".status-bar-experience")?.textContent).toContain("397/800");
    view.rerender(
      <ProgressionHud
        progression={progression}
        combat={combat}
        classSnapshot={null}
        aggressiveRemainingMs={90_000}
      />
    );
    expect(screen.getByRole("status", { name: "Aggressive for 90.0s" })).toBeTruthy();
  });
});
