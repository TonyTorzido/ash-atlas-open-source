import { describe, expect, it } from "vitest";

import {
  MOB_ARCH_SIGNATURE_MIN_SPACING_MS,
  MOB_ARCH_GOVERNOR_BUDGET_HE,
  MOB_ARCH_KNOCKBACK_CAP_M,
  MOB_SIGNATURES,
  tacticsMsToTicks
} from "@ash-atlas/shared";
import {
  archetypeTokenCost,
  inLungeRearArc,
  parseArchetypesOnly,
  resolveArchetypeTactics,
  signatureConeContains,
  signatureKnockbackM,
  signatureLaneLengthM,
  signaturePartTicks,
  volleyFacings
} from "./mobArchetypeSignatures.js";
import { TokenLedger, type TokenCandidate } from "./mobTactics.js";

/** Mob AI Phase 2 chunk B: ledger (fractional costs, landing windows, signature slot, governor) and pure helpers. */

const HZ = 20;
const BASIC_GAP = tacticsMsToTicks(300, HZ);
const SIGNATURE_GAP = tacticsMsToTicks(500, HZ);
const SIGNATURE_SPACING = tacticsMsToTicks(MOB_ARCH_SIGNATURE_MIN_SPACING_MS, HZ);

function candidate(id: string, overrides: Partial<TokenCandidate> = {}): TokenCandidate {
  return {
    id, pool: "melee", cost: 1, waitingSinceTick: 100, distanceM: 100, bearingDeg: 0, grabbed: false, engageRadiusM: 85,
    ...overrides
  };
}

/** The Phase 1 single landing cursor, verbatim, as the reference for the equivalence proof. */
class Phase1Cursor {
  nextLandingTick = 0;
  canStartWindup(now: number, windup: number): boolean {
    return now + windup >= this.nextLandingTick;
  }
  commitLanding(now: number, windup: number): void {
    this.nextLandingTick = Math.max(this.nextLandingTick, now + windup) + BASIC_GAP;
  }
}

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("token ledger: Phase 2 landing windows", () => {
  it("matches the Phase 1 cursor exactly for basic-only fights (one windup length)", () => {
    const windup = tacticsMsToTicks(450, HZ);
    for (let seed = 1; seed <= 25; seed += 1) {
      const random = prng(seed);
      const ledger = new TokenLedger("p1", HZ);
      const cursor = new Phase1Cursor();
      for (let tick = 100; tick < 1_100; tick += 1) {
        // Up to three mobs ask each tick, at random.
        for (let ask = 0; ask < 3; ask += 1) {
          if (random() > 0.35) continue;
          const allowed = ledger.canStartWindup(tick, windup);
          expect(allowed).toBe(cursor.canStartWindup(tick, windup));
          if (allowed) {
            ledger.commitLanding(tick, windup);
            cursor.commitLanding(tick, windup);
          }
        }
      }
    }
  });

  it("lets a shorter windup land in a free window before a longer one (the start is delayed, never the telegraph)", () => {
    const ledger = new TokenLedger("p1", HZ);
    ledger.commitLanding(100, 12); // brute basic lands at 112
    expect(ledger.canStartWindup(100, 8)).toBe(false); // 108: 4 ticks from 112
    expect(ledger.canStartWindup(100, 6)).toBe(true); // 106: exactly the 300 ms gap
    ledger.commitLanding(100, 6);
    expect(ledger.canStartWindup(101, 8)).toBe(false); // 109 sits between 106 and 112
  });

  it("lets swarm wave members share one landing tick, and only members of the same wave", () => {
    const ledger = new TokenLedger("p1", HZ);
    const windup = tacticsMsToTicks(300, HZ);
    ledger.commitLanding(100, windup, "s1", "p1:100");
    expect(ledger.canStartWindup(100, windup, "p1:100")).toBe(true);
    ledger.commitLanding(100, windup, "s2", "p1:100");
    expect(ledger.canStartWindup(100, windup, "p1:other")).toBe(false);
    expect(ledger.canStartWindup(100, windup)).toBe(false);
    expect(ledger.canStartWindup(101, windup, "p1:100")).toBe(false); // same wave, different tick: basic gap applies
  });
});

