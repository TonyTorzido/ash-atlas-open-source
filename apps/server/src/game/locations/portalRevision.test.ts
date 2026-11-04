import { describe, expect, it } from "vitest";
import { usePortalMessageSchema } from "@ash-atlas/shared";
import { boundedPortalRevision } from "./portalRevision.js";

describe("authored portal revision wire contract", () => {
  it("retains short revisions and fingerprints long names without losing change detection", () => {
    expect(boundedPortalRevision("developer:1:a:b:c")).toBe("developer:1:a:b:c");
    const source = `developer:1:${"long_dungeon_name_".repeat(30)}`;
    const revision = boundedPortalRevision(source);
    expect(revision.length).toBeLessThanOrEqual(128);
    expect(boundedPortalRevision(source)).toBe(revision);
    expect(boundedPortalRevision(`${source}:2`)).not.toBe(revision);
    expect(usePortalMessageSchema.safeParse({ type: "USE_PORTAL", requestId: "test", portalId: "dungeon:test:entrance", expectedPortalRevision: revision, expectedLocationRevision: 0 }).success).toBe(true);
  });
});
