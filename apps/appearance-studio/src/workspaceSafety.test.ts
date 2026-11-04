import { describe, expect, it } from "vitest";

import { writeBlockReason } from "./workspaceSafety.js";

describe("Appearance Studio Git write policy", () => {
  it("allows only approved task branches in linked worktrees", () => {
    expect(writeBlockReason("feature/appearance", true)).toBeNull();
    expect(writeBlockReason("fix/appearance", true)).toBeNull();
    expect(writeBlockReason("integration/test", true)).toMatch(/Protected/u);
    expect(writeBlockReason("master", true)).toMatch(/Protected/u);
    expect(writeBlockReason("test/t328", true)).toMatch(/Protected/u);
    expect(writeBlockReason(null, true)).toMatch(/Detached/u);
    expect(writeBlockReason("feature/appearance", false)).toMatch(/permanent/u);
    expect(writeBlockReason("my-branch", true)).toMatch(/approved/u);
  });
});