describe("token ledger: fractional costs and upgrades", () => {
  it("fits four half-point swarmers in the melee pool and no fifth", () => {
    const ledger = new TokenLedger("p1", HZ);
    const ids = ["a", "b", "c", "d", "e"];
    const granted = ledger.arbitrate(ids.map((id) => candidate(id, { cost: 0.5 })), 100, null);
    expect(granted).toEqual(["a", "b", "c", "d"]);
    expect(ledger.inUse("melee")).toBe(2);
    expect(ledger.release("a")).toBe(true);
    expect(ledger.release("a")).toBe(false);
    expect(ledger.inUse("melee")).toBe(1.5);
  });

  it("mixes half and whole points without breaking the 2-point ceiling", () => {
    const ledger = new TokenLedger("p1", HZ);
    const granted = ledger.arbitrate([candidate("a", { cost: 0.5 }), candidate("b", { cost: 1 }), candidate("c", { cost: 1 })], 100, null);
    expect(granted).toEqual(["a", "b"]);
    expect(ledger.inUse("melee")).toBe(1.5);
    expect(ledger.arbitrate([candidate("d", { cost: 0.5 })], 101, null)).toEqual(["d"]);
    expect(ledger.inUse("melee")).toBe(2);
  });

  it("upgrades a holder to the signature cost only when the pool covers the difference", () => {
    const ledger = new TokenLedger("p1", HZ);
    ledger.arbitrate([candidate("brute")], 100, null);
    expect(ledger.upgrade("brute", 2)).toBe(true);
    expect(ledger.costOf("brute")).toBe(2);
    expect(ledger.inUse("melee")).toBe(2);
    ledger.release("brute");
    ledger.arbitrate([candidate("brute"), candidate("wolf")], 101, null);
    expect(ledger.upgrade("brute", 2)).toBe(false);
    expect(ledger.costOf("brute")).toBe(1);
    expect(ledger.inUse("melee")).toBe(2);
    expect(ledger.upgrade("nobody", 2)).toBe(false);
  });

  it("serves a candidate by its own starvation threshold (Swarmer 2 s)", () => {
    const ledger = new TokenLedger("p1", HZ);
    const now = 100 + tacticsMsToTicks(2_100, HZ);
    const granted = ledger.arbitrate([
      candidate("front", { bearingDeg: 0, waitingSinceTick: now - 1 }),
      candidate("swarmer", { bearingDeg: 180, waitingSinceTick: 100, starvationMs: 2_000, cost: 0.5 }),
      candidate("other", { bearingDeg: 180, waitingSinceTick: 100 })
    ], now, 0);
    expect(granted[0]).toBe("swarmer");
  });
});

describe("token ledger: signature slot, spacing and governor", () => {
  it("holds one signature slot per player and spaces signature landings apart", () => {
    const ledger = new TokenLedger("p1", HZ);
    const parts = [18];
    expect(ledger.canStartSignature(100, parts)).toBe(true);
    ledger.takeSignatureSlot("hog", 100, parts);
    expect(ledger.canStartSignature(101, [10])).toBe(false);
    ledger.finishSignature("hog", 118);
    expect(ledger.signatureHolderId).toBeNull();
    // Next landing must be >= 118 + the spacing.
    expect(ledger.canStartSignature(119, [SIGNATURE_SPACING - 2])).toBe(false);
    expect(ledger.canStartSignature(118, [SIGNATURE_SPACING])).toBe(true);
  });

  it("keeps basic landings 500 ms from a signature landing, either side", () => {
    const ledger = new TokenLedger("p1", HZ);
    ledger.takeSignatureSlot("bear", 100, [20]); // lands at 120
    expect(ledger.canStartWindup(100, 20 - SIGNATURE_GAP + 1)).toBe(false);
    expect(ledger.canStartWindup(100, 20 - SIGNATURE_GAP)).toBe(true);
    expect(ledger.canStartWindup(100, 20 + SIGNATURE_GAP - 1)).toBe(false);
    expect(ledger.canStartWindup(100, 20 + SIGNATURE_GAP)).toBe(true);
    // And a signature may not start within 500 ms of a reserved basic landing.
    const other = new TokenLedger("p2", HZ);
    other.commitLanding(100, 9); // basic at 109
    expect(other.canStartSignature(100, [18])).toBe(false); // 118: 9 ticks away
    expect(other.canStartSignature(100, [9 + SIGNATURE_GAP])).toBe(true);
  });

  it("reserves both double-strike landings and frees only unlanded ones on cancel", () => {
    const ledger = new TokenLedger("p1", HZ);
    const parts = signaturePartTicks(MOB_SIGNATURES.double_strike, HZ);
    expect(parts).toEqual([24, 44]); // telegraph time: 1200 + 1000 ms
    ledger.takeSignatureSlot("spear", 100, parts);
    expect(ledger.landings.filter((landing) => landing.kind === "signature")).toHaveLength(2);
    ledger.cancelSignature("spear", 130); // first landed at 124, second (144) not yet
    expect(ledger.signatureHolderId).toBeNull();
    expect(ledger.landings.map((landing) => landing.tick)).toEqual([124]);
    ledger.cancelSignature("spear", 130);
    expect(ledger.landings).toHaveLength(1);
  });

  it("defers a signature that would push the 2 s window over the governor budget", () => {
    const ledger = new TokenLedger("p1", HZ);
    for (let tick = 100; tick < 106; tick += 1) ledger.recordLanded(tick, 1);
    expect(ledger.governorLoad(106)).toBe(6);
    expect(ledger.governorAllows(106, 0.5)).toBe(true);
    expect(ledger.governorAllows(106, 1.8)).toBe(false);
    // Two seconds after the first landing it slides out.
    const window = tacticsMsToTicks(2_000, HZ);
    expect(ledger.governorLoad(100 + window)).toBe(5);
    expect(ledger.governorAllows(105 + window, MOB_ARCH_GOVERNOR_BUDGET_HE)).toBe(true);
  });

  it("holds new basic windups while a ready signature waits for its window, until it starts or the hold expires", () => {
    const ledger = new TokenLedger("p1", HZ);
    expect(ledger.canStartWindup(100, 14)).toBe(true);
    ledger.holdBasicsForSignature("wolf", 100, 24);
    expect(ledger.canStartWindup(101, 14)).toBe(false);
    ledger.takeSignatureSlot("wolf", 110, [10]);
    expect(ledger.signatureBasicHold).toBeNull();
    ledger.holdBasicsForSignature("wolf2", 200, 24);
    expect(ledger.canStartWindup(223, 14)).toBe(false);
    expect(ledger.canStartWindup(224, 14)).toBe(true);
    ledger.holdBasicsForSignature("wolf3", 300, 24);
    ledger.release("wolf3");
    expect(ledger.canStartWindup(301, 14)).toBe(true);
  });

  it("clear() empties holders, landings, slot and governor", () => {
    const ledger = new TokenLedger("p1", HZ);
    ledger.arbitrate([candidate("a")], 100, null);
    ledger.commitLanding(100, 9);
    ledger.takeSignatureSlot("a", 100, [30]);
    ledger.recordLanded(100, 2);
    ledger.clear();
    expect(ledger.inUse("melee")).toBe(0);
    expect(ledger.landings).toHaveLength(0);
    expect(ledger.signatureHolderId).toBeNull();
    expect(ledger.governorLoad(101)).toBe(0);
  });
});

