// @vitest-environment jsdom

import type { CombatEntitySnapshot } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GoblinInteractionPrompt,
  combatEntityPrimaryInteraction,
  isGoblinInteractionTarget
} from "./GoblinInteractionPrompt.js";

afterEach(cleanup);

describe("GoblinInteractionPrompt", () => {
  it("offers Talk and Cancel without combat actions or metadata", () => {
    const onTalk = vi.fn();
    const onClose = vi.fn();
    render(<GoblinInteractionPrompt target={defender()} onTalk={onTalk} onClose={onClose} />);

    expect(screen.getByText("GOBLIN")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Talk" }));
    expect(onTalk).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Attack" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Shield Charge" })).toBeNull();
    expect(screen.queryByText(/HP|Melee range|Level 10/i)).toBeNull();
  });

  it("shows one read-only conversation line with Close", () => {
    const onClose = vi.fn();
    render(<GoblinInteractionPrompt
      target={defender()}
      conversationLine="Your boots are louder than your thoughts."
      onTalk={vi.fn()}
      onClose={onClose}
    />);
    expect(screen.getByText("CONVERSATION")).toBeTruthy();
    expect(screen.getByText("Your boots are louder than your thoughts.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Talk" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("routes only neutral city Goblin NPCs to conversation", () => {
    expect(isGoblinInteractionTarget(defender())).toBe(true);
    expect(combatEntityPrimaryInteraction(defender())).toBe("talk");
    expect(isGoblinInteractionTarget({ ...defender(), npcFaction: null })).toBe(false);
    expect(combatEntityPrimaryInteraction({ ...defender(), npcFaction: null })).toBe("attack");
    const hostileDefender = {
      ...defender(),
      npcFaction: { ...defender().npcFaction!, relation: "enemy" }
    } satisfies CombatEntitySnapshot;
    expect(isGoblinInteractionTarget(hostileDefender)).toBe(false);
    expect(combatEntityPrimaryInteraction(hostileDefender)).toBe("attack");
  });
});

function defender(): CombatEntitySnapshot {
  return {
    entityId: "goblin:defender", kind: "mob", archetypeKey: "goblin",
    name: "Goblin Warrior", level: 10, regionCode: "NM", zoneId: "world:NM",
    lat: 35, lon: -106, maxHealth: 180, currentHealth: 180, lifeState: "alive",
    activityState: "idle", targetEntityId: null, revision: 1,
    npcFaction: {
      cityId: "11111111-1111-4111-8111-111111111111", cityName: "Goblin Village",
      culture: "goblin", role: "warrior", presentationKey: "goblin_warrior",
      relation: "neutral", protected: true
    }
  };
}
