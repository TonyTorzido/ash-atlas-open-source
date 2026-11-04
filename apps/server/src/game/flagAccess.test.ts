import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { decidePersonalFlagAccess } from "./flagAccess.js";

const base = {
  controlType: "personal",
  ownerPlayerId: "owner",
  travelerPlayerId: "traveler",
  mode: "private" as const,
  jumpTollGold: 0n,
  normalPassage: false,
  enemyBlocked: false
};

describe("personal flag access precedence", () => {
  it.each([
    [{ travelerPlayerId: "owner" }, true, "ALLOWED_OWNER", "0"],
    [{ companionHostPlayerId: "owner" }, true, "ALLOWED_INVITE", "0"],
    [{ companionHostPlayerId: "someone-else" }, false, "PRIVATE_OWNER_ONLY", "0"],
    [{ mode: "public" as const, jumpTollGold: 25n }, true, "ALLOWED_PUBLIC", "25"],
    [{ mode: "public" as const, jumpTollGold: 25n, companionHostPlayerId: "host" }, true, "ALLOWED_PUBLIC", "0"],
    [{ mode: "normal" as const, normalPassage: true, jumpTollGold: 8n }, true, "ALLOWED_NORMAL", "8"],
    [{ mode: "normal" as const, jumpTollGold: 8n, companionHostPlayerId: "owner" }, true, "ALLOWED_INVITE", "0"],
    [{ mode: "normal" as const, normalPassage: true, jumpTollGold: 8n, companionHostPlayerId: "host" }, true, "ALLOWED_NORMAL", "0"],
    [{ mode: "normal" as const }, false, "NORMAL_PASSAGE_REQUIRED", "0"],
    [{ mode: "normal" as const, requestPending: true }, false, "NORMAL_REQUEST_PENDING", "0"],
    [{ mode: "public" as const, enemyBlocked: true }, false, "PUBLIC_ENEMY_BLOCKED", "0"],
    [{ mode: "normal" as const, enemyBlocked: true }, false, "NORMAL_ENEMY_BLOCKED", "0"],
    [{ controlType: "city" }, true, "ALLOWED_PUBLIC", "0"]
  ])("resolves the expected access result", (changes, allowed, reasonCode, tollGold) => {
    expect(decidePersonalFlagAccess({ ...base, ...changes })).toEqual(expect.objectContaining({
      allowed,
      reasonCode,
      tollGold
    }));
  });

  it("offers a request only for Normal passage without a pending request", () => {
    expect(decidePersonalFlagAccess({ ...base, mode: "normal" }).requestable).toBe(true);
    expect(decidePersonalFlagAccess({
      ...base,
      mode: "normal",
      requestPending: true
    }).requestable).toBe(false);
  });
});

describe("flag geometry compatibility", () => {
  it("keeps access decisions independent from centralized geometry configuration", () => {
    const current = loadConfig({});
    const changed = loadConfig({
      FLAG_CLAIM_RADIUS_M: "550",
      MOVE_LEASH_RADIUS_M: "700",
      FLAG_RESOURCE_VISION_RADIUS_M: "800",
      FLAG_PREPARE_RADIUS_M: "900"
    });
    expect(current.FLAG_CLAIM_RADIUS_M).not.toBe(changed.FLAG_CLAIM_RADIUS_M);
    expect(decidePersonalFlagAccess({
      ...base,
      mode: "public",
      jumpTollGold: 73n
    })).toEqual({
      allowed: true,
      requestable: false,
      reasonCode: "ALLOWED_PUBLIC",
      tollGold: "73"
    });
  });
});
