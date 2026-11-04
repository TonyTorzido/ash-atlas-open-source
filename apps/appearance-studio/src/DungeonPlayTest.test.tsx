// @vitest-environment jsdom
import { DUNGEON_CATALOG, type DungeonSnapshot, type PlayerAppearanceSnapshot } from "@ash-atlas/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioApi } from "./studioApi.js";
import { StudioApiError } from "./studioApi.js";
import type { SequencedPlaytestFrame } from "./dungeonPlaytestRoutes.js";
import type { CreatePlaytestInput, PlaytestCommand } from "./dungeonPlaytestContracts.js";

vi.mock("../../client/src/ui/DungeonZoneLayer.js", () => ({
  DungeonZoneLayer: (props: { snapshot: DungeonSnapshot; onSelectEnemy(enemy: { entityId: string }): void; onMove(x: number, y: number): void }) => <div aria-label="Canonical dungeon scene"><span>{props.snapshot.spaceId}</span><button onClick={() => props.onSelectEnemy({ entityId: "enemy" })}>Select enemy</button><button onClick={() => props.onMove(300, 400)}>Move normally</button></div>
}));
import { DungeonPlayTest } from "./DungeonPlayTest.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function fixture(runId = "run-1", sequence = 1, cues: string[] = []): SequencedPlaytestFrame {
  const dungeon = DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "cistern_warrens")!;
  const room = dungeon.rooms.find((room) => room.id === dungeon.entrance.roomId)!;
  return {
    runId, sequence, seed: "fixture", mode: "full", lifecycle: "PLAYING", classId: "warrior", weaponName: "Axe", armorName: "Breastplate",
    appearance: {} as PlayerAppearanceSnapshot, debug: { invulnerable: false, aiEnabled: true, aggroEnabled: true, speed: 1 }, events: [], portalMessages: [], drops: [], log: [], geometry: { playerCollisionRadius: 8, playerAttackRange: 10, mobs: [], spawns: [] }, sandbox: { storageAttempts: 0, inventory: {}, gold: 0, cityCoins: 0, exited: false },
    combatEntities: [{ entityId: "enemy", kind: "mob", archetypeKey: "sewer_rat", name: "Sewer Rat", level: 1, regionCode: "interior:test", zoneId: "interior:test:room", lat: 0, lon: 0, currentHealth: 100, maxHealth: 100, lifeState: "alive", activityState: "idle", targetEntityId: null, revision: 1 }],
     snapshot: { snapshotKind: "full", catalogRevision: DUNGEON_CATALOG.catalogRevision, sceneRevision: "test", dungeonId: dungeon.id, dungeonRevision: dungeon.revision, entranceId: "entrance", name: dungeon.name, description: dungeon.description, instancePolicy: dungeon.instancePolicy, portalId: dungeon.entrance.portalId, presentation: "door", assetKey: null, sessionId: runId, instanceId: runId, spaceId: room.id, roomWidth: room.width, roomHeight: room.height, playerVisualHeight: 35, camera: room.camera, environment: { ...dungeon.environment, ...room.environment }, player: { playerId: "test-player", name: "Warrior", displayColor: null, x: 125, y: 150, targetX: null, targetY: null, targetEntityId: null, movementSpeed: 130, movementRevision: 0, currentHealth: 100, maxHealth: 100 }, occupants: [], room, prefabs: DUNGEON_CATALOG.prefabs, enemies: [], objects: [], resources: [], telegraphs: [], encounters: [], triggers: [], dungeonFlags: {}, portalLocks: {}, completed: false, resetDeadline: null, cues, status: "", serverTime: 1000 }
  };
}
function harness(initial = fixture()) {
  let current = initial;
  const start = vi.fn(async (input: CreatePlaytestInput): Promise<SequencedPlaytestFrame> => { void input; current = { ...initial, runId: `run-${start.mock.calls.length}`, sequence: 1 }; return current; });
  const command = vi.fn(async (_id: string, value: PlaytestCommand) => { current = { ...current, sequence: current.sequence + 1, ...(value.type === "debug" ? { lifecycle: value.paused ? "DEBUG_PAUSED" as const : "PLAYING" as const } : {}) }; return current; });
  const api = { startDungeonPlaytest: start, advanceDungeonPlaytest: vi.fn(async () => current), commandDungeonPlaytest: command, stopDungeonPlaytest: vi.fn(async () => undefined) };
  return { api, start, command };
}
function view(api: unknown, mode: "full" | "room" = "full") {
  return render(<DungeonPlayTest api={api as StudioApi} catalog={DUNGEON_CATALOG} dungeonId={DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "cistern_warrens")!.id} roomId={DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "cistern_warrens")!.rooms[1]!.id} mode={mode} onExit={vi.fn()} />);
}

