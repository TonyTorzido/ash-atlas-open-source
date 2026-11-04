import { describe, expect, it, vi } from "vitest";

import {
  FLAG_CONTROL_TOUCH_TOLERANCE_M,
  findForeignOrganizationConnection,
  isPersonalFlagControlledByPlayer,
  lockFlagControlGeometry
} from "./flagControlGeometry.js";

describe("organization-neutral flag-control geometry", () => {
  it("uses one global touch tolerance for City and Kingdom geometry", () => {
    expect(FLAG_CONTROL_TOUCH_TOLERANCE_M).toBe(0.05);
  });

  it("uses one global advisory lock identity", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await lockFlagControlGeometry({ query } as never);

    expect(query).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["flag-control-geometry"]
    );
  });

  it("detects foreign City and Kingdom control with the shared tolerance", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "foreign-flag" }] });

    await expect(findForeignOrganizationConnection(
      { query } as never,
      "target-flag",
      "allowed-city",
      "allowed-kingdom"
    )).resolves.toBe("foreign-flag");

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("neighbor.city_id IS DISTINCT FROM $2::uuid"),
      [
        "target-flag",
        "allowed-city",
        "allowed-kingdom",
        FLAG_CONTROL_TOUCH_TOLERANCE_M
      ]
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      "neighbor.kingdom_id IS DISTINCT FROM $3::uuid"
    );
  });

  it("keeps personal control classification organization-neutral", () => {
    expect(isPersonalFlagControlledByPlayer({
      control_type: "personal",
      owner_id: "player-1"
    }, "player-1")).toBe(true);
    expect(isPersonalFlagControlledByPlayer({
      control_type: "city",
      owner_id: "player-1"
    }, "player-1")).toBe(false);
  });
});
