import { describe, expect, it } from "vitest";

import type { PartySnapshot } from "./PartyAuthority.js";
import { autoFollowPlayerIdsForLeader } from "./partyTravel.js";

const party: PartySnapshot = {
  partyId: "party-1",
  leaderPlayerId: "leader",
  memberPlayerIds: ["leader", "member-a", "member-b"],
  allowTravel: false,
  autoFollowPlayerIds: ["member-a"],
  revision: 1
};

describe("autoFollowPlayerIdsForLeader", () => {
  it("requires the current leader allowance and each member's consent", () => {
    expect(autoFollowPlayerIdsForLeader(party, "leader")).toEqual([]);
    expect(autoFollowPlayerIdsForLeader({ ...party, allowTravel: true }, "leader"))
      .toEqual(["member-a"]);
  });

  it("rejects stale leader events and ignores stale/non-member consent", () => {
    expect(autoFollowPlayerIdsForLeader({ ...party, allowTravel: true }, "old-leader")).toEqual([]);
    expect(autoFollowPlayerIdsForLeader({
      ...party,
      allowTravel: true,
      autoFollowPlayerIds: ["leader", "member-a", "removed-member"]
    }, "leader")).toEqual(["member-a"]);
  });
});
