import { describe, expect, it } from "vitest";

import {
  desktopReleaseSourceProblem,
  type DesktopBuildSource
} from "./desktopBuildSource.js";

const validSource: DesktopBuildSource = {
  branch: "integration/test",
  commitSha: "a".repeat(40),
  integrationSha: "a".repeat(40),
  generationTags: ["test/t580"],
  clean: true
};

describe("Appearance Studio desktop release source", () => {
  it("accepts only the clean, tagged remote integration source", () => {
    expect(desktopReleaseSourceProblem(validSource)).toBeNull();
  });

  it.each([
    [{ ...validSource, branch: "feature/mouths--from-t531" }, /integration\/test/u],
    [{ ...validSource, clean: false }, /clean/u],
    [{ ...validSource, integrationSha: "b".repeat(40) }, /exactly match/u],
    [{ ...validSource, generationTags: [] }, /exactly one/u],
    [{ ...validSource, generationTags: ["test/t579", "test/t580"] }, /exactly one/u]
  ])("refuses an unsafe or ambiguous package source", (source, expected) => {
    expect(desktopReleaseSourceProblem(source as DesktopBuildSource)).toMatch(expected);
  });
});
