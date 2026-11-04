// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  destinationPoint,
  MILITARY_FUSION_RANGE_M,
  SIEGE_ATTACK_RANGE_METERS,
  type CombatEntitySnapshot,
  type FlagSnapshot,
  type LatLon,
  type MilitaryUnitGroupSnapshot,
  type MilitaryUnitSnapshot
} from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MilitaryGroupCommandPrompt } from "./MilitaryGroupCommandPrompt.js";

const playerId = "player-1";
const origin: LatLon = { lat: 35.0844, lon: -106.6504 };

afterEach(cleanup);

describe("MilitaryGroupCommandPrompt", () => {
  it("keeps ownership, command range, and recovery reasons in the canonical action prompt", () => {
    const onFollow = vi.fn();
    const group = makeGroup({ locationState: "STATIONED_CITY" });
    renderPrompt({
      group,
      ownPlayerId: "another-player",
      playerPosition: { lat: origin.lat + 0.01, lon: origin.lon },
      onFollow
    });

    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    expect(screen.queryByText("This military group belongs to another player.")).toBeNull();
    expect(onFollow).not.toHaveBeenCalled();
  });

  it("lets the owner choose one in-range Infantry combat target", () => {
    const onAttack = vi.fn();
    const onCancel = vi.fn();
    const target = makeCombatTarget({ entityId: "enemy-player", lat: origin.lat, lon: origin.lon + 0.0004 });
    const outOfRange = makeCombatTarget({
      entityId: "far-player",
      name: "Far Player",
      lat: origin.lat,
      lon: origin.lon + 0.002
    });
    const ownTarget = makeCombatTarget({ entityId: playerId, name: "Own Player" });
    renderPrompt({
      group: makeGroup({ unitType: "infantry", memberCount: 2, memberUnitIds: ["unit-1", "unit-2"] }),
      combatTargets: [target, outOfRange, ownTarget],
      onAttack,
      onCancel
    });

    fireEvent.click(screen.getByRole("button", { name: "Attack" }));
    expect(screen.getByRole("dialog", { name: "Choose Combat Target for Infantry group" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Far Player/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Own Player/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Enemy Player/ }));

    expect(onAttack).toHaveBeenCalledWith("group-1", "enemy-player");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("offers Plant Bomb and Merge while keeping combat commands out of Bomber prompts", () => {
    const onDemolish = vi.fn();
    const flag = makeTargetFlag();
    const distantFlag = makeTargetFlag({
      id: "distant-flag",
      ownerUsername: "Distant",
      lat: destinationPoint(origin, SIEGE_ATTACK_RANGE_METERS, 0).lat,
      lon: destinationPoint(origin, SIEGE_ATTACK_RANGE_METERS, 0).lon
    });
    const combatTarget = makeCombatTarget({ entityId: "enemy-player", lat: origin.lat, lon: origin.lon + 0.0002 });
    renderPrompt({
      group: makeGroup({ unitType: "bomber", memberCount: 1, memberUnitIds: ["unit-1"] }),
      units: [makeUnit({ unitId: "unit-1", unitType: "bomber" })],
      combatTargets: [combatTarget],
      flagTargets: [flag, distantFlag],
      onDemolish
    });

    expect(screen.queryByRole("button", { name: "Attack" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plant Bomb" }));
    expect(screen.getByRole("dialog", { name: "Choose Structure Target for Kippen Bomber +1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Enemy Player/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Distant's Flag/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Enemy's Flag/ }));
    expect(onDemolish).toHaveBeenCalledWith("group-1", "flag-1");
  });

  it("uses lifecycle-specific Siege actions without stock military commands", () => {
    const onFollow = vi.fn();
    const onStay = vi.fn();
    const onDeploy = vi.fn();
    const onPackUp = vi.fn();
    const view = renderPrompt({
      group: makeGroup({
        unitType: "field_ballista",
        memberCount: 1,
        memberUnitIds: ["unit-1"],
        locationState: "PACKED_FIELD"
      }),
      units: [makeUnit({ unitId: "unit-1", unitType: "field_ballista" })],
      onFollow,
      onStay,
      onDeploy,
      onPackUp
    });

    expect(actionLabels()).toEqual(["Move to Me", "Follow", "Deploy", "Cancel"]);
    expect(screen.queryByRole("button", { name: "Defend / Stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop at City" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set Siege Target" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Follow" }));
    expect(onFollow).toHaveBeenCalledWith("group-1");

    view.rerender(<MilitaryGroupCommandPrompt
      group={makeGroup({
        unitType: "field_ballista",
        memberCount: 1,
        memberUnitIds: ["unit-1"],
        locationState: "FOLLOWING_PLAYER"
      })}
      city={null}
      warCamp={null}
      units={[makeUnit({ unitId: "unit-1", unitType: "field_ballista" })]}
      playerPosition={origin}
      ownPlayerId={playerId}
      onFollow={onFollow}
      onStay={onStay}
      onDeploy={onDeploy}
      onPackUp={onPackUp}
      onCancel={vi.fn()}
    />);
    expect(actionLabels()).toEqual(["Move to Me", "Stay", "Deploy", "Cancel"]);
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(onStay).toHaveBeenCalledWith("group-1");

    view.rerender(<MilitaryGroupCommandPrompt
      group={makeGroup({
        unitType: "field_ballista",
        memberCount: 1,
        memberUnitIds: ["unit-1"],
        locationState: "DEPLOYED_FIELD"
      })}
      city={null}
      warCamp={null}
      units={[makeUnit({ unitId: "unit-1", unitType: "field_ballista" })]}
      playerPosition={origin}
      ownPlayerId={playerId}
      onFollow={onFollow}
      onStay={onStay}
      onDeploy={onDeploy}
      onPackUp={onPackUp}
      onCancel={vi.fn()}
    />);
    expect(actionLabels()).toEqual(["Move to Me", "Follow", "Pack Up", "Cancel"]);
    expect(screen.queryByRole("button", { name: "Deploy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel last" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pack Up" }));
    expect(onPackUp).toHaveBeenCalledWith("group-1");
  });

  it("offers a hostile Siege attack to non-owners without requiring local member rows", () => {
    const onAttackSiege = vi.fn();
    renderPrompt({
      group: makeGroup({
        ownerPlayerId: "enemy-player",
        unitType: "field_ballista",
        memberUnitIds: ["enemy-unit-1", "enemy-unit-2"],
        memberCount: 2,
        currentHp: 275,
        maxHp: 300,
        locationState: "DEPLOYED_FIELD"
      }),
      units: [],
      onAttackSiege
    });

    expect(screen.getByText("HOSTILE SIEGE")).toBeTruthy();
    expect(actionLabels()).toEqual(["Attack", "Cancel"]);
    fireEvent.click(screen.getByRole("button", { name: "Attack" }));
    expect(onAttackSiege).toHaveBeenCalledWith("group-1");
  });

  it("uses the compact Kippen header without duplicate military metadata", () => {
    renderPrompt({
      group: makeGroup({
        unitType: "field_ballista",
        memberCount: 3,
        memberUnitIds: ["unit-1", "unit-2", "unit-3"],
        currentHp: 375,
        maxHp: 450,
        locationState: "DEPLOYED_FIELD"
      }),
      units: [
        makeUnit({ unitId: "unit-1", unitType: "field_ballista", currentHp: 150, maxHp: 150 }),
        makeUnit({ unitId: "unit-2", unitType: "field_ballista", currentHp: 150, maxHp: 150 }),
        makeUnit({ unitId: "unit-3", unitType: "field_ballista", currentHp: 75, maxHp: 150 })
      ]
    });

    expect(screen.getByRole("heading", { name: "Kippen Siege +3 · 375/450 HP" })).toBeTruthy();
    expect(screen.queryByText("MILITARY GROUP")).toBeNull();
    expect(screen.queryByText(/surviving/u)).toBeNull();
    expect(screen.queryByText("Deployed Field")).toBeNull();
  });

  it("hides Merge without a compatible source and shows no reason text", () => {
    renderPrompt({
      group: makeGroup({ unitType: "bomber", memberCount: 2, memberUnitIds: ["unit-1", "unit-2"] }),
      units: [
        makeUnit({ unitId: "unit-1", unitType: "bomber", currentHp: 60, maxHp: 60 }),
        makeUnit({ unitId: "unit-2", unitType: "bomber", currentHp: 60, maxHp: 60 })
      ],
      onMerge: vi.fn()
    });

    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.queryByText("No compatible owned Bomber group is within 1000 meters.")).toBeNull();
    expect(screen.queryByText("Split 1 + 1")).toBeNull();
  });

  it("removes Split from both fused Siege and Bomber prompts", () => {
    for (const unitType of ["field_ballista", "bomber"] as const) {
      const unitIds = ["unit-1", "unit-2"];
      renderPrompt({
        group: makeGroup({ unitType, memberCount: 2, memberUnitIds: unitIds }),
        units: unitIds.map((unitId) => makeUnit({ unitId, unitType }))
      });
      expect(screen.queryByRole("button", { name: /Split/u })).toBeNull();
      cleanup();
    }
  });

  it("shows the authoritative next-volley countdown and waits for its snapshot", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const firstDeadline = now + 60_000;
    const baseGroup = makeGroup({
      unitType: "field_ballista",
      memberCount: 1,
      memberUnitIds: ["unit-1"],
      locationState: "DEPLOYED_FIELD",
      nextFireAt: new Date(firstDeadline).toISOString()
    });
    const view = renderPrompt({
      group: baseGroup,
      units: [makeUnit({ unitId: "unit-1", unitType: "field_ballista" })],
      now
    });

    expect(screen.getByRole("status").textContent).toBe("Next volley · 60s");

    view.rerender(<MilitaryGroupCommandPrompt
      group={baseGroup}
      city={null}
      warCamp={null}
      units={[makeUnit({ unitId: "unit-1", unitType: "field_ballista" })]}
      playerPosition={origin}
      ownPlayerId={playerId}
      now={now + 1_100}
      onCancel={vi.fn()}
    />);
    expect(screen.getByRole("status").textContent).toBe("Next volley · 59s");

    view.rerender(<MilitaryGroupCommandPrompt
      group={baseGroup}
      city={null}
      warCamp={null}
      units={[makeUnit({ unitId: "unit-1", unitType: "field_ballista" })]}
      playerPosition={origin}
      ownPlayerId={playerId}
      now={firstDeadline}
      onCancel={vi.fn()}
    />);
    expect(screen.getByRole("status").textContent).toBe("Next volley · Finalizing…");

    const advancedDeadline = firstDeadline + 60_000;
    view.rerender(<MilitaryGroupCommandPrompt
      group={{ ...baseGroup, nextFireAt: new Date(advancedDeadline).toISOString(), revision: "2" }}
      city={null}
      warCamp={null}
      units={[makeUnit({ unitId: "unit-1", unitType: "field_ballista" })]}
      playerPosition={origin}
      ownPlayerId={playerId}
      now={firstDeadline}
      onCancel={vi.fn()}
    />);
    expect(screen.getByRole("status").textContent).toBe("Next volley · 60s");
  });

  it("shows a known in-range Tower arming instead of an idle Siege wait", () => {
    renderPrompt({
      group: makeGroup({ unitType: "field_ballista", memberCount: 1, memberUnitIds: ["unit-1"] }),
      units: [makeUnit({ unitId: "unit-1", unitType: "field_ballista" })],
      flagTargets: [makeTargetFlag({ upgradeTier: "tower", reinforcementLevel: 3, health: 1, maximumHealth: 2_700 })]
    });

    expect(screen.getByRole("status").textContent).toBe("Next volley · Arming…");
  });

  it("shows a server-deadline countdown while a Siege is packing", () => {
    const deadline = Date.parse("2026-01-01T00:00:30.000Z");
    const onCancel = vi.fn();
    const view = renderPrompt({
      group: makeGroup({
        unitType: "field_ballista",
        memberCount: 1,
        memberUnitIds: ["unit-1"],
        locationState: "PACKING_UP",
        packingCompletesAt: new Date(deadline).toISOString()
      }),
      units: [makeUnit({ unitId: "unit-1", unitType: "field_ballista" })],
      onCancel,
      now: deadline - 2_100
    });

    expect(screen.getByText("Packing up · 2.1s remaining.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pack Up" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move to Me" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.queryByText("A military operation is already in progress.")).toBeNull();

    view.rerender(<MilitaryGroupCommandPrompt
      group={makeGroup({
        unitType: "field_ballista",
        memberCount: 1,
        memberUnitIds: ["unit-1"],
        locationState: "PACKING_UP",
        packingCompletesAt: new Date(deadline).toISOString()
      })}
      city={null}
      warCamp={null}
      units={[makeUnit({ unitId: "unit-1", unitType: "field_ballista" })]}
      playerPosition={origin}
      ownPlayerId={playerId}
      now={deadline}
      onCancel={onCancel}
    />);
    expect(screen.getByText("Finalizing…")).toBeTruthy();
  });

  it("previews every eligible Siege target and deploys only after confirmation", () => {
    const onDeploy = vi.fn();
    const onDeployPreview = vi.fn();
    const edge = destinationPoint(origin, SIEGE_ATTACK_RANGE_METERS, 0);
    const outside = destinationPoint(origin, SIEGE_ATTACK_RANGE_METERS + 0.1, 0);
    renderPrompt({
      group: makeGroup({
        unitType: "field_ballista",
        memberCount: 1,
        memberUnitIds: ["unit-1"],
        locationState: "PACKED_FIELD"
      }),
      units: [makeUnit({ unitId: "unit-1", unitType: "field_ballista" })],
      flagTargets: [
        makeTargetFlag({ id: "near-flag", ownerUsername: "Near", lat: origin.lat, lon: origin.lon, upgradeTier: "tower", reinforcementLevel: 3, health: 2_700, maximumHealth: 2_700 }),
        makeTargetFlag({ id: "edge-flag", ownerUsername: "Edge", lat: edge.lat, lon: edge.lon, upgradeTier: "tower", reinforcementLevel: 3, health: 2_700, maximumHealth: 2_700 }),
        makeTargetFlag({ id: "outside-flag", ownerUsername: "Outside", lat: outside.lat, lon: outside.lon, upgradeTier: "tower", reinforcementLevel: 3, health: 2_700, maximumHealth: 2_700 }),
        makeTargetFlag({ id: "friendly-flag", ownerId: playerId, ownerUsername: "Ash", upgradeTier: "tower", reinforcementLevel: 3, health: 2_700, maximumHealth: 2_700 })
      ],
      onDeploy,
      onDeployPreview
    });

    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
    expect(screen.getByText(/2 eligible structures within 575m/)).toBeTruthy();
    expect(onDeploy).not.toHaveBeenCalled();
    expect(onDeployPreview).toHaveBeenLastCalledWith("group-1", ["edge-flag", "near-flag"]);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDeploy).not.toHaveBeenCalled();
    expect(onDeployPreview).toHaveBeenLastCalledWith("group-1", []);

    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Deploy" }));
    expect(onDeploy).toHaveBeenCalledOnce();
    expect(onDeploy).toHaveBeenCalledWith("group-1");
    expect(onDeployPreview).toHaveBeenLastCalledWith("group-1", []);
  });

  it("clears Siege deployment preview when the prompt is dismissed", () => {
    const onDeployPreview = vi.fn();
    const view = renderPrompt({
      group: makeGroup({ unitType: "field_ballista", memberCount: 1, memberUnitIds: ["unit-1"], locationState: "PACKED_FIELD" }),
      units: [makeUnit({ unitId: "unit-1", unitType: "field_ballista" })],
      flagTargets: [makeTargetFlag({ upgradeTier: "tower", reinforcementLevel: 3, health: 2_700, maximumHealth: 2_700 })],
      onDeploy: vi.fn(),
      onDeployPreview
    });

    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
    expect(onDeployPreview).toHaveBeenLastCalledWith("group-1", ["flag-1"]);
    view.unmount();
    expect(onDeployPreview).toHaveBeenLastCalledWith("group-1", []);
  });

  it("previews no targets when no Flag is within 575m", () => {
    const far = destinationPoint(origin, SIEGE_ATTACK_RANGE_METERS + 1, 0);
    renderPrompt({
      group: makeGroup({ unitType: "field_ballista", memberCount: 1, memberUnitIds: ["unit-1"], locationState: "PACKED_FIELD" }),
      units: [makeUnit({ unitId: "unit-1", unitType: "field_ballista" })],
      flagTargets: [makeTargetFlag({ id: "far-flag", ownerUsername: "Far", lat: far.lat, lon: far.lon, upgradeTier: "tower", reinforcementLevel: 3, health: 2_700, maximumHealth: 2_700 })],
      onDeploy: vi.fn()
    });

    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
    expect(screen.getByText(/No currently known eligible hostile structures are within 575m\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Far's Flag/ })).toBeNull();
  });

  it("opens one canonical source picker for compatible nearby Siege stacks", () => {
    const onMerge = vi.fn();
    const onCancel = vi.fn();
    const group = makeGroup({
      unitType: "field_ballista",
      memberCount: 1,
      memberUnitIds: ["unit-1"],
      locationState: "FOLLOWING_PLAYER"
    });
    const oneSiege = makeGroup({
      groupId: "group-2",
      unitType: "field_ballista",
      memberCount: 1,
      memberUnitIds: ["unit-2"],
      locationState: "FOLLOWING_PLAYER",
      lat: destinationPoint(origin, 900, 0).lat,
      lon: origin.lon
    });
    const twoSieges = makeGroup({
      groupId: "group-3",
      unitType: "field_ballista",
      memberCount: 2,
      memberUnitIds: ["unit-3", "unit-4"],
      locationState: "FOLLOWING_PLAYER",
      lat: destinationPoint(origin, 900, 180).lat,
      lon: origin.lon
    });
    const farSiege = makeGroup({
      groupId: "group-4",
      unitType: "field_ballista",
      memberCount: 1,
      memberUnitIds: ["unit-5"],
      locationState: "FOLLOWING_PLAYER",
      lat: destinationPoint(origin, MILITARY_FUSION_RANGE_M + 1, 0).lat,
      lon: destinationPoint(origin, MILITARY_FUSION_RANGE_M + 1, 0).lon
    });
    renderPrompt({
      group,
      units: [makeUnit({ unitId: "unit-1", unitType: "field_ballista" })],
      mergeCandidates: [oneSiege, twoSieges, farSiege],
      onMoveToMe: vi.fn(),
      onDeploy: vi.fn(),
      onMerge,
      onCancel
    });

    expect(screen.getByRole("button", { name: "Move to Me" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deploy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel last" })).toBeNull();
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(screen.getByRole("dialog", { name: "Choose Merge Source for Kippen Siege +1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Kippen Siege \+1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Kippen Siege \+2/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Kippen Siege \+2/ }));
    expect(onMerge).toHaveBeenCalledOnce();
    expect(onMerge).toHaveBeenCalledWith("group-1", "group-3");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("hides Merge at the fusion cap or without a source", () => {
    const onMerge = vi.fn();
    const { rerender } = renderPrompt({
      group: makeGroup({
        unitType: "field_ballista",
        memberCount: 6,
        memberUnitIds: ["unit-1", "unit-2", "unit-3", "unit-4", "unit-5", "unit-6"],
        locationState: "DEPLOYED_FIELD"
      }),
      units: Array.from({ length: 6 }, (_, index) => makeUnit({
        unitId: `unit-${index + 1}`,
        unitType: "field_ballista"
      })),
      onMerge
    });
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.queryByText("This group is already at the +6 fusion cap.")).toBeNull();
    expect(onMerge).not.toHaveBeenCalled();

    rerender(<MilitaryGroupCommandPrompt
      group={makeGroup({ unitType: "field_ballista", memberCount: 1, memberUnitIds: ["unit-1"], locationState: "DEPLOYED_FIELD" })}
      city={null}
      warCamp={null}
      units={[makeUnit({ unitId: "unit-1", unitType: "field_ballista" })]}
      playerPosition={origin}
      ownPlayerId={playerId}
      busy
      onMerge={onMerge}
      onCancel={vi.fn()}
    />);
    expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Another military command is in progress.")).toBeNull();
  });

  it("allows a visible owned group command from outside the old proximity radius", () => {
    const onFollow = vi.fn();
    renderPrompt({
      group: makeGroup({ locationState: "STATIONED_CITY" }),
      playerPosition: { lat: origin.lat + 0.01, lon: origin.lon },
      onFollow
    });

    const follow = screen.getByRole("button", { name: "Follow" }) as HTMLButtonElement;
    expect(follow.disabled).toBe(false);
    fireEvent.click(follow);
    expect(onFollow).toHaveBeenCalledWith("group-1");
  });

  it("sends Move to Me with the current player coordinate", () => {
    const onMoveToMe = vi.fn();
    renderPrompt({
      group: makeGroup({
        unitType: "field_ballista",
        locationState: "PACKED_FIELD",
        memberCount: 1,
        memberUnitIds: ["unit-1"]
      }),
      units: [makeUnit({ unitId: "unit-1", unitType: "field_ballista" })],
      onMoveToMe
    });

    fireEvent.click(screen.getByRole("button", { name: "Move to Me" }));
    expect(onMoveToMe).toHaveBeenCalledWith("group-1", origin);
  });
});

function renderPrompt({
  group = makeGroup(),
  units = [makeUnit({ unitId: "unit-1", unitType: group.unitType }), makeUnit({ unitId: "unit-2", unitType: group.unitType })],
  playerPosition = origin,
  ownPlayerId: owner = playerId,
  combatTargets = [],
  flagTargets = [],
  onFollow,
  onMoveToMe,
  onStay,
  onPackUp,
  onDeploy,
  onDeployPreview,
  onAttack,
  onAttackSiege,
  onDemolish,
  onSetBallistaTarget,
  mergeCandidates,
  onMerge,
  onCancel = vi.fn(),
  now
}: {
  group?: MilitaryUnitGroupSnapshot;
  units?: MilitaryUnitSnapshot[];
  playerPosition?: LatLon | null;
  ownPlayerId?: string | null;
  combatTargets?: CombatEntitySnapshot[];
  flagTargets?: FlagSnapshot[];
  onFollow?: (groupId: string) => void;
  onMoveToMe?: (groupId: string, position: LatLon) => void;
  onStay?: (groupId: string) => void;
  onPackUp?: (groupId: string) => void;
  onDeploy?: (groupId: string) => void;
  onDeployPreview?: (groupId: string, flagIds: readonly string[]) => void;
  onAttack?: (groupId: string, targetEntityId: string) => void;
  onAttackSiege?: (groupId: string) => void;
  onDemolish?: (groupId: string, targetFlagId: string) => void;
  onSetBallistaTarget?: (groupId: string, targetFlagId: string) => void;
  mergeCandidates?: MilitaryUnitGroupSnapshot[];
  onMerge?: (groupId: string, adjacentGroupId: string) => void;
  onCancel?: () => void;
  now?: number;
}) {
  return render(<MilitaryGroupCommandPrompt
    group={group}
    city={null}
    warCamp={null}
    units={units}
    playerPosition={playerPosition}
    ownPlayerId={owner}
    combatTargets={combatTargets}
    flagTargets={flagTargets}
    {...(mergeCandidates ? { mergeCandidates } : {})}
    {...(onFollow ? { onFollow } : {})}
    {...(onMoveToMe ? { onMoveToMe } : {})}
    {...(onStay ? { onStay } : {})}
    {...(onPackUp ? { onPackUp } : {})}
    {...(onDeploy ? { onDeploy } : {})}
    {...(onDeployPreview ? { onDeployPreview } : {})}
    {...(onAttack ? { onAttack } : {})}
    {...(onAttackSiege ? { onAttackSiege } : {})}
    {...(onDemolish ? { onDemolish } : {})}
    {...(onSetBallistaTarget ? { onSetBallistaTarget } : {})}
    {...(onMerge ? { onMerge } : {})}
    {...(now !== undefined ? { now } : {})}
    onCancel={onCancel}
  />);
}

function actionLabels(): string[] {
  return Array.from(screen.getByRole("complementary").querySelectorAll("button"))
    .map((button) => button.textContent?.trim() ?? "");
}

function makeGroup(
  overrides: Partial<MilitaryUnitGroupSnapshot> = {}
): MilitaryUnitGroupSnapshot {
  return {
    groupId: "group-1",
    ownerPlayerId: playerId,
    unitType: "infantry",
    memberUnitIds: ["unit-1", "unit-2"],
    memberCount: 2,
    currentHp: 200,
    maxHp: 200,
    locationState: "DEPLOYED_FIELD",
    stationCityId: null,
    warCampId: null,
    lat: origin.lat,
    lon: origin.lon,
    targetFlagId: null,
    nextFireAt: null,
    packingCompletesAt: null,
    revision: "1",
    ...overrides
  };
}

function makeUnit(
  overrides: Partial<MilitaryUnitSnapshot> = {}
): MilitaryUnitSnapshot {
  return {
    unitId: "unit-1",
    ownerPlayerId: playerId,
    unitType: "infantry",
    homeCityId: "city-1",
    currentHp: 100,
    maxHp: 100,
    status: "available",
    locationState: "DEPLOYED_FIELD",
    stationCityId: null,
    warCampId: null,
    lat: origin.lat,
    lon: origin.lon,
    groupId: "group-1",
    nextRecoveryAt: null,
    nextFireAt: null,
    targetFlagId: null,
    packingCompletesAt: null,
    revision: "1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function makeCombatTarget(
  overrides: Partial<CombatEntitySnapshot> = {}
): CombatEntitySnapshot {
  return {
    entityId: "enemy-player",
    kind: "player",
    archetypeKey: null,
    name: "Enemy Player",
    level: 5,
    regionCode: "US-NM",
    zoneId: "surface",
    lat: origin.lat,
    lon: origin.lon + 0.0002,
    maxHealth: 100,
    currentHealth: 100,
    lifeState: "alive",
    activityState: "idle",
    targetEntityId: null,
    queuedAbility: null,
    cooldownEndsAt: {},
    revision: 1,
    ...overrides
  } as CombatEntitySnapshot;
}

function makeTargetFlag(overrides: Partial<FlagSnapshot> = {}): FlagSnapshot {
  return {
    id: "flag-1",
    controlType: "personal",
    ownerId: "enemy-player",
    ownerUsername: "Enemy",
    name: "Enemy Flag",
    anchorKind: "flag",
    systemControlled: false,
    lat: origin.lat,
    lon: origin.lon + 0.0002,
    packageId: null,
    elevationM: null,
    terrainClass: null,
    biome: null,
    ecoregion: null,
    claimRadiusM: 100,
    cityId: null,
    kingdomId: null,
    reinforcementLevel: 1,
    upgradeTier: "stone",
    health: 220,
    maximumHealth: 220,
    burning: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  } as FlagSnapshot;
}
