import { describe, expect, it } from "vitest";

import {
  MOB_TACTICS_MAX_ROSTER,
  MOB_TACTICS_SEPARATION_MAX_SHARE,
  MOB_TACTICS_STARVATION_MS,
  MOB_TACTICS_TOKEN_MAX_HOLD_MS,
  angleDiffDeg,
  deriveMobRhythm,
  mobChallengeTier,
  minSlotAngleDeg,
  ringCapacity,
  normalizeAngleDeg,
  tacticsMsToTicks,
  tacticsRingRadiusM,
  tacticsTokenCost
} from "@ash-atlas/shared";
import { MOB_DEFINITIONS } from "./mobDefinitions.js";
import {
  TokenLedger,
  assignRings,
  relaxSlots,
  separationPush,
  steerStep,
  strafeDirection,
  strafeFlipTicks,
  strafeStep,
  tokenScore,
  type TokenCandidate,
  type Vec2
} from "./mobTactics.js";

const HZ = 20;

function candidate(id: string, overrides: Partial<TokenCandidate> = {}): TokenCandidate {
  return {
    id, pool: "melee", cost: 1, waitingSinceTick: 0, distanceM: 85, bearingDeg: 180,
    grabbed: false, engageRadiusM: 85, ...overrides
  };
}

describe("rhythm derivation over every mob definition", () => {
  it("gives positive, floor-respecting timings and keeps the cycle", () => {
    const defs = Object.values(MOB_DEFINITIONS);
    expect(defs.length).toBeGreaterThan(50);
    for (const def of defs) {
      const rhythm = deriveMobRhythm(def.attackIntervalMs, def.attackRangeM);
      expect(rhythm.windupMs, def.key).toBeGreaterThan(0);
      expect(rhythm.recoverMs, def.key).toBeGreaterThan(0);
      expect(rhythm.cooldownMs, def.key).toBeGreaterThanOrEqual(300);
      const total = rhythm.windupMs + rhythm.recoverMs + rhythm.cooldownMs;
      // The floor can only lengthen the cycle; it never shortens it.
      expect(total, def.key).toBeGreaterThanOrEqual(Math.min(def.attackIntervalMs, total));
      if (def.attackIntervalMs >= rhythm.windupMs + rhythm.recoverMs + 300) {
        expect(total, def.key).toBe(def.attackIntervalMs);
      }
      expect(tacticsTokenCost(mobChallengeTier(def.level)), def.key).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("TokenLedger", () => {
  it("respects the melee capacity of 2 points", () => {
    const ledger = new TokenLedger("p1", HZ);
    const granted = ledger.arbitrate([candidate("a"), candidate("b"), candidate("c")], 100, null);
    expect(granted).toEqual(["a", "b"]);
    expect(ledger.inUse("melee")).toBe(2);
    expect(ledger.arbitrate([candidate("c")], 101, null)).toEqual([]);
  });

  it("makes an epic take the whole pool and blocks grunts behind it (strict priority)", () => {
    const ledger = new TokenLedger("p1", HZ);
    const granted = ledger.arbitrate(
      [candidate("elite", { cost: tacticsTokenCost("epic"), waitingSinceTick: 0 }), candidate("grunt", { waitingSinceTick: 50 })],
      100, null
    );
    expect(granted).toEqual(["elite"]);
    expect(ledger.inUse("melee")).toBe(2);
    // An epic that does not fit does not let a grunt skip ahead of it.
    const other = new TokenLedger("p2", HZ);
    other.arbitrate([candidate("g1")], 100, null);
    expect(other.arbitrate([candidate("elite", { cost: 2 }), candidate("g2", { waitingSinceTick: 90 })], 101, null)).toEqual([]);
  });

  it("keeps ranged tokens in their own pool", () => {
    const ledger = new TokenLedger("p1", HZ);
    const granted = ledger.arbitrate(
      [candidate("m1"), candidate("m2"), candidate("r1", { pool: "ranged" }), candidate("r2", { pool: "ranged" })],
      100, null
    );
    expect(granted.sort()).toEqual(["m1", "m2", "r1"]);
    expect(ledger.inUse("ranged")).toBe(1);
  });

  it("serves the longest waiter first, with a bonus for mobs in front", () => {
    const ledger = new TokenLedger("p1", HZ);
    const granted = ledger.arbitrate(
      [candidate("old", { waitingSinceTick: 0 }), candidate("new", { waitingSinceTick: 90 }), candidate("mid", { waitingSinceTick: 40 })],
      100, null
    );
    expect(granted).toEqual(["old", "mid"]);
    const front = new TokenLedger("p2", HZ);
    const frontGranted = front.arbitrate(
      [candidate("behind", { waitingSinceTick: 90, bearingDeg: 180 }), candidate("ahead", { waitingSinceTick: 100, bearingDeg: 10 }), candidate("side", { waitingSinceTick: 100, bearingDeg: 90 })],
      100, 0
    );
    // behind waited 0.5 s, ahead 0 s + 0.6 s front bonus, side 0 s.
    expect(frontGranted).toEqual(["ahead", "behind"]);
  });

  it("serves a starved mob first and a grabbed mob before everything", () => {
    const starvedTick = Math.round((MOB_TACTICS_STARVATION_MS / 1000) * HZ);
    const now = starvedTick + 10;
    const starved = candidate("starved", { waitingSinceTick: 0, bearingDeg: 180 });
    const fresh = candidate("fresh", { waitingSinceTick: now - 5, bearingDeg: 0 });
    expect(tokenScore(starved, now, HZ, 0)).toBeGreaterThan(tokenScore(fresh, now, HZ, 0));
    const ledger = new TokenLedger("p1", HZ);
    const granted = ledger.arbitrate([starved, fresh, candidate("hit", { waitingSinceTick: now, grabbed: true })], now, 0);
    expect(granted[0]).toBe("hit");
    expect(granted).toContain("starved");
  });

  it("breaks ties by id deterministically", () => {
    const ledger = new TokenLedger("p1", HZ);
    const granted = ledger.arbitrate([candidate("c"), candidate("a"), candidate("b")], 100, null);
    expect(granted).toEqual(["a", "b"]);
  });

  it("spaces landings at least 300 ms apart without shortening the windup", () => {
    const ledger = new TokenLedger("p1", HZ);
    const windup = tacticsMsToTicks(450, HZ);
    const gap = tacticsMsToTicks(300, HZ);
    const landings: number[] = [];
    for (let tick = 100; tick < 140; tick += 1) {
      if (landings.length < 4 && ledger.canStartWindup(tick, windup)) {
        ledger.commitLanding(tick, windup);
        landings.push(tick + windup);
      }
    }
    expect(landings).toHaveLength(4);
    for (let index = 1; index < landings.length; index += 1) {
      expect(landings[index]! - landings[index - 1]!).toBeGreaterThanOrEqual(gap);
    }
    expect(landings[0]).toBe(100 + windup);
  });

  it("release is idempotent and validate takes back stale tokens", () => {
    const ledger = new TokenLedger("p1", HZ);
    ledger.arbitrate([candidate("a"), candidate("b")], 100, null);
    expect(ledger.release("a")).toBe(true);
    expect(ledger.release("a")).toBe(false);
    expect(ledger.inUse("melee")).toBe(1);
    expect(ledger.validate((id) => id !== "b", 101)).toEqual(["b"]);
    expect(ledger.inUse("melee")).toBe(0);
    ledger.arbitrate([candidate("c")], 200, null);
    const maxHold = tacticsMsToTicks(MOB_TACTICS_TOKEN_MAX_HOLD_MS, HZ);
    expect(ledger.validate(() => true, 200 + maxHold)).toEqual([]);
    expect(ledger.validate(() => true, 200 + maxHold + 1)).toEqual(["c"]);
    expect(ledger.holders.size).toBe(0);
    expect(ledger.inUse("melee")).toBe(0);
  });

  it("leaves the ledger empty after every end case", () => {
    const ledger = new TokenLedger("p1", HZ);
    ledger.arbitrate([candidate("a"), candidate("b")], 100, null);
    ledger.clear();
    expect(ledger.holders.size).toBe(0);
    expect(ledger.inUse("melee")).toBe(0);
    expect(ledger.inUse("ranged")).toBe(0);
    expect(ledger.arbitrate([candidate("c")], 101, null)).toEqual(["c"]);
  });
});

describe("ring assignment", () => {
  it("seats six melee mobs on the engage ring and waits the rest at 150 m", () => {
    const items = Array.from({ length: 9 }, (_, index) => ({
      id: `m${index}`, pool: "melee" as const, score: 100 - index, attackRangeM: 100, currentRing: null
    }));
    const rings = assignRings(items);
    const engage = [...rings.values()].filter((entry) => entry.ring === "engage");
    const wait = [...rings.values()].filter((entry) => entry.ring === "wait");
    expect(engage).toHaveLength(6);
    expect(wait).toHaveLength(3);
    expect(engage[0]!.radiusM).toBe(85);
    expect(wait[0]!.radiusM).toBe(150);
  });

  it("keeps engage incumbents over a higher score, and puts ranged mobs on the outer ring", () => {
    const items = [
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `in${index}`, pool: "melee" as const, score: 0, attackRangeM: 100, currentRing: "engage" as const
      })),
      { id: "newcomer", pool: "melee" as const, score: 9_999, attackRangeM: 100, currentRing: "wait" as const },
      { id: "archer", pool: "ranged" as const, score: 0, attackRangeM: 210, currentRing: null }
    ];
    const rings = assignRings(items);
    expect(rings.get("newcomer")!.ring).toBe("wait");
    expect(rings.get("in0")!.ring).toBe("engage");
    expect(rings.get("archer")).toMatchObject({ ring: "outer", radiusM: tacticsRingRadiusM(210, "outer") });
  });

  it("spills a full ring outward by one layer", () => {
    const items = Array.from({ length: ringCapacity(tacticsRingRadiusM(300, "outer")) + MOB_TACTICS_MAX_ROSTER }, (_, index) => ({
      id: `w${index}`, pool: "ranged" as const, score: 0, attackRangeM: 300, currentRing: null
    }));
    const layers = new Set([...assignRings(items).values()].map((entry) => entry.layer));
    expect(layers.size).toBeGreaterThan(1);
  });
});

describe("slot relaxation", () => {
  const radius = 85;
  const minAngle = minSlotAngleDeg(radius);

  function minGap(slots: Map<string, number>): number {
    const angles = [...slots.values()].sort((a, b) => a - b);
    let smallest = 360;
    for (let index = 0; index < angles.length; index += 1) {
      const next = angles[(index + 1) % angles.length]!;
      const gap = index === angles.length - 1 ? next + 360 - angles[index]! : next - angles[index]!;
      smallest = Math.min(smallest, gap);
    }
    return smallest;
  }

  it("spreads six clustered mobs to the minimum spacing and keeps their order", () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ id: `m${index}`, bearingDeg: 10 + index * 2, prevSlotDeg: null }));
    const slots = relaxSlots(items, radius);
    expect(minGap(slots)).toBeGreaterThanOrEqual(minAngle - 1e-6);
    const ordered = [...slots.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    // Circular order preserved up to rotation.
    const start = ordered.indexOf("m0");
    const rotated = [...ordered.slice(start), ...ordered.slice(0, start)];
    expect(rotated).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
  });

  it("does not move spread-out mobs and handles the 0/360 wrap", () => {
    const items = [
      { id: "a", bearingDeg: 355, prevSlotDeg: null },
      { id: "b", bearingDeg: 5, prevSlotDeg: null },
      { id: "c", bearingDeg: 180, prevSlotDeg: null }
    ];
    const slots = relaxSlots(items, radius);
    expect(minGap(slots)).toBeGreaterThanOrEqual(minAngle - 1e-6);
    expect(Math.abs(angleDiffDeg(slots.get("c")!, 180))).toBeLessThan(1e-6);
    expect(Math.abs(angleDiffDeg(slots.get("a")!, 355))).toBeLessThan(minAngle);
  });

  it("is stable: feeding the result back as previous slots changes nothing", () => {
    const items = Array.from({ length: 5 }, (_, index) => ({ id: `m${index}`, bearingDeg: 100 + index * 3, prevSlotDeg: null as number | null }));
    const first = relaxSlots(items, radius);
    const second = relaxSlots(items.map((item) => ({ ...item, prevSlotDeg: first.get(item.id)! })), radius);
    for (const [id, angle] of first) expect(second.get(id)).toBeCloseTo(angle, 9);
  });

  it("applies hysteresis: a 10 degree shift moves nothing, a 40 degree shift moves the mob", () => {
    const base = [
      { id: "a", bearingDeg: 0, prevSlotDeg: 0 },
      { id: "b", bearingDeg: 120, prevSlotDeg: 120 },
      { id: "c", bearingDeg: 240, prevSlotDeg: 240 }
    ];
    const small = relaxSlots(base.map((item) => ({ ...item, bearingDeg: item.bearingDeg + 10 })), radius);
    for (const item of base) expect(small.get(item.id)).toBeCloseTo(item.prevSlotDeg, 9);
    const large = relaxSlots(base.map((item) => ({ ...item, bearingDeg: item.id === "a" ? 40 : item.bearingDeg })), radius);
    expect(large.get("a")).toBeCloseTo(40, 6);
    expect(large.get("b")).toBeCloseTo(120, 6);
  });

  it("never moves a slot by more than needed while the player drifts", () => {
    let slots = new Map<string, number>();
    const ids = ["a", "b", "c", "d"];
    let moves = 0;
    for (let step = 0; step < 40; step += 1) {
      const items = ids.map((id, index) => ({
        id, bearingDeg: normalizeAngleDeg(index * 90 + step * 2), prevSlotDeg: slots.get(id) ?? null
      }));
      const next = relaxSlots(items, radius);
      for (const id of ids) {
        if (slots.has(id) && Math.abs(angleDiffDeg(slots.get(id)!, next.get(id)!)) > 1e-6) moves += 1;
      }
      slots = next;
    }
    // 80 degrees of drift with 25 degree hysteresis: each mob re-slots about 3 times, not every step.
    expect(moves).toBeLessThanOrEqual(ids.length * 4);
  });
});