describe("Dungeon Studio real-runtime transport", () => {
  it("distinguishes full start from selected-room start and passes an isolated definition", async () => {
    const { api, start } = harness(); const before = structuredClone(DUNGEON_CATALOG);
    const mounted = view(api);
    await screen.findByLabelText("Canonical dungeon scene");
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ mode: "full", dungeonId: DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "cistern_warrens")!.id }));
    expect(start.mock.calls[0]?.[0]).not.toHaveProperty("roomId");
    expect(start.mock.calls[0]?.[0].catalog).not.toBe(DUNGEON_CATALOG);
    expect(DUNGEON_CATALOG).toEqual(before);
    expect(screen.queryByRole("complementary", { name: "Play Test debugging" })).toBeNull();
    mounted.unmount(); view(api, "room");
    await screen.findByLabelText("Canonical dungeon scene");
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "room", roomId: DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "cistern_warrens")!.rooms[1]!.id }));
    expect(screen.getByText(/Room-only test/)).toBeTruthy();
  });

  it("uses actual attack and movement commands after explicit selection", async () => {
    const { api, command } = harness(); view(api);
    await screen.findByLabelText("Canonical dungeon scene");
    fireEvent.click(screen.getByRole("button", { name: "Select enemy" }));
    expect(command).not.toHaveBeenCalled();
    const prompt = screen.getByLabelText("Sewer Rat actions");
    fireEvent.click(within(prompt).getByRole("button", { name: "Attack" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("run-1", { type: "attack", targetEntityId: "enemy" }));
    fireEvent.click(screen.getByRole("button", { name: "Move normally" }));
    await waitFor(() => expect(command).toHaveBeenLastCalledWith("run-1", { type: "move", x: 300, y: 400 }));
    expect(screen.queryByText("Finish fight")).toBeNull();
  });

  it("exposes full healing in the main play test controls through the sandbox command", async () => {
    const { api, command } = harness(); view(api);
    await screen.findByLabelText("Canonical dungeon scene");
    fireEvent.click(screen.getByRole("button", { name: "Fully Heal" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("run-1", { type: "heal" }));
  });

  it("exposes bounded damage for the selected living enemy through the sandbox command", async () => {
    const { api, command } = harness(); view(api);
    await screen.findByLabelText("Canonical dungeon scene");
    const damage = screen.getByRole("button", { name: "1,000 Damage" });
    expect(damage.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Select enemy" }));
    expect(damage.hasAttribute("disabled")).toBe(false);
    fireEvent.click(damage);
    await waitFor(() => expect(command).toHaveBeenCalledWith("run-1", { type: "damage", targetEntityId: "enemy", amount: 1000 }));
  });

  it("surfaces runtime warning and error cues as actionable diagnostics", async () => {
    const { api } = harness(fixture("run-1", 1, [
      "warning:resource_zone_underfilled:room:zone",
      "error:reward_grant_failed:chest"
    ]));
    view(api);
    const diagnostics = await screen.findByRole("alert", { name: "Dungeon runtime diagnostics" });
    expect(within(diagnostics).getByText("warning:resource_zone_underfilled:room:zone")).toBeTruthy();
    expect(within(diagnostics).getByText("error:reward_grant_failed:chest")).toBeTruthy();
    expect(within(diagnostics).getByText(/Resolve these authored runtime warnings/)).toBeTruthy();
    expect(within(diagnostics).getByText("Resource zone is underfilled")).toBeTruthy();
    expect(within(diagnostics).getByText("Reward delivery failed")).toBeTruthy();
  });

  it("does not treat presentation cues as runtime diagnostics", async () => {
    const { api } = harness(fixture("run-1", 1, ["encounter-active", "portal-open"]));
    view(api);
    await screen.findByLabelText("Canonical dungeon scene");
    expect(screen.queryByRole("alert", { name: "Dungeon runtime diagnostics" })).toBeNull();
  });

  it("shows field paths and messages when a Play Test request is rejected", async () => {
    const { api } = harness();
    api.startDungeonPlaytest = vi.fn(() => Promise.reject(new StudioApiError(
      "Invalid dungeon Play Test definition.", 400, "PLAYTEST_INPUT_INVALID",
      [{ path: "seed", message: "String must contain at least 1 character(s)" }]
    )));
    view(api);
    const failure = await screen.findByRole("status");
    expect(failure.textContent).toContain("seed: String must contain at least 1 character(s)");
  });

  it("recreates every full restart from Start, retaining or replacing the seed explicitly", async () => {
    const { api, start } = harness(); view(api, "room");
    await screen.findByLabelText("Canonical dungeon scene");
    const firstSeed = start.mock.calls[0]?.[0].seed;
    fireEvent.click(screen.getByRole("button", { name: "Restart Dungeon" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1]?.[0]).toMatchObject({ mode: "full", seed: firstSeed });
    expect(start.mock.calls[1]?.[0]).not.toHaveProperty("roomId");
    await screen.findByLabelText("Canonical dungeon scene");
    fireEvent.click(screen.getByRole("button", { name: "Debug" }));
    fireEvent.click(screen.getByRole("button", { name: "New Simulated Run" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(3));
    expect(start.mock.calls[2]?.[0].mode).toBe("full");
    expect(start.mock.calls[2]?.[0].seed).not.toBe(firstSeed);
    expect(api.stopDungeonPlaytest).toHaveBeenCalledWith("run-1");
  });

  it("disposes a late start after unmount without installing the obsolete frame", async () => {
    const { api } = harness();
    let finish!: (frame: SequencedPlaytestFrame) => void;
    api.startDungeonPlaytest = vi.fn(() => new Promise<SequencedPlaytestFrame>((resolve) => { finish = resolve; }));
    const mounted = view(api); mounted.unmount();
    await act(async () => { finish(fixture("late")); });
    expect(api.stopDungeonPlaytest).toHaveBeenCalledWith("late");
    expect(api.advanceDungeonPlaytest).not.toHaveBeenCalled();
  });

  it("pauses through the runtime and exits through disposal", async () => {
    const { api, command } = harness(); view(api);
    await screen.findByLabelText("Canonical dungeon scene");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("run-1", { type: "debug", paused: true }));
    expect(screen.getByLabelText("Dungeon Play Test").getAttribute("data-playtest-state")).toBe("DEBUG_PAUSED");
    fireEvent.click(screen.getByRole("button", { name: "Exit Play Test" }));
    await waitFor(() => expect(api.stopDungeonPlaytest).toHaveBeenCalledWith("run-1"));
  });

  it("leaves Space on focused toolbar controls to native button activation", async () => {
    const { api, command } = harness(); view(api);
    await screen.findByLabelText("Canonical dungeon scene");
    fireEvent.click(screen.getByRole("button", { name: "Select enemy" }));
    const pause = screen.getByRole("button", { name: "Pause" });
    pause.focus();
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "Space", key: " " });
    pause.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(command).not.toHaveBeenCalled();
  });

  it("clears combat selection and remounts the canonical scene when restarting a room", async () => {
    const { api, command } = harness(); view(api);
    const originalScene = await screen.findByLabelText("Canonical dungeon scene");
    fireEvent.click(screen.getByRole("button", { name: "Select enemy" }));
    expect(screen.getByLabelText("Sewer Rat actions")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart Room" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("run-1", { type: "restart_room" }));
    await waitFor(() => expect(screen.queryByLabelText("Sewer Rat actions")).toBeNull());
    expect(screen.getByLabelText("Canonical dungeon scene")).not.toBe(originalScene);
    expect(screen.getByRole("button", { name: "Attack selected enemy Space" }).hasAttribute("disabled")).toBe(true);
  });
});
