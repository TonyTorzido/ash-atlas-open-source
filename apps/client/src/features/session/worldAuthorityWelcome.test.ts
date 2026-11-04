import { describe, expect, it } from "vitest";

import {
  classifyWorldAuthorityWelcome,
  type WorldAuthorityWelcomeMarker
} from "./worldAuthorityWelcome.js";

const marker = (
  changes: Partial<WorldAuthorityWelcomeMarker> = {}
): WorldAuthorityWelcomeMarker => ({
  playerId: "player-1",
  epoch: "epoch-a",
  relocationRevision: 11,
  resourceVisionRevision: 7,
  gameplayViewGeneration: 5,
  ...changes
});

describe("world authority WELCOME classification", () => {
  it("distinguishes a new logical runtime from a same-runtime reconnect", () => {
    expect(classifyWorldAuthorityWelcome(null, marker())).toBe("initial");
    expect(classifyWorldAuthorityWelcome(marker(), marker({
      relocationRevision: 12,
      resourceVisionRevision: 8,
      gameplayViewGeneration: 6
    }))).toBe("same-authority");
    expect(classifyWorldAuthorityWelcome(marker(), marker({
      epoch: "epoch-b",
      relocationRevision: 0,
      resourceVisionRevision: 0,
      gameplayViewGeneration: 0
    }))).toBe("epoch-changed");
  });

  it("fails safe when a legacy server regresses any session-scoped revision", () => {
    const legacy = marker({ epoch: null });
    expect(classifyWorldAuthorityWelcome(legacy, marker({
      epoch: null,
      relocationRevision: 10
    }))).toBe("revision-regressed");
    expect(classifyWorldAuthorityWelcome(legacy, marker({
      epoch: null,
      resourceVisionRevision: 6
    }))).toBe("revision-regressed");
    expect(classifyWorldAuthorityWelcome(legacy, marker({
      epoch: null,
      gameplayViewGeneration: 4
    }))).toBe("revision-regressed");
  });

  it("resets once when a rolling deployment first establishes an epoch", () => {
    expect(classifyWorldAuthorityWelcome(
      marker({ epoch: null }),
      marker({ epoch: "epoch-a" })
    )).toBe("epoch-established");
  });
});