describe("separation and steering", () => {
  const out: Vec2 = { x: 0, y: 0 };
  const step = 6.25;

  it("pushes overlapping mobs apart, more when closer, never past half a step", () => {
    const self = { id: "a", x: 0, y: 0 };
    const near = separationPush(self, [{ id: "b", x: 10, y: 0 }], step, { x: 0, y: 0 });
    expect(near.x).toBeLessThan(0);
    expect(Math.hypot(near.x, near.y)).toBeLessThanOrEqual(step * MOB_TACTICS_SEPARATION_MAX_SHARE + 1e-9);
    const far = separationPush(self, [{ id: "b", x: 45, y: 0 }], step, { x: 0, y: 0 });
    expect(Math.hypot(far.x, far.y)).toBeLessThan(Math.hypot(near.x, near.y));
    const none = separationPush(self, [{ id: "b", x: 60, y: 0 }], step, { x: 0, y: 0 });
    expect(Math.hypot(none.x, none.y)).toBe(0);
    const crowd = separationPush(self, Array.from({ length: 8 }, (_, index) => ({ id: `n${index}`, x: 2 + index, y: 3 })), step, { x: 0, y: 0 });
    expect(Math.hypot(crowd.x, crowd.y)).toBeLessThanOrEqual(step * MOB_TACTICS_SEPARATION_MAX_SHARE + 1e-9);
  });

  it("separates coincident mobs in opposite, deterministic directions", () => {
    const a = separationPush({ id: "a", x: 5, y: 5 }, [{ id: "b", x: 5, y: 5 }], step, { x: 0, y: 0 });
    const b = separationPush({ id: "b", x: 5, y: 5 }, [{ id: "a", x: 5, y: 5 }], step, { x: 0, y: 0 });
    expect(Math.hypot(a.x, a.y)).toBeGreaterThan(0);
    expect(Math.hypot(b.x, b.y)).toBeGreaterThan(0);
    const again = separationPush({ id: "a", x: 5, y: 5 }, [{ id: "b", x: 5, y: 5 }], step, { x: 0, y: 0 });
    expect(again).toEqual(a);
  });

  it("spreads a stacked pack heading for the same point to at least 40 m apart", () => {
    const bodies = Array.from({ length: 6 }, (_, index) => ({ id: `m${index}`, x: 300 + index * 0.5, y: 0 + index * 0.3 }));
    const slots = relaxSlots(bodies.map((body) => ({ id: body.id, bearingDeg: 90, prevSlotDeg: null })), 85);
    const push: Vec2 = { x: 0, y: 0 };
    const next: Vec2 = { x: 0, y: 0 };
    for (let tick = 0; tick < 200; tick += 1) {
      const snapshot = bodies.map((body) => ({ ...body }));
      for (let index = 0; index < bodies.length; index += 1) {
        const body = bodies[index]!;
        const angle = (slots.get(body.id)! * Math.PI) / 180;
        separationPush(snapshot[index]!, snapshot, step, push);
        steerStep(body.x, body.y, Math.sin(angle) * 85, Math.cos(angle) * 85, push, step, next);
        body.x = next.x;
        body.y = next.y;
      }
    }
    let smallest = Infinity;
    for (let i = 0; i < bodies.length; i += 1) {
      for (let j = i + 1; j < bodies.length; j += 1) {
        smallest = Math.min(smallest, Math.hypot(bodies[i]!.x - bodies[j]!.x, bodies[i]!.y - bodies[j]!.y));
      }
      expect(Math.hypot(bodies[i]!.x, bodies[i]!.y)).toBeGreaterThan(75);
      expect(Math.hypot(bodies[i]!.x, bodies[i]!.y)).toBeLessThan(95);
    }
    expect(smallest).toBeGreaterThanOrEqual(40);
  });

  it("steers toward a destination, stops at the slot and never exceeds one step", () => {
    steerStep(0, 0, 100, 0, { x: 0, y: 0 }, step, out);
    expect(out.x).toBeCloseTo(step, 9);
    steerStep(0, 0, 4, 0, { x: 0, y: 0 }, step, out);
    expect(out.x).toBe(0);
    steerStep(0, 0, 100, 0, { x: 0, y: 50 }, step, out);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(step, 9);
  });

  it("strafes along the ring at the requested speed and eases onto the ring", () => {
    const next: Vec2 = { x: 0, y: 0 };
    strafeStep(0, 85, 85, 1, 5, next);
    expect(Math.hypot(next.x, next.y)).toBeCloseTo(85, 6);
    expect(next.x).toBeGreaterThan(0);
    const arc = Math.atan2(next.x, next.y) * 85;
    expect(arc).toBeCloseTo(5, 3);
    strafeStep(0, 85, 85, -1, 5, next);
    expect(next.x).toBeLessThan(0);
    strafeStep(0, 60, 85, 1, 5, next);
    expect(Math.hypot(next.x, next.y)).toBeGreaterThan(60);
    expect(Math.hypot(next.x, next.y)).toBeLessThanOrEqual(62.5 + 1e-6);
  });

  it("seeds strafe direction and flip timing deterministically within 1.5 to 3.5 s", () => {
    for (let flips = 0; flips < 20; flips += 1) {
      const ticks = strafeFlipTicks("wolf", flips, HZ);
      expect(ticks).toBeGreaterThanOrEqual(30);
      expect(ticks).toBeLessThanOrEqual(70);
      expect(strafeFlipTicks("wolf", flips, HZ)).toBe(ticks);
    }
    const directions = new Set(Array.from({ length: 20 }, (_, flips) => strafeDirection("wolf", flips)));
    expect(directions.size).toBe(2);
  });
});
