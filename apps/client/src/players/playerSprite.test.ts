import { describe, expect, it, vi } from "vitest";

import { createPlayerSprite } from "./playerSprite.js";

describe("player sprite scale", () => {
  it.each([true, false])(
    "renders %s player width and height at half the previous presentation",
    (local) => {
      const previous = createPlayerSprite(0, 0, 56, {
        local,
        color: 0x38bdf8,
        groundAtPosition: true
      }).getLocalBounds();
      const current = createPlayerSprite(0, 0, 28, {
        local,
        color: 0x38bdf8,
        groundAtPosition: true
      }).getLocalBounds();

      expect(current.width).toBeCloseTo(previous.width / 2);
      expect(current.height).toBeCloseTo(previous.height / 2);
    }
  );

  it("uses the same scale ratio for local and remote players", () => {
    const previousLocal = createPlayerSprite(0, 0, 56, {
      local: true,
      color: 0x38bdf8,
      groundAtPosition: true
    }).getLocalBounds();
    const local = createPlayerSprite(0, 0, 28, {
      local: true,
      color: 0x38bdf8,
      groundAtPosition: true
    }).getLocalBounds();
    const previousRemote = createPlayerSprite(0, 0, 56, {
      local: false,
      color: 0x38bdf8,
      groundAtPosition: true
    }).getLocalBounds();
    const remote = createPlayerSprite(0, 0, 28, {
      local: false,
      color: 0x38bdf8,
      groundAtPosition: true
    }).getLocalBounds();

    expect(local.width / previousLocal.width).toBeCloseTo(0.5);
    expect(local.height / previousLocal.height).toBeCloseTo(0.5);
    expect(remote.width / previousRemote.width).toBeCloseTo(0.5);
    expect(remote.height / previousRemote.height).toBeCloseTo(0.5);
  });
});

describe("afloat raft", () => {
  it("draws the raft only while afloat, sized from the body, and nothing when the art fails", async () => {
    const { PlayerRaft, PLAYER_RAFT_PRESENTATION, resetPlayerRaftTextureForTests } = await import("./playerSprite.js");
    const { Texture } = await import("pixi.js");
    resetPlayerRaftTextureForTests();
    const texture = Texture.WHITE;
    const load = vi.fn(async () => texture);
    const raft = new PlayerRaft(load, "raft.png");
    raft.update({ afloat: false, bodyHeightPx: 40, nowMs: 0, reducedMotion: true });
    expect(raft.root.visible).toBe(false);
    expect(load).not.toHaveBeenCalled();
    raft.update({ afloat: true, bodyHeightPx: 40, nowMs: 0, reducedMotion: true });
    await Promise.resolve();
    raft.update({ afloat: true, bodyHeightPx: 40, nowMs: 0, reducedMotion: true });
    expect(load).toHaveBeenCalledTimes(1);
    expect(raft.root.visible).toBe(true);
    const sprite = raft.root.children[0]!;
    expect(sprite.width).toBeCloseTo(
      40 * PLAYER_RAFT_PRESENTATION.bodyWidthToHeight * PLAYER_RAFT_PRESENTATION.widthToBodyWidth
    );
    raft.update({ afloat: false, bodyHeightPx: 40, nowMs: 0, reducedMotion: true });
    expect(raft.root.visible).toBe(false);

    resetPlayerRaftTextureForTests();
    const failing = new PlayerRaft(vi.fn(async () => { throw new Error("missing"); }), "raft.png");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    failing.update({ afloat: true, bodyHeightPx: 40, nowMs: 0, reducedMotion: true });
    await Promise.resolve();
    await Promise.resolve();
    failing.update({ afloat: true, bodyHeightPx: 40, nowMs: 0, reducedMotion: true });
    expect(failing.root.visible).toBe(false);
    expect(failing.root.children).toHaveLength(0);
    warn.mockRestore();
    resetPlayerRaftTextureForTests();
  });
});
