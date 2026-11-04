// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CombatTargetPrompt } from "./CombatTargetPrompt.js";

afterEach(cleanup);

const target = {
  entityId: "mob:1",
  kind: "mob" as const,
  archetypeKey: "goblin" as const,
  name: "Goblin",
  level: 10,
  regionCode: "NM",
  zoneId: "world:NM",
  lat: 35.0844,
  lon: -106.6504,
  maxHealth: 60,
  currentHealth: 42,
  lifeState: "alive" as const,
  activityState: "attacking" as const,
  targetEntityId: "p1",
  revision: 3
};

describe("CombatTargetPrompt", () => {
  it("shows server health, distance, type, and explicit attack controls", () => {
    const markup = renderToStaticMarkup(
      <CombatTargetPrompt
        target={target}
        distanceM={18.4}
        disabled={false}
        onAttack={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(markup).toContain("Goblin");
    expect(markup).toContain("42 / 60 HP");
    expect(markup).toContain("18 m");
    expect(markup).toContain("Attack");
    expect(markup).toContain("hp-bar-fill");
    expect(markup).toContain("role=\"progressbar\"");
  });

  it("keeps Attack enabled and repeatable for the active target", () => {
    const onAttack = vi.fn();
    render(
      <CombatTargetPrompt
        target={target}
        distanceM={10}
        disabled={false}
        onAttack={onAttack}
        onClose={vi.fn()}
      />
    );
    const attack = screen.getByRole("button", { name: "Attack" });
    expect(attack.hasAttribute("disabled")).toBe(false);
    fireEvent.click(attack);
    expect(onAttack).toHaveBeenCalledOnce();
  });

  it("renders skills below Attack with Cancel last", () => {
    const onShieldCharge = vi.fn();
    render(<CombatTargetPrompt
      target={target}
      distanceM={10}
      disabled={false}
      skillActions={[{ key: "shield-charge", label: "Shield Charge", onSelect: onShieldCharge }]}
      onAttack={vi.fn()}
      onClose={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Shield Charge" }));
    expect(onShieldCharge).toHaveBeenCalledOnce();
    const labels = screen.getAllByRole("button").map((button) => button.textContent);
    expect(labels).toEqual(["Attack", "Shield Charge", "Cancel"]);
  });

  it("hides an unavailable skill but keeps a cooling one visible and disabled", () => {
    render(<CombatTargetPrompt
      target={target}
      distanceM={10}
      disabled={false}
      skillActions={[{ key: "shield-charge", label: "Shield Charge", enabled: false, onSelect: vi.fn() }]}
      onAttack={vi.fn()}
      onClose={vi.fn()}
    />);
    expect(screen.queryByRole("button", { name: "Shield Charge" })).toBeNull();
    cleanup();
    render(<CombatTargetPrompt target={target} distanceM={10} disabled={false}
      skillActions={[{ key: "pounce", label: "Pounce 12s", enabled: false, cooling: true, onSelect: vi.fn() }]}
      onAttack={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Pounce 12s" })).toHaveProperty("disabled", true);
  });

  it("lays skills out three per row with an odd remainder filling its row", () => {
    const skill = (key: string) => ({ key, label: key, onSelect: vi.fn() });
    const view = render(<CombatTargetPrompt target={target} distanceM={10} disabled={false}
      skillActions={["a", "b", "c", "d"].map(skill)} onAttack={vi.fn()} onClose={vi.fn()} />);
    const rows = Array.from(view.container.querySelectorAll<HTMLElement>(".game-compact-skill-row"));
    expect(rows.map((row) => row.children.length)).toEqual([3, 1]);
    expect(rows[1]!.style.gridTemplateColumns).toBe("repeat(1, minmax(0, 1fr))");
  });

  it("does not execute the selected target action until the prompt button is pressed", () => {
    const onAttack = vi.fn();
    render(<CombatTargetPrompt target={target} distanceM={18.4} disabled={false} onAttack={onAttack} onClose={vi.fn()} />);
    expect(screen.getByLabelText("Combat target")).toBeTruthy();
    expect(onAttack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Attack" }));
    expect(onAttack).toHaveBeenCalledOnce();
  });

  it("hides the primary action while it is unavailable", () => {
    render(
      <CombatTargetPrompt
        target={{ ...target, archetypeKey: "xoral", bossEventState: "dormant" }}
        distanceM={10}
        disabled={false}
        disabledReason="Only the party leader may start The Xoral event."
        primaryActionLabel="Start Event"
        onAttack={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Start Event" })).toBeNull();
    expect(screen.queryByText("Only the party leader may start The Xoral event.")).toBeNull();
  });
});
