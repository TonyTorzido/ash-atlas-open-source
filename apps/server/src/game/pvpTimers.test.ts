import { PVP_AGGRESSOR_MARK_MS, PVP_DEFEAT_SAFETY_MS, PVP_STRIKE_BLOCK_MS, pvpAttackVerdict } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { PvpTimerService } from "./pvpTimers.js";

const AGGRO_MS = 10_000;

function service() {
  let now = 1_000_000;
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
  const onChange = vi.fn();
  const timers = new PvpTimerService({ query } as never, { now: () => now, onChange });
  return {
    timers,
    query,
    onChange,
    now: () => now,
    advance: (ms: number) => { now += ms; },
    /** A landed hit with the normal 10 s aggression timer. */
    hit: (attacker: string, target: string) => timers.recordHit(attacker, target, now + AGGRO_MS)
  };
}

describe("PvP strike-block rule", () => {
  it("lets a first strike land once, then refuses the aggressor for 20 hours", () => {
    const { timers, hit, onChange, advance } = service();
    expect(timers.strikeBlockMs("ada", "bo")).toBeNull();
    hit("ada", "bo");
    // Denied: Ada used her one swing and Bo has not fought back.
    expect(timers.strikeBlockMs("ada", "bo")).toBe(PVP_STRIKE_BLOCK_MS);
    // Allowed: Bo may attack Ada, his marked aggressor.
    expect(timers.strikeBlockMs("bo", "ada")).toBeNull();
    expect(timers.timersFor("bo")).toEqual([
      expect.objectContaining({ kind: "aggressor", playerId: "ada", expiresAt: 1_000_000 + PVP_AGGRESSOR_MARK_MS })
    ]);
    expect(timers.timersFor("ada")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "marked", playerId: "bo" }),
      expect.objectContaining({ kind: "cannot_attack", playerId: "bo" })
    ]));
    expect(onChange).toHaveBeenLastCalledWith(["ada", "bo"], new Map([
      ["ada", { kind: "struck", otherPlayerId: "bo" }],
      ["bo", { kind: "struck_by", otherPlayerId: "ada" }]
    ]));
    advance(PVP_STRIKE_BLOCK_MS - 60_000);
    expect(timers.strikeBlockMs("ada", "bo")).toBe(60_000);
    advance(60_000);
    expect(timers.strikeBlockMs("ada", "bo")).toBeNull();
  });

  it("lets two different aggressors each land one hit", () => {
    const { timers, hit } = service();
    hit("ada", "bo");
    expect(timers.strikeBlockMs("cy", "bo")).toBeNull();
    hit("cy", "bo");
    expect(timers.strikeBlockMs("ada", "bo")).not.toBeNull();
    expect(timers.strikeBlockMs("cy", "bo")).not.toBeNull();
    // Bo holds a separate mark on each of them.
    expect(timers.timersFor("bo").filter((entry) => entry.kind === "aggressor").map((entry) => entry.playerId).sort())
      .toEqual(["ada", "cy"]);
    expect(timers.strikeBlockMs("bo", "ada")).toBeNull();
    expect(timers.strikeBlockMs("bo", "cy")).toBeNull();
  });

  it("starts a fight when the victim strikes back; both trade hits while aggression is up", () => {
    const { timers, hit, advance } = service();
    hit("ada", "bo");
    advance(60_000);
    hit("bo", "ada");
    expect(timers.isFighting("ada", "bo")).toBe(true);
    // Ada may now fight back freely, with no one-swing limit.
    expect(timers.strikeBlockMs("ada", "bo")).toBeNull();
    for (let round = 0; round < 5; round += 1) {
      advance(1_600);
      hit("ada", "bo");
      expect(timers.strikeBlockMs("ada", "bo")).toBeNull();
      advance(1_600);
      hit("bo", "ada");
    }
    expect(timers.timersFor("ada")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "fighting", playerId: "bo" })
    ]));
    // Retaliation never marks the victim, so Ada gains no pass on Bo.
    expect(timers.timersFor("ada").some((entry) => entry.kind === "aggressor")).toBe(false);
  });

  it("puts the block back once the aggressor breaks away and aggression drops; the victim can re-engage", () => {
    const { timers, hit, advance, onChange } = service();
    hit("ada", "bo");
    advance(60_000);
    hit("bo", "ada");
    advance(1_600);
    hit("ada", "bo");
    // Ada runs out of range: no more hits either way.
    advance(AGGRO_MS + 1);
    expect(timers.isFighting("ada", "bo")).toBe(false);
    expect(timers.strikeBlockMs("ada", "bo")).not.toBeNull();
    onChange.mockClear();
    timers.sweep();
    expect(onChange).toHaveBeenCalledWith(expect.arrayContaining(["ada", "bo"]), new Map());
    // Still within 20 hours: Bo may strike again, which starts a new fight.
    advance(5 * 60 * 60_000);
    expect(timers.strikeBlockMs("bo", "ada")).toBeNull();
    hit("bo", "ada");
    expect(timers.isFighting("ada", "bo")).toBe(true);
    expect(timers.strikeBlockMs("ada", "bo")).toBeNull();
  });

  it("starts a fight, not a one-swing block, when the target is Aggressive; no block is left afterwards", () => {
    const { timers, advance, onChange, now } = service();
    timers.recordHit("ada", "bo", now() + AGGRO_MS, true);
    expect(timers.isFighting("ada", "bo")).toBe(true);
    expect(timers.strikeBlockMs("ada", "bo")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(["ada", "bo"], new Map([
      ["ada", { kind: "engaged", otherPlayerId: "bo" }],
      ["bo", { kind: "struck_by", otherPlayerId: "ada" }]
    ]));
    // Ada is marked; Bo's hits back never mark Bo.
    advance(1_600);
    timers.recordHit("bo", "ada", now() + AGGRO_MS, true);
    expect(timers.timersFor("bo").map((entry) => entry.kind).sort()).toEqual(["aggressor", "fighting"]);
    expect(timers.timersFor("ada").map((entry) => entry.kind).sort()).toEqual(["fighting", "marked"]);
    advance(AGGRO_MS + 1);
    expect(timers.isFighting("ada", "bo")).toBe(false);
    expect(timers.strikeBlockMs("ada", "bo")).toBeNull();
    // Bo is calm now: Ada's next strike is a one swing.
    timers.recordHit("ada", "bo", now() + AGGRO_MS, false);
    expect(timers.strikeBlockMs("ada", "bo")).not.toBeNull();
  });

  it("starts a 20h post-kill safety only for a death at a player's hands, and persists it", async () => {
    const { timers, query, advance } = service();
    timers.recordDeath("bo");
    expect(timers.defeatSafetyMs("bo")).toBeNull();
    timers.recordDeath("bo", "ada");
    expect(timers.defeatSafetyMs("bo")).toBe(PVP_DEFEAT_SAFETY_MS);
    expect(timers.defeatSafetyMs("ada")).toBeNull();
    await timers.flush();
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO player_pvp_defeat_safety")))
      .toHaveLength(1);
    advance(PVP_DEFEAT_SAFETY_MS);
    expect(timers.defeatSafetyMs("bo")).toBeNull();
  });

  it("keeps the victim's marks through a death (they are the revenge) and ends that player's fights", () => {
    const { timers, hit, advance } = service();
    hit("ada", "bo");
    hit("bo", "ada");
    expect(timers.isFighting("ada", "bo")).toBe(true);
    timers.recordDeath("bo");
    expect(timers.isFighting("ada", "bo")).toBe(false);
    expect(timers.strikeBlockMs("ada", "bo")).not.toBeNull();
    advance(60 * 60_000);
    expect(timers.strikeBlockMs("bo", "ada")).toBeNull();
  });

  it("persists marks and blocks, but refreshes a mark in the database at most once a minute", async () => {
    const { timers, hit, query, advance } = service();
    hit("ada", "bo");
    await timers.flush();
    const writes = () => query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO player_pvp_timers"));
    expect(writes().map(([, values]) => values?.[2])).toEqual(["aggressor", "strike_block"]);
    hit("bo", "ada");
    for (let round = 0; round < 10; round += 1) { advance(1_600); hit("ada", "bo"); }
    await timers.flush();
    expect(writes()).toHaveLength(2);
    // A fight running past a minute writes Ada's refreshed mark once.
    for (let round = 0; round < 15; round += 1) { advance(1_600); hit("bo", "ada"); advance(1_600); hit("ada", "bo"); }
    await timers.flush();
    expect(writes().map(([, values]) => values?.[2])).toEqual(["aggressor", "strike_block", "aggressor"]);
  });

  it("gives the player menu a verdict with a reason (the server decides blocks, since Aggression lifts them)", () => {
    const { timers, hit, now } = service();
    hit("ada", "bo");
    const named = (playerId: string) => timers.timersFor(playerId).map((entry) => ({ ...entry, displayName: entry.playerId === "bo" ? "Bo" : "Ada" }));
    expect(pvpAttackVerdict(named("ada"), "bo", now())).toEqual({
      allowed: true,
      oneSwing: false,
      reason: "You already struck Bo; you can't attack them again for 20h unless they fight back or turn aggressive"
    });
    expect(pvpAttackVerdict(named("bo"), "ada", now())).toMatchObject({ allowed: true, oneSwing: false });
    expect(pvpAttackVerdict(named("ada"), "cy", now())).toMatchObject({ allowed: true, oneSwing: true });
    hit("bo", "ada");
    expect(pvpAttackVerdict(named("ada"), "bo", now())).toMatchObject({ allowed: true, oneSwing: false, reason: "Fighting Bo" });
  });
});
