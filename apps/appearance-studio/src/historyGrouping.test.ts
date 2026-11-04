import { describe, expect, it } from "vitest";
import { DEFAULT_BOSS_APPEARANCE_CATALOG, DEFAULT_PLAYER_APPEARANCE_CATALOG } from "@ash-atlas/shared";
import { bossStudioReducer, createBossStudioHistory } from "./bossStudioState.js";
import { burstGroup, gestureGroup, HISTORY_LIMIT, IDLE_GROUP_MS, resolveGroup } from "./historyCore.js";
import {
  createStudioHistory,
  studioReducer,
  withPlayerAnchorPosition,
  type StudioAction,
  type StudioHistory
} from "./studioState.js";

const base = DEFAULT_PLAYER_APPEARANCE_CATALOG;
const anchorAt = (x: number) => withPlayerAnchorPosition(base, "idle", "right_hand", x, 4);
const run = (state: StudioHistory, ...actions: StudioAction[]): StudioHistory => actions.reduce(studioReducer, state);
const edit = (x: number, extra: Partial<Extract<StudioAction, { type: "edit" }>> = {}): StudioAction =>
  ({ type: "edit", catalog: anchorAt(x), ...extra });

describe("shared undo grouping rules", () => {
  it("merges only same-key edits and expires burst groups after the idle time", () => {
    const first = resolveGroup(null, burstGroup("nudge:a"), 0);
    expect(first.coalesce).toBe(false);
    expect(resolveGroup(first.active, burstGroup("nudge:a"), IDLE_GROUP_MS).coalesce).toBe(true);
    expect(resolveGroup(first.active, burstGroup("nudge:a"), IDLE_GROUP_MS + 1).coalesce).toBe(false);
    expect(resolveGroup(first.active, burstGroup("nudge:b"), 10).coalesce).toBe(false);
    expect(resolveGroup(first.active, undefined, 10)).toEqual({ coalesce: false, active: null });
    const gesture = resolveGroup(null, gestureGroup(1), 0);
    expect(resolveGroup(gesture.active, gestureGroup(1), 60_000).coalesce).toBe(true);
  });

  it("keeps a larger history now that steps are meaningful", () => {
    expect(HISTORY_LIMIT).toBe(200);
    let state = createStudioHistory(base);
    for (let index = 1; index <= HISTORY_LIMIT + 20; index += 1) state = run(state, edit(index));
    expect(state.past).toHaveLength(HISTORY_LIMIT);
  });
});

describe("Appearance history grouping", () => {
  it("records a pointer drag of many moves, with pauses, as exactly one undo step", () => {
    const start = createStudioHistory(base);
    const gesture = gestureGroup(1);
    let state = start;
    for (let move = 1; move <= 50; move += 1) state = run(state, edit(move, { group: gesture, at: move * 5_000 }));
    expect(state.past).toHaveLength(1);
    expect(state.present).toEqual(anchorAt(50));
    state = run(state, { type: "undo" });
    expect(state.present).toEqual(start.present);
  });

  it("restores the pre-drag state without a step when the gesture is cancelled", () => {
    const start = createStudioHistory(base);
    const gesture = gestureGroup(2);
    let state = run(start, edit(1, { group: gesture, at: 0 }), edit(2, { group: gesture, at: 10 }));
    state = run(state, { type: "cancelGroup", key: gesture.key });
    expect(state.present).toEqual(start.present);
    expect(state.past).toHaveLength(0);
    expect(state.group).toBeNull();
  });

  it("ignores a cancel for a different gesture", () => {
    const state = run(createStudioHistory(base), edit(1, { group: gestureGroup(3), at: 0 }));
    expect(studioReducer(state, { type: "cancelGroup", key: "gesture:99" })).toBe(state);
  });

  it("coalesces nudges on one target, then splits after idle time or a target change", () => {
    const nudge = (x: number, key: string, at: number): StudioAction => edit(x, { group: burstGroup(key), at });
    let state = run(createStudioHistory(base), nudge(1, "nudge:a", 0), nudge(2, "nudge:a", 300), nudge(3, "nudge:a", 900));
    expect(state.past).toHaveLength(1);
    state = run(state, nudge(4, "nudge:a", 2_500));
    expect(state.past).toHaveLength(2);
    state = run(state, nudge(5, "nudge:b", 2_600));
    expect(state.past).toHaveLength(3);
  });

  it("treats one field session as one step and a different field as a new step", () => {
    const typing = (x: number, field: string, at: number): StudioAction => edit(x, { group: burstGroup(field), at });
    let state = run(createStudioHistory(base), typing(1, "field:1", 0), typing(12, "field:1", 200), typing(123, "field:1", 400));
    expect(state.past).toHaveLength(1);
    state = run(state, typing(7, "field:2", 500));
    expect(state.past).toHaveLength(2);
  });

  it("ends the group on endGroup, select, undo and redo", () => {
    const open = (): StudioHistory => run(createStudioHistory(base), edit(1, { group: gestureGroup(4), at: 0 }));
    expect(run(open(), { type: "endGroup" }, edit(2, { group: gestureGroup(4), at: 1 })).past).toHaveLength(2);
    expect(run(open(), { type: "select", appearanceId: null }, edit(2, { group: gestureGroup(4), at: 1 })).past).toHaveLength(2);
    expect(run(open(), { type: "undo" }).group).toBeNull();
    expect(run(open(), { type: "undo" }, { type: "redo" }).group).toBeNull();
  });

  it("makes every ungrouped edit its own step, and a no-op edit no step", () => {
    let state = run(createStudioHistory(base), edit(1), edit(2), edit(3));
    expect(state.past).toHaveLength(3);
    state = run(state, edit(3));
    expect(state.past).toHaveLength(3);
    state = run(state, edit(3, { group: gestureGroup(5), at: 0 }));
    expect(state.past).toHaveLength(3);
    expect(state.group).toBeNull();
  });

  it("clears redo only when a new step is created, not while merging into the open one", () => {
    const gesture = gestureGroup(6);
    let state = run(createStudioHistory(base), edit(1), { type: "undo" });
    expect(state.future).toHaveLength(1);
    state = run(state, edit(2, { group: gesture, at: 0 }));
    expect(state.future).toHaveLength(0);
  });
});

describe("Boss history grouping", () => {
  const bossBase = DEFAULT_BOSS_APPEARANCE_CATALOG;
  const bossEdit = (scale: number, group?: ReturnType<typeof gestureGroup>, at = 0) => ({
    type: "edit" as const,
    catalog: { ...bossBase, catalogRevision: bossBase.catalogRevision + scale },
    ...(group ? { group, at } : {})
  });

  it("is one step per gesture and restores on cancel", () => {
    const gesture = gestureGroup(7);
    let state = createBossStudioHistory(bossBase);
    for (let move = 1; move <= 20; move += 1) state = bossStudioReducer(state, bossEdit(move, gesture, move * 3_000));
    expect(state.past).toHaveLength(1);
    const cancelled = bossStudioReducer(state, { type: "cancelGroup", key: gesture.key });
    expect(cancelled.present).toEqual(bossBase);
    expect(cancelled.past).toHaveLength(0);
  });

  it("makes no-op edits no step and discrete edits separate steps", () => {
    let state = createBossStudioHistory(bossBase);
    state = bossStudioReducer(state, { type: "edit", catalog: bossBase });
    expect(state.past).toHaveLength(0);
    state = bossStudioReducer(bossStudioReducer(state, bossEdit(1)), bossEdit(2));
    expect(state.past).toHaveLength(2);
  });
});
