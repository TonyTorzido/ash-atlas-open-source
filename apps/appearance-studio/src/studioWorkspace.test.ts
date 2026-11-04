import { describe, expect, it } from "vitest";

import { restoreStudioWorkspace } from "./studioWorkspace.js";

describe("restoreStudioWorkspace", () => {
  it("keeps current workspace ids", () => {
    for (const id of ["appearance", "assets", "interiors", "progression-icons", "flags"]) {
      expect(restoreStudioWorkspace(id)).toBe(id);
    }
  });

  it("maps the retired dungeon, manor, and greenhouse workspaces to interiors", () => {
    for (const id of ["dungeons", "manors", "greenhouses"]) {
      expect(restoreStudioWorkspace(id)).toBe("interiors");
    }
  });

  it("falls back to appearance for unknown or missing ids", () => {
    expect(restoreStudioWorkspace("nope")).toBe("appearance");
    expect(restoreStudioWorkspace(null)).toBe("appearance");
    expect(restoreStudioWorkspace(undefined)).toBe("appearance");
  });
});
