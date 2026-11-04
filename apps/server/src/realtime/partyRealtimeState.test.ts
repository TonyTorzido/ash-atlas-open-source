import { describe, expect, it } from "vitest";

import { PartyRealtimeState } from "./partyRealtimeState.js";

describe("PartyRealtimeState.runMutations", () => {
  it("lets exactly one of two crossed two-player mutations through instead of failing both", async () => {
    const state = new PartyRealtimeState();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ran: string[] = [];
    // Leader A accepts B's request while leader B accepts A's request.
    const first = state.runMutations(["player-a", "player-b"], async () => { await held; ran.push("a-accepts-b"); });
    const second = state.runMutations(["player-b", "player-a"], async () => { ran.push("b-accepts-a"); });
    await expect(second).rejects.toMatchObject({ code: "PARTY_UNAVAILABLE" });
    release();
    await expect(first).resolves.toBeUndefined();
    expect(ran).toEqual(["a-accepts-b"]);
    await expect(state.runMutations(["player-b", "player-a"], async () => "free")).resolves.toBe("free");
  });
});
