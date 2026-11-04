// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BossCastSnapshot,
  BossEncounterProjection,
  CombatEntitySnapshot
} from "@ash-atlas/shared";

import { BossEncounterHud, isRenderableBoss } from "./BossEncounterHud.js";
import { BossTelegraphLayer } from "./BossTelegraphLayer.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const cast: BossCastSnapshot = {
  encounterId: "dungeon-instance-1:run-1:room-1",
  bossId: "test-boss",
  abilityId: "cone_cleave",
  castInstanceId: "cast-1",
  startTime: 900,
  resolveTime: 2_200,
  origin: { lat: 0, lon: 0 },
  facingDegrees: 0,
  geometry: {
    kind: "cone",
    origin: { lat: 0, lon: 0 },
    facingDegrees: 0,
    rangeM: 8,
    angleDegrees: 70
  },
  lifeGeneration: 3
};

const projection: BossEncounterProjection = {
  encounterId: "dungeon-instance-1:run-1:room-1",
  bossId: "test-boss",
  bossRevision: 1,
  encounterHandlerId: "dungeon",
  hostKind: "dungeon",
  hostInstanceId: "dungeon-instance-1",
  encounterInstanceId: "dungeon-instance-1:run-1:room-1",
  mobEntityId: "mob-1",
  lifecycleState: "active",
  phaseId: null,
  lifeGeneration: 3,
  participation: {
    policyId: "room-party",
    canJoin: true,
    participantIds: ["player-1"]
  },
  activeCasts: [cast]
};

const boss = {
  entityId: "mob-1",
  kind: "mob",
  name: "Test Warden",
  currentHealth: 720,
  maxHealth: 1_000,
  level: 12,
  lifeState: "alive",
  boss: true,
  bossEncounter: projection
} as unknown as CombatEntitySnapshot;

describe("BossEncounterHud", () => {
  it("uses explicit encounter projection for identity, health, and cast countdown", () => {
    vi.useFakeTimers();
    render(<BossEncounterHud boss={boss} synchronizedNow={() => 1_000} />);

    expect(screen.getByRole("region", { name: "Test Warden boss encounter" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Test Warden health" })
      .getAttribute("aria-valuenow")).toBe("720");
    expect(screen.getByRole("status").textContent).toContain("cone cleave in 1.2s");
    expect(screen.getByRole("region").getAttribute("data-boss-encounter-id"))
      .toBe(projection.encounterId);
  });

  it("does not present an archetype-only or inactive boss", () => {
    const archetypeOnly = { ...boss, bossEncounter: undefined } as unknown as CombatEntitySnapshot;
    expect(isRenderableBoss(archetypeOnly)).toBe(false);
    expect(isRenderableBoss({
      ...boss,
      bossEncounter: { ...projection, lifecycleState: "dormant" }
    } as unknown as CombatEntitySnapshot)).toBe(false);
  });

  it("keeps active identity visible when the projection says this player cannot join", () => {
    vi.useFakeTimers();
    const unavailable = {
      ...boss,
      bossEncounter: {
        ...projection,
        participation: { ...projection.participation, canJoin: false }
      }
    } as unknown as CombatEntitySnapshot;
    expect(isRenderableBoss(unavailable)).toBe(true);
    render(<BossEncounterHud boss={unavailable} synchronizedNow={() => 1_000} />);
    expect(screen.getByText("Participation unavailable")).toBeTruthy();
  });

  it("labels the server-projected steam phase and deadline", () => {
    vi.useFakeTimers();
    render(<BossEncounterHud
      boss={{
        ...boss,
        bossEncounter: { ...projection, phaseId: "steam", phaseDeadlineAt: 5_000 }
      } as unknown as CombatEntitySnapshot}
      synchronizedNow={() => 1_000}
    />);

    expect(screen.getByText("Steam / Enraged · 4.0s")).toBeTruthy();
  });

  it("labels the Golem Forge anvil strike counter and monolith count", () => {
    const { unmount } = render(<BossEncounterHud
      boss={{ ...boss, bossEncounter: { ...projection, phaseId: "anvil_strikes_2" } } as unknown as CombatEntitySnapshot}
      synchronizedNow={() => 1_000}
    />);
    expect(screen.getByText("Anvil strikes 2/3")).toBeTruthy();
    unmount();
    render(<BossEncounterHud
      boss={{ ...boss, bossEncounter: { ...projection, phaseId: "enraged_monoliths_1" } } as unknown as CombatEntitySnapshot}
      synchronizedNow={() => 1_000}
    />);
    expect(screen.getByText("Enraged · Monoliths 1/4")).toBeTruthy();
  });

  it("labels the Corrupted Core's possessed husk and its exposed window", () => {
    const { unmount } = render(<BossEncounterHud
      boss={{ ...boss, bossEncounter: { ...projection, phaseId: "possessing_2" } } as unknown as CombatEntitySnapshot}
      synchronizedNow={() => 1_000}
    />);
    expect(screen.getByText("Husk 2/4")).toBeTruthy();
    unmount();
    render(<BossEncounterHud
      boss={{ ...boss, bossEncounter: { ...projection, phaseId: "enraged_exposed_3" } } as unknown as CombatEntitySnapshot}
      synchronizedNow={() => 1_000}
    />);
    expect(screen.getByText("Enraged · Core exposed · x2 damage")).toBeTruthy();
  });
});

describe("BossTelegraphLayer", () => {
  it("renders the shared authoritative cone geometry and removes expired casts", () => {
    const view = render(<BossTelegraphLayer
      telegraphs={[cast]}
      roomWidth={1_000}
      roomHeight={1_000}
      serverNow={1_000}
    />);
    const path = view.container.querySelector('[data-telegraph-kind="cone"]');
    expect(path).toBeTruthy();
    expect(path?.getAttribute("data-cast-instance-id")).toBe(cast.castInstanceId);
    expect(path?.getAttribute("d")).toContain("M");

    view.rerender(<BossTelegraphLayer
      telegraphs={[cast]}
      roomWidth={1_000}
      roomHeight={1_000}
      serverNow={2_200}
    />);
    expect(view.container.querySelector(".boss-telegraph")).toBeNull();
  });
});