describe("archetype helpers", () => {
  it("costs: swarmer half a point only when common; epic and legendary pay the tier cost", () => {
    expect(archetypeTokenCost(0.5, "common")).toBe(0.5);
    expect(archetypeTokenCost(0.5, "uncommon")).toBe(1);
    expect(archetypeTokenCost(0.5, "epic")).toBe(2);
    expect(archetypeTokenCost(1, "common")).toBe(1);
    expect(archetypeTokenCost(1, "legendary")).toBe(2);
    expect(archetypeTokenCost(2, "common")).toBe(2);
  });

  it("resolves archetype state at join, honouring the rollout list", () => {
    const hog = resolveArchetypeTactics("hog", "common", null, HZ)!;
    expect(hog.archetype).toBe("brute");
    expect(hog.signature?.kind).toBe("charge");
    // Design rule 7: a brute signature costs 1 point (2 starved its own basics in packs); epic tiers still pay 2.
    expect(hog.signatureCost).toBe(1);
    expect(resolveArchetypeTactics("hog", "epic", null, HZ)?.signatureCost).toBe(2);
    expect(hog.signaturePartTicks).toEqual([26]); // telegraph time: the 1300 ms charge
    expect(resolveArchetypeTactics("red_squirrel", "common", null, HZ)?.signature).toBeNull();
    expect(resolveArchetypeTactics("shellback", "common", null, HZ)?.signature).toBeNull();
    expect(resolveArchetypeTactics("hedge_witch", "common", null, HZ)?.reachOverrideM).toBe(260);
    expect(resolveArchetypeTactics("frog", "common", null, HZ)?.reachOverrideM).toBeNull();
    expect(resolveArchetypeTactics("drowned_citizen", "common", null, HZ)).toBeNull();
    expect(resolveArchetypeTactics("hog", "common", parseArchetypesOnly("pack, swarmer"), HZ)).toBeNull();
    expect(resolveArchetypeTactics("wolf", "common", parseArchetypesOnly("pack, swarmer"), HZ)?.archetype).toBe("pack");
    expect(parseArchetypesOnly("")).toBeNull();
    expect([...parseArchetypesOnly("Brute,nonsense")!]).toEqual(["brute"]);
  });

  it("shapes: cone angle, volley fan, lunge rear arc, lane lengths and the knockback cap", () => {
    expect(signatureConeContains(0, 100, 70, 0, 90)).toBe(true);
    expect(signatureConeContains(0, 100, 70, 60, 60)).toBe(false); // 45 degrees off a 70-degree cone
    expect(signatureConeContains(0, 100, 100, 60, 60)).toBe(true);
    expect(volleyFacings(90, 36)).toEqual([72, 90, 108]);
    expect(inLungeRearArc(0, 180)).toBe(true);
    expect(inLungeRearArc(0, 100)).toBe(true);
    expect(inLungeRearArc(0, 60)).toBe(false);
    expect(inLungeRearArc(null, 0)).toBe(true);
    expect(signatureLaneLengthM(MOB_SIGNATURES.charge, 200)).toBe(280);
    expect(signatureLaneLengthM(MOB_SIGNATURES.charge, 480)).toBe(500);
    expect(signatureLaneLengthM(MOB_SIGNATURES.lunge, 130)).toBe(160);
    expect(signatureLaneLengthM(MOB_SIGNATURES.lunge, 230)).toBe(255);
    for (const kind of ["charge", "maul", "slam"] as const) expect(signatureKnockbackM(kind)).toBe(MOB_ARCH_KNOCKBACK_CAP_M);
    expect(signatureKnockbackM("lunge")).toBe(0);
  });
});
