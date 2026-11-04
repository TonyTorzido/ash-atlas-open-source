// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CombatPresentationController } from "../combat/combatPresentation.js";
import { lootGoldHold } from "../combat/lootFly.js";
import { CombatRewardHud } from "./CombatRewardHud.js";

vi.mock("@ash-atlas/player-renderer", () => ({
  projectileAimRadians: () => 0
}));
vi.mock("./ItemArtwork.js", () => ({
  itemArtworkSource: () => "/assets/items/coin.png",
  itemArtworkStyle: () => ({})
}));

afterEach(cleanup);

const laneStyles = readFileSync(resolve(process.cwd(), "src/hudLanes.css"), "utf8");

function enqueue(controller: CombatPresentationController, id: string, extra: Record<string, unknown>, at: number): void {
  act(() => controller.enqueueFloatingFeedback({
    eventId: id,
    targetEntityId: "player-1",
    ...extra
  } as never, at));
}

describe("CombatRewardHud loot feed", () => {
  it("renders one row per reward outside a hidden map and keeps it through a scene clear", () => {
    const controller = new CombatPresentationController();
    render(<>
      <div className="map-root world-map-suspended" />
      <CombatRewardHud controller={controller} />
    </>);
    const createdAt = performance.now();
    enqueue(controller, "reward-1", { kind: "profession_xp", amount: 12, subject: "Hunter" }, createdAt);
    enqueue(controller, "reward-1", { kind: "profession_xp", amount: 12, subject: "Hunter" }, createdAt + 1);

    expect(document.querySelectorAll(".hud-loot-row")).toHaveLength(1);
    expect(document.querySelector(".hud-loot-text")?.textContent).toBe("+12 Hunter XP");
    expect(document.querySelectorAll('[data-combat-reward-event-id="reward-1"]')).toHaveLength(1);

    act(() => controller.clearScene());

    expect(document.querySelectorAll(".hud-loot-row")).toHaveLength(1);
    expect(controller.floatingFeedback.seenEventCount()).toBe(1);
  });

  it("merges identical XP into one counting row; item and gold gains fly instead of becoming rows", () => {
    const controller = new CombatPresentationController();
    render(<CombatRewardHud controller={controller} />);
    const now = performance.now() - 200;
    enqueue(controller, "x1", { kind: "profession_xp", amount: 20, subject: "Hunter" }, now);
    enqueue(controller, "x2", { kind: "profession_xp", amount: 5, subject: "Hunter" }, now + 5);
    enqueue(controller, "i1", { kind: "resource", amount: 1, icon: "wood", subject: "Wood" }, now + 10);
    enqueue(controller, "i1", { kind: "resource", amount: 1, icon: "wood", subject: "Wood" }, now + 11);
    enqueue(controller, "i2", { kind: "resource", amount: 3, icon: "wood", subject: "Wood" }, now + 12);
    enqueue(controller, "g1", { kind: "gold", amount: 250 }, now + 30);

    const log = screen.getByRole("log", { name: "Loot and experience" });
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(Array.from(log.querySelectorAll(".hud-loot-text")).map((node) => node.textContent))
      .toEqual(["+25 Hunter XP"]);
    // The HUD has no targets in jsdom, so the gains land at once; the duplicate event id counted once.
    expect(controller.floatingFeedback.floaters().map((f) => f.kind)).toEqual(["profession_xp", "profession_xp"]);
    expect(lootGoldHold.held(performance.now())).toBe(0);
  });

  it("queues gains with the label format and the pickup position", () => {
    const controller = new CombatPresentationController();
    controller.setWorldProjector(() => ({ x: 120, y: 340 }));
    controller.enqueueFloatingFeedback({
      eventId: "pickup:1", targetEntityId: "p", kind: "resource", amount: 3, icon: "wood", subject: "Wood",
      worldPosition: { lat: 1, lon: 2 }
    }, 10);
    controller.enqueueFloatingFeedback({ eventId: "pickup:1", targetEntityId: "p", kind: "resource", amount: 3, icon: "wood", subject: "Wood" }, 11);
    controller.enqueueFloatingFeedback({ eventId: "gold:1", targetEntityId: "p", kind: "gold", amount: 22 }, 12);
    const launches = controller.lootFly.takeLaunches(0, 20);
    expect(launches.map((l) => [l.kind, l.name, l.quantity])).toEqual([["gold", "Gold", 22], ["item", "Wood", 3]]);
    expect(launches[1]!.origin).toEqual({ x: 120, y: 340 });
    expect(controller.floatingFeedback.floaters()).toEqual([]);
    controller.lootFly.clear();
  });

  it("shows no card for a kill: common drops only fly, rare drops get one pill", () => {
    const controller = new CombatPresentationController();
    render(<CombatRewardHud controller={controller} />);
    act(() => controller.enqueueLootCard({
      id: "kill:t1", source: "kill", boss: false, eyebrow: null, heading: "Dune Wolf",
      createdAtMs: 0, expiresAtMs: 5_000,
      entries: [
        { key: "g", kind: "gold", itemId: null, name: "Gold", quantity: 22, rarity: "common" },
        { key: "l", kind: "item", itemId: "leather", name: "Leather", quantity: 2, rarity: "common" },
        { key: "r", kind: "item", itemId: "wolf_ring", name: "Wolf Ring", quantity: 1, rarity: "rare" }
      ]
    }));
    expect(document.querySelector(".hud-loot-card")).toBeNull();
    expect(document.querySelectorAll(".hud-loot-pill")).toHaveLength(1);
    expect(document.querySelector(".hud-loot-pill")?.getAttribute("data-rarity")).toBe("rare");
    expect(document.querySelector(".hud-loot-pill-name")?.textContent).toBe("Wolf Ring");
    // No HUD targets exist in this tree, so the coin lands at once and its gold hold is lifted.
    expect(lootGoldHold.held(performance.now())).toBe(0);
  });

  it("owns a fixed lane that never reuses the top-centre chat area on desktop", () => {
    const feed = laneStyles.match(/\.hud-loot-feed\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(feed).toContain("position: fixed;");
    const desktop = laneStyles.match(/\[data-presentation="desktop"\] \.hud-loot-feed\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(desktop).toContain("bottom: var(--hud-lane-loot-bottom);");
  });
});
